// A marimo table as a text grid for the notebook view: frozen, scrolled and hidden columns, data
// types, column summaries with sparklines, sort marks, selection marks, cell styles, justification,
// a cursor, and a footer that says which rows these are. It is drawn from a `TableData` (the page
// marimo sent, or the one the table's `search` function returned) and a `TableRender` (the view's
// cursor, sort and selection). Row and column cards show what a grid cell cannot.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TableData } from "../core/output.js";
import type { ColumnSummaries } from "../core/table-rpc.js";
import type { PaneTheme } from "./outline.js";

export type Summaries = ColumnSummaries;

export interface TableRender {
  focused: boolean;
  cursorRow?: number;
  cursorCol?: number;
  colOffset: number;
  selected: ReadonlySet<string>;
  /** `${rowId}\0${column}` */
  selectedCells?: ReadonlySet<string>;
  sort: Array<{ by: string; descending: boolean }>;
  summaries?: Summaries;
  status?: string;
  rowIdOf(i: number): string;
  /** Absolute index of the first row shown. */
  firstRow: number;
  totalRows?: number | "many";
}

const MAX_COLUMN = 28;
const MAX_WRAPPED = 40;
const WRAP_LINES = 3;
const SEP = " │ ";
const FROZEN_SEP = " ┃ ";
const SELECT_WIDTH = 2;
const BLOCKS = "▁▂▃▄▅▆▇█";

const SGR = (on: string, off: string) => (text: string): string => `\x1b[${on}m${text}\x1b[${off}m`;
const inverse = SGR("7", "27");
const italic = SGR("3", "23");
const underline = SGR("4", "24");
const boldSgr = SGR("1", "22");

const fieldKind = (t: TableData, column: string): string => t.fieldTypes?.[column]?.kind ?? "";
const isNumber = (t: TableData, column: string): boolean => {
  const kind = fieldKind(t, column);
  if (kind) return kind === "integer" || kind === "number";
  return t.numeric[t.columns.indexOf(column)] === true;
};
const isTemporal = (kind: string): boolean => kind === "date" || kind === "datetime" || kind === "time";

/** The columns in the order they are drawn and moved through: frozen left, the scrolling ones, frozen right. */
export function columnGroups(t: TableData): { left: string[]; middle: string[]; right: string[] } {
  const left = (t.freezeLeft ?? []).filter((c) => t.columns.includes(c));
  const right = (t.freezeRight ?? []).filter((c) => t.columns.includes(c) && !left.includes(c));
  const middle = t.columns.filter((c) => !left.includes(c) && !right.includes(c));
  return { left, middle, right };
}

export function orderedColumns(t: TableData): string[] {
  const g = columnGroups(t);
  return [...g.left, ...g.middle, ...g.right];
}

/** One value as text, with how it should be styled. */
function format(value: unknown, kind: string): { text: string; style?: "null" | "yes" | "no" } {
  if (value === null || value === undefined) return { text: "null", style: "null" };
  if (typeof value === "boolean") return { text: value ? "✓" : "✗", style: value ? "yes" : "no" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { text: String(value) };
    const whole = kind === "integer" || (kind !== "number" && Number.isInteger(value));
    return { text: whole ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 4 }) };
  }
  if (typeof value === "string") return { text: value.replace(/\s+/gu, " ") };
  return { text: JSON.stringify(value) ?? "" };
}

/** A column's value on row `i`: from the parsed records, else the text rows. */
function valueAt(t: TableData, i: number, column: string): { text: string; style?: "null" | "yes" | "no" } {
  if (t.records) return format(t.records[i]?.[column], fieldKind(t, column));
  return { text: t.rows[i]?.[t.columns.indexOf(column)] ?? "" };
}

const rowCount = (t: TableData): number => (t.records?.length ? t.records.length : t.rows.length);

