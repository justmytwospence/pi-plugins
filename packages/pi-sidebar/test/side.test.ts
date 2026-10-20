import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILES } from "../src/protocol.ts";
import { registerSide } from "../src/side.ts";
import { FakePi, fakeCtx } from "./fake.ts";

let dir: string;
const H1 = { type: "ephemeral", ttl: "1h" };

function mainPayload() {
  return {
    model: "claude-x",
    max_tokens: 1,
    stream: true,
    system: [{ type: "text", text: "MAIN", cache_control: H1 }],
    tools: [{ name: "read", cache_control: H1 }],
    messages: [{ role: "user", content: [{ type: "text", text: "fix it", cache_control: H1 }] }],
  };
}

function sidePayload() {
  return {
    model: "claude-x",
    max_tokens: 9000,
    stream: true,
    system: [{ type: "text", text: "SIDE" }],
    tools: [{ name: "read" }],
    messages: [{ role: "user", content: [{ type: "text", text: "what is it doing?", cache_control: { type: "ephemeral" } }] }],
  };
}

function setup(opts: { sentAt?: number; payload?: boolean; lastUsage?: object } = {}) {
  const sessionFile = join(dir, "main.jsonl");
  const lines = [
    { type: "session", version: 3, id: "main-id", timestamp: "", cwd: "/repo" },
    { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: [{ type: "text", text: "fix it" }], timestamp: 0 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "Fixed the bug in a.ts." }], provider: "anthropic", model: "claude-x", api: "anthropic-messages", usage: {}, stopReason: "stop", timestamp: 0 } },
  ];
  writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, FILES.host), JSON.stringify({ version: 1, pid: process.pid, sessionId: "main-id", sessionFile, cwd: "/repo", thinkingLevel: "high", updatedAt: 0 }));
  writeFileSync(join(dir, FILES.live), JSON.stringify({ version: 1, state: "idle", since: Date.now(), tools: [], leafId: "a1", updatedAt: Date.now(), lastUsage: opts.lastUsage }));
  if (opts.payload !== false) {
    writeFileSync(join(dir, FILES.payload), JSON.stringify({
      version: 1, api: "anthropic-messages", provider: "anthropic", model: "claude-x", leafId: "u1", sentAt: opts.sentAt ?? Date.now(), payload: mainPayload(),
    }));
  }
}

const sideCtx = (extra: Parameters<typeof fakeCtx>[0] = {}) =>
  fakeCtx({ sessionId: "side-id", model: { provider: "anthropic", id: "claude-x", api: "anthropic-messages" }, ...extra });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-sidebar-side-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("Sidebar's requests", () => {
  it("announces itself and asks main for its last request on start", async () => {
    setup();
    const pi = new FakePi();
    registerSide(pi as any, dir);
    await pi.emit("session_start", { reason: "startup" }, sideCtx().ctx);
    expect(JSON.parse(readFileSync(join(dir, FILES.side), "utf8")).pid).toBe(process.pid);
    expect(existsSync(join(dir, FILES.wantPayload))).toBe(true);
    await pi.emit("session_shutdown", { reason: "quit" }, sideCtx().ctx);
  });

  it("never keeps its own cache warm", async () => {
    const pi = new FakePi();
    registerSide(pi as any, dir);
    expect(await pi.emit("cache_warming_decision", { action: "warm" }, sideCtx().ctx)).toEqual({ action: "stop" });
  });

  it("sends main's request plus main's newer entries, the live note and the question", async () => {
    setup();
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx();
    const system = { role: "system", content: "", timestamp: 0 };
    const question = { role: "user", content: [{ type: "text", text: "what is it doing?" }], timestamp: 0 };
    const assembled = await pi.emit("context_with_system", { messages: [system, question] }, c.ctx);
    expect(assembled.messages.map((m: any) => m.role)).toEqual(["system", "assistant", "user", "user", "user"]);
    expect(assembled.messages[1].content[0].text).toBe("Fixed the bug in a.ts.");
    expect(assembled.messages[2].content[0].text).toContain("You are Sidebar");
    expect(assembled.messages[3].content[0].text).toContain("Main is idle");
    expect(assembled.messages[4]).toBe(question);
    const sent = await pi.emit("before_provider_request", { payload: sidePayload() }, c.ctx);
    expect(sent.system).toEqual(mainPayload().system);
    expect(sent.tools).toEqual(mainPayload().tools);
    expect(sent.messages[0]).toEqual(mainPayload().messages[0]);
    expect(sent.messages[1].content[0].text).toBe("what is it doing?");
    expect(sent.max_tokens).toBe(9000);
    expect(c.aborted).toBe(0);
  });

  it("fails closed without a copy of main's request", async () => {
    setup({ payload: false });
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx();
    await pi.emit("context_with_system", { messages: [] }, c.ctx);
    const sent = await pi.emit("before_provider_request", { payload: sidePayload() }, c.ctx);
    expect(c.aborted).toBe(1);
    expect(sent.messages).toEqual([]);
    expect(c.notes[0]!.message).toMatch(/did not send.*Nothing was spent/);
  });

  it("fails closed when the APIs differ", async () => {
    setup();
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx({ model: { provider: "openai", id: "claude-x", api: "openai-responses" } });
    await pi.emit("context_with_system", { messages: [] }, c.ctx);
    await pi.emit("before_provider_request", { payload: sidePayload() }, c.ctx);
    expect(c.aborted).toBe(1);
  });

  it("routes by main's session id", async () => {
    setup();
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const headers: Record<string, string> = { "x-session-affinity": "side-id", other: "keep" };
    await pi.emit("before_provider_headers", { headers }, sideCtx().ctx);
    expect(headers).toEqual({ "x-session-affinity": "main-id", other: "keep" });
  });
});

