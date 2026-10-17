import { expect, test } from "vitest";
import { stripVTControlCharacters as plain } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CopyModeView } from "../src/copy-mode/view.ts";
import { type Snapshot, findTranscript, renderBlocks, snapshotSession, snapshotTranscript } from "../src/copy-mode/snapshot.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function snap(lines: string[], blocks: Snapshot["blocks"] = [], scrollTop = 0, viewportHeight = 0): Snapshot {
  return { lines, plain: lines, blocks, scrollTop, viewportHeight, fallback: false };
}

function make(s: Snapshot, rows = 12, options = {}) {
  const copied: string[] = [];
  const inserted: string[] = [];
  let done: { row: number } | undefined | null = null;
  const view = new CopyModeView(s, theme, () => rows, {
    copy: async (t) => { copied.push(t); },
    insert: (t) => inserted.push(t),
    done: (r) => { done = r; },
    requestRender: () => undefined,
  }, options);
  const keys = (...ks: string[]) => { for (const k of ks) for (const ch of k.length > 1 && !k.startsWith("\x1b") && k !== "\r" ? [...k] : [k]) view.handleInput(ch); };
  return { view, keys, copied, inserted, done: () => done };
}

const transcript = Array.from({ length: 200 }, (_, i) => (i === 3 ? "NEEDLE early" : i === 150 ? "needle late https://x.io/a" : `filler ${i}`));

test("opens at Pi's scroll position with the cursor on the last visible line", () => {
  const { view } = make(snap(transcript, [], 100, 20));
  expect(view.top).toBe(100);
  expect(view.cursor.row).toBe(109);
});

test("incremental smartcase search, n/N with wrap, counter and history", async () => {
  const { view, keys } = make(snap(transcript, [], 100, 20));
  keys("/", "needle");
  expect(view.cursor.row).toBe(150);
  keys("\r");
  expect(view.render(80).at(-1)).toContain("[2/2]");
  keys("n");
  expect(view.cursor.row).toBe(3);
  expect(view.message).toContain("BOTTOM");
  keys("N");
  expect(view.cursor.row).toBe(150);
  keys("?", "NEEDLE", "\r");
  expect(view.cursor.row).toBe(3);
  // Up recalls the earlier search.
  keys("/", "\x1b[A");
  expect(view.render(80).at(-1)).toMatch(/^\/NEEDLE/);
  keys("\x1b");
  expect(view.mode).toBe("normal");
});

test("motions, counts, visual yank and yy", async () => {
  const { view, keys, copied } = make(snap(["alpha beta gamma", "second line", "third"]));
  keys("g", "g");
  expect(view.cursor).toEqual({ row: 0, col: 0 });
  keys("w", "w");
  expect(view.cursor).toEqual({ row: 0, col: 11 });
  keys("v", "e", "y");
  await Promise.resolve();
  expect(copied.at(-1)).toBe("gamma");
  keys("2", "y", "y");
  await Promise.resolve();
  expect(copied.at(-1)).toBe("alpha beta gamma\nsecond line");
  keys("G");
  expect(view.cursor.row).toBe(2);
  keys("V", "k", "y");
  await Promise.resolve();
  expect(copied.at(-1)).toBe("second line\nthird");
});

test("quote and insert into the editor, Enter jumps Pi to the spot, q closes", () => {
  const a = make(snap(["one", "two"]));
  a.keys("g", "g", "V", "j", ">");
  expect(a.inserted).toEqual(["> one\n> two\n\n"]);
  expect(a.done()).toBeUndefined();
  const b = make(snap(transcript, [], 100, 20));
  b.keys("\r");
  expect(b.done()).toEqual({ row: 103 });
  const c = make(snap(["x"]));
  c.keys("q");
  expect(c.done()).toBeUndefined();
});

test("presets, hints and block jumps", async () => {
  const lines = ["you: fix it", "ok", "$ npm test", "Error: boom", "fixed in src/a.ts:12 see https://x.io/a", "you: thanks"];
  const blocks: Snapshot["blocks"] = [
    { start: 0, end: 1, kind: "user", error: false },
    { start: 1, end: 2, kind: "assistant", error: false },
    { start: 2, end: 4, kind: "bash", error: true },
    { start: 4, end: 5, kind: "assistant", error: false },
    { start: 5, end: 6, kind: "user", error: false },
  ];
  const { view, keys, copied, inserted } = make(snap(lines, blocks));
  keys("g", "g", "]", "]");
  expect(view.cursor.row).toBe(5);
  keys("[", "e");
  expect(view.cursor.row).toBe(2);
  keys("g", "g", "]", "t");
  expect(view.cursor.row).toBe(2);
  keys("g", "u");
  expect(view.cursor).toEqual({ row: 4, col: 25 });
  keys("g", "f");
  expect(view.cursor.row).toBe(4);
  keys("f");
  expect(view.mode).toBe("hint");
  const screen = view.render(80).map((l) => plain(l)).join("\n");
  expect(screen).toContain("a");
  keys("a");
  await Promise.resolve();
  expect(copied.at(-1)).toBe("src/a.ts:12");
  keys("f", "S");
  expect(inserted.at(-1)).toBe("https://x.io/a");
});

test("renders within width at 46 and 120 columns", () => {
  const { view, keys } = make(snap(transcript.map((l) => `${l} ${"x".repeat(150)}`)), 20);
  keys("/", "filler", "\r", "v", "j");
  for (const w of [46, 120]) for (const line of view.render(w)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
});

test("snapshot renders the transcript document and records message blocks", () => {
  class Container { children: unknown[]; constructor(c: unknown[]) { this.children = c; } render(w: number): string[] { return this.children.flatMap((c: any) => c.render(w)); } }
  class UserMessageComponent { render() { return ["\x1b[1mhello\x1b[0m"]; } }
  class ToolExecutionComponent { result = { isError: true }; render() { return ["tool", "out"]; } }
  class Spacer { render() { return [""]; } }
  const doc = new Container([new Container([new Spacer()]), new Container([new UserMessageComponent(), new Spacer(), new ToolExecutionComponent()])]);
  const { lines, blocks } = renderBlocks(doc as never, 80);
  expect(lines).toEqual(["", "\x1b[1mhello\x1b[0m", "", "tool", "out"]);
  expect(blocks).toEqual([{ start: 1, end: 2, kind: "user", error: false }, { start: 3, end: 5, kind: "tool", error: true }]);
  let scrolled = -1;
  const view = { scrollTop: 2, viewportHeight: 3, child: doc, scrollTo: (r: number) => { scrolled = r; }, getContentWidth: (w: number) => w - 1, render: () => [] };
  const tui = { getPrimaryScrollView: () => view };
  expect(findTranscript(tui)).toBe(view);
  const s = snapshotTranscript(tui, 80)!;
  expect(s.plain[1]).toBe("hello");
  s.scrollTo!(4);
  expect(scrolled).toBe(4);
  expect(snapshotTranscript({}, 80)).toBeUndefined();
  // Found through the layout tree when getPrimaryScrollView is missing.
  expect(findTranscript({ layoutRoot: { entries: [{ component: view }] } })).toBe(view);
});

test("session fallback", () => {
  const s = snapshotSession([
    { type: "message", message: { role: "user", content: "hi there" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: "boom" } },
  ], 80);
  expect(s.fallback).toBe(true);
  expect(s.plain).toEqual(["> hi there", "", "hello", "", "[bash]", "boom", ""]);
  expect(s.blocks.map((b) => [b.kind, b.error])).toEqual([["user", false], ["assistant", false], ["tool", true]]);
});
