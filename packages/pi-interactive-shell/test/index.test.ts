import { afterEach, expect, test, vi } from "vitest";
import interactiveShell from "../src/index.ts";
import * as handoffModule from "../src/handoff.ts";

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, original] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
    if (original) Object.defineProperty(stream, "isTTY", original);
    else delete (stream as any).isTTY;
  }
});

function harness(overrides: any = {}) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const handlers = new Map<string, any>();
  const events = new Map<string, any>();
  const pi = { on: (key: string, fn: any) => handlers.set(key, fn), events: {
    on: (key: string, fn: any) => events.set(key, fn), emit: vi.fn(),
  } };
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true,
    ui: { custom: vi.fn(async (factory: any) => { let result; await factory({}, {}, {}, (r: any) => { result = r; }); return result; }) }, ...overrides };
  interactiveShell(pi as any);
  handlers.get("session_start")({}, ctx);
  const bash = (command: string, excludeFromContext = false) => handlers.get("user_bash")({ command, cwd: "/session/cwd", excludeFromContext }, ctx);
  return { ctx, handlers, events, pi, bash };
}

test("ordinary bang commands pass through, including ones named id/install", async () => {
  const h = harness();
  expect(await h.bash("id")).toBeUndefined();
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
});

test.each([false, true])("explicit handoffs use the event cwd; Pi owns exclusion=%s", async (exclude) => {
  const result = { output: "status only", exitCode: 0, cancelled: false, truncated: false };
  const spy = vi.spyOn(handoffModule, "handoff").mockResolvedValue(result);
  const h = harness();
  expect(await h.bash("i sudo true", exclude)).toEqual({ result });
  expect(spy).toHaveBeenCalledWith({}, "sudo true", "/session/cwd");
  expect(h.pi.events.emit).toHaveBeenCalledWith("prompt:clear", {});
});

test.each([{ mode: "rpc" }, { mode: "print", hasUI: false }, { isIdle: () => false }])("rejects unsupported or busy contexts without executing (%j)", async (overrides) => {
  const h = harness(overrides);
  expect((await h.bash("i true")).result.exitCode).toBe(1);
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
});

test("rejects empty commands and missing terminals", async () => {
  const h = harness();
  expect((await h.bash("i")).result.output).toContain("usage");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  expect((await h.bash("i true")).result.output).toContain("interactive terminal");
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
});

test("agent starts and reload wait until the terminal is released", async () => {
  let finish!: (result: ReturnType<typeof handoffModule.failure>) => void;
  vi.spyOn(handoffModule, "handoff").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const h = harness();
  const running = h.bash("i true");
  expect((await h.bash("i another-command")).result.exitCode).toBe(1);
  let started = false;
  let shutDown = false;
  const start = h.handlers.get("before_agent_start")().then(() => { started = true; });
  const shutdown = h.handlers.get("session_shutdown")().then(() => { shutDown = true; });
  await Promise.resolve();
  expect(started).toBe(false);
  expect(shutDown).toBe(false);
  finish({ output: "status", exitCode: 0, cancelled: false, truncated: false });
  await Promise.all([running, start, shutdown]);
  expect(started).toBe(true);
  expect(shutDown).toBe(true);
});

test("capability is session-scoped and absent outside TUI", () => {
  const h = harness();
  const reply = vi.fn();
  h.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
  h.handlers.get("session_shutdown")();
  h.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
  const rpc = harness({ mode: "rpc" });
  rpc.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
});
