import { beforeEach, expect, test, vi } from "vitest";
import { CURSOR_MARKER, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { omissionDivider, TerminalPanel } from "../src/panel.ts";
import { stopPty } from "../src/pty.ts";

vi.mock("../src/pty.ts", () => ({ spawnPty: vi.fn(), stopPty: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

async function setup(factory?: any, command = "interactive-example", autoClose = false, inline = false) {
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
  const panel = new TerminalPanel(tui as any, theme as any, command, "/tmp", done, spawn, autoClose, inline);
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

test("Kitty prefix controls scroll and resize without forwarding to the PTY", async () => {
  const h = await setup(undefined, undefined, false, true);
  h.data(Array.from({ length: 80 }, (_, i) => `row-${i}\r\n`).join(""));
  await vi.waitFor(() => expect((h.panel as any).screen.maxScrollback).toBeGreaterThan(0));
  const prefix = "\x1d";
  const control = (key: string) => { h.panel.handleInput(prefix); h.panel.handleInput(key); };
  const compact = h.panel.render(98).length;
  control("\x1b[102u");
  expect(h.panel.render(98).length).toBeGreaterThan(compact);
  control("\x1b[117u");
  expect((h.panel as any).offset).toBeGreaterThan(0);
  control("\x1b[100u");
  expect((h.panel as any).offset).toBe(0);
  control("\x1b[113u");
  expect(plain(h.panel.render(98))).toContain("Stop command?");
  expect(stopPty).not.toHaveBeenCalled();
  h.panel.handleInput("\x1b");
  expect(plain(h.panel.render(98))).not.toContain("Stop command?");
  expect(stopPty).not.toHaveBeenCalled();
  control("\x1b[113u");
  h.panel.handleInput("\r");
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(stopPty).toHaveBeenCalledExactlyOnceWith(h.pty);
  expect(h.done.mock.calls[0][0].cancelled).toBe(true);
  expect(h.pty.write).not.toHaveBeenCalled();
  await h.panel.shutdown();
});

test.each(["\x1b[103;2u", "G"])("shifted G returns from the top to live output: %j", async end => {
  const h = await setup(undefined, undefined, false, true);
  try {
    h.data(Array.from({ length: 80 }, (_, i) => `row-${i}\r\n`).join(""));
    await (h.panel as any).screen.flush();
    const max = (h.panel as any).screen.maxScrollback;
    expect(max).toBeGreaterThan(0);
    h.panel.handleInput("\x1d"); h.panel.handleInput("\x1b[103u");
    expect((h.panel as any).offset).toBe(max);
    h.panel.handleInput("\x1d"); h.panel.handleInput(end);
    expect((h.panel as any).offset).toBe(0);
    expect(h.pty.write).not.toHaveBeenCalled();
  } finally {
    await h.panel.shutdown();
  }
});

test("inline wheel scrolls both directions, clamps and consumes edges without focus or PTY input", async () => {
  const h = await setup(undefined, undefined, false, true);
  h.data(Array.from({ length: 80 }, (_, i) => `row-${i}\r\n`).join(""));
  await vi.waitFor(() => expect((h.panel as any).screen.maxScrollback).toBeGreaterThan(0));
  const wheel = (delta: number): TuiMouseEvent => ({ type: "wheel", button: "none", x: 2, y: 2, screenX: 2, screenY: 2, width: 80, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: delta });
  const max = (h.panel as any).screen.maxScrollback;
  const focus = h.panel.focused;
  expect(h.panel.handleMouse(wheel(-2.6))).toEqual({ handled: true, render: true });
  expect((h.panel as any).offset).toBe(3);
  expect(h.panel.handleMouse(wheel(1.4))).toEqual({ handled: true, render: true });
  expect((h.panel as any).offset).toBe(2);
  expect(h.panel.handleMouse(wheel(-Infinity))).toBeUndefined();
  expect(h.panel.handleMouse(wheel(NaN))).toBeUndefined();
  expect(h.panel.handleMouse(wheel(0))).toBeUndefined();
  expect(h.panel.handleMouse(wheel(-max * 2))).toEqual({ handled: true, render: true });
  expect((h.panel as any).offset).toBe(max);
  expect(h.panel.handleMouse(wheel(-1))).toEqual({ handled: true, render: true });
  expect(h.panel.handleMouse(wheel(max * 2))).toEqual({ handled: true, render: true });
  expect((h.panel as any).offset).toBe(0);
  expect(h.panel.handleMouse(wheel(1))).toEqual({ handled: true, render: true });
  expect(h.panel.handleMouse({ ...wheel(1), type: "click" })).toBeUndefined();
  expect(h.panel.focused).toBe(focus);
  expect(h.pty.write).not.toHaveBeenCalled();
  h.exit();
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(h.panel.handleMouse(wheel(-1))).toBeUndefined();
  const regular = await setup();
  expect(regular.panel.handleMouse(wheel(-1))).toBeUndefined();
  await regular.panel.shutdown();
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


test("inline uses half the terminal including four frame rows, ignoring footer height", async () => {
  const h = await setup(undefined, undefined, false, true);
  (h.tui as any).children = [{ render: () => Array(8).fill("footer") }];
  expect(h.panel.render(100)).toHaveLength(15);
  expect(h.pty.resize).toHaveBeenLastCalledWith(96, 11);
  h.panel.handleInput("typed");
  expect(h.pty.write).toHaveBeenCalledWith("typed");
  h.panel.handleInput("\x1d"); h.panel.handleInput("f");
  expect(h.panel.render(100)).toHaveLength(30);
  expect(h.pty.resize).toHaveBeenLastCalledWith(96, 26);
  h.panel.handleInput("\x1d"); h.panel.handleInput("f");
  expect(h.panel.render(100)).toHaveLength(15);
  for (const rows of [1, 2, 5, 8, 14]) {
    h.tui.terminal.rows = rows;
    for (const width of [0, 1, 2, 4, 12]) {
      const lines = h.panel.render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows / 2)));
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(h.pty.resize).toHaveBeenLastCalledWith(Math.max(1, width - 4), Math.max(1, Math.floor(rows / 2) - 4));
    }
  }
  await h.panel.shutdown();
});

test.each([
  { output: "", body: 0 },
  { output: "one line", body: 1 },
  { output: "one line\n", body: 1 },
  { output: "one line\n\n", body: 2 },
])("retained inline frame shrinks to occupied output for %j", async ({ output, body }) => {
  const h = await setup(undefined, undefined, false, true);
  const live = h.panel.render(98);
  expect(live).toHaveLength(15);
  if (output) h.data(output);
  h.exit(0);
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  const [result, snapshot] = h.done.mock.calls[0];
  expect(result.exitCode).toBe(0);
  const lines = snapshot.render(98);
  expect(lines).toHaveLength(4 + body);
  expect(plain(lines)).toContain("output retained for this session");
  if (body) expect(plain(lines)).toContain("one line");
  expect(h.tui.terminal.rows).toBe(30);
});

test.each([
  { rows: 6, output: "", body: 0 },
  { rows: 8, output: "one line", body: 1 },
])("retained frame at $rows terminal rows keeps its bottom border after resizing", async ({ rows, output, body }) => {
  const h = await setup(undefined, undefined, false, true);
  h.tui.terminal.rows = rows;
  const live = h.panel.render(98);
  expect(live.length).toBeLessThan(4 + body); // Live viewport remains height-limited.
  if (output) h.data(output);
  h.exit(0);
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  const snapshot = h.done.mock.calls[0][1];
  const frozen = snapshot.render(98);
  expect(frozen).toHaveLength(4 + body);
  expect(plain([frozen.at(-2)!])).toContain("Exited · output retained for this session");
  expect(plain([frozen.at(-1)!])).toMatch(/^└─+┘$/);
  if (body) expect(plain(frozen)).toContain(output);
  h.tui.terminal.rows = 30;
  expect(snapshot.render(98)).toEqual(frozen);
});

test.each([false, true])("inline exit auto-finishes with frozen head-tail before disposal (autoClose %s)", async autoClose => {
  const h = await setup(undefined, undefined, autoClose, true);
  h.panel.render(98);
  h.data(Array.from({ length: 40 }, (_, i) => `row${i}`).join("\r\n"));
  const screen = (h.panel as any).screen;
  await screen.flush();
  h.panel.handleInput("\x1d"); h.panel.handleInput("g");
  expect(plain(h.panel.render(98))).toContain("row0");
  const headTail = vi.spyOn(screen, "headTail");
  const dispose = vi.spyOn(screen, "dispose");
  h.exit(7);
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  expect(headTail.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
  const [result, snapshot] = h.done.mock.calls[0];
  expect(result.exitCode).toBe(7);
  expect(JSON.stringify(result)).not.toContain("row");
  expect(snapshot.handleInput).toBeUndefined();
  expect(snapshot.focused).toBeUndefined();
  const lines = snapshot.render(98);
  const text = plain(lines);
  expect(text).toContain("row0");
  expect(text).toContain("row39");
  expect(text).toContain("30 rows omitted");
  expect(text).toContain("──");
  expect(text).toContain("Exited · output retained for this session");
  expect(lines.join("")).not.toContain(CURSOR_MARKER);
  expect(lines).toHaveLength(15);
  for (const width of [0, 1, 4, 20, 200]) expect(snapshot.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
  snapshot.invalidate();
  h.panel.dispose();
  await h.panel.shutdown();
  expect(snapshot.render(98)).toEqual(lines);
  expect(h.done).toHaveBeenCalledOnce();
});

test.each([0, 1, 2, 3, 5, 9, 20, 42, 43, 116])("omission divider fills exactly %i columns with centered responsive text", width => {
  const divider = omissionDivider(30, width, text => `\x1b[2m${text}\x1b[0m`);
  expect(visibleWidth(divider)).toBe(width);
  if (width === 0) expect(divider).toBe("");
  else expect(divider).toContain("\x1b[2m");
  const raw = divider.replace(/\x1b\[[0-9;]*m/g, "");
  if (width >= " 30 rows omitted ".length) {
    expect(raw).toContain(" 30 rows omitted ");
    const [left, right] = raw.split(" 30 rows omitted ");
    expect(left).toMatch(/^─*$/);
    expect(right).toMatch(/^─*$/);
    expect(right.length - left.length).toBeGreaterThanOrEqual(0);
    expect(right.length - left.length).toBeLessThanOrEqual(1);
  } else if (width >= " 30 omitted ".length) expect(raw).toContain(" 30 omitted ");
  else if (width >= "…30…".length) expect(raw).toContain("…30…");
});

test("singular divider and real output lookalikes remain distinct after resizing", async () => {
  expect(omissionDivider(1, 40, s => s)).toContain("1 row omitted");
  const h = await setup(undefined, undefined, false, true);
  h.panel.render(120);
  h.data(["1 row omitted", ...Array.from({ length: 45 }, (_, i) => `row${i}`)].join("\r\n"));
  await (h.panel as any).screen.flush();
  h.exit(0);
  await vi.waitFor(() => expect(h.done).toHaveBeenCalledOnce());
  const snapshot = h.done.mock.calls[0][1];
  const wide = snapshot.render(120);
  expect(plain(wide)).toContain("1 row omitted"); // Child output is unchanged.
  expect(plain(wide)).toMatch(/─+\s+\d+ rows omitted\s+─+/);
  for (const width of [46, 20, 9, 5]) {
    const rows = snapshot.render(width);
    expect(rows).toHaveLength(wide.length);
    expect(rows.every((row: string) => visibleWidth(row) <= width)).toBe(true);
    if (width === 46) expect(plain(rows)).toMatch(/─+\s+\d+ rows omitted\s+─+/);
  }
});

test("inline spawn failure retains its readable final frame without dismissal", async () => {
  const h = await setup(async () => { throw new Error("native startup failed"); }, undefined, false, true);
  expect(h.done).toHaveBeenCalledOnce();
  const [result, snapshot] = h.done.mock.calls[0];
  expect(result.exitCode).toBe(1);
  expect(plain(snapshot.render(98))).toContain("native startup failed");
  expect(plain(snapshot.render(98))).toContain("Exited · output retained for this session");
  await h.panel.shutdown();
  expect(h.done).toHaveBeenCalledOnce();
});

test("inline confirmed stop, exit and shutdown racing finish exactly once", async () => {
  const h = await setup(undefined, undefined, false, true);
  h.data("last output");
  h.panel.handleInput("\x1d"); h.panel.handleInput("q");
  h.panel.handleInput("\r");
  h.exit(130);
  await h.panel.shutdown();
  expect(h.done).toHaveBeenCalledOnce();
  expect(stopPty).toHaveBeenCalledOnce();
  const [result, snapshot] = h.done.mock.calls[0];
  expect(result.cancelled).toBe(true);
  expect(plain(snapshot.render(98))).toContain("last output");
});

test.each([false, true])("shutdown before deferred start prevents spawn (inline %s)", async inline => {
  const done = vi.fn();
  const spawn = vi.fn();
  const onStarted = vi.fn();
  const panel = new TerminalPanel({ terminal: { columns: 80, rows: 24 }, requestRender: vi.fn() } as any,
    { fg: (_color: string, text: string) => text } as any, "true", "/tmp", done, spawn, false, inline, onStarted);
  queueMicrotask(() => { void panel.start(); });
  await panel.shutdown();
  await panel.start();
  expect(spawn).not.toHaveBeenCalled();
  expect(onStarted).not.toHaveBeenCalled();
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0]).toHaveLength(inline ? 2 : 1);
});

test.each([false, true])("onStarted observes the assigned PTY before immediate exit (shutdown pending %s)", async shutdownPending => {
  let resolve!: (pty: any) => void;
  const spawn = vi.fn(() => new Promise<any>(r => { resolve = r; }));
  const done = vi.fn();
  const order: string[] = [];
  const listenerDispose = vi.fn();
  const pty = {
    write: vi.fn(), resize: vi.fn(),
    onData: vi.fn(() => ({ dispose: listenerDispose })),
    onExit: vi.fn(callback => {
      order.push("exit");
      callback({ exitCode: 127, signal: 0 });
      return { dispose: listenerDispose };
    }),
  };
  const onStarted = vi.fn(() => {
    order.push("started");
    expect((panel as any).pty).toBe(pty);
    expect(pty.onData).not.toHaveBeenCalled();
    expect(pty.onExit).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
  const panel = new TerminalPanel({ terminal: { columns: 80, rows: 24 }, requestRender: vi.fn() } as any,
    { fg: (_color: string, text: string) => text } as any, "exit 127", "/tmp", done, spawn, false, true, onStarted);
  const start = panel.start();
  expect(panel.start()).toBe(start);
  expect(onStarted).not.toHaveBeenCalled();
  const shutdown = shutdownPending ? panel.shutdown() : undefined;
  resolve(pty);
  await start;
  await Promise.all([shutdown, panel.shutdown(), panel.shutdown()]);
  panel.dispose();
  await panel.start();
  expect(order).toEqual(["started", "exit"]);
  expect(spawn).toHaveBeenCalledOnce();
  expect(onStarted).toHaveBeenCalledOnce();
  expect(stopPty).toHaveBeenCalledExactlyOnceWith(pty);
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0][0]).toMatchObject({ exitCode: 127, cancelled: false });
  expect(listenerDispose).toHaveBeenCalledTimes(2);
});

test.each([false, true])("rejected PTY startup never calls onStarted (shutdown pending %s)", async shutdownPending => {
  let reject!: (error: Error) => void;
  const spawn = vi.fn(() => new Promise<any>((_resolve, r) => { reject = r; }));
  const onStarted = vi.fn();
  const done = vi.fn();
  const panel = new TerminalPanel({ terminal: { columns: 80, rows: 24 }, requestRender: vi.fn() } as any,
    { fg: (_color: string, text: string) => text } as any, "true", "/tmp", done, spawn, false, true, onStarted);
  const start = panel.start();
  const shutdown = shutdownPending ? panel.shutdown() : undefined;
  reject(new Error("spawn rejected"));
  await start;
  await Promise.all([shutdown, panel.shutdown()]);
  await panel.start();
  expect(spawn).toHaveBeenCalledOnce();
  expect(onStarted).not.toHaveBeenCalled();
  expect(stopPty).not.toHaveBeenCalled();
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0][0]).toMatchObject({ output: "(interactive command: spawn rejected)", exitCode: 1 });
});

test("inline shutdown during pending startup captures output and finishes once", async () => {
  let spawned!: (pty: any) => void;
  const pending = new Promise<any>(resolve => { spawned = resolve; });
  const done = vi.fn();
  const panel = new TerminalPanel({ terminal: { columns: 80, rows: 24 }, requestRender: vi.fn() } as any,
    { fg: (_color: string, text: string) => text } as any, "true", "/tmp", done, () => pending, false, true);
  void panel.start();
  const shutdown = panel.shutdown();
  spawned({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize: vi.fn() });
  await shutdown;
  expect(stopPty).toHaveBeenCalledOnce();
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0][1].render(80).join("")).not.toContain(CURSOR_MARKER);
});
