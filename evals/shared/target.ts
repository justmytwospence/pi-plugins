// The shape of an eval target: the one thing every eval is. Node builtins and sibling imports only,
// no imports from any package (scripts/test-contracts.mjs holds this directory to that).
//
// An eval lives in `packages/<pkg>/eval/<id>.target.ts` as the default export of `defineEval({...})`
// and is listed in `evals/targets.ts`. The runner (`runner.ts`, `npm run -s eval`) does everything
// else: choosing targets, skipping without TypeSafe credentials, sampling sessions once per run,
// printing the report and the spend, appending a results record, and the exit code. A target holds
// only what is specific to it: how many calls it would make (`plan`) and what it measures (`run`).
//
// What a target does with Jev is its own: it imports its package's `askJev` and questions and calls
// them with `ctx.registry`. It adds every call to `ctx.spend`, as `ctx.spend.addOutcome(outcome)`
// (the outcome's `usage?.cost?.total`; a failed outcome counts as a call and adds nothing), or merges
// the Spend of a sub-run in with `ctx.spend.merge(other)`. The runner prints `ctx.spend.line()` and
// records `ctx.spend.total` and `ctx.spend.calls`. A target never prints the spend line or writes the
// results history itself.
import type { pool } from "./pool.ts";
import type { Sample } from "./sessions.ts";
import type { Spend } from "./spend.ts";
import type { table } from "./table.ts";

/** In-flight Jev calls per target (the `pool` limit the evals ran with). */
export const CONCURRENCY = 8;
/** Per-call Jev timeout in milliseconds that the evals ran with. */
export const TIMEOUT_MS = 20_000;
/** A target fails when at least this share of its Jev calls fail (no usable answer). */
export const MAX_FAILURE_RATE = 0.2;

/** True when `failures` out of `calls` is under the limit; a target that made no call passes. */
export function withinFailureLimit(failures: number, calls: number, limit = MAX_FAILURE_RATE): boolean {
  return calls === 0 || failures / calls < limit;
}

/** `cases`: hand-written examples. `replay`: the user's real sessions (the runner samples them). */
export type TargetKind = "cases" | "replay";

/** What `plan` returns: the Jev calls a run would make, and a one-line explanation of the count. */
export interface Plan {
  calls: number;
  notes: string;
}

/** What every target gets, in the dry run and the live run. */
export interface PlanContext {
  /**
   * The sampled sessions (`sampleSessions`: EVAL_SEED, EVAL_SAMPLE, EVAL_RECENT, EVAL_MIN_PROMPTS,
   * EVAL_MIN_TOOLS), the same object for every target of one runner invocation; it prints its summary
   * line once. Call it only when the target replays sessions.
   */
  sample(): Sample;
  /** EVAL_COMPARE=1: also run the old behaviour (a target that has none ignores it). */
  compare: boolean;
  /** The environment the runner was started with, for any other EVAL_* variable a target reads. */
  env: NodeJS.ProcessEnv;
  /** One line of progress or a note. Goes to stderr under `--json`, else stdout. */
  log(message: string): void;
}

/** What a live run adds: the Jev registry and the shared helpers, so a target imports nothing shared. */
export interface RunContext extends PlanContext {
  /** Pi's model registry (`installedRegistry`), built once per runner invocation; pass it to the package's `askJev`. */
  registry: unknown;
  /** This target's own accumulator; see the header. */
  spend: Spend;
  /** `pool(items, concurrency, fn)`: run `fn` over the items with a bounded number in flight. */
  pool: typeof pool;
  /** `table(rows)`: columns padded to their widest cell. */
  table: typeof table;
  /** `CONCURRENCY`, the number of Jev calls to keep in flight. */
  concurrency: number;
  /** `TIMEOUT_MS`, the per-call timeout to give `askJev`. */
  timeoutMs: number;
}

/** What `run` returns; the runner prints `report`, records the numbers and turns `pass` into the exit code. */
export interface TargetResult {
  /** The numbers worth comparing between runs: a flat object of finite numbers (the results history). */
  metrics: Record<string, number>;
  /** The same numbers for the old behaviour, when `ctx.compare` ran it. */
  compare?: Record<string, number>;
  /** What to print: the tables and text, without the spend line (the runner adds it). */
  report: string;
  /** Whether the target met its own thresholds (`withinFailureLimit` for the Jev failure rate). */
  pass: boolean;
  /** Calls that gave no usable answer; printed and returned with the run, not recorded in the history. */
  failures?: number;
}

export interface EvalTarget {
  /** Kebab-case and unique across all targets; also the name of `evals/results/<id>.jsonl`. Not a package name. */
  id: string;
  /** One line for pickers and listings. */
  title: string;
  /** The package directory name under `packages/`, e.g. `pi-auto-effort`. */
  package: string;
  kind: TargetKind;
  /**
   * Whether the target reads `ctx.sample()`, so a dry run samples sessions only for those. Default:
   * `kind === "replay"`. Set it to false for a replay of something else (a file).
   */
  needsSessions?: boolean;
  /** The dry run: what a live run would call, without calling Jev (or anything that costs). */
  plan(ctx: PlanContext): Plan | Promise<Plan>;
  /** The live run. Throwing counts as a failed target; the runner reports it and goes on to the next. */
  run(ctx: RunContext): Promise<TargetResult>;
}

/** Identity: gives a target literal its type and checks it. */
export function defineEval(target: EvalTarget): EvalTarget {
  return target;
}

/** Whether a dry run must sample sessions for this target. */
export function needsSessions(target: Pick<EvalTarget, "kind" | "needsSessions">): boolean {
  return target.needsSessions ?? target.kind === "replay";
}

/** `pi-auto-effort` and `auto-effort` both name that package. */
export function shortPackage(name: string): string {
  return name.replace(/^pi-/u, "");
}

/** Throws on a malformed list: a bad or repeated id, an id that is also a package name, a bad kind. */
export function validateTargets(targets: readonly EvalTarget[]): void {
  const ids = new Set<string>();
  const packages = new Set(targets.flatMap((t) => [t.package, shortPackage(t.package)]));
  for (const t of targets) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(t.id)) throw new Error(`eval target id must be kebab-case: ${JSON.stringify(t.id)}`);
    if (ids.has(t.id)) throw new Error(`duplicate eval target id: ${t.id}`);
    ids.add(t.id);
    if (t.id === "all") throw new Error('eval target id "all" is reserved: it selects every target');
    if (packages.has(t.id)) throw new Error(`eval target id ${t.id} is also a package name; ids and packages are both selectors`);
    if (!t.package) throw new Error(`eval target ${t.id} has no package`);
    if (t.kind !== "cases" && t.kind !== "replay") throw new Error(`eval target ${t.id} has kind ${String(t.kind)}`);
    if (typeof t.plan !== "function" || typeof t.run !== "function") throw new Error(`eval target ${t.id} needs plan() and run()`);
  }
}
