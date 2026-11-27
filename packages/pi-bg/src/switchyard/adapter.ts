/**
 * Switchyard adapter for @justmytwospence/pi-bg. Self-contained: the host loads this file with
 * Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * On contract v2 hosts the tasks come from pi-bg's `pi-bg:task` entries (src/task-entry.ts) and are
 * a Background tracker above the input, one row per task with its state and time, and the bg
 * tools get one-line rows. Older hosts get the panel and pill below, built from the status text.
 */

import type {
  AdapterContext as HostContext,
  AdapterFeature,
  SessionEntryInfo,
  ToolInfo,
  ToolViewData,
  UINode,
  UIRow,
} from "./contract.ts";

/** What the adapter uses of its context; `setContribution` is missing on the oldest hosts. */
export type AdapterContext = Pick<HostContext, "state" | "setPanel" | "features"> &
  Partial<Pick<HostContext, "setContribution">>;

/** Contract v2 feature guard: `ctx.features` is undefined on a host from before v2. */
const supports = (ctx: { readonly features?: readonly string[] }, feature: AdapterFeature): boolean =>
  ctx.features?.includes(feature) === true;

/**
 * Panel presentation for pi-bg: the `bg` status (and `bg` widget lines, when present)
 * become the "bg" panel, as progress when the text carries a fraction or percentage and as text
 * otherwise. The custom web renderer (bg-renderer.html) draws the same data as a compact
 * task list from the panel `state`.
 */

export const STATUS_KEY = "bg";

export interface BgState {
  status: string | null;
  lines: string[];
}

/** Progress value in 0..1 from "3/5" or "40%", else undefined. */
export function progressValue(text: string): number | undefined {
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (frac) {
    const total = Number(frac[2]);
    if (total > 0) return Math.min(1, Number(frac[1]) / total);
  }
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct) return Math.min(1, Number(pct[1]) / 100);
  return undefined;
}

export function bgPanel(s: BgState): UINode | null {
  const children: UINode[] = [];
  if (s.status) {
    // In legacy status text, CPU percentages and slot counts on queued jobs are not progress.
    const nonQueued = s.status.split(" · ").filter((item) => !/\bqueued \([^)]*\)$/u.test(item));
    const value = progressValue(nonQueued.join(" · "));
    children.push(
      value === undefined ? { t: "text", text: s.status } : { t: "progress", label: s.status, value, status: "running" },
    );
  }
  if (s.lines.length) children.push({ t: "list", items: s.lines.map((l): UINode => ({ t: "text", text: l })) });
  if (children.length === 0) return null;
  return children.length === 1 ? children[0]! : { t: "section", children };
}

/** Rebuild presentation from persisted display data, never from live processes. */
export function renderBackground(ctx: AdapterContext): void {
  if (ctx.setContribution && supports(ctx, "adapter.trackers.v1")) {
    renderTracker(ctx as AdapterContext & Required<Pick<AdapterContext, "setContribution">>);
    return;
  }
  const s = current(ctx);
  const node = bgPanel(s);
  const fallback = [s.status, ...s.lines].filter(Boolean).join("\n");
  if (ctx.setContribution) {
    ctx.setPanel("bg", null);
    ctx.setContribution("bg", node ? {
      placement: "session.panel", title: "Background", node, mobileFallback: fallback.slice(0, 2000), state: s,
    } : null);
    ctx.setContribution("bg-pill", s.status ? {
      placement: "composer.pill", title: "Background", node: bgPanel({ status: s.status, lines: [] })!,
      mobileFallback: s.status.slice(0, 2000),
    } : null);
  } else {
    ctx.setPanel("bg", node, { title: "Background", mobileFallback: fallback || null, state: s });
  }
}

function update(ctx: AdapterContext, s: BgState): void {
  if (!s.status && s.lines.length === 0) ctx.state.delete("bg");
  else ctx.state.set("bg", s);
  renderBackground(ctx);
}

const current = (ctx: AdapterContext): BgState =>
  ctx.state.get<BgState>("bg") ?? { status: null, lines: [] };

// ---------------------------------------------------------------------------
// Contract v2: tasks from pi-bg's entries

export const TASK_ENTRY = "pi-bg:task";
const TASKS_KEY = "tasks";
/** Tasks listed in the tracker: the active ones and the latest ended ones, up to this many. */
const LISTED = 8;
/** How long ended tasks keep the tracker up once nothing runs (the footer lingers a minute). */
export const LINGER_MS = 5 * 60_000;

