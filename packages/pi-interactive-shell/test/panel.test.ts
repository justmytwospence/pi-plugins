import { beforeEach, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TerminalPanel } from "../src/panel.ts";
import { stopPty } from "../src/pty.ts";

vi.mock("../src/pty.ts", () => ({ spawnPty: vi.fn(), stopPty: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

async function setup(factory?: any, command = "interactive-example") {
  let data!: (data: string) => void;
  let exit!: (event: any) => void;
  const dispose = vi.fn();
  const pty = { pid: 12345, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: vi.fn((fn: any) => { data = fn; return { dispose }; }),
    onExit: vi.fn((fn: any) => { exit = fn; return { dispose }; }),
  };
  const tui = { terminal: { columns: 100, rows: 30 }, requestRender: vi.fn(), stop: vi.fn(), start: vi.fn() };
  const theme = { fg: (_color: string, text: string) => text };
  const done = vi.fn();
  const spawn = factory ?? vi.fn(async () => pty);
  const panel = new TerminalPanel(tui as any, theme as any, command, "/tmp", done, spawn);
  await panel.start();
  return { panel, pty, tui, done, spawn, dispose, data: (text: string) => data(text), exit: (code = 0, signal = 0) => exit({ exitCode: code, signal }) };
}

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

test("renders a bounded overlay and never suspends or clears Pi", async () => {
  const h = await setup();
  const lines = h.panel.render(98);
  expect(lines.length).toBeLessThan(h.tui.terminal.rows);
  expect(lines.every(line => visibleWidth(line) <= 98)).toBe(true);
  expect(lines[0]).toContain("Interactive terminal");
  expect(h.tui.stop).not.toHaveBeenCalled();
  expect(h.tui.start).not.toHaveBeenCalled();
  expect((h.panel as any)[Symbol.for("pi-plugins.input-context.v1")]()).toBe("terminal");
  await h.panel.shutdown();
});

test("a command's literal control bytes cannot escape the header", async () => {
  const h = await setup(undefined, "printf '\x1b[2J'\nnext-line");
  const header = h.panel.render(98)[1];
  expect(header).not.toContain("\x1b[2J");
  expect(header).toContain("\\x1b[2J");
  expect(header).toContain("\\x0a");
  await h.panel.shutdown();
});

test("program keys go to the PTY; prefix controls stay local", async () => {
  const h = await setup();
  for (const input of ["a", "\t", "\x1b", "\x03", "\x04"]) h.panel.handleInput(input);
  expect(h.pty.write.mock.calls.map(call => call[0])).toEqual(["a", "\t", "\x1b", "\x03", "\x04"]);
  h.panel.handleInput("\x1d"); h.panel.handleInput("\x1d");
  expect(h.pty.write).toHaveBeenLastCalledWith("\x1d");
  const compact = h.panel.render(98).length;
  h.panel.handleInput("\x1d"); h.panel.handleInput("f");
  expect(h.panel.render(100).length).toBeGreaterThan(compact);
  expect(h.pty.resize).toHaveBeenLastCalledWith(96, 26);
  await h.panel.shutdown();
});

test("native fd closure racing input or resize cannot crash the UI", async () => {
  const h = await setup();
  h.pty.write.mockImplementation(() => { throw new Error("closed fd"); });
  h.pty.resize.mockImplementation(() => { throw new Error("closed fd"); });
  expect(() => h.panel.handleInput("x")).not.toThrow();
  expect(() => h.panel.render(80)).not.toThrow();
  h.exit(0);
  h.panel.handleInput("\r");
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(h.done.mock.calls[0][0].exitCode).toBe(0);
});

test("retains final output until dismissal, without returning screen content", async () => {
  const h = await setup();
  h.data("PRIVATE_SCREEN_ONLY\r\n");
  await vi.waitFor(() => expect(plain(h.panel.render(98))).toContain("PRIVATE_SCREEN_ONLY"));
  h.exit(1);
  await vi.waitFor(() => expect(plain(h.panel.render(98))).toContain("exited 1"));
  expect(h.done).not.toHaveBeenCalled();
  h.panel.handleInput("\r");
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(h.done.mock.calls[0][0]).toEqual({ output: "(interactive command exited with code 1)", exitCode: 1, cancelled: false, truncated: false });
  expect(JSON.stringify(h.done.mock.calls)).not.toContain("PRIVATE_SCREEN_ONLY");
  expect(h.dispose).toHaveBeenCalledTimes(2);
});

test("stop needs explicit confirmation; Esc returns to the application", async () => {
  const h = await setup();
  h.panel.handleInput("\x1d"); h.panel.handleInput("q");
  expect(plain(h.panel.render(98))).toContain("Stop command?");
  h.panel.handleInput("\x1b");
  expect(stopPty).not.toHaveBeenCalled();
  h.panel.handleInput("\x1d"); h.panel.handleInput("q"); h.panel.handleInput("\r");
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(stopPty).toHaveBeenCalledOnce();
  expect(h.done.mock.calls[0][0].cancelled).toBe(true);
});

test("shutdown is idempotent and terminates pending processes without user input", async () => {
  const h = await setup();
  await Promise.all([h.panel.shutdown(), h.panel.shutdown()]);
  h.panel.dispose();
  expect(stopPty).toHaveBeenCalledOnce();
  expect(h.done).toHaveBeenCalledOnce();
});

test("startup failure stays readable, then closes with status only", async () => {
  const h = await setup(async () => { throw new Error("native startup failed"); });
  await vi.waitFor(() => expect(plain(h.panel.render(98))).toContain("native startup failed"));
  h.panel.handleInput("\x1b");
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(h.done.mock.calls[0][0].exitCode).toBe(1);
});

test("resize and prefix scrollback controls keep terminal output inside panel bounds", async () => {
  const h = await setup();
  h.data(Array.from({ length: 40 }, (_, i) => `line${i}\r\n`).join(""));
  await vi.waitFor(() => expect(plain(h.panel.render(98))).toContain("line39"));
  h.panel.handleInput("\x1d"); h.panel.handleInput("g");
  expect(plain(h.panel.render(98))).toContain("line0");
  h.panel.handleInput("\x1d"); h.panel.handleInput("G");
  expect(plain(h.panel.render(98))).toContain("line39");
  h.tui.terminal.columns = 24; h.tui.terminal.rows = 14;
  const lines = h.panel.render(22);
  expect(lines.every(line => visibleWidth(line) <= 22)).toBe(true);
  expect(h.pty.resize).toHaveBeenLastCalledWith(18, 2);
  await h.panel.shutdown();
});
