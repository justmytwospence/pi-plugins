import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { last, record } from "./results.ts";
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
    alpha: { kind: "cases", calls: 4, logicalCalls: 4, attemptMultiplier: 1, maxAttempts: 4, notes: "four" },
    beta: { kind: "replay", calls: 10, logicalCalls: 10, attemptMultiplier: 1, maxAttempts: 10, notes: "compared" },
    gamma: { kind: "replay", calls: 1, logicalCalls: 1, attemptMultiplier: 1, maxAttempts: 1, notes: "one per session" },
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
  assert.match(f.out.join("\n"), /bad: plan failed: no plan\nalpha: 4 calls \(four\); .*\nestimate only: 4 calls/u);
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
  assert.match(out, /== alpha: Alpha cases \(pi-one, cases\) ==\nreport of alpha\nspend: \$0\.0030 over 3 calls \(catalog estimate; not a cash charge or verified credit debit\)\nrecorded: .*alpha\.jsonl/u);
  assert.match(out, /report of gamma\nspend: \$0\.0030 over 3 calls \(catalog estimate; not a cash charge or verified credit debit\); failures: 2/u);
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
  assert.match(f.out.join("\n"), /spend: \$0\.0100 over 1 calls \(catalog estimate; not a cash charge or verified credit debit\)\nFAIL boom/u);
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
  assert.match(f.err.join("\n"), /cannot build or configure the Jev registry/u);
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
  assert.match(f.out.join("\n"), /^alpha: .*\nconfigured policy: legacy\/unknown\nactual providers .*\nwarning: .*\n +previous +last +change\nspend .*\ncalls +3 +3 +0\nscore +0\.5 +0\.5 +0\nn +3 +3 +0\nbeta: no recorded runs/u);
});

