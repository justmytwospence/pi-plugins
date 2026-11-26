/**
 * Switchyard adapter for @justmytwospence/pi-subagents. Self-contained: the host loads this file with
 * Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * On contract v2 hosts the runs (from `subagents:run` entries and the `subagent` tool's live
 * updates and results) are a Subagents tracker above the input, one row per run, and `subagent`
 * calls get one-line rows. Older hosts get the panel and pill.
 */

import type {
  AdapterContext as HostContext,
  AdapterFeature,
  SessionEntryInfo,
  ToolEndEvent,
  ToolInfo,
  ToolUpdateEvent,
  ToolViewData,
  UINode,
  UIRow,
} from "./contract.ts";

export type SubagentLink = Parameters<HostContext["linkSubagent"]>[0];
/** What the adapter uses of its context; `setContribution` is missing on the oldest hosts. */
export type AdapterContext = Pick<HostContext, "state" | "setPanel" | "linkSubagent" | "features"> &
  Partial<Pick<HostContext, "setContribution">>;

/** Contract v2 feature guard: `ctx.features` is undefined on a host from before v2. */
const supports = (ctx: { readonly features?: readonly string[] }, feature: AdapterFeature): boolean =>
  ctx.features?.includes(feature) === true;

/**
 * Run entries (`subagents:run`) and `subagent` tool
 * results (`details.runs`) become subagent links, keeping the latest state per run id. Clients
 * open a linked run as a read-only view of its native session file
 * ("Subagent: view only. Live control is not supported.").
 */

export const RUN_ENTRY = "subagents:run";
export const TOOL_NAME = "subagent";
export const VIEW_ONLY_NOTE = "Subagent: view only. Live control is not supported.";

export interface RunView {
  id: string;
  agent?: string;
  task?: string;
  label?: string;
  status: "running" | "done" | "failed" | "stopped" | "lost" | string;
  sessionFile?: string;
  model?: string;
  /** What it is doing now. */
  activity?: string;
  /** How long it has run (or ran). */
  seconds?: number;
  error?: string;
}

function asRun(x: unknown): RunView | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.status !== "string") return undefined;
  return r as unknown as RunView;
}

export function runLink(run: RunView): SubagentLink {
  const task = run.task ? (run.task.length > 60 ? `${run.task.slice(0, 57)}...` : run.task) : "";
  const label =
    run.label?.trim() || [run.agent, task].filter(Boolean).join(": ") || `Subagent ${run.id}`;
  return {
    runId: run.id,
    label,
    status: run.status,
    sessionFile: typeof run.sessionFile === "string" ? run.sessionFile : null,
  };
}

/** Restore only portable display; links are emitted solely for new run evidence. */
export function renderSubagents(ctx: AdapterContext): void {
  if (ctx.setContribution && supports(ctx, "adapter.trackers.v1")) {
    renderTracker(ctx as AdapterContext & Required<Pick<AdapterContext, "setContribution">>);
    return;
  }
  const links = ctx.state.keys().filter((key) => key.startsWith("run:"))
    .map((key) => ctx.state.get<SubagentLink>(key))
    .filter((link): link is SubagentLink => !!link);
  const node: UINode | null = links.length ? {
    t: "section", children: [
      { t: "table", columns: ["Subagent", "Status"], rows: links.map((link) => [link.label, link.status]) },
      { t: "text", text: VIEW_ONLY_NOTE },
    ],
  } : null;
  const summary = links.map((link) => `${link.label}: ${link.status}`).join("\n");
  const fallback = `${summary.slice(0, 1999 - VIEW_ONLY_NOTE.length)}\n${VIEW_ONLY_NOTE}`;
  if (ctx.setContribution) {
    ctx.setPanel("subagents", null);
    ctx.setContribution("subagents", node ? {
      placement: "session.panel", title: "Subagents", node, mobileFallback: fallback,
    } : null);
    const count = links.filter((link) => link.status === "running").length;
    const text = `Subagents: ${count} running`;
    ctx.setContribution("subagents-pill", count ? {
      placement: "composer.pill", title: "Subagents", node: { t: "text", text }, mobileFallback: text,
    } : null);
  } else {
    ctx.setPanel("subagents", node, { title: "Subagents", mobileFallback: node ? fallback : null });
  }
}

// ---------------------------------------------------------------------------
// Contract v2

