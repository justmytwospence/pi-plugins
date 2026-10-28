// Replays real Pi sessions through auto-effort's prompt-time decision (eval/replay.eval.ts). For
// each sampled session's current branch and each user message on it: the Jev state the extension
// would have built then (effortState over the entries before the message), the pre-filter, else a
// live Jev call; then the prompts are walked in order through decide() with the default policy to
// give the level auto-effort would set now. Model choice and mid-run re-assessment are not replayed.
//
// The user's own level changes are the reference. An override is a `thinking_level_change` after a
// prompt and before the next user message that auto-effort did not make, with the level it chose;
// when there are several, the last one. Heuristic: auto-effort writes its level change and then, as
// the very next entry, an `auto-effort:state` entry recording the move (`from` another level to
// that level as `level`), so a change with such a state entry next to it (after it, or before it
// for robustness) is auto-effort's own. A state entry that holds (`from` equals `level`) does not
// count: a change you make just before sending a prompt is followed by one. Two exceptions are not
// overrides either: a change right after a `model_change` is Pi applying the new model's thinking
// level, and the change after that one, followed by a state entry with its level, is auto-effort
// restoring its decision after its own model switch. Changes other extensions make count as yours.
// Pressure, p, is the prompt's recorded state entry's `p` (0 for older entries without one).
// The walk starts from the level before the first prompt and continues from each replayed level, or
// from your override where there is one; mid-run changes are not replayed.
import { DEFAULT_CONFIG, LEGACY_QUESTIONS, QUESTIONS, effortState, judgment } from "../src/index.ts";
import { type JevOutcome, askJev } from "../src/jev.ts";
import { DEFAULT_POLICY, type Judgment, type Policy, decide } from "../src/policy.ts";
import { isGoAhead } from "../src/prefilter.ts";
import { messageText } from "../src/transcript.ts";
import type { Session, SessionEntry } from "./sessions.ts";
import { branchOf } from "./sessions.ts";

const STATE_ENTRY = "auto-effort:state";

/** Pi's thinking levels, lowest first: the scale for "within one step". */
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pi's default thinking level (`defaultThinkingLevel`), for a branch that records none. */
const DEFAULT_START = "medium";

/** What a replay runs: the current behaviour, or the old one for comparison (EVAL_COMPARE=1). */
export interface Variant {
  name: string;
  /** Settle go-aheads without a Jev call. */
  prefilter: boolean;
  /** The old state and questions: the agent's reply as `last_outcome`, clipped at 1,500 characters. */
  legacy: boolean;
}

export const CURRENT: Variant = { name: "current", prefilter: true, legacy: false };
export const OLD: Variant = { name: "old", prefilter: false, legacy: true };

export interface ReplayPrompt {
  /** Index of the user message on the branch. */
  index: number;
  text: string;
  /** The pressure auto-effort recorded for this prompt (its state entry's `p`), else 0. */
  p: number;
  /** The level auto-effort set for this prompt at the time, when its state entry is on the branch. */
  live?: string;
  /** The level the user chose after this prompt, before the next one. */
  override?: string;
}

export interface ReplaySession {
  file: string;
  /** The session's working directory. */
  cwd: string;
  branch: SessionEntry[];
  /** The level before the first prompt. */
  start: string;
  prompts: ReplayPrompt[];
}

interface Data {
  phase?: unknown;
  level?: unknown;
  from?: unknown;
  p?: unknown;
}

const messageRole = (e: SessionEntry | undefined) => (e?.type === "message" ? (e.message as { role?: unknown } | undefined)?.role : undefined);
const stateData = (e: SessionEntry | undefined): Data | undefined =>
  e?.type === "custom" && e.customType === STATE_ENTRY && e.data && typeof e.data === "object" ? (e.data as Data) : undefined;
const levelOf = (e: SessionEntry | undefined) => (e?.type === "thinking_level_change" && typeof e.thinkingLevel === "string" ? e.thinkingLevel : undefined);

