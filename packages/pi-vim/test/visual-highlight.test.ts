import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { ModalEditor } from "../src/index.js";
import { getVisualLineSpans, paintVisualRows } from "../src/engine/visual.js";
import { sendKeys, stubKeybindings, stubTheme, stubTui } from "./harness.js";

const paint = (s: string) => `[${s}]`;
const BG = (s: string) => `\x1b[44m${s}\x1b[49m`;

function editorWith(text: string): ModalEditor {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, { selectionColor: BG });
  editor.setText(text);
  sendKeys(editor, ["\x1b", "g", "g", "0"]);
  return editor;
}

/** Body rows with the fake cursor markers removed, borders dropped. */
const body = (editor: ModalEditor, width = 40): string[] =>
  editor
    .render(width)
    .slice(1, -1)
    .map((line) => line.replace(/\x1b_pi:\/?fc\x07|\x1b_pi:c\x07/g, "").trimEnd());

describe("getVisualLineSpans", () => {
  it("covers whole lines for V, painting a cell only on empty lines", () => {
    const spans = getVisualLineSpans("visual-line", { line: 0, col: 2 }, { line: 2, col: 0 }, ["abc", "", "de"]);
    assert.deepEqual([...spans], [
      [0, { from: 0, to: 3, newline: false }],
      [1, { from: 0, to: 0, newline: true }],
      [2, { from: 0, to: 2, newline: false }],
    ]);
  });

  it("is inclusive for v and covers the newlines it continues past", () => {
    const spans = getVisualLineSpans("visual", { line: 1, col: 1 }, { line: 0, col: 1 }, ["abc", "def"]);
    assert.deepEqual([...spans], [
      [0, { from: 1, to: 3, newline: true }],
      [1, { from: 0, to: 2, newline: false }],
    ]);
  });
});

describe("paintVisualRows", () => {
  const measure = (s: string) => s.length;

  it("keeps the cursor on the same character inside and after the selection", () => {
    const spans = new Map([[0, { from: 1, to: 3, newline: false }]]);
    const map = [{ logicalLine: 0, startCol: 0, length: 5 }];
    const inside = paintVisualRows([{ text: "abcde", hasCursor: true, cursorPos: 1 }], map, spans, paint, 20, measure);
    assert.deepEqual(inside, [{ text: "a[bc]de", hasCursor: true, cursorPos: 2 }]);
    assert.equal(inside[0]!.text[inside[0]!.cursorPos!], "b");
    const after = paintVisualRows([{ text: "abcde", hasCursor: true, cursorPos: 4 }], map, spans, paint, 20, measure);
    assert.equal(after[0]!.text[after[0]!.cursorPos!], "e");
  });

  it("splits a selection across wrapped rows and paints the newline cell on the last", () => {
    const spans = new Map([[0, { from: 2, to: 6, newline: true }]]);
    const map = [
      { logicalLine: 0, startCol: 0, length: 3 },
      { logicalLine: 0, startCol: 3, length: 3 },
    ];
    const rows = paintVisualRows(
      [{ text: "abc", hasCursor: false }, { text: "def", hasCursor: false }],
      map,
      spans,
      paint,
      10,
      measure,
    );
    assert.deepEqual(rows.map((r) => r.text), ["ab[c]", "[def ]"]);
  });

  it("skips the newline cell when it would not fit", () => {
    const spans = new Map([[0, { from: 0, to: 3, newline: true }]]);
    const rows = paintVisualRows([{ text: "abc", hasCursor: false }], [{ logicalLine: 0, startCol: 0, length: 3 }], spans, paint, 3, measure);
    assert.equal(rows[0]!.text, "[abc]");
  });

  it("leaves rows alone when the host layout does not match the line map", () => {
    const rows = [{ text: "abc", hasCursor: false }];
    assert.equal(paintVisualRows(rows, [], new Map(), paint, 10, measure), rows);
  });
});

describe("Visual selection rendering", () => {
  it("highlights whole lines in V-LINE mode", () => {
    const editor = editorWith("one\ntwo\nthree");
    sendKeys(editor, ["V", "j"]);
    assert.deepEqual(body(editor), [BG("one"), BG("two"), "three"]);
  });

  it("highlights the inclusive character range in VISUAL mode", () => {
    const editor = editorWith("hello world");
    sendKeys(editor, ["l", "v", "e"]);
    assert.deepEqual(body(editor), [`h${BG("ello")} world`]);
  });

  it("paints an empty line inside a V selection as one cell", () => {
    const editor = editorWith("a\n\nb");
    sendKeys(editor, ["V", "j", "j"]);
    assert.deepEqual(body(editor), [BG("a"), BG(" "), BG("b")]);
  });

  it("drops the highlight on leaving Visual mode and keeps row widths", () => {
    const editor = editorWith("one\ntwo");
    const before = editor.render(40);
    sendKeys(editor, ["V", "j"]);
    const during = editor.render(40);
    assert.deepEqual(during.map((l) => visibleWidth(l)), before.map((l) => visibleWidth(l)));
    assert.deepEqual(
      during.slice(1, -1).map((l) => stripTerminalSequences(l)),
      before.slice(1, -1).map((l) => stripTerminalSequences(l)),
    );
    sendKeys(editor, ["\x1b"]);
    assert.ok(!body(editor).some((l) => l.includes("\x1b[44m")));
  });
});
