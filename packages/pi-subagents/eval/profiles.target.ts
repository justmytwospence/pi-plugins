// The role profiles checked against your recorded subagent runs, as an eval target (`npm run -s eval
// -- profiles`, or `--package pi-subagents`). From the sampled sessions (EVAL_RECENT, EVAL_MIN_PROMPTS,
// EVAL_MIN_TOOLS, EVAL_SAMPLE, EVAL_SEED) it collects the `subagents:run` records (the latest per
// run id), at most MAX_RUNS of them (a seeded shuffle above that), and asks Jev the role question on
// each task, one call per run. It reports which roles the tasks get, the model and effort each role
// implies on the run's own provider, and an estimated cost: the run's turns at the median cost per
// turn observed for that model in the same runs (the actual cost when there is no data, or when the
// model does not change), against what the runs cost. It cannot judge answer quality. `pass` is only
// the Jev failure rate (under 20%). The default sample is 20 sessions; raise EVAL_RECENT and
// EVAL_SAMPLE to cover more of your history.
import { defineEval, withinFailureLimit } from "../../../evals/shared/target.ts";
import { type Session, shuffle } from "../../../evals/shared/sessions.ts";
import { type AgentDef, BUILTIN_AGENTS } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { type AvailableModel, DEFAULT_TIER_DESCRIPTIONS, agentDefaults, pickQuestions, readPicks } from "../src/pick.ts";
import { SOURCES, modelSource } from "../src/stats.ts";
import { clip } from "../src/transcript.ts";

/** At most this many runs are asked about (one Jev call each). */
export const MAX_RUNS = 300;
const RUN_ENTRY = "subagents:run";
/** The bucket of runs Jev gave no answer for: they keep their model and cost. */
const UNANSWERED = "unanswered";

/** A recorded run as this eval reads it, with the user message before it as the parent request. */
export interface RecordedRun {
  id: string;
  agent: string;
  task: string;
  model: string;
  thinking: string;
  status: string;
  /** Where the run's model came from; `unknown` for records from before `source` was kept. */
  modelSource: ReturnType<typeof modelSource>;
  turns: number;
  tokens: number;
  cost: number;
  parentRequest: string;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : "");

function userText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as { role?: unknown; content?: unknown } | undefined;
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((b: { type?: unknown; text?: unknown }) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** The `subagents:run` records of the sessions, the latest per run id, in order of first appearance. */
export function collectRuns(sessions: readonly Pick<Session, "entries">[]): RecordedRun[] {
  const latest = new Map<string, RecordedRun>();
  for (const session of sessions) {
    let lastUser = "";
    for (const entry of session.entries) {
      const text = userText(entry);
      if (text !== undefined) lastUser = text;
      if (entry.type !== "custom" || entry.customType !== RUN_ENTRY) continue;
      const d = entry.data as Record<string, unknown> | undefined;
      if (!d || typeof d.id !== "string" || !str(d.task).trim()) continue;
      latest.set(d.id, {
        id: d.id,
        agent: str(d.agent) || "general",
        task: str(d.task),
        model: str(d.model),
        thinking: str(d.thinking),
        status: str(d.status),
        modelSource: modelSource(d as { source?: { model?: string } }),
        turns: num(d.turns),
        tokens: num(d.tokens),
        cost: num(d.cost),
        parentRequest: latest.get(d.id)?.parentRequest ?? lastUser,
      });
    }
  }
  return [...latest.values()];
}

/** The runs to ask about: all of them up to `max`, else the first `max` of a seeded shuffle. */
export function selectRuns(runs: readonly RecordedRun[], seed: number, max = MAX_RUNS): RecordedRun[] {
  return runs.length <= max ? [...runs] : shuffle(runs, seed).slice(0, max);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The median cost per turn of each model over the runs with turns and a cost. */
export function costPerTurn(runs: readonly RecordedRun[]): Map<string, { perTurn: number; runs: number }> {
  const byModel = new Map<string, number[]>();
  for (const r of runs) if (r.model && r.turns > 0 && r.cost > 0) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r.cost / r.turns]);
  return new Map([...byModel].map(([model, values]) => [model, { perTurn: median(values), runs: values.length }]));
}

/** What a role implies for a run: its profile model and effort on the run's provider, else the run's own (general, no profile). */
export function implied(role: AgentDef | undefined, run: RecordedRun, available: readonly AvailableModel[] = []): { model: string; thinking: string; profiled: boolean } {
  const provider = run.model.split("/")[0] ?? "";
  const fixed = role && provider ? agentDefaults(role, `${provider}/_`, available) : {};
  return fixed.model ? { model: fixed.model, thinking: fixed.thinking ?? run.thinking, profiled: true } : { model: run.model, thinking: run.thinking, profiled: false };
}

/** The run's cost on `model`: the actual cost on the same model, else its turns at the model's median per turn, else the actual cost (unpriced). */
export function estimate(run: RecordedRun, model: string, medians: Map<string, { perTurn: number }>): { cost: number; priced: boolean } {
  if (model === run.model) return { cost: run.cost, priced: true };
  const m = medians.get(model);
  return m && run.turns > 0 ? { cost: m.perTurn * run.turns, priced: true } : { cost: run.cost, priced: false };
}