const DECISIONS = { backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna" };
const JEV = { backend: "jev", provider: "typesafe", model: "jev-latest" };
function selectedClassifier(f: Fake, configured = true) {
  let checks = 0;
  let key = JSON.stringify(Object.values(DECISIONS));
  f.deps.classifier = {
    ...DECISIONS, key,
    currentKey: () => key,
    configured: async (registry) => {
      checks++;
      assert.deepEqual(registry, { fake: "registry" });
      return configured;
    },
  };
  delete f.deps.hasCredentials;
  return { checks: () => checks, change: () => { key = "other target"; } };
}

test("the selected provider predicate replaces the TypeSafe environment gate and records policy, not a winner", async () => {
  const f = fixture();
  const c = selectedClassifier(f);
  assert.equal(await runEval(["alpha", "--json"], f.deps), 0);
  assert.equal(c.checks(), 1);
  assert.equal(f.registries, 1);
  const policy = { waterfall: [DECISIONS.backend], targets: [DECISIONS], key: f.deps.classifier!.key };
  assert.deepEqual(json(f.out).configuredPolicy, policy);
  assert.deepEqual(json(f.out).targets.alpha.configuredPolicy, policy);
  assert.deepEqual(last("alpha", 1, f.env)[0]?.configuredPolicy, policy);
  assert.equal(last("alpha", 1, f.env)[0]?.classifier, undefined);
  assert.deepEqual(f.runs[0]?.ctx.classifier, policy);
  assert.match(f.err.join("\n"), /System 1: openai-decisions \(system1-openai\/gpt-6-luna\)/u);
});

test("a configured Jev provider also need not use an environment key", async () => {
  const f = fixture();
  selectedClassifier(f);
  Object.assign(f.deps.classifier!, JEV);
  assert.equal(await runEval(["alpha"], f.deps), 0);
  assert.equal(f.runs.length, 1);
});

test("missing selected-provider auth skips without falling back to a TypeSafe env key", async () => {
  const f = fixture({ env: { TYPESAFE_API_KEY: "fake-unrelated-key" } });
  const c = selectedClassifier(f, false);
  assert.equal(await runEval(["alpha", "--json"], f.deps), 0);
  assert.equal(c.checks(), 1);
  assert.equal(f.runs.length + f.samples, 0);
  assert.equal(json(f.out).skipped, true);
  assert.match(json(f.out).reason, /openai-decisions.*is not configured/u);
});

test("dry, list and last expose selection without registry, configured-auth or model calls", async () => {
  for (const mode of ["--dry", "--list", "--last"]) {
    const f = fixture();
    const c = selectedClassifier(f);
    f.deps.registry = async () => { throw new Error("must not construct registry"); };
    f.deps.classifier!.configured = async () => { throw new Error("must not inspect credentials"); };
    f.deps.classifier!.currentKey = () => { throw new Error("live-only recheck"); };
    assert.equal(await runEval(["alpha", mode, "--json"], f.deps), 0);
    assert.equal(c.checks() + f.registries + f.runs.length, 0);
    const output = json(f.out);
    assert.deepEqual(mode === "--list" ? output[0].configuredPolicy : output.configuredPolicy,
      { waterfall: [DECISIONS.backend], targets: [DECISIONS], key: f.deps.classifier!.key });
  }
});

test("explicit hasCredentials remains an offline override even with selected-provider injection", async () => {
  for (const credentials of [false, true]) {
    const f = fixture();
    const c = selectedClassifier(f);
    f.deps.hasCredentials = credentials;
    assert.equal(await runEval(["alpha"], f.deps), 0);
    assert.equal(c.checks(), 0);
    assert.equal(f.runs.length, credentials ? 1 : 0);
    assert.equal(f.registries, credentials ? 1 : 0);
  }
});

test("a selection changed before registry/auth stops safely", async () => {
  const f = fixture();
  const c = selectedClassifier(f);
  c.change();
  assert.equal(await runEval(["all", "--json"], f.deps), 1);
  assert.equal(f.registries + c.checks() + f.runs.length, 0);
  assert.match(json(f.out).stopped, /System 1 changed/u);
});

test("a selection changed while auth was checked never starts a target", async () => {
  const f = fixture();
  const c = selectedClassifier(f);
  f.deps.classifier!.configured = async () => { c.change(); return true; };
  assert.equal(await runEval(["all"], f.deps), 1);
  assert.equal(f.runs.length, 0);
});

test("selection changes during a target discard its metrics, retain failed-outcome spend, and stop", async () => {
  const f = fixture();
  const c = selectedClassifier(f);
  const first = f.deps.targets[0]!;
  f.deps.targets = [{ ...first, run: async (ctx) => {
    ctx.spend.addOutcome({ ok: false, usage: { cost: { total: 0.025 } } });
    c.change();
    return { metrics: { score: 1 }, report: "must not present stale success", pass: true };
  } }, ...f.deps.targets.slice(1)];
  assert.equal(await runEval(["all", "--json"], f.deps), 1);
  assert.equal(f.runs.length, 0);
  const output = json(f.out);
  assert.equal(output.spend, 0.025);
  assert.equal(output.calls, 1);
  assert.equal(output.targets.alpha.discarded, true);
  assert.deepEqual(output.targets.alpha.metrics, {});
  assert.equal(output.targets.alpha.pass, false);
  assert.deepEqual(Object.keys(output.targets), ["alpha"]);
  assert.deepEqual(last("alpha", 1, f.env), []);
  assert.doesNotMatch(f.err.join("\n"), /must not present stale success/u);
});

test("selection is rechecked between targets, after the previous record was saved", async () => {
  const f = fixture();
  const c = selectedClassifier(f);
  const out = f.deps.io!.out;
  f.deps.io!.out = (line) => { out(line); if (line.startsWith("recorded:")) c.change(); };
  assert.equal(await runEval(["all"], f.deps), 1);
  assert.deepEqual(f.runs.map((r) => r.id), ["alpha"]);
  assert.equal(last("alpha", 1, f.env).length, 1);
  assert.equal(last("beta", 1, f.env).length, 0);
});

test("the CLI dry/list/last bootstrap reads the same global backend without loading an SDK or auth", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-cli-offline-"));
  try {
    for (const backend of ["jev", "openai-decisions"]) {
      writeFileSync(path.join(dir, "system1.json"), JSON.stringify({ backend }));
      for (const mode of ["--dry", "--list", "--last"]) {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/eval.mjs", import.meta.url)), "guard", mode, "--json"], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_PACKAGE_DIR: path.join(dir, "sdk-must-not-load"), EVAL_RESULTS_DIR: path.join(dir, "results") },
          timeout: 20_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        const policy = mode === "--list" ? output[0].configuredPolicy : output.configuredPolicy;
        assert.deepEqual(policy.waterfall, [backend]);
        assert.equal(policy.targets[0].backend, backend);
        assert.equal(policy.targets[0].provider, backend === "jev" ? "typesafe" : "system1-openai");
        assert.equal(output.classifier, undefined);
        assert.match(result.stderr, new RegExp(`System 1: ${backend}`, "u"));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the injected local predicate accepts any configured rung and ignores optional registration failure", async () => {
  const module = new URL("../../scripts/eval.mjs", import.meta.url).href;
  const { createEvalClassifier, prepareEvalRegistry } = await import(module);
  for (const targets of [[JEV, DECISIONS], [DECISIONS, JEV]]) {
    const lookups: string[] = [];
    const auth: string[] = [];
    let registrations = 0;
    const registry = {
      findOfType: (_type: string, provider: string, id: string) => {
        lookups.push(provider);
        return { id, api: provider === "system1-openai" ? "openai-decisions" : "typesafe-system-one", baseUrl: "https://api.openai.com/v1" };
      },
      getProviderAuthStatus: (provider: string) => { auth.push(provider); return { configured: provider === targets[1].provider }; },
    };
    assert.equal(await prepareEvalRegistry(registry, async () => { registrations++; throw new Error("SECRET registration body"); }), registry);
    assert.equal(registrations, 1);
    const classifier = createEvalClassifier({ ok: true, waterfall: targets.map((t) => t.backend), targets, key: "chain" }, () => "chain");
    assert.equal(await classifier.configured(registry), true);
    assert.deepEqual(auth, targets.map((t) => t.provider));
    assert.deepEqual(lookups, targets.map((t) => t.provider));
  }
});

test("mixed policy planning and live results separate policy, attempts and actual winner", async () => {
  const f = fixture();
  const policy = { waterfall: ["jev", "openai-decisions"], targets: [JEV, DECISIONS], key: "full-chain" };
  f.deps.classifier = { ...policy, currentKey: () => policy.key, configured: async () => true };
  delete f.deps.hasCredentials;
  const attempts = [
    { ...JEV, status: "failed", code: "quota_exhausted", sdkCalls: 1, usage: { cost: { total: 0.02 } } },
    { ...DECISIONS, status: "succeeded", sdkCalls: 1, usage: { cost: { total: 0.01 } } },
  ];
  f.deps.targets = [defineEval({ id: "waterfall", title: "Waterfall", package: "pi-one", kind: "cases",
    plan: (ctx) => { assert.deepEqual(ctx.classifier, policy); return { calls: 72, notes: "fixed count" }; },
    run: async (ctx) => {
      assert.deepEqual(ctx.classifier, policy);
      ctx.spend.addOutcome({ ok: true, ...DECISIONS, waterfall: policy.waterfall, fallback: true, attempts, usage: { cost: { total: 0.03 } } });
      return { metrics: { score: 1 }, report: "fallback succeeded", pass: true };
    },
  })];
  assert.equal(await runEval(["waterfall", "--dry", "--json"], f.deps), 0);
  const dry = json(f.out);
  assert.deepEqual(dry.configuredPolicy, policy);
  assert.equal(dry.classifier, undefined);
  assert.equal(dry.logicalCalls, 72);
  assert.equal(dry.maxAttempts, 144);
  assert.equal(dry.attemptMultiplier, 2);
  assert.equal(dry.estimate.calls, 144);
  assert.equal(f.registries, 0);
  // Optional targets-only policy metadata still describes both rungs.
  delete f.deps.classifier!.waterfall;
  f.out.length = 0;
  assert.equal(await runEval(["waterfall", "--dry", "--json"], f.deps), 0);
  assert.equal(json(f.out).maxAttempts, 144);
  f.deps.classifier!.waterfall = policy.waterfall;
  f.out.length = 0;
  assert.equal(await runEval(["waterfall", "--json"], f.deps), 0);
  const live = json(f.out);
  assert.equal(live.stopped, undefined);
  assert.equal(live.calls, 1);
  assert.equal(live.registryCalls, 2);
  assert.equal(live.spend, 0.03);
  assert.deepEqual(live.backendAttempts, { jev: 1, "openai-decisions": 1 });
  assert.deepEqual(live.actualProviders, { [JSON.stringify(Object.values(DECISIONS))]: 1 });
  assert.equal(live.attempts.length, 2);
  const saved = last("waterfall", 1, f.env)[0];
  assert.deepEqual(saved.configuredPolicy, policy);
  assert.deepEqual(saved.actualProviders, live.actualProviders);
  assert.equal(saved.classifier, undefined);
  assert.equal(saved.calls, 1);
  assert.equal(saved.registryCalls, 2);
});

test("editing a later rung during live bootstrap stops before classification", async () => {
  const f = fixture();
  let key = "jev-openai";
  f.deps.classifier = { waterfall: ["jev", "openai-decisions"], targets: [JEV, DECISIONS], key,
    currentKey: () => key, configured: async () => { key = "jev-only"; return true; } };
  delete f.deps.hasCredentials;
  assert.equal(await runEval(["alpha", "--json"], f.deps), 1);
  assert.equal(f.runs.length, 0);
  assert.match(json(f.out).stopped, /System 1 changed/u);
});

test("mixed CLI dry/list/last never load a registry, auth or models", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-cli-mixed-"));
  try {
    for (const waterfall of [["jev", "openai-decisions"], ["openai-decisions", "jev"]]) {
      writeFileSync(path.join(dir, "system1.json"), JSON.stringify({ waterfall, backend: waterfall[0] }));
      for (const mode of ["--dry", "--list", "--last"]) {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/eval.mjs", import.meta.url)), "guard", mode, "--json"], {
          encoding: "utf8", timeout: 20_000,
          env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_PACKAGE_DIR: path.join(dir, "sdk-must-not-load"), EVAL_RESULTS_DIR: path.join(dir, "results") },
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.deepEqual((mode === "--list" ? output[0] : output).configuredPolicy.waterfall, waterfall);
        assert.equal(output.classifier, undefined);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("credential/bootstrap errors never echo raw provider bodies", async () => {
  const f = fixture();
  selectedClassifier(f);
  f.deps.classifier!.configured = async () => { throw new Error("SECRET provider body"); };
  assert.equal(await runEval(["alpha"], f.deps), 1);
  assert.doesNotMatch(f.err.join("\n"), /SECRET/u);
});

test("last warns and suppresses numeric deltas across backends and legacy/known runs", async () => {
  for (const classifier of [undefined, JEV, { ...DECISIONS, model: "another-model" }]) {
    const f = fixture();
    selectedClassifier(f);
    record("alpha", { classifier, spend: 1, calls: 2, metrics: { score: 0.1 } }, f.env);
    record("alpha", { classifier: DECISIONS, spend: 2, calls: 3, metrics: { score: 0.8 } }, f.env);
    assert.equal(await runEval(["alpha", "--last", "--json"], f.deps), 0);
    const compared = json(f.out).targets.alpha;
    assert.deepEqual(compared.diff, {});
    assert.equal(typeof compared.warning, "string");
    f.out.length = 0;
    assert.equal(await runEval(["alpha", "--last"], f.deps), 0);
    assert.match(f.out.join("\n"), /warning: /u);
    assert.match(f.out.join("\n"), /score +0\.1 +0\.8 +-\n?/u);
  }
});
