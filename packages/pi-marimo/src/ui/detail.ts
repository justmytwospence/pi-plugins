// The detail: the notebook view's right pane, the selected cell as a reader wants it. Prose is
// rendered, the output is large, an error comes with its traceback, the code is folded (Enter opens
// it) and the dataflow is named by variable. In section view (`O`) it is the whole section stacked
// as a document, the selected cell marked. No cell ids and no Python reprs: values are in the
// variables pane.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { editableMarkdown } from "../core/markdown.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import { elapsed, formatDuration } from "../core/render.js";
import type { FrameTheme } from "../frame.ts";
import { clean, outputRows } from "./outputs.js";
import { type PaneTheme, cellGlyph, headingText } from "./outline.js";
import { MAX_WIDGETS, type Row, type RowOptions, diffLines, safeHighlight, safeMarkdown } from "./rows.js";
import { cellTitle, sectionOf } from "./titles.js";
import { widgetLine, widgetValue } from "./widgets.js";

/** How much of an open cell's code shows. */
const MAX_CODE_LINES = 40;

/** A focusable piece of the detail: what `n` and `p` walk and Enter acts on. */
export interface Part {
  kind: "error" | "printed" | "output" | "table" | "chart" | "widgets" | "code" | "markdown";
  cell: string;
  /** Its row in the detail. */
  row: number;
}

export interface DetailOptions extends RowOptions {
  /** The selected cell. */
  cell: Cell;
  width: number;
  /** The selected cell's code shows (instead of `▸ code · N lines`). */
  codeOpen: boolean;
  /** The code shows as the agent's diff. */
  diff: boolean;
  /** The whole section, stacked, instead of the cell. */
  section: boolean;
  /** The widget the keys drive, and its sub-position. */
  widgetFocus?: { cell: string; index: number; sub: number } | undefined;
  highlight?: (code: string) => string[];
  markdown?: (text: string, width: number) => string[];
  /** The focused part (an index into the returned `parts`). */
  partFocus?: number | undefined;
  /** A row or column card that replaces the table's grid. */
  tableCard?: (cell: Cell) => string[] | undefined;
}

/** `left` and `right` on one line of `width`, the right one flush right. */
function sides(left: string, right: string, width: number): string {
  const rw = visibleWidth(right);
  const cut = truncateToWidth(left, Math.max(1, width - rw - (rw ? 1 : 0)), "…");
  return `${cut}${" ".repeat(Math.max(rw ? 1 : 0, width - visibleWidth(cut) - rw))}${right}`;
}

