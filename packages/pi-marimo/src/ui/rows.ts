// What the notebook view's panes share: its row type, the highlight, markdown and diff helpers, and
// which cells the cursor can stand on and which a fold hides. The outline is outline.ts, the
// selected cell's detail detail.ts.
import { generateDiffString, getMarkdownTheme, highlightCode, renderDiff } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import type { Geometry } from "../core/live.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import type { CellOutput, TableData } from "../core/output.js";
import type { ChartRenderer, VegaRenderer } from "../core/vega.js";
import type { LiveCharts } from "./live-charts.js";
import type { TableRender } from "./table.js";

/** Widgets listed under a cell, at most. */
export const MAX_WIDGETS = 8;

/** One display line. The first line of a cell in the outline carries its id (the cursor can stand there); a widget's line, its place. */
export interface Row {
  text: string;
  cell?: string;
  /** The `▸ code` line of the detail, which a click opens or folds. */
  code?: boolean;
  widget?: { cell: string; index: number };
  /** A part label of the detail (its index in the parts list), or a line of a part the label heads. */
  part?: number;
  /** A body row of a table grid: its index within the page. */
  tableRow?: number;
  /** A line of the variables pane. */
  variable?: string;
  /** One line of an inline image: its place in the block, the block's height, and what shows when the block is not fully on screen. */
  image?: { index: number; height: number; alt: string; live?: { output: CellOutput; geometry: Geometry } };
}

export interface RowOptions {
  /** Draw image outputs inline with at most this many rows (default: when the terminal shows images, 14; 0 never). */
  imageRows?: number;
  /** The width the pane draws at, for sizing images, tables and prose. */
  width?: number;
  /** The indent of an output's rows (default: six spaces; the detail pane has none). */
  pad?: string;
  /** Turns Vega-Lite chart outputs into images; `onVega` runs when one finishes. */
  vega?: VegaRenderer;
  plotly?: ChartRenderer;
  /** Runs charts live in a browser page the mouse can drive; a chart it cannot run falls back to the static image. */
  live?: LiveCharts;
  onVega?: () => void;
  /** The marimo table behind a cell's output, as the view drives it (its current page and cursor), when it does. */
  table?: (cell: Cell) => { data: TableData; render?: TableRender; /** What the table's label adds: `sorted by cups`. */ note?: string } | undefined;
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
 * The cells the cursor can stand on: code cells, and markdown cells with headings; with a filter,
 * those matching it (name, id, variables, code, error). Folded sections hide their cells, except
 * while filtering.
 */
export function selectableCells(nb: NotebookState, filter = "", o: { folded?: ReadonlySet<string> } = {}): Cell[] {
  const q = filter.trim().toLowerCase();
  const hidden = q ? new Map<string, string>() : foldedCells(nb, o.folded ?? new Set());
  return nb.ordered().filter((c) => {
    if (hidden.has(c.id)) return false;
    if (nb.isMarkdown(c) && !q && !nb.headings(c).length) return false;
    if (!q) return true;
    return [c.name, c.id, ...(nb.defs.get(c.id) ?? []), c.code, c.error ?? ""].some((t) => t.toLowerCase().includes(q));
  });
}
