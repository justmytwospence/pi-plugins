// Requests rated by live Jev through Pi's model registry, as an eval target (`npm run -s eval -- effort`,
// or `--package pi-auto-effort`). Each hand-written request has an expected depth (0 trivial, 1 routine,
// 2 multi-step, 3 hard); the rating is in band when its probability-weighted level index is within 0.9
// of that depth. Go-ahead requests must also be judged as go-aheads (ack above 0.7). The target passes
// when every answered request is in band and fewer than 20% of the Jev calls fail (the runner's limit).
import { defineEval, withinFailureLimit } from "../../../evals/shared/target.ts";
import { DEFAULT_CONFIG, QUESTIONS, effortState } from "../src/index.ts";
import { type JevOutcome, askJev, bool, choice } from "../src/jev.ts";
import { JUDGED_LEVELS } from "../src/policy.ts";

/** depth: 0 trivial (low), 1 routine (medium), 2 multi-step (high), 3 hard (xhigh). The expected
 * level index under Jev's choice probabilities within 0.9 of the label passes. */
export interface EffortCase {
  request: string;
  depth: number;
  ack?: boolean;
  previous?: string;
}

export const CASES: EffortCase[] = [
  { request: "what does `git stash pop` do?", depth: 0 },
  { request: "rename the variable `tmp` to `buffer` in src/io.ts", depth: 0 },
  { request: "bump the version in package.json to 1.2.0", depth: 0 },
  { request: "what's in the README?", depth: 0 },
  { request: "add a --verbose flag to the CLI that prints each request URL", depth: 1 },
  { request: "fix the typo in the error message for missing config files", depth: 0 },
  { request: "write a unit test for parseDuration covering '1h30m'", depth: 1 },
  { request: "add retries with exponential backoff to the HTTP client and test them", depth: 2 },
  { request: "the CI build fails with 'Cannot find module ./config' only on Linux; find out why and fix it", depth: 2 },
  { request: "add pagination to the /users endpoint, following how /orders does it", depth: 2 },
  { request: "we have an intermittent deadlock in the job scheduler under load; find the root cause", depth: 3 },
  { request: "redesign the sync engine so offline edits merge without data loss; plan it first", depth: 3 },
  { request: "migrate the whole codebase from callbacks to async/await without changing behavior", depth: 3 },
  { request: "prove the rate limiter can never let more than N requests through in any window, and fix it if it can", depth: 3 },
  { request: "yes go ahead", depth: 2, ack: true, previous: "Plan: refactor the cache into an LRU with TTL across 6 files. Shall I proceed?" },
  { request: "continue", depth: 2, ack: true, previous: "I've done 3 of 5 steps of the migration. Continue?" },
  { request: "do it", depth: 1, ack: true, previous: "I can add the missing import. Want me to?" },
  { request: "thanks!", depth: 0 },
  { request: "now also handle the case where the token expires mid-request, that's the tricky part", depth: 3, previous: "Added token refresh on startup." },
  { request: "show me the diff", depth: 0 },
];

/** The per-call timeout this eval always ran with (the extension's own is 1,500 ms). */
export const CASE_TIMEOUT_MS = 15_000;

/** The probability-weighted level index (0 low to 3 xhigh). */
export function expectedIndex(probabilities: Record<string, number>): number {
  let sum = 0;
  let total = 0;
  JUDGED_LEVELS.forEach((level, i) => {
    const p = probabilities[level] ?? 0;
    sum += i * p;
    total += p;
  });
  return total > 0 ? sum / total : -9;
}

interface Judged {
  c: EffortCase;
  outcome: JevOutcome;
  got?: string;
  expected?: number;
  ack: number;
  inBand: boolean;
}

function judge(c: EffortCase, outcome: JevOutcome): Judged {
  if (!outcome.ok) return { c, outcome, ack: 0, inBand: false };
  const depth = choice(outcome.answers, "depth");
  const expected = depth ? expectedIndex(depth.probabilities) : undefined;
  const ack = bool(outcome.answers, "ack") ?? 0;
  const ackOk = c.ack === undefined || (ack > 0.7) === c.ack;
  const depthOk = Boolean(c.ack) || Math.abs((expected ?? -9) - c.depth) <= 0.9;
  return { c, outcome, got: depth?.choice, expected, ack, inBand: ackOk && depthOk };
}

function line(j: Judged): string {
  const { c, outcome } = j;
  if (!outcome.ok) return `${c.depth}  FAILED: ${outcome.reason}  ${c.request.slice(0, 70)}`;
  const verdict = j.inBand ? "" : "  MISS";
  return `${c.depth}  got ${j.got} (expected index ${j.expected?.toFixed(2)}) ack ${j.ack.toFixed(2)}  ${c.request.slice(0, 70)}  ${outcome.latencyMs} ms${verdict}`;
}

export default defineEval({
  id: "effort",
  title: "Requests rated by Jev: depth and go-ahead against hand-picked expectations",
  package: "pi-auto-effort",
  kind: "cases",

  plan() {
    return { calls: CASES.length, notes: `${CASES.length} requests, one Jev request each (carrying ${Object.keys(QUESTIONS).length} questions)` };
  },

  async run(ctx) {
    const judged: Judged[] = new Array(CASES.length);
    await ctx.pool(CASES, ctx.concurrency, async (c, i) => {
      const entries = c.previous
        ? [{ type: "message", message: { role: "user", content: "earlier request" } }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: c.previous }] } }]
        : [];
      const outcome = await askJev(ctx.registry, { ...DEFAULT_CONFIG.jev, timeoutMs: CASE_TIMEOUT_MS }, effortState(c.request, entries), QUESTIONS);
      ctx.spend.addOutcome(outcome);
      judged[i] = judge(c, outcome);
    });
    const failures = judged.filter((j) => !j.outcome.ok).length;
    const inBand = judged.filter((j) => j.inBand).length;
    const misses = judged.filter((j) => j.outcome.ok && !j.inBand).length;
    const accuracy = inBand / CASES.length;
    const report = [
      ...judged.map(line),
      `accuracy: ${inBand}/${CASES.length} in band (${Math.round(accuracy * 100)}%); misses ${misses}; Jev failures ${failures}/${CASES.length}`,
    ].join("\n");
    return {
      metrics: { cases: CASES.length, inBand, accuracy },
      report,
      pass: misses === 0 && withinFailureLimit(failures, CASES.length),
      failures,
    };
  },
});
