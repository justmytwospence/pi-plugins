// What the notebook view calls a cell, and the one badge at the end of its outline line. A cell's id
// is never shown: a cell is its name, what it defines that others use, or what it shows.
import { markdownText } from "../core/markdown.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import { elapsed } from "../core/render.js";
import type { FrameTheme } from "../frame.ts";

const MAX_TITLE = 40;

const codeLines = (code: string): string[] => code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** A cell that only imports: every variable it defines is a module (or, values unknown, most of its lines are imports). */
function isImports(nb: NotebookState, cell: Cell, defs: string[]): boolean {
  if (defs.length && defs.every((d) => nb.values.has(d))) return defs.every((d) => nb.values.get(d)?.datatype === "module");
  const lines = codeLines(cell.code);
  return lines.length > 0 && lines.filter((l) => /^(?:import|from)\s/u.test(l)).length * 2 >= lines.length;
}

const names = (list: string[]): string => `${list.slice(0, 2).join(", ")}${list.length > 2 ? ` +${list.length - 2}` : ""}`;

const firstCodeLine = (code: string): string => code.split("\n").find((l) => l.trim())?.trim() ?? "";

/** An output the view only knows is interactive (marimo's own elements it cannot draw). */
const interactive = (o: NonNullable<Cell["output"]>): boolean => o.kind === "chart" && !o.vega && !o.plotly && !o.image && o.text.startsWith("[interactive");

/** The words for what a cell's output is, when it is not text. */
function shows(cell: Cell): string | undefined {
  const o = cell.output;
  if (!o) return undefined;
  if (interactive(o)) return "output";
  if (o.kind === "image" || o.kind === "chart") return "chart";
  if (o.kind === "table") return "table";
  if (o.kind === "widgets" || (o.widgets?.length && !o.text.trim())) return "controls";
  return undefined;
}

/** A cell's title: its name; `imports`; the variables others use; what it shows; its other variables; its first line of code. */
export function cellTitle(nb: NotebookState, cell: Cell): string {
  if (nb.isMarkdown(cell)) {
    const heading = nb.headings(cell)[0];
    if (heading) return truncate(heading.text, MAX_TITLE);
    return truncate((markdownText(cell.code) ?? cell.code).replace(/\s+/gu, " ").trim() || "(empty)", MAX_TITLE);
  }
  if (cell.name && cell.name !== "_") return truncate(cell.name, MAX_TITLE);
  const defs = nb.defs.get(cell.id) ?? [];
  if (isImports(nb, cell, defs)) return "imports";
  const used = defs.filter((d) => (nb.usedBy.get(d) ?? []).some((id) => id !== cell.id));
  if (used.length) return truncate(names(used), MAX_TITLE);
  const word = shows(cell);
  if (word) return word;
  if (defs.length) return truncate(names(defs), MAX_TITLE);
  return truncate(firstCodeLine(cell.code) || "(empty)", MAX_TITLE);
}

/** The cell's section path without its own headings. */
export function sectionOf(nb: NotebookState, cellId: string): string[] {
  const cell = nb.cells.get(cellId);
  const path = nb.sectionPath(cellId);
  return cell ? path.slice(0, Math.max(0, path.length - nb.headings(cell).length)) : path;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The shape of a cell's output (`450×4`, `chart`, `4 inputs`), or nothing. */
export function outputShape(cell: Cell): string {
  const o = cell.output;
  if (!o) return "";
  if (o.kind === "table") {
    const t = o.table;
    if (!t) return "table";
    const rows = t.totalRows === "many" ? "many" : (t.totalRows ?? t.rows.length).toLocaleString("en-US");
    return `${rows}×${(t.totalColumns ?? t.columns.length).toLocaleString("en-US")}`;
  }
  if (o.kind === "image") return "image";
  if (interactive(o)) return "interactive";
  if (o.kind === "chart") return "chart";
  if (o.widgets?.length && (o.kind === "widgets" || !o.text.trim())) return plural(o.widgets.length, "input");
  return "";
}

/** The one badge at the end of a cell's outline line: what needs attention first, else the output's shape. */
export function cellBadge(nb: NotebookState, cell: Cell, now: number, theme: FrameTheme): string {
  if (cell.status === "running") return theme.fg("accent", cell.runningSince ? elapsed(now - cell.runningSince) : "running");
  if (cell.status === "queued") return theme.fg("muted", "queued");
  if (cell.error) return theme.fg("error", /^([A-Za-z_][\w.]*)(?::|$)/u.exec(cell.error)?.[1] ?? "error");
  if (cell.blocked) return theme.fg("error", "blocked");
  if (cell.stale) return theme.fg("warning", "stale");
  if (nb.edited(cell)) return theme.fg("warning", "edited");
  const change = nb.agentChanges.get(cell.id);
  if (change && change.kind !== "deleted") return theme.fg("accent", change.kind === "created" ? "new" : "changed");
  return theme.fg("dim", outputShape(cell));
}
