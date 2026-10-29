// A table output's first page as a text grid for the notebook view: as many columns as fit, numbers
// right-aligned, and a footer saying how much of the table that is.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TableData } from "../core/output.js";
import type { FrameTheme } from "../frame.ts";

const MAX_COLUMN = 24;
const GAP = "  ";
/** Room kept for `… +N cols` when not every column fits. */
const MORE = 12;

const pad = (text: string, width: number, right: boolean): string => {
  const cell = truncateToWidth(text, width, "…");
  const fill = " ".repeat(Math.max(0, width - visibleWidth(cell)));
  return right ? `${fill}${cell}` : `${cell}${fill}`;
};

export function tableLines(t: TableData, width: number, theme: FrameTheme, maxRows: number): string[] {
  const shown = t.rows.slice(0, Math.max(1, maxRows));
  const widths = t.columns.map((c, i) => Math.max(1, Math.min(MAX_COLUMN, Math.max(visibleWidth(c), ...shown.map((r) => visibleWidth(r[i] ?? ""))))));
  const fits = (n: number, reserve: number) => widths.slice(0, n).reduce((sum, w) => sum + w, 0) + GAP.length * Math.max(0, n - 1) + reserve <= width;
  let count = t.columns.length;
  if (!fits(count, 0)) {
    count = 0;
    while (count < t.columns.length && fits(count + 1, MORE)) count++;
    count = Math.max(1, count);
  }
  const hidden = t.columns.length - count;
  const cols = Array.from({ length: count }, (_, i) => i);
  const more = hidden ? theme.fg("dim", `${GAP}… +${hidden} col${hidden === 1 ? "" : "s"}`) : "";
  const header = `${theme.bold(cols.map((i) => pad(t.columns[i]!, widths[i]!, t.numeric[i] === true)).join(GAP))}${more}`;
  const rule = theme.fg("dim", cols.map((i) => "─".repeat(widths[i]!)).join(GAP));
  const rows = shown.map((r) => cols.map((i) => pad(r[i] ?? "", widths[i]!, t.numeric[i] === true)).join(GAP));
  const total = t.totalRows === "many" ? "many" : (t.totalRows ?? t.rows.length).toLocaleString("en-US");
  const columns = t.totalColumns ?? t.columns.length;
  const footer = theme.fg("dim", `${shown.length.toLocaleString("en-US")} of ${total} rows · ${columns.toLocaleString("en-US")} column${columns === 1 ? "" : "s"}`);
  return [header, rule, ...rows, footer].map((l) => truncateToWidth(l, Math.max(1, width)));
}