function align(text: string, width: number, how: "left" | "center" | "right"): string {
  const cell = truncateToWidth(text, width, "…");
  const fill = Math.max(0, width - visibleWidth(cell));
  if (how === "right") return `${" ".repeat(fill)}${cell}`;
  if (how === "center") return `${" ".repeat(Math.floor(fill / 2))}${cell}${" ".repeat(fill - Math.floor(fill / 2))}`;
  return `${cell}${" ".repeat(fill)}`;
}

const justify = (t: TableData, column: string): "left" | "center" | "right" => t.justify?.[column] ?? (isNumber(t, column) ? "right" : "left");

const sortMark = (sort: TableRender["sort"], column: string): string => {
  const i = sort.findIndex((s) => s.by === column);
  if (i < 0) return "";
  return ` ${sort[i]!.descending ? "↓" : "↑"}${sort.length > 1 ? String(i + 1) : ""}`;
};

function capOf(t: TableData, column: string): number {
  const px = t.widths?.[column];
  if (px) return Math.max(3, Math.round(px / 8));
  return t.wrapped?.includes(column) ? MAX_WRAPPED : MAX_COLUMN;
}

function widthOf(t: TableData, column: string, shown: number, sort: TableRender["sort"]): number {
  let w = visibleWidth(column) + visibleWidth(sortMark(sort, column));
  const dtype = t.fieldTypes?.[column]?.dtype;
  if (dtype && t.show?.types !== false) w = Math.max(w, visibleWidth(dtype));
  for (let i = 0; i < shown; i++) w = Math.max(w, visibleWidth(valueAt(t, i, column).text));
  return Math.max(1, Math.min(capOf(t, column), w));
}

/** Which columns fit at this width: the frozen ones, and the scrolled window starting at `colOffset`. */
export function visibleColumns(t: TableData, width: number, colOffset: number, sort: TableRender["sort"] = [], shown = rowCount(t)): { left: string[]; middle: string[]; right: string[]; before: number; after: number } {
  const g = columnGroups(t);
  const left = [...(t.rowHeaders ?? []), ...g.left];
  const w = (c: string) => widthOf(t, c, shown, sort);
  const sepWidth = 3;
  const fixed = (cols: string[]) => cols.reduce((sum, c) => sum + w(c) + sepWidth, 0);
  const before = Math.max(0, Math.min(colOffset, g.middle.length - 1));
  const rest = g.middle.slice(before);
  const room = width - fixed(left) - fixed(g.right) - (before > 0 && !left.length ? 2 : 0);
  const take = (budget: number): string[] => {
    const out: string[] = [];
    let used = 0;
    for (const c of rest) {
      const need = w(c) + (out.length ? sepWidth : 0);
      if (used + need > budget && out.length) break;
      out.push(c);
      used += need;
    }
    return out;
  };
  let middle = take(room + sepWidth);
  if (middle.length < rest.length) middle = take(room + sepWidth - 2);
  if (!middle.length && rest.length) middle = [rest[0]!];
  return { left: g.left, middle, right: g.right, before, after: rest.length - middle.length };
}

const hex = (value: string): [number, number, number] | undefined => {
  const v = value.trim();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(v);
  if (m) return [parseInt(m[1]! + m[1]!, 16), parseInt(m[2]! + m[2]!, 16), parseInt(m[3]! + m[3]!, 16)];
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(v);
  if (m) return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/iu.exec(v);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
};

/** A cell's CSS-ish style (marimo's `style_cell`) as terminal attributes. */
function styled(text: string, style: Record<string, unknown> | undefined): string {
  if (!style) return text;
  let out = text;
  const fg = typeof style.color === "string" ? hex(style.color) : undefined;
  const bg = typeof style.backgroundColor === "string" ? hex(style.backgroundColor) : undefined;
  if (fg) out = `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${out}\x1b[39m`;
  if (bg) out = `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m${out}\x1b[49m`;
  const weight = style.fontWeight;
  if (weight === "bold" || (typeof weight === "number" && weight >= 600) || (typeof weight === "string" && Number(weight) >= 600)) out = boldSgr(out);
  if (style.fontStyle === "italic") out = italic(out);
  if (typeof style.textDecoration === "string" && style.textDecoration.includes("underline")) out = underline(out);
  return out;
}

