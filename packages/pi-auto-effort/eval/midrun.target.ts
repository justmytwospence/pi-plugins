// Mid-run stretches rated by live Jev through Pi's model registry, as an eval target (`npm run -s eval -- midrun`,
// or `--package pi-auto-effort`). Each stretch is a run part-way through: the agent's recent
// steps and the signals so far. Jev's depth for the next step must fall within the expected band
// (0 low to 3 xhigh, widened by half a level each side). The target passes when every answered stretch
// is in band and fewer than 20% of the Jev calls fail (the runner's limit).
import { defineEval, withinFailureLimit } from "../../../evals/shared/target.ts";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { type JevOutcome, askJev, choice } from "../src/jev.ts";
import { JUDGED_LEVELS } from "../src/policy.ts";
import { MID_RUN_QUESTIONS, runState } from "../src/midrun.ts";

/** The per-call timeout this eval always ran with (the extension's own is 1,500 ms). */
export const STRETCH_TIMEOUT_MS = 10_000;

type Step = { said?: string; calls: Array<[string, Record<string, unknown>]>; failed?: string[] };

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
function entries(request: string, steps: Step[]) {
  return [
    user(request),
    ...steps.flatMap((s) => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            ...(s.said ? [{ type: "text", text: s.said }] : []),
            ...s.calls.map(([name, args], i) => ({ type: "toolCall", id: String(i), name, arguments: args })),
          ],
        },
      },
      ...s.calls.map(([name], i) => {
        const error = s.failed?.[i];
        return { type: "message", message: { role: "toolResult", toolName: name, isError: Boolean(error), content: [{ type: "text", text: error ?? "ok" }] } };
      }),
    ]),
  ];
}

// Expected depth band [min, max] for the next step, as level indexes (0 low to 3 xhigh).
export interface StretchCase {
  name: string;
  request: string;
  steps: Step[];
  min: number;
  max: number;
}

export const CASES: StretchCase[] = [
  {
    name: "mechanical edits after the plan is settled",
    request: "rename getUser to fetchUser everywhere",
    steps: [
      { said: "Found 14 call sites; updating them.", calls: [["edit", { path: "src/api.ts" }], ["edit", { path: "src/routes.ts" }]] },
      { calls: [["edit", { path: "src/hooks.ts" }], ["edit", { path: "src/pages/user.tsx" }]] },
      { calls: [["edit", { path: "src/pages/admin.tsx" }]] },
    ],
    min: 0,
    max: 1,
  },
  {
    name: "repeated failures with an unclear cause",
    request: "add retries to the HTTP client",
    steps: [
      { said: "Retries added; running tests.", calls: [["bash", { command: "npm test" }]], failed: ["FAIL client.test.ts: expected 3 calls, got 7"] },
      { said: "Backoff counter was off by one; fixed.", calls: [["edit", { path: "src/client.ts" }], ["bash", { command: "npm test" }]], failed: [undefined as never, "FAIL client.test.ts: timeout after 5000ms; FAIL pool.test.ts: socket hang up"] },
      { said: "Now a different failure in the connection pool, which I did not touch.", calls: [["bash", { command: "npm test -- pool" }]], failed: ["FAIL pool.test.ts: socket hang up (intermittent)"] },
    ],
    min: 2,
    max: 3,
  },
  {
    name: "reading around before a cross-cutting design",
    request: "make the sync engine merge offline edits without losing data",
    steps: [
      { said: "Reading the current sync code.", calls: [["read", { path: "src/sync/engine.ts" }], ["read", { path: "src/sync/queue.ts" }]] },
      { said: "Edits are last-write-wins keyed by timestamp; concurrent edits to the same field clobber each other. I need a merge strategy (CRDT or OT) that works with the queue.", calls: [["read", { path: "src/sync/conflict.ts" }]] },
    ],
    min: 2,
    max: 3,
  },
  {
    name: "wrapping up: final checks pass",
    request: "fix the typo in the CLI help text",
    steps: [
      { calls: [["edit", { path: "src/cli.ts" }]] },
      { said: "Fixed; checking.", calls: [["bash", { command: "npm test" }]] },
    ],
    min: 0,
    max: 1,
  },
];

interface Judged {
  c: StretchCase;
  outcome: JevOutcome;
  got?: string;
  confidence?: number;
  expected: number;
  inBand: boolean;
}

function judge(c: StretchCase, outcome: JevOutcome): Judged {
  if (!outcome.ok) return { c, outcome, expected: 0, inBand: false };
  const depth = choice(outcome.answers, "depth");
  const probabilities = depth?.probabilities ?? {};
  const expected = JUDGED_LEVELS.reduce((sum, level, i) => sum + i * (probabilities[level] ?? 0), 0);
  const inBand = depth !== undefined && expected >= c.min - 0.5 && expected <= c.max + 0.5;
  return { c, outcome, got: depth?.choice, confidence: depth?.confidence, expected, inBand };
}

function line(j: Judged): string {
  const { c, outcome } = j;
  if (!outcome.ok) return `${c.name}: FAILED: ${outcome.reason}`;
  const verdict = j.inBand ? "" : "  MISS";
  return `${c.name}: ${j.got} (expected index ${j.expected.toFixed(2)}, confidence ${j.confidence?.toFixed(2)})${verdict}`;
}

export default defineEval({
  id: "midrun",
  title: "Mid-run stretches rated by Jev: the depth of the agent's next step",
  package: "pi-auto-effort",
  kind: "cases",

  plan() {
    return { calls: CASES.length, notes: `${CASES.length} stretches, one Jev request each (carrying ${Object.keys(MID_RUN_QUESTIONS).length} question)` };
  },

  async run(ctx) {
    const judged: Judged[] = new Array(CASES.length);
    await ctx.pool(CASES, ctx.concurrency, async (c, i) => {
      const outcome = await askJev(ctx.registry, { ...DEFAULT_CONFIG.jev, timeoutMs: STRETCH_TIMEOUT_MS }, runState(entries(c.request, c.steps), 6), MID_RUN_QUESTIONS);
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