const VIEW_KEY = "view:";
/** Runs listed in the tracker: the running ones and the latest ended ones, up to this many. */
const LISTED = 8;
/** How long ended runs keep the tracker up once nothing runs. */
export const LINGER_MS = 5 * 60_000;

/** A run as the tracker keeps it, with when this adapter last heard of it. */
type Seen = RunView & { seenAt: number };

/** `42s`, `3m 12s`, `1h 5m`. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const TONES: Record<string, UIRow["tone"]> = { done: "success", failed: "danger", lost: "danger", stopped: "muted" };

/** One row per run: its label, state, then agent, model and time (or its error). */
export function runRow(run: RunView): UIRow {
  const meta = [run.agent, run.model, typeof run.seconds === "number" ? duration(run.seconds) : "", run.status === "running" ? run.activity : run.error]
    .filter((x): x is string => typeof x === "string" && x !== "")
    .join(" · ");
  const tone = TONES[run.status];
  return { title: runLink(run).label, status: run.status, ...(tone ? { tone } : {}), ...(meta ? { meta: meta.slice(0, 200) } : {}) };
}

const seenRuns = (ctx: AdapterContext): Seen[] =>
  ctx.state.keys().filter((k) => k.startsWith(VIEW_KEY)).map((k) => ctx.state.get<Seen>(k)).filter((r): r is Seen => !!r);

/** Running first (oldest first), then the latest ended. */
function listed(runs: Seen[]): Seen[] {
  const running = runs.filter((r) => r.status === "running").sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0));
  const ended = runs.filter((r) => r.status !== "running").sort((a, b) => b.seenAt - a.seenAt);
  return [...running, ...ended].slice(0, Math.max(LISTED, running.length));
}

function renderTracker(ctx: AdapterContext & Required<Pick<AdapterContext, "setContribution">>, now = Date.now()): void {
  ctx.setPanel("subagents", null);
  ctx.setContribution("subagents", null);
  ctx.setContribution("subagents-pill", null);
  const runs = listed(seenRuns(ctx));
  const running = runs.filter((r) => r.status === "running");
  const last = Math.max(0, ...runs.map((r) => r.seenAt));
  if (!running.length && now - last > LINGER_MS) {
    ctx.setContribution("subagents-tracker", null);
    return;
  }
  const rows = runs.map(runRow);
  const failed = !running.length && runs.some((r) => r.seenAt === last && (r.status === "failed" || r.status === "lost"));
  const first = running[0];
  const step = first ? [runLink(first).label, first.activity].filter(Boolean).join(": ") : undefined;
  const fallback = `${rows.map((r) => `${r.title}: ${r.status}`).join("\n").slice(0, 1999 - VIEW_ONLY_NOTE.length)}\n${VIEW_ONLY_NOTE}`;
  ctx.setContribution("subagents-tracker", {
    placement: "composer.tracker",
    title: "Subagents",
    node: supports(ctx, "ui.nodes.v2")
      ? { t: "rows", rows }
      : { t: "table", columns: ["Subagent", "Status", "Details"], rows: rows.map((r) => [r.title, r.status ?? "", r.meta ?? ""]) },
    mobileFallback: fallback,
    tracker: {
      ...(running.length ? { count: `${running.length} running` } : {}),
      status: running.length ? "running" : failed ? "error" : "ok",
      ...(step ? { step: step.slice(0, 120) } : {}),
    },
  });
}

/** Keep the latest view of a run for the tracker; true when it changed what the tracker shows. */
function see(run: RunView, ctx: AdapterContext): boolean {
  const key = VIEW_KEY + run.id;
  const prev = ctx.state.get<Seen>(key);
  const next: Seen = {
    id: run.id,
    status: run.status,
    ...(run.agent ? { agent: run.agent } : {}),
    ...(run.task ? { task: run.task.slice(0, 200) } : {}),
    ...(run.label ? { label: run.label } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.activity ? { activity: run.activity.slice(0, 200) } : {}),
    ...(typeof run.seconds === "number" ? { seconds: run.seconds } : {}),
    ...(run.error ? { error: run.error.slice(0, 200) } : {}),
    seenAt: Date.now(),
  };
  const { seenAt: _a, ...a } = prev ?? ({} as Seen);
  const { seenAt: _b, ...b } = next;
  if (prev && JSON.stringify(a) === JSON.stringify(b)) return false;
  ctx.state.set(key, next);
  // Forget the oldest ended runs.
  const keep = new Set(listed(seenRuns(ctx)).map((r) => r.id));
  for (const r of seenRuns(ctx)) if (!keep.has(r.id)) ctx.state.delete(VIEW_KEY + r.id);
  return true;
}

