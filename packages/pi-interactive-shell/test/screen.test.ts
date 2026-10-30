import { CURSOR_MARKER, renderFakeCursor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import headless from "@xterm/headless";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalScreen } from "../src/screen.ts";

const screens: TerminalScreen[] = [];
afterEach(() => {
  for (const screen of screens.splice(0)) screen.dispose();
  vi.restoreAllMocks();
});

function create(cols = 12, rows = 3) {
  const onChange = vi.fn();
  const onReply = vi.fn();
  const screen = new TerminalScreen(cols, rows, onChange, onReply);
  screens.push(screen);
  return { screen, onChange, onReply };
}

function render(screen: TerminalScreen, offset = 0, focused = false): string[] {
  const lines = screen.render(offset, focused);
  expect(lines).toHaveLength(screen.terminal.rows);
  for (const line of lines) {
    expect(visibleWidth(line)).toBe(screen.terminal.cols);
    const text = line.replaceAll(CURSOR_MARKER, "")
      .replace(/\x1b_pi:\/?fc\x07/g, "")
      .replace(/\x1b\[[\d;]*m/g, "");
    // The only escapes in a projection are generated SGR and Pi cursor markers.
    expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  }
  return lines;
}

function plain(screen: TerminalScreen, offset = 0): string[] {
  return render(screen, offset).map(stripTerminalSequences);
}

function cursorPosition(lines: string[]): [number, number] | undefined {
  let position: [number, number] | undefined;
  for (const [row, line] of lines.entries()) {
    const index = line.indexOf(CURSOR_MARKER);
    if (index !== -1) {
      expect(position).toBeUndefined();
      position = [row, visibleWidth(line.slice(0, index))];
    }
  }
  return position;
}

test("starts with a fixed, blank viewport and reports only parsed changes", async () => {
  const { screen, onChange, onReply } = create(8, 3);
  expect(screen.terminal).toBeInstanceOf(headless.Terminal);
  expect(screen.terminal.options.allowProposedApi).toBe(true);
  expect(screen.terminal.options.logLevel).toBe("off");
  expect(plain(screen)).toEqual(["        ", "        ", "        "]);
  expect(screen.maxScrollback).toBe(0);
  screen.write("abc");
  expect(onChange).not.toHaveBeenCalled();
  await screen.flush();
  expect(onChange).toHaveBeenCalled();
  expect(plain(screen)).toEqual(["abc     ", "        ", "        "]);
  expect(onReply).not.toHaveBeenCalled();
});

test("emulates carriage return, erase, cursor addressing, tabs, and wrapping", async () => {
  const { screen } = create(10, 3);
  screen.write("old text\rnew\x1b[K\r\n12345\x1b[2DXY\t!");
  await screen.flush();
  expect(plain(screen)).toEqual(["new       ", "123XY   ! ", "          "]);
  screen.write("AB");
  await screen.flush();
  expect(plain(screen)).toEqual(["new       ", "123XY   !A", "B         "]);
  screen.write("\x1b[2J\x1b[Hreset");
  await screen.flush();
  expect(plain(screen)).toEqual(["reset     ", "          ", "          "]);
});

test.each([
  ["31;44", "\x1b[31;44m", [1, 4], undefined],
  ["91;104", "\x1b[91;104m", [9, 12], undefined],
  ["38;5;202;48;5;17", "\x1b[38;5;202;48;5;17m", [202, 17], undefined],
  ["38;2;1;128;255;48;2;254;127;0", "\x1b[38;2;1;128;255;48;2;254;127;0m", undefined, [0x0180ff, 0xfe7f00]],
] as const)("regenerates foreground/background colors (%s)", async (sgr, regenerated, palette, rgb) => {
  const { screen } = create(5, 2);
  screen.write(`\x1b[${sgr}mA\x1b[0mB\r\nC`);
  await screen.flush();
  const lines = render(screen);
  expect(lines[0]).toContain(`${regenerated}A\x1b[0mB`);
  expect(lines[1]).not.toContain(regenerated);
  const replay = new headless.Terminal({ cols: 5, rows: 2, allowProposedApi: true, logLevel: "off" });
  try {
    await new Promise<void>((resolve) => replay.write(lines[0], resolve));
    const a = replay.buffer.active.getLine(0)!.getCell(0)!;
    const b = replay.buffer.active.getLine(0)!.getCell(1)!;
    expect([a.getFgColor(), a.getBgColor()]).toEqual(palette ?? rgb);
    expect(a.isFgPalette()).toBe(!!palette);
    expect(a.isBgPalette()).toBe(!!palette);
    expect(a.isFgRGB()).toBe(!!rgb);
    expect(a.isBgRGB()).toBe(!!rgb);
    expect(b.isAttributeDefault()).toBe(true);
  } finally {
    replay.dispose();
  }
});

test("preserves every public style attribute and resets styles between runs/rows", async () => {
  const { screen } = create(5, 2);
  screen.write("\x1b[1;2;3;4;5;7;8;9;53mA\x1b[0mB\r\nC");
  await screen.flush();
  const lines = render(screen);
  expect(lines[0]).toContain("\x1b[1;2;3;4;5;7;8;9;53mA\x1b[0mB");
  expect(lines[1]).toBe("\x1b[0mC    \x1b[0m");
  expect(lines.every((line) => line.startsWith("\x1b[0m") && line.endsWith("\x1b[0m"))).toBe(true);
});

test("preserves styled blank cells, including erase-to-end background", async () => {
  const { screen } = create(5, 2);
  screen.write("A\x1b[48;2;2;3;4m\x1b[K");
  await screen.flush();
  expect(render(screen)[0]).toContain("A\x1b[0m\x1b[48;2;2;3;4m    \x1b[0m");
  expect(plain(screen)[0]).toBe("A    ");
});

test("shows a Pi/fake cursor only when focused at the live viewport", async () => {
  const { screen } = create(8, 2);
  screen.write("abc");
  await screen.flush();
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 3]);
  expect(render(screen, 0, true)[0]).toContain(CURSOR_MARKER + renderFakeCursor(" "));
  expect(cursorPosition(render(screen))).toBeUndefined();
  screen.write("\r\nrow2\r\nrow3");
  await screen.flush();
  expect(cursorPosition(render(screen, 0, true))).toEqual([1, 4]);
  expect(cursorPosition(render(screen, 1, true))).toBeUndefined();
});

