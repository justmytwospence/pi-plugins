import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { handoff, interactiveCommand } from "../src/handoff.ts";

afterEach(() => vi.unstubAllEnvs());

test("only the explicit i word is intercepted", () => {
  for (const text of ["sudo true", "id", "install x", "i-have-a-command"]) expect(interactiveCommand(text)).toBeUndefined();
  expect(interactiveCommand("i")).toBe("");
  expect(interactiveCommand("i \t ")).toBe("");
  expect(interactiveCommand("i\tprintf 'a b'")).toBe("printf 'a b'");
});

async function run(result: any, shell = "/bin/test-shell") {
  vi.stubEnv("SHELL", shell);
  const order: string[] = [];
  const tui = { stop: vi.fn(() => { order.push("stop"); }), start: vi.fn(() => { order.push("start"); }), requestRender: vi.fn() };
  const spawn = vi.fn((..._args: any[]) => {
    order.push("spawn");
    if (result instanceof Error) throw result;
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (result.error) child.emit("error", result.error);
      else child.emit("exit", result.status, result.signal);
    });
    return child;
  });
  const write = vi.fn();
  const listeners = process.listeners("SIGINT");
  const output = await handoff(tui, "printf private-terminal-output", "/tmp", spawn as any, write);
  expect(process.listeners("SIGINT")).toEqual(listeners);
  return { order, tui, spawn, write, output };
}

test("uses inherited terminal stdio, cwd, shell and status only", async () => {
  const x = await run({ status: 7, signal: null, stdout: "DO-NOT-CAPTURE", stderr: "DO-NOT-CAPTURE" });
  expect(x.spawn).toHaveBeenCalledWith("/bin/test-shell", ["-c", "printf private-terminal-output"], { cwd: "/tmp", stdio: "inherit", env: process.env });
  expect(x.order).toEqual(["stop", "spawn", "start"]);
  expect(x.tui.requestRender).toHaveBeenCalledWith(true);
  expect(x.output).toEqual({ output: "(interactive command exited with code 7)", exitCode: 7, cancelled: false, truncated: false });
  expect(JSON.stringify(x.output)).not.toContain("DO-NOT-CAPTURE");
});

test("falls back to /bin/sh", async () => {
  expect((await run({ status: 0 }, "")).spawn.mock.calls[0][0]).toBe("/bin/sh");
});

test.each([
  [{ status: null, signal: "SIGINT" }, 130, true],
  [{ status: null, signal: "SIGTERM" }, 1, true],
  [{ status: null, signal: "SIGKILL" }, 1, false],
  [{ status: null, error: new Error("missing shell") }, 1, false],
  [new Error("spawn threw"), 1, false],
])("restores the TUI after interruption or failure (%j)", async (result, code, cancelled) => {
  const x = await run(result);
  expect(x.output.exitCode).toBe(code);
  expect(x.output.cancelled).toBe(cancelled);
  expect(x.tui.start).toHaveBeenCalledOnce();
  expect(x.tui.requestRender).toHaveBeenCalledWith(true);
});

test("restores even if terminal setup throws", async () => {
  const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
  const spawn = vi.fn();
  const result = await handoff(tui, "true", "/tmp", spawn as any, () => { throw new Error("write failed"); });
  expect(result.exitCode).toBe(1);
  expect(spawn).not.toHaveBeenCalled();
  expect(tui.start).toHaveBeenCalledOnce();
});
