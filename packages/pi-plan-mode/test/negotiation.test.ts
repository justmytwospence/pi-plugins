import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createNegotiation,
  finishReview,
  outstanding,
  parseReviewDecision,
  recoverNegotiation,
  restoreNegotiation,
  startReview,
  validateResponses,
} from "../src/negotiation.js";

const accepted = { outcome: "accepted", summary: "Meets approved plan.", evidence: [], limitations: [], findings: [] };
const findings = [{ id: "F1", title: "Fix", detail: "Broken", requestedChange: "Correct it" }];
const changes = parseReviewDecision(JSON.stringify({ ...accepted, outcome: "changes_requested", findings }));
const report = { report: "Changed.", verification: "Passed.", concerns: "None" };
test("strict object and single json fence only, bounded output and valid contradictions", () => {
  assert.equal(parseReviewDecision(JSON.stringify(accepted)).outcome, "accepted");
  assert.equal(parseReviewDecision("```json\n" + JSON.stringify(accepted) + "\n```").outcome, "accepted");
  for (const reply of [
    "Verdict: done",
    "[]",
    "null",
    "prefix " + JSON.stringify(accepted),
    "```json\n" + JSON.stringify(accepted) + "\n```\nprose",
    JSON.stringify({ ...accepted, outcome: "Accepted" }),
    JSON.stringify({ ...accepted, outcome: ["accepted"] }),
    JSON.stringify({ ...accepted, summary: " " }),
    JSON.stringify({ ...accepted, findings }),
    JSON.stringify({ ...accepted, outcome: "changes_requested" }),
    JSON.stringify({ ...accepted, outcome: "user_needed" }),
    JSON.stringify({ ...accepted, evidence: [""] }),
    " ".repeat(65537),
  ])
    assert.throws(() => parseReviewDecision(reply), reply.slice(0, 80));
  assert.throws(() =>
    parseReviewDecision(
      JSON.stringify({ ...accepted, outcome: "changes_requested", findings: [...findings, ...findings] }),
    ),
  );
  assert.throws(() =>
    parseReviewDecision(
      JSON.stringify({
        ...accepted,
        outcome: "changes_requested",
        findings: Array.from({ length: 31 }, (_, i) => ({ ...findings[0], id: String(i) })),
      }),
    ),
  );
  assert.equal(
    parseReviewDecision(
      JSON.stringify({ ...accepted, outcome: "user_needed", question: "Check?", recommendation: "Verify manually." }),
    ).question,
    "Check?",
  );
});
test("responses cover every finding exactly once without duplicates or unknown IDs", () => {
  const response = { id: "F1", status: "disputed", response: "Evidence disproves this." };
  assert.equal(validateResponses([response], findings).length, 1);
  for (const value of [
    undefined,
    [],
    [response, response],
    [{ ...response, id: "unknown" }],
    [{ ...response, status: "done" }],
    [{ ...response, status: ["addressed"] }],
    [{ ...response, response: " " }],
  ])
    assert.throws(() => validateResponses(value, findings));
});
test("default two fix cycles allow three reviews, failure consumes no revision and extension is explicit", () => {
  let n = createNegotiation("exec", 2);
  for (let round = 1; round <= 3; round++)
    n = finishReview(startReview(n, report, []), { decision: changes, costUsd: 0.1 });
  assert.equal(n.phase, "paused");
  assert.equal(n.revisionsUsed, 2);
  assert.equal(n.attempts, 3);
  assert.throws(() => startReview(n, report, []));
  n = recoverNegotiation(n, "resume");
  n = finishReview(startReview(n, report, []), { decision: changes, costUsd: 0.1 });
  assert.equal(n.phase, "paused");
  assert.equal(n.revisionsUsed, 3);
  assert.equal(n.history.length, 4);
  const failed = finishReview(startReview(createNegotiation("failure", 2), report, []), {
    error: "Invalid response",
    costUsd: 0.2,
  });
  assert.equal(failed.revisionsUsed, 0);
  assert.equal(failed.phase, "paused");
  const retried = finishReview(startReview(recoverNegotiation(failed, "retry"), report, []), {
    decision: parseReviewDecision(JSON.stringify(accepted)),
    costUsd: 0.1,
  });
  assert.equal(retried.reviewCostUsd, 0.30000000000000004);
  assert.equal(retried.attempts, 2);
});
test("zero/max revision settings and persisted record validation", () => {
  const n = finishReview(startReview(createNegotiation("zero", 0), report, []), { decision: changes, costUsd: 0 });
  assert.equal(n.phase, "paused");
  assert.equal(n.attempts, 1);
  assert.equal(createNegotiation("max", 5).maxRevisions, 5);
  assert.deepEqual(restoreNegotiation(n), n);
  for (const invalid of [
    { ...n, attempts: NaN },
    { ...n, maxRevisions: 6 },
    { ...n, reviewCostUsd: Infinity },
    { ...n, history: [] },
    { ...n, revisionsUsed: -1 },
    { ...n, phase: ["paused"] },
    { ...n, pause: { reason: ["failure"], action: "Retry" } },
    { ...n, reviewCostUsd: 1 },
  ])
    assert.equal(restoreNegotiation(invalid), undefined);
});

test("attempt records do not share mutable external decisions, reports or responses", () => {
  const input = { ...report };
  const response = [{ id: "F1", status: "addressed" as const, response: "Fixed." }];
  const d = structuredClone(changes);
  const initial = createNegotiation("immutable", 2);
  const reviewing = startReview(initial, input, response);
  const result = finishReview(reviewing, { decision: d, costUsd: 0.1 });
  d.findings[0].title = "Rewritten";
  input.report = "Rewritten";
  response[0].response = "Rewritten";
  assert.equal(result.history[0].decision?.findings[0].title, "Fix");
  assert.equal(result.history[0].report.report, "Changed.");
  assert.equal(result.history[0].responses[0].response, "Fixed.");
  assert.equal(initial.history.length, 0);
  assert.equal(reviewing.history[0].decision, undefined);
});

test("human-needed interlude cannot erase outstanding changes or forbid retained IDs", () => {
  let n = finishReview(startReview(createNegotiation("mixed", 2), report, []), { decision: changes, costUsd: 0 });
  const human = parseReviewDecision(
    JSON.stringify({ ...accepted, outcome: "user_needed", question: "Permission?", recommendation: "Ask user." }),
  );
  n = finishReview(startReview(n, report, [{ id: "F1", status: "blocked", response: "Need permission." }]), {
    decision: human,
    costUsd: 0,
  });
  n = recoverNegotiation(n, "resume");
  assert.throws(() => validateResponses([], outstanding(n)));
  n = finishReview(startReview(n, report, [{ id: "F1", status: "addressed", response: "Permission granted." }]), {
    decision: changes,
    costUsd: 0,
  });
  assert.equal(n.phase, "revising");
  assert.equal(n.history.at(-1)?.error, undefined);
});
