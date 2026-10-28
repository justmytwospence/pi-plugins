// The history of live eval runs, one JSON line per run in `evals/results/<target>.jsonl` (git-ignored).
// Node builtins only, no imports from any package.
//
// A record: `{ at, commit, dirty, seed, params, spend, calls, metrics, compare? }`
//   at       ISO time of the run
//   commit   `git rev-parse --short HEAD` of the repository, "unknown" outside a checkout
//   dirty    true when the working tree has uncommitted changes
//   seed     the EVAL_SEED the run printed
//   params   every EVAL_* variable that was set
//   spend    USD reported by the classifier (see spend.ts); calls = number of classifier calls
//   metrics  the numbers the eval prints, a flat object of numbers
//   compare  the same for the old behaviour, with EVAL_COMPARE=1
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Metrics = Record<string, number>;

export interface ResultRecord {
  at: string;
  commit: string;
  dirty: boolean;
  seed: number | null;
  params: Record<string, string>;
  spend: number;
  calls: number;
  metrics: Metrics;
  compare?: Metrics;
}

/** What an eval supplies; `at`, `commit`, `dirty` and `params` are filled in when omitted. */
export type ResultEntry = Pick<ResultRecord, "spend" | "calls" | "metrics"> & Partial<ResultRecord>;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

/** `evals/results` (override with `EVAL_RESULTS_DIR`, for tests). */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVAL_RESULTS_DIR?.trim() || path.join(here, "..", "results");
}

const fileOf = (target: string, env?: NodeJS.ProcessEnv) => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(target)) throw new Error(`bad results target: ${target}`);
  return path.join(resultsDir(env), `${target}.jsonl`);
};

/** The short HEAD and whether the tree is dirty. */
export function gitState(cwd = root): { commit: string; dirty: boolean } {
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
  try {
    return { commit: git("rev-parse", "--short", "HEAD").trim(), dirty: git("status", "--porcelain").trim() !== "" };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

/** Every `EVAL_*` variable that is set, except where the results go. */
export function evalParams(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[0].startsWith("EVAL_") && e[0] !== "EVAL_RESULTS_DIR" && e[1] !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}

/** Appends one record to the target's history and returns it. */
export function record(target: string, entry: ResultEntry, env: NodeJS.ProcessEnv = process.env): ResultRecord {
  const full: ResultRecord = {
    at: new Date().toISOString(),
    ...gitState(),
    seed: null,
    params: evalParams(env),
    ...entry,
  };
  const file = fileOf(target, env);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(full)}\n`);
  return full;
}

/** The last `n` records, oldest first (fewer when the history is shorter, none when there is none). */
export function last(target: string, n = 1, env: NodeJS.ProcessEnv = process.env): ResultRecord[] {
  const file = fileOf(target, env);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: ResultRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as ResultRecord);
    } catch {
      // A torn line is skipped.
    }
  }
  return n > 0 ? records.slice(-n) : [];
}

export type Delta = { [key: string]: number | Delta };

/**
 * `next - prev` for every key both have as a finite number; objects present in both are compared
 * recursively and kept when they have any delta. Anything else (strings, keys in one side only) is left out.
 */
export function diff(prev: unknown, next: unknown): Delta {
  const out: Delta = {};
  if (!prev || !next || typeof prev !== "object" || typeof next !== "object") return out;
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!(key in a)) continue;
    const x = a[key];
    const y = b[key];
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      out[key] = Math.round((y - x) * 1e9) / 1e9;
    } else if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      const nested = diff(x, y);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

/** What `npm run eval:last` compares between two records: the numbers, not the stamps. */
export function diffRecords(prev: ResultRecord, next: ResultRecord): Delta {
  const pick = (r: ResultRecord) => ({ spend: r.spend, calls: r.calls, metrics: r.metrics, ...(r.compare ? { compare: r.compare } : {}) });
  return diff(pick(prev), pick(next));
}
