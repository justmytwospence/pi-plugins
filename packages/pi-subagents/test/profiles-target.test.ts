import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import profiles, { MAX_RUNS, collectRuns, costPerTurn, estimate, implied, selectRuns } from "../eval/profiles.target.ts";
import { BUILTIN_AGENTS } from "../src/agents.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";
import type { Sample, SessionEntry } from "../../../evals/shared/sessions.ts";

// A Jev that bills a tenth of a cent per call. `answer` gets the questions and the state of each request.
const usage = { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
function fakeJev(answer: (questions: Record<string, any>, state: Record<string, any>) => Record<string, unknown> | { stopReason: "error"; errorMessage: string }) {
  const calls: Array<{ questions: string[]; state: Record<string, any> }> = [];
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
    classify: async (_model: unknown, context: { questions: Record<string, any>; state: Record<string, any> }) => {
      calls.push({ questions: Object.keys(context.questions), state: context.state });
      const result = answer(context.questions, context.state);
      if ("stopReason" in result) return { model: "jev-latest", ...result };
      return { model: "jev-latest", stopReason: "stop", answers: result, usage };
    },
  };
  return { calls, registry };
}
const role = (name: string) => ({ role: { type: "choice", choice: name, confidence: 0.9, probabilities: { [name]: 0.9 } } });

const user = (text: string): SessionEntry => ({ type: "message", message: { role: "user", content: text } });
const record = (data: Record<string, unknown>): SessionEntry => ({ type: "custom", customType: "subagents:run", data });
const run = (id: string, task: string, model: string, turns: number, cost: number, agent = "general", status = "done") =>
  record({ id, agent, task, model, thinking: "high", status, turns, tokens: 1000, cost, byJev: {}, outputPath: "/x" });

const sample: Sample = {
  seed: 7,
  sessions: [
    {
      file: "/s/a.jsonl",
      cwd: "/p",
      entries: [
        user("Look into the retry bug"),
        run("r1", "Find where retries are configured", "anthropic/claude-fable-5-1", 10, 2, "general", "running"),
        run("r1", "Find where retries are configured", "anthropic/claude-fable-5-1", 10, 2),
        run("r2", "Review the diff for bugs", "anthropic/claude-opus-5-5", 4, 0.8, "reviewer"),
        user("Now write docs"),
        run("r3", "Write the README section", "anthropic/claude-sonnet-5-5", 5, 0.25),
      ],
    },
    { file: "/s/b.jsonl", cwd: "/q", entries: [user("hi"), run("c1", "Search the codebase for the logger", "openai-codex/gpt-6.1-sol", 6, 0.6), record({ id: "bad" })] },
  ],
};

const roles: Record<string, string> = {
  "Find where retries are configured": "explorer",
  "Review the diff for bugs": "reviewer",
  "Write the README section": "writer",
  "Search the codebase for the logger": "explorer",
};

function runTarget(argv: string[], registry: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "profiles-target-")) };
  const code = runEval(argv, { targets: [profiles], env, hasCredentials: true, registry: async () => registry, sample: () => sample, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env };
}