/** A `pi-bg:task` entry (src/task-entry.ts). */
export interface TaskRecord {
  version: 1;
  id: string;
  name: string;
  kind: "job" | "service";
  status: "queued" | "running" | "done" | "failed" | "killed" | "timeout";
  origin: "agent" | "user";
  command: string;
  cwd: string;
  logPath: string;
  requestedAt?: number;
  queueReason?: string;
  /** 0 until the task spawns. */
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  ready: boolean;
  keep: boolean;
  killedBy?: string;
  progress?: { fraction: number; count?: string; note?: string };
}

const STATUSES = new Set(["queued", "running", "done", "failed", "killed", "timeout"]);

export function parseTaskRecord(data: unknown): TaskRecord | undefined {
  const d = data as Partial<TaskRecord> | null | undefined;
  if (!d || typeof d !== "object" || d.version !== 1) return undefined;
  if (typeof d.id !== "string" || typeof d.name !== "string" || !Number.isFinite(d.startedAt)) return undefined;
  if (d.kind !== "job" && d.kind !== "service") return undefined;
  if (typeof d.status !== "string" || !STATUSES.has(d.status)) return undefined;
  if (d.status === "queued" && d.startedAt !== 0) return undefined;
  if (d.requestedAt !== undefined && !Number.isFinite(d.requestedAt)) return undefined;
  if (d.queueReason !== undefined && typeof d.queueReason !== "string") return undefined;
  if (d.progress !== undefined && typeof d.progress?.fraction !== "number") return undefined;
  return d as TaskRecord;
}

/** `42s`, `3m 12s`, `1h 5m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const percentOf = (t: TaskRecord) => (t.progress ? `${Math.round(t.progress.fraction * 100)}%` : undefined);
const active = (t: TaskRecord) => t.status === "queued" || t.status === "running";
const orderedAt = (t: TaskRecord) => t.requestedAt ?? t.startedAt;
const reasonOf = (t: TaskRecord) => t.queueReason || "waiting for host capacity";

function taskState(t: TaskRecord): { status: string; tone: UIRow["tone"] } {
  if (t.status === "queued") return { status: "queued", tone: "default" };
  if (t.status === "running") {
    if (t.kind === "service") return { status: t.ready ? "ready" : "starting", tone: "default" };
    return { status: percentOf(t) ?? "running", tone: "default" };
  }
  if (t.status === "done") return { status: "done", tone: "success" };
  if (t.status === "failed") {
    return { status: typeof t.exitCode === "number" ? `failed (exit ${t.exitCode})` : "failed", tone: "danger" };
  }
  if (t.status === "timeout") return { status: "timed out", tone: "danger" };
  return { status: "stopped", tone: "muted" };
}

/** One row per task: name, state, then kind and time. */
export function taskRow(t: TaskRecord, now: number): UIRow {
  const { status, tone } = taskState(t);
  const end = t.endedAt ?? now;
  const spawned = t.startedAt > 0;
  const wait = t.requestedAt === undefined ? undefined : duration((spawned ? t.startedAt : end) - t.requestedAt);
  const inQueue = wait === undefined ? undefined : `${wait} in queue`;
  const time = t.status === "queued" ? [inQueue, reasonOf(t)]
    : !spawned ? [inQueue ?? "never started"]
    : [`${t.status === "running" ? "for" : "after"} ${duration(end - t.startedAt)}`, wait && `waited ${wait}`, t.progress?.note];
  const meta = [t.kind === "service" ? "service" : "", ...time].filter(Boolean).join(" · ");
  return { title: t.name, status, ...(tone !== "default" ? { tone } : {}), meta: meta.slice(0, 200) };
}

const tasksOf = (ctx: AdapterContext): TaskRecord[] => Object.values(ctx.state.get<Record<string, TaskRecord>>(TASKS_KEY) ?? {});

/** The tracker's tasks: active first (oldest first), then the latest ended. */
export function listed(tasks: TaskRecord[]): TaskRecord[] {
  const live = tasks.filter(active).sort((a, b) => orderedAt(a) - orderedAt(b));
  const ended = tasks.filter((t) => !active(t)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...live, ...ended].slice(0, Math.max(LISTED, live.length));
}

