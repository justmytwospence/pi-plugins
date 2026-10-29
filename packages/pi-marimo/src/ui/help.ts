// The notebook view's keys (`?`), grouped as the README lists them.
import type { FrameTheme } from "../frame.ts";

const GROUPS: Array<[string, string[]]> = [
  ["Move", ["j/k ↑/↓ cell · [ ] section · g/G first/last · ^U/^D PgUp/PgDn space scroll · f follow the running cell"]],
  ["Look", [
    "enter/l expand: code, dataflow, console, output · O every cell's output · z fold section · Z fold all",
    "n/N next/previous error · c/C next/previous agent change · d diff of an agent change · < > upstream/downstream cell",
    "/ filter · v variables · i drive an expanded live chart",
  ]],
  ["Act", [
    "r run cell · R run stale (twice) · A run all (twice) · x interrupt (twice) · w drive widgets",
    ": python in the kernel · a ask the agent · m mark for the agent (Lens) · M remove a mark (twice)",
    "o open in the browser · S stop the server (twice)",
  ]],
  ["Notebooks", ["tab/shift+tab next/previous · esc, q, h back to Pi"]],
  ["Widgets", ["j/k next/previous · h/l change (H/L ×10) · space toggle or press · enter type a value · esc done"]],
  ["Variables", ["j/k move · enter its cell · > first cell that uses it · / filter · v or esc back"]],
  ["Mouse", ["wheel scrolls · click selects · double-click expands"]],
];

export function helpLines(theme: FrameTheme): string[] {
  const out = [theme.bold(theme.fg("accent", "Notebook view keys")), ""];
  for (const [label, lines] of GROUPS) {
    lines.forEach((line, i) => out.push(`${i === 0 ? theme.bold(label.padEnd(11)) : " ".repeat(11)}${line}`));
  }
  return out;
}
