// The notebook as the view's rows. The outline (the default) is the headings and one line per code
// cell: its status, what it defines, what needs attention, how long it ran and what it output, with
// its widgets under it. Outputs mode (`O`) puts every cell's output under its line and renders the
// markdown cells as prose, the way the notebook reads in a browser. A cell's expansion adds its code
// (or the agent's diff), its dataflow, its console and its whole output.
import { generateDiffString, getMarkdownTheme, highlightCode, renderDiff } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import type { Geometry } from "../core/live.js";
import { markdownText } from "../core/markdown.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import type { CellOutput } from "../core/output.js";
import { elapsed, formatDuration } from "../core/render.js";
import type { ChartRenderer, VegaRenderer } from "../core/vega.js";
import type { FrameTheme } from "../frame.ts";
import type { LiveCharts } from "./live-charts.js";
import { PAD, clean, consoleRows, outputRows } from "./outputs.js";
import { widgetLine, widgetValue } from "./widgets.js";

/** How much of an expanded cell shows: its code. */
const MAX_CODE_LINES = 40;
/** Widgets listed under a cell, at most. */
export const MAX_WIDGETS = 8;

/** One display line. The first line of a cell carries its id (the cursor can stand there); a widget's line, its place. */
export interface Row {
  text: string;
  cell?: string;
  widget?: { cell: string; index: number };
  /** A line of the variables pane. */
  variable?: string;
  /** One line of an inline image: its place in the block, the block's height, and what shows when the block is not fully on screen. */
  image?: { index: number; height: number; alt: string; live?: { output: CellOutput; geometry: Geometry } };
}

export interface RowOptions {
  cursor?: string | undefined;
  expanded?: ReadonlySet<string>;
  filter?: string;
  /** Draw image outputs inline with at most this many rows (default: when the terminal shows images, 14; 0 never). */
  imageRows?: number;
  /** The width the view draws at, for sizing images, tables and prose. */
  width?: number;
  /** Turns Vega-Lite chart outputs into images; `onVega` runs when one finishes. */
  vega?: VegaRenderer;
  plotly?: ChartRenderer;
  /** Runs charts live in a browser page the mouse can drive; a chart it cannot run falls back to the static image. */
  live?: LiveCharts;
  onVega?: () => void;
  /** Every cell's output under it, markdown as prose. */
  outputs?: boolean;
  /** Cells (with headings) whose section is folded. */
  folded?: ReadonlySet<string>;
  /** Expanded cells that show the agent's diff instead of their code. */
  diffs?: ReadonlySet<string>;
  /** The widget the keys drive, and its sub-position (a range's handle, a multiselect's option). */
  widgetFocus?: { cell: string; index: number; sub: number };
  highlight?: (code: string) => string[];
  markdown?: (text: string, width: number) => string[];
}

export const firstLine = (code: string) => code.split("\n").find((l) => l.trim())?.trim() ?? "";

/** Python highlighted with Pi's theme; plain where there is none (Pi's theme is set up only in Pi). */
export function safeHighlight(code: string): string[] {
  try {
    return highlightCode(code, "python");
  } catch {
    return code.split("\n");
  }
}

const markdownCache = new Map<string, string[]>();

/** Markdown rendered with Pi's markdown theme, plain where there is none. */
export function safeMarkdown(text: string, width: number): string[] {
  const key = `${width}\0${text}`;
  const known = markdownCache.get(key);
  if (known) return known;
  let lines: string[];
  try {
    lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(Math.max(10, width));
  } catch {
    lines = text.split("\n");
  }
  if (markdownCache.size > 200) markdownCache.clear();
  markdownCache.set(key, lines);
  return lines;
}

/** The agent's change to a cell as Pi draws an edit's diff; plain without Pi's theme. */
export function diffLines(before: string, after: string): string[] {
  let diff: string;
  try {
    diff = generateDiffString(before, after, 2).diff;
  } catch {
    return after.split("\n");
  }
  try {
    return renderDiff(diff).split("\n");
  } catch {
    return diff.split("\n");
  }
}

