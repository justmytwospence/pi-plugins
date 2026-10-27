/**
 * Visual-mode selection geometry.
 *
 * A visual selection is an anchor (where `v`/`V` was pressed) plus the live
 * cursor. Both ends are inclusive, so the grapheme under the later end belongs
 * to the selection. Character-wise selections span an absolute text range;
 * line-wise selections span whole lines and ignore the columns.
 */

import { getLineGraphemes } from "./motions.js";
import type { Mode } from "./types.js";

export type VisualMode = "visual" | "visual-line";
export type VisualPosition = { line: number; col: number };

export function isVisualMode(mode: Mode): mode is VisualMode {
  return mode === "visual" || mode === "visual-line";
}

/** Negative when `a` precedes `b` in buffer order, positive when it follows. */
export function compareVisualPositions(
  a: VisualPosition,
  b: VisualPosition,
): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

/** The two endpoints in buffer order, regardless of which one is the anchor. */
export function orderVisualEndpoints(
  anchor: VisualPosition,
  cursor: VisualPosition,
): { start: VisualPosition; end: VisualPosition } {
  return compareVisualPositions(anchor, cursor) <= 0
    ? { start: anchor, end: cursor }
    : { start: cursor, end: anchor };
}

/** Whole lines covered by a line-wise selection. */
export function getVisualLineRange(
  anchor: VisualPosition,
  cursor: VisualPosition,
): { startLine: number; endLine: number } {
  return {
    startLine: Math.min(anchor.line, cursor.line),
    endLine: Math.max(anchor.line, cursor.line),
  };
}

/**
 * Exclusive end column for an inclusive selection end sitting at `col`.
 * Grapheme-aware, so a selection ending on an emoji takes the whole cluster.
 * A column at or past the end of the line yields the line length.
 */
export function getInclusiveEndColumn(line: string, col: number): number {
  if (col >= line.length) return line.length;
  const segment = getLineGraphemes(line).find((s) => col < s.end);
  return segment ? segment.end : line.length;
}

/** Keep a stale anchor inside the buffer after the text changed underneath it. */
export function clampVisualPosition(
  position: VisualPosition,
  lines: string[],
): VisualPosition {
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  const col = Math.max(0, Math.min(position.col, (lines[line] ?? "").length));
  return { line, col };
}

/** Selected columns of one logical line: `[from, to)` plus its newline cell. */
export type VisualLineSpan = { from: number; to: number; newline: boolean };

/**
 * Per-line selected spans, the way Vim paints them: char-wise selections cover
 * the newline cell of every line they continue past (and of the end line when
 * the cursor sits past its last character); line-wise ones cover whole lines
 * and paint one cell only for an empty line.
 */
export function getVisualLineSpans(
  mode: VisualMode,
  anchor: VisualPosition,
  cursor: VisualPosition,
  lines: string[],
): Map<number, VisualLineSpan> {
  const spans = new Map<number, VisualLineSpan>();
  if (mode === "visual-line") {
    const { startLine, endLine } = getVisualLineRange(anchor, cursor);
    for (let line = startLine; line <= endLine; line++) {
      const len = (lines[line] ?? "").length;
      spans.set(line, { from: 0, to: len, newline: len === 0 });
    }
    return spans;
  }
  const { start, end } = orderVisualEndpoints(anchor, cursor);
  for (let line = start.line; line <= end.line; line++) {
    const text = lines[line] ?? "";
    const from = line === start.line ? start.col : 0;
    if (line < end.line) {
      spans.set(line, { from, to: text.length, newline: true });
    } else {
      const to = getInclusiveEndColumn(text, end.col);
      spans.set(line, { from, to, newline: end.col >= text.length });
    }
  }
  return spans;
}

/** One row of the host editor's layout (`Editor.layoutText`). */
export type LayoutRow = { text: string; hasCursor: boolean; cursorPos?: number };
/** Where a layout row sits in the buffer (`Editor.buildVisualLineMap`). */
export type LayoutRowSpan = { logicalLine: number; startCol: number; length: number };

/**
 * Paint the selected part of each layout row with `paint`, keeping the
 * row's cursor index on the same grapheme. The newline cell becomes a painted
 * space on the line's last row when it fits within `maxWidth` (or the cursor
 * already occupies it). Rows the host laid out differently are left alone.
 */
export function paintVisualRows(
  rows: LayoutRow[],
  map: LayoutRowSpan[],
  spans: Map<number, VisualLineSpan>,
  paint: (s: string) => string,
  maxWidth: number,
  measure: (s: string) => number,
): LayoutRow[] {
  if (rows.length !== map.length) return rows;
  return rows.map((row, i) => {
    const at = map[i]!;
    const span = spans.get(at.logicalLine);
    if (!span) return row;
    const { text } = row;
    const clamp = (n: number) => Math.max(0, Math.min(n - at.startCol, text.length));
    const a = clamp(span.from);
    const b = clamp(span.to);
    const lastRow = map[i + 1]?.logicalLine !== at.logicalLine;
    const cursorAtEnd = row.hasCursor && row.cursorPos === text.length;
    const eol =
      span.newline &&
      lastRow &&
      b === text.length &&
      (cursorAtEnd || measure(text) + 1 <= maxWidth);
    if (a >= b && !eol) return row;
    const segment = text.slice(a, b) + (eol ? " " : "");
    const painted = paint(segment);
    const open = painted.indexOf(segment);
    if (open < 0) return row;
    const out: LayoutRow = { ...row, text: text.slice(0, a) + painted + text.slice(b) };
    const pos = row.cursorPos;
    if (row.hasCursor && pos !== undefined && pos >= a) {
      out.cursorPos = pos < b || (eol && pos === b) ? pos + open : pos + painted.length - (b - a);
    }
    return out;
  });
}