describe("the profiles eval target", () => {
  test("is registered as a replay of pi-subagents", () => {
    expect([profiles.id, profiles.package, profiles.kind]).toEqual(["profiles", "pi-subagents", "replay"]);
  });

  test("collects the latest record per run with the user message before it, and caps the runs by seed", () => {
    const runs = collectRuns(sample.sessions);
    expect(runs.map((r) => `${r.id} ${r.status} ${r.parentRequest}`)).toEqual(["r1 done Look into the retry bug", "r2 done Look into the retry bug", "r3 done Now write docs", "c1 done hi"]);
    expect(selectRuns(runs, 7)).toEqual(runs);
    const many = Array.from({ length: MAX_RUNS + 50 }, (_, i) => ({ ...runs[0]!, id: `x${i}` }));
    expect(selectRuns(many, 7)).toHaveLength(MAX_RUNS);
    expect(selectRuns(many, 7)).toEqual(selectRuns(many, 7));
    expect(selectRuns(many, 7)).not.toEqual(selectRuns(many, 8));
  });

  test("implied models stay on the run's provider; estimates use the median cost per turn, else the actual cost", () => {
    const runs = collectRuns(sample.sessions);
    const explorer = BUILTIN_AGENTS.find((a) => a.name === "explorer");
    expect(implied(explorer, runs[0]!)).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "low", profiled: true });
    expect(implied(explorer, runs[3]!)).toEqual({ model: "openai-codex/gpt-6-luna", thinking: "high", profiled: true });
    expect(implied(BUILTIN_AGENTS[0], runs[0]!)).toEqual({ model: "anthropic/claude-fable-5-1", thinking: "high", profiled: false });
    const medians = costPerTurn(runs);
    expect(medians.get("anthropic/claude-sonnet-5-5")).toEqual({ perTurn: 0.05, runs: 1 });
    expect(estimate(runs[0]!, "anthropic/claude-sonnet-5-5", medians)).toEqual({ cost: 0.5, priced: true });
    expect(estimate(runs[3]!, "openai-codex/gpt-6-luna", medians)).toEqual({ cost: 0.6, priced: false });
    expect(estimate(runs[1]!, "anthropic/claude-opus-5-5", medians)).toEqual({ cost: 0.8, priced: true });
  });

  test("plan counts one role question per recorded run, without Jev", async () => {
    const plan = await profiles.plan({ sample: () => sample, compare: false, env: {}, log: () => undefined });
    expect(plan).toEqual({ calls: 4, notes: `4 of 4 recorded runs in 2 sessions, one role question each (at most ${MAX_RUNS})` });
  });

  test("a live run through the runner: the role question only, the role table, the cost estimate and one record", async () => {
    const fake = fakeJev((_questions, state) => role(roles[state.task] ?? "general"));
    const r = runTarget(["profiles"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls.every((c) => c.questions.join() === "role")).toBe(true);
    expect(fake.calls[0]?.state).toEqual({ task: "Find where retries are configured", parent_request: "Look into the retry bug" });
    const text = r.out.join("\n");
    expect(text).toMatch(/^explorer\s+2\s+50%\s+\$2\.60\s+\$1\.10\s+anthropic\/claude-sonnet-5-5 low x1, openai-codex\/gpt-6-luna high x1$/mu);
    expect(text).toMatch(/^total\s+4\s+100%\s+\$3\.65\s+\$2\.15\s+estimated\/actual 0\.59$/mu);
    expect(text).toContain("3 runs would get another agent than they had; 1 runs are estimated at their actual cost");
    expect(text).toContain("cannot judge answer quality");
    expect(text).toContain("Model chosen by: not recorded (4 runs predate the source record).");
    expect(text).toMatch(/spend: \$0\.0040 over 4 calls/u);
    const [recorded] = last("profiles", 1, r.env);
    expect(recorded).toMatchObject({ seed: 7, calls: 4, metrics: { runs: 4, recorded: 4, sessions: 2, jevFailures: 0, "share.explorer": 0.5, "runs.writer": 1, unpriced: 1, changedAgent: 3, "source.unknown": 4, "source.explicit": 0 } });
    expect(recorded!.metrics.actualCost).toBeCloseTo(3.65);
    expect(recorded!.metrics.estimatedCost).toBeCloseTo(2.15);
  });

  test("reports the source of the model where records have it", () => {
    const runs = collectRuns([
      { entries: [record({ id: "a", task: "t", model: "m/x", source: { model: "profile", thinking: "profile" } }), record({ id: "b", task: "t", model: "m/x", source: { model: "explicit" } }), record({ id: "c", task: "t", model: "m/x" })] },
    ]);
    expect(runs.map((r) => r.modelSource)).toEqual(["profile", "explicit", "unknown"]);
  });

  test("fails, with the failures counted, when 20% or more of the calls do not answer", async () => {
    const fake = fakeJev(() => ({ stopReason: "error", errorMessage: "boom" }));
    const r = runTarget(["profiles", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.profiles).toMatchObject({ pass: false, failures: 4, calls: 4, metrics: { "runs.unanswered": 4 } });
  });
});
