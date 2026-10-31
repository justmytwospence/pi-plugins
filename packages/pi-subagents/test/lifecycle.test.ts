import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Child } from "../src/child.ts";
import subagents from "../src/index.ts";
import { FAMILY_CHANNEL, type FamilyService, type PreparedAgent } from "../src/family-contract.ts";
import { SUBAGENT_ENV_CHANNEL } from "../src/child.ts";
import { harness } from "./harness.ts";
import { fakeUI, normalFocus } from "./ui-helpers.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeAll(() => initTheme("dark"));
// Drain child completion microtasks as well as the deferred eligibility check they schedule.
const checkpoint = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const explicit = { agent: "general", model: "p/m", thinking: "low" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup(concurrency = 1, exec?: (cmd: string, args: string[]) => any, withBg = false, hasUI = true) {
  vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(path.join(tmpdir(), "subagents-owner-")));
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-queue-"));
  mkdirSync(path.join(cwd, ".pi"));
  writeFileSync(path.join(cwd, ".pi/pi-subagents.json"), JSON.stringify({ concurrency }));
  const children: Child[] = [];
  const spawned = deferred<void>();
  vi.spyOn(Child.prototype, "start").mockImplementation(function (this: Child) {
    children.push(this);
    spawned.resolve();
    return this;
  });
  const h = harness({ exec });
  let tool: any;
  const tools = new Map<string, any>();
  const events = new Map<string, Array<(data: any) => void>>();
  h.pi.events = { emit: (name: string, data: any) => { for (const handler of events.get(name) ?? []) handler(data); }, on: (name: string, handler: (data: any) => void) => { events.set(name, [...(events.get(name) ?? []), handler]); return () => undefined; } };
  h.pi.registerTool = (t: any) => { tools.set(t.name, t); if (t.name === "subagent") tool = t; };
  await subagents(h.pi);
  if (withBg) {
    vi.stubEnv("PI_BG_DIR", cwd);
    const { default: bg } = await import(path.resolve(import.meta.dirname, "../../pi-bg/src/index.ts"));
    await bg(h.pi);
  }
  const ui = fakeUI();
  const ctx = h.ctx({ cwd, ui, hasUI, model: { provider: "p", id: "m" }, hasPendingMessages: () => false });
  await h.emit("session_start", {}, ctx);
  const run = (params: any, signal?: AbortSignal) => tool.execute("run", params, signal, undefined, ctx);
  const shutdown = () => h.emit("session_shutdown", {}, ctx);
  const finish = (index = 0) => (children[index] as any).finish("done");
  return { h, ctx, ui, children, spawned, run, shutdown, finish, tools };
}

function observed(agentId = "child-uuid"): PreparedAgent {
  return {
    agentId, membership: { version: 1, familyId: "family-uuid", agentId },
    observer: () => undefined, extensions: ["/observer.ts"], env: { PI_FAMILY_MEMBER: agentId },
    finish: vi.fn(), dispose: vi.fn(),
  };
}

function installFamily(x: Awaited<ReturnType<typeof setup>>, prepare: FamilyService["prepare"]) {
  x.h.pi.events.on(FAMILY_CHANNEL, (request: any) => { request.service = { prepare }; });
}

test("family enrollment precedes spawn and merges guard env without guarding ordinary workers", async () => {
  const x = await setup();
  const entered = deferred<void>();
  const gate = deferred<PreparedAgent>();
  const prepared = observed();
  const prepare = vi.fn((_descriptor, _signal) => { entered.resolve(); return gate.promise; });
  installFamily(x, prepare);
  x.h.pi.events.on(SUBAGENT_ENV_CHANNEL, (request: any) => { request.env.GUARD_TEST = "kept"; });
  const work = x.run({ ...explicit, task: "enroll", label: "Explicit label" });
  await entered.promise;
  expect(x.children).toHaveLength(0);
  expect(prepare).toHaveBeenCalledWith({ kind: "subagent", label: "Explicit label", operationId: expect.any(String) }, expect.any(AbortSignal));
  gate.resolve(prepared);
  await x.spawned.promise;
  const options = (x.children[0] as any).options;
  expect(options.extensions).toEqual(["/observer.ts"]);
  expect(options.env).toEqual({ GUARD_TEST: "kept", PI_FAMILY_MEMBER: "child-uuid" });
  expect(options.env.PI_SIDEBAR_GUARD).toBeUndefined();
  x.finish();
  const result = await work;
  expect(result.details.runs[0]).toMatchObject({ familyId: "family-uuid", agentId: "child-uuid" });
  expect(prepared.finish).toHaveBeenCalledWith("done", undefined);
  expect(prepared.dispose).toHaveBeenCalledTimes(1);
  await x.shutdown();
});

