import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import piBg from "../src/index.ts";
import type { StartOptions, Task, TaskEvent } from "../src/registry.ts";
import { WORKING_MESSAGE_EVENT } from "../src/working-message.ts";
import { fakeCtx, fakePi } from "./fake.ts";

const { registryMock } = vi.hoisted(() => ({ registryMock: vi.fn() }));
vi.mock("../src/registry.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/registry.ts")>(), registry: registryMock,
}));

let dir: string;
let f: ReturnType<typeof fakePi>;
let c: ReturnType<typeof fakeCtx>;
let reg: ReturnType<typeof fakeRegistry>;
let callId: number;

function fakeRegistry() {
  const tasks = new Map<string, Task>();
  const listeners = new Set<(event: TaskEvent) => void>();
  const list = (sid?: string) => [...tasks.values()].filter((t) => !sid || t.sessionId === sid);
  const emit = (type: TaskEvent["type"], task: Task) => { for (const listener of listeners) listener({ type, task }); };
  return {
    tasks, list, emit, cleared: new Set<string>(),
    running: (sid?: string) => list(sid).filter((t) => t.status === "running"),
    find: (id: string, sid?: string) => list(sid).find((t) => t.id === id) ?? list(sid).filter((t) => t.name === id).at(-1) ?? list(sid).find((t) => t.id.startsWith(id)),
    start: (options: StartOptions) => {
      const id = `task${tasks.size + 1}`;
      const logPath = path.join(dir, `${id}.log`);
      fs.writeFileSync(logPath, "concurrent-failure\n");
      const task: Task = { id, name: options.name, kind: options.kind, command: options.command, cwd: options.cwd, sessionId: options.sessionId, origin: options.origin, logPath, startedAt: Date.now(), status: "running", ready: false, readyPattern: options.ready, keep: false, delivered: false, readyDelivered: false };
      tasks.set(id, task); emit("start", task); return task;
    },
    subscribe: (listener: (event: TaskEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    attach: vi.fn(), detach: vi.fn(), sweep: () => [], forgetEnded: vi.fn(), release: vi.fn(), killAll: vi.fn(async () => {}),
  };
}

async function event(name: string, reason = "startup") {
  for (const handler of f.handlers.get(name) ?? []) await handler({ reason }, c.ctx);
}
function call(tool: string, params: object, signal?: AbortSignal) {
  return f.tools.get(tool).execute(`call-${++callId}`, params, signal, undefined, c.ctx) as Promise<any>;
}
function start(kind: "job" | "service" = "job") {
  return call("bg_run", { command: "echo concurrent-failure; exit 2", kind, name: "build", ...(kind === "service" ? { ready: "ready" } : {}) });
}
function task() { return [...reg.tasks.values()][0]!; }
function end(emit = true) {
  const t = task(); Object.assign(t, { status: "failed", exitCode: 2, endedAt: Date.now() });
  if (emit) reg.emit("end", t);
}
function ready() { const t = task(); t.ready = true; t.readyLine = "ready"; reg.emit("ready", t); }
function textOf(result: any): string { return result.content.map((p: any) => p.text).join("\n"); }
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function tracked(p: Promise<any>) {
  const state: { result?: any } = {};
  void p.then((result) => { state.result = result; });
  return state;
}
async function runningJob() { const p = start(); await vi.advanceTimersByTimeAsync(1_500); await p; }

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000); callId = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-wait-"));
  reg = fakeRegistry(); registryMock.mockReturnValue(reg); f = fakePi(); c = fakeCtx(dir);
  piBg(f.pi as any); await event("session_start");
});
afterEach(async () => {
  await event("session_shutdown", "quit");
  vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true });
});

it("same tick startup and named wait both settle on failure", async () => {
  const run = tracked(start());
  const wait = tracked(call("bg_wait", { id: "build", timeout: 30 }));
  end(); await flush();
  expect(run.result, "bg_run settled after the end event").toBeDefined();
  expect(wait.result, "bg_wait settled after the same end event").toBeDefined();
  expect(textOf(run.result)).toMatch(/ended at once/);
  expect(textOf(wait.result)).toMatch(/exit 2[\s\S]*concurrent-failure/);
  expect(textOf(wait.result)).not.toMatch(/Still running/);
});

it.each(["named", "any"])("two concurrent waits receive one job outcome (%s)", async (second) => {
  await runningJob();
  const a = tracked(call("bg_wait", { id: "build" }));
  const b = tracked(call("bg_wait", second === "named" ? { id: "build" } : {}));
  end(); await flush();
  expect(a.result).toBeDefined(); expect(b.result).toBeDefined();
  for (const result of [a.result, b.result]) expect(textOf(result)).toMatch(/exit 2[\s\S]*concurrent-failure/);
});

it("named and id waits return an already delivered outcome immediately", async () => {
  const run = start(); end(); await run;
  for (const id of ["build", task().id]) {
    const wait = tracked(call("bg_wait", { id })); await flush();
    expect(wait.result).toBeDefined(); expect(textOf(wait.result)).toMatch(/exit 2[\s\S]*concurrent-failure/);
  }
});

it("service readiness reaches startup and both waits, including a late wait", async () => {
  const run = tracked(start("service"));
  const a = tracked(call("bg_wait", { id: "build" }));
  const b = tracked(call("bg_wait", { id: "build" }));
  ready(); await flush();
  for (const item of [run, a, b]) { expect(item.result).toBeDefined(); expect(textOf(item.result)).toMatch(/ready/i); }
  const late = tracked(call("bg_wait", { id: "build" })); await flush();
  expect(late.result).toBeDefined(); expect(textOf(late.result)).toMatch(/ready/i);
});

