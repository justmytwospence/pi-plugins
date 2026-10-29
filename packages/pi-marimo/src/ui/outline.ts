// The outline: the notebook's left pane. The headings, and one short line per code cell: its status,
// a human title (titles.ts), the Lens marks on it, and one badge at the end. The selected line has an
// accent bar and Pi's selection background. What a cell holds is in the detail pane (detail.ts).
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Cell, NotebookState } from "../core/notebook.js";
import { truncate } from "../core/notebook.js";
import type { FrameTheme } from "../frame.ts";
import { type Row, firstLine, foldedCells, selectableCells } from "./rows.js";
import { cellBadge, cellTitle } from "./titles.js";

/** Pi's theme has `bg`; a plain one (tests, other hosts) may not. */
export type PaneTheme = FrameTheme & { bg?(color: string, text: string): string };

export interface OutlineOptions {
  cursor?: string | undefined;
  folded: ReadonlySet<string>;
  filter: string;
  /** The width the outline draws at. */
  width: number;
}

export const headingText = (theme: FrameTheme, h: { level: number; text: string }): string =>
  h.level === 1 ? theme.bold(theme.fg("accent", h.text)) : h.level === 2 ? theme.bold(h.text) : theme.fg("muted", h.text);

/** The glyph at the start of a code cell's line. */
/** A spinner frame for `now` (ms): what is running turns. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (now: number): string => SPINNER[Math.floor(now / 100) % SPINNER.length]!;

export function cellGlyph(nb: NotebookState, theme: FrameTheme, c: Cell, now = Date.now()): string {
  return c.status === "running"
    ? theme.fg("accent", spinner(now))
    : c.error || c.blocked
      ? theme.fg("error", "✗")
      : c.status === "queued"
        ? theme.fg("muted", "◌")
        : c.stale || nb.edited(c)
          ? theme.fg("warning", "•")
          : " ";
}

/** The notebook as outline rows, in notebook order. */
export function outlineRows(nb: NotebookState, theme: PaneTheme, now: number, o: OutlineOptions): { rows: Row[]; cellRows: Map<string, number>; running?: number } {
  const filtering = !!o.filter.trim();
  const width = Math.max(8, o.width);
  const hidden = filtering ? new Map<string, string>() : foldedCells(nb, o.folded);
  const shown = new Set(selectableCells(nb, o.filter, { folded: o.folded }).map((c) => c.id));
  const rows: Row[] = [];
  const cellRows = new Map<string, number>();
  let running: number | undefined;
  let underHeading = false;
  const marks = new Map<string, string[]>();
  for (const s of nb.lens.selections()) for (const id of s.cells) marks.set(id, [...marks.get(id) ?? [], s.label]);
  // What each fold hides.
  const inFold = new Map<string, Cell[]>();
  for (const [id, head] of hidden) { const c = nb.cells.get(id); if (c) inFold.set(head, [...inFold.get(head) ?? [], c]); }
  const foldSummary = (head: string): string => {
    if (filtering || !o.folded.has(head)) return "";
    const inside = (inFold.get(head) ?? []).filter((c) => !nb.isMarkdown(c));
    const busy = inside.some((c) => c.status === "running");
    const errors = inside.filter((c) => c.error).length;
    return `  ${theme.fg("dim", "▸")} ${theme.fg("dim", `${inside.length} cell${inside.length === 1 ? "" : "s"}`)}${busy ? `${theme.fg("dim", " · ")}${theme.fg("accent", "running")}` : ""}${errors ? `${theme.fg("dim", " · ")}${theme.fg("error", `${errors} error${errors === 1 ? "" : "s"}`)}` : ""}`;
  };
  const bar = (here: boolean) => (here ? theme.fg("accent", "▌") : " ");
  /** A finished row: cut to the width, and on the selected one the selection background. */
  const finish = (text: string, here: boolean): string => {
    if (!here) return truncateToWidth(text, width, "…");
    const padded = truncateToWidth(text, width, "…", true);
    return theme.bg ? theme.bg("selectedBg", padded) : padded;
  };
  const headingRows = (cell: Cell, here: boolean, withId: boolean) => {
    nb.headings(cell).forEach((h, i) => {
      underHeading = true;
      const text = `${bar(here && i === 0)} ${"  ".repeat(Math.max(0, h.level - 1))}${headingText(theme, h)}${i === 0 ? foldSummary(cell.id) : ""}`;
      if (withId && i === 0) cellRows.set(cell.id, rows.length);
      rows.push({ text: finish(text, here && i === 0), ...(withId && i === 0 ? { cell: cell.id } : {}) });
    });
  };
  for (const cell of nb.ordered()) {
    if (hidden.has(cell.id)) continue;
    const here = o.cursor === cell.id;
    if (nb.isMarkdown(cell)) {
      if (!shown.has(cell.id) || !nb.headings(cell).length) continue;
      headingRows(cell, here, true);
      continue;
    }
    if (!filtering) headingRows(cell, false, false);
    if (!shown.has(cell.id)) continue;
    const marked = marks.get(cell.id);
    const tags = marked ? ` ${theme.fg("warning", marked.join(" "))}` : "";
    const title = cellTitle(nb, cell);
    const left = `${bar(here)}${underHeading ? "  " : ""}${cellGlyph(nb, theme, cell, now)} ${here ? theme.bold(title) : title}${tags}`;
    const badge = cellBadge(nb, cell, now, theme);
    const badgeWidth = visibleWidth(badge);
    const cut = truncateToWidth(left, Math.max(1, width - badgeWidth - (badgeWidth ? 1 : 0)), "…");
    const gap = Math.max(badgeWidth ? 1 : 0, width - visibleWidth(cut) - badgeWidth);
    if (cell.status === "running") running = rows.length;
    cellRows.set(cell.id, rows.length);
    rows.push({ cell: cell.id, text: finish(`${cut}${" ".repeat(gap)}${badge}`, here) });
  }
  const removed = [...nb.agentChanges].filter(([, c]) => c.kind === "deleted");
  if (removed.length && !filtering) {
    rows.push({ text: "" });
    for (const [, c] of removed) {
      const what = c.name && c.name !== "_" ? c.name : truncate(firstLine(c.before) || "(empty)", 40);
      rows.push({ text: truncateToWidth(`  ${theme.fg("dim", `✗ Removed: ${what}`)}`, width, "…") });
    }
  }
  return { rows, cellRows, ...(running !== undefined ? { running } : {}) };
}

/** The outline as display lines (for tests and anything that wants text). */
export function notebookLines(nb: NotebookState, theme: PaneTheme, now: number, o: Partial<OutlineOptions> = {}): { lines: string[]; running?: number } {
  const { rows, running } = outlineRows(nb, theme, now, { folded: new Set(), filter: "", width: 100, ...o });
  return { lines: rows.map((r) => r.text), ...(running !== undefined ? { running } : {}) };
}