test.each(["abort", "shutdown", "restart", "reload"])("%s during family enrollment cannot spawn a late child", async (reason) => {
  const x = await setup();
  const entered = deferred<void>();
  const gate = deferred<PreparedAgent>();
  const prepared = observed();
  installFamily(x, () => { entered.resolve(); return gate.promise; });
  const abort = new AbortController();
  const work = x.run({ ...explicit, task: "never enrolled late" }, abort.signal);
  const outcome = work.catch((error: unknown) => error);
  await entered.promise;
  if (reason === "abort") abort.abort();
  else {
    await x.h.emit("session_shutdown", { reason: reason === "reload" ? "reload" : "new" }, x.ctx);
    if (reason === "restart") await x.h.emit("session_start", {}, x.ctx);
  }
  gate.resolve(prepared);
  await outcome;
  await checkpoint();
  expect(x.children).toHaveLength(0);
  expect(prepared.finish).toHaveBeenCalledWith("stopped");
  expect(prepared.dispose).toHaveBeenCalledTimes(1);
  await x.shutdown();
});

test("explicit observation and descendant enrollment remain independent of the max-depth tool runtime", async () => {
  const x = await setup();
  const reservations: Array<{ parent: string; child: string }> = [];
  const prepared: PreparedAgent[] = [];
  const observe = vi.fn();
  const service = (parent: string): FamilyService => ({
    prepare: async () => {
      const child = `member-${reservations.length + 1}`;
      reservations.push({ parent, child });
      const member = observed(child);
      member.observer = (pi) => {
        pi.on("session_start", () => { observe(child); });
        pi.events.on(FAMILY_CHANNEL, (request: any) => { request.service = service(child); });
      };
      prepared.push(member);
      return member;
    },
    focus: () => {}, view: async () => {}, prepareHandoff: async () => { throw new Error("unused"); },
  });
  x.h.pi.events.on(FAMILY_CHANNEL, (request: any) => { request.service = service("main"); });
  await x.run({ ...explicit, task: "child", async: true });
  expect(x.children).toHaveLength(1);

  // Simulate the child loading the explicitly supplied observer before its ordinary tool
  // extension; no full Sidebar UI is loaded. The observer supplies its own scoped service.
  const child = harness();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  child.pi.events = {
    on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
    emit: (name: string, data: unknown) => { for (const handler of listeners.get(name) ?? []) handler(data); },
  };
  await prepared[0]!.observer(child.pi);
  vi.stubEnv("PI_SUBAGENT_DEPTH", "1");
  let tool: any;
  child.pi.registerTool = (registered: any) => { tool = registered; };
  subagents(child.pi);
  const ctx = child.ctx({ cwd: x.ctx.cwd, hasUI: false, model: { provider: "p", id: "m" } });
  await child.emit("session_start", {}, ctx);
  await tool.execute("nested", { ...explicit, task: "grandchild", async: true }, undefined, undefined, ctx);
  expect(reservations).toEqual([{ parent: "main", child: "member-1" }, { parent: "member-1", child: "member-2" }]);

  const grandchild = harness();
  await prepared[1]!.observer(grandchild.pi);
  vi.stubEnv("PI_SUBAGENT_DEPTH", "2");
  const register = vi.spyOn(grandchild.pi, "registerTool");
  subagents(grandchild.pi);
  await grandchild.emit("session_start", {}, grandchild.ctx());
  expect(register).not.toHaveBeenCalled();
  expect(observe.mock.calls.map(call => call[0])).toEqual(["member-1", "member-2"]);
  x.finish(0); x.finish(1);
  await checkpoint();
  await child.emit("session_shutdown", {}, ctx);
  await x.shutdown();
});

