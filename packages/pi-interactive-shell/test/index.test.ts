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
    ui: { custom: vi.fn((factory: any) => new Promise(resolve => { factory({}, {}, {}, resolve); })) }, ...overrides };
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

test.each([false, true])("explicit handoffs use an overlay and event cwd; Pi owns exclusion=%s", async (exclude) => {
  const result = { output: "status only", exitCode: 0, cancelled: false, truncated: false as const };
  const spy = vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done) => {
    queueMicrotask(() => done(result));
    return {} as any;
  });
  const h = harness();
  expect(await h.bash("i sudo true", exclude)).toEqual({ result });
  expect(spy).toHaveBeenCalledWith({}, {}, "sudo true", "/session/cwd", expect.any(Function));
  expect(h.ctx.ui.custom.mock.calls[0][1].overlay).toBe(true);
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

test("agent starts wait for panel dismissal; reload stops the panel", async () => {
  const result = { output: "stopped", exitCode: 130, cancelled: true, truncated: false as const };
  let finish!: (value: typeof result) => void;
  const shutdown = vi.fn(async () => { finish(result); });
  vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done) => {
    finish = done; return { shutdown } as any;
  });
  const h = harness();
  const running = h.bash("i true");
  expect((await h.bash("i another-command")).result.exitCode).toBe(1);
  let started = false;
  const start = h.handlers.get("before_agent_start")().then(() => { started = true; });
  await Promise.resolve();
  expect(started).toBe(false);
  await h.handlers.get("session_shutdown")();
  await Promise.all([running, start]);
  expect(shutdown).toHaveBeenCalledOnce();
  expect(started).toBe(true);
});

test("capability is session-scoped and absent outside TUI", async () => {
  const h = harness();
  const reply = vi.fn();
  h.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
  await h.handlers.get("session_shutdown")();
  h.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
  const rpc = harness({ mode: "rpc" });
  rpc.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
});
