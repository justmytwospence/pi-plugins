import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { last } from "./results.ts";
import { parseArgs, runEval, select, type RunnerDeps } from "./runner.ts";
import type { Sample } from "./sessions.ts";
import { type EvalTarget, type RunContext, defineEval } from "./target.ts";

interface Fake {
  deps: RunnerDeps;
  out: string[];
  err: string[];
  env: NodeJS.ProcessEnv;
  samples: number;
  registries: number;
  runs: Array<{ id: string; ctx: RunContext }>;
}

const SAMPLE: Sample = { seed: 7, sessions: [{ file: "/s/a.jsonl", cwd: "/s", entries: [] }] };

/** A fake outcome of a Jev call: `cost` in USD, as askJev reports it in `usage.cost.total`. */
const outcome = (cost?: number) => ({ ok: true, ...(cost === undefined ? {} : { usage: { cost: { total: cost } } }) });

function fixture(options: { targets?: EvalTarget[]; credentials?: boolean; env?: NodeJS.ProcessEnv } = {}): Fake {
  const fake = { out: [] as string[], err: [] as string[], samples: 0, registries: 0, runs: [] as Fake["runs"] } as Fake;
  const record = (id: string, result: Partial<Awaited<ReturnType<EvalTarget["run"]>>> = {}): EvalTarget["run"] =>
    async (ctx) => {
      fake.runs.push({ id, ctx });
      ctx.spend.addOutcome(outcome(0.001));
      ctx.spend.addOutcome(outcome(0.002));
      ctx.spend.addOutcome({ ok: false });
      return { metrics: { score: 0.5, n: 3 }, report: `report of ${id}`, pass: true, ...result };
    };
  const targets = options.targets ?? [
    defineEval({ id: "alpha", title: "Alpha cases", package: "pi-one", kind: "cases", plan: () => ({ calls: 4, notes: "four" }), run: record("alpha") }),
    defineEval({ id: "beta", title: "Beta replay", package: "pi-one", kind: "replay", plan: (ctx) => ({ calls: ctx.sample().sessions.length * 10, notes: ctx.compare ? "compared" : "plain" }), run: record("beta", { compare: { score: 0.4 } }) }),
    defineEval({ id: "gamma", title: "Gamma replay", package: "pi-two", kind: "replay", plan: async (ctx) => ({ calls: ctx.sample().sessions.length, notes: "one per session" }), run: record("gamma", { failures: 2 }) }),
  ];
  fake.env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "eval-runner-")), ...options.env };
  fake.deps = {
    targets,
    env: fake.env,
    hasCredentials: options.credentials ?? true,
    registry: async () => {
      fake.registries++;
      return { fake: "registry" };
    },
    sample: (log) => {
      fake.samples++;
      log("sessions: fake sample");
      return SAMPLE;
    },
    io: { out: (line) => fake.out.push(line), err: (line) => fake.err.push(line) },
  };
  return fake;
}

const json = (lines: string[]) => JSON.parse(lines.at(-1) as string);

test("parseArgs reads selectors, modes, --package in both forms and rejects mistakes", () => {
  assert.deepEqual(parseArgs(["a", "--dry", "--json", "--package", "pi-x", "--package=y", "b"]), { mode: "dry", json: true, selectors: ["a", "b"], packages: ["pi-x", "y"], help: false });
  assert.equal(parseArgs([]).mode, "run");
  assert.throws(() => parseArgs(["--dry", "--list"]), /cannot be combined/u);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/u);
  assert.throws(() => parseArgs(["--package"]), /needs a package/u);
});