test("observes cursor hiding without swallowing other DECSET/DECRST modes", async () => {
  const { screen } = create();
  screen.write("\x1b[?25;2004l");
  await screen.flush();
  expect(cursorPosition(render(screen, 0, true))).toBeUndefined();
  expect(screen.terminal.modes.bracketedPasteMode).toBe(false);
  screen.write("\x1b[?25;2004h");
  await screen.flush();
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 0]);
  expect(screen.terminal.modes.bracketedPasteMode).toBe(true);
  screen.write("\x1b[?25l\x1bc");
  await screen.flush();
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 0]);
});

test("places the cursor on the last visible cell during pending wrap", async () => {
  const { screen } = create(3, 2);
  screen.write("abc");
  await screen.flush();
  expect(screen.terminal.buffer.active.cursorX).toBe(3);
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 2]);
  expect(render(screen, 0, true)[0]).toContain(CURSOR_MARKER + renderFakeCursor("c"));
});

test("handles CJK, combining marks, emoji, and wide-cell continuations", async () => {
  const { screen } = create(10, 2);
  screen.write("A界e\u0301😀Z");
  await screen.flush();
  expect(plain(screen)).toEqual(["A界e\u0301😀Z   ", "          "]);
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 7]);
  screen.write("\x1b[3G"); // Inside 界's second cell: mark the complete glyph.
  await screen.flush();
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 1]);
  expect(render(screen, 0, true)[0]).toContain(CURSOR_MARKER + renderFakeCursor("界"));
});

test.each(["👩‍💻", "👨‍👩‍👧‍👦", "👍🏽", "🇺🇸", "1️⃣", "✈️"])("keeps streamed grapheme %s in one wide cell", async (grapheme) => {
  const { screen } = create(6, 2);
  for (const codepoint of grapheme) {
    screen.write(codepoint);
    await screen.flush();
  }
  expect(plain(screen)[0]).toBe(`${grapheme}    `);
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 2]);
  expect(screen.terminal.buffer.active.getLine(0)!.getCell(0)!.getChars()).toBe(grapheme);
});

test("handles split surrogate pairs, split combining text, and long combining clusters", async () => {
  const { screen } = create(8, 2);
  screen.write("e");
  screen.write("\u0301\ud83d");
  screen.write("\ude00");
  screen.write("x" + "\u0301".repeat(160));
  await screen.flush();
  expect(plain(screen)[0]).toBe("e\u0301😀x" + "\u0301".repeat(160) + "    ");
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 4]);
});

