#!/usr/bin/env node
// Deprecated alias of `npm run -s eval -- --dry --json <id>...`, kept so the /eval extension keeps working
// until it reads the registry: `npm run -s eval:dry -- <auto-effort|tool-gate|all>` prints ONE JSON object on
// stdout in the old shape, `{ seed, targets: { <name>: { sessions, estimatedCalls, notes } }, estimate }`; human
// text goes to stderr. The old names map to target ids below (auto-effort: replay, tool-gate: sessions).
// Everything is computed by the runner (evals/shared/runner.ts) from the targets in evals/targets.ts.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { runEval } = await jiti.import("../evals/shared/runner.ts");
const { targets } = await jiti.import("../evals/targets.ts");
const { sampleSessions, summarizeSession } = await jiti.import("../evals/shared/sessions.ts");
const { estimate } = await jiti.import("../evals/shared/spend.ts");

const IDS = { "auto-effort": "replay", "tool-gate": "sessions" };
const target = process.argv[2];
if (target !== "all" && !(target in IDS)) {
  console.error(`usage: npm run -s eval:dry -- <${[...Object.keys(IDS), "all"].join("|")}>   (EVAL_SEED, EVAL_SAMPLE, EVAL_RECENT, EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS, EVAL_COMPARE=1, EVAL_COST_PER_CALL); superseded by npm run -s eval -- --dry`);
  process.exit(2);
}
const wanted = target === "all" ? Object.keys(IDS) : [target];
const viaRunner = wanted.filter((name) => targets.some((t) => t.id === IDS[name]));
const log = (line) => console.error(line);

const sample = sampleSessions({ log });
const described = sample.sessions.map(summarizeSession);
const out = {};

if (viaRunner.length) {
  const lines = [];
  const code = await runEval(["--dry", "--json", ...viaRunner.map((name) => IDS[name])], { targets, sample: () => sample, io: { out: (line) => lines.push(line), err: log } });
  if (code) process.exit(code);
  const plan = JSON.parse(lines.at(-1));
  for (const name of viaRunner) out[name] = { sessions: described, estimatedCalls: plan.targets[IDS[name]].calls, notes: plan.targets[IDS[name]].notes };
}

const cost = estimate(Object.values(out).reduce((n, t) => n + t.estimatedCalls, 0));
console.log(JSON.stringify({ seed: sample.seed, targets: out, estimate: cost }));