test("select takes ids, packages (with or without pi-), all and --package, in list order and without repeats", () => {
  const { targets } = fixture().deps;
  const ids = (names: string[], packages: string[] = []) => select(targets, names, packages).map((t) => t.id);
  assert.deepEqual(ids(["gamma", "alpha"]), ["alpha", "gamma"]);
  assert.deepEqual(ids(["pi-one"]), ["alpha", "beta"]);
  assert.deepEqual(ids(["two"]), ["gamma"]);
  assert.deepEqual(ids(["all"]), ["alpha", "beta", "gamma"]);
  assert.deepEqual(ids(["alpha"], ["one"]), ["alpha", "beta"]);
  assert.deepEqual(ids([], ["pi-two"]), ["gamma"]);
  assert.throws(() => ids(["nope"]), /unknown eval target or package: nope\nknown ids: alpha, beta, gamma\nknown packages: pi-one, pi-two/u);
  assert.throws(() => ids([], ["nope"]), /unknown package: nope/u);
});

test("--list prints a table, or a JSON array of id, title, package and kind", async () => {
  const f = fixture();
  assert.equal(await runEval(["--list"], f.deps), 0);
  assert.match(f.out.join("\n"), /^id\s+title\s+package\s+kind\nalpha\s+Alpha cases\s+pi-one\s+cases\nbeta\s+Beta replay\s+pi-one\s+replay\ngamma/u);
  f.out.length = 0;
  assert.equal(await runEval(["--list", "--json", "pi-two"], f.deps), 0);
  assert.deepEqual(json(f.out), [{ id: "gamma", title: "Gamma replay", package: "pi-two", kind: "replay" }]);
  assert.equal(f.registries + f.samples + f.runs.length, 0);
});

test("an unknown id is a usage error listing the known ids, in every mode", async () => {
  for (const mode of [[], ["--dry"], ["--list"], ["--last"]]) {
    const f = fixture();
    assert.equal(await runEval(["nope", ...mode], f.deps), 2);
    assert.match(f.err.join("\n"), /unknown eval target or package: nope\nknown ids: alpha, beta, gamma/u);
    assert.equal(f.runs.length, 0);
  }
});

test("a live run must name its targets; an unknown option or a malformed list is refused", async () => {
  const f = fixture();
  assert.equal(await runEval([], f.deps), 2);
  assert.match(f.err.join("\n"), /name what to run/u);
  assert.equal(await runEval(["alpha", "--bogus"], f.deps), 2);
  assert.equal(f.runs.length, 0);
  const bad = fixture();
  bad.deps.targets = [...bad.deps.targets, bad.deps.targets[0] as EvalTarget];
  await assert.rejects(() => runEval(["--list"], bad.deps), /duplicate eval target id/u);
});

test("--dry samples once for the targets that need sessions, plans each, and estimates without calling Jev", async () => {
  const f = fixture({ env: { EVAL_COMPARE: "1", EVAL_COST_PER_CALL: "0.001" } });
  assert.equal(await runEval(["--dry", "--json", "all"], f.deps), 0);
  assert.equal(f.samples, 1);
  assert.equal(f.registries + f.runs.length, 0);
  const plan = json(f.out);
  assert.equal(plan.seed, 7);
  assert.deepEqual(plan.sessions, [{ file: "/s/a.jsonl", cwd: "/s", prompts: 0, toolResults: 0 }]);
  assert.deepEqual(plan.targets, {
    alpha: { kind: "cases", calls: 4, notes: "four" },
    beta: { kind: "replay", calls: 10, notes: "compared" },
    gamma: { kind: "replay", calls: 1, notes: "one per session" },
  });
  assert.equal(plan.totalCalls, 15);
  assert.equal(plan.estimate.calls, 15);
  assert.equal(plan.estimate.usd.expected, 0.015);
  assert.match(f.err.join("\n"), /alpha: 4 calls \(four\)/u);
  assert.equal(f.out.length, 1);
});

test("--dry of a cases target does not sample sessions; the seed is null", async () => {
  const f = fixture();
  assert.equal(await runEval(["--dry", "--json", "alpha"], f.deps), 0);
  assert.equal(f.samples, 0);
  assert.deepEqual([json(f.out).seed, json(f.out).sessions], [null, []]);
});

