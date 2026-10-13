import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Child } from "../src/child.ts";
import subagents from "../src/index.ts";
import { harness } from "./harness.ts";
import { fakeUI, normalFocus } from "./ui-helpers.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const explicit = { agent: "general", model: "p/m", thinking: "low" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup(concurrency = 1, exec?: (cmd: string, args: string[]) => any) {
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
  h.pi.registerTool = (t: any) => { tool = t; };
  await subagents(h.pi);
  const ui = fakeUI();
  const ctx = h.ctx({ cwd, ui, model: { provider: "p", id: "m" } });
  await h.emit("session_start", {}, ctx);
  const run = (params: any, signal?: AbortSignal) => tool.execute("run", params, signal, undefined, ctx);
  const shutdown = () => h.emit("session_shutdown", {}, ctx);
  const finish = (index = 0) => (children[index] as any).finish("done");
  return { h, ctx, ui, children, spawned, run, shutdown, finish };
}

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
