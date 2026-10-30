import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createEventBus, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, type ActivitySection } from "../src/activity.ts";
import { type ChildRecord, Children } from "../src/core/children.ts";
import { FORK_BOUNDARY } from "../src/fork-session.ts";
import piHerdr from "../src/index.ts";
import { PI_CHILD } from "../src/session.ts";
import { fakeCall } from "./core/fake.ts";

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_SOCKET_PATH", "/fixture/no-socket");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1"); vi.stubEnv("PI_HERDR_PR", "0");
  vi.spyOn(PI_CHILD, "reply").mockResolvedValue("Fixture reply");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const drain = () => vi.advanceTimersByTimeAsync(0);
const rec = (name = "worker", awaiting = true): ChildRecord => ({ name, paneId: "w1:p2", where: "tab", cwd: "/repo", task: "Review", createdAt: 1, awaiting, baseline: { completionSeq: 1, stateSeq: 1 }, session: "/fixture/session" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(manager = SessionManager.inMemory("/repo")) {
  const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
  const bus = createEventBus();
  const emitted: Array<[string, any]> = [];
  const messages: any[] = [];
  const state = { idle: true, stopOnSend: false, staleIdle: false };
  let tool: any;
  const pi = {
    on: (event: string, fn: any) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => undefined; },
    events: {
      on: bus.on,
      emit: (channel: string, data: unknown) => { emitted.push([channel, data]); bus.emit(channel, data); },
    },
    appendEntry: vi.fn((customType: string, data: unknown) => { manager.appendCustomEntry(customType, structuredClone(data)); }),
    sendMessage: vi.fn((message: any, options: unknown) => {
      messages.push({ message, options });
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      if (state.stopOnSend) state.idle = false;
    }),
    registerTool: (t: any) => { tool = t; },
    getActiveTools: () => [], setActiveTools: vi.fn(), getThinkingLevel: () => "medium", getSessionName: () => undefined,
  };
  const ctx = { mode: "tui", hasUI: true, cwd: "/repo", model: { id: "m" }, ui: {}, sessionManager: manager, isIdle: () => { if (state.staleIdle) throw new Error("stale ctx"); return state.idle; } };
  const emit = async (event: string, payload: any = {}, c = ctx) => { for (const fn of handlers.get(event) ?? []) await fn(payload, c); };
  const section = () => emitted.filter(([channel]) => channel === ACTIVITY_SECTION).at(-1)?.[1].section as ActivitySection;
  return { pi: pi as unknown as ExtensionAPI, rawPi: pi, manager, state, ctx, emit, emitted, messages, section, tool: () => tool };
}

function socketFixture() {
  const state = { seq: 1, status: "idle", pending: undefined as undefined | ReturnType<typeof deferred<any>> };
  const f = fakeCall({
    "agent.get": () => state.pending?.promise ?? { result: { agent: { agent_status: state.status, completion_seq: state.seq, state_change_seq: 1, interactive_ready: true, agent_session: { value: "/fixture/session" } } } },
    "pane.get": (p) => ({ result: { pane: { pane_id: p.pane_id, workspace_id: "w1" } } }),
    "tab.create": () => ({ result: { root_pane: { pane_id: "w1:p2" } } }),
    "agent.list": () => ({ result: { agents: [] } }),
  });
  return { state, f };
}
const deps = (call: any) => ({ call, exec: async () => ({ code: 0, stdout: "", stderr: "" }), pollMs: 1_000 });
const save = (p: ReturnType<typeof harness>, r: ChildRecord) => p.manager.appendCustomEntry("pi-herdr:child", r);

const forkRecords: Array<[string, ChildRecord]> = [
  ["awaiting", rec()],
  ["pendingReply", { ...rec("worker", false), pendingReply: "source reply" }],
  ["queued", { ...rec("worker", false), queued: ["source follow-up"] }],
];

function copySession(manager: SessionManager) {
  const header = SessionManager.inMemory("/repo").getHeader()!;
  return SessionManager.inMemory("/repo", undefined, structuredClone([header, ...manager.getBranch()]));
}

test.each(forkRecords)("tree-fork boundary isolates inherited %s children through reload and a fresh runtime without changing the source", async (_kind, record) => {
  const source = harness();
  save(source, structuredClone(record));
  const original = structuredClone(source.manager.getBranch());
  const fork = harness(copySession(source.manager)); const x = socketFixture();
  expect(fork.manager.getSessionId()).not.toBe(source.manager.getSessionId());
  fork.manager.appendCustomEntry(FORK_BOUNDARY, {});
  piHerdr(fork.pi, deps(x.f.call));
  const isolated = async (p: ReturnType<typeof harness>) => {
    expect(p.section().entries(Date.now())).toEqual([]);
    expect(p.section().canStop?.("worker")).toBe(false);
    await p.section().stop?.("worker");
    await p.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.messages).toEqual([]);
    expect(p.rawPi.appendEntry).not.toHaveBeenCalled();
    expect(x.f.of("agent.get")).toEqual([]);
    expect(x.f.of("agent.prompt")).toEqual([]);
    expect(x.f.of("agent.send_keys")).toEqual([]);
    expect(PI_CHILD.reply).not.toHaveBeenCalled();
    expect(p.emitted.filter(([c, d]) => c === "herdr:background" && d.active)).toEqual([]);
  };
  await fork.emit("session_start", { reason: "fork" });
  await isolated(fork);
  await fork.emit("session_start", { reason: "reload" });
  await isolated(fork);
  await fork.emit("session_shutdown");
  const fresh = harness(copySession(fork.manager));
  piHerdr(fresh.pi, deps(x.f.call)); await fresh.emit("session_start");
  await isolated(fresh);
  await fresh.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);

  // Copying the branch and appending the marker never abandons the source's children.
  expect(source.manager.getBranch()).toEqual(original);
  const sx = socketFixture(); source.state.idle = false;
  piHerdr(source.pi, deps(sx.f.call)); await source.emit("session_start");
  expect(source.section().entries(Date.now()).map((e) => e.key)).toEqual(["worker"]);
  source.state.idle = true;
  await source.emit("agent_settled");
  sx.state.seq = 2;
  await vi.advanceTimersByTimeAsync(1_000);
  if (record.pendingReply) expect(source.messages.map((m) => m.message.content)).toEqual(["source reply"]);
  else expect(sx.f.of("agent.get").length).toBeGreaterThan(0);
  if (record.queued) expect(sx.f.of("agent.prompt")).toHaveLength(1);
  await source.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
});