const ACTION_VERBS: Record<string, [string, string]> = {
  status: ["Checked subagent", "Checking subagent"],
  result: ["Read subagent result", "Reading subagent result"],
  steer: ["Steered subagent", "Steering subagent"],
  stop: ["Stopped subagent", "Stopping subagent"],
  resume: ["Resumed subagent", "Resuming subagent"],
};

const runsOf = (tool: { details?: unknown; result?: unknown }): RunView[] => {
  const details = (tool.details ?? (tool.result as { details?: unknown } | null | undefined)?.details) as
    | { runs?: unknown }
    | undefined;
  return Array.isArray(details?.runs) ? details.runs.map(asRun).filter((r): r is RunView => !!r) : [];
};

/** Contract v2: a `subagent` call's row (`Delegated Fix the tests · worker · done`), opening to its runs. */
export function subagentView(tool: ToolInfo, ctx: AdapterContext): ToolViewData | undefined {
  if (tool.name !== TOOL_NAME) return undefined;
  const args = (tool.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" ? args.action : "run";
  const runs = runsOf(tool);
  const items = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).length : 0);
  const first = runs[0];
  let target: string;
  if (items("tasks")) target = `${items("tasks")} tasks`;
  else if (items("chain")) target = `${items("chain")}-step chain`;
  else if (first) target = runLink(first).label;
  else if (typeof args.label === "string" && args.label) target = args.label;
  else if (typeof args.task === "string") target = args.task.split("\n")[0]!.slice(0, 120);
  else target = typeof args.id === "string" ? args.id : "";
  const [verb, activeVerb] = ACTION_VERBS[action] ?? ["Delegated", "Delegating"];
  const meta: string[] = [];
  const agent = typeof args.agent === "string" ? args.agent : runs.length === 1 ? first?.agent : undefined;
  if (agent && action === "run") meta.push(agent);
  if (tool.result !== undefined && runs.length) {
    const counts = new Map<string, number>();
    for (const r of runs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    meta.push(...[...counts].map(([status, n]) => (runs.length === 1 ? status : `${n} ${status}`)));
  }
  if (tool.isError) meta.push("failed");
  const detail: UINode | undefined = runs.length
    ? supports(ctx, "ui.nodes.v2")
      ? { t: "rows", rows: runs.map(runRow) }
      : { t: "table", columns: ["Subagent", "Status"], rows: runs.map((r) => [runLink(r).label, r.status]) }
    : undefined;
  return { kind: "other", verb, activeVerb, target: target.slice(0, 500), meta: meta.slice(0, 6), ...(detail ? { detail } : {}) };
}

function publish(run: RunView, ctx: AdapterContext) {
  const tracked = ctx.setContribution && supports(ctx, "adapter.trackers.v1") ? see(run, ctx) : false;
  const link = runLink(run);
  const key = `run:${run.id}`;
  const prev = ctx.state.get<SubagentLink>(key);
  if (
    prev &&
    prev.label === link.label &&
    prev.status === link.status &&
    prev.sessionFile === link.sessionFile
  ) {
    if (tracked) renderSubagents(ctx);
    return;
  }
  ctx.state.set(key, link);
  ctx.linkSubagent(link);
  renderSubagents(ctx);
}

export default {
  onRestore: renderSubagents,
  toolView: subagentView,

  /** Contract v2: live runs (status, activity, time) while the call waits on them. */
  onToolUpdate(e: ToolUpdateEvent, ctx: AdapterContext): void {
    if (e.name !== TOOL_NAME || !ctx.setContribution || !supports(ctx, "adapter.trackers.v1")) return;
    for (const run of runsOf(e)) publish(run, ctx);
  },

  onEntry(entry: SessionEntryInfo, ctx: AdapterContext): void {
    if (entry.customType !== RUN_ENTRY) return;
    const run = asRun(entry.data);
    if (run) publish(run, ctx);
  },

  onToolEnd(e: ToolEndEvent, ctx: AdapterContext): void {
    if (e.name !== TOOL_NAME) return;
    for (const run of runsOf(e)) publish(run, ctx);
  },
};