/** True when the `thinking_level_change` at `i` was auto-effort's own or Pi's after a model switch (see the header). */
export function notChosen(branch: readonly SessionEntry[], i: number): boolean {
  const level = levelOf(branch[i]);
  if (level === undefined) return true;
  if (branch[i - 1]?.type === "model_change") return true;
  const next = stateData(branch[i + 1]);
  if (next?.level === level && levelOf(branch[i - 1]) !== undefined && branch[i - 2]?.type === "model_change") return true;
  return [next, stateData(branch[i - 1])].some((d) => d?.level === level && d.from !== level);
}

/** The prompts of a branch with their recorded pressure, live level and the user's overrides. */
export function replaySession(file: string, branch: SessionEntry[], cwd = ""): ReplaySession {
  const users: number[] = [];
  branch.forEach((e, i) => {
    if (messageRole(e) === "user" && messageText((e.message as { content?: unknown }).content).trim()) users.push(i);
  });
  const prompts = users.map((index, k): ReplayPrompt => {
    const text = messageText((branch[index]!.message as { content?: unknown }).content);
    // Auto-effort decides before Pi appends the message: its state entry for this prompt is the last
    // one (not a mid-run one) since the previous prompt.
    let data: Data | undefined;
    for (let i = index - 1; i > (users[k - 1] ?? -1) && !data; i--) {
      const d = stateData(branch[i]);
      if (d && d.phase !== "run") data = d;
    }
    let override: string | undefined;
    for (let i = index + 1; i < (users[k + 1] ?? branch.length); i++) {
      if (levelOf(branch[i]) !== undefined && !notChosen(branch, i)) override = levelOf(branch[i]);
    }
    return {
      index,
      text,
      p: typeof data?.p === "number" && Number.isFinite(data.p) ? data.p : 0,
      ...(typeof data?.level === "string" ? { live: data.level } : {}),
      ...(override !== undefined ? { override } : {}),
    };
  });
  return { file, cwd, branch, start: startLevel(branch, users[0]), prompts };
}

/** The level before the first prompt: its state entry's `from`, else the last level change before it, else Pi's default. */
function startLevel(branch: readonly SessionEntry[], first: number | undefined): string {
  const before = branch.slice(0, first ?? branch.length);
  const data = before.map(stateData).findLast((d) => d && d.phase !== "run");
  if (typeof data?.from === "string") return data.from;
  return before.map(levelOf).findLast((l) => l !== undefined) ?? DEFAULT_START;
}

export function fromSession(session: Session): ReplaySession {
  return replaySession(session.file, branchOf(session.entries), session.cwd);
}

/** One prompt's assessment: settled by the pre-filter, or Jev's outcome and the judgment in it. */
export type Assessment = { kind: "go-ahead" } | { kind: "jev"; outcome: JevOutcome; judgment: Judgment | undefined };

export interface AssessOptions {
  concurrency?: number;
  timeoutMs?: number;
  /** Called after each Jev call with the number done and the number to do. */
  progress?: (done: number, total: number) => void;
}

/** Assesses every prompt of every session for a variant: the pre-filter, else Jev (`concurrency` calls at a time). */
export async function assess(registry: unknown, sessions: readonly ReplaySession[], variant: Variant, options: AssessOptions = {}): Promise<Assessment[][]> {
  const config = { ...DEFAULT_CONFIG.jev, timeoutMs: options.timeoutMs ?? 20_000 };
  const questions = variant.legacy ? LEGACY_QUESTIONS : QUESTIONS;
  const out: Assessment[][] = sessions.map((s) => new Array<Assessment>(s.prompts.length));
  const jobs: Array<() => Promise<void>> = [];
  sessions.forEach((session, s) => {
    session.prompts.forEach((prompt, k) => {
      if (variant.prefilter && isGoAhead(prompt.text)) {
        out[s]![k] = { kind: "go-ahead" };
        return;
      }
      jobs.push(async () => {
        const state = effortState(prompt.text, session.branch.slice(0, prompt.index), { legacy: variant.legacy });
        const outcome = await askJev(registry, config, state, questions);
        out[s]![k] = { kind: "jev", outcome, judgment: judgment(outcome, true) };
      });
    });
  });
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      await job();
      options.progress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, jobs.length)) }, worker));
  return out;
}

