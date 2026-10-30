/** Bounded completion protocol. No prose, edits or missing evidence imply acceptance. */
export interface Finding {
  id: string;
  title: string;
  detail: string;
  requestedChange: string;
}
export interface ReviewDecision {
  outcome: "accepted" | "changes_requested" | "user_needed";
  summary: string;
  evidence: string[];
  limitations: string[];
  findings: Finding[];
  question?: string;
  recommendation?: string;
}
export interface FindingResponse {
  id: string;
  status: "addressed" | "disputed" | "blocked";
  response: string;
}
export interface Submission {
  report: string;
  verification: string;
  concerns: string;
}
export interface ReviewAttempt {
  id: string;
  report: Submission;
  responses: FindingResponse[];
  decision?: ReviewDecision;
  error?: string;
  costUsd: number;
}
export interface NegotiationState {
  version: 1;
  executionId: string;
  phase: "implementing" | "consulting" | "reviewing" | "revising" | "paused";
  attempts: number;
  revisionsUsed: number;
  maxRevisions: number;
  reviewCostUsd: number;
  latestExchangeId?: string;
  latestReport?: Submission;
  history: ReviewAttempt[];
  pause?: { reason: "failure" | "interrupted" | "user_needed" | "exhausted"; action: string; question?: string };
  revisionAuthorized: boolean;
  userAnswers?: string[];
}
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const enumValue = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(nonempty);
const fail = (message: string): never => {
  throw new Error(message);
};
export function revisionLimit(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 2;
}
export function createNegotiation(executionId: string, maximum: number): NegotiationState {
  return {
    version: 1,
    executionId,
    phase: "implementing",
    attempts: 0,
    revisionsUsed: 0,
    maxRevisions: revisionLimit(maximum),
    reviewCostUsd: 0,
    history: [],
    revisionAuthorized: false,
  };
}
export function parseReviewDecision(reply: string): ReviewDecision {
  if (new TextEncoder().encode(reply).length > 64 * 1024) fail("Review exceeds 64 KiB.");
  const source = reply.trim();
  const fence = /^```json\s*\n([\s\S]*?)\n```$/u.exec(source);
  let v: unknown;
  try {
    v = JSON.parse(fence ? fence[1] : source);
  } catch {
    fail("Review must be one JSON object or a single json fence, without surrounding prose.");
  }
  if (!object(v)) return fail("Review must be an object.");
  if (!enumValue(v.outcome, ["accepted", "changes_requested", "user_needed"])) fail("Invalid review outcome.");
  if (!nonempty(v.summary) || !strings(v.evidence) || !strings(v.limitations))
    fail("Review needs summary, evidence and limitations arrays.");
  if (!Array.isArray(v.findings) || v.findings.length > 30) fail("Review needs at most 30 findings.");
  const ids = new Set<string>();
  for (const f of v.findings as unknown[]) {
    if (!object(f) || ![f.id, f.title, f.detail, f.requestedChange].every(nonempty))
      fail("Finding fields must be nonempty.");
    const id = (f as Finding).id.trim();
    if (id !== (f as Finding).id) fail("Finding IDs cannot have surrounding whitespace.");
    if (ids.has(id)) fail("Duplicate finding ID.");
    ids.add(id);
  }
  if (v.outcome === "accepted" && (v.findings as unknown[]).length) fail("Accepted review cannot have findings.");
  if (v.outcome === "changes_requested" && !(v.findings as unknown[]).length)
    fail("Changes requested requires findings.");
  if (v.outcome === "user_needed" && (!nonempty(v.question) || !nonempty(v.recommendation)))
    fail("User-needed review requires a question and recommendation.");
  return structuredClone(v) as unknown as ReviewDecision;
}
export function outstanding(state: NegotiationState): Finding[] {
  for (const attempt of [...state.history].reverse()) {
    if (attempt.decision?.outcome === "accepted") return [];
    if (attempt.decision?.outcome === "changes_requested") return attempt.decision.findings;
  }
  return [];
}
export function validateResponses(value: unknown, findings: Finding[]): FindingResponse[] {
  if (value === undefined && findings.length === 0) return [];
  if (!Array.isArray(value)) return fail("Provide responses for every outstanding finding.");
  const expected = new Set(findings.map((f) => f.id));
  const seen = new Set<string>();
  for (const v of value) {
    if (
      !object(v) ||
      !nonempty(v.id) ||
      !nonempty(v.response) ||
      !enumValue(v.status, ["addressed", "disputed", "blocked"])
    )
      fail("Invalid finding response.");
    const id = v.id as string;
    if (!expected.has(id) || seen.has(id)) fail("Unknown or duplicate finding response ID.");
    seen.add(id);
  }
  if (seen.size !== expected.size) fail("Respond to every outstanding finding exactly once.");
  return structuredClone(value) as FindingResponse[];
}
export function startReview(
  state: NegotiationState,
  report: Submission,
  responses: FindingResponse[],
): NegotiationState {
  if (state.phase === "paused" || state.phase === "reviewing" || state.phase === "consulting")
    fail("Review is not authorized in this phase.");
  const next = structuredClone(state);
  next.phase = "reviewing";
  next.revisionAuthorized = false;
  next.attempts++;
  next.latestExchangeId = `${next.executionId}:review:${next.attempts}`;
  next.latestReport = structuredClone(report);
  next.history.push({
    id: next.latestExchangeId,
    report: structuredClone(report),
    responses: structuredClone(responses),
    costUsd: 0,
  });
  return next;
}
export function finishReview(
  state: NegotiationState,
  result: { decision?: ReviewDecision; error?: string; costUsd: number },
): NegotiationState {
  if (state.phase !== "reviewing") fail("No review in progress.");
  const next = structuredClone(state);
  const attempt = next.history.at(-1)!;
  attempt.costUsd = Number.isFinite(result.costUsd) && result.costUsd >= 0 ? result.costUsd : 0;
  next.reviewCostUsd += attempt.costUsd;
  attempt.decision = result.decision ? structuredClone(result.decision) : undefined;
  attempt.error = result.error;
  const decision = result.decision;
  if (decision) {
    const retained = new Set(outstanding(state).map((f) => f.id));
    // The in-progress attempt has no decision; outstanding() therefore reads the preceding round.
    const used = new Set(state.history.flatMap((a) => a.decision?.findings.map((f) => f.id) ?? []));
    if (decision.findings.some((f) => used.has(f.id) && !retained.has(f.id))) {
      attempt.decision = undefined;
      attempt.error = "Review reused a previously resolved finding ID; new findings require fresh IDs.";
      next.phase = "paused";
      next.pause = { reason: "failure", action: attempt.error };
      return next;
    }
  }
  if (!decision) next.pause = { reason: "failure", action: result.error || "Review failed." };
  else if (decision.outcome === "user_needed")
    next.pause = { reason: "user_needed", action: decision.recommendation!, question: decision.question };
  else if (decision.outcome === "changes_requested") {
    if (next.revisionsUsed < next.maxRevisions || next.revisionAuthorized) {
      next.revisionsUsed++;
      next.revisionAuthorized = false;
      next.phase = "revising";
      return next;
    }
    next.pause = { reason: "exhausted", action: "Automatic revision budget exhausted." };
  }
  next.phase = next.pause ? "paused" : "implementing";
  return next;
}
export function recoverNegotiation(state: NegotiationState, action: "retry" | "resume"): NegotiationState {
  if (state.phase !== "paused" || !state.pause) fail("Execution is not paused.");
  const failure = ["failure", "interrupted"].includes(state.pause!.reason);
  if ((action === "retry") !== failure) fail("This recovery action is not available for the current pause.");
  const next = structuredClone(state);
  if (action === "resume" && state.pause!.reason === "exhausted") {
    next.revisionsUsed++;
    next.revisionAuthorized = true;
  }
  next.phase = action === "retry" ? "implementing" : "revising";
  next.pause = undefined;
  return next;
}
/** Reject corrupt versioned records instead of silently resetting a spent budget. */
export function restoreNegotiation(value: unknown): NegotiationState | undefined {
  if (!object(value) || value.version !== 1 || !nonempty(value.executionId)) return undefined;
  if (!enumValue(value.phase, ["implementing", "consulting", "reviewing", "revising", "paused"])) return undefined;
  for (const key of ["attempts", "revisionsUsed", "maxRevisions"])
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) return undefined;
  if (
    (value.maxRevisions as number) > 5 ||
    typeof value.reviewCostUsd !== "number" ||
    !Number.isFinite(value.reviewCostUsd) ||
    value.reviewCostUsd < 0 ||
    typeof value.revisionAuthorized !== "boolean" ||
    !Array.isArray(value.history) ||
    value.history.length !== value.attempts
  )
    return undefined;
  if (value.userAnswers !== undefined && !strings(value.userAnswers)) return undefined;
  if (
    value.latestReport !== undefined &&
    (!object(value.latestReport) ||
      ![value.latestReport.report, value.latestReport.verification, value.latestReport.concerns].every(nonempty))
  )
    return undefined;
  if (value.latestExchangeId !== undefined && !nonempty(value.latestExchangeId)) return undefined;
  try {
    if (value.phase === "reviewing" && (value.attempts === 0 || !value.latestReport)) return undefined;
    const attemptIds = new Set<string>();
    let cost = 0;
    for (const a of value.history) {
      if (
        !object(a) ||
        !nonempty(a.id) ||
        !object(a.report) ||
        ![a.report.report, a.report.verification, a.report.concerns].every(nonempty) ||
        !Array.isArray(a.responses) ||
        typeof a.costUsd !== "number" ||
        !Number.isFinite(a.costUsd) ||
        a.costUsd < 0
      )
        return undefined;
      if (attemptIds.has(a.id as string)) return undefined;
      attemptIds.add(a.id as string);
      cost += a.costUsd as number;
      if (a.decision) parseReviewDecision(JSON.stringify(a.decision));
      for (const r of a.responses)
        if (
          !object(r) ||
          !nonempty(r.id) ||
          !nonempty(r.response) ||
          !enumValue(r.status, ["addressed", "disputed", "blocked"])
        )
          return undefined;
    }
    if (
      value.phase === "paused" &&
      (!object(value.pause) ||
        !enumValue(value.pause.reason, ["failure", "interrupted", "user_needed", "exhausted"]) ||
        !nonempty(value.pause.action))
    )
      return undefined;
    if (Math.abs(cost - value.reviewCostUsd) > 1e-8) return undefined;
    return structuredClone(value) as unknown as NegotiationState;
  } catch {
    return undefined;
  }
}