const roleQuestion = () => ({ role: pickQuestions({}, BUILTIN_AGENTS, { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS }, false).role! });
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export default defineEval({
  id: "profiles",
  title: "Replay your subagent runs: the roles they get, and the cost of the role profiles",
  package: "pi-subagents",
  kind: "replay",

  plan(ctx) {
    const { seed, sessions } = ctx.sample();
    const all = collectRuns(sessions);
    const selected = selectRuns(all, seed);
    return { calls: selected.length, notes: `${selected.length} of ${all.length} recorded runs in ${sessions.length} sessions, one role question each (at most ${MAX_RUNS})` };
  },

  async run(ctx) {
    const { seed, sessions } = ctx.sample();
    const all = collectRuns(sessions);
    const runs = selectRuns(all, seed);
    const medians = costPerTurn(all);
    const registry = ctx.registry as { getAll?: () => AvailableModel[] } | undefined;
    let available: AvailableModel[] = [];
    try {
      available = typeof registry?.getAll === "function" ? registry.getAll() : [];
    } catch {
      // No registry listing: profile ids are taken as written.
    }
    const roles = new Array<string>(runs.length);
    let failures = 0;
    await ctx.pool(runs, ctx.concurrency, async (run, i) => {
      const state = { task: clip(run.task, 6_000), parent_request: clip(run.parentRequest, 2_000) || "(none)" };
      const outcome = await askJev(ctx.registry, { ...DEFAULT_CONFIG.jev, timeoutMs: ctx.timeoutMs }, state, roleQuestion());
      ctx.spend.addOutcome(outcome);
      if (!outcome.ok) {
        failures++;
        roles[i] = UNANSWERED;
        return;
      }
      // As the extension does: a role below 0.5 confidence is general.
      roles[i] = readPicks(outcome.answers).agent ?? "general";
    });

    type Bucket = { runs: number; actual: number; estimated: number; implied: Map<string, number> };
    const buckets = new Map<string, Bucket>();
    let actual = 0;
    let estimated = 0;
    let unpriced = 0;
    let changedAgent = 0;
    runs.forEach((run, i) => {
      const role = roles[i]!;
      const agent = BUILTIN_AGENTS.find((a) => a.name === role);
      const next = role === UNANSWERED ? { model: run.model, thinking: run.thinking, profiled: false } : implied(agent, run, available);
      const est = estimate(run, next.model, medians);
      if (!est.priced) unpriced++;
      if (role !== UNANSWERED && role !== run.agent) changedAgent++;
      const b = buckets.get(role) ?? { runs: 0, actual: 0, estimated: 0, implied: new Map() };
      b.runs++;
      b.actual += run.cost;
      b.estimated += est.cost;
      const label = next.profiled ? `${next.model} ${next.thinking}` : "unchanged";
      b.implied.set(label, (b.implied.get(label) ?? 0) + 1);
      buckets.set(role, b);
      actual += run.cost;
      estimated += est.cost;
    });

    const order = [...BUILTIN_AGENTS.map((a) => a.name), UNANSWERED].filter((r) => buckets.has(r));
    const n = runs.length;
    const rows: Array<Array<string | number>> = [["role", "runs", "share", "actual", "estimated", "implies (model effort x runs)"]];
    for (const role of order) {
      const b = buckets.get(role)!;
      const impl = [...b.implied].sort((x, y) => y[1] - x[1]).map(([label, count]) => `${label} x${count}`).join(", ");
      rows.push([role, b.runs, pct(b.runs / n), usd(b.actual), usd(b.estimated), impl]);
    }
    rows.push(["total", n, n ? "100%" : "-", usd(actual), usd(estimated), actual > 0 ? `estimated/actual ${(estimated / actual).toFixed(2)}` : ""]);
    const bySource = Object.fromEntries(SOURCES.map((x) => [x, runs.filter((r) => r.modelSource === x).length])) as Record<(typeof SOURCES)[number], number>;
    const recordedSource = n - bySource.unknown;
    const sourceLine = recordedSource
      ? `Model chosen by (${recordedSource} of ${n} runs recorded it): ${SOURCES.filter((x) => x !== "unknown").map((x) => `${x} ${pct(bySource[x] / recordedSource)}`).join(", ")}; ${bySource.unknown} not recorded (older runs).`
      : `Model chosen by: not recorded (${n} runs predate the source record).`;
    const perTurn = [...medians].sort((a, b) => b[1].runs - a[1].runs).map(([model, m]) => `  ${model}: ${usd(m.perTurn)}/turn over ${m.runs} runs`);
    const report = [
      `profiles: EVAL_SEED=${seed}, ${n} of ${all.length} recorded runs in ${sessions.length} sessions (at most ${MAX_RUNS})`,
      ctx.table(rows),
      `${changedAgent} runs would get another agent than they had; ${unpriced} runs are estimated at their actual cost for lack of per-turn data on the implied model.`,
      sourceLine,
      "Median cost per turn by model (all efforts together), from the same runs:",
      ...(perTurn.length ? perTurn : ["  (no run with turns and a cost)"]),
      "Estimates assume the same number of turns on the implied model. This cannot judge answer quality: a cheaper role may answer worse or need more turns.",
      ...(failures ? [`Jev failures: ${failures}/${n}${withinFailureLimit(failures, n) ? "" : ", at or above the 20% limit"}`] : []),
    ].join("\n");

    const metrics: Record<string, number> = {
      sessions: sessions.length,
      recorded: all.length,
      runs: n,
      jevFailures: failures,
      actualCost: actual,
      estimatedCost: estimated,
      costRatio: actual > 0 ? estimated / actual : 0,
      changedAgent,
      unpriced,
    };
    for (const x of SOURCES) {
      metrics[`source.${x}`] = bySource[x];
      if (x !== "unknown") metrics[`sourceShare.${x}`] = recordedSource ? bySource[x] / recordedSource : 0;
    }
    for (const [role, b] of buckets) {
      metrics[`share.${role}`] = n ? b.runs / n : 0;
      metrics[`runs.${role}`] = b.runs;
      metrics[`actualCost.${role}`] = b.actual;
      metrics[`estimatedCost.${role}`] = b.estimated;
    }
    return { metrics, report, pass: withinFailureLimit(failures, n), failures };
  },
});
