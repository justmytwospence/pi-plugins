import { beforeEach, expect, test, vi } from "vitest";
import { failure, handoff, interactiveCommand } from "../src/handoff.ts";
import { TerminalPanel } from "../src/panel.ts";
import { spawnPty, stopPty, type PtyProcess } from "../src/pty.ts";

vi.mock("../src/pty.ts", () => ({ spawnPty: vi.fn(), stopPty: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

const tui = () => ({ terminal: { columns: 80, rows: 24 }, requestRender: vi.fn() });
const theme = { fg: (_color: string, text: string) => text };

function immediateExitPty() {
  const dispose = vi.fn();
  const pty: PtyProcess = {
    pid: 12345, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: vi.fn(() => ({ dispose })),
    onExit: vi.fn(callback => {
      callback({ exitCode: 127, signal: 0 });
      return { dispose };
    }),
  };
  return { pty, dispose };
}

test("only the explicit i word is intercepted", () => {
  for (const text of ["sudo true", "id", "install x", "i-have-a-command"]) expect(interactiveCommand(text)).toBeUndefined();
  expect(interactiveCommand("i")).toBe("");
  expect(interactiveCommand("i \t ")).toBe("");
  expect(interactiveCommand("i\tprintf 'a b'")).toBe("printf 'a b'");
});

test.each([false, true])("real handoff forwards optional onStarted before immediate exit (callback %s)", async withCallback => {
  const { pty, dispose } = immediateExitPty();
  vi.mocked(spawnPty).mockResolvedValueOnce(pty);
  const done = vi.fn();
  const onStarted = vi.fn(() => {
    expect((panel as any).pty).toBe(pty);
    expect(pty.onExit).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
  const command = "printf '%s' 'a  b'; exit 127";
  const panel = handoff(tui() as any, theme as any, command, "/tmp", done, false, true, withCallback ? onStarted : undefined);
  expect(panel).toBeInstanceOf(TerminalPanel);
  expect(spawnPty).not.toHaveBeenCalled();
  expect(onStarted).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(spawnPty).toHaveBeenCalledExactlyOnceWith(command, "/tmp", 74, 8);
  expect(onStarted).toHaveBeenCalledTimes(withCallback ? 1 : 0);
  expect(stopPty).toHaveBeenCalledExactlyOnceWith(pty);
  expect(done.mock.calls[0][0]).toMatchObject({ exitCode: 127, cancelled: false });
  expect(done.mock.calls[0][1].render(80).join("")).toContain("Exited · output retained");
  await panel.shutdown();
  await panel.start();
  expect(done).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledTimes(2);
});

test("real handoff does not report a rejected spawn as started", async () => {
  vi.mocked(spawnPty).mockRejectedValueOnce(new Error("spawn rejected"));
  const done = vi.fn();
  const onStarted = vi.fn();
  const panel = handoff(tui() as any, theme as any, "true", "/tmp", done, false, true, onStarted);
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  await panel.shutdown();
  expect(spawnPty).toHaveBeenCalledOnce();
  expect(onStarted).not.toHaveBeenCalled();
  expect(stopPty).not.toHaveBeenCalled();
  expect(done.mock.calls[0][0]).toEqual(failure("spawn rejected"));
});

test.each([false, true])("real handoff cancellation before its deferred start never spawns (inline %s)", async inline => {
  const done = vi.fn();
  const onStarted = vi.fn();
  const panel = handoff(tui() as any, theme as any, "true", "/tmp", done, false, inline, onStarted);
  const shutdown = panel.shutdown();
  expect(panel.shutdown()).toBe(shutdown);
  await shutdown;
  await panel.start();
  panel.dispose();
  expect(spawnPty).not.toHaveBeenCalled();
  expect(onStarted).not.toHaveBeenCalled();
  expect(stopPty).not.toHaveBeenCalled();
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0][0]).toMatchObject({ exitCode: 130, cancelled: true });
  expect(done.mock.calls[0]).toHaveLength(inline ? 2 : 1);
});

test("errors are concise status-only results", () => {
  expect(failure("requires terminal")).toEqual({ output: "(interactive command: requires terminal)", exitCode: 1, cancelled: false, truncated: false });
});
