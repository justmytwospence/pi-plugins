// Real Pi sessions replayed through the gate, with live Jev: `npm run eval -- eval/sessions.eval.ts`.
// Paid: one Jev request per call the gate would judge (two for a call that runs a script, with
// EVAL_COMPARE=1). Samples recent sessions with evals/shared/sessions.ts (EVAL_RECENT, EVAL_SAMPLE, EVAL_SEED,
// EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS; the seed is printed), walks each current branch's tool calls in
// order, plans each one as the gate does in auto mode (`planCall`: clear allows, always-held calls,
// the directory policy, the judge) with this machine's settings, rules and project grants, and asks
// Jev about the judged ones with the conversation as it stood when the call was made.
//
// Labels come from each call's result: a call whose result is not a tool-gate block ran, so it
// counts as allowed; one the user blocked (Block, Block with a message) counts as held. Calls the
// gate stopped on its own (a push-back, chat or plan mode) are not labeled. A hold on an allowed
// call is an extra prompt; an allow on a held call is a miss. Script content is read from disk now,
// not as it was then.
//
// Planning lives in eval/sessions.ts, shared with the dry run (`npm run eval:dry -- tool-gate` at the
// repository root, which makes no Jev call). Each run prints its spend and appends a record to
// evals/results/tool-gate.jsonl (`npm run eval:last -- tool-gate`).
import { beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { judgeQuestions, verdict } from "../src/judge.ts";
import { pool } from "../../../evals/shared/pool.ts";
import { hasCredentials, installedRegistry } from "../../../evals/shared/registry.ts";
import { record } from "../../../evals/shared/results.ts";
import { sampleSessions } from "../../../evals/shared/sessions.ts";
import { Spend } from "../../../evals/shared/spend.ts";
import { table } from "../../../evals/shared/table.ts";
import { collect, type Judged, outcomes, type Outcomes } from "./plans.ts";

const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
const COMPARE = process.env.EVAL_COMPARE === "1";

describe.skipIf(!hasCredentials)("tool-gate on real sessions", () => {
  let registry: unknown;
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test("replay", async () => {
    const { seed, sessions } = sampleSessions();
    const { walked, stopped, clearAllow, clearHold, toJudge, downloaded, judged } = collect(sessions, COMPARE);

    const all = outcomes();
    const withScript = outcomes();
    const withoutContent = outcomes();
    const lines: string[] = [];
    const spend = new Spend();
    const judge = async (j: Judged, state: Record<string, unknown>, script: boolean, into: Outcomes[]) => {
      const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: TIMEOUT_MS }, state, judgeQuestions(j.rules, { script }));
      spend.addOutcome(outcome);
      for (const o of into) o.n++;
      if (!outcome.ok) {
        for (const o of into) o.failed++;
        return undefined;
      }
      const v = verdict(outcome.answers, j.rules, DEFAULT_CONFIG.thresholds);
      const hold = Boolean(v && !v.allow);
      for (const o of into) {
        if (hold) o.holds++;
        if (hold && j.label === "allowed") o.extra++;
        if (!hold && j.label === "held") o.misses++;
      }
      return { hold, v };
    };
    const one = async (j: Judged) => {
      const hasScript = j.state.script !== undefined;
      const got = await judge(j, j.state, hasScript, hasScript ? [all, withScript] : [all]);
      if (j.bare) await judge(j, j.bare, false, [withoutContent]);
      if (got && got.hold !== (j.label === "held")) {
        const kind = got.hold ? "EXTRA" : "MISS ";
        const shown = `${j.tool} ${j.args.replace(/\s+/gu, " ").slice(0, 100)}`;
        lines.push(`${kind} ${hasScript ? "[script] " : ""}${shown}\n       ${got.v?.failures.join("; ") ?? ""}`);
      }
    };
    await pool(judged, CONCURRENCY, one);

    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
    const plans = table([
      ["calls (EVAL_SEED=" + seed + ")", "n", "user allowed", "user held"],
      ["walked", walked.n, walked.allowed, walked.held],
      ["  clear allow", clearAllow.n, clearAllow.allowed, clearAllow.held],
      ["  clear hold", clearHold.n, clearHold.allowed, clearHold.held],
      ["    downloaded code", downloaded.holds.n, downloaded.holds.allowed, downloaded.holds.held],
      ["    of those, new holds", downloaded.added.n, downloaded.added.allowed, downloaded.added.held],
      ["  judged", toJudge.n, toJudge.allowed, toJudge.held],
      ["stopped by the gate itself", stopped.n, "", ""],
    ]);
    const jev = table([
      ["Jev", "n", "failed", "holds", "extra prompts", "misses"],
      ["judged calls", all.n, all.failed, all.holds, `${all.extra} (${pct(all.extra, toJudge.allowed)})`, `${all.misses} (${pct(all.misses, toJudge.held)})`],
      ["  running a script", withScript.n, withScript.failed, withScript.holds, withScript.extra, withScript.misses],
      ...(COMPARE ? [["  same, without its content", withoutContent.n, withoutContent.failed, withoutContent.holds, withoutContent.extra, withoutContent.misses]] : []),
    ]);
    // The disagreements, at most 25 of each kind.
    const shown = ["EXTRA", "MISS "].flatMap((kind) => {
      const of = lines.filter((l) => l.startsWith(kind)).sort();
      return of.length > 25 ? [...of.slice(0, 25), `${kind.trim()}: ${of.length - 25} more`] : of;
    });
    console.log(`${sessions.length} sessions\n\n${plans}\n\n${jev}${shown.length ? `\n\n${shown.join("\n")}` : ""}`);
    console.log(spend.line());
    const metricsOf = (o: Outcomes) => ({ judged: o.n, failed: o.failed, holds: o.holds, extraPrompts: o.extra, misses: o.misses });
    record("tool-gate", {
      seed,
      spend: spend.total,
      calls: spend.calls,
      metrics: {
        sessions: sessions.length,
        walked: walked.n,
        clearAllow: clearAllow.n,
        clearHold: clearHold.n,
        downloadedHolds: downloaded.holds.n,
        downloadedNewHolds: downloaded.added.n,
        toJudge: toJudge.n,
        toJudgeAllowed: toJudge.allowed,
        toJudgeHeld: toJudge.held,
        stoppedByGate: stopped.n,
        ...metricsOf(all),
        scriptJudged: withScript.n,
        scriptHolds: withScript.holds,
        scriptExtraPrompts: withScript.extra,
        scriptMisses: withScript.misses,
      },
      ...(COMPARE ? { compare: metricsOf(withoutContent) } : {}),
    });
    expect(all.failed).toBeLessThan(Math.max(1, all.n * 0.2));
  }, 3_600_000);
});
