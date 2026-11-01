// The history of live eval runs, one JSON line per run in `evals/results/<target>.jsonl` (git-ignored).
// Node builtins and siblings only, no imports from any package.
//
// A record: `{ at, commit, dirty, seed, params, spend, calls, metrics, compare?, configuredPolicy?, actualProviders? }`
//   at       ISO time of the run
//   commit   `git rev-parse --short HEAD` of the repository, "unknown" outside a checkout
//   dirty    true when the working tree has uncommitted changes
//   seed     the EVAL_SEED the run printed
//   params   every EVAL_* variable that was set
//   spend    catalog-estimated USD reported by the classifier (see spend.ts); calls = logical requests
//   metrics  the numbers the eval prints, a flat object of numbers
//   compare  the same for the old behaviour, with EVAL_COMPARE=1
//   configuredPolicy  ordered configured targets, never a claim about the actual winner
//   actualProviders   successful logical judgments counted by actual backend/provider/model
//   classifier        older single-provider provenance; still readable, never inferred from policy
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AttemptAudit } from "./spend.ts";

export type Metrics = Record<string, number>;

export interface ClassifierProvenance {
  backend: string;
  provider: string;
  model: string;
}

/** Policy identity is separate from the providers actually observed in a run. */
export interface ConfiguredClassifierPolicy {
  waterfall?: string[];
  targets?: ClassifierProvenance[];
  key?: string;
  /** Compatibility metadata from older direct runner callers; not observed provenance. */
  backend?: string;
  provider?: string;
  model?: string;
}

/** Counts of successful logical judgments by actual backend/provider/model identity. */
export type ActualProviderMix = Record<string, number>;

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
  /** Legacy single-provider record, not populated from the current configured policy. */
  classifier?: ClassifierProvenance;
  configuredPolicy?: ConfiguredClassifierPolicy;
  actualProviders?: ActualProviderMix;
  backendAttempts?: Record<string, number>;
  registryCalls?: number;
  attempts?: AttemptAudit[];
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

/** Warn when provenance is unknown or differs; unknown records are never assumed to use a particular classifier. */
export function comparisonWarning(prev: ResultRecord, next: ResultRecord): string | undefined {
  const policy = (r: ResultRecord) => {
    const c = r.configuredPolicy ?? r.classifier;
    if (!c) return undefined;
    const configured = r.configuredPolicy;
    const targets = configured?.targets ?? (c.backend && c.provider && c.model ? [{ backend: c.backend, provider: c.provider, model: c.model }] : undefined);
    return JSON.stringify([configured?.waterfall ?? targets?.map((t) => t.backend) ?? null,
      targets?.map((t) => [t.backend, t.provider, t.model]) ?? null]);
  };
  if (prev.configuredPolicy || next.configuredPolicy || Object.keys(prev.actualProviders ?? {}).length || Object.keys(next.actualProviders ?? {}).length) {
    const a = policy(prev);
    const b = policy(next);
    if (!a || !b) return "Configured classifier policy is legacy/unknown; numeric comparison suppressed.";
    if (a !== b) return "Configured classifier chains differ; numeric comparison suppressed.";
    if (!prev.actualProviders || !next.actualProviders) return "Actual provider mix is legacy/unknown; numeric comparison suppressed.";
    // Compare proportions, not raw sample counts; doubling an otherwise identical run is comparable.
    const mix = (counts: ActualProviderMix) => {
      const entries = Object.entries(counts).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b));
      const total = entries.reduce((n, [, count]) => n + count, 0);
      return JSON.stringify(entries.map(([key, count]) => [key, count / total]));
    };
    if (mix(prev.actualProviders) !== mix(next.actualProviders)) return "Actual provider mixes differ; numeric comparison suppressed.";
    return undefined;
  }
  const a = prev.classifier;
  const b = next.classifier;
  if (!a || !b) return "Classifier provenance is legacy/unknown; comparison may not be meaningful.";
  const mismatches = (["backend", "provider", "model"] as const).filter((key) => a[key] !== b[key]);
  if (mismatches.length) return `Classifier provenance differs (${mismatches.map((key) => `${key}: ${a[key]} vs ${b[key]}`).join(", ")}); numeric comparison suppressed.`;
  return undefined;
}

/** Compare numbers only for matching classifiers or two legacy records. */
export function diffRecords(prev: ResultRecord, next: ResultRecord): Delta {
  if ((prev.classifier || next.classifier || prev.configuredPolicy || next.configuredPolicy || Object.keys(prev.actualProviders ?? {}).length || Object.keys(next.actualProviders ?? {}).length) && comparisonWarning(prev, next)) return {};
  const pick = (r: ResultRecord) => ({ spend: r.spend, calls: r.calls, metrics: r.metrics, ...(r.compare ? { compare: r.compare } : {}) });
  return diff(pick(prev), pick(next));
}
