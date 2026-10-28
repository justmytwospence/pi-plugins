#!/usr/bin/env node
// `npm run -s eval:dry -- <auto-effort|tool-gate|all>`: what a live replay eval would call, without
// calling Jev. Samples sessions exactly as the evals do (evals/shared/sessions.ts: EVAL_SEED,
// EVAL_SAMPLE, EVAL_RECENT, EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS), counts calls with the evals' own
// functions (auto-effort: eval/replay.ts countCalls; tool-gate: eval/sessions.ts collect and
// countCalls) and prints ONE JSON object on stdout; everything for humans goes to stderr.
// EVAL_COMPARE=1 counts the old behaviour too. EVAL_COST_PER_CALL sets the per-call price estimate.
import { countCalls as autoEffortCalls, CURRENT, fromSession, OLD } from "../packages/pi-auto-effort/eval/replay.ts";
import { collect, countCalls as toolGateCalls } from "../packages/pi-tool-gate/eval/plans.ts";
import { estimate } from "../evals/shared/spend.ts";
import { sampleSessions, summarizeSession } from "../evals/shared/sessions.ts";

const TARGETS = ["auto-effort", "tool-gate"];
const target = process.argv[2];
if (target !== "all" && !TARGETS.includes(target)) {
  console.error(`usage: npm run -s eval:dry -- <${[...TARGETS, "all"].join("|")}>   (EVAL_SEED, EVAL_SAMPLE, EVAL_RECENT, EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS, EVAL_COMPARE=1, EVAL_COST_PER_CALL)`);
  process.exit(2);
}
const wanted = target === "all" ? TARGETS : [target];
const compare = process.env.EVAL_COMPARE === "1";
const log = (line) => console.error(line);

const { seed, sessions } = sampleSessions({ log });
const described = sessions.map(summarizeSession);
const targets = {};

if (wanted.includes("auto-effort")) {
  const replays = sessions.map(fromSession);
  const variants = compare ? [CURRENT, OLD] : [CURRENT];
  const prompts = replays.reduce((n, s) => n + s.prompts.length, 0);
  const estimatedCalls = autoEffortCalls(replays, variants);
  const settled = prompts - autoEffortCalls(replays, [CURRENT]);
  targets["auto-effort"] = {
    sessions: described,
    estimatedCalls,
    notes: `${prompts} prompts, ${settled} settled by the pre-filter` + (compare ? "; EVAL_COMPARE=1 adds the old behaviour, which has no pre-filter" : ""),
  };
}

if (wanted.includes("tool-gate")) {
  const collected = collect(sessions, compare);
  const estimatedCalls = toolGateCalls(collected);
  targets["tool-gate"] = {
    sessions: described,
    estimatedCalls,
    notes: `${collected.walked.n} labeled calls walked, ${collected.judged.length} planned as judge` + (compare ? `, ${estimatedCalls - collected.judged.length} extra for script calls (EVAL_COMPARE=1)` : ""),
  };
}

const total = Object.values(targets).reduce((n, t) => n + t.estimatedCalls, 0);
const cost = estimate(total);
for (const [name, t] of Object.entries(targets)) log(`${name}: ${t.estimatedCalls} calls (${t.notes})`);
log(`${cost.note}: $${cost.usd.low.toFixed(4)} to $${cost.usd.high.toFixed(4)}`);
console.log(JSON.stringify({ seed, targets, estimate: cost }));