test("cancellation inside environment propagation is rechecked before spawn", async () => {
  const x = await setup();
  const prepared = observed();
  const abort = new AbortController();
  installFamily(x, async () => prepared);
  x.h.pi.events.on(SUBAGENT_ENV_CHANNEL, () => abort.abort());
  await expect(x.run({ ...explicit, task: "cancel in hook" }, abort.signal)).rejects.toThrow(/Cancelled|No subagent/);
  expect(x.children).toHaveLength(0);
  expect(prepared.finish).toHaveBeenCalledWith("stopped");
  expect(prepared.dispose).toHaveBeenCalledTimes(1);
  await x.shutdown();
});

test("family enrollment failure fails closed instead of spawning an unobserved child", async () => {
  const x = await setup();
  installFamily(x, async () => { throw new Error("Family unavailable"); });
  await expect(x.run({ ...explicit, task: "never" })).rejects.toThrow("Family unavailable");
  expect(x.children).toHaveLength(0);
  await x.shutdown();
});

test("foreground waiting opens the sole conversation and completion returns to main", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const work = x.run({ ...explicit, task: "foreground" });
  await x.spawned.promise;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await work;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test("async main must become idle; Esc suppresses reopening for that run", async () => {
  const x = await setup();
  normalFocus(x.ui);
  let idle = false;
  x.ctx.isIdle = () => idle;
  await x.run({ ...explicit, task: "async", async: true });
  expect(x.ui.customs).toHaveLength(0);
  idle = true;
  await x.h.emit("agent_settled", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.ui.customs[0]!.component.handleInput("\x1b");
  await checkpoint();
  await x.h.emit("agent_settled", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await checkpoint();
  await x.shutdown();
});

test.each(["draft", "dialog", "overlay failure"])("an automatic open blocked by %s retries when availability returns", async (reason) => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => true;
  const dialog = { handleInput() {}, render: () => ["dialog"] };
  const original = x.ui.tui.showOverlay;
  if (reason === "draft") x.ui.editorText = "new draft";
  if (reason === "dialog") x.ui.tui.focused = dialog;
  if (reason === "overlay failure") x.ui.tui.showOverlay = () => { throw new Error("UI unavailable"); };
  await x.run({ ...explicit, task: "retry", async: true });
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  if (reason === "dialog") expect(x.ui.tui.focused).toBe(dialog);
  if (reason === "draft") expect(x.ui.editorText).toBe("new draft");
  x.ui.tui.showOverlay = original;
  x.ui.editorText = "";
  normalFocus(x.ui);
  await x.h.emit("agent_settled", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test("wait holds are tracked independently and end an untouched auto-view", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  await x.run({ ...explicit, task: "async", async: true });
  const hold = (id: string, active: boolean) => x.h.pi.events.emit("herdr:waiting", { id, active });
  hold("one", true);
  hold("two", true);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  hold("one", false);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  hold("two", false);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await checkpoint();
  await x.shutdown();
});

test("a second call closes an untouched auto-view; two-to-one opens the survivor", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => true;
  await x.run({ ...explicit, task: "one", async: true });
  expect(x.ui.customs).toHaveLength(1);
  await x.run({ ...explicit, task: "two", async: true });
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish(1);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test.each([1, 2])("only active workers count through queued batches (concurrency %i)", async (concurrency) => {
  const x = await setup(concurrency);
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const work = x.run({ tasks: ["first", "last"].map((task) => ({ ...explicit, task })) });
  await x.spawned.promise;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(concurrency === 1 ? 1 : 0);
  x.finish();
  await checkpoint();
  expect(x.children).toHaveLength(2);
  expect(x.ui.customs).toHaveLength(1);
  x.finish(1);
  await work;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test.each(["classifier", "worktree"])("only the running worker counts during delayed %s preparation", async (phase) => {
  const entered = deferred<void>();
  const gate = deferred<any>();
  const x = await setup(1, () => { entered.resolve(); return gate.promise; });
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  x.ctx.modelRegistry = { findOfType: () => ({ provider: "typesafe", id: "jev-latest" }), classify: () => { entered.resolve(); return gate.promise; } };
  // These are separate execute calls: neither has queued the other's tasks.
  const delayed = x.run(phase === "classifier" ? { task: "planning" } : { ...explicit, task: "worktree", worktree: true });
  await entered.promise;
  const first = x.run({ ...explicit, task: "ready" });
  await x.spawned.promise;
  await checkpoint();
  expect(x.children).toHaveLength(1);
  expect(x.ui.customs).toHaveLength(1);
  gate.resolve(phase === "classifier" ? { stopReason: "stop", answers: {} } : { code: 0, stdout: x.ctx.cwd, stderr: "" });
  await checkpoint();
  expect(x.children).toHaveLength(2);
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await first;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish(1);
  await delayed;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test("aborting an independently planning call preserves the sole active worker view", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const entered = deferred<void>();
  const gate = deferred<any>();
  x.ctx.modelRegistry = { findOfType: () => ({ provider: "typesafe", id: "jev-latest" }), classify: () => { entered.resolve(); return gate.promise; } };
  const abort = new AbortController();
  const delayed = x.run({ task: "cancelled planning" }, abort.signal);
  const rejected = expect(delayed).rejects.toThrow(/Cancelled/);
  await entered.promise;
  const first = x.run({ ...explicit, task: "ready" });
  await x.spawned.promise;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  abort.abort();
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  gate.resolve({ stopReason: "stop", answers: {} });
  await rejected;
  expect(x.children).toHaveLength(1);
  x.finish();
  await first;
  await x.shutdown();
});

test("failed independent preparation preserves the sole active worker view", async () => {
  const entered = deferred<void>();
  const gate = deferred<any>();
  const x = await setup(1, () => { entered.resolve(); return gate.promise; });
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const delayed = x.run({ ...explicit, task: "bad worktree", worktree: true });
  const rejected = expect(delayed).rejects.toThrow(/worktree/);
  await entered.promise;
  const first = x.run({ ...explicit, task: "ready" });
  await x.spawned.promise;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  gate.resolve({ code: 1, stdout: "", stderr: "failure" });
  await rejected;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await first;
  await x.shutdown();
});

test("planning failure does not leave a preparation guard behind", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  x.ctx.modelRegistry = { getAll: () => { throw new Error("planning failed"); } };
  await expect(x.run({ task: "failed planning" })).rejects.toThrow("planning failed");
  x.ctx.modelRegistry = {};
  const work = x.run({ ...explicit, task: "ready" });
  await x.spawned.promise;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await work;
  await x.shutdown();
});

test("old classifier completion cannot change a new session's active worker view", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const gates = [deferred<any>(), deferred<any>()];
  let calls = 0;
  x.ctx.modelRegistry = { findOfType: () => ({ provider: "typesafe", id: "jev-latest" }), classify: () => gates[calls++]!.promise };
  const old = x.run({ task: "old planning" });
  const rejected = expect(old).rejects.toThrow(/session ended/);
  await checkpoint();
  await x.shutdown();
  await x.h.emit("session_start", {}, x.ctx);
  normalFocus(x.ui);
  const delayed = x.run({ task: "new planning" });
  const first = x.run({ ...explicit, task: "ready" });
  await x.spawned.promise;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  gates[0]!.resolve({ stopReason: "stop", answers: {} });
  await rejected;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  gates[1]!.resolve({ stopReason: "stop", answers: {} });
  await checkpoint();
  expect(x.children).toHaveLength(2);
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await first;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish(1);
  await delayed;
  await x.shutdown();
});

test.each(["draft", "\x1b[A"])("interaction %j never pins an automatic view", async (key) => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => true;
  await x.run({ ...explicit, task: "one", async: true });
  const view = x.ui.customs[0]!.component;
  view.handleInput(key);
  await x.run({ ...explicit, task: "two", async: true });
  expect(x.ui.customs).toHaveLength(0);
  x.finish(1);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test("an explicitly opened view survives worker completion and main resuming", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "manual", async: true });
  const opened = x.h.commands.get("subagents").handler(started.details.runs[0].id, x.ctx);
  await checkpoint();
  const viewer = x.ui.customs[0]!.component;
  x.finish();
  await checkpoint();
  await x.h.emit("agent_start", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs[0]!.component).toBe(viewer);
  viewer.handleInput("\x1b");
  await opened;
  await x.shutdown();
});

test.each([false, true])("Escape from a live manual view suppresses auto-reopening (switched=%s)", async (switched) => {
  const x = await setup();
  normalFocus(x.ui);
  let idle = false;
  x.ctx.isIdle = () => idle;
  const first = await x.run({ ...explicit, task: "manual first", async: true });
  if (switched) await x.run({ ...explicit, task: "manual second", async: true });
  const opened = x.h.commands.get("subagents").handler(first.details.runs[0].id, x.ctx);
  await checkpoint();
  const viewer = x.ui.customs[0]!.component;
  if (switched) {
    viewer.handleInput("\t");
    x.finish();
  }
  idle = true;
  await x.h.emit("agent_settled", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs[0]!.component).toBe(viewer);
  x.ui.dispatch("\x1b");
  await opened;
  await checkpoint();
  await x.h.emit("agent_settled", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  x.finish(switched ? 1 : 0);
  await x.shutdown();
});

test.each(["before_agent_start", "agent_start", "turn_start"])("%s returns an interacted automatic view to main", async (event) => {
  const x = await setup();
  normalFocus(x.ui);
  let idle = true;
  x.ctx.isIdle = () => idle;
  await x.run({ ...explicit, task: "automatic", async: true });
  x.ui.customs[0]!.component.handleInput("draft");
  idle = false;
  await x.h.emit(event, { prompt: "continue" }, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await x.shutdown();
});

test.each(["done", "failed", "stopped"])("an interacted worker returning %s automatically returns to main", async (status) => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => true;
  await x.run({ ...explicit, task: "finishes", async: true });
  x.ui.customs[0]!.component.handleInput("draft");
  (x.children[0] as any).finish(status);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test("each queued chain step follows its sole active worker", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const work = x.run({ chain: ["first", "second", "third"].map(task => ({ ...explicit, task })) });
  await x.spawned.promise;
  for (let step = 0; step < 3; step++) {
    await checkpoint();
    expect(x.ui.customs).toHaveLength(1);
    expect(x.ui.customs[0]!.component.current.task).toBe(["first", "second", "third"][step]);
    x.finish(step);
  }
  await work;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test("dialog lifecycle and independent blocked holds defer automatic viewing", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => true;
  await x.h.emit("ui_prompt_start", {}, x.ctx);
  x.h.pi.events.emit("herdr:blocked", { id: "approval", active: true });
  await x.run({ ...explicit, task: "waiting safely", async: true });
  expect(x.ui.customs).toHaveLength(0);
  await x.h.emit("ui_prompt_end", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  x.h.pi.events.emit("herdr:blocked", { id: "approval", active: false });
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  await x.h.emit("ui_prompt_start", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.h.emit("ui_prompt_end", {}, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await x.shutdown();
});

test("a wait in a nested tool branch does not hide concurrent main work", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  await x.run({ ...explicit, task: "background worker", async: true });
  await x.h.emit("tool_execution_start", { toolCallId: "code", toolName: "codemode" }, x.ctx);
  await x.h.emit("tool_execution_start", { toolCallId: "code/wait", parentToolCallId: "code", toolName: "bg_wait" }, x.ctx);
  x.h.pi.events.emit("herdr:waiting", { id: "wait", active: true });
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  await x.h.emit("tool_execution_start", { toolCallId: "code/build", parentToolCallId: "code", toolName: "bash" }, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.h.emit("tool_execution_end", { toolCallId: "code/build", toolName: "bash" }, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.h.pi.events.emit("herdr:waiting", { id: "wait", active: false });
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await x.shutdown();
});

test("a foreground worker is a wait, but a concurrent main tool keeps main visible", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  await x.h.emit("tool_execution_start", { toolCallId: "run", toolName: "subagent" }, x.ctx);
  const work = x.run({ ...explicit, task: "foreground worker" });
  await x.spawned.promise;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  await x.h.emit("tool_execution_start", { toolCallId: "check", toolName: "bash" }, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.h.emit("tool_execution_end", { toolCallId: "check", toolName: "bash" }, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await work;
  await x.h.emit("tool_execution_end", { toolCallId: "run", toolName: "subagent" }, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  await x.shutdown();
});

test("anonymous blocked holds are reference-counted independently of named holds", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => true;
  const hold = (active: boolean, id?: string) => x.h.pi.events.emit("herdr:blocked", { active, ...(id ? { id } : {}) });
  hold(true);
  hold(true);
  hold(true, "named");
  await x.run({ ...explicit, task: "behind planner questions", async: true });
  expect(x.ui.customs).toHaveLength(0);
  hold(false);
  hold(false, "named");
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  hold(false);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  // Extra legacy releases are clamped rather than poisoning the next acquisition.
  hold(false);
  hold(true);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  hold(false);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await x.shutdown();
});

test("clearing a main draft retries automatic viewing without another worker event", async () => {
  const x = await setup();
  normalFocus(x.ui);
  x.ctx.isIdle = () => true;
  x.ui.editorText = "main draft";
  await x.run({ ...explicit, task: "draft protected", async: true });
  expect(x.ui.customs).toHaveLength(0);
  x.ui.press("\x15");
  x.ui.editorText = "";
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  x.finish();
  await x.shutdown();
});

test("no UI and shutdown with a pending check cannot create an overlay", async () => {
  const headless = await setup(1, undefined, false, false);
  normalFocus(headless.ui);
  const work = headless.run({ ...explicit, task: "headless" });
  await headless.spawned.promise;
  await checkpoint();
  expect(headless.ui.customs).toHaveLength(0);
  headless.finish();
  await work;
  await headless.shutdown();
  const x = await setup();
  normalFocus(x.ui);
  const pending = x.run({ ...explicit, task: "shutdown" });
  await x.spawned.promise;
  await x.shutdown();
  await pending;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
});

test("already-aborted foreground calls do not even plan", async () => {
  const x = await setup();
  const abort = new AbortController();
  abort.abort();
  x.ctx.modelRegistry = { classify: vi.fn(() => { throw new Error("must not plan"); }) };
  await expect(x.run({ task: "never" }, abort.signal)).rejects.toThrow(/Cancelled/);
  expect(x.ctx.modelRegistry.classify).not.toHaveBeenCalled();
  expect(x.children).toHaveLength(0);
  await x.shutdown();
});

test.each(["abort", "shutdown"])("%s during classifier preparation prevents a late spawn", async (reason) => {
  const x = await setup();
  const entered = deferred<void>();
  const picks = deferred<any>();
  x.ctx.modelRegistry = { findOfType: () => ({ provider: "typesafe", id: "jev-latest" }), classify: () => { entered.resolve(); return picks.promise; } };
  const abort = new AbortController();
  const work = x.run({ task: "never" }, abort.signal);
  const rejected = expect(work).rejects.toThrow(/Cancelled|session ended/);
  await entered.promise;
  if (reason === "abort") abort.abort();
  else await x.shutdown();
  picks.resolve({ stopReason: "stop", answers: {} });
  await rejected;
  expect(x.children).toHaveLength(0);
  await x.shutdown();
});

test.each(["tasks", "chain"])("foreground abort stops the active child and skips queued %s", async (mode) => {
  const x = await setup();
  const abort = new AbortController();
  const work = x.run({ [mode]: ["first", "never"].map((task) => ({ ...explicit, task })) }, abort.signal);
  await x.spawned.promise;
  // startRun registers cancellation after its synchronous start call.
  await Promise.resolve();
  abort.abort();
  const result = await work;
  expect(x.children).toHaveLength(1);
  expect(result.details.runs[0].status).toBe("stopped");
  expect(result.content[0].text).toContain("1 queued task never started");
  await x.shutdown();
});

test.each(["abort", "shutdown", "restart"])("%s while preparing a worktree cannot spawn after preparation returns", async (reason) => {
  const entered = deferred<void>();
  const prepared = deferred<any>();
  const x = await setup(1, () => { entered.resolve(); return prepared.promise; });
  const abort = new AbortController();
  const work = x.run({ ...explicit, task: "never", worktree: true }, abort.signal);
  const rejected = expect(work).rejects.toThrow(/Cancelled|No subagent/);
  await entered.promise;
  if (reason === "abort") abort.abort();
  else {
    await x.shutdown();
    if (reason === "restart") await x.h.emit("session_start", {}, x.ctx);
  }
  prepared.resolve({ code: 0, stdout: x.ctx.cwd, stderr: "" });
  await rejected;
  expect(x.children).toHaveLength(0);
  await x.shutdown();
});

test("a failed parallel preparation cancels other in-flight preparations and the rest of the queue", async () => {
  const gates = [deferred<any>(), deferred<any>()];
  let preparing = 0;
  const entered = deferred<void>();
  // rev-parse answers at once; each `git worktree add` waits on its gate.
  const x = await setup(2, (_cmd: string, args: string[]) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: "/repo/.git\n", stderr: "" };
    const gate = gates[preparing++]; if (preparing === 2) entered.resolve(); return gate!.promise;
  });
  const work = x.run({ tasks: ["bad", "in flight", "queued"].map((task) => ({ ...explicit, task })), worktree: true });
  const rejected = expect(work).rejects.toThrow(/worktree/);
  await entered.promise;
  gates[0]!.resolve({ code: 1, stdout: "", stderr: "failure" });
  await Promise.resolve();
  await Promise.resolve();
  gates[1]!.resolve({ code: 0, stdout: x.ctx.cwd, stderr: "" });
  await rejected;
  expect(x.children).toHaveLength(0);
  expect(preparing).toBe(2);
  await x.shutdown();
});

test("deliberate async ignores even an already-aborted turn, including subsequent queued work", async () => {
  const x = await setup();
  const abort = new AbortController();
  abort.abort();
  const result = await x.run({ tasks: ["first", "second"].map((task) => ({ ...explicit, task })), async: true }, abort.signal);
  expect(result.details.runs).toHaveLength(1);
  x.finish();
  await vi.waitFor(() => expect(x.children).toHaveLength(2));
  x.finish(1);
  await vi.waitFor(() => expect(x.h.messages).toHaveLength(1));
  await x.shutdown();
});

test("shutdown during deliberate async preparation still prevents a late spawn", async () => {
  const entered = deferred<void>();
  const prepared = deferred<any>();
  const x = await setup(1, () => { entered.resolve(); return prepared.promise; });
  const call = x.run({ ...explicit, task: "never", async: true, worktree: true });
  await entered.promise;
  await call;
  await x.shutdown();
  await x.h.emit("session_start", {}, x.ctx);
  prepared.resolve({ code: 0, stdout: x.ctx.cwd, stderr: "" });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(x.children).toHaveLength(0);
  expect(x.h.messages).toHaveLength(0);
  await x.shutdown();
});

test("deliberate async preparation ignores a subsequent turn abort", async () => {
  const entered = deferred<void>();
  const prepared = deferred<any>();
  const x = await setup(1, () => { entered.resolve(); return prepared.promise; });
  const abort = new AbortController();
  const call = x.run({ ...explicit, task: "continues", async: true, worktree: true }, abort.signal);
  await entered.promise;
  abort.abort();
  prepared.resolve({ code: 0, stdout: x.ctx.cwd, stderr: "" });
  await x.spawned.promise;
  await call;
  expect(x.children).toHaveLength(1);
  await x.shutdown();
});

test("detached foreground work survives turn abort but not session shutdown", async () => {
  const x = await setup();
  const abort = new AbortController();
  normalFocus(x.ui);
  const work = x.run({ tasks: ["first", "never"].map((task) => ({ ...explicit, task })) }, abort.signal);
  await x.spawned.promise;
  await Promise.resolve();
  expect(x.ui.press("\x1b[B")).toBe(true);
  expect(x.ui.press("b")).toBe(true);
  await work;
  abort.abort();
  expect(x.children[0]!.state.status).toBe("running");
  await x.shutdown();
  await x.h.emit("session_start", {}, x.ctx);
  await Promise.resolve();
  await Promise.resolve();
  expect(x.children).toHaveLength(1);
  expect(x.h.messages).toHaveLength(0);
  await x.shutdown();
});

test("Child stop-before-start settles without spawning, and a second start is ignored", async () => {
  vi.restoreAllMocks();
  const child = new Child({ task: "never", cwd: "/", model: "p/m", thinking: "low", sessionDir: "/tmp", invocation: { command: "must-not-exist", args: [] } });
  child.stop();
  child.start().start();
  expect((await child.done).status).toBe("stopped");
});

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test.each(["before queue", "after queue"])("reading a completed result %s suppresses its wake-up", async (when) => {
  const x = await setup();
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "already handled", async: true });
  const id = started.details.runs[0].id;
  x.finish();
  if (when === "after queue") await tick();
  await x.run({ action: "result", id });
  await x.run({ action: "result", id });
  await tick();
  x.ctx.isIdle = () => true;
  await x.h.emit("agent_settled", {}, x.ctx);
  expect(x.h.messages).toHaveLength(0);
  await x.shutdown();
});

test.each(["failed", "stopped"])("consuming a %s result suppresses its completion", async (status) => {
  const x = await setup();
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "finished failure", async: true });
  (x.children[0] as any).finish(status, "permission blocker");
  await tick();
  const result = await x.run({ action: "result", id: started.details.runs[0].id });
  expect(result.content[0].text).toContain(status);
  x.ctx.isIdle = () => true;
  await x.h.emit("agent_settled", {}, x.ctx);
  expect(x.h.messages).toHaveLength(0);
  await x.shutdown();
});

test("status inspection does not consume an unread completion", async () => {
  const x = await setup();
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "status only", async: true });
  x.finish(); await tick();
  await x.run({ action: "status", id: started.details.runs[0].id });
  x.ctx.isIdle = () => true;
  await x.h.emit("agent_settled", {}, x.ctx);
  expect(x.h.messages).toHaveLength(1);
  await x.shutdown();
});

test("a running snapshot does not consume the later completion", async () => {
  const x = await setup();
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "unread", async: true });
  await x.run({ action: "result", id: started.details.runs[0].id });
  x.finish(); await tick();
  x.ctx.isIdle = () => true;
  await x.h.emit("agent_settled", {}, x.ctx);
  await x.h.emit("agent_settled", {}, x.ctx);
  expect(x.h.messages).toHaveLength(1);
  expect(x.h.messages[0].message.content).toContain("unread");
  await x.shutdown();
});

test.each(["tasks", "chain"])("partial %s consumption preserves only unread members", async (mode) => {
  const x = await setup();
  x.ctx.isIdle = () => false;
  const started = await x.run({ [mode]: ["handled member", "unread member"].map(task => ({ ...explicit, task })), async: true });
  x.finish();
  await vi.waitFor(() => expect(x.children).toHaveLength(2));
  await x.run({ action: "result", id: started.details.runs[0].id });
  x.finish(1); await tick();
  x.ctx.isIdle = () => true;
  await x.h.emit("agent_settled", {}, x.ctx);
  expect(x.h.messages).toHaveLength(1);
  expect(x.h.messages[0].message.content).toContain("unread member");
  expect(x.h.messages[0].message.content).not.toContain("handled member");
  expect(x.h.messages[0].message.details.runs).toHaveLength(1);
  await x.shutdown();
});

test("actual pi-bg waiting opens the only conversation and releases it on interruption", async () => {
  const x = await setup(1, undefined, true);
  Object.assign(x.ui, { setWorkingMessage: () => undefined });
  normalFocus(x.ui);
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "wait for me", async: true });
  expect(x.ui.customs).toHaveLength(0);
  const abort = new AbortController();
  const waiting = x.tools.get("bg_wait").execute("wait", { id: `subagent:${started.details.runs[0].id}`, timeout: 2 }, abort.signal, undefined, x.ctx);
  await checkpoint();
  expect(x.ui.customs).toHaveLength(1);
  abort.abort();
  await waiting;
  await checkpoint();
  expect(x.ui.customs).toHaveLength(0);
  x.finish();
  await checkpoint();
  await x.shutdown();
});

