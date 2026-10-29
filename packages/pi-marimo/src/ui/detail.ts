// The detail: the notebook view's right pane, the selected cell as a reader wants it. Prose is
// rendered, the output is large, an error comes with its traceback, the code is folded (Enter opens
// it) and the dataflow is named by variable. In section view (`O`) it is the whole section stacked
// as a document, the selected cell marked. No cell ids and no Python reprs: values are in the
// variables pane.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { markdownText } from "../core/markdown.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import { elapsed, formatDuration } from "../core/render.js";
import type { FrameTheme } from "../frame.ts";
import { clean, outputRows } from "./outputs.js";
import { cellGlyph, headingText } from "./outline.js";
import { MAX_WIDGETS, type Row, type RowOptions, diffLines, safeHighlight, safeMarkdown } from "./rows.js";
import { cellTitle, sectionOf } from "./titles.js";
import { widgetLine, widgetValue } from "./widgets.js";

/** How much of an open cell's code shows. */
const MAX_CODE_LINES = 40;
const FSTRING_MD = /\bmo\s*\.\s*md\s*\(\s*(?:[rR]?[fF]|[fF][rR])/u;

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
}

/** `left` and `right` on one line of `width`, the right one flush right. */
function sides(left: string, right: string, width: number): string {
  const rw = visibleWidth(right);
  const cut = truncateToWidth(left, Math.max(1, width - rw - (rw ? 1 : 0)), "…");
  return `${cut}${" ".repeat(Math.max(rw ? 1 : 0, width - visibleWidth(cut) - rw))}${right}`;
}

export function detailRows(nb: NotebookState, theme: FrameTheme, now: number, o: DetailOptions): { rows: Row[]; widgetRows: Map<string, number>; focusRow?: number } {
  const rows: Row[] = [];
  const widgetRows = new Map<string, number>();
  const width = Math.max(10, o.width);
  // A chart takes the pane's width, and as much of its height as fits under the title (a section shares it).
  const page = o.imageRows ?? 14;
  const sub: RowOptions = { ...o, pad: "", width, imageRows: Math.max(2, o.section ? Math.min(page - 4, Math.floor(page * 0.6)) : page - 4) };
  const push = (text: string) => rows.push({ text });
  const dim = (text: string) => theme.fg("dim", text);

  /** A markdown cell as prose, trailing blank lines dropped. */
  const proseOf = (cell: Cell, w = width): string[] => {
    const md = FSTRING_MD.test(cell.code) ? undefined : markdownText(cell.code);
    const text = md ?? (cell.output?.kind === "text" ? cell.output.text : undefined);
    let lines = text !== undefined ? (md !== undefined ? (o.markdown ?? safeMarkdown)(md, w) : text.split("\n")) : nb.headings(cell).map((h) => headingText(theme, h));
    lines = [...lines];
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines.length ? lines : [dim("(empty markdown)")];
  };

  /** The widgets of a cell's output, focusable. */
  const widgetBlock = (cell: Cell) => {
    const widgets = cell.output?.widgets ?? [];
    widgets.slice(0, MAX_WIDGETS).forEach((w, index) => {
      const focused = o.widgetFocus?.cell === cell.id && o.widgetFocus.index === index;
      widgetRows.set(`${cell.id}\0${index}`, rows.length);
      rows.push({ text: `${focused ? theme.fg("accent", "▸") : dim("◆")} ${widgetLine(w, widgetValue(nb, w), focused ? { sub: o.widgetFocus!.sub } : undefined, theme)}`, widget: { cell: cell.id, index } });
    });
    if (widgets.length > MAX_WIDGETS) push(dim(`… ${widgets.length - MAX_WIDGETS} more widgets: o opens the notebook`));
  };

  /** `▸ code · N lines`, or the code (or the agent's diff) under `▾ code`. */
  const codeBlock = (cell: Cell, open: boolean, diff: boolean) => {
    const source = cell.code.replace(/\s+$/u, "");
    const total = source ? source.split("\n").length : 0;
    if (!open) {
      rows.push({ text: dim(`▸ code · ${total} line${total === 1 ? "" : "s"}`), code: true });
      return;
    }
    const change = nb.agentChanges.get(cell.id);
    const lines = diff && change ? diffLines(change.before, cell.code) : (o.highlight ?? safeHighlight)(source.split("\n").map(clean).join("\n"));
    rows.push({ text: dim(diff && change ? "▾ code · the agent's change" : "▾ code"), code: true });
    for (const line of lines.slice(0, MAX_CODE_LINES)) push(`${dim("│")} ${line}`);
    if (lines.length > MAX_CODE_LINES) push(dim(`│ … ${lines.length - MAX_CODE_LINES} more lines`));
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
    if (cell.error) push(theme.fg("error", truncate(cell.error, 300)));
    const lines = cell.console ?? [];
    for (const l of lines.filter((x) => x.stream === "stderr")) push(theme.fg("warning", clean(l.text)));
    for (const l of lines.filter((x) => x.stream === "stdout").slice(-printed)) push(`${dim("▍")} ${clean(l.text)}`);
    rows.push(...outputRows(cell, theme, sub, limits));
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
        proseOf(cell, width - 1).forEach((line) => push(`${selected ? theme.fg("accent", "▌") : " "}${line}`));
        continue;
      }
      push(`${selected ? theme.fg("accent", "▌") : " "}${cellGlyph(nb, theme, cell)} ${selected ? theme.bold(cellTitle(nb, cell)) : dim(cellTitle(nb, cell))}`);
      resultBlock(cell, { textLines: 12, tableRows: 10 }, 5);
    }
    return { rows, widgetRows, ...(focusRow !== undefined ? { focusRow } : {}) };
  }

  const cell = o.cell;
  if (nb.isMarkdown(cell)) {
    rows.push(...proseOf(cell).map((text): Row => ({ text })));
    const cells = nb.ordered();
    for (let i = cells.findIndex((c) => c.id === cell.id) + 1; i > 0 && i < cells.length; i++) {
      const next = cells[i]!;
      if (!nb.isMarkdown(next) || nb.headings(next).length) break;
      push("");
      rows.push(...proseOf(next).map((text): Row => ({ text })));
    }
    push("");
    codeBlock(cell, o.codeOpen, false);
    return { rows, widgetRows };
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
  return { rows, widgetRows };
}