test("--dry without --json prints the plan lines on stdout; a plan that throws fails the run", async () => {
  const f = fixture();
  f.deps.targets = [defineEval({ id: "bad", title: "Bad", package: "pi-one", kind: "cases", plan: () => { throw new Error("no plan"); }, run: async () => ({ metrics: {}, report: "", pass: true }) }), ...f.deps.targets];
  assert.equal(await runEval(["--dry", "bad", "alpha"], f.deps), 1);
  assert.match(f.out.join("\n"), /bad: plan failed: no plan\nalpha: 4 calls \(four\)\nestimate only: 4 calls/u);
});

test("without credentials a live run skips cleanly: exit 0, no registry, no target run", async () => {
  const f = fixture({ credentials: false });
  assert.equal(await runEval(["all"], f.deps), 0);
  assert.match(f.out.join("\n"), /skipped: TYPESAFE_API_KEY is not set.*alpha, beta, gamma/u);
  assert.equal(f.registries + f.samples + f.runs.length, 0);
  const g = fixture({ credentials: false });
  assert.equal(await runEval(["--package", "pi-one", "--json"], g.deps), 0);
  assert.equal(json(g.out).skipped, true);
});

test("credentials default to TYPESAFE_API_KEY in the environment", async () => {
  const without = fixture({ env: { TYPESAFE_API_KEY: "  " } });
  delete without.deps.hasCredentials;
  assert.equal(await runEval(["alpha"], without.deps), 0);
  assert.equal(without.runs.length, 0);
  const withKey = fixture({ env: { TYPESAFE_API_KEY: "k" } });
  delete withKey.deps.hasCredentials;
  assert.equal(await runEval(["alpha"], withKey.deps), 0);
  assert.equal(withKey.runs.length, 1);
});