export interface Step {
  from: string;
  level: string;
  reason: string;
}

/**
 * The levels auto-effort would set, prompt by prompt: decide() with `policy` in free bounds and the
 * recorded pressure, from the level the last step left (or the user's override of it).
 */
export function walk(session: ReplaySession, assessed: readonly Assessment[], policy: Policy = DEFAULT_POLICY): Step[] {
  let current = session.start;
  let ceiling = session.start;
  return session.prompts.map((prompt, k) => {
    const a = assessed[k];
    const decision = a?.kind === "go-ahead" ? { level: current, reason: "go-ahead" } : decide(current, ceiling, a?.judgment, policy, prompt.p, "free");
    const step = { from: current, level: decision.level, reason: decision.reason };
    current = prompt.override ?? decision.level;
    if (prompt.override !== undefined) ceiling = prompt.override;
    return step;
  });
}

export interface Summary {
  sessions: number;
  prompts: number;
  /** Prompts the pre-filter settled. */
  prefiltered: number;
  calls: number;
  /** Calls with no outcome, or one without a usable rating. */
  failures: number;
  latencies: number[];
  overrides: number;
  exact: number;
  withinOne: number;
  /** Misses where the replayed level was above or below the user's choice. */
  above: number;
  below: number;
  levels: Record<string, number>;
  /** Replayed level changes per session. */
  changes: number[];
  /** Prompts with a recorded live level, and how many of them the replay matches. */
  live: number;
  sameAsLive: number;
}

const rank = (level: string) => THINKING.indexOf(level as (typeof THINKING)[number]);

export function summarize(sessions: readonly ReplaySession[], assessed: readonly Assessment[][], steps: readonly Step[][]): Summary {
  const sum: Summary = {
    sessions: sessions.length,
    prompts: 0,
    prefiltered: 0,
    calls: 0,
    failures: 0,
    latencies: [],
    overrides: 0,
    exact: 0,
    withinOne: 0,
    above: 0,
    below: 0,
    levels: {},
    changes: [],
    live: 0,
    sameAsLive: 0,
  };
  sessions.forEach((session, s) => {
    let changes = 0;
    session.prompts.forEach((prompt, k) => {
      const a = assessed[s]?.[k];
      const step = steps[s]?.[k];
      if (!a || !step) return;
      sum.prompts++;
      if (a.kind === "go-ahead") sum.prefiltered++;
      else {
        sum.calls++;
        if (!a.outcome.ok || !a.judgment) sum.failures++;
        if (a.outcome.ok) sum.latencies.push(a.outcome.latencyMs);
      }
      sum.levels[step.level] = (sum.levels[step.level] ?? 0) + 1;
      if (step.level !== step.from) changes++;
      if (prompt.live !== undefined) {
        sum.live++;
        if (prompt.live === step.level) sum.sameAsLive++;
      }
      if (prompt.override !== undefined) {
        sum.overrides++;
        const miss = rank(step.level) - rank(prompt.override);
        if (miss === 0) sum.exact++;
        if (Math.abs(miss) <= 1) sum.withinOne++;
        if (miss > 0) sum.above++;
        if (miss < 0) sum.below++;
      }
    });
    sum.changes.push(changes);
  });
  return sum;
}