test("tree-fork restores post-boundary awaiting, pendingReply and queued records normally", async () => {
  const p = harness(); const x = socketFixture();
  for (const [, record] of forkRecords) save(p, { ...structuredClone(record), name: `inherited-${record.awaiting ? "awaiting" : record.pendingReply ? "reply" : "queued"}` });
  p.manager.appendCustomEntry(FORK_BOUNDARY, {});
  save(p, { ...rec("new-awaiting"), paneId: "w1:p3" });
  save(p, { ...rec("new-reply", false), paneId: "w1:p4", pendingReply: "new reply" });
  save(p, { ...rec("new-queued", false), paneId: "w1:p5", queued: ["new follow-up"] });
  piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  expect(p.section().entries(1_000).map((e) => e.key).sort()).toEqual(["new-awaiting", "new-queued", "new-reply"]);
  expect(p.messages.map((m) => m.message.content)).toEqual(["new reply"]);
  x.state.seq = 2;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(PI_CHILD.reply).toHaveBeenCalledTimes(1);
  expect(vi.mocked(PI_CHILD.reply).mock.calls[0][0]).toMatchObject({ name: "new-awaiting", paneId: "w1:p3" });
  expect(p.messages).toHaveLength(2);
  expect(p.messages[1].message.content).toContain("Fixture reply");
  expect(x.f.of("agent.get").map((c) => c.params.target)).toEqual(expect.arrayContaining(["w1:p3", "w1:p5"]));
  expect(x.f.of("agent.get").every((c) => c.params.target !== "w1:p2")).toBe(true);
  expect(x.f.of("agent.prompt")).toHaveLength(1);
  expect(x.f.of("agent.prompt")[0].params).toMatchObject({ target: "w1:p5", text: "new follow-up" });
  await p.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
});