/** The level of a cell's section (its highest heading), or undefined without headings. */
export function sectionLevel(nb: NotebookState, cell: Cell): number | undefined {
  const headings = nb.headings(cell);
  return headings.length ? Math.min(...headings.map((h) => h.level)) : undefined;
}

/** The cells a folded section hides, each with the cell that heads the fold. */
export function foldedCells(nb: NotebookState, folded: ReadonlySet<string>): Map<string, string> {
  const hidden = new Map<string, string>();
  if (!folded.size) return hidden;
  let open: { level: number; head: string } | undefined;
  for (const cell of nb.ordered()) {
    const level = sectionLevel(nb, cell);
    if (open) {
      if (level !== undefined && level <= open.level) open = undefined;
      else {
        hidden.set(cell.id, open.head);
        continue;
      }
    }
    if (level !== undefined && folded.has(cell.id)) open = { level, head: cell.id };
  }
  return hidden;
}

/**
 * The cells the cursor can stand on: code cells, and markdown cells with headings (every markdown
 * cell in outputs mode); with a filter, those matching it (name, id, variables, code, error). Folded
 * sections hide their cells, except while filtering.
 */
export function selectableCells(nb: NotebookState, filter = "", o: { outputs?: boolean; folded?: ReadonlySet<string> } = {}): Cell[] {
  const q = filter.trim().toLowerCase();
  const hidden = q ? new Map<string, string>() : foldedCells(nb, o.folded ?? new Set());
  return nb.ordered().filter((c) => {
    if (hidden.has(c.id)) return false;
    if (nb.isMarkdown(c) && !q && !o.outputs && !nb.headings(c).length) return false;
    if (!q) return true;
    return [c.name, c.id, ...(nb.defs.get(c.id) ?? []), c.code, c.error ?? ""].some((t) => t.toLowerCase().includes(q));
  });
}

/** Open marimo-lens selections (label, note, where, image) and the latest addressed ones, above the outline. */
export function lensSection(nb: NotebookState, theme: FrameTheme): string[] {
  const open = nb.lens.selections();
  const history = nb.lens.history().slice(-3);
  if (!open.length && !history.length) return [];
  const current = nb.lens.current()?.id;
  const where = (cells: string[]) => cells.map((id) => {
    const c = nb.cells.get(id);
    return c && c.name !== "_" ? c.name : id;
  }).join(", ");
  const lines = [theme.bold(theme.fg("accent", "Lens"))];
  for (const s of open) {
    const meta = [where(s.cells), s.image && s.image !== "available" ? `image ${s.image}` : "", s.previous !== undefined ? "reopened" : ""].filter(Boolean).join(" \u00b7 ");
    lines.push(`  ${theme.fg("warning", s.label)}${s.id === current ? theme.fg("dim", "*") : " "} ${s.note ? truncate(s.note.replace(/\s+/g, " "), 120) : theme.fg("dim", s.what ?? "(no note)")}${meta ? `  ${theme.fg("dim", meta)}` : ""}`);
  }
  for (const h of history) {
    lines.push(`  ${theme.fg("success", "\u2713")} ${theme.fg("dim", h.label)} ${theme.fg("dim", truncate(h.summary ?? h.note ?? "", 120))}`);
  }
  lines.push("");
  return lines;
}

export const cellLabel = (c: Pick<Cell, "id" | "name">): string => (c.name !== "_" ? c.name : c.id);

