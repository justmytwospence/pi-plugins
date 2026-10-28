// Real Pi sessions replayed through live Jev, as an eval target (`npm run -s eval -- replay`, or
// `--package pi-auto-effort`). The runner samples the sessions (EVAL_RECENT, EVAL_MIN_PROMPTS,
// EVAL_MIN_TOOLS, EVAL_SAMPLE, EVAL_SEED), prints the report and the spend, records the run in
// evals/results/replay.jsonl and exits non-zero when `pass` is false. The engine is eval/replay.ts:
// it assesses every user message as auto-effort would now and compares the replayed levels with the
// levels you chose by hand (that file explains how an override is told apart). EVAL_COMPARE=1 also
// replays the old behaviour (no pre-filter, `last_outcome` at 1,500 characters) side by side.
// `pass` is only the failure rate (under 20% of the Jev calls of each variant); the rest is a report.
import { defineEval, withinFailureLimit } from "../../../evals/shared/target.ts";
import { CURRENT, OLD, type VariantResult, countCalls, fromSession, metricsOf, report, runVariant } from "./replay.ts";

const variantsOf = (compare: boolean) => (compare ? [CURRENT, OLD] : [CURRENT]);

export default defineEval({
  id: "replay",
  title: "Replay your sessions: replayed effort levels against your overrides",
  package: "pi-auto-effort",
  kind: "replay",

  plan(ctx) {
    const replays = ctx.sample().sessions.map(fromSession);
    const prompts = replays.reduce((n, s) => n + s.prompts.length, 0);
    const settled = prompts - countCalls(replays, [CURRENT]);
    return {
      calls: countCalls(replays, variantsOf(ctx.compare)),
      notes: `${prompts} prompts, ${settled} settled by the pre-filter` + (ctx.compare ? "; EVAL_COMPARE=1 adds the old behaviour, which has no pre-filter" : ""),
    };
  },

  async run(ctx) {
    const { seed, sessions } = ctx.sample();
    const replays = sessions.map(fromSession);
    const results: VariantResult[] = [];
    for (const variant of variantsOf(ctx.compare)) {
      results.push(await runVariant(ctx.registry, replays, variant, { concurrency: ctx.concurrency, timeoutMs: ctx.timeoutMs }));
    }
    // Each variant summed its own askJev outcomes (Spend.addOutcome); fold them into the target's.
    for (const r of results) ctx.spend.merge(r.spend);
    const [current, old] = results as [VariantResult, VariantResult | undefined];
    const over = results.filter((r) => !withinFailureLimit(r.summary.failures, r.summary.calls));
    return {
      metrics: metricsOf(current.summary),
      ...(old ? { compare: metricsOf(old.summary) } : {}),
      report: [report(seed, replays, results), ...over.map((r) => `${r.variant.name}: Jev failures ${r.summary.failures}/${r.summary.calls}, at or above the 20% limit`)].join("\n"),
      pass: over.length === 0,
      failures: results.reduce((n, r) => n + r.summary.failures, 0),
    };
  },
});