test("a live run builds the registry and the sample once, gives each target its own spend, prints and records", async () => {
  const f = fixture({ env: { EVAL_SEED: "7", EVAL_COMPARE: "1", EVAL_SAMPLE: "3" } });
  assert.equal(await runEval(["all"], f.deps), 0);
  assert.equal(f.registries, 1);
  assert.equal(f.samples, 1);
  assert.deepEqual(f.runs.map((r) => r.id), ["alpha", "beta", "gamma"]);
  const [alpha, beta] = f.runs.map((r) => r.ctx);
  assert.deepEqual(alpha?.registry, { fake: "registry" });
  assert.equal(alpha?.compare, true);
  assert.notEqual(alpha?.spend, beta?.spend);
  assert.equal(alpha?.concurrency, 8);
  assert.equal(alpha?.timeoutMs, 20_000);
  assert.equal(alpha?.sample(), SAMPLE);
  assert.equal(typeof alpha?.pool, "function");
  assert.equal(typeof alpha?.table, "function");
  const out = f.out.join("\n");
  assert.match(out, /== alpha: Alpha cases \(pi-one, cases\) ==\nreport of alpha\nspend: \$0\.0030 over 3 calls\nrecorded: .*alpha\.jsonl/u);
  assert.match(out, /report of gamma\nspend: \$0\.0030 over 3 calls; failures: 2/u);
  assert.match(out, /3\/3 targets passed; total spend: \$0\.0090 over 9 calls/u);
  const [a] = last("alpha", 1, f.env);
  assert.deepEqual([a?.spend, a?.calls, a?.metrics, a?.compare, a?.seed], [0.003, 3, { score: 0.5, n: 3 }, undefined, null]);
  assert.equal(a?.params.EVAL_SAMPLE, "3");
  const [b] = last("beta", 1, f.env);
  assert.deepEqual([b?.spend, b?.calls, b?.compare, b?.seed], [0.003, 3, { score: 0.4 }, 7]);
  assert.equal(last("gamma", 1, f.env)[0]?.seed, 7);
  assert.equal(readFileSync(path.join(f.env.EVAL_RESULTS_DIR as string, "alpha.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("a target selected by package runs with the others of that package only", async () => {
  const f = fixture();
  assert.equal(await runEval(["--package", "pi-one"], f.deps), 0);
  assert.deepEqual(f.runs.map((r) => r.id), ["alpha", "beta"]);
  assert.deepEqual(last("gamma", 1, f.env), []);
});

test("a target whose pass is false makes the exit code 1, is still recorded, and does not stop the others", async () => {
  const f = fixture();
  f.deps.targets = [
    defineEval({ id: "weak", title: "Weak", package: "pi-one", kind: "cases", plan: () => ({ calls: 1, notes: "" }), run: async (ctx) => (ctx.spend.add(0.01), { metrics: { rate: 0.5 }, report: "too many failures", pass: false, failures: 5 }) }),
    ...f.deps.targets,
  ];
  assert.equal(await runEval(["weak", "alpha", "--json"], f.deps), 1);
  const result = json(f.out);
  assert.equal(result.pass, false);
  assert.equal(result.targets.weak.pass, false);
  assert.equal(result.targets.weak.failures, 5);
  assert.equal(result.targets.alpha.pass, true);
  assert.equal(result.calls, 4);
  assert.deepEqual(last("weak", 1, f.env)[0]?.metrics, { rate: 0.5 });
  assert.match(f.err.join("\n") + f.out.join("\n"), /FAIL weak/u);
  assert.equal(f.out.length, 1);
});

test("a target that throws fails the run, keeps its spend line, records nothing, and the next one still runs", async () => {
  const f = fixture();
  f.deps.targets = [
    defineEval({ id: "boom", title: "Boom", package: "pi-one", kind: "cases", plan: () => ({ calls: 1, notes: "" }), run: async (ctx) => { ctx.spend.add(0.01); throw new Error("registry exploded"); } }),
    ...f.deps.targets,
  ];
  assert.equal(await runEval(["boom", "alpha"], f.deps), 1);
  assert.match(f.err.join("\n"), /boom: registry exploded/u);
  assert.match(f.out.join("\n"), /spend: \$0\.0100 over 1 calls\nFAIL boom/u);
  assert.deepEqual(last("boom", 1, f.env), []);
  assert.equal(last("alpha", 1, f.env).length, 1);
});

test("non-finite metrics are not recorded", async () => {
  const f = fixture();
  f.deps.targets = [defineEval({ id: "nan", title: "NaN", package: "pi-one", kind: "cases", plan: () => ({ calls: 0, notes: "" }), run: async () => ({ metrics: { ok: 1, bad: Number.NaN, inf: Infinity }, report: "", pass: true }) })];
  assert.equal(await runEval(["nan"], f.deps), 0);
  assert.deepEqual(last("nan", 1, f.env)[0]?.metrics, { ok: 1 });
});

test("a registry that cannot be built is an error, not a skip", async () => {
  const f = fixture();
  f.deps.registry = async () => {
    throw new Error("no pi");
  };
  assert.equal(await runEval(["alpha"], f.deps), 1);
  assert.match(f.err.join("\n"), /cannot build the Jev registry: no pi/u);
  assert.equal(f.runs.length, 0);
});

test("--last reads the history, with the diff from the run before; no history is said so", async () => {
  const f = fixture();
  await runEval(["--last", "--json", "alpha"], f.deps);
  assert.deepEqual(json(f.out).targets.alpha, { runs: 0, last: null, previous: null, diff: null });
  f.out.length = 0;
  await runEval(["alpha"], f.deps);
  await runEval(["alpha"], f.deps);
  f.out.length = 0;
  assert.equal(await runEval(["--last", "--json", "alpha", "beta"], f.deps), 0);
  const { targets } = json(f.out);
  assert.equal(targets.alpha.runs, 2);
  assert.equal(targets.alpha.last.calls, 3);
  assert.deepEqual(targets.alpha.diff.metrics, { score: 0, n: 0 });
  assert.equal(targets.beta.last, null);
  f.out.length = 0;
  assert.equal(await runEval(["--last", "alpha", "beta"], f.deps), 0);
  assert.match(f.out.join("\n"), /^alpha: .*\n +previous +last +change\nspend .*\ncalls +3 +3 +0\nscore +0\.5 +0\.5 +0\nn +3 +3 +0\nbeta: no recorded runs/u);
});
