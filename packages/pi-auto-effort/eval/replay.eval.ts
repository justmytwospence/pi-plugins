// Real Pi sessions replayed through live Jev: `npm run eval -- eval/replay.eval.ts`. Samples recent
// sessions (eval/sessions.ts: EVAL_RECENT, EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS, EVAL_SAMPLE, EVAL_SEED),
// assesses every user message as auto-effort would now, and compares the replayed levels with the
// levels you chose by hand (eval/replay.ts explains how an override is told apart). EVAL_COMPARE=1
// also replays the old behaviour (no pre-filter, `last_outcome` at 1,500 characters) side by side.
// Only the failure rate is asserted; the rest is a report.
import { describe, expect, test } from "vitest";
import { hasCredentials, installedRegistry } from "./registry.ts";
import { CURRENT, OLD, type VariantResult, fromSession, report, runVariant } from "./replay.ts";
import { sampleSessions } from "./sessions.ts";

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
    for (const { variant, summary } of results) {
      if (summary.calls) expect(summary.failures / summary.calls, `${variant.name}: Jev failures`).toBeLessThan(0.2);
    }
  }, 3_600_000);
});
