// Layout for questions whose options carry a Markdown preview: beside the options in wide
// terminals, below them in narrow ones, in a bordered box clamped to a few rows.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Narrower than this, the preview goes below the options. */
export const SIDE_BY_SIDE_MIN_WIDTH = 100;
export const SIDE_ROWS = 15;
export const STACKED_ROWS = 10;
const MIN_LEFT = 30;
const GAP = 2;

export function sideBySide(width: number): boolean {
  return width >= SIDE_BY_SIDE_MIN_WIDTH;
}

/** The options column: as wide as its widest row, at least 30 columns, at most half the width. */
export function leftWidth(width: number, natural: number): number {
  return Math.max(MIN_LEFT, Math.min(Math.floor(width / 2), natural));
}

/** The preview box's width beside a left column of `left` columns. */
export function rightWidth(width: number, left: number): number {
  return width - left - GAP;
}

/** Two columns side by side; the left one padded to its width. */
export function columns(left: readonly string[], right: readonly string[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? "";
    out.push(`${l}${" ".repeat(Math.max(0, width - visibleWidth(l)) + GAP)}${right[i] ?? ""}`);
  }
  return out;
}

/**
 * `content` in a box `width` columns wide, at most `maxRows` content rows; the last row says how
 * many more there are when it is cut.
 */
export function box(
  content: readonly string[],
  width: number,
  maxRows: number,
  border: (s: string) => string,
  more: (hidden: number) => string,
): string[] {
  const inner = Math.max(1, width - 4);
  let rows = trimBlank(content);
  if (rows.length === 0) rows = [""];
  if (rows.length > maxRows) rows = [...rows.slice(0, maxRows - 1), more(rows.length - maxRows + 1)];
  const bar = "─".repeat(Math.max(0, width - 2));
  return [
    border(`┌${bar}┐`),
    ...rows.map((row) => `${border("│")} ${truncateToWidth(row, inner, "…", true)} ${border("│")}`),
    border(`└${bar}┘`),
  ];
}

function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  const blank = (s: string | undefined) => !s || !s.replace(/\x1b\[[0-9;]*m/gu, "").trim();
  while (start < end && blank(lines[start])) start++;
  while (end > start && blank(lines[end - 1])) end--;
  return lines.slice(start, end);
}
