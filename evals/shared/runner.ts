// The eval runner: `runEval(argv, deps)` behind `npm run -s eval` (scripts/eval.mjs is a thin CLI over
// it, so tests call it with fakes instead of spawning a process). Node builtins and siblings only.
//
//   npm run -s eval -- [<id|package|all>...] [--package <pkg>] [--dry | --list | --last] [--json]
//
//   (default)  live run: skipped with exit 0 when the selected classifier is unconfigured; else targets
//              one after another (each target's own concurrency is its `ctx.pool`): the report, then
//              `spend: $X over N calls`, then a record in evals/results/<id>.jsonl. Exit 1 when any
//              target's `pass` is false (or it threw). A live run must name what to run.
//   --dry      what each target would call, without inference: samples sessions once for targets that
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
import { comparisonWarning, diffRecords, last, record, resultsDir, type ConfiguredClassifierPolicy, type ResultRecord } from "./results.ts";
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
  /** Builds the classifier registry once per live run (default: `installedRegistry`, Pi's own). */
  registry?: () => Promise<unknown>;
  /** Default `process.env`; the EVAL_* variables, TYPESAFE_API_KEY and EVAL_RESULTS_DIR are read from it. */
  env?: NodeJS.ProcessEnv;
  /** Explicit offline/backwards-compatible override; otherwise use classifier.configured or TYPESAFE_API_KEY. */
  hasCredentials?: boolean;
  /** Injected by the CLI, never imported from a component here. Omit for legacy direct runner use. */
  classifier?: ConfiguredClassifierPolicy & {
    key: string;
    configured(registry: unknown): Promise<boolean>;
    /** Re-read the effective global target, without auth or inference; checked around every target. */
    currentKey?(): string;
    /** Safe explanation for an unavailable setting/capability. */
    reason?: string;
  };
  /** Default: `sampleSessions({ env, log })`. */
  sample?: (log: (line: string) => void) => Sample;
  /** Default: `console.log` and `console.error`. */
  io?: RunnerIO;
}

