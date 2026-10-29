// The notebook view's keys (`?`), grouped as the README lists them.
import type { FrameTheme } from "../frame.ts";

const GROUPS: Array<[string, string[]]> = [
  ["Move", ["j/k ↑/↓ cell · [ ] section · g/G first/last · ^U/^D PgUp/PgDn space scroll the detail · f follow the running cell"]],
  ["Look", [
    "enter/l a cell's code · O the whole section, or the cell · z fold section · Z fold all",
    "n/N next/previous error · c/C next/previous agent change · d diff of an agent change · < > upstream/downstream cell",
    "/ filter · v variables · i drive an expanded live chart",
  ]],
  ["Act", [
    "r run cell · R run stale (twice) · A run all (twice) · x interrupt (twice) · w drive widgets",
    ": python in the kernel · a ask the agent · m mark for the agent (Lens) · M remove a mark (twice)",
    "o open in the browser · S stop the server (twice)",
  ]],
  ["Notebooks", ["tab/shift+tab next/previous · | dock beside the chat, or full screen again · esc, q, h back to Pi"]],
  ["Docked", ["ctrl+' dock or close the active notebook · ctrl+] (or Herdr prefix+h/l) chat ⇄ notebook · esc back to the chat · q close · drag the divider to resize · click a side to focus it"]],
  ["Widgets", ["j/k next/previous · h/l change (H/L ×10) · space toggle or press · enter type a value · esc done"]],
  ["Variables", ["j/k move · enter its cell · > first cell that uses it · / filter · v or esc back"]],
  ["Mouse", ["wheel scrolls the pane under it · click selects · double-click opens the code"]],
];

export function helpLines(theme: FrameTheme, where?: string): string[] {
  const out = [...(where ? [theme.fg("dim", where), ""] : []), theme.bold(theme.fg("accent", "Notebook view keys")), ""];
  for (const [label, lines] of GROUPS) {
    lines.forEach((line, i) => out.push(`${i === 0 ? theme.bold(label.padEnd(11)) : " ".repeat(11)}${line}`));
  }
  return out;
}