/** A sparkline of `width` blocks over bin counts. */
export function sparkline(counts: number[], width: number): string {
  if (!counts.length || width < 1) return "";
  const cells = Array.from({ length: width }, (_, i) => {
    const from = Math.floor((i * counts.length) / width);
    const to = Math.max(from + 1, Math.floor(((i + 1) * counts.length) / width));
    return Math.max(...counts.slice(from, to));
  });
  const top = Math.max(...cells, 1);
  return cells.map((c) => BLOCKS[Math.min(7, Math.round((c / top) * 7))]).join("");
}

const compact = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const s = String(v);
  return /^\d{4}-\d\d-\d\dT/u.test(s) ? s.slice(0, 10) : s;
};

/** The two summary lines (a chart, and the range or a count) of a column. */
function summaryCells(t: TableData, column: string, s: Summaries, width: number): [string, string] {
  const kind = fieldKind(t, column);
  const stats = s.stats[column] ?? {};
  const bins = s.bins[column] ?? [];
  if (kind === "boolean") {
    const nulls = Number(stats.nulls ?? 0);
    return [`✓${compact(stats.true)} ✗${compact(stats.false)}`, nulls > 0 ? `${compact(nulls)} null` : ""];
  }
  if (kind === "integer" || kind === "number" || isTemporal(kind)) {
    const chart = bins.length ? sparkline(bins.map((b) => b.count), width) : "";
    const range = stats.min === undefined && stats.max === undefined ? "" : `${compact(stats.min)}${isTemporal(kind) ? " → " : "–"}${compact(stats.max)}`;
    return [chart, range];
  }
  const top = (s.counts[column] ?? []).reduce<{ value: unknown; count: number } | undefined>((best, c) => (!best || c.count > best.count ? c : best), undefined);
  return [top ? `${String(top.value)} ${compact(top.count)}` : "", stats.unique !== undefined ? `${compact(stats.unique)} unique` : ""];
}

export interface Grid {
  lines: string[];
  /** For each line, the page row it belongs to (undefined for header, rules and footer). */
  rowAt: Array<number | undefined>;
}

