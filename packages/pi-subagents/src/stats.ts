// Delegation stats: what the subagent runs chose, where each choice came from, and what they cost.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isRateLimit } from "./child.ts";

export const RUN_ENTRY = "subagents:run";
export const SOURCES = ["explicit", "profile", "tier", "default", "unknown"] as const;
export type ModelSource = (typeof SOURCES)[number];

/** The parts of a `subagents:run` record the stats read; everything is optional because records age. */
export interface StatRecord {
  id: string;
  agent?: string;
  model?: string;
  status?: string;
  error?: string;
  turns?: number;
  cost?: number;
  source?: { model?: string; thinking?: string };
}

export interface Stats {
  runs: number;
  totalCost: number;
  /** Runs per model source; older records without `source` are `unknown`. */
  bySource: Record<ModelSource, number>;
  byRole: Array<{ role: string; runs: number; medianCost: number; totalCost: number }>;
  byModel: Array<{ model: string; runs: number; medianCostPerTurn: number | undefined }>;
  failed: number;
  rateLimited: number;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The model source of a record, `unknown` when it predates `source` or holds something unrecognized. */
export function modelSource(r: Pick<StatRecord, "source">): ModelSource {
  const m = r.source?.model;
  return m === "explicit" || m === "profile" || m === "tier" || m === "default" ? m : "unknown";
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Latest record per run id, in order of first appearance. */
export function latestPerRun(records: Iterable<StatRecord>): StatRecord[] {
  const latest = new Map<string, StatRecord>();
  for (const r of records) if (r && typeof r.id === "string") latest.set(r.id, r);
  return [...latest.values()];
}

export function computeStats(records: readonly StatRecord[]): Stats {
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<ModelSource, number>;
  const roles = new Map<string, number[]>();
  const models = new Map<string, { runs: number; perTurn: number[] }>();
  let totalCost = 0;
  let failed = 0;
  let rateLimited = 0;
  for (const r of records) {
    const cost = num(r.cost);
    totalCost += cost;
    bySource[modelSource(r)]++;
    const role = r.agent || "general";
    roles.set(role, [...(roles.get(role) ?? []), cost]);
    const model = r.model || "unknown";
    const m = models.get(model) ?? { runs: 0, perTurn: [] };
    m.runs++;
    if (num(r.turns) > 0 && cost > 0) m.perTurn.push(cost / num(r.turns));
    models.set(model, m);
    if (r.status === "failed") {
      failed++;
      if (isRateLimit(r.error) || /rate limit/iu.test(r.error ?? "")) rateLimited++;
    }
  }
  return {
    runs: records.length,
    totalCost,
    bySource,
    byRole: [...roles].map(([role, costs]) => ({ role, runs: costs.length, medianCost: median(costs), totalCost: costs.reduce((a, b) => a + b, 0) })).sort((a, b) => b.runs - a.runs || a.role.localeCompare(b.role)),
    byModel: [...models].map(([model, m]) => ({ model, runs: m.runs, medianCostPerTurn: m.perTurn.length ? median(m.perTurn) : undefined })).sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model)),
    failed,
    rateLimited,
  };
}

const usd = (v: number | undefined) => (v === undefined ? "-" : v >= 10 ? `$${v.toFixed(0)}` : v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "0%");

/** Left-align the first column, right-align the rest; every line cut to `width` with an ellipsis. */
function table(rows: string[][], width: number): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => {
    const line = r.map((cell, c) => (c === 0 ? cell.padEnd(w[c]!) : cell.padStart(w[c]!))).join("  ").trimEnd();
    return line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line;
  });
}

/** The stats as compact plain text, no line longer than `width`. */
export function formatStats(stats: Stats, scope: string, width = 100): string {
  const cut = (s: string) => (s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s);
  if (!stats.runs) return `No subagent runs ${scope}.`;
  const out: string[] = [cut(`${stats.runs} runs, ${usd(stats.totalCost)} total, ${scope}`)];
  out.push("", "Model chosen by:");
  out.push(...table([["source", "runs", "share"], ...SOURCES.filter((s) => stats.bySource[s]).map((s) => [s, String(stats.bySource[s]), pct(stats.bySource[s], stats.runs)])], width));
  out.push("", "By role:");
  out.push(...table([["role", "runs", "median", "total"], ...stats.byRole.map((r) => [r.role, String(r.runs), usd(r.medianCost), usd(r.totalCost)])], width));
  out.push("", "By model:");
  out.push(...table([["model", "runs", "median/turn"], ...stats.byModel.map((m) => [m.model, String(m.runs), usd(m.medianCostPerTurn)])], width));
  out.push("", cut(`Failed: ${stats.failed} (rate-limited: ${stats.rateLimited})`));
  return out.join("\n");
}

/** `subagents:run` records of one session's entries (a parsed `.jsonl` file or a branch). */
export function runRecords(entries: Iterable<{ type?: string; customType?: string; data?: unknown }>): StatRecord[] {
  const out: StatRecord[] = [];
  for (const e of entries) if (e?.type === "custom" && e.customType === RUN_ENTRY && e.data && typeof e.data === "object") out.push(e.data as StatRecord);
  return out;
}

/** Every `.jsonl` session file below `dir`, if any. */
function sessionFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    let items;
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const p = path.join(d, item.name);
      if (item.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (item.isFile() && item.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(dir, 0);
  return files.sort();
}

/** The records of every session under `dir`; unreadable files and lines are skipped. Latest per run id is the caller's `latestPerRun`. */
export function readAllRuns(dir: string): StatRecord[] {
  const out: StatRecord[] = [];
  for (const file of sessionFiles(dir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const entries: Array<{ type?: string; customType?: string; data?: unknown }> = [];
    for (const line of text.split("\n")) {
      if (!line.includes(RUN_ENTRY)) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // a torn line
      }
    }
    out.push(...runRecords(entries));
  }
  return out;
}
