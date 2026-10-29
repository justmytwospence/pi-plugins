// The notebook view's keys (`?`), grouped as the README lists them.
import type { FrameTheme } from "../frame.ts";

const GROUPS: Array<[string, string[]]> = [
  ["Move", ["j/k ↑/↓ cell · ctrl+j/ctrl+k (or ] [) section · n/p parts of the cell · g/G first/last · ^U/^D PgUp/PgDn space scroll the detail · f follow the running cell"]],
  ["Look", [
    "enter acts on the part (or code; markdown: edit) · t table · O the whole section, or the cell · tab (z) fold the section · shift+tab (Z) fold all, again unfold all",
    "e/E next/previous error · c/C next/previous agent change · d diff of an agent change · < > upstream/downstream cell",
    "/ find a cell (enter goes there, esc goes back) · v variables · i drive an expanded live chart",
  ]],
  ["Act", [
    "r run cell · R run stale (twice) · A run all (twice) · x interrupt (twice) · w drive widgets",
    ": python in the kernel · a ask the agent · m mark for the agent (Lens) · M remove a mark (twice)",
    "o open in the browser · S stop the server (twice)",
  ]],
  ["Notebooks", ["} { next/previous · | dock beside the chat, or full screen again · esc, q, h back to Pi"]],
  ["Docked", ["ctrl+' dock or close the active notebook · ctrl+] (or Herdr prefix+h/l) chat ⇄ notebook · esc back to the chat · q close · drag the divider to resize · click a side to focus it"]],
  ["Widgets", ["j/k next/previous · h/l change (H/L ×10) · space toggle or press · enter type a value · esc done"]],
  ["Tables", ["hjkl move · [ ] page · g/G first/last page · +/- page size · s sort (S add) · / search · f filter (F clear) · space select · enter row · i column · c summaries · y/Y copy cell/row · D save csv · r refresh · esc done"]],
  ["Markdown", ["enter edits a markdown cell in the editor (pi-vim when loaded) · saved through marimo, re-rendered at once"]],
  ["Variables", ["j/k move · enter its cell · > first cell that uses it · / find a variable (enter goes there, esc goes back) · v or esc back"]],
  ["Mouse", ["wheel scrolls the pane under it · click selects · double-click opens the code"]],
];

export function helpLines(theme: FrameTheme, where?: string): string[] {
  const out = [...(where ? [theme.fg("dim", where), ""] : []), theme.bold(theme.fg("accent", "Notebook view keys")), ""];
  for (const [label, lines] of GROUPS) {
    lines.forEach((line, i) => out.push(`${i === 0 ? theme.bold(label.padEnd(11)) : " ".repeat(11)}${line}`));
  }
  return out;
}
