// The eval runner: `runEval(argv, deps)` behind `npm run -s eval` (scripts/eval.mjs is a thin CLI over
// it, so tests call it with fakes instead of spawning a process). Node builtins and siblings only.
//
//   npm run -s eval -- [<id|package|all>...] [--package <pkg>] [--dry | --list | --last] [--json]
//
//   (default)  live run: skipped with exit 0 when TYPESAFE_API_KEY is unset; else the selected targets
//              one after another (each target's own concurrency is its `ctx.pool`): the report, then
//              `spend: $X over N calls`, then a record in evals/results/<id>.jsonl. Exit 1 when any
//              target's `pass` is false (or it threw). A live run must name what to run.
//   --dry      what each target would call, without Jev: samples sessions once for the targets that
//              need them, then each `plan()`, and a spend estimate.
//   --list     the targets (id, title, package, kind).
//   --last     the last recorded run of each target and its numeric difference from the one before.
//   --json     ONE JSON object on stdout (an array for --list); the human text goes to stderr.
//
// A selector is a target id, a package (`pi-auto-effort` or `auto-effort`) for all of its targets, or
// `all`. Environment: EVAL_SEED, EVAL_SAMPLE, EVAL_RECENT, EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS (the session
// sampler), EVAL_COMPARE=1, EVAL_COST_PER_CALL, EVAL_RESULTS_DIR, and whatever else a target reads.
// Exit codes: 0 done or skipped, 1 a target failed, 2 a usage error (including an unknown id).
import path from "node:path";
import { installedRegistry } from "./registry.ts";
import { diffRecords, last, record, resultsDir, type ResultRecord } from "./results.ts";
import { pool } from "./pool.ts";
import { type Sample, sampleSessions, summarizeSession } from "./sessions.ts";
import { Spend, estimate } from "./spend.ts";
import { table } from "./table.ts";
import { CONCURRENCY, type EvalTarget, type PlanContext, type RunContext, TIMEOUT_MS, needsSessions, shortPackage, validateTargets } from "./target.ts";

export interface RunnerIO {
  out(line: string): void;
  err(line: string): void;
}

export interface RunnerDeps {
  targets: readonly EvalTarget[];
  /** Builds the Jev registry once per run (default: `installedRegistry`, Pi's own). */
  registry?: () => Promise<unknown>;
  /** Default `process.env`; the EVAL_* variables, TYPESAFE_API_KEY and EVAL_RESULTS_DIR are read from it. */
  env?: NodeJS.ProcessEnv;
  /** Default: whether `env.TYPESAFE_API_KEY` is set. */
  hasCredentials?: boolean;
  /** Default: `sampleSessions({ env, log })`. */
  sample?: (log: (line: string) => void) => Sample;
  /** Default: `console.log` and `console.error`. */
  io?: RunnerIO;
}

const USAGE = `usage: npm run -s eval -- [<id|package|all>...] [--package <pkg>] [--dry | --list | --last] [--json]
  (default) run the selected targets live against Jev (paid); skipped without TYPESAFE_API_KEY
  --dry     what they would call, without calling Jev, and a spend estimate
  --list    the targets
  --last    the last recorded run of each target and its change from the one before
  --json    one JSON object on stdout; text for humans goes to stderr`;

/** A mistake in the command line; `usage` adds the usage text to the message. */
class UsageError extends Error {
  usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.usage = usage;
  }
}

export type Mode = "run" | "dry" | "list" | "last";

export interface Options {
  mode: Mode;
  json: boolean;
  selectors: string[];
  packages: string[];
}

