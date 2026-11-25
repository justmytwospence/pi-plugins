// The review step of /ship: one reviewer per lens, their findings parsed, de-duplicated and each
// checked against its diff hunk by a typed System 1 judgment before the user sees it.
import { bool, type ClassifierQuestion, type System1Outcome } from "./system1.ts";

export const LENSES = {
  correctness: "logic errors, edge cases, regressions, broken contracts",
  security: "secrets, injection, unsafe shell or file handling, permission changes",
  tests: "changed behavior without tests, tests that cannot fail",
  docs: "README, docs or AGENTS.md left stale by the change",
} as const;
export type Lens = keyof typeof LENSES;

export interface Finding {
  path: string;
  line: number;
  severity: "blocking" | "minor";
  title: string;
  body: string;
  lens: string;
  /** System 1 could not judge it: shown anyway, marked. */
  unverified?: boolean;
}

export function lensTask(lens: Lens, root: string, base: string, head: string): string {
  return `Review the change \`git diff ${base}..${head}\` in ${root} for ${lens}: ${LENSES[lens]}. Follow this repository's AGENTS.md. Report only problems this diff introduces; do not change any files. Answer with exactly one \`\`\`json fenced block holding an array of {"path": string (repo-relative), "line": number (line in the new file), "severity": "blocking" | "minor", "title": string, "body": string}; an empty array when there is nothing.`;
}

/** The last ```json block of a reviewer's answer, validated field by field; `error` when it has none or is invalid. */
export function parseFindings(output: string, lens: string): { findings: Finding[]; error?: string } {
  const blocks = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return { findings: [], error: `${lens}: no json block in the answer` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { findings: [], error: `${lens}: the json block does not parse` };
  }
  if (!Array.isArray(parsed)) return { findings: [], error: `${lens}: the json block is not an array` };
  const findings: Finding[] = [];
  for (const item of parsed) {
    const f = item as Record<string, unknown> | null;
    if (!f || typeof f.path !== "string" || !f.path || !Number.isInteger(f.line) || (f.line as number) < 1 || typeof f.title !== "string" || typeof f.body !== "string") continue;
    findings.push({ path: f.path, line: f.line as number, severity: f.severity === "blocking" ? "blocking" : "minor", title: f.title, body: f.body, lens });
  }
  return { findings };
}

/** Same path and lines within 2 of each other is one finding: the first stays; blocking ones come first. */
export function dedupe(findings: Finding[]): Finding[] {
  const ordered = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
  const kept: Finding[] = [];
  for (const f of ordered) if (!kept.some((k) => k.path === f.path && Math.abs(k.line - f.line) <= 2)) kept.push(f);
  return kept;
}

const SUPPORTED: Record<string, ClassifierQuestion> = {
  supported: {
    type: "bool",
    instructions: "Is this finding a real problem that the diff hunk introduces, not a style preference or a misreading?",
    criteria: { true: "real problem introduced by this diff", false: "not supported by the hunk, pre-existing, or a matter of taste" },
  },
};

export type Ask = (state: Record<string, unknown>, questions: Record<string, ClassifierQuestion>) => Promise<System1Outcome>;

/** Keeps the findings System 1 supports at or above `threshold` (at most `max`, in order); unjudged ones stay, marked. */
export async function verify(findings: Finding[], hunkFor: (path: string) => Promise<string>, ask: Ask, threshold: number, max: number): Promise<Finding[]> {
  const kept: Finding[] = [];
  for (const f of findings.slice(0, max)) {
    const hunk = await hunkFor(f.path);
    const outcome = await ask({ finding: { path: f.path, line: f.line, title: f.title, body: f.body }, hunk }, SUPPORTED);
    if (!outcome.ok) {
      kept.push({ ...f, unverified: true });
      continue;
    }
    const p = bool(outcome.answers, "supported");
    if (p === undefined) kept.push({ ...f, unverified: true });
    else if (p >= threshold) kept.push(f);
  }
  return kept;
}