test.each(["finished", "running"])("actual bg_wait consumes %s subagent output", async (when) => {
  const x = await setup(1, undefined, true);
  x.ctx.hasUI = false;
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "waited result", async: true });
  const id = started.details.runs[0].id;
  x.children[0]!.state.output = "Full worker findings";
  if (when === "finished") { x.finish(); await tick(); }
  const waiting = x.tools.get("bg_wait").execute("wait", { id: `subagent:${id}`, timeout: 2 }, undefined, undefined, x.ctx);
  if (when === "running") { x.finish(); await tick(); }
  const result = await waiting;
  expect(result.content.map((c: { text: string }) => c.text).join("\n\n")).toContain("Full worker findings");
  await tick();
  x.ctx.isIdle = () => true;
  await x.h.emit("agent_settled", {}, x.ctx);
  expect(x.h.messages).toHaveLength(0);
  await x.shutdown();
});

test.each(["aborted", "timeout"])("a %s bg_wait does not consume a later result", async (reason) => {
  const x = await setup(1, undefined, true);
  x.ctx.hasUI = false;
  x.ctx.isIdle = () => false;
  const started = await x.run({ ...explicit, task: "still unread", async: true });
  const abort = new AbortController();
  const waiting = x.tools.get("bg_wait").execute("wait", { id: `subagent:${started.details.runs[0].id}`, timeout: 1 }, abort.signal, undefined, x.ctx);
  if (reason === "aborted") abort.abort();
  await waiting;
  x.finish(); await tick();
  x.ctx.isIdle = () => true;
  await x.h.emit("agent_settled", {}, x.ctx);
  expect(x.h.messages).toHaveLength(1);
  await x.shutdown();
});