export function parseArgs(argv: readonly string[]): Options & { help: boolean } {
  const options = { mode: "run" as Mode, json: false, selectors: [] as string[], packages: [] as string[], help: false };
  const modes: Mode[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") options.json = true;
    else if (arg === "--dry" || arg === "--list" || arg === "--last") modes.push(arg.slice(2) as Mode);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--package" || arg.startsWith("--package=")) {
      const value = arg === "--package" ? argv[++i] : arg.slice("--package=".length);
      if (!value || value.startsWith("--")) throw new UsageError("--package needs a package name", true);
      options.packages.push(value);
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`, true);
    else options.selectors.push(arg);
  }
  if (new Set(modes).size > 1) throw new UsageError(`${modes.map((m) => `--${m}`).join(" and ")} cannot be combined`, true);
  if (modes[0]) options.mode = modes[0];
  return options;
}

/**
 * The targets named by `selectors` (an id, a package, or `all`) and `packages`, in list order and
 * without repeats. Throws a UsageError naming the known ids and packages for anything unknown.
 */
export function select(targets: readonly EvalTarget[], selectors: readonly string[], packages: readonly string[] = []): EvalTarget[] {
  const ids = targets.map((t) => t.id);
  const known = [...new Set(targets.map((t) => t.package))];
  const chosen = new Set<EvalTarget>();
  const inPackage = (name: string) => targets.filter((t) => shortPackage(t.package) === shortPackage(name));
  for (const selector of selectors) {
    if (selector === "all") targets.forEach((t) => chosen.add(t));
    else {
      const byId = targets.find((t) => t.id === selector);
      const byPackage = byId ? [] : inPackage(selector);
      if (!byId && !byPackage.length) throw new UsageError(`unknown eval target or package: ${selector}\nknown ids: ${ids.join(", ") || "(none)"}\nknown packages: ${known.join(", ") || "(none)"}`);
      if (byId) chosen.add(byId);
      byPackage.forEach((t) => chosen.add(t));
    }
  }
  for (const name of packages) {
    const found = inPackage(name);
    if (!found.length) throw new UsageError(`unknown package: ${name}\nknown packages: ${known.join(", ") || "(none)"}`);
    found.forEach((t) => chosen.add(t));
  }
  return targets.filter((t) => chosen.has(t));
}

const text = (rows: readonly (readonly string[])[]) => {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ").trimEnd()).join("\n");
};

const finite = (metrics: Record<string, number> | undefined) =>
  metrics ? Object.fromEntries(Object.entries(metrics).filter((e) => typeof e[1] === "number" && Number.isFinite(e[1]))) : undefined;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs the command in `argv` (what follows `eval --` on the command line) and returns the exit code. */
export async function runEval(argv: readonly string[], deps: RunnerDeps): Promise<number> {
  const io = deps.io ?? { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };
  const env = deps.env ?? process.env;
  try {
    validateTargets(deps.targets);
    const options = parseArgs(argv);
    if (options.help) {
      io.out(USAGE);
      return 0;
    }
    if (options.mode === "run" && !options.selectors.length && !options.packages.length) throw new UsageError("name what to run: an id, a package or all (a live run is paid)", true);
    const selected = select(deps.targets, options.selectors.length || options.packages.length ? options.selectors : ["all"], options.packages);
    const say = options.json ? io.err : io.out;
    const ctx = { options, selected, io, say, env, deps };
    if (options.mode === "list") return list(ctx);
    if (options.mode === "last") return lastRuns(ctx);
    return options.mode === "dry" ? await dry(ctx) : await live(ctx);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(error.usage ? `${error.message}\n${USAGE}` : error.message);
    return 2;
  }
}

interface Ctx {
  options: Options;
  selected: EvalTarget[];
  io: RunnerIO;
  say: (line: string) => void;
  env: NodeJS.ProcessEnv;
  deps: RunnerDeps;
}

function list({ options, selected, io }: Ctx): number {
  if (options.json) io.out(JSON.stringify(selected.map(({ id, title, package: pkg, kind }) => ({ id, title, package: pkg, kind }))));
  else io.out(text([["id", "title", "package", "kind"], ...selected.map((t) => [t.id, t.title, t.package, t.kind])]));
  return 0;
}

/** One memoized session sample per invocation, for the contexts of every target. */
function sampler({ env, deps, say }: Ctx) {
  let sample: Sample | undefined;
  return {
    get: () => (sample ??= (deps.sample ?? ((log) => sampleSessions({ env, log })))(say)),
    peek: () => sample,
  };
}

function planContext(ctx: Ctx, sampled: ReturnType<typeof sampler>, used: { sample: boolean }): PlanContext {
  return {
    sample: () => {
      used.sample = true;
      return sampled.get();
    },
    compare: ctx.env.EVAL_COMPARE === "1",
    env: ctx.env,
    log: ctx.say,
  };
}

async function dry(ctx: Ctx): Promise<number> {
  const { options, selected, io, say, env } = ctx;
  const sampled = sampler(ctx);
  if (selected.some(needsSessions)) sampled.get();
  const targets: Record<string, { kind: string; calls?: number; notes?: string; error?: string }> = {};
  let failed = false;
  for (const target of selected) {
    try {
      const plan = await target.plan(planContext(ctx, sampled, { sample: false }));
      targets[target.id] = { kind: target.kind, calls: plan.calls, notes: plan.notes };
      say(`${target.id}: ${plan.calls} calls (${plan.notes})`);
    } catch (error) {
      failed = true;
      targets[target.id] = { kind: target.kind, error: message(error) };
      say(`${target.id}: plan failed: ${message(error)}`);
    }
  }
  const totalCalls = Object.values(targets).reduce((n, t) => n + (t.calls ?? 0), 0);
  const cost = estimate(totalCalls, env);
  say(`${cost.note}: $${cost.usd.low.toFixed(4)} to $${cost.usd.high.toFixed(4)}`);
  const sample = sampled.peek();
  if (options.json) io.out(JSON.stringify({ seed: sample?.seed ?? null, sessions: sample?.sessions.map(summarizeSession) ?? [], targets, totalCalls, estimate: cost }));
  return failed ? 1 : 0;
}

async function live(ctx: Ctx): Promise<number> {
  const { options, selected, io, say, env, deps } = ctx;
  const credentials = deps.hasCredentials ?? Boolean(env.TYPESAFE_API_KEY?.trim());
  if (!credentials) {
    const reason = "TYPESAFE_API_KEY is not set; the evals call Jev live, so nothing ran";
    say(`skipped: ${reason} (${selected.map((t) => t.id).join(", ")})`);
    if (options.json) io.out(JSON.stringify({ skipped: true, reason, targets: {} }));
    return 0;
  }
  let registry: unknown;
  try {
    registry = await (deps.registry ?? installedRegistry)();
  } catch (error) {
    io.err(`cannot build the Jev registry: ${message(error)}`);
    return 1;
  }
  const sampled = sampler(ctx);
  if (selected.some(needsSessions)) sampled.get();
  const outcomes: Record<string, unknown> = {};
  const failed: string[] = [];
  const total = new Spend();
  for (const target of selected) {
    say(`\n== ${target.id}: ${target.title} (${target.package}, ${target.kind}) ==`);
    const used = { sample: false };
    const spend = new Spend();
    const runContext: RunContext = { ...planContext(ctx, sampled, used), registry, spend, pool, table, concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS };
    let result;
    let error: string | undefined;
    try {
      result = await target.run(runContext);
    } catch (thrown) {
      error = message(thrown);
    }
    total.merge(spend);
    if (result) say(result.report);
    say(`${spend.line()}${result?.failures !== undefined ? `; failures: ${result.failures}` : ""}`);
    let recorded: ResultRecord | undefined;
    if (result) {
      const metrics = finite(result.metrics) ?? {};
      const compare = finite(result.compare);
      const seed = used.sample || needsSessions(target) ? (sampled.peek()?.seed ?? null) : null;
      try {
        recorded = record(target.id, { seed, spend: spend.total, calls: spend.calls, metrics, ...(compare ? { compare } : {}) }, env);
        say(`recorded: ${path.join(resultsDir(env), `${target.id}.jsonl`)}`);
      } catch (thrown) {
        error = `could not record the run: ${message(thrown)}`;
      }
    }
    const pass = result?.pass === true && !error;
    if (error) io.err(`${target.id}: ${error}`);
    if (!pass) {
      failed.push(target.id);
      say(`FAIL ${target.id}`);
    }
    outcomes[target.id] = {
      kind: target.kind,
      pass,
      ...(result?.failures !== undefined ? { failures: result.failures } : {}),
      spend: spend.total,
      calls: spend.calls,
      metrics: result?.metrics ?? {},
      ...(result?.compare ? { compare: result.compare } : {}),
      ...(error ? { error } : {}),
    };
  }
  if (selected.length > 1) say(`\n${selected.length - failed.length}/${selected.length} targets passed${failed.length ? ` (failed: ${failed.join(", ")})` : ""}; total ${total.line()}`);
  if (options.json) io.out(JSON.stringify({ seed: sampled.peek()?.seed ?? null, pass: !failed.length, spend: total.total, calls: total.calls, targets: outcomes }));
  return failed.length ? 1 : 0;
}

function lastRuns({ options, selected, io, env }: Ctx): number {
  const found: Record<string, { runs: number; last: ResultRecord | null; previous: ResultRecord | null; diff: unknown }> = {};
  for (const target of selected) {
    const records = last(target.id, 2, env);
    const next = records.at(-1) ?? null;
    const prev = records.length > 1 ? (records[0] ?? null) : null;
    found[target.id] = { runs: records.length, last: next, previous: prev, diff: next && prev ? diffRecords(prev, next) : null };
  }
  if (options.json) {
    io.out(JSON.stringify({ targets: found }));
    return 0;
  }
  for (const [id, { runs, last: next, previous: prev }] of Object.entries(found)) {
    if (!next) {
      io.out(`${id}: no recorded runs`);
      continue;
    }
    io.out(`${id}: ${next.at}, commit ${next.commit}${next.dirty ? " (dirty)" : ""}, seed ${next.seed ?? "-"}, ${runs} run${runs === 1 ? "" : "s"} kept for the comparison`);
    const rows: (string | number)[][] = [["", ...(prev ? ["previous"] : []), "last", ...(prev ? ["change"] : [])]];
    const add = (label: string, a: number | undefined, b: number | undefined) =>
      rows.push([label, ...(prev ? [a ?? "-"] : []), b ?? "-", ...(prev ? [a !== undefined && b !== undefined ? Math.round((b - a) * 1e9) / 1e9 : "-"] : [])]);
    add("spend", prev?.spend, next.spend);
    add("calls", prev?.calls, next.calls);
    for (const key of Object.keys(next.metrics)) add(key, prev?.metrics[key], next.metrics[key]);
    for (const key of Object.keys(next.compare ?? {})) add(`compare.${key}`, prev?.compare?.[key], next.compare?.[key]);
    io.out(table(rows));
  }
  return 0;
}