/** The q-quantile (0-1) of `values` by nearest rank, or undefined when there are none. */
export function percentile(values: readonly number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export interface VariantResult {
  variant: Variant;
  assessed: Assessment[][];
  steps: Step[][];
  summary: Summary;
}

export async function runVariant(registry: unknown, sessions: readonly ReplaySession[], variant: Variant, options: AssessOptions = {}): Promise<VariantResult> {
  const assessed = await assess(registry, sessions, variant, options);
  const steps = sessions.map((s, i) => walk(s, assessed[i]!));
  return { variant, assessed, steps, summary: summarize(sessions, assessed, steps) };
}

/** Columns padded to their widest cell; the first column left-aligned, the rest right-aligned. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  ").trimEnd()).join("\n");
}

const pct = (n: number, of: number) => (of ? `${n} (${Math.round((100 * n) / of)}%)` : `${n}`);
const short = (level: string) => ({ minimal: "min", medium: "med", xhigh: "xhi" })[level] ?? level;

/** `pi-plugins 2026-10-27T16-12`: the working directory's name and the session file's start time. */
export function sessionLabel(session: Pick<ReplaySession, "file" | "cwd">): string {
  const project = session.cwd.split(/[/\\]/u).filter(Boolean).at(-1) ?? "?";
  const started = (session.file.split(/[/\\]/u).at(-1) ?? "").slice(0, 16);
  return `${project.length > 24 ? `${project.slice(0, 23)}…` : project} ${started}`;
}

/** The report: one row per session (each variant's go-aheads, failures and level changes), then the totals side by side. */
export function report(seed: number, sessions: readonly ReplaySession[], results: readonly VariantResult[]): string {
  const sessionRows: string[][] = [["session", "prompts", "overrides", ...results.flatMap((r) => [`${r.variant.name}: pre`, "fail", "changes"])]];
  sessions.forEach((session, s) => {
    sessionRows.push([
      sessionLabel(session),
      String(session.prompts.length),
      String(session.prompts.filter((p) => p.override !== undefined).length),
      ...results.flatMap((r) => {
        const assessed = r.assessed[s] ?? [];
        const steps = r.steps[s] ?? [];
        return [
          String(assessed.filter((a) => a?.kind === "go-ahead").length),
          String(assessed.filter((a) => a?.kind === "jev" && (!a.outcome.ok || !a.judgment)).length),
          String(steps.filter((st) => st.level !== st.from).length),
        ];
      }),
    ]);
  });
  const ms = (v: number | undefined) => (v === undefined ? "-" : String(Math.round(v)));
  const levelLine = (s: Summary) => THINKING.filter((l) => s.levels[l]).map((l) => `${short(l)} ${s.levels[l]}`).join(" ") || "-";
  const totals: Array<[string, (s: Summary) => string]> = [
    ["prompts", (s) => String(s.prompts)],
    ["settled by the pre-filter", (s) => pct(s.prefiltered, s.prompts)],
    ["Jev calls", (s) => String(s.calls)],
    ["Jev failures", (s) => pct(s.failures, s.calls)],
    ["latency p50 / p95 ms", (s) => `${ms(percentile(s.latencies, 0.5))} / ${ms(percentile(s.latencies, 0.95))}`],
    ["user overrides", (s) => String(s.overrides)],
    ["  replay = user's level", (s) => pct(s.exact, s.overrides)],
    ["  within one step", (s) => pct(s.withinOne, s.overrides)],
    ["  misses above / below", (s) => `${s.above} / ${s.below}`],
    ["level changes / session", (s) => (s.changes.length ? `avg ${(s.changes.reduce((a, b) => a + b, 0) / s.changes.length).toFixed(1)}, max ${Math.max(...s.changes)}` : "-")],
    ["levels", levelLine],
    ["same level as live", (s) => pct(s.sameAsLive, s.live)],
  ];
  const totalRows = [["", ...results.map((r) => r.variant.name)], ...totals.map(([label, f]) => [label, ...results.map((r) => f(r.summary))])];
  return [`auto-effort replay: EVAL_SEED=${seed}, ${sessions.length} sessions`, "", table(sessionRows), "", table(totalRows)].join("\n");
}