export function detailRows(nb: NotebookState, theme: FrameTheme, now: number, o: DetailOptions): { rows: Row[]; widgetRows: Map<string, number>; focusRow?: number; parts: Part[] } {
  const rows: Row[] = [];
  const widgetRows = new Map<string, number>();
  const width = Math.max(10, o.width);
  // A chart takes the pane's width, and as much of its height as fits under the title (a section shares it).
  const page = o.imageRows ?? 14;
  const sub: RowOptions = { ...o, pad: "", width, imageRows: Math.max(2, o.section ? Math.min(page - 4, Math.floor(page * 0.6)) : page - 4) };
  const push = (text: string) => rows.push({ text });
  const dim = (text: string) => theme.fg("dim", text);
  const pane = theme as PaneTheme;
  const parts: Part[] = [];

  /**
   * A part of a cell (its error, what it printed, its output, its widgets, its code): no label, its rows
   * carry a bar in the first column instead, in the part's own color, or the accent `▌` when focused.
   */
  const part = (kind: Part["kind"], cell: Cell) => {
    const index = parts.length;
    const focused = o.partFocus === index;
    parts.push({ kind, cell: cell.id, row: rows.length });
    const bar = (color?: string): string => (focused ? theme.fg("accent", "▌") : color ? theme.fg(color, "▍") : " ");
    const add = (text: string, extra: Partial<Row> = {}) => rows.push({ text, part: index, ...extra });
    return { index, focused, bar, add };
  };

  /** A markdown cell as prose, trailing blank lines dropped. */
  const proseOf = (cell: Cell, w = width): string[] => {
    const md = editableMarkdown(cell.code);
    const text = md ?? (cell.output?.kind === "text" ? cell.output.text : undefined);
    let lines = text !== undefined ? (md !== undefined ? (o.markdown ?? safeMarkdown)(md, w) : text.split("\n")) : nb.headings(cell).map((h) => headingText(theme, h));
    lines = [...lines];
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines.length ? lines : [dim("(empty markdown)")];
  };

  /** The widgets of a cell's output, focusable. */
  const widgetBlock = (cell: Cell) => {
    const widgets = cell.output?.widgets ?? [];
    if (!widgets.length) return;
    const p = part("widgets", cell);
    widgets.slice(0, MAX_WIDGETS).forEach((w, index) => {
      const focused = o.widgetFocus?.cell === cell.id && o.widgetFocus.index === index;
      widgetRows.set(`${cell.id}\0${index}`, rows.length);
      // `WIDGET_TEXT` columns before the control's own text: the bar, a space, the glyph and a space.
      p.add(`${p.bar()} ${focused ? theme.fg("accent", "▸") : dim("◆")} ${widgetLine(w, widgetValue(nb, w), focused ? { sub: o.widgetFocus!.sub } : undefined, theme)}`, { widget: { cell: cell.id, index } });
    });
    if (widgets.length > MAX_WIDGETS) p.add(`${p.bar()} ${dim(`… ${widgets.length - MAX_WIDGETS} more widgets: o opens the notebook`)}`);
  };

  /**
   * The code as a block on a background (a `│` gutter without one): folded, its first line dimmed and
   * `⋯ +N` for the rest; open, every line highlighted (or the agent's diff). Any of its rows opens or folds it.
   */
  const codeBlock = (cell: Cell, open: boolean, diff: boolean) => {
    const source = cell.code.replace(/\s+$/u, "");
    const all = source ? source.split("\n") : [];
    const p = part("code", cell);
    const bg = pane.bg ? pane.bg.bind(pane) : undefined;
    const start = bg ? bg("toolPendingBg", "\u0000").split("\u0000")[0] ?? "" : "";
    // The block starts at the pane's left edge; the focused part's accent bar takes its first column.
    const inner = p.focused ? width - 1 : width;
    // Highlighted code resets its colors mid-line: the background opens again after each reset.
    const block = (line: string): string => bg
      ? bg("toolPendingBg", truncateToWidth(` ${line.replace(/\x1b\[0m|\x1b\[49m/gu, (m) => m + start)}`, inner, "…", true))
      : `${dim("│")} ${line}`;
    const add = (line: string) => p.add(`${p.focused ? p.bar() : ""}${block(line)}`, { code: true });
    if (!open) {
      const first = all.find((l) => l.trim()) ?? "";
      const rest = all.length - 1;
      const more = rest > 0 ? dim(`  ⋯ +${rest}`) : "";
      add(`${dim(truncateToWidth(clean(first), Math.max(4, inner - 3 - visibleWidth(more)), "…"))}${more}`);
      return;
    }
    const change = nb.agentChanges.get(cell.id);
    const lines = diff && change ? diffLines(change.before, cell.code) : (o.highlight ?? safeHighlight)(all.map(clean).join("\n"));
    for (const line of lines.slice(0, MAX_CODE_LINES)) add(line);
    if (lines.length > MAX_CODE_LINES) add(dim(`⋯ +${lines.length - MAX_CODE_LINES}`));
  };

  const statusOf = (cell: Cell): string => {
    const parts: string[] = [];
    if (cell.status === "running") parts.push(theme.fg("accent", `running${cell.runningSince ? ` ${elapsed(now - cell.runningSince)}` : ""}`));
    else if (cell.status === "queued") parts.push(theme.fg("muted", "queued"));
    if (cell.blocked) parts.push(theme.fg("error", "not run: an ancestor failed"));
    if (cell.disabled) parts.push(dim("disabled"));
    if (cell.stale) parts.push(theme.fg("warning", "stale"));
    if (nb.edited(cell)) parts.push(theme.fg("warning", "edited, not rerun"));
    const change = nb.agentChanges.get(cell.id);
    if (change && change.kind !== "deleted") parts.push(theme.fg("accent", change.kind === "created" ? "new from the agent" : "changed by the agent"));
    return parts.join(dim(" · "));
  };

  const lensOf = (cell: Cell): string[] =>
    nb.lens.selections().filter((s) => s.cells.includes(cell.id)).map((s) => `${theme.fg("warning", s.label)} ${s.note ? truncate(s.note.replace(/\s+/gu, " "), 200) : dim(s.what ?? "(no note)")}`);

  /** Error, traceback, what it printed, and the output. */
  const resultBlock = (cell: Cell, limits: { textLines: number; tableRows: number }, printed: number) => {
    const lines = cell.console ?? [];
    const stderr = lines.filter((x) => x.stream === "stderr");
    if (cell.error || stderr.length) {
      const p = part("error", cell);
      if (cell.error) p.add(`${p.bar("error")} ${theme.fg("error", truncate(cell.error, 300))}`);
      for (const l of stderr) p.add(`${p.bar("error")} ${theme.fg("warning", clean(l.text))}`);
    }
    const stdout = lines.filter((x) => x.stream === "stdout");
    if (stdout.length) {
      const p = part("printed", cell);
      for (const l of stdout.slice(-printed)) p.add(`${p.bar("dim")} ${clean(l.text)}`);
    }
    const output = cell.output;
    const kind: Part["kind"] = output?.table ? "table" : output?.kind === "image" || output?.kind === "chart" ? "chart" : "output";
    // A part is only taken when the output has rows of its own; it would be the next one.
    const bar = o.partFocus === parts.length ? theme.fg("accent", "▌") : theme.fg("dim", "▍");
    const card = output?.table ? o.tableCard?.(cell) : undefined;
    const shown = card ? card.map((text): Row => ({ text: `${bar} ${text}` })) : outputRows(cell, theme, { ...sub, bar }, limits);
    if (output && shown.length) {
      const p = part(kind, cell);
      for (const r of shown) rows.push({ ...r, part: p.index });
    }
    widgetBlock(cell);
  };

  if (o.section) {
    const cells = nb.ordered();
    const at = Math.max(0, cells.findIndex((c) => c.id === o.cell.id));
    let start = at;
    while (start > 0 && !nb.headings(cells[start]!).length) start--;
    if (!nb.headings(cells[start]!).length) start = 0;
    let end = start + 1;
    while (end < cells.length && !nb.headings(cells[end]!).length) end++;
    let focusRow: number | undefined;
    for (const cell of cells.slice(start, end)) {
      const selected = cell.id === o.cell.id;
      if (rows.length) push("");
      if (selected) focusRow = rows.length;
      if (nb.isMarkdown(cell)) {
        const index = parts.length;
        const focused = o.partFocus === index;
        parts.push({ kind: "markdown", cell: cell.id, row: rows.length });
        proseOf(cell, width - 1).forEach((line) => rows.push({ text: `${selected || focused ? theme.fg("accent", "▌") : " "}${line}`, part: index }));
        continue;
      }
      push(`${selected ? theme.fg("accent", "▌") : " "}${cellGlyph(nb, theme, cell)} ${selected ? theme.bold(cellTitle(nb, cell)) : dim(cellTitle(nb, cell))}`);
      resultBlock(cell, { textLines: 12, tableRows: 10 }, 5);
    }
    return { rows, widgetRows, parts, ...(focusRow !== undefined ? { focusRow } : {}) };
  }

  const cell = o.cell;
  if (nb.isMarkdown(cell)) {
    /** One markdown cell as a part: the accent bar when focused, prose beside it. */
    const prose = (c: Cell) => {
      const index = parts.length;
      const focused = o.partFocus === index;
      parts.push({ kind: "markdown", cell: c.id, row: rows.length });
      const bar = focused ? theme.fg("accent", "▌") + " " : "  ";
      for (const line of proseOf(c, width - 2)) rows.push({ text: `${bar}${line}`, part: index });
    };
    prose(cell);
    const cells = nb.ordered();
    for (let i = cells.findIndex((c) => c.id === cell.id) + 1; i > 0 && i < cells.length; i++) {
      const next = cells[i]!;
      if (!nb.isMarkdown(next) || nb.headings(next).length) break;
      push("");
      prose(next);
    }
    if (editableMarkdown(cell.code) === undefined) {
      push("");
      codeBlock(cell, o.codeOpen, false);
    }
    return { rows, widgetRows, parts };
  }

  const title = cellTitle(nb, cell);
  const where = sectionOf(nb, cell.id).join(" › ");
  const ran = cell.status === "idle" && cell.lastRunMs !== undefined ? dim(formatDuration(cell.lastRunMs)) : "";
  push(sides(`${theme.bold(title)}${where ? dim(` · ${where}`) : ""}`, ran, width));
  const status = statusOf(cell);
  if (status) push(status);
  for (const line of lensOf(cell)) push(line);
  push("");
  const before = rows.length;
  resultBlock(cell, { textLines: 40, tableRows: 20 }, 20);
  if (rows.length === before && !cell.error) push(dim(cell.status === "idle" && !cell.lastRunCode ? "(not run)" : "(no output)"));
  push("");
  codeBlock(cell, o.codeOpen, o.diff);
  const uses = nb.uses(cell.id);
  // Prose cells use `mo` and the like; they are no one's dataflow, and an imports cell has no story to tell.
  const users = title === "imports" ? [] : nb.children(cell.id).map((id) => nb.cells.get(id)).filter((c): c is Cell => !!c && !nb.isMarkdown(c)).map((c) => cellTitle(nb, c));
  const flow = [uses.length ? `uses ${truncate(uses.join(", "), 100)}` : "", users.length ? `used by ${truncate(users.join(", "), 100)}` : ""].filter(Boolean);
  if (flow.length) {
    push("");
    push(dim(flow.join(" · ")));
  }
  return { rows, widgetRows, parts };
}
