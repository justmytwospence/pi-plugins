// Shared verbatim by pi-herdr and opencode-herdr (src/core).
//
// The space token `pr`: the pull request for the checkout's branch, from `gh pr view`, so each
// worktree's space in herdr's sidebar says where its PR stands ("#123 ✓ approved"). Refreshed on
// a timer and after each turn (pushes happen in turns); cleared when the branch has no PR.

export interface PrView {
  number: number;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: { status?: string; conclusion?: string | null; state?: string }[];
}

/** ✓ every check passed, ✗ one failed, … some still run; undefined without checks. */
export function checksMark(rollup: PrView["statusCheckRollup"]): string | undefined {
  if (!rollup?.length) return undefined;
  let pending = false;
  for (const c of rollup) {
    // CheckRun: status + conclusion; StatusContext: state.
    const result = (c.conclusion ?? c.state ?? "").toUpperCase();
    const status = (c.status ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result)) return "✗";
    if ((status && status !== "COMPLETED") || result === "PENDING" || result === "EXPECTED" || (!result && !status)) pending = true;
  }
  return pending ? "…" : "✓";
}

export function prToken(pr: PrView | undefined): string | undefined {
  if (!pr?.number) return undefined;
  const parts = [`#${pr.number}`];
  const state = (pr.state ?? "").toUpperCase();
  if (state === "MERGED") return `${parts[0]} merged`;
  if (state === "CLOSED") return `${parts[0]} closed`;
  if (pr.isDraft) parts.push("draft");
  const checks = checksMark(pr.statusCheckRollup);
  if (checks) parts.push(checks);
  const review = (pr.reviewDecision ?? "").toUpperCase();
  if (review === "APPROVED") parts.push("approved");
  else if (review === "CHANGES_REQUESTED") parts.push("changes");
  else if (review === "REVIEW_REQUIRED") parts.push("review");
  return parts.join(" ");
}

export function parsePrView(stdout: string): PrView | undefined {
  try {
    const v = JSON.parse(stdout);
    return typeof v?.number === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

export const PR_FIELDS = "number,state,isDraft,reviewDecision,statusCheckRollup";