test("wraps a wide glyph instead of emitting half of it at the right margin", async () => {
  const { screen } = create(4, 2);
  screen.write("abc界");
  await screen.flush();
  expect(plain(screen)).toEqual(["abc ", "界  "]);
  expect(cursorPosition(render(screen, 0, true))).toEqual([1, 2]);
});

test("projects clamped scrollback without changing xterm's active viewport", async () => {
  const { screen } = create(6, 3);
  screen.write(["L0", "L1", "L2", "L3", "L4"].join("\r\n"));
  await screen.flush();
  expect(screen.maxScrollback).toBe(2);
  const viewport = screen.terminal.buffer.active.viewportY;
  expect(plain(screen)).toEqual(["L2    ", "L3    ", "L4    "]);
  expect(plain(screen, 1)).toEqual(["L1    ", "L2    ", "L3    "]);
  expect(plain(screen, 999)).toEqual(["L0    ", "L1    ", "L2    "]);
  expect(plain(screen, -1)).toEqual(plain(screen));
  expect(plain(screen, Number.NaN)).toEqual(plain(screen));
  expect(plain(screen, Number.POSITIVE_INFINITY)).toEqual(plain(screen, 2));
  expect(plain(screen, 1.9)).toEqual(plain(screen, 1));
  expect(screen.terminal.buffer.active.viewportY).toBe(viewport);
});

test("bounds history at 1000 lines and honors erase-scrollback", async () => {
  const { screen } = create(10, 3);
  screen.write(Array.from({ length: 1105 }, (_, index) => `row${index}`).join("\r\n"));
  await screen.flush();
  expect(screen.maxScrollback).toBe(1000);
  expect(screen.terminal.buffer.active.length).toBe(1003);
  expect(plain(screen, 1000)[0].trimEnd()).toBe("row102");
  expect(plain(screen).map((line) => line.trimEnd())).toEqual(["row1102", "row1103", "row1104"]);
  screen.write("\x1b[3J");
  await screen.flush();
  expect(screen.maxScrollback).toBe(0);
});

test("uses the alternate buffer without normal history and restores the normal screen", async () => {
  const { screen } = create(8, 2);
  screen.write("first\r\nsecond\r\nthird");
  await screen.flush();
  const normal = plain(screen);
  expect(screen.maxScrollback).toBe(1);
  screen.write("\x1b[?1049h\x1b[2J\x1b[HALT\r\nA\r\nB");
  await screen.flush();
  expect(screen.terminal.buffer.active.type).toBe("alternate");
  expect(screen.maxScrollback).toBe(0);
  expect(plain(screen, 100)).toEqual(["A       ", "B       "]);
  expect(cursorPosition(render(screen, 0, true))).toEqual([1, 1]);
  screen.write("\x1b[?1049l");
  await screen.flush();
  expect(screen.terminal.buffer.active.type).toBe("normal");
  expect(plain(screen)).toEqual(normal);
  expect(screen.maxScrollback).toBe(1);
});

test("sends emulator replies exclusively through onReply", async () => {
  const { screen, onReply } = create();
  screen.write("abc\x1b[6n\x1b[5n\x1b[c");
  await screen.flush();
  expect(onReply.mock.calls.map(([data]) => data)).toEqual(["\x1b[1;4R", "\x1b[0n", "\x1b[?1;2c"]);
  expect(plain(screen)[0]).toBe("abc         ");
});