test("session_tree honors each fork boundary on the active ancestry, including navigation back before it", async () => {
  const p = harness(); const x = socketFixture();
  save(p, rec());
  const sourceLeaf = p.manager.getLeafId()!;
  const boundary = p.manager.appendCustomEntry(FORK_BOUNDARY, {});
  // Reusing the name must select only the record on this side of the marker.
  save(p, { ...rec("worker", false), paneId: "w1:p9" });
  const forkLeaf = p.manager.getLeafId()!;
  const secondBoundary = p.manager.appendCustomEntry(FORK_BOUNDARY, {});
  piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  expect(p.section().entries(1_000)).toEqual([]);
  for (const leaf of [sourceLeaf, boundary, forkLeaf, secondBoundary, forkLeaf, boundary]) {
    p.manager.branch(leaf);
    await p.emit("session_tree", { type: "session_tree" });
    const entries = p.section().entries(Date.now());
    if (leaf === sourceLeaf || leaf === forkLeaf) {
      expect(entries.map((e) => e.key)).toEqual(["worker"]);
      expect(entries[0].detail).toContain(leaf === sourceLeaf ? "w1:p2" : "w1:p9");
    } else {
      expect(entries).toEqual([]);
      await p.emit("agent_settled");
      await vi.advanceTimersByTimeAsync(1_000);
    }
  }
  expect(x.f.of("agent.get")).toEqual([]);
  expect(x.f.of("agent.prompt")).toEqual([]);
  expect(PI_CHILD.reply).not.toHaveBeenCalled();
  expect(p.messages).toEqual([]);
  await p.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
});

test("session_tree subscribes to active branch changes, removes abandoned children and ignores an old poll even after a new branch is live", async () => {
  const p = harness(); const x = socketFixture();
  const root = p.manager.appendCustomEntry("fixture:root", {});
  save(p, rec());
  piHerdr(p.pi, deps(x.f.call));
  await p.emit("session_start");
  expect(p.section().entries(1_000).map((e) => e.key)).toEqual(["worker"]);
  const oldPoll = deferred<any>(); x.state.pending = oldPoll;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(x.f.of("agent.get")).toHaveLength(1);
  // Navigate to a different history without restarting the extension.
  p.manager.branch(root);
  save(p, { ...rec("other", false), paneId: "w1:p9" });
  await p.emit("session_tree", { type: "session_tree" });
  expect(p.section().entries(1_000).map((e) => e.key)).toEqual(["other"]);
  expect(p.emitted.filter(([c, d]) => c === "herdr:background" && !d.active)).toHaveLength(1);
  x.state.pending = undefined;
  oldPoll.resolve({ result: { agent: { agent_status: "idle", completion_seq: 2, agent_session: { value: "/fixture/session" } } } });
  await drain();
  expect(p.rawPi.appendEntry).not.toHaveBeenCalled();
  expect(p.messages).toEqual([]);
  expect(p.section().entries(1_000).map((e) => e.key)).toEqual(["other"]);
  p.pi.events.emit(ACTIVITY_HOST, { host: "subagents", priority: 20 });
  expect(p.section().entries(1_000).map((e) => e.key)).toEqual(["other"]);
  await p.emit("session_shutdown");
  expect(p.emitted.some(([c]) => c === ACTIVITY_GONE)).toBe(true);
});