/** What a cell output is, short, for the end of its line in the outline. */
export function outputTag(output: CellOutput | undefined): string {
  if (!output) return "";
  if (output.kind === "table") {
    const t = output.table;
    if (!t) return output.text.replace(/^\[|\]$/gu, "");
    const rows = t.totalRows === "many" ? "many" : (t.totalRows ?? t.rows.length).toLocaleString("en-US");
    return `table ${rows}×${(t.totalColumns ?? t.columns.length).toLocaleString("en-US")}`;
  }
  if (output.kind === "image") return "image";
  if (output.kind === "chart") return "chart";
  if (output.kind === "widgets") return "";
  if (output.kind === "text") return output.text.trim() ? `\u201c${truncate(firstLine(output.text), 40)}\u201d` : "";
  return truncate(output.text, 40);
}

const headingText = (theme: FrameTheme, h: { level: number; text: string }): string =>
  `${"  ".repeat(Math.max(0, h.level - 1))}${h.level === 1 ? theme.bold(theme.fg("accent", h.text)) : theme.bold(h.text)}`;

const FSTRING_MD = /\bmo\s*\.\s*md\s*\(\s*(?:[rR]?[fF]|[fF][rR])/u;

/** The expanded part of a cell: its code (or the agent's diff), dataflow, console and output. */
export function expandedRows(cell: Cell, nb: NotebookState, theme: FrameTheme, opts: RowOptions = {}): Row[] {
  const out: Row[] = [];
  const push = (text: string) => out.push({ text });
  const change = nb.agentChanges.get(cell.id);
  const diff = !!change && opts.diffs?.has(cell.id) === true;
  const source = cell.code.replace(/\s+$/u, "").split("\n").map(clean).join("\n");
  const lines = diff ? diffLines(change!.before, cell.code) : (opts.highlight ?? safeHighlight)(source);
  for (const line of lines.slice(0, MAX_CODE_LINES)) push(`${PAD}${theme.fg("dim", "│")} ${line}`);
  if (lines.length > MAX_CODE_LINES) push(`${PAD}${theme.fg("dim", `│ … ${lines.length - MAX_CODE_LINES} more lines`)}`);
  if (nb.isMarkdown(cell)) return out;
  const label = (id: string) => { const c = nb.cells.get(id); return c ? cellLabel(c) : id; };
  const uses = nb.uses(cell.id).map((v) => { const from = nb.declaredBy.get(v)?.find((id) => id !== cell.id); return from ? `${v} ← ${label(from)}` : v; });
  const users = nb.children(cell.id).map(label);
  const flow = [uses.length ? `uses ${truncate(uses.join(", "), 100)}` : "", users.length ? `used by ${truncate(users.join(", "), 80)}` : ""].filter(Boolean);
  if (flow.length) push(`${PAD}${theme.fg("dim", "⇄")} ${flow.join(theme.fg("dim", " · "))}`);
  const defs = nb.defs.get(cell.id) ?? [];
  if (defs.some((d) => nb.values.has(d))) {
    const parts = defs.map((d) => { const v = nb.values.get(d); return v ? `${d} (${v.datatype ?? "?"}) ${truncate((v.value ?? "").replace(/\s+/gu, " "), 40)}` : d; });
    push(`${PAD}${theme.fg("dim", "=")} ${truncate(parts.join(", "), 160)}`);
  }
  out.push(...consoleRows(cell, theme, 40));
  out.push(...outputRows(cell, theme, opts, { textLines: 30, tableRows: 20 }));
  if (!cell.output && !(cell.console ?? []).length && !cell.error) {
    push(`${PAD}${theme.fg("dim", cell.status === "idle" && !cell.lastRunCode ? "▍ (not run)" : "▍ (no output)")}`);
  }
  return out;
}

/** The notebook as rows: headings (or prose), a line per code cell, its widgets and error, and what is open. */
export function notebookRows(nb: NotebookState, theme: FrameTheme, now: number, opts: RowOptions = {}): { rows: Row[]; running?: number; cellRows: Map<string, number>; widgetRows: Map<string, number> } {
  const filtering = !!opts.filter?.trim();
  const outputs = opts.outputs === true;
  const folded = opts.folded ?? new Set<string>();
  const rows: Row[] = (filtering ? [] : lensSection(nb, theme)).map((text) => ({ text }));
  const hidden = filtering ? new Map<string, string>() : foldedCells(nb, folded);
  const shown = new Set(selectableCells(nb, opts.filter, { outputs, folded }).map((c) => c.id));
  const cellRows = new Map<string, number>();
  const widgetRows = new Map<string, number>();
  let running: number | undefined;
  // Each cell's open Lens selections, tagged on its row.
  const marks = new Map<string, string[]>();
  for (const s of nb.lens.selections()) for (const id of s.cells) marks.set(id, [...marks.get(id) ?? [], s.label]);
  // What each fold hides.
  const inFold = new Map<string, Cell[]>();
  for (const [id, head] of hidden) { const c = nb.cells.get(id); if (c) inFold.set(head, [...inFold.get(head) ?? [], c]); }
  const foldSummary = (head: string): string => {
    if (filtering || !folded.has(head)) return "";
    const inside = (inFold.get(head) ?? []).filter((c) => !nb.isMarkdown(c));
    const busy = inside.some((c) => c.status === "running");
    const errors = inside.filter((c) => c.error).length;
    return `  ${theme.fg("dim", "▸")} ${theme.fg("dim", `${inside.length} cell${inside.length === 1 ? "" : "s"}`)}${busy ? `${theme.fg("dim", " · ")}${theme.fg("accent", "running")}` : ""}${errors ? `${theme.fg("dim", " · ")}${theme.fg("error", `${errors} error${errors === 1 ? "" : "s"}`)}` : ""}`;
  };
  const icon = (c: Cell) =>
    c.status === "running"
      ? theme.fg("accent", "●")
      : c.error || c.blocked
        ? theme.fg("error", "✗")
        : c.status === "queued"
          ? theme.fg("muted", "◌")
          : c.stale || nb.edited(c)
            ? theme.fg("warning", "○")
            : theme.fg("dim", "○");
  const proseWidth = (opts.width ?? 80) - 4 - 2;
  for (const cell of nb.ordered()) {
    if (hidden.has(cell.id)) continue;
    const headings = nb.headings(cell);
    const here = opts.cursor === cell.id;
    const open = opts.expanded?.has(cell.id) === true;
    const mark = here ? theme.fg("accent", "●") : open ? theme.fg("dim", "▾") : " ";
    const marked = marks.get(cell.id);
    const tags = marked ? ` ${theme.fg("warning", marked.join(" "))}` : "";
    if (nb.isMarkdown(cell)) {
      if (!shown.has(cell.id)) continue;
      cellRows.set(cell.id, rows.length);
      let lines: string[];
      if (outputs && !filtering) {
        const md = FSTRING_MD.test(cell.code) ? undefined : markdownText(cell.code);
        const text = md ?? (cell.output?.kind === "text" ? cell.output.text : undefined);
        lines = text !== undefined ? (md !== undefined ? (opts.markdown ?? safeMarkdown)(md, proseWidth) : text.split("\n")) : headings.map((h) => headingText(theme, h));
        while (lines.length && !lines.at(-1)!.trim()) lines.pop();
        if (!lines.length) lines = [theme.fg("dim", "(empty markdown)")];
      } else {
        lines = headings.length ? headings.map((h) => headingText(theme, h)) : [theme.fg("dim", truncate(firstLine(markdownText(cell.code) ?? cell.code), 80))];
      }
      lines.forEach((line, i) => rows.push(i === 0 ? { text: `${mark} ${line}${tags}${foldSummary(cell.id)}`, cell: cell.id } : { text: `  ${line}` }));
      if (open) rows.push(...expandedRows(cell, nb, theme, opts));
      continue;
    }
    if (!filtering) headings.forEach((h, i) => rows.push({ text: `  ${headingText(theme, h)}${i === 0 ? foldSummary(cell.id) : ""}` }));
    if (!shown.has(cell.id)) continue;
    const notes: string[] = [];
    if (cell.status === "running") notes.push(theme.fg("accent", `running${cell.runningSince ? ` ${elapsed(now - cell.runningSince)}` : ""}`));
    else if (cell.status === "queued") notes.push(theme.fg("muted", "queued"));
    if (cell.blocked) notes.push(theme.fg("error", "not run: an ancestor failed"));
    if (cell.disabled) notes.push(theme.fg("dim", "disabled"));
    if (cell.stale) notes.push(theme.fg("warning", "stale"));
    if (nb.edited(cell)) notes.push(theme.fg("warning", "edited, not rerun"));
    const change = nb.agentChanges.get(cell.id);
    if (change) notes.push(theme.fg("accent", change.kind === "created" ? "new from the agent" : "changed by the agent"));
    if (cell.status === "idle" && cell.lastRunMs !== undefined) notes.push(theme.fg("dim", formatDuration(cell.lastRunMs)));
    const defs = nb.defs.get(cell.id) ?? [];
    const label = cellLabel(cell);
    const what = defs.length ? `→ ${truncate(defs.join(", "), 80)}` : theme.fg("dim", truncate(firstLine(cell.code) || "(empty)", 80));
    const tag = !outputs && !open ? outputTag(cell.output) : "";
    if (cell.status === "running") running = rows.length;
    cellRows.set(cell.id, rows.length);
    rows.push({
      cell: cell.id,
      text: `${mark} ${icon(cell)} ${here ? theme.bold(label) : theme.fg("muted", label)}${tags}  ${what}${notes.length ? `  ${notes.join(theme.fg("dim", " · "))}` : ""}${tag ? `  ${theme.fg("dim", tag)}` : ""}`,
    });
    const widgets = cell.output?.widgets ?? [];
    widgets.slice(0, MAX_WIDGETS).forEach((w, index) => {
      const focused = opts.widgetFocus?.cell === cell.id && opts.widgetFocus.index === index;
      widgetRows.set(`${cell.id}\0${index}`, rows.length);
      rows.push({ text: `${PAD}${focused ? theme.fg("accent", "▸") : theme.fg("dim", "◆")} ${widgetLine(w, widgetValue(nb, w), focused ? { sub: opts.widgetFocus!.sub } : undefined, theme)}`, widget: { cell: cell.id, index } });
    });
    if (widgets.length > MAX_WIDGETS) rows.push({ text: `${PAD}${theme.fg("dim", `… ${widgets.length - MAX_WIDGETS} more widgets: o opens the notebook`)}` });
    if (cell.error) rows.push({ text: `${PAD}${theme.fg("error", truncate(cell.error, 200))}` });
    if (open) rows.push(...expandedRows(cell, nb, theme, opts));
    else if (outputs) rows.push(...consoleRows(cell, theme, 5), ...outputRows(cell, theme, opts, { textLines: 12, tableRows: 10 }));
  }
  const removed = [...nb.agentChanges].filter(([, c]) => c.kind === "deleted");
  if (removed.length && !filtering) {
    rows.push({ text: "" }, { text: theme.bold(theme.fg("dim", "Removed by the agent since your last message")) });
    for (const [id, c] of removed) rows.push({ text: `  ${theme.fg("dim", "✗")} ${theme.fg("dim", `${c.name && c.name !== "_" ? c.name : id}  ${truncate(firstLine(c.before) || "(empty)", 80)}`)}` });
  }
  return { rows, ...(running !== undefined ? { running } : {}), cellRows, widgetRows };
}

/** The notebook as display lines (see notebookRows), without images. */
export function notebookLines(nb: NotebookState, theme: FrameTheme, now: number, opts: RowOptions = {}): { lines: string[]; running?: number } {
  const { rows, running } = notebookRows(nb, theme, now, { ...opts, imageRows: 0 });
  return { lines: rows.map((r) => r.text), ...(running !== undefined ? { running } : {}) };
}