test("never forwards OSC titles, clipboard, links, images, DCS or forged Pi markers to the host", async () => {
  const { screen, onReply } = create();
  const host = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  screen.write("A\x1b]0;PRIVATE-TITLE\x07\x1b]2;PRIVATE-TITLE\x1b\\");
  screen.write("\x1b]52;c;UFJJVkFURS1DTElQQk9BUkQ=\x07\x1b]9;PRIVATE-NOTIFICATION\x07");
  screen.write("\x1b]1337;File=inline=1:PRIVATE-IMAGE\x07\x1b]8;;https://private.example\x07B\x1b]8;;\x07");
  screen.write("\x1bPqPRIVATE-DCS\x1b\\\x1b^PRIVATE-PM\x1b\\\x1b_PRIVATE-APC\x1b\\");
  screen.write(CURSOR_MARKER + "\x1b\\" + renderFakeCursor("FORGED") + "\x1b\\C");
  await screen.flush();
  const lines = render(screen);
  expect(lines.map(stripTerminalSequences)).toEqual(["ABC         ", "            ", "            "]);
  expect(lines.join("")).not.toMatch(/PRIVATE|FORGED|https|TITLE|52;/);
  expect(cursorPosition(lines)).toBeUndefined();
  expect(onReply).not.toHaveBeenCalled();
  expect(host).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test("parses split control sequences without leaking incomplete payloads", async () => {
  const { screen } = create(8, 2);
  screen.write("A\x1b]52;c;PRIVATE");
  await screen.flush();
  expect(plain(screen)[0]).toBe("A       ");
  screen.write("-DATA\x07\x1b[38;2;");
  await screen.flush();
  expect(plain(screen)[0]).toBe("A       ");
  screen.write("1;2;3mB");
  await screen.flush();
  expect(render(screen)[0]).toContain("\x1b[38;2;1;2;3mB");
  expect(plain(screen)[0]).toBe("AB      ");
});

test("resizes the emulator and viewport, preserving contents, styles, and cursor", async () => {
  const { screen, onChange } = create(8, 2);
  screen.write("\x1b[31m界A\x1b[0m");
  await screen.flush();
  onChange.mockClear();
  screen.resize(6, 4);
  expect(onChange).toHaveBeenCalled();
  expect(plain(screen)).toEqual(["界A   ", "      ", "      ", "      "]);
  expect(render(screen)[0]).toContain("\x1b[31m界A");
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 3]);
  screen.resize(4, 2);
  expect(plain(screen)).toEqual(["界A ", "    "]);
  screen.write("B");
  await screen.flush();
  expect(plain(screen)[0]).toBe("界AB");
  expect(cursorPosition(render(screen, 0, true))).toEqual([0, 3]);
  screen.write("\x1b[?1049h\x1b[HALT");
  await screen.flush();
  screen.resize(7, 3);
  expect(plain(screen)).toEqual(["ALT    ", "       ", "       "]);
  screen.write("\x1b[?1049l");
  await screen.flush();
  expect(plain(screen)[0]).toBe("界AB   ");
});

test("disposes the emulator/listeners once and settles pending flushes", async () => {
  const { screen, onChange, onReply } = create(8, 2);
  const dispose = vi.spyOn(screen.terminal, "dispose");
  screen.write("queued\x1b[6n");
  const first = screen.flush();
  const second = screen.flush();
  screen.dispose();
  screen.dispose();
  await Promise.all([first, second, screen.flush()]);
  screen.write("ignored");
  screen.resize(20, 20);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(dispose).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
  expect(onReply).not.toHaveBeenCalled();
  expect(screen.maxScrollback).toBe(0);
  expect(plain(screen)).toEqual(["        ", "        "]);
});


test.each([0, 1, 2, 3, 4, 5, 6])("head-tail uses the last occupied rows without scrollback at height %i", async height => {
  const { screen } = create(8, 4);
  screen.write("first\r\nsecond");
  await screen.flush();
  const result = screen.headTail(height);
  expect(result.head).toEqual([]);
  expect(result.omitted).toBe(0);
  expect(result.tail).toEqual(screen.render(0, false).slice(Math.max(0, 2 - height), 2));
  expect(result.tail.join("")).not.toContain(CURSOR_MARKER);
});

test.each([3, 4, 5, 6, 7, 8])("head-tail reserves one omission row and favors the tail at height %i", async height => {
  const { screen } = create(8, 6);
  screen.write(Array.from({ length: 12 }, (_, i) => `row${i}`).join("\r\n"));
  await screen.flush();
  const result = screen.headTail(height);
  const head = Math.floor((height - 1) / 2);
  const tail = height - 1 - head;
  expect(result.head.map(line => stripTerminalSequences(line).trimEnd())).toEqual(Array.from({ length: head }, (_, i) => `row${i}`));
  expect(result.tail.map(line => stripTerminalSequences(line).trimEnd())).toEqual(Array.from({ length: tail }, (_, i) => `row${12 - tail + i}`));
  expect(result.omitted).toBe(12 - head - tail);
  expect(result.head.length + result.tail.length + 1).toBe(height);
});