test("branch ancestry guards reject an in-flight completion before session_tree is dispatched", async () => {
  const p = harness(); const x = socketFixture();
  const root = p.manager.appendCustomEntry("fixture:root", {});
  save(p, rec()); piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  const oldPoll = deferred<any>(); x.state.pending = oldPoll;
  await vi.advanceTimersByTimeAsync(1_000);
  p.manager.branch(root);
  oldPoll.resolve({ result: { agent: { agent_status: "idle", completion_seq: 2 } } });
  await drain();
  expect(p.messages).toEqual([]); expect(p.rawPi.appendEntry).not.toHaveBeenCalled();
  expect(p.section().entries(1_000)).toEqual([]);
  expect(p.section().canStop?.("worker")).toBe(false);
  await p.section().stop?.("worker");
  expect(x.f.of("agent.send_keys")).toEqual([]);
  await p.emit("session_shutdown");
});

test("busy replies persist across shutdown, await idle, and durable receipts deduplicate a fresh extension runtime", async () => {
  const p = harness(); const x = socketFixture();
  save(p, rec()); p.state.idle = false;
  piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  x.state.seq = 2;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(p.messages).toEqual([]);
  const saved = p.manager.getBranch().filter((e) => e.type === "custom" && e.customType === "pi-herdr:child").at(-1) as any;
  expect(saved.data).toMatchObject({ awaiting: false, pendingReply: expect.stringContaining("Fixture reply") });
  await p.emit("session_shutdown");
  const fresh = harness(p.manager); fresh.state.idle = false;
  piHerdr(fresh.pi, deps(x.f.call)); await fresh.emit("session_start");
  expect(fresh.messages).toEqual([]);
  fresh.state.staleIdle = true;
  await fresh.emit("agent_settled"); // Stale isIdle must neither throw nor grant delivery permission.
  expect(fresh.messages).toEqual([]);
  fresh.state.staleIdle = false; fresh.state.idle = true;
  await fresh.emit("agent_settled"); await fresh.emit("agent_settled");
  expect(fresh.messages).toHaveLength(1);
  expect(fresh.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  await fresh.emit("session_shutdown");
  // Simulate an older record winning restoration; the durable delivery receipt still wins.
  p.manager.appendCustomEntry("pi-herdr:child", rec());
  const again = harness(p.manager); piHerdr(again.pi, deps(x.f.call)); await again.emit("session_start");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(again.messages).toEqual([]);
  await again.emit("session_shutdown");
});

test("SDK forks inherit delivery receipts even when the parent session id changes before acknowledgement", async () => {
  const p = harness(); const x = socketFixture();
  save(p, { ...rec("worker", false), turnId: "fixture-turn", pendingReply: "already delivered reply" });
  piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  expect(p.messages).toHaveLength(1);
  const marker = p.manager.getBranch().find((e) => e.type === "custom" && e.customType === "pi-herdr:delivered")!;
  const originalSession = p.manager.getSessionId();
  // Fork at the durable receipt, before the acknowledgement record. The inherited pending
  // reply must not be replayed: this history already contains its message and receipt.
  p.manager.createBranchedSession(marker.id);
  expect(p.manager.getSessionId()).not.toBe(originalSession);
  await p.emit("session_start", { reason: "fork" });
  await p.emit("agent_settled");
  expect(p.messages).toHaveLength(1);
  await p.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["marker", "message"])("SDK forks recognize legacy session-prefixed %s receipts", async (kind) => {
  const p = harness(); const x = socketFixture();
  const pending = { ...rec("worker", false), pendingReply: "legacy delivered reply" };
  save(p, pending);
  const legacyKey = JSON.stringify([p.manager.getSessionId(), pending.name, pending.paneId, pending.createdAt, pending.baseline]);
  if (kind === "marker") p.manager.appendCustomEntry("pi-herdr:delivered", { key: legacyKey });
  else p.manager.appendCustomMessageEntry("herdr-child", pending.pendingReply, true, { turnKey: legacyKey });
  p.manager.createBranchedSession(p.manager.getLeafId()!);
  piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start"); await p.emit("agent_settled");
  expect(p.messages).toEqual([]);
  await p.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
});

test("several owed replies recheck idle between deliveries instead of enqueuing during the triggered turn", async () => {
  const p = harness(); const x = socketFixture();
  save(p, { ...rec("one", false), pendingReply: "one reply" });
  save(p, { ...rec("two", false), paneId: "w1:p3", pendingReply: "two reply" });
  p.state.stopOnSend = true;
  piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  expect(p.messages.map((m) => m.message.content)).toEqual(["one reply"]);
  await p.emit("agent_settled");
  expect(p.messages).toHaveLength(1);
  p.state.idle = true; await p.emit("agent_settled");
  expect(p.messages.map((m) => m.message.content)).toEqual(["one reply", "two reply"]);
  await p.emit("session_shutdown");
});

test("in-flight prompt and poll cannot persist, deliver or schedule new work after shutdown/restart", async () => {
  const p = harness(); const x = socketFixture();
  save(p, rec()); piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  const blocked = deferred<any>(); x.state.pending = blocked;
  const sent = p.tool().execute("t", { action: "send", name: "worker", message: "more" }, undefined, undefined, p.ctx);
  const rejected = expect(sent).rejects.toThrow("no longer current");
  await vi.advanceTimersByTimeAsync(1_000);
  await p.emit("session_shutdown");
  // Replace the history with a same-name record in another pane while old reads still await.
  p.manager.resetLeaf(); save(p, { ...rec(), paneId: "w9:p9", awaiting: false });
  x.state.pending = undefined;
  await p.emit("session_start");
  const before = p.rawPi.appendEntry.mock.calls.length;
  blocked.resolve({ result: { agent: { agent_status: "idle", completion_seq: 2 } } });
  await rejected; await drain();
  expect(x.f.of("agent.prompt")).toEqual([]);
  expect(p.rawPi.appendEntry).toHaveBeenCalledTimes(before);
  expect(p.messages).toEqual([]);
  expect(p.section().entries(1_000)[0]).toMatchObject({ detail: expect.stringContaining("w9:p9"), status: "done" });
  await p.emit("session_shutdown");
  const calls = p.emitted.length;
  await p.emit("agent_settled"); await vi.advanceTimersByTimeAsync(60_000);
  expect(p.emitted).toHaveLength(calls);
  expect(vi.getTimerCount()).toBe(0);
});

test("a reply read that resolves after a new prompt cannot finish that new turn", async () => {
  const x = socketFixture(); x.state.seq = 2;
  const reply = deferred<string>();
  const delivered = vi.fn();
  const children = new Children({ ...deps(x.f.call), selfPane: "w1:p1", agent: { kind: "pi", args: () => [], reply: () => reply.promise }, persist: vi.fn(), deliver: delivered, hold: vi.fn() });
  children.restore([rec()]);
  const ticking = children.tick(); await drain();
  await children.send("worker", "another task");
  const nextTurn = children.get("worker").turnId;
  reply.resolve("old reply"); await ticking;
  expect(delivered).not.toHaveBeenCalled();
  expect(children.get("worker")).toMatchObject({ awaiting: true, turnId: nextTurn, baseline: { completionSeq: 2 } });
  children.shutdown();
});

test("actual Pi event bus cannot reoffer a departing source from a reentrant host announcement", async () => {
  const p = harness(); const x = socketFixture();
  save(p, rec()); piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  const source = p.section();
  let announcements = 0;
  p.pi.events.on(ACTIVITY_GONE, (event: any) => {
    if (event.id !== "herdr") return;
    // This is synchronous inside Pi's real createEventBus emit, just like a surviving host.
    announcements++;
    p.pi.events.emit(ACTIVITY_HOST, { host: "subagents", priority: 20 });
  });
  const offers = p.emitted.filter(([c]) => c === ACTIVITY_SECTION).length;
  await p.emit("session_shutdown");
  expect(announcements).toBe(1);
  expect(p.emitted.filter(([c]) => c === ACTIVITY_SECTION)).toHaveLength(offers);
  const gone = p.emitted.findIndex(([c]) => c === ACTIVITY_GONE);
  expect(p.emitted.slice(gone).map(([c]) => c)).toEqual([ACTIVITY_GONE, ACTIVITY_HOST]);
  expect(source.entries(1_000)).toEqual([]);
  expect(source.canStop?.("worker")).toBe(false);
  await source.stop?.("worker");
  expect(x.f.of("agent.send_keys")).toEqual([]);
  await p.emit("session_shutdown");
  expect(announcements).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a rejected poll is contained and retried deterministically", async () => {
  const x = socketFixture(); let fail = true;
  const children = new Children({ ...deps(async (method: string, params: any) => { if (method === "agent.get" && fail) throw new Error("offline"); return x.f.call(method, params); }), selfPane: "w1:p1", agent: { kind: "pi", args: () => [], reply: async () => "reply" }, persist: vi.fn(), deliver: vi.fn(), hold: vi.fn() });
  children.restore([rec()]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(children.get("worker").awaiting).toBe(true);
  fail = false; x.state.seq = 2;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(children.get("worker").awaiting).toBe(false);
  children.shutdown();
});

test.each(["tree", "switch", "fork", "shutdown/restart"])("%s offers only a new section and retained same-name sources cannot act on its children", async (transition) => {
  const p = harness(); const x = socketFixture();
  const root = p.manager.appendCustomEntry("fixture:root", {});
  save(p, rec()); piHerdr(p.pi, deps(x.f.call)); await p.emit("session_start");
  const old = p.section();
  old.setHosted?.(true, "bg");
  const offers = p.emitted.filter(([c]) => c === ACTIVITY_SECTION).length;
  // Announcements from release callbacks must not reoffer a disposed source during restore.
  p.pi.events.on("herdr:background", (e: any) => {
    if (!e.active) p.pi.events.emit(ACTIVITY_HOST, { host: "bg", priority: 10 });
  });
  if (transition === "shutdown/restart") await p.emit("session_shutdown");
  p.manager.branch(root);
  save(p, { ...rec(), paneId: "w9:p9" });
  await p.emit(transition === "tree" ? "session_tree" : "session_start", { reason: transition });
  const fresh = p.section();
  expect(fresh).not.toBe(old);
  expect(p.emitted.filter(([c]) => c === ACTIVITY_SECTION)).toHaveLength(offers + 1);
  p.pi.events.emit(ACTIVITY_HOST, { host: "subagents", priority: 20 });
  expect(p.section()).toBe(fresh);
  expect(old.entries(1_000)).toEqual([]);
  expect(old.pill?.(1_000)).toBeUndefined();
  expect(old.canStop?.("worker")).toBe(false);
  const ui = { custom: vi.fn(async () => undefined) };
  await old.open("worker", ui);
  await old.openDialog?.(ui);
  await old.stop?.("worker");
  expect(ui.custom).not.toHaveBeenCalled();
  expect(x.f.of("agent.send_keys")).toEqual([]);
  expect(fresh.entries(1_000)[0].detail).toContain("w9:p9");
  await fresh.stop?.("worker");
  expect(x.f.of("agent.send_keys").map((c) => c.params)).toEqual([{ target: "w9:p9", keys: ["esc"] }]);
  x.state.seq = 2;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fresh.entries(2_000)[0].status).toBe("done");
  await old.dismiss?.("worker");
  expect(fresh.entries(2_000)).toHaveLength(1);
  await p.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
});

test("delivery receipts deduplicate only their active branch, not a sibling history with the same pending reply", async () => {
  const p = harness(); const x = socketFixture();
  const pending = { ...rec("worker", false), pendingReply: "shared pending reply" };
  save(p, pending);
  const shared = p.manager.getLeafId()!;
  piHerdr(p.pi, deps(x.f.call));
  await p.emit("session_start");
  expect(p.messages).toHaveLength(1);
  const branchA = p.manager.getLeafId()!;
  // B inherits the pending record but neither A's message nor its delivery marker.
  p.manager.branch(shared);
  await p.emit("session_tree");
  expect(p.messages).toHaveLength(2);
  expect(p.messages.map((m) => m.message.content)).toEqual(["shared pending reply", "shared pending reply"]);
  expect(p.messages[0].message.details.turnKey).toBe(p.messages[1].message.details.turnKey);
  const branchB = p.manager.getLeafId()!;
  // Even if an old pending snapshot wins restoration, each branch's own receipts still win.
  for (const leaf of [branchA, branchB]) {
    p.manager.branch(leaf);
    save(p, pending);
    await p.emit("session_tree");
    expect(p.messages).toHaveLength(2);
    await p.emit("session_tree");
    expect(p.messages).toHaveLength(2);
  }
  await p.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
});

test("repeated session_start cancels refresh/PR timers and releases old holds before restoring switched/forked children", async () => {
  vi.stubEnv("PI_HERDR_PR", "1");
  const p = harness(); const x = socketFixture();
  const root = p.manager.appendCustomEntry("fixture:root", {});
  save(p, rec("old"));
  const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "no pull requests found" }));
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  piHerdr(p.pi, { ...deps(x.f.call), exec: run });
  await p.emit("session_start"); await drain();
  expect(vi.getTimerCount()).toBe(4); // child poll, metadata refresh, PR poll, delayed PR
  await vi.advanceTimersByTimeAsync(500);
  const oldTimers = intervals.mock.results.map((r) => r.value);
  p.manager.branch(root); save(p, rec("new"));
  await p.emit("session_start", { reason: "switch" }); await drain();
  for (const timer of oldTimers) expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  expect(vi.getTimerCount()).toBe(4);
  expect(p.emitted.filter(([c]) => c === "herdr:background").map(([, d]) => d)).toEqual([
    { active: true, label: "child old", id: "child:old" },
    { active: false, id: "child:old" },
    { active: true, label: "child new", id: "child:new" },
  ]);
  await vi.advanceTimersByTimeAsync(1_500);
  const gh = () => run.mock.calls.filter((c: any[]) => c[0] === "gh");
  expect(gh()).toHaveLength(0); // the startup session's delayed PR was cancelled
  await vi.advanceTimersByTimeAsync(500);
  expect(gh()).toHaveLength(1);
  await p.emit("agent_settled"); // a pending 5s PR refresh must also be discarded
  await vi.advanceTimersByTimeAsync(500);
  await p.emit("session_start", { reason: "fork" }); await drain();
  expect(vi.getTimerCount()).toBe(4);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(gh()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(298_000);
  expect(gh()).toHaveLength(3); // only this generation's 3-minute PR poll
  const holds = p.emitted.filter(([c]) => c === "herdr:background").map(([, d]) => d);
  expect(holds.slice(-2)).toEqual([{ active: false, id: "child:new" }, { active: true, label: "child new", id: "child:new" }]);
  const bg = x.f.of("pane.report_metadata").filter((c) => c.params.tokens && "bg" in c.params.tokens).at(-1);
  expect(bg?.params.tokens.bg).toBe("↳ 1"); // no old hold or duplicate same-name hold
  await p.emit("session_shutdown");
  expect(vi.getTimerCount()).toBe(0);
  const calls = x.f.log.length;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(x.f.log).toHaveLength(calls);
  expect(gh()).toHaveLength(3);
});
