// Tasks routed by live Jev through Pi's model registry, as an eval target (`npm run -s eval -- pick`,
// or `--package pi-subagents`). Jev picks one of the built-in roles for each task, by their
// descriptions; every task must get the role it was written for. The runner prints the report and the spend, records the run in
// evals/results/pick.jsonl and exits non-zero when `pass` is false: a Jev call that gives no answer,
// or a role that is not the expected one.
import { defineEval } from "../../../evals/shared/target.ts";
import { BUILTIN_AGENTS } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { DEFAULT_TIER_DESCRIPTIONS, pickQuestions, readPicks } from "../src/pick.ts";

/** The per-call timeout these checks always ran with. */
const TIMEOUT_MS = 15_000;

/** The built-in roles, with the descriptions Jev routes by. */
const AGENTS = BUILTIN_AGENTS;

export const CASES: Array<{ task: string; role: string }> = [
  { task: "Find where the HTTP retry policy is configured and list the files and functions involved.", role: "explorer" },
  { task: "Map out how authentication flows through the codebase: which modules, which middleware.", role: "explorer" },
  { task: "Which files import the legacy logger? Return paths with line numbers.", role: "explorer" },
  { task: "Write a step-by-step implementation plan for adding rate limiting to the public API.", role: "planner" },
  { task: "Plan how to migrate the job queue from Redis to Postgres, with phases and risks.", role: "planner" },
  { task: "Weigh event sourcing against a plain audit table for order history here and recommend one, without changing code.", role: "planner" },
  { task: "Review the changes in `git diff main` for bugs and security issues.", role: "reviewer" },
  { task: "Check this pull request's diff for race conditions and missing error handling.", role: "reviewer" },
  { task: "Implement the plan in PLAN.md: add the --dry-run flag and make the tests pass.", role: "worker" },
  { task: "Fix the failing test in test/parser.test.ts and make sure the whole suite passes.", role: "worker" },
  { task: "Rename the `fetchUser` function to `getUser` across the codebase and update the tests.", role: "worker" },
  { task: "What is the latest stable version of Vite and what changed in its config API?", role: "researcher" },
  { task: "Find out how Stripe recommends handling idempotency keys for retries, with links.", role: "researcher" },
  { task: "Compare zod and valibot bundle sizes and APIs using their documentation.", role: "researcher" },
  { task: "Write a README section explaining how to configure the CLI, with an example config file.", role: "writer" },
  { task: "Draft the CHANGELOG entry for this release from the merged pull requests.", role: "writer" },
  { task: "Summarize the README for me in five bullet points.", role: "writer" },
  { task: "Explain the difference between a mutex and a semaphore with a short example.", role: "general" },
  { task: "Check whether port 5432 is free on this machine and, if not, which process holds it.", role: "general" },
];

/** The questions for a task with nothing given: the role, the tier and the effort (the same for every case). */
const questions = () => pickQuestions({}, AGENTS, { models: { fast: "x", strong: "y" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, true);

const slug = (role: string, index: number) => `${String(index + 1).padStart(2, "0")}-${role}`;

export default defineEval({
  id: "pick",
  title: "Route tasks to the agent their wording calls for",
  package: "pi-subagents",
  kind: "cases",

  plan() {
    const keys = Object.keys(questions());
    return {
      calls: CASES.length,
      notes: `${CASES.length} tasks, one request each with ${keys.length} questions (${keys.join(", ")})`,
    };
  },

  async run(ctx) {
    const lines = new Array<string>(CASES.length);
    const misses: string[] = [];
    const metrics: Record<string, number> = {};
    let failures = 0;
    let correct = 0;

    await ctx.pool(CASES, ctx.concurrency, async (c, i) => {
      const outcome = await askJev(ctx.registry, { ...DEFAULT_CONFIG.jev, timeoutMs: TIMEOUT_MS }, { task: c.task, parent_request: "(none)" }, questions());
      ctx.spend.addOutcome(outcome);
      if (!outcome.ok) {
        failures++;
        lines[i] = `${c.role}: FAILED: ${outcome.reason}`;
        return;
      }
      const picks = readPicks(outcome.answers);
      const role = outcome.answers.role;
      const got = picks.agent ?? "general";
      lines[i] = `${c.role.padEnd(10)} got ${got.padEnd(10)} conf ${role?.type === "choice" ? role.confidence.toFixed(2) : "-"} tier ${picks.tier} effort ${picks.thinking}  ${c.task.slice(0, 60)}`;
      const ok = got === c.role;
      metrics[`correct.${slug(c.role, i)}`] = ok ? 1 : 0;
      if (ok) correct++;
      else misses.push(`expected ${c.role}, got ${got}: ${c.task.slice(0, 60)}`);
    });

    Object.assign(metrics, { cases: CASES.length, correct, accuracy: correct / CASES.length, misses: misses.length });
    const report = [...lines, ...(misses.length ? ["misses:", ...misses.map((m) => `  ${m}`)] : [])].join("\n");
    return { metrics, report, pass: failures === 0 && misses.length === 0, failures };
  },
});
