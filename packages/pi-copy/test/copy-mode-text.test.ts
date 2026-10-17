import { expect, test } from "vitest";
import { PRESETS, compile, extract, findAll, findHints, hintLabels, nextMatch, quote, wordAt, wordBackward, wordEnd, wordForward } from "../src/copy-mode/text.ts";

test("smartcase, \\c / \\C and literal fallback", () => {
  const lines = ["Error: foo", "error bar", "a.b (x"];
  expect(findAll(lines, compile("error")!).map((m) => m.row)).toEqual([0, 1]);
  expect(findAll(lines, compile("Error")!).map((m) => m.row)).toEqual([0]);
  expect(findAll(lines, compile("Error\\c")!).map((m) => m.row)).toEqual([0, 1]);
  expect(findAll(lines, compile("err\\C")!).map((m) => m.row)).toEqual([1]);
  const bad = compile("(x")!;
  expect(bad.literal).toBe(true);
  expect(findAll(lines, bad)).toEqual([{ row: 2, start: 4, end: 6 }]);
  expect(findAll(lines, compile("o+")!).length).toBe(3);
  expect(compile("")).toBeUndefined();
});

test("next match wraps both ways", () => {
  const m = [{ row: 1, start: 0, end: 1 }, { row: 5, start: 2, end: 3 }];
  expect(nextMatch(m, { row: 1, col: 0 }, true)).toEqual({ index: 1, wrapped: false });
  expect(nextMatch(m, { row: 5, col: 2 }, true)).toEqual({ index: 0, wrapped: true });
  expect(nextMatch(m, { row: 1, col: 0 }, false)).toEqual({ index: 1, wrapped: true });
  expect(nextMatch(m, { row: 9, col: 0 }, false)).toEqual({ index: 1, wrapped: false });
  expect(nextMatch([], { row: 0, col: 0 }, true)).toBeUndefined();
});

test("word motions cross lines like vim", () => {
  const lines = ["foo.bar baz", "  qux-1"];
  expect(wordForward(lines, { row: 0, col: 0 })).toEqual({ row: 0, col: 3 });
  expect(wordForward(lines, { row: 0, col: 0 }, true)).toEqual({ row: 0, col: 8 });
  expect(wordForward(lines, { row: 0, col: 8 })).toEqual({ row: 1, col: 2 });
  expect(wordBackward(lines, { row: 1, col: 2 })).toEqual({ row: 0, col: 8 });
  expect(wordBackward(lines, { row: 0, col: 6 })).toEqual({ row: 0, col: 4 });
  expect(wordEnd(lines, { row: 0, col: 0 })).toEqual({ row: 0, col: 2 });
  expect(wordEnd(lines, { row: 0, col: 0 }, true)).toEqual({ row: 0, col: 6 });
  expect(wordAt("  hello world", 0)).toBe("hello");
  expect(wordAt("  hello world", 9)).toBe("world");
});

test("presets find URLs, paths with lines, hashes and error lines", () => {
  const lines = [
    "see https://example.com/a?b=1. and src/index.ts:42 or ~/x/y",
    "commit 3f9a2c1d and 1234567 and deadbee",
    "Error: cannot open file",
  ];
  const text = (name: keyof typeof PRESETS) => findAll(lines, PRESETS[name].pattern, PRESETS[name].filter).map((m) => lines[m.row]!.slice(m.start, m.end));
  expect(text("url")).toEqual(["https://example.com/a?b=1"]);
  expect(text("path")).toEqual(expect.arrayContaining(["src/index.ts:42", "~/x/y"]));
  expect(text("hash")).toEqual(["3f9a2c1d"]);
  expect(text("error")).toEqual(["Error: cannot open file"]);
});

test("hints label unique things on screen", () => {
  const lines = ["open https://a.io/x then src/a.ts", "again https://a.io/x and \"quoted text\""];
  const hints = findHints(lines, 0, 2);
  expect(hints.map((h) => [h.label, h.text])).toEqual([["a", "https://a.io/x"], ["s", "src/a.ts"], ["d", "quoted text"]]);
  expect(hintLabels(26).every((l) => l.length === 1)).toBe(true);
  expect(hintLabels(30)[0]).toBe("aa");
});

test("extract and quote", () => {
  const lines = ["hello world  ", "second line"];
  expect(extract(lines, { row: 0, col: 6 }, { row: 1, col: 5 }, false)).toBe("world\nsecond");
  expect(extract(lines, { row: 1, col: 3 }, { row: 0, col: 0 }, true)).toBe("hello world\nsecond line");
  expect(extract([" a", "   b", ""], { row: 0, col: 0 }, { row: 2, col: 0 }, true)).toBe("a\n  b");
  expect(quote("a\n\nb")).toBe("> a\n>\n> b\n\n");
});
