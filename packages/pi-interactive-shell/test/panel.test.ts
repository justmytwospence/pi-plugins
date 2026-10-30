import { beforeEach, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TerminalPanel } from "../src/panel.ts";
import { stopPty } from "../src/pty.ts";

vi.mock("../src/pty.ts", () => ({ spawnPty: vi.fn(), stopPty: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

async function setup(factory?: any, command = "interactive-example", autoClose = false) {
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
  const panel = new TerminalPanel(tui as any, theme as any, command, "/tmp", done, spawn, autoClose);
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

for (const width of [46, 120]) test(`footer stays uncovered in both sizes at ${width} columns`, async () => {
  const h = await setup();
  let footerHeight = 4;
  (h.tui as any).children = [{ render: () => Array(footerHeight).fill("footer") }];
  h.tui.terminal.columns = width;
  for (const expanded of [false, true]) {
    if (expanded) { h.panel.handleInput("\x1d"); h.panel.handleInput("f"); }
    for (const height of [4, 8]) {
      footerHeight = height;
      const options = h.panel.overlayOptions();
      const lines = h.panel.render(width - (expanded ? 0 : 2));
      expect(options.margin.bottom).toBeGreaterThanOrEqual(height);
      expect(lines.length + options.margin.top + options.margin.bottom).toBeLessThanOrEqual(30);
      if (expanded) expect(h.pty.resize).toHaveBeenLastCalledWith(width - 4, 30 - height - 4);
    }
  }
  h.tui.terminal.rows = 6;
  expect(h.panel.render(width).length + h.panel.overlayOptions().margin.bottom).toBeLessThanOrEqual(6);
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

test.each([
  { code: 0, signal: 0, exitCode: 0, cancelled: false },
  { code: 7, signal: 0, exitCode: 7, cancelled: false },
  { code: 130, signal: 0, exitCode: 130, cancelled: true },
  { code: 0, signal: 2, exitCode: 130, cancelled: true },
])("auto-close returns status after flushing and stopping: %j", async ({ code, signal, exitCode, cancelled }) => {
  const h = await setup(undefined, undefined, true);
  const screen = (h.panel as any).screen;
  const flush = vi.spyOn(screen, "flush");
  const dispose = vi.spyOn(screen, "dispose");
  let stopped!: () => void;
  vi.mocked(stopPty).mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve; }));
  h.data("PRIVATE_FINAL_OUTPUT\r\n");
  h.exit(code, signal);
  await vi.waitFor(() => expect(stopPty).toHaveBeenCalledOnce());
  expect(flush).toHaveBeenCalled();
  expect(plain(h.panel.render(98))).toContain("PRIVATE_FINAL_OUTPUT");
  expect(h.done).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  stopped();
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(h.done.mock.calls[0][0]).toMatchObject({ exitCode, cancelled, truncated: false });
  expect(JSON.stringify(h.done.mock.calls)).not.toContain("PRIVATE_FINAL_OUTPUT");
  expect(h.dispose).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledOnce();
  await Promise.all([h.panel.shutdown(), h.panel.shutdown()]);
  h.panel.dispose();
  h.exit(code, signal);
  expect(stopPty).toHaveBeenCalledOnce();
  expect(h.done).toHaveBeenCalledOnce();
});

test("auto-close finishes spawn failure without a dismissal", async () => {
  const h = await setup(async () => { throw new Error("native startup failed"); }, undefined, true);
  expect(h.done).toHaveBeenCalledExactlyOnceWith({
    output: "(interactive command: native startup failed)", exitCode: 1, cancelled: false, truncated: false,
  });
  await h.panel.shutdown();
  expect(h.done).toHaveBeenCalledOnce();
});

test("auto-close shutdown during startup remains idempotent", async () => {
  let spawned!: (pty: any) => void;
  const pending = new Promise<any>(resolve => { spawned = resolve; });
  const done = vi.fn();
  const panel = new TerminalPanel({ terminal: { columns: 80, rows: 24 }, requestRender: vi.fn() } as any,
    { fg: (_color: string, text: string) => text } as any, "true", "/tmp", done, () => pending, true);
  void panel.start();
  const shutdown = panel.shutdown();
  expect(panel.shutdown()).toBe(shutdown);
  spawned({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize: vi.fn() });
  await shutdown;
  expect(stopPty).toHaveBeenCalledOnce();
  expect(done).toHaveBeenCalledExactlyOnceWith({ output: "(interactive command stopped)", exitCode: 130, cancelled: true, truncated: false });
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
