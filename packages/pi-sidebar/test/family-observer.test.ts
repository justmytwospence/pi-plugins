import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FamilyKernel } from "../src/family/kernel.ts";
import { discoverFamily } from "../src/family-contract.ts";
import { FakePi, fakeCtx } from "./fake.ts";
import type { ObservationSnapshot } from "../src/family/protocol.ts";
const kernels: FamilyKernel[] = []; const dirs: string[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.dispose(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function kernel() { const dir = await mkdtemp(path.join(tmpdir(), "family-kernel-")); dirs.push(dir); const k = await FamilyKernel.create({ root: { kind: "main", label: "main" }, agentDir: dir }); kernels.push(k); return k; }
const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
describe("family kernel and member observer", () => {
  it("detaches host callbacks, persists thread/preferences, and does not churn focus", async () => {
    const k = await kernel(); let calls = 0; let listener: (() => void) | undefined;
    const snapshot = (): ObservationSnapshot => { calls++; return { revision: calls, sessionId: "main", leafId: null, messages: [{ role: "user", content: `hello ${k.server.socketPath} ${"a".repeat(64)}` }], live: { state: "working" } }; };
    const detach = k.attachHost({ agentId: k.rootId, snapshot, onChange(fn) { listener = fn; return () => { listener = undefined; }; } });
    const revision = k.revision; k.focus(k.rootId); k.setPreferences({ draft: "" }); expect(k.revision).toBe(revision);
    const page = await k.transcript({ agentId: k.rootId }); expect(page.text).toContain("hello"); expect(page.text).not.toContain(k.server.socketPath); expect(page.text).not.toContain("a".repeat(64)); expect(page.coverage).toBe("partial");
    listener?.(); detach(); await wait(280); expect(calls).toBe(1); expect(listener).toBeUndefined();
    await k.appendExchange("one", [{ role: "user", content: "question", timestamp: 1 }]); await k.appendExchange("one", []); expect(k.messages).toHaveLength(1);
    k.setPreferences({ draft: "draft", model: "model", open: true, sidebarFocused: true }); await k.store.flush(); expect(await k.store.loadState()).toMatchObject({ draft: "draft", model: "model", open: true, sidebarFocused: true });
    expect((await k.transcript({ agentId: "not-enrolled" })).coverage).toBe("unavailable");
    await k.dispose();
    const restored = await FamilyKernel.create({ familyId: k.familyId, agentId: k.rootId, root: { kind: "main", label: "main" }, agentDir: path.resolve(k.store.directory, "../../..") }); kernels.push(restored);
    expect(restored).toMatchObject({ draft: "draft", model: "model", open: true, sidebarFocused: true }); expect(restored.messages).toHaveLength(1);
  });
  it("enrolls main-child-grandchild through member-local discovery without UI", async () => {
    const k = await kernel(); const child = await k.prepareChild(k.rootId, { kind: "worker", label: "child" });
    const pi = new FakePi(); await child.observer(pi as never); const handlers = [...pi.handlers.values()].reduce((n, list) => n + list.length, 0);
    await child.observer({ events: { ...pi.events }, on: pi.on.bind(pi) } as never); expect([...pi.handlers.values()].reduce((n, list) => n + list.length, 0)).toBe(handlers); expect(pi.commands.size).toBe(0);
    const ctx = fakeCtx({ sessionId: "child-session", leafId: "a", entries: [{ type: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "evidence", timestamp: 1 } }] }).ctx;
    await pi.emit("session_start", {}, ctx); await wait();
    expect(() => k.cancelReservation(child.agentId)).toThrow("Cannot discard an observed");
    const service = discoverFamily(pi.events)!; expect(service).toBeDefined();
    const grandchild = await service.prepare({ kind: "scout", label: "grandchild" });
    expect(k.snapshot().agents.find(a => a.agentId === grandchild.agentId)?.parentId).toBe(child.agentId);
    expect((await k.transcript({ agentId: child.agentId })).text).toContain("evidence");
    await pi.emit("agent_start", {}, ctx); await wait(280); expect(k.snapshot().agents.find(a => a.agentId === child.agentId)?.phase).toBe("working");
    await pi.emit("agent_end", {}, ctx); await wait(280); expect(k.snapshot().agents.find(a => a.agentId === child.agentId)?.phase).toBe("working");
    await pi.emit("agent_settled", {}, ctx); await wait(280); expect(k.snapshot().agents.find(a => a.agentId === child.agentId)?.phase).toBe("idle");
    (ctx.sessionManager.getEntries()[0] as { message: { content: string } }).message.content = "final evidence";
    grandchild.finish("done"); grandchild.dispose(); child.finish("done"); child.dispose(); await wait();
    expect((await k.transcript({ agentId: child.agentId })).text).toContain("final evidence");
    expect(discoverFamily(pi.events)).toBeUndefined(); expect(k.snapshot().agents.find(a => a.agentId === child.agentId)?.phase).toBe("done");
  });
  it("isolates unrelated families and rejects a copied session identity", async () => {
    const k = await kernel(); const other = await kernel();
    expect(k.server.socketPath).not.toBe(other.server.socketPath);
    expect((await k.transcript({ agentId: other.rootId })).coverage).toBe("unavailable");
    const host = (sessionId: string) => ({ agentId: k.rootId, snapshot: () => ({ sessionId, revision: 1, messages: [], live: { state: "idle" } }), onChange: () => () => {} });
    const detach = k.attachHost(host("original")); detach();
    expect(() => k.attachHost(host("fork-copy"))).toThrow("session does not match");
  });
  it("cancels reservations and rejects already-aborted enrollment", async () => {
    const k = await kernel(); const abort = new AbortController(); abort.abort();
    await expect(k.prepareChild(k.rootId, { kind: "worker", label: "no" }, abort.signal)).rejects.toThrow(); expect(k.snapshot().agents).toHaveLength(1);
    const child = await k.prepareChild(k.rootId, { kind: "worker", label: "reserved" }); k.cancelReservation(child.agentId);
    expect(k.snapshot().agents.some(a => a.agentId === child.agentId)).toBe(false); child.finish("done"); expect(k.snapshot().agents.some(a => a.agentId === child.agentId)).toBe(false); child.dispose();
    await k.store.flush(); expect((await k.store.loadState())?.agents.some(a => a.agentId === child.agentId)).toBe(false);
    const controller = new AbortController(); const ordinary = await k.prepareChild(k.rootId, { kind: "worker", label: "ordinary" }, controller.signal); controller.abort();
    ordinary.finish("done"); expect(k.snapshot().agents.find(a => a.agentId === ordinary.agentId)?.phase).toBe("stopped"); ordinary.dispose();
  });
});
