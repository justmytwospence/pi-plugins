// The vet's discrimination, as an eval target (`npm run -s eval -- vet`, or `--package pi-next-prompt`).
// Sessions do not keep suggestions, so the vet is scored on what they do keep: your real next messages
// (positives, should pass) against next messages borrowed from another session (negatives, should be
// rejected); see eval/vet.ts. `pass` is only the failure rate (under 20% of the Jev requests); the rest
// is a report, including the real next messages the vet would have hidden.
import { defineEval, withinFailureLimit } from "../../../evals/shared/target.ts";
import { clip } from "../src/transcript.ts";
import { THRESHOLD, TURNS_PER_SESSION, buildCases, countRequests, lowestReal, scoreTurns, summarize } from "./vet.ts";

const fixed = (n: number, digits = 3) => (Number.isFinite(n) ? n.toFixed(digits) : "-");
const one = (text: string, max: number) => clip(text.replace(/\s+/gu, " "), max);

export default defineEval({
  id: "vet",
  title: "Vet discrimination: real next messages against another session's, scored by the vet",
  package: "pi-next-prompt",
  kind: "replay",

  plan(ctx) {
    const { seed, sessions } = ctx.sample();
    const cases = buildCases(sessions, seed);
    return {
      calls: countRequests(cases),
      notes: `${cases.positives.length} real next messages and ${cases.negatives.length} mismatched ones, from ${cases.candidates} qualifying turns in ${sessions.length} sessions (at most ${TURNS_PER_SESSION} per session)`,
    };
  },

  async run(ctx) {
    const { seed, sessions } = ctx.sample();
    const cases = buildCases(sessions, seed);
    const { scored, failures, requests, spend } = await scoreTurns(ctx.registry, [...cases.positives, ...cases.negatives], { concurrency: ctx.concurrency, timeoutMs: ctx.timeoutMs });
    ctx.spend.merge(spend);
    const real = scored.filter((s) => s.case.kind === "real");
    const mismatch = scored.filter((s) => s.case.kind === "mismatch");
    const summary = summarize(real, mismatch);
    const hidden = lowestReal(real);
    const report = [
      `next-prompt vet: EVAL_SEED=${seed}, ${sessions.length} sessions, threshold ${THRESHOLD}`,
      ctx.table([
        ["", "n", "mean probability", `at or above ${THRESHOLD}`],
        ["real next message (should pass)", summary.positives, fixed(summary.meanProbReal), fixed(summary.passRateReal)],
        ["another session's (should be hidden)", summary.negatives, fixed(summary.meanProbMismatch), fixed(1 - summary.rejectRateMismatch)],
      ]),
      `separation (AUC, a random real above a random mismatch): ${fixed(summary.separation)}; rejected mismatches: ${fixed(summary.rejectRateMismatch)}; Jev failures: ${failures}/${requests}`,
      hidden.length ? `\nthe ${hidden.length} real next messages the vet scored lowest (it would have hidden those below ${THRESHOLD}):` : "",
      ...hidden.map((s) => `  ${fixed(s.probability as number, 2)}  ${one(s.case.suggestion, 100)}\n        after: ${one(s.case.assistantTail.slice(-160), 110)}`),
      !withinFailureLimit(failures, requests) ? `Jev failures ${failures}/${requests}, at or above the 20% limit` : "",
    ].filter(Boolean).join("\n");
    return { metrics: { ...summary }, report, pass: withinFailureLimit(failures, requests), failures };
  },
});