export function tableGrid(t: TableData, width: number, theme: PaneTheme, maxRows: number, view?: TableRender): Grid {
  const lines: string[] = [];
  const rowAt: Array<number | undefined> = [];
  const dim = (s: string) => theme.fg("dim", s);
  const add = (line: string, row?: number) => { lines.push(line); rowAt.push(row); };
  const total = rowCount(t);
  const shown = Math.min(total, Math.max(1, maxRows));
  const sort = view?.sort ?? [];
  const firstRow = view?.firstRow ?? 0;
  if (t.label) add(theme.bold(t.label));
  if (t.banner) add(theme.fg("warning", t.banner));
  const rowSelect = t.selection === "single" || t.selection === "multi";
  const cellSelect = t.selection === "single-cell" || t.selection === "multi-cell";
  const markWidth = rowSelect ? SELECT_WIDTH + 3 : 0;
  const vis = visibleColumns(t, width - markWidth, view?.colOffset ?? 0, sort, shown);
  const headers = t.rowHeaders ?? [];
  const left = [...headers, ...vis.left];
  const order = [...left, ...vis.middle, ...vis.right];
  const w = new Map(order.map((c) => [c, widthOf(t, c, shown, sort)]));
  const orderAll = orderedColumns(t);
  const cursorColumn = view?.focused && view.cursorCol !== undefined ? orderAll[view.cursorCol] : undefined;
  const focusRow = view?.focused ? view.cursorRow : undefined;

  /** The line's pieces joined by separators; `◂` and `▸` take the outer space of the separators around the scrolled window. */
  const join = (cell: (c: string) => string, mark: string, rule = false): string => {
    let out = mark;
    order.forEach((c, i) => {
      const frozen = (i === left.length && left.length > 0) || (i === left.length + vis.middle.length && vis.right.length > 0);
      if (i > 0) {
        let sep = rule ? (frozen ? "━╋━" : "─┼─") : frozen ? FROZEN_SEP : SEP;
        if (!rule && c === vis.middle[0] && vis.before > 0) sep = `◂${sep.slice(1)}`;
        if (!rule && order[i - 1] === vis.middle.at(-1) && vis.after > 0) sep = `${sep.slice(0, -1)}▸`;
        out += rule ? sep : dim(sep);
      } else if (!rule && c === vis.middle[0] && vis.before > 0) out += dim("◂ ");
      out += cell(c);
    });
    if (!rule && vis.after > 0 && order.at(-1) === vis.middle.at(-1)) out += dim(" ▸");
    return out;
  };
  const markCol = (text: string) => (rowSelect ? `${text}${dim(SEP)}` : "");

  // Header.
  add(join((c) => {
    const name = `${c}${sortMark(sort, c)}`;
    const text = align(name, w.get(c)!, justify(t, c));
    const bold = theme.bold(text);
    return c === cursorColumn ? theme.fg("accent", underline(bold)) : bold;
  }, markCol("  ")));
  if (t.show?.types !== false && t.fieldTypes) add(join((c) => dim(align(t.fieldTypes?.[c]?.dtype ?? "", w.get(c)!, "left")), markCol("  ")));
  if (view?.summaries) {
    const cells = order.map((c) => summaryCells(t, c, view.summaries!, w.get(c)!));
    add(join((c) => align(cells[order.indexOf(c)]![0], w.get(c)!, "left"), markCol("  ")));
    add(join((c) => dim(align(cells[order.indexOf(c)]![1], w.get(c)!, "left")), markCol("  ")));
  }
  add(dim(join((c) => "─".repeat(w.get(c)!), rowSelect ? `${"─".repeat(SELECT_WIDTH)}─┼─` : "", true)));

  // Body.
  for (let i = 0; i < shown; i++) {
    const rowId = view?.rowIdOf(i) ?? String(t.records?.[i]?._marimo_row_id ?? firstRow + i);
    const styles = t.cellStyles?.[rowId];
    const cursor = focusRow === i;
    const cellLines = new Map<string, string[]>();
    let height = 1;
    for (const c of order) {
      const value = valueAt(t, i, c);
      const wrap = t.wrapped?.includes(c) && value.style === undefined;
      const parts = wrap ? wrapTextWithAnsi(value.text, w.get(c)!).slice(0, WRAP_LINES) : [value.text];
      cellLines.set(c, parts.length ? parts : [""]);
      height = Math.max(height, parts.length || 1);
    }
    for (let h = 0; h < height; h++) {
      const selectedRow = view?.selected.has(rowId) === true;
      const mark = rowSelect ? (h === 0 ? (t.selection === "multi" ? (selectedRow ? "☑" : "☐") : selectedRow ? "●" : "○") : " ") : "";
      let line = join((c) => {
        const value = valueAt(t, i, c);
        const text = align(cellLines.get(c)![h] ?? "", w.get(c)!, justify(t, c));
        let out = text;
        if (value.style === "null") out = dim(italic(text));
        else if (value.style === "yes") out = theme.fg("success", text);
        else if (value.style === "no") out = dim(text);
        out = styled(out, styles?.[c]);
        const chosen = cellSelect && view?.selectedCells?.has(`${rowId}\0${c}`);
        if (chosen || (cursor && c === cursorColumn)) out = inverse(out);
        return out;
      }, rowSelect ? `${selectedRow ? theme.fg("accent", `${mark} `) : `${mark} `}${dim(SEP)}` : "");
      if (cursor) line = theme.bg ? theme.bg("selectedBg", truncateToWidth(line, Math.max(1, width), "…", true)) : theme.bold(line);
      add(line, i);
    }
  }

  // Footer.
  const grand = view?.totalRows ?? t.totalRows ?? total;
  const parts: string[] = [];
  const count = (n: number | "many") => (n === "many" ? "many" : n.toLocaleString("en-US"));
  parts.push(shown ? `rows ${(firstRow + 1).toLocaleString("en-US")}–${(firstRow + shown).toLocaleString("en-US")} of ${count(grand)}` : `rows 0 of ${count(grand)}`);
  const size = t.pageSize ?? shown;
  if (t.pagination !== false && typeof grand === "number" && size > 0 && grand > size) parts.push(`page ${Math.floor(firstRow / size) + 1} of ${Math.ceil(grand / size)}`);
  const index = (c: string) => orderAll.indexOf(c);
  if (order.length < t.columns.length + (t.rowHeaders?.length ?? 0)) {
    const idx = order.map(index).filter((n) => n >= 0);
    if (idx.length) parts.push(`cols ${Math.min(...idx) + 1}–${Math.max(...idx) + 1} of ${orderAll.length}`);
  }
  for (const s of sort) parts.push(`sorted ${s.by} ${s.descending ? "↓" : "↑"}`);
  if (view?.status) parts.push(view.status);
  add(dim(parts.join(" · ")));
  return { lines: lines.map((l) => truncateToWidth(l, Math.max(1, width))), rowAt };
}