it.each(["normal", "message", "abort"])("tick reconciles an unannounced end before %s", async (mode) => {
  await runningJob();
  const controller = new AbortController();
  const wait = tracked(call("bg_wait", { id: "build" }, controller.signal));
  end(false); task().delivered = true;
  if (mode === "message") c.state.pending = true;
  if (mode === "abort") controller.abort();
  await vi.advanceTimersByTimeAsync(250);
  expect(wait.result).toBeDefined(); expect(textOf(wait.result)).toMatch(/exit 2/);
  expect(textOf(wait.result)).not.toMatch(/Still running/);
});

it("reconciles an end during working-message setup before registration", async () => {
  await runningJob();
  const original = c.ctx.ui.setWorkingMessage;
  vi.spyOn(c.ctx.ui, "setWorkingMessage").mockImplementationOnce((message) => { const result = original(message); end(); return result; });
  const wait = tracked(call("bg_wait", { id: "build" })); await flush();
  expect(wait.result).toBeDefined(); expect(textOf(wait.result)).toMatch(/exit 2/);
  expect(f.sent).toEqual([]);
});

it("returns an unannounced outcome even if the context becomes stale", async () => {
  await runningJob();
  let stale = false;
  const original = c.ctx.ui.setWorkingMessage;
  vi.spyOn(c.ctx.ui, "setWorkingMessage").mockImplementation((message) => {
    if (stale) throw new Error("stale context");
    return original(message);
  });
  const wait = tracked(call("bg_wait", { id: "build" }));
  end(false); stale = true;
  await vi.advanceTimersByTimeAsync(250);
  expect(wait.result).toBeDefined();
  expect(textOf(wait.result)).toMatch(/exit 2/);
});

it("reconciles an end at the timeout boundary", async () => {
  await runningJob();
  setTimeout(() => end(false), 1_000);
  const wait = tracked(call("bg_wait", { id: "build", timeout: 1 }));
  vi.advanceTimersByTime(1_000); await flush();
  expect(wait.result).toBeDefined(); expect(textOf(wait.result)).toMatch(/exit 2/);
  expect(textOf(wait.result)).not.toMatch(/Still running/);
});

it("reports only genuinely running work on cancellation", async () => {
  await runningJob();
  const a = call("bg_wait", { id: "build", timeout: 1 });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(textOf(await a)).toMatch(/Still running: build/);
  const controller = new AbortController();
  const b = call("bg_wait", { id: "build" }, controller.signal);
  end(false); controller.abort(); await vi.advanceTimersByTimeAsync(250);
  expect(textOf(await b)).not.toMatch(/Still running: build/);
});

it("external cancellation does not call completed work still running", async () => {
  f.pi.events.emit("bg:external", { id: "external", label: "outside", state: "running" });
  const controller = new AbortController();
  const wait = call("bg_wait", { id: "external" }, controller.signal);
  controller.abort(); await vi.advanceTimersByTimeAsync(250);
  expect(textOf(await wait)).toMatch(/Still running: outside/);
});

it("returns an external result completed during setup", async () => {
  f.pi.events.emit("bg:external", { id: "external", label: "outside", state: "running" });
  const original = c.ctx.ui.setWorkingMessage;
  vi.spyOn(c.ctx.ui, "setWorkingMessage").mockImplementationOnce((message) => {
    const result = original(message);
    f.pi.events.emit("bg:external", { id: "external", label: "outside", state: "done", result: "IMPORTANT RESULT" });
    return result;
  });
  const wait = tracked(call("bg_wait", { id: "external" }));
  await flush();
  expect(wait.result).toBeDefined();
  expect(textOf(wait.result)).toContain("IMPORTANT RESULT");
  expect(f.emitted).toContainEqual({ channel: "bg:external-consumed", data: { id: "external" } });
});

it.each([false, true])("concurrent results release holds without wake-ups (busy=%s)", async (busy) => {
  c.state.busy = busy;
  const run = tracked(start());
  const a = tracked(call("bg_wait", { id: "build" }));
  const b = tracked(call("bg_wait", { id: "build" }));
  end(); await flush();
  for (const item of [run, a, b]) expect(item.result).toBeDefined();
  await vi.advanceTimersByTimeAsync(0); c.state.busy = false;
  await event("agent_settled"); await event("turn_end");
  expect(f.sent).toEqual([]);
  const waitTool = f.tools.get("bg_wait");
  for (const id of ["call-2", "call-3"]) {
    const view = waitTool.renderResult({ content: [{ type: "text", text: "finished" }] }, { expanded: false, isPartial: true }, c.theme, { toolCallId: id });
    expect(view.render(200).join("\n")).not.toMatch(/build running/);
  }
  const holds = f.emitted.filter((e) => e.channel === "herdr:waiting");
  const owners = holds.filter((e) => e.data.active).map((e) => e.data.id);
  expect(new Set(owners).size).toBe(2);
  for (const owner of owners) {
    expect(holds.some((e) => e.data.id === owner && !e.data.active)).toBe(true);
    expect(f.emitted.some((e) => e.channel === WORKING_MESSAGE_EVENT && e.data.owner === owner && !e.data.message)).toBe(true);
  }
});
