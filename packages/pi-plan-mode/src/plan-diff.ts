// What changed between the plan the user declined and the revision shown for review: changed lines
// only, by a line LCS (plans are short), with `…` where unchanged lines were skipped.
import type { Theme } from "@earendil-works/pi-coding-agent";

export type DiffLine = { kind: "added" | "removed" | "gap"; text: string };

/** Changed lines between `before` and `after`, in order, with a gap marker between separate runs. */
export function planDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // lcs[i][j]: longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let skipped = false;
  const push = (line: DiffLine) => {
    if (skipped && out.length > 0) out.push({ kind: "gap", text: "…" });
    skipped = false;
    out.push(line);
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      skipped = true;
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      push({ kind: "removed", text: a[i++]! });
    } else {
      push({ kind: "added", text: b[j++]! });
    }
  }
  return out;
}

/** The diff as themed terminal lines (unwrapped; the caller's Text wraps them). */
export function renderPlanDiff(theme: Theme, lines: DiffLine[]): string {
  return lines
    .map((line) =>
      line.kind === "gap"
        ? theme.fg("dim", "  …")
        : line.kind === "added"
          ? theme.fg("toolDiffAdded", `+ ${line.text}`)
          : theme.fg("toolDiffRemoved", `- ${line.text}`),
    )
    .join("\n");
}