function renderTracker(ctx: AdapterContext & Required<Pick<AdapterContext, "setContribution">>, now = Date.now()): void {
  ctx.setPanel("bg", null);
  ctx.setContribution("bg", null);
  ctx.setContribution("bg-pill", null);
  const tasks = listed(tasksOf(ctx));
  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const live = running.length + queued.length > 0;
  const lastEnd = Math.max(0, ...tasks.map((t) => t.endedAt ?? 0));
  if (!live && now - lastEnd > LINGER_MS) {
    ctx.setContribution("bg-tracker", null);
    return;
  }
  const failed = !live && tasks.some((t) => (t.endedAt ?? 0) === lastEnd && (t.status === "failed" || t.status === "timeout"));
  const first = running.find((t) => t.kind === "job") ?? running[0] ?? queued[0];
  const step = first ? [first.name, first.status === "queued" ? "queued" : percentOf(first)].filter(Boolean).join(" ") : undefined;
  const count = [running.length ? `${running.length} running` : undefined, queued.length ? `${queued.length} queued` : undefined].filter(Boolean).join(" · ");
  const rows = tasks.map((t) => taskRow(t, now));
  ctx.setContribution("bg-tracker", {
    placement: "composer.tracker",
    title: "Background",
    node: supports(ctx, "ui.nodes.v2")
      ? { t: "rows", rows }
      : { t: "table", columns: ["Task", "State", "Time"], rows: rows.map((r) => [r.title, r.status ?? "", r.meta ?? ""]) },
    mobileFallback: rows.map((r) => `${r.title}: ${r.status}${r.meta ? ` (${r.meta})` : ""}`).join("\n").slice(0, 2000) || "No tasks",
    tracker: {
      ...(count ? { count } : {}),
      status: live ? "running" : failed ? "error" : "ok",
      ...(step ? { step: step.slice(0, 120) } : {}),
    },
  });
}

function record(task: TaskRecord, ctx: AdapterContext): void {
  const all = ctx.state.get<Record<string, TaskRecord>>(TASKS_KEY) ?? {};
  all[task.id] = task;
  // Keep the active tasks and the latest ended ones.
  const keep = new Set(listed(Object.values(all)).map((t) => t.id));
  ctx.state.set(TASKS_KEY, Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id))));
}

const TOOL_VERBS: Record<string, [string, string]> = {
  bg_run: ["Started", "Starting"],
  bg_wait: ["Waited on", "Waiting on"],
  bg_logs: ["Read logs of", "Reading logs of"],
  bg_kill: ["Stopped", "Stopping"],
};

/** Contract v2: the bg tools' rows (`Started train · job`, `Waited on train · done`). */
export function bgToolView(tool: ToolInfo, ctx: AdapterContext): ToolViewData | undefined {
  const verbs = TOOL_VERBS[tool.name];
  if (!verbs) return undefined;
  const args = (tool.args ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const tasks = ctx.state.get<Record<string, TaskRecord>>(TASKS_KEY) ?? {};
  const details = tool.details as { id?: unknown; status?: unknown } | undefined;
  const id = str("id") || (typeof details?.id === "string" ? details.id : "");
  // `id` may be a task's id or its name.
  const task = id ? (tasks[id] ?? Object.values(tasks).find((t) => t.name === id)) : undefined;
  const meta: string[] = [];
  let target = task?.name ?? (id || str("name"));
  const queuedRun = tool.name === "bg_run" && !tool.isError && (task?.status === "queued" || details?.status === "queued");
  if (tool.name === "bg_run") {
    target = str("name") || task?.name || str("command").split("\n")[0]!.slice(0, 120);
    meta.push(str("kind") === "service" ? "service" : "job");
    if (task?.status === "queued") meta.push(reasonOf(task));
  } else if (tool.name === "bg_wait" && !target) target = "the next task";
  else if (tool.name === "bg_logs" && !target) target = "all tasks";
  if (task && tool.result !== undefined && tool.name !== "bg_run") meta.push(taskState(task).status);
  if (tool.isError) meta.push("failed");
  return {
    kind: tool.name === "bg_run" || tool.name === "bg_kill" ? "command" : "other",
    verb: queuedRun ? "Queued" : verbs[0],
    activeVerb: tool.name === "bg_run" && args.heavy === true ? "Queueing" : verbs[1],
    target: target.slice(0, 500),
    meta,
    ...(tool.name === "bg_run" && str("command") ? { detail: { t: "code", text: str("command"), lang: "bash" } } : {}),
  };
}

export default {
  onRestore: renderBackground,
  toolView: bgToolView,

  onEntry(entry: SessionEntryInfo, ctx: AdapterContext): void {
    if (entry.customType !== TASK_ENTRY) return;
    const task = parseTaskRecord(entry.data);
    if (!task) return;
    record(task, ctx);
    renderBackground(ctx);
  },

  onStatus(key: string, text: string | undefined, ctx: AdapterContext): boolean {
    if (key !== STATUS_KEY) return false;
    // Contract v2 draws the tasks from their entries; the status only refreshes their times.
    if (ctx.setContribution && supports(ctx, "adapter.trackers.v1")) renderBackground(ctx);
    else update(ctx, { ...current(ctx), status: text?.trim() ? text : null });
    return true;
  },

  onWidget(key: string, lines: string[] | undefined, ctx: AdapterContext): boolean {
    if (key !== STATUS_KEY) return false;
    if (!ctx.setContribution || !supports(ctx, "adapter.trackers.v1")) update(ctx, { ...current(ctx), lines: lines ?? [] });
    return true;
  },
};
