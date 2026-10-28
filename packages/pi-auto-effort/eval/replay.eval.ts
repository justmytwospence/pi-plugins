// Real Pi sessions replayed through live Jev: `npm run eval -- eval/replay.eval.ts`. Samples recent
// sessions (evals/shared/sessions.ts: EVAL_RECENT, EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS, EVAL_SAMPLE, EVAL_SEED),
// assesses every user message as auto-effort would now, and compares the replayed levels with the
// levels you chose by hand (eval/replay.ts explains how an override is told apart). EVAL_COMPARE=1
// also replays the old behaviour (no pre-filter, `last_outcome` at 1,500 characters) side by side.
// Only the failure rate is asserted; the rest is a report. Each run prints its spend and appends a
// record to evals/results/auto-effort.jsonl (`npm run eval:last -- auto-effort` at the repository root).
// The dry run (`npm run eval:dry -- auto-effort`) counts the calls without making any (`countCalls`).
import { describe, expect, test } from "vitest";
import { hasCredentials, installedRegistry } from "../../../evals/shared/registry.ts";
import { CURRENT, OLD, type VariantResult, fromSession, metricsOf, report, runVariant } from "./replay.ts";
import { record } from "../../../evals/shared/results.ts";
import { sampleSessions } from "../../../evals/shared/sessions.ts";
import { Spend } from "../../../evals/shared/spend.ts";

const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;

describe.skipIf(!hasCredentials)("auto-effort session replay", () => {
  test("replayed levels against your overrides", async () => {
    const registry = await installedRegistry();
    const { seed, sessions } = sampleSessions();
    const replays = sessions.map(fromSession);
    const variants = process.env.EVAL_COMPARE === "1" ? [CURRENT, OLD] : [CURRENT];
    const results: VariantResult[] = [];
    for (const variant of variants) results.push(await runVariant(registry, replays, variant, { concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS }));
    console.log(report(seed, replays, results));
    const spend = new Spend();
    for (const r of results) spend.merge(r.spend);
    console.log(spend.line());
    const [current, old] = results;
    record("auto-effort", { seed, spend: spend.total, calls: spend.calls, metrics: metricsOf(current!.summary), ...(old ? { compare: metricsOf(old.summary) } : {}) });
    for (const { variant, summary } of results) {
      if (summary.calls) expect(summary.failures / summary.calls, `${variant.name}: Jev failures`).toBeLessThan(0.2);
    }
  }, 3_600_000);
});
