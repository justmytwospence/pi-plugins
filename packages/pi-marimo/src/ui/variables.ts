// The notebook's variables as a pane of the view (`v`), like marimo's variables panel: each name,
// its type and value, the cell that defines it and how many cells use it.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NotebookState } from "../core/notebook.js";
import type { FrameTheme } from "../frame.ts";
import type { Row } from "./rows.js";
import { cellTitle } from "./titles.js";

export interface VariableRow {
  name: string;
  datatype: string;
  value: string;
  definedBy?: string;
  usedBy: string[];
}

/** Every variable the notebook defines, in the order of the cells that define them, then by name. */
export function variableList(nb: NotebookState, filter = ""): VariableRow[] {
  const q = filter.trim().toLowerCase();
  const index = new Map(nb.order.map((id, i) => [id, i]));
  return [...nb.declaredBy]
    .map(([name, cells]) => {
      const v = nb.values.get(name);
      return { name, datatype: v?.datatype ?? "", value: (v?.value ?? "").replace(/\s+/gu, " "), ...(cells[0] ? { definedBy: cells[0] } : {}), usedBy: nb.usedBy.get(name) ?? [] };
    })
    .filter((v) => !q || [v.name, v.datatype, v.value].some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => (index.get(a.definedBy ?? "") ?? Infinity) - (index.get(b.definedBy ?? "") ?? Infinity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const fit = (text: string, width: number): string => {
  const cut = truncateToWidth(text, width, "…");
  return `${cut}${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
};

/** The pane's rows, the cursor's variable marked; `width` is the content width. */
export function variableRows(list: VariableRow[], nb: NotebookState, theme: FrameTheme, cursor: string | undefined, width: number, filter = ""): { rows: Row[]; index: Map<string, number> } {
  const index = new Map<string, number>();
  if (!list.length) return { rows: [{ text: theme.fg("dim", filter.trim() ? `No variable matches "${filter}".` : "No variables yet: run cells first.") }], index };
  const valueWidth = Math.max(10, width - 66);
  const rows = list.map((v, i): Row => {
    index.set(v.name, i);
    const here = v.name === cursor;
    const from = v.definedBy ? nb.cells.get(v.definedBy) : undefined;
    const where = from ? cellTitle(nb, from) : "?";
    const uses = v.usedBy.length ? theme.fg("dim", ` · ${v.usedBy.length} use${v.usedBy.length === 1 ? "" : "s"}`) : "";
    return { variable: v.name, text: `${here ? theme.fg("accent", "●") : " "} ${here ? theme.bold(fit(v.name, 20)) : fit(v.name, 20)} ${theme.fg("dim", fit(v.datatype, 14))} ${fit(v.value, valueWidth)} ${theme.fg("dim", `← ${where}`)}${uses}` };
  });
  return { rows, index };
}