test("head-tail includes all rows when exactly fitting or larger, without omission", async () => {
  const { screen } = create(8, 3);
  screen.write("a\r\n\r\nc\r\nd\r\ne");
  await screen.flush();
  for (const height of [5, 6]) {
    const result = screen.headTail(height);
    expect(result.omitted).toBe(0);
    expect(result.head).toEqual([]);
    expect(result.tail.map(line => stripTerminalSequences(line).trimEnd())).toEqual(["a", "", "c", "d", "e"]);
  }
  expect(screen.headTail(3).omitted).toBe(3); // Blank buffer rows count too.
  for (const height of [0, 1, 2]) {
    expect(screen.headTail(height).tail.map(line => stripTerminalSequences(line).trimEnd()))
      .toEqual(["a", "", "c", "d", "e"].slice(5 - height));
  }
});

test.each([
  { output: "", rows: [] },
  { output: "hello", rows: ["hello"] },
  { output: "hello\n", rows: ["hello"] },
  { output: "hello\n\n", rows: ["hello", ""] },
  { output: "\n", rows: [""] },
  { output: "a\n\nb", rows: ["a", "", " b"] },
  { output: " ", rows: [""] },
  { output: "a\r\nb\x1b[1;1H", rows: ["a", "b"] },
  { output: "hello\x1b[2J\x1b[H", rows: [] },
])("head-tail excludes unprinted padding while retaining meaningful rows: %j", async ({ output, rows }) => {
  const { screen } = create(12, 8);
  screen.write(output);
  await screen.flush();
  expect(plain(screen)).toHaveLength(8); // Live PTY dimensions do not shrink.
  const snapshot = screen.headTail(8);
  expect(snapshot.head).toEqual([]);
  expect(snapshot.omitted).toBe(0);
  expect(snapshot.tail.map(line => stripTerminalSequences(line).trimEnd())).toEqual(rows);
  expect(snapshot.tail).toHaveLength(rows.length);
});

test("head-tail retains explicitly styled blank cells even with cursor back at origin", async () => {
  const { screen } = create(12, 8);
  screen.write("\x1b[41m \x1b[0m\x1b[H");
  await screen.flush();
  const snapshot = screen.headTail(8);
  expect(snapshot.tail).toHaveLength(1);
  expect(snapshot.tail[0]).toContain("\x1b[41m");
});

test("head-tail excludes the pending blank cursor row from long-history omission counts", async () => {
  const { screen } = create(12, 4);
  screen.write(Array.from({ length: 12 }, (_, i) => `row${i}`).join("\r\n") + "\r\n");
  await screen.flush();
  const snapshot = screen.headTail(5);
  expect(snapshot.head.map(line => stripTerminalSequences(line).trimEnd())).toEqual(["row0", "row1"]);
  expect(snapshot.tail.map(line => stripTerminalSequences(line).trimEnd())).toEqual(["row10", "row11"]);
  expect(snapshot.omitted).toBe(8);
});

test("head-tail preserves styles and sanitized cells, with no live cursor or raw escapes", async () => {
  const { screen } = create(8, 3);
  screen.write("\x1b[31mred\x1b[0m\x1b]52;c;PRIVATE\x07\r\n1\r\n2\r\n3\r\n\x1b[32mgreen");
  await screen.flush();
  const { head, tail, omitted } = screen.headTail(3);
  expect(omitted).toBe(3);
  expect(head[0]).toContain("\x1b[31mred");
  expect(tail[0]).toContain("\x1b[32mgreen");
  expect([...head, ...tail].join("")).not.toContain(CURSOR_MARKER);
  expect([...head, ...tail].join("")).not.toContain("PRIVATE");
  expect([...head, ...tail].every(line => visibleWidth(line) === 8)).toBe(true);
});

test("head-tail uses the bounded buffer's earliest rows after truncation and the active alternate screen", async () => {
  const { screen } = create(10, 3);
  screen.write(Array.from({ length: 1105 }, (_, i) => `row${i}`).join("\r\n"));
  await screen.flush();
  const result = screen.headTail(4);
  expect(result.head.map(line => stripTerminalSequences(line).trimEnd())).toEqual(["row102"]);
  expect(result.tail.map(line => stripTerminalSequences(line).trimEnd())).toEqual(["row1103", "row1104"]);
  expect(result.omitted).toBe(1000);
  screen.write("\x1b[?1049hALT");
  await screen.flush();
  expect(screen.headTail(3)).toEqual({ head: [], tail: screen.render(0, false), omitted: 0 });
});