const USAGE = `usage: npm run -s eval -- [<id|package|all>...] [--package <pkg>] [--dry | --list | --last] [--json]
  (default) run targets live against the global System 1 backend (API usage); skipped without configured auth
  --dry     what they would call, without inference or auth, and a catalog-cost estimate
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
    if (deps.classifier) say(`System 1: ${classifierLabel(deps.classifier)}${deps.classifier.reason ? `; unavailable: ${deps.classifier.reason}` : ""}`);
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

const configuredPolicy = (deps: RunnerDeps): ConfiguredClassifierPolicy | undefined => {
  const c = deps.classifier;
  if (!c) return undefined;
  const targets = c.targets ?? (c.backend && c.provider && c.model ? [{ backend: c.backend, provider: c.provider, model: c.model }] : []);
  return { waterfall: c.waterfall ? [...c.waterfall] : targets.map((t) => t.backend), targets: targets.map((t) => ({ ...t })), key: c.key };
};
const classifierLabel = (c: ConfiguredClassifierPolicy) => c.waterfall
  ? (c.waterfall.join(" → ") || "unavailable") + (c.targets?.length ? ` (${c.targets.map((t) => `${t.provider}/${t.model}`).join(" → ")})` : "")
  : `${c.backend} (${c.provider}/${c.model})`;
// Never label configured metadata as the observed physical classifier, even for legacy injection.
const classifierJSON = (deps: RunnerDeps) => deps.classifier ? { configuredPolicy: configuredPolicy(deps) } : {};
const attemptMultiplier = (deps: RunnerDeps) => Math.max(1, deps.classifier?.waterfall?.length ?? deps.classifier?.targets?.length ?? 1);
const selectionChanged = (deps: RunnerDeps): boolean => {
  try {
    return deps.classifier?.currentKey !== undefined && deps.classifier.currentKey() !== deps.classifier.key;
  } catch {
    return true;
  }
};
const CHANGED = "System 1 changed during the eval; stopped to avoid mixing classifiers. Retry the run.";

function list({ options, selected, io, deps }: Ctx): number {
  if (options.json) io.out(JSON.stringify(selected.map(({ id, title, package: pkg, kind }) => ({ id, title, package: pkg, kind, ...classifierJSON(deps) }))));
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
    classifier: configuredPolicy(ctx.deps),
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
  const targets: Record<string, { kind: string; calls?: number; logicalCalls?: number; attemptMultiplier?: number; maxAttempts?: number; notes?: string; error?: string }> = {};
  const multiplier = attemptMultiplier(ctx.deps);
  let failed = false;
  for (const target of selected) {
    try {
      const plan = await target.plan(planContext(ctx, sampled, { sample: false }));
      targets[target.id] = { kind: target.kind, calls: plan.calls, logicalCalls: plan.calls, attemptMultiplier: multiplier, maxAttempts: plan.calls * multiplier, notes: plan.notes };
      say(`${target.id}: ${plan.calls} calls (${plan.notes}); ${plan.calls} logical calls, up to ${plan.calls * multiplier} backend attempts (${multiplier} configured rungs per request)`);
    } catch (error) {
      failed = true;
      targets[target.id] = { kind: target.kind, error: message(error) };
      say(`${target.id}: plan failed: ${message(error)}`);
    }
  }
  const totalCalls = Object.values(targets).reduce((n, t) => n + (t.calls ?? 0), 0);
  const cost = estimate(totalCalls * multiplier, env);
  say(`${cost.note}: $${cost.usd.low.toFixed(4)} to $${cost.usd.high.toFixed(4)}`);
  const sample = sampled.peek();
  if (options.json) io.out(JSON.stringify({ ...classifierJSON(ctx.deps), seed: sample?.seed ?? null, sessions: sample?.sessions.map(summarizeSession) ?? [], targets, totalCalls, logicalCalls: totalCalls, attemptMultiplier: multiplier, maxAttempts: totalCalls * multiplier, estimate: cost }));
  return failed ? 1 : 0;
}

async function live(ctx: Ctx): Promise<number> {
  const { options, selected, io, say, env, deps } = ctx;
  const skip = (reason: string) => {
    say(`skipped: ${reason} (${selected.map((t) => t.id).join(", ")})`);
    if (options.json) io.out(JSON.stringify({ ...classifierJSON(deps), skipped: true, reason, targets: {} }));
    return 0;
  };
  const stop = () => {
    io.err(CHANGED);
    if (options.json) io.out(JSON.stringify({ ...classifierJSON(deps), pass: false, stopped: CHANGED, spend: 0, calls: 0, targets: {} }));
    return 1;
  };
  if (selectionChanged(deps)) return stop();
  // Preserve the old no-registry fast path for direct callers and explicit test overrides.
  const credentials = deps.hasCredentials ?? (deps.classifier ? undefined : Boolean(env.TYPESAFE_API_KEY?.trim()));
  if (credentials === false) return skip(deps.classifier
    ? `${classifierLabel(deps.classifier)} is not configured; nothing ran`
    : "TYPESAFE_API_KEY is not set; the evals call Jev live, so nothing ran");
  let registry: unknown;
  try {
    registry = await (deps.registry ?? (async () => (await import("./registry.ts")).installedRegistry()))();
    if (selectionChanged(deps)) return stop();
    if (credentials === undefined && deps.classifier && !await deps.classifier.configured(registry)) {
      if (selectionChanged(deps)) return stop();
      return skip(`${classifierLabel(deps.classifier)} is not configured${deps.classifier.reason ? `: ${deps.classifier.reason}` : ""}; nothing ran`);
    }
  } catch {
    // Provider/auth exceptions may contain credential material; do not echo their bodies.
    io.err(`cannot build or configure the ${deps.classifier ? classifierLabel(deps.classifier) : "Jev"} registry`);
    return 1;
  }
  if (selectionChanged(deps)) return stop();
  const sampled = sampler(ctx);
  if (selected.some(needsSessions)) sampled.get();
  const outcomes: Record<string, unknown> = {};
  const failed: string[] = [];
  const total = new Spend();
  let stopped: string | undefined;
  for (const target of selected) {
    if (selectionChanged(deps)) {
      stopped = CHANGED;
      io.err(stopped);
      break;
    }
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
    if (selectionChanged(deps)) {
      stopped = CHANGED;
      error = stopped;
    }
    if (result && !stopped) say(result.report);
    say(`${spend.line()}${result?.failures !== undefined ? `; failures: ${result.failures}` : ""}`);
    if (result && !stopped) {
      const metrics = finite(result.metrics) ?? {};
      const compare = finite(result.compare);
      const seed = used.sample || needsSessions(target) ? (sampled.peek()?.seed ?? null) : null;
      try {
        record(target.id, { ...classifierJSON(deps), ...spend.audit(), seed, spend: spend.total, calls: spend.calls, metrics, ...(compare ? { compare } : {}) }, env);
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
      ...classifierJSON(deps),
      ...(stopped ? { discarded: true } : {}),
      kind: target.kind,
      pass,
      ...(result?.failures !== undefined ? { failures: result.failures } : {}),
      spend: spend.total,
      calls: spend.calls,
      ...spend.audit(),
      metrics: stopped ? {} : result?.metrics ?? {},
      ...(!stopped && result?.compare ? { compare: result.compare } : {}),
      ...(error ? { error } : {}),
    };
    if (stopped) break;
  }
  if (selected.length > 1) say(`\n${Object.keys(outcomes).length - failed.length}/${selected.length} targets passed${failed.length ? ` (failed: ${failed.join(", ")})` : ""}; total ${total.line()}`);
  if (options.json) io.out(JSON.stringify({ ...classifierJSON(deps), ...(stopped ? { stopped } : {}), seed: sampled.peek()?.seed ?? null, pass: !failed.length && !stopped, spend: total.total, calls: total.calls, ...total.audit(), targets: outcomes }));
  return failed.length || stopped ? 1 : 0;
}

function lastRuns({ options, selected, io, env, deps }: Ctx): number {
  const found: Record<string, { runs: number; last: ResultRecord | null; previous: ResultRecord | null; diff: unknown; warning?: string }> = {};
  for (const target of selected) {
    const records = last(target.id, 2, env);
    const next = records.at(-1) ?? null;
    const prev = records.length > 1 ? (records[0] ?? null) : null;
    const warning = next && prev ? comparisonWarning(prev, next) : undefined;
    found[target.id] = { runs: records.length, last: next, previous: prev, diff: next && prev ? diffRecords(prev, next) : null, ...(warning ? { warning } : {}) };
  }
  if (options.json) {
    io.out(JSON.stringify({ ...classifierJSON(deps), targets: found }));
    return 0;
  }
  for (const [id, { runs, last: next, previous: prev, warning }] of Object.entries(found)) {
    if (!next) {
      io.out(`${id}: no recorded runs`);
      continue;
    }
    io.out(`${id}: ${next.at}, commit ${next.commit}${next.dirty ? " (dirty)" : ""}, seed ${next.seed ?? "-"}, ${runs} run${runs === 1 ? "" : "s"} kept for the comparison`);
    io.out(`configured policy: ${next.configuredPolicy ? classifierLabel(next.configuredPolicy) : next.classifier ? classifierLabel(next.classifier) : "legacy/unknown"}`);
    if (next.actualProviders) io.out(`actual providers (successful logical judgments): ${JSON.stringify(next.actualProviders)}`);
    if (warning) io.out(`warning: ${warning}`);
    const comparable = prev && Object.keys(diffRecords(prev, next)).length > 0;
    const rows: (string | number)[][] = [["", ...(prev ? ["previous"] : []), "last", ...(prev ? ["change"] : [])]];
    const add = (label: string, a: number | undefined, b: number | undefined) =>
      rows.push([label, ...(prev ? [a ?? "-"] : []), b ?? "-", ...(prev ? [comparable && a !== undefined && b !== undefined ? Math.round((b - a) * 1e9) / 1e9 : "-"] : [])]);
    add("spend", prev?.spend, next.spend);
    add("calls", prev?.calls, next.calls);
    for (const key of Object.keys(next.metrics)) add(key, prev?.metrics[key], next.metrics[key]);
    for (const key of Object.keys(next.compare ?? {})) add(`compare.${key}`, prev?.compare?.[key], next.compare?.[key]);
    io.out(table(rows));
  }
  return 0;
}