export function tableLines(t: TableData, width: number, theme: PaneTheme, maxRows: number, view?: TableRender): string[] {
  return tableGrid(t, width, theme, maxRows, view).lines;
}

/** Every column of one row, wrapped, the frozen and hidden ones too. */
export function rowCard(t: TableData, rowIndex: number, width: number, theme: PaneTheme, absolute: number): string[] {
  const record = t.records?.[rowIndex];
  const names = [...(t.rowHeaders ?? []), ...(t.hidden ?? []), ...orderedColumns(t)];
  const unique = [...new Set(names)];
  const long = Math.max(1, ...unique.map((n) => visibleWidth(n)));
  const out = [theme.bold(`row ${absolute + 1}`)];
  for (const name of unique) {
    const value = record ? format(record[name], fieldKind(t, name)).text : valueAt(t, rowIndex, name).text;
    const room = Math.max(10, width - long - 2);
    const wrapped = wrapTextWithAnsi(value, room);
    (wrapped.length ? wrapped : [""]).forEach((line, i) => out.push(`${theme.fg("dim", (i === 0 ? name : "").padEnd(long))}  ${line}`));
  }
  return out.map((l) => truncateToWidth(l, Math.max(1, width)));
}

const STAT_ORDER = ["total", "nulls", "unique", "min", "max", "mean", "median", "std", "p5", "p25", "p75", "p95", "true", "false"];

/** A column's statistics, distribution and most common values. */
export function columnCard(t: TableData, column: string, s: Summaries | undefined, top: Array<[string, number]> | undefined, width: number, theme: PaneTheme): string[] {
  const dtype = t.fieldTypes?.[column]?.dtype;
  const out = [theme.bold(`${column}${dtype ? ` · ${dtype}` : ""}`)];
  const stats = s?.stats[column] ?? {};
  for (const key of STAT_ORDER) {
    const v = stats[key];
    if (v !== null && v !== undefined) out.push(`${theme.fg("dim", key.padEnd(7))}  ${compact(v)}`);
  }
  const bins = s?.bins[column];
  if (bins?.length) out.push("", sparkline(bins.map((b) => b.count), Math.max(10, width)));
  const values = top ?? [];
  if (values.length) {
    const biggest = Math.max(1, ...values.map(([, n]) => n));
    out.push("", theme.fg("dim", "top values"));
    const nameWidth = Math.min(30, Math.max(...values.map(([v]) => visibleWidth(String(v)))));
    for (const [value, n] of values.slice(0, 10)) {
      out.push(`${align(String(value), nameWidth, "left")}  ${String(n).padStart(6)}  ${"█".repeat(Math.max(1, Math.round((n / biggest) * 20)))}`);
    }
  }
  if (!s && !top) out.push(theme.fg("dim", "loading…"));
  return out.map((l) => truncateToWidth(l, Math.max(1, width)));
}