describe("before a prompt is sent", () => {
  it("lets a question through while main's cache is warm, and commands always", async () => {
    setup();
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx();
    expect(await pi.emit("input", { text: "what now?", source: "interactive" }, c.ctx)).toEqual({ action: "continue" });
    expect(await pi.emit("input", { text: "/tree", source: "interactive" }, c.ctx)).toEqual({ action: "continue" });
    expect(c.confirms).toEqual([]);
  });

  it("asks before re-caching an expired cache, and keeps the prompt when declined", async () => {
    setup({ sentAt: Date.now() - 2 * 60 * 60_000, lastUsage: { input: 10, output: 5, cacheRead: 150_000, cacheWrite: 40 } });
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx({ confirm: false });
    expect(await pi.emit("input", { text: "what now?", source: "interactive" }, c.ctx)).toEqual({ action: "handled" });
    expect(c.confirms[0]).toMatch(/expired/);
    expect(c.editor).toBe("what now?");
    expect(pi.emitted).toEqual([["herdr:blocked", { active: true, label: "Sidebar" }], ["herdr:blocked", { active: false }]]);
    const yes = sideCtx({ confirm: true });
    expect(await pi.emit("input", { text: "what now?", source: "interactive" }, yes.ctx)).toEqual({ action: "continue" });
  });

  it("refuses without a UI to confirm", async () => {
    setup({ sentAt: 0 });
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx({ hasUI: false });
    expect(await pi.emit("input", { text: "q", source: "rpc" }, c.ctx)).toEqual({ action: "handled" });
    expect(c.notes[0]!.message).toMatch(/expired/);
  });

  it("switches to main's model before sending", async () => {
    setup();
    const pi = new FakePi();
    pi.thinking = "low";
    registerSide(pi as any, dir);
    const c = sideCtx({ model: { provider: "anthropic", id: "other", api: "anthropic-messages" } });
    expect(await pi.emit("input", { text: "q", source: "interactive" }, c.ctx)).toEqual({ action: "continue" });
    expect(pi.models).toEqual(["anthropic/claude-x"]);
    expect(pi.thinking).toBe("high");
  });

  it("asks again after an answer that missed main's cache", async () => {
    setup({ lastUsage: { input: 0, output: 0, cacheRead: 100_000, cacheWrite: 0 } });
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx({ confirm: false });
    await pi.emit("message_end", { message: { role: "assistant", usage: { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 50 } } }, c.ctx);
    expect(c.notes[0]!.message).toMatch(/missed main's cache/);
    expect(await pi.emit("input", { text: "q", source: "interactive" }, c.ctx)).toEqual({ action: "handled" });
    expect(c.confirms[0]).toMatch(/missed/);
  });
});

describe("read-only", () => {
  it("blocks edits and allows reads", async () => {
    const pi = new FakePi();
    registerSide(pi as any, dir);
    const c = sideCtx();
    expect(await pi.emit("tool_call", { toolName: "edit", input: {} }, c.ctx)).toEqual({ block: true, reason: expect.stringMatching(/read-only/) });
    expect(await pi.emit("tool_call", { toolName: "read", input: { path: "a" } }, c.ctx)).toBeUndefined();
    expect(await pi.emit("tool_call", { toolName: "bash", input: { command: "rm -rf /" } }, c.ctx)).toEqual({ block: true, reason: expect.any(String) });
  });
});

describe("status line", () => {
  it("drops optional parts before cutting the line", async () => {
    const { fitStatus } = await import("../src/side.ts");
    const parts = [{ text: "◧ Sidebar" }, { text: "read-only", optional: 1 }, { text: "main idle 5s" }, { text: "last answer 97% cached · 1k new", optional: 2 }];
    expect(fitStatus(parts, 120, " · ")).toBe("◧ Sidebar · read-only · main idle 5s · last answer 97% cached · 1k new");
    expect(fitStatus(parts, 46, " · ")).toBe("◧ Sidebar · read-only · main idle 5s");
    expect(fitStatus(parts, 30, " · ")).toBe("◧ Sidebar · main idle 5s");
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    expect(visibleWidth(fitStatus(parts, 12, " · "))).toBeLessThanOrEqual(12);
  });
});
