// pi-subagents: delegate tasks to Pi subagents, each a `pi --mode rpc` child with its own context.
// One tool, `subagent`: run a single task, parallel tasks, or a chain (with `{previous}`), in the
// foreground or async, with fresh or forked context, optionally in a new worktree; then status,
// steer, stop, and result by run id. When the call leaves the agent, model, or effort open, Jev
// (through Pi's own classifier models) picks them: the agent definition, a model tier from your
// settings, and a thinking level.
//
// With pi-bg installed the two work as one (activity.ts): pi-bg's background tasks are a section of
// the subagents panel and are listed in FleetView, and async runs are outside work pi-bg's bg_wait
// can wait on (`subagent:<id>`). Each works alone without the other.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, type ActivityEntry, type ActivitySection, FLEET_HOST_PRIORITY, hostOutranks, readHost } from "./activity.ts";
import { type AgentDef, discoverAgents } from "./agents.ts";
import { MENTION_TYPE, mentionGuidance, subagentAutocomplete } from "./mentions.ts";
import { CACHE_RETENTIONS, type CacheRetention, Child, type ChildState, answerSubagentEnvProbes, requestSubagentEnv, subagentDepth, type Usage, addUsage, emptyUsage } from "./child.ts";
import { agentDir, loadConfig } from "./config.ts";
import { Conversation, type Message, readTranscript, transcriptWriter } from "./conversation.ts";
import { type JevConfig, askJev } from "./jev.ts";
import { runLabel, taskLabel } from "./label.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TIER_DESCRIPTIONS, type Given, type Resolved, type Threshold, type Tier, pickQuestions, providerTiers, readPicks, resolve } from "./pick.ts";
import { REFERENCE_TYPE, type RunRef, referenceContext, runAutocomplete } from "./references.ts";
import { type Run, displayTokens, transcriptPath } from "./run.ts";
import { clip, recentTexts } from "./transcript.ts";
import { FleetView, SUCCESS_HINT_MS } from "./ui/fleet.ts";
import type { ViewerActions } from "./ui/viewer.ts";
import { elapsedMs, formatCount, formatElapsed, shortModel } from "./ui/format.ts";
import { RunsWidget, WIDGET_MODES, type WidgetMode } from "./ui/widget.ts";

/** How readily the main agent delegates: `economical` (default) or `conservative`. */
export type Delegation = "conservative" | "economical";
export const DELEGATIONS: readonly Delegation[] = ["conservative", "economical"];

export interface SubagentsConfig extends Record<string, unknown> {
  /** `threshold`: how sure Jev must be to climb to a stronger tier or effort, from no quota pressure (`relaxed`) to full (`tight`). */
  jev: JevConfig & { threshold: Threshold };
  /** The tool's first prompt guideline: hand settled implementation to cheaper tiers (`economical`, default) or delegate only clear wins (`conservative`). */
  delegation: Delegation;
  /** Legacy tier defaults; only entries matching the parent's provider apply. */
  tiers: Partial<Record<Tier, string>>;
  /** Provider-specific tier defaults, selected using the current parent model. */
  providerTiers: Record<string, Partial<Record<Tier, string>>>;
  tierDescriptions: Record<Tier, string>;
  maxParallel: number;
  concurrency: number;
  /** Which runs the widget above the editor shows: none (default; FleetView below the prompt shows them, as in Claude Code), async ones, or all. */
  widget: WidgetMode;
  /** The list of subagents below the editor that ↓ at an empty prompt moves into. */
  fleetView: boolean;
  /** Levels of subagents below the main session: 2 lets a child start children of its own, 1 does not. */
  maxDepth: number;
  /** Prompt-cache TTL for children: `short` (5 minutes on Anthropic; default), `long` (1 hour) or `inherit` the parent's `PI_CACHE_RETENTION`. */
  childCacheRetention: CacheRetention;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 3_000, threshold: { ...DEFAULT_THRESHOLD } },
  delegation: "economical",
  tiers: {},
  providerTiers: {},
  tierDescriptions: DEFAULT_TIER_DESCRIPTIONS,
  maxParallel: 8,
  concurrency: 4,
  widget: "off",
  fleetView: true,
  maxDepth: 2,
  childCacheRetention: "short",
};

const CONSERVATIVE_GUIDELINE =
  "Prefer direct work for routine investigation, diagnosis, and verification. Do not delegate merely because work is long or multistep, or commission a redundant audit of work you are already doing. Delegate only genuinely independent tasks with a clear payoff or when requested; when delegating report-back work, use headless subagents rather than interactive Herdr sessions.";
const ECONOMICAL_GUIDELINE =
  "Once the design is settled and what remains is implementation that follows from it (applying a decided change across files, writing tests to a given spec, mechanical refactors, running checks and fixing what fails), delegate it to a subagent with a precise, self-contained spec and no model, so Jev picks a cheaper tier; then review the result (diff, check output) yourself instead of redoing it. Do it directly when the spec would be about as long as the work, the remaining decisions are judgment calls, or the work needs most of this conversation's context. Do not commission redundant audits of work you are already doing; use headless subagents rather than interactive Herdr sessions for report-back work.";

/** The `subagent` tool's prompt guidelines for a `delegation` setting (anything unknown is the default, economical). */
export function promptGuidelines(delegation: unknown): string[] {
  return [
    delegation === "conservative" ? CONSERVATIVE_GUIDELINE : ECONOMICAL_GUIDELINE,
    "Give each subagent a complete, self-contained task: it cannot see this conversation unless context is fork.",
    "Give each task a short descriptive label; omit it to derive one deterministically from the task.",
    "Use parallel tasks for independent work and a chain when a step needs the previous step's output.",
    "Use worktree only when the user requests a worktree or branch isolation; otherwise ask first. An authorized worktree task remains a headless subagent.",
  ];
}

/** `quota:pressure` from pi-auto-effort: how close a provider is to its usage limit. */
export const QUOTA_PRESSURE = "quota:pressure";
export interface QuotaPressure {
  provider: string;
  tier: "none" | "caution" | "critical";
  /** 0..1 */
  p: number;
  label?: string;
}

/** A valid `quota:pressure` payload with `p` clamped to 0..1, or undefined. */
export function readPressure(data: unknown): QuotaPressure | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.provider !== "string" || !d.provider || typeof d.p !== "number" || !Number.isFinite(d.p)) return undefined;
  const tier = d.tier === "caution" || d.tier === "critical" ? d.tier : "none";
  return { provider: d.provider, tier, p: Math.min(1, Math.max(0, d.p)), ...(typeof d.label === "string" ? { label: d.label } : {}) };
}

/** ` (Jev)`, or ` (Jev, p=0.5)` for a pick made under quota pressure. */
export function jevMark(on: boolean, pressure?: number): string {
  if (!on) return "";
  return pressure && pressure > 0 ? ` (Jev, p=${pressure.toFixed(1)})` : " (Jev)";
}

const MAX_LINES = 2_000;
const MAX_BYTES = 50 * 1024;
const RUN_ENTRY = "subagents:run";

const TaskItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name; omit to let Jev choose" })),
  task: Type.String({ description: "The complete, self-contained task" }),
  label: Type.Optional(Type.String({ description: "Short task name for lists and headings; omit to derive from the task" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
  model: Type.Optional(Type.String({ description: "provider/model; omit for the agent's or Jev's tier on the parent's provider; explicit models may cross providers" })),
  thinking: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh|max; omit to let Jev choose" })),
});

const Params = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("steer"), Type.Literal("stop"), Type.Literal("result")], {
      description: "run (default), status, steer, stop, or result",
    }),
  ),
  agent: Type.Optional(Type.String({ description: "Agent for a single task; omit to let Jev choose" })),
  task: Type.Optional(Type.String({ description: "A single task" })),
  label: Type.Optional(Type.String({ description: "Short name for a single task; omit to derive from the task" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks (up to 8, 4 at a time)" })),
  chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential steps; {previous} in a task is replaced by the previous step's output" })),
  async: Type.Optional(Type.Boolean({ description: "Return at once and deliver results as messages when done (default false)" })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fresh (default) or fork this conversation" })),
  worktree: Type.Optional(Type.Boolean({ description: "Run each task in a new git worktree, only when the user requests a worktree or branch isolation; otherwise ask (default false)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: the session's)" })),
  model: Type.Optional(Type.String({ description: "provider/model for a single task; explicit models may cross providers" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level for a single task" })),
  id: Type.Optional(Type.String({ description: "Run id (or prefix) for status, steer, stop, result" })),
  message: Type.Optional(Type.String({ description: "Steering message for steer" })),
});

type Item = { agent?: string; task: string; label?: string; cwd?: string; model?: string; thinking?: string };

export interface RunView {
  id: string;
  agent: string;
  task: string;
  label?: string;
  model: string;
  thinking: string;
  byJev: Resolved["byJev"];
  /** The quota pressure Jev's model or effort pick was made under, when above 0. */
  pressure?: number;
  status: ChildState["status"];
  /** Native child history, when Pi reported its session path. */
  sessionFile?: string;
  activity?: string;
  turns: number;
  tokens: number;
  cost: number;
  seconds: number;
  error?: string;
  output?: string;
}

interface Details {
  mode: "single" | "parallel" | "chain";
  runs: RunView[];
}

function view(run: Run, withOutput = false): RunView {
  const s = run.state;
  return {
    id: run.id,
    agent: run.agent,
    task: run.task,
    label: runLabel(run),
    model: s.model ?? run.model,
    thinking: run.thinking,
    byJev: run.byJev,
    ...(run.pressure ? { pressure: run.pressure } : {}),
    status: s.status,
    ...(s.sessionFile ? { sessionFile: s.sessionFile } : {}),
    ...(s.activity ? { activity: s.activity } : {}),
    turns: s.turns,
    tokens: displayTokens(s.usage),
    cost: s.usage.cost.total,
    seconds: Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000),
    ...(s.error ? { error: clip(s.error, 400) } : {}),
    ...(withOutput && s.output ? { output: clip(s.output, 2_000) } : {}),
  };
}

/** A run record as saved in the session. */
type RecordedRun = RunView & { outputPath: string; async: boolean };

/** A run known only from its record: its saved conversation, or else its task and output. */
export function recordedRun(v: RecordedRun): Run {
  let messages: Message[] | undefined = readTranscript(transcriptPath(v.outputPath));
  if (!messages?.length) {
    let output = v.output ?? "";
    try {
      output = readFileSync(v.outputPath, "utf8");
    } catch {
      // Only the record is left.
    }
    messages = [{ role: "user", content: [{ type: "text", text: v.task }] }, ...(output ? [{ role: "assistant", content: [{ type: "text" as const, text: output }] }] : [])];
  }
  const usage = emptyUsage();
  usage.input = v.tokens ?? 0;
  usage.cost.total = v.cost ?? 0;
  return {
    id: v.id,
    agent: v.agent,
    task: v.task,
    label: runLabel(v),
    model: v.model,
    thinking: v.thinking,
    byJev: v.byJev ?? { agent: false, model: false, thinking: false },
    ...(typeof v.pressure === "number" && v.pressure > 0 ? { pressure: v.pressure } : {}),
    cwd: "",
    async: Boolean(v.async),
    // A record still "running" belongs to a process that is gone.
    state: { status: v.status === "running" ? "stopped" : v.status, output: "", usage, turns: v.turns ?? 0, startedAt: 0, endedAt: (v.seconds ?? 0) * 1000, ...(v.sessionFile ? { sessionFile: v.sessionFile } : {}), ...(v.error ? { error: v.error } : {}) },
    conversation: Conversation.from(messages),
    outputPath: v.outputPath,
  };
}

/** Cut to 2,000 lines or 50 KB, keeping the start; say where the rest is. */
export function truncateOutput(text: string, fullPath: string): string {
  let lines = text.split("\n");
  let cut = false;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    cut = true;
  }
  let out = lines.join("\n");
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(0, MAX_BYTES).toString().replace(/\uFFFD$/u, "");
    cut = true;
  }
  return cut ? `${out}\n\n[Output truncated. Full output: ${fullPath}]` : out;
}

function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 24) || "task";
}

export default function subagents(pi: ExtensionAPI) {
  // At the deepest level allowed, a subagent gets no subagent tool, so nesting cannot run away.
  const initial = loadConfig("pi-subagents", DEFAULT_CONFIG, process.cwd());
  if (subagentDepth() >= initial.maxDepth) return;
  const runs = new Map<string, Run>();
  let config: SubagentsConfig = initial;
  /** The latest quota pressure per provider (pi-auto-effort's `quota:pressure`); none known is 0. */
  const pressures = new Map<string, QuotaPressure>();
  pi.events.on(QUOTA_PRESSURE, (data) => {
    const pressure = readPressure(data);
    if (pressure) pressures.set(pressure.provider, pressure);
  });
  const pressureFor = (provider: string) => pressures.get(provider)?.p ?? 0;
  let backgroundCount = 0;
  /** Numbers each async call's herdr:background hold. */
  let holdCount = 0;
  /** Tasks waiting for a free slot (parallel) or their turn (chain), by sync/async. */
  const queued = { async: 0, sync: 0 };
  /** For each foreground run: move its whole call to the background. */
  const detachers = new Map<string, () => void>();

  const widgetMode = (): WidgetMode => (WIDGET_MODES.includes(config.widget) ? config.widget : "off");
  /** Other extensions' sources whose pills end FleetView (pi-bg's tasks), while we host them. */
  const sections = new Map<string, ActivitySection>();
  let hosting = false;
  /** Our identity as a host (activity.ts): the list under the prompt, which outranks the pill host. */
  const me = { host: "subagents", priority: FLEET_HOST_PRIORITY };
  /** Hosts that outrank us and are present (none in this suite; the rule is still honored). */
  const yieldedTo = new Set<string>();
  const hostedSections = () => [...sections.values()];
  /** When the user last sent a message: failed and stopped runs that ended before it leave the views. */
  let dismissedAt = 0;
  /** Runs dismissed with `x` (in FleetView or pi-bg's dialog). */
  const dismissed = new Set<string>();
  const widget = new RunsWidget({
    runs: () => [...runs.values()],
    queued: (mode) => queued.async + (mode === "all" ? queued.sync : 0),
    mode: widgetMode,
    dismissedAt: () => dismissedAt,
    open: (runId) => {
      const ui = boundUI;
      const run = runs.get(runId);
      if (ui && run) void fleet.show(ui, run).catch(() => undefined);
    },
  });
  /** Steer and stop for the viewer; only a live child takes either. */
  const viewerActions = (run: Run, ui: Pick<ExtensionContext["ui"], "notify">): ViewerActions => ({
    steer: (message) => run.child?.steer(message) ?? false,
    background: () => detachers.get(run.id)?.(),
    canBackground: () => detachers.has(run.id),
    stop: () => {
      run.child?.stop();
      ui.notify(`Stopping subagent ${runLabel(run)} · ${run.agent} (${run.id}).`, "info");
    },
    // The composer asks for the suite's editor (pi-vim's) through the bus, falling back to pi's input.
    events: { emit: (channel, data) => safely(() => pi.events.emit(channel, data)) },
  });
  let boundUI: ExtensionContext["ui"] | undefined;
  const fleet = new FleetView({
    runs: () => [...runs.values()],
    enabled: () => config.fleetView !== false,
    actions: (run) => viewerActions(run, boundUI ?? { notify: () => undefined }),
    sections: hostedSections,
    dismissedAt: () => dismissedAt,
    dismissed: () => dismissed,
    dismiss: (runId) => {
      dismissed.add(runId);
      refreshUI();
    },
    // A subagent's session view draws main's footer and editor for the child.
    contextWindow: (model) => {
      const slash = model.indexOf("/");
      if (slash <= 0 || !sessionCtx) return undefined;
      try {
        return sessionCtx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))?.contextWindow;
      } catch {
        return undefined;
      }
    },
    settings: () => {
      try {
        const s = pi.getSettings() as { hideThinkingBlock?: unknown; editorPaddingX?: unknown };
        return { hideThinkingBlock: s.hideThinkingBlock === true, editorPaddingX: Math.max(0, Math.min(3, Math.floor(Number(s.editorPaddingX) || 0))) };
      } catch {
        return {};
      }
    },
    // Claude Code: a background subagent that succeeds leaves the panel at once, with this for 30 s.
    note: (now) => {
      const latest = Math.max(0, ...[...runs.values()].filter((r) => r.async && r.state.status === "done").map((r) => r.state.endedAt ?? 0));
      if (!latest || now - latest >= SUCCESS_HINT_MS) return undefined;
      return `${sections.has("bg") ? "/tasks" : "/subagents"} to see subagents`;
    },
  });
  // The user's next message dismisses failures and stops they have had a chance to see.
  pi.on("input", (event) => {
    if ((event as { source?: string }).source !== "interactive") return;
    dismissedAt = Date.now();
    refreshUI();
  });

  /** Our runs as a source for pi-bg's background-tasks dialog (activity.ts). */
  const runStatus = (r: Run): ActivityEntry["status"] =>
    r.state.status === "running" ? "running" : r.state.status === "done" ? "done" : r.state.status === "stopped" ? "stopped" : "failed";
  const ownSource: ActivitySection = {
    id: "subagents",
    title: "subagents",
    noun: "agent",
    entries: (now) => {
      const all = [...runs.values()].filter((r) => !dismissed.has(r.id));
      const running = all.filter((r) => r.state.status === "running").sort((a, b) => a.state.startedAt - b.state.startedAt);
      const ended = all.filter((r) => r.state.status !== "running").sort((a, b) => (b.state.endedAt ?? 0) - (a.state.endedAt ?? 0));
      return [...running, ...ended].map((r) => ({
        key: r.id,
        label: runLabel(r),
        detail: r.agent,
        status: runStatus(r),
        stats: `${r.state.status === "running" ? "" : `${r.state.status} · `}${formatElapsed(elapsedMs(r, now))} · ↓ ${formatCount(displayTokens(r.state.usage))} tokens`,
        startedAt: r.state.startedAt,
        ...(r.state.endedAt ? { endedAt: r.state.endedAt } : {}),
      }));
    },
    open: (key, ui) => {
      const run = runs.get(key);
      const u = ui as ExtensionContext["ui"];
      return run ? fleet.show(u, run) : Promise.resolve();
    },
    stop: (key) => runs.get(key)?.child?.stop(),
    dismiss: (key) => {
      dismissed.add(key);
      refreshUI();
    },
  };

  /** Show a source's pill at the end of FleetView, if we host (an interactive session with FleetView on, outranked by no one). */
  const accept = (section: ActivitySection) => {
    if (!hosting || yieldedTo.size > 0 || section.id === ownSource.id) return;
    const previous = sections.get(section.id);
    // The same source offered again (it re-offers when a host announces itself) is already shown.
    if (previous === section) return;
    previous?.setHosted?.(false, me.host);
    sections.set(section.id, section);
    section.setHosted?.(true, me.host);
    refreshUI();
  };
  /** Let every hosted source go (it draws its own pill again, or a lesser host counts it). */
  const releaseSections = () => {
    for (const section of sections.values()) {
      try {
        section.setHosted?.(false, me.host);
      } catch {
        // Its session may already be gone.
      }
    }
    sections.clear();
  };
  const stopHosting = () => {
    hosting = false;
    yieldedTo.clear();
    releaseSections();
  };
  /** Announce ourselves: sources offer themselves again, lesser hosts yield. */
  const announce = () => {
    if (hosting && yieldedTo.size === 0) safely(() => pi.events.emit(ACTIVITY_HOST, { ...me }));
  };
  answerSubagentEnvProbes(pi.events);
  pi.events.on(ACTIVITY_SECTION, (data) => {
    const section = (data as { section?: ActivitySection } | undefined)?.section;
    if (section && typeof section.pill === "function" && typeof section.setHosted === "function") accept(section);
  });
  pi.events.on(ACTIVITY_HOST, (data) => {
    const other = readHost(data);
    if (other.host === me.host || !hosting) return;
    if (hostOutranks(other, me)) {
      // A greater host (none in this suite) takes the pills: we let ours go until it is gone.
      yieldedTo.add(other.host);
      releaseSections();
      refreshUI();
    } else {
      // A lesser host (pi-bg's pill) announcing itself: it yields once it hears from us.
      announce();
    }
  });
  pi.events.on("activity:prompt-tab", (data) => {
    const request = data as { handled?: boolean; phase?: string } | undefined;
    if (request && !request.handled && hosting && yieldedTo.size === 0) request.handled = fleet.tab(request.phase === "active");
  });
  pi.events.on(ACTIVITY_CHANGED, (data) => {
    if (sections.has((data as { id?: string } | undefined)?.id ?? "")) refreshUI();
  });
  pi.events.on(ACTIVITY_GONE, (data) => {
    const id = (data as { id?: string } | undefined)?.id ?? "";
    if (sections.delete(id)) refreshUI();
    // A greater host left: we host again, and say so.
    if (yieldedTo.delete(id)) announce();
  });
  /**
   * Whether this runtime's session is live. After `session_shutdown` (a reload, /new, /resume) pi
   * marks the runtime stale and every pi.* call throws; a child that ends later must not call it,
   * or the unhandled rejection takes pi down.
   */
  let live = false;
  let lifetime = new AbortController();
  let sessionCtx: ExtensionContext | undefined;
  const safely = (fn: () => void) => {
    if (!live) return;
    try {
      fn();
    } catch {
      // The runtime went stale between the check and the call.
    }
  };
  /**
   * Results owed to the agent. Sent only while pi is idle: a follow-up queued during a turn is
   * dropped when the user presses Esc. Several that pile up go out as one message.
   */
  const consumedResults = new Set<string>();
  const owedResults: { content: string; details: unknown; runs?: Run[]; mode?: Details["mode"] }[] = [];
  const deliverResult = (content: string, details?: unknown, runs?: Run[], mode?: Details["mode"]) => {
    if (!live) return;
    owedResults.push({ content, details, runs, mode });
    flushResults(sessionCtx);
  };
  const flushResults = (c: Pick<ExtensionContext, "isIdle"> | undefined) => {
    if (!live || !owedResults.length || c?.isIdle?.() === false) return;
    const items = owedResults.splice(0).flatMap((item) => {
      if (!item.runs) return [item];
      const unread = item.runs.filter((run) => !consumedResults.has(run.id));
      return unread.length ? [{ ...item, runs: unread, content: `${finishedHeadline(item.mode, unread)}\n\n${unread.map(resultText).join("\n\n---\n\n")}`, details: { mode: item.mode, runs: unread.map((run) => view(run, true)) } }] : [];
    });
    if (!items.length) return;
    safely(() => {
      pi.sendMessage(
        { customType: "subagent-result", content: items.map((i) => i.content).join("\n\n---\n\n"), display: true, details: items.length === 1 ? items[0]?.details : { batches: items.map((i) => i.details) } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      for (const item of items) for (const run of item.runs ?? []) consumedResults.add(run.id);
    });
  };
  pi.on("agent_settled", (_event, c) => flushResults(c));
  pi.events.on("bg:external-consumed", (data) => {
    const id = (data as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !id.startsWith("subagent:")) return;
    const run = runs.get(id.slice("subagent:".length));
    if (run && run.state.status !== "running") consumedResults.add(run.id);
  });

  /** Async runs as outside work pi-bg's bg_wait can wait on; nothing listens without pi-bg. */
  const external = (run: Run, chain?: { step: number; of: number }) => {
    const done = run.state.status !== "running";
    const elapsed = Math.round(((run.state.endedAt ?? Date.now()) - run.state.startedAt) / 1000);
    // A chain's result message comes only after its last step.
    const after =
      chain && chain.step < chain.of ? `; step ${chain.step} of ${chain.of} in a chain, which goes on (its result arrives after the last step)` : "; its result arrives as a message";
    safely(() =>
      pi.events.emit("bg:external", {
        id: `subagent:${run.id}`,
        label: `${runLabel(run)} · ${run.agent}`,
        state: !done ? "running" : run.state.status === "done" ? "done" : "failed",
        ...(done ? { summary: `${run.state.status} after ${elapsed}s${chain && chain.step < chain.of ? after : ""}`, result: resultText(run) } : {}),
      }),
    );
  };
  /** Whether pi-bg is loaded (it answers bg:probe). */
  const hasBg = () => {
    let yes = false;
    pi.events.emit("bg:probe", { reply: () => (yes = true) });
    return yes;
  };
  const bindUI = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    boundUI = ctx.ui;
    widget.setUI(ctx.ui);
    fleet.setUI(ctx.ui);
  };
  const refreshUI = () => {
    widget.update();
    fleet.update();
  };

  const findRun = (id: string | undefined) => {
    if (!id) return undefined;
    const exact = runs.get(id);
    if (exact) return exact;
    const matches = [...runs.values()].filter((r) => r.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  };

  const record = (run: Run) => {
    safely(() => pi.appendEntry(RUN_ENTRY, { ...view(run), outputPath: run.outputPath, async: run.async }));
  };

  /** This session's runs, newest first: live ones, then those known only from their records (before a reload). */
  const allRuns = (ctx: Pick<ExtensionContext, "sessionManager">): Array<{ view: RunView; run: () => Run }> => {
    const latest = new Map<string, RecordedRun>();
    for (const e of ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: RecordedRun }>) {
      if (e.type === "custom" && e.customType === RUN_ENTRY && e.data && !runs.has(e.data.id)) latest.set(e.data.id, e.data);
    }
    return [
      ...[...latest.values()].map((v) => ({ view: v, run: () => recordedRun(v) })),
      ...[...runs.values()].map((r) => ({ view: view(r), run: () => r })),
    ].reverse();
  };
  /** The same runs, as `@run:` references. */
  const runRefs = (ctx: Pick<ExtensionContext, "sessionManager">): RunRef[] =>
    allRuns(ctx).map((e) => ({ id: e.view.id, agent: e.view.agent, task: e.view.task, ...(e.view.label ? { label: e.view.label } : {}), status: e.view.status, model: e.view.model, run: e.run }));

  /** Jev's picks for the gaps in each item, one request per item, in parallel. */
  const plan = async (ctx: ExtensionContext, items: Item[], agents: AgentDef[], signal: AbortSignal | undefined) => {
    const parent = { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", thinking: pi.getThinkingLevel() };
    const tiers = {
      models: providerTiers(parent.model, config.tiers, config.providerTiers, ctx.modelRegistry?.getAll?.() ?? []),
      descriptions: config.tierDescriptions,
    };
    const askTier = Object.values(tiers.models).some(Boolean);
    const parentRequest = clip(recentTexts(ctx.sessionManager.getBranch()).user, 2_000);
    return Promise.all(
      items.map(async (item) => {
        const given: Given = { ...(item.agent ? { agent: item.agent } : {}), ...(item.model ? { model: item.model } : {}), ...(item.thinking ? { thinking: item.thinking } : {}) };
        const questions = pickQuestions(given, agents, tiers, askTier);
        let picks: ReturnType<typeof readPicks> | undefined;
        if (Object.keys(questions).length) {
          const outcome = await askJev(ctx.modelRegistry, config.jev, { task: clip(item.task, 6_000), parent_request: parentRequest || "(none)" }, questions, signal);
          if (outcome.ok) picks = readPicks(outcome.answers, { pressure: pressureFor(parent.model.split("/")[0]!), threshold: config.jev.threshold });
        }
        const resolved = resolve(given, agents, picks, tiers, parent);
        if ("error" in resolved) return resolved;
        if (!resolved.model) return { error: "No model: the session has no model selected; pass `model`." };
        return resolved;
      }),
    );
  };

  const worktreeFor = async (cwd: string, task: string, signal: AbortSignal): Promise<string> => {
    const branch = `subagent/${slug(task)}-${shortId()}`;
    // <repo>/.worktrees/<branch, slashes as dashes>: the location every harness shares.
    const common = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 10_000, signal });
    if (common.code !== 0) throw new Error(`worktree ${branch} failed: not in a git repository: ${cwd}`);
    if (signal.aborted) throw new Error("Cancelled before any subagent started.");
    const dir = `${common.stdout.trim().replace(/\/\.git\/?$/u, "")}/.worktrees/${branch.replaceAll("/", "-")}`;
    const result = await pi.exec("git", ["worktree", "add", "-q", "-b", branch, dir, "HEAD"], { cwd, timeout: 60_000, signal });
    if (result.code !== 0) throw new Error(`git worktree add ${branch} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    return dir;
  };

  const startRun = (
    ctx: ExtensionContext,
    item: Item,
    resolved: Resolved,
    options: { cwd: string; fork?: string; async: boolean; owner: AbortSignal; onUpdate: () => void },
  ): Run => {
    const id = shortId();
    const outputPath = path.join(agentDir(), "subagents", id, "output.md");
    let sessionRecorded = false;
    const child = new Child({
      task: item.task,
      cwd: options.cwd,
      model: resolved.model,
      thinking: resolved.thinking,
      ...(resolved.agent.tools ? { tools: resolved.agent.tools } : {}),
      ...(resolved.agent.prompt ? { systemPrompt: resolved.agent.prompt } : {}),
      ...(resolved.agent.maxTurns ? { maxTurns: resolved.agent.maxTurns } : {}),
      ...(options.fork ? { forkSession: options.fork } : {}),
      cacheRetention: CACHE_RETENTIONS.includes(config.childCacheRetention) ? config.childCacheRetention : "short",
      sessionDir: path.join(agentDir(), "subagents", "sessions"),
      env: requestSubagentEnv(pi.events),
      onUpdate: (state) => {
        run.state = state;
        // Preserve the discovered path even if this runtime shuts down before the child finishes.
        if (!sessionRecorded && state.sessionFile && state.status === "running" && !options.owner.aborted) {
          sessionRecorded = true;
          record(run);
        }
        options.onUpdate();
      },
      onMessage: transcriptWriter(transcriptPath(outputPath)),
    });
    const run: Run = {
      id,
      agent: resolved.agent.name,
      task: item.task,
      label: taskLabel(item.task, item.label),
      model: resolved.model,
      thinking: resolved.thinking,
      byJev: resolved.byJev,
      ...(resolved.pressure ? { pressure: resolved.pressure } : {}),
      ...(resolved.tier ? { tier: resolved.tier } : {}),
      ...(resolved.agent.maxTurns ? { maxTurns: resolved.agent.maxTurns } : {}),
      cwd: options.cwd,
      async: options.async,
      state: child.state,
      child,
      conversation: child.conversation,
      outputPath,
    };
    runs.set(id, run);
    child.start();
    record(run);
    refreshUI();
    void child.done.then((state) => {
      run.state = state;
      try {
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, state.output || state.error || "(no output)");
      } catch {
        // The output stays in memory.
      }
      run.child = undefined;
      if (!options.owner.aborted) {
        record(run);
        refreshUI();
      }
    });
    return run;
  };

  /**
   * The result message's first line: which runs ended and how. herdr-web-ui's phone chat shows a
   * custom message as a collapsed card labelled with its first line (cut at 96 characters), so this
   * line is all a phone shows of the result until it is opened.
   */
  const finishedHeadline = (mode: Details["mode"] | undefined, list: Run[]) => {
    if (list.length === 1) {
      const run = list[0]!;
      return `Subagent "${clip(runLabel(run), 60)}" ${run.state.status === "done" ? "finished" : run.state.status} after ${formatElapsed(elapsedMs(run))}:`;
    }
    const bad = list.filter((run) => run.state.status !== "done").length;
    const labels = clip(list.map((run) => runLabel(run)).join(", "), 60);
    return `${list.length} subagents (${mode ?? "runs"}) finished${bad ? `, ${bad} not done` : ""}: ${labels}:`;
  };

  const resultText = (run: Run) => {
    const s = run.state;
    const head = `[${runLabel(run)} · ${run.agent} · ${s.model ?? run.model} · ${run.thinking} · ${s.status}${s.error ? `: ${clip(s.error, 300)}` : ""}]`;
    // A blank line keeps the Markdown answer from running into the header when it is rendered.
    return `${head}\n\n${truncateOutput(s.output || "(no output)", run.outputPath)}`;
  };

  const usageOf = (list: Run[]): Usage => list.reduce((sum, r) => addUsage(sum, r.state.usage), emptyUsage());

  /** `@subagent:<name>` completes to a discovered agent and `@run:` to this session's runs; once per runtime (a reload clears pi's providers). */
  let autocompleteAdded = false;
  pi.on("session_start", (_event, ctx) => {
    lifetime.abort();
    lifetime = new AbortController();
    live = true;
    sessionCtx = ctx;
    config = loadConfig("pi-subagents", DEFAULT_CONFIG, ctx.cwd);
    // The guidelines are part of the tool's registration: a project's `delegation` re-registers it.
    if (delegationOf(config) !== registeredDelegation) registerSubagentTool(delegationOf(config));
    bindUI(ctx);
    if (boundUI && !autocompleteAdded && typeof ctx.ui.addAutocompleteProvider === "function") {
      autocompleteAdded = true;
      try {
        ctx.ui.addAutocompleteProvider((current) => runAutocomplete(subagentAutocomplete(current, () => discoverAgents(sessionCtx?.cwd ?? ctx.cwd)), () => (sessionCtx ? runRefs(sessionCtx) : [])));
      } catch {
        // An older pi without the hook: mentions still guide the model.
      }
    }
    // Host other extensions' pills at the end of FleetView, when it is on.
    hosting = Boolean(boundUI) && config.fleetView !== false;
    yieldedTo.clear();
    announce();
    // Our runs, for pi-bg's background-tasks dialog.
    if (boundUI) pi.events.emit(ACTIVITY_SECTION, { section: ownSource });
    refreshUI();
  });

  // A prompt mentioning `@subagent:<name>`: tell the model which discovered agent that is and how to
  // delegate to it (an unknown name is named as such, with the agents that exist).
  pi.on("before_agent_start", (event, ctx) => {
    if (!("prompt" in event)) return undefined;
    const guidance = mentionGuidance(event.prompt, discoverAgents(ctx.cwd));
    if (!guidance) return undefined;
    return { message: { customType: MENTION_TYPE, content: guidance, display: false } };
  });

  // A prompt referencing `@run:<label-or-id>`: give the model that run's task, result and a compact
  // transcript (an unknown token is named as such, with the runs that exist).
  pi.on("before_agent_start", (event, ctx) => {
    if (!("prompt" in event)) return undefined;
    const context = referenceContext(event.prompt, runRefs(ctx));
    if (!context) return undefined;
    return { message: { customType: REFERENCE_TYPE, content: context, display: false } };
  });

  pi.on("session_shutdown", () => {
    lifetime.abort();
    for (const run of runs.values()) run.child?.stop();
    stopHosting();
    safely(() => pi.events.emit(ACTIVITY_GONE, { id: ownSource.id }));
    live = false;
    owedResults.length = 0;
    consumedResults.clear();
    sessionCtx = undefined;
    boundUI = undefined;
    // The UI may already be gone; each part still lets go of its timers and listeners.
    for (const part of [widget, fleet]) {
      try {
        part.dispose();
      } catch {
        // stale UI
      }
    }
  });

  const delegationOf = (c: SubagentsConfig): Delegation => (DELEGATIONS.includes(c.delegation) ? c.delegation : DEFAULT_CONFIG.delegation);
  let registeredDelegation: Delegation | undefined;
  const registerSubagentTool = (delegation: Delegation) => {
    registeredDelegation = delegation;
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Each subagent adds its own context and token usage. action=run (default): a single `task`, parallel `tasks`, or a `chain` whose steps can use {previous}. Omit agent, model, or thinking to let Jev choose them; implicit models stay on the parent session's provider. `async: true` returns run ids at once and delivers each result as a message. action=status|steer|stop|result take `id` (steer also `message`).",
      promptSnippet: "Delegate self-contained tasks to subagents with their own context windows",
      promptGuidelines: promptGuidelines(delegation),
      parameters: Params,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        config = loadConfig("pi-subagents", DEFAULT_CONFIG, ctx.cwd);
        bindUI(ctx);
        const action = params.action ?? "run";

        if (action !== "run") {
          if (action === "status" && !params.id) {
            const all = [...runs.values()];
            const text = all.length ? all.map((r) => `${r.id}  ${r.state.status.padEnd(7)} ${runLabel(r)} · ${r.agent}`).join("\n") : "No subagent runs in this session.";
            return { content: [{ type: "text", text }], details: { mode: "single", runs: all.map((r) => view(r)) } as Details };
          }
          const run = findRun(params.id);
          if (!run) throw new Error(`No run ${params.id ?? "(missing id)"}. Use action=status to list runs.`);
          if (action === "steer") {
            if (!params.message?.trim()) throw new Error("steer needs `message`.");
            if (!run.child?.steer(params.message)) throw new Error(`Run ${run.id} is ${run.state.status}; only running runs can be steered.`);
            return { content: [{ type: "text", text: `Steered ${run.id}.` }], details: { mode: "single", runs: [view(run)] } as Details };
          }
          if (action === "stop") {
            run.child?.stop();
            return { content: [{ type: "text", text: `Stopping ${run.id}.` }], details: { mode: "single", runs: [view(run)] } as Details };
          }
          if (action === "result") {
            if (run.state.status !== "running") consumedResults.add(run.id);
            let output = run.state.output;
            try {
              output = readFileSync(run.outputPath, "utf8");
            } catch {
              // still running or not written
            }
            const text = `[${runLabel(run)} · ${run.agent} · ${run.state.status}]\n\n${truncateOutput(output || "(no output yet)", run.outputPath)}`;
            return { content: [{ type: "text", text }], details: { mode: "single", runs: [view(run, true)] } as Details };
          }
          return { content: [{ type: "text", text: JSON.stringify(view(run, true), null, 2) }], details: { mode: "single", runs: [view(run, true)] } as Details };
        }

        const mode: Details["mode"] = params.tasks?.length ? "parallel" : params.chain?.length ? "chain" : "single";
        const rawItems: Item[] =
          mode === "parallel"
            ? (params.tasks as Item[])
            : mode === "chain"
              ? (params.chain as Item[])
              : params.task
                ? [{ task: params.task, ...(params.label ? { label: params.label } : {}), ...(params.agent ? { agent: params.agent } : {}), ...(params.model ? { model: params.model } : {}), ...(params.thinking ? { thinking: params.thinking } : {}) }]
                : [];
        // Resolve names before chain expansion: previous output must never rename a step.
        const items = rawItems.map((item) => ({ ...item, label: taskLabel(item.task, item.label) }));
        if (!items.length) throw new Error("run needs `task`, `tasks`, or `chain`.");
        if (mode === "parallel" && items.length > config.maxParallel) throw new Error(`At most ${config.maxParallel} parallel tasks.`);
        const fork = params.context === "fork" ? ctx.sessionManager.getSessionFile() : undefined;
        if (params.context === "fork" && !fork) throw new Error("context: fork needs a saved session; this one is not persisted.");

        /** Whether this call's runs are in the background: from the start (`async`), or once detached. */
        const owner = lifetime;
        const call = { async: Boolean(params.async), detach: undefined as (() => void) | undefined };
        const preparation = new AbortController();
        const abortPreparation = () => { if (!call.async) preparation.abort(); };
        // Unlike turn cancellation, a session end always cancels background preparation too.
        const prepSignal = AbortSignal.any([owner.signal, preparation.signal]);
        // A foreground call the user already interrupted spawns nothing: not before Jev's picks, not
        // after them. A deliberate `async` call is the user's background work and goes on regardless.
        const cancelled = () => !call.async && Boolean(signal?.aborted);
        if (cancelled()) throw new Error("Cancelled before any subagent started.");
        if (!live || owner.signal.aborted) throw new Error("The session ended before any subagent started.");
        signal?.addEventListener("abort", abortPreparation);
        let resolvedAll: Awaited<ReturnType<typeof plan>>;
        try {
          resolvedAll = await plan(ctx, items, discoverAgents(ctx.cwd), prepSignal);
        } catch (error) {
          signal?.removeEventListener("abort", abortPreparation);
          throw error;
        }
        if (cancelled() || owner.signal.aborted || !live) {
          signal?.removeEventListener("abort", abortPreparation);
          throw new Error(cancelled() ? "Cancelled before any subagent started." : "The session ended before any subagent started.");
        }
        const failed = resolvedAll.find((r): r is { error: string } => "error" in r);
        if (failed) {
          signal?.removeEventListener("abort", abortPreparation);
          throw new Error(failed.error);
        }
        const resolved = resolvedAll as Resolved[];

        const started: Run[] = [];
        const details = (): Details => ({ mode, runs: started.map((r) => view(r)) });
        const update = () => {
          if (live && !owner.signal.aborted) onUpdate?.({ content: [{ type: "text", text: `${started.filter((r) => r.state.status === "running").length} running` }], details: details() });
        };

        const cwdFor = async (item: Item) => {
          const base = path.resolve(ctx.cwd, item.cwd ?? params.cwd ?? ".");
          return params.worktree ? worktreeFor(base, item.task, prepSignal) : base;
        };

        /**
         * Nothing queued spawns once the session is gone (a reload, /new: its result would reach no
         * one), nor once a foreground call is cancelled; a deliberate async call keeps going.
         */
        const mayStart = () => live && !owner.signal.aborted && !prepSignal.aborted && !cancelled();
        const runOne = async (item: Item, r: Resolved, dequeue: () => void, chain?: { step: number; of: number }): Promise<Run | undefined> => {
          if (!mayStart()) return undefined;
          const cwd = await cwdFor(item);
          if (!mayStart()) return undefined;
          dequeue();
          const run = startRun(ctx, item, r, { cwd, ...(fork ? { fork } : {}), async: call.async, owner: owner.signal, onUpdate: update });
          started.push(run);
          if (call.async) external(run, chain);
          update();
          // A foreground run stops with the call, unless it has been moved to the background.
          const abort = () => {
            if (!call.async) run.child?.stop();
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          if (!call.async && call.detach) detachers.set(run.id, call.detach);
          await run.child?.done;
          signal?.removeEventListener("abort", abort);
          detachers.delete(run.id);
          // The chain stops at a step that did not succeed: that step is its last.
          if (call.async && !owner.signal.aborted) external(run, chain && run.state.status === "done" ? chain : undefined);
          return run;
        };

        let waiting = items.length;
        const kind = () => (call.async ? "async" : "sync");
        const execute = async (): Promise<Run[]> => {
          queued[kind()] += waiting;
          const dequeue = () => {
            if (waiting <= 0) return;
            waiting--;
            queued[kind()]--;
          };
          try {
            if (mode === "chain") {
              let previous = "";
              const done: Run[] = [];
              for (const [index, item] of items.entries()) {
                const run = await runOne({ ...item, task: item.task.replaceAll("{previous}", previous) }, resolved[index] as Resolved, dequeue, { step: index + 1, of: items.length });
                if (!run) break;
                done.push(run);
                if (run.state.status !== "done") break;
                previous = run.state.output;
              }
              return done;
            }
            const queue = items.map((item, index) => ({ item, index }));
            const done: Run[] = [];
            const worker = async () => {
              for (let next = queue.shift(); next; next = queue.shift()) {
                try {
                  const run = await runOne(next.item, resolved[next.index] as Resolved, dequeue);
                  if (!run) break;
                  done[next.index] = run;
                } catch (error) {
                  preparation.abort();
                  for (const run of started) run.child?.stop();
                  throw error;
                }
              }
            };
            const workers = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(Math.floor(config.concurrency), items.length)) }, worker));
            const failure = workers.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
            return done.filter(Boolean);
          } finally {
            // A chain that stopped early leaves steps that will never run.
            queued[kind()] -= waiting;
            waiting = 0;
            signal?.removeEventListener("abort", abortPreparation);
            refreshUI();
          }
        };

        /** Report `work` as a message when it ends; meanwhile herdr shows background work. */
        const deliverLater = (work: Promise<Run[]>) => {
          backgroundCount++;
          // Released by id: without one, pi-herdr ends the oldest hold, which may be another extension's.
          const hold = `subagents:${++holdCount}`;
          safely(() => pi.events.emit("herdr:background", { active: true, label: `subagents (${items.length})`, id: hold }));
          void work
            .then((list) => {
              backgroundCount--;
              safely(() => pi.events.emit("herdr:background", { active: false, id: hold }));
              const text = list.filter(Boolean).map(resultText).join("\n\n---\n\n");
              if (owner.signal.aborted) return;
              deliverResult(`${finishedHeadline(mode, list.filter(Boolean))}\n\n${text}`, { mode, runs: list.filter(Boolean).map((r) => view(r, true)) }, list.filter(Boolean), mode);
            })
            .catch((error: unknown) => {
              backgroundCount--;
              safely(() => pi.events.emit("herdr:background", { active: false, id: hold }));
              if (owner.signal.aborted) return;
              deliverResult(`Subagent ${mode} failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        };

        const ids = () => started.map((r) => `${r.id} (${runLabel(r)} · ${r.agent}, ${r.model}, ${r.thinking})`).join(", ");

        if (call.async) {
          deliverLater(execute());
          // Let the runs start so their ids exist.
          await new Promise((r) => setTimeout(r, 50));
          return {
            content: [{ type: "text", text: `Started ${mode} in the background${started.length ? `: ${ids()}` : ""}. Results arrive as messages; use action=status, steer, stop, or result with an id meanwhile.${hasBg() && started.length ? ` If nothing else is left to do, bg_wait ${started.map((r) => `subagent:${r.id}`).join(" or ")} waits inside your turn until it ends.` : ""}` }],
            details: details(),
          };
        }

        // In the foreground until the user moves the call to the background (b in FleetView or the viewer).
        const detached = new Promise<"detached">((resolve) => {
          call.detach = () => {
            if (call.async) return;
            queued.sync -= waiting;
            queued.async += waiting;
            call.async = true;
            for (const r of started) {
              r.async = true;
              detachers.delete(r.id);
              if (r.state.status === "running") external(r);
            }
            refreshUI();
            resolve("detached");
          };
        });
        const work = execute();
        const done = await Promise.race([work, detached]);
        if (done === "detached") {
          deliverLater(work);
          return {
            content: [{ type: "text", text: `The user moved this ${mode} to the background: ${ids()}. Results arrive as messages; use action=status, steer, stop, or result with an id meanwhile.` }],
            details: details(),
          };
        }
        for (const r of started) detachers.delete(r.id);
        if (!done.length) throw new Error(signal?.aborted ? "Cancelled before any subagent started." : "No subagent started.");
        const skipped = items.length - done.length;
        const text = `${mode === "chain" ? resultText(done.at(-1) as Run) : done.map(resultText).join("\n\n---\n\n")}${skipped > 0 && signal?.aborted ? `\n\n[Cancelled: ${skipped} queued task${skipped === 1 ? "" : "s"} never started.]` : ""}`;
        const allFailed = done.every((r) => r.state.status !== "done");
        return {
          content: [{ type: "text", text }],
          details: { mode, runs: done.map((r) => view(r, true)) } as Details,
          usage: usageOf(done) as never,
          ...(allFailed ? { isError: true } : {}),
        };
      },

      renderCall(args, theme) {
        const a = args as { action?: string; agent?: string; task?: string; label?: string; tasks?: unknown[]; chain?: unknown[]; async?: boolean; id?: string };
        const action = a.action ?? "run";
        const what =
          action !== "run"
            ? `${action}${a.id ? ` ${a.id}` : ""}`
            : a.tasks?.length
              ? `${a.tasks.length} parallel tasks`
              : a.chain?.length
                ? `chain of ${a.chain.length}`
                : `${taskLabel(a.task ?? "", a.label)} · ${a.agent ?? "auto"}`;
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("muted", what)}${a.async ? theme.fg("dim", " (async)") : ""}`, 0, 0);
      },

      renderResult(result, { expanded }, theme) {
        const d = result.details as Details | undefined;
        if (!d?.runs?.length) {
          const first = result.content[0];
          return new Text(first?.type === "text" ? first.text : "", 0, 0);
        }
        const icon = (s: RunView["status"]) =>
          s === "running" ? theme.fg("warning", "●") : s === "done" ? theme.fg("success", "✓") : s === "stopped" ? theme.fg("muted", "■") : theme.fg("error", "✗");
        const jev = (on: boolean, pressure?: number) => (on ? theme.fg("dim", jevMark(on, pressure)) : "");
        const sep = theme.fg("muted", " · ");
        const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
        // Every run is exactly two clipped rows, so the block never changes height or reflows
        // while runs progress: identity left and stats flush right, then what the run is doing
        // (or ended with) below. Only expanded output wraps.
        const rows: Row[] = [];
        for (const r of d.runs) {
          rows.push({
            left: `${icon(r.status)} ${theme.fg("accent", runLabel(r))}${sep}${r.agent}${jev(r.byJev.agent)}${sep}${shortModel(r.model)}${jev(r.byJev.model, r.pressure)}${sep}${r.thinking}${jev(r.byJev.thinking, r.pressure)}`,
            right: [formatElapsed(r.seconds * 1000), `${r.turns} turns`, ...(r.cost ? [`$${r.cost.toFixed(3)}`] : []), r.id],
          });
          const detail = r.error
            ? theme.fg("error", flat(r.error))
            : r.status === "running"
              ? theme.fg("dim", flat(r.activity ?? "starting…"))
              : theme.fg("dim", flat(r.output?.split("\n").find((l) => l.trim()) ?? r.task));
          rows.push({ left: `  ${theme.fg("muted", "└")} ${detail}` });
          if (expanded && r.output) rows.push({ left: "", markdown: r.output.split("\n").slice(0, 40).join("\n"), indent: 4 });
        }
        return new RowsText(rows, (text) => theme.fg("dim", text));
      },
    });
  };
  registerSubagentTool(delegationOf(config));

  pi.registerCommand("subagents", {
    description: "Browse this session's subagent runs and view their conversations (/subagents [id], /subagents stop [id|all])",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/u);
      if (verb === "stop") {
        const running = [...runs.values()].filter((r) => r.child && r.state.status === "running");
        const chosen = target === "all" || (!target && running.length === 1) ? running : target ? running.filter((r) => r.id.startsWith(target)) : [];
        if (!chosen.length) {
          const which = running.map((r) => `${r.id} ${runLabel(r)} · ${r.agent}`).join(", ");
          ctx.ui.notify(!running.length ? "No subagents are running." : target ? `No running run matches "${target}". Running: ${which}.` : `Say which: /subagents stop <id> or all. Running: ${which}.`, "info");
          return;
        }
        for (const r of chosen) r.child?.stop();
        ctx.ui.notify(`Stopping ${chosen.map((r) => `${runLabel(r)} · ${r.agent} (${r.id})`).join(", ")}.`, "info");
        return;
      }
      const label = (r: RunView) => `${r.id}  ${r.status.padEnd(7)} ${runLabel(r)} · ${r.agent} · ${r.model} · ${r.thinking}`;
      let list = allRuns(ctx);
      if (!list.length) {
        ctx.ui.notify("No subagent runs in this session.", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(list.map((e) => label(e.view)).join("\n"), "info");
        return;
      }
      const id = args.trim();
      if (id) {
        const matches = list.filter((e) => e.view.id.startsWith(id));
        const only = matches.length === 1 ? matches[0] : list.find((e) => e.view.id === id);
        if (!only) {
          ctx.ui.notify(`No single run matches "${id}".`, "warning");
          return;
        }
        const run = only.run();
        await fleet.show(ctx.ui, run);
        return;
      }
      for (;;) {
        const width = String(list.length).length;
        const labels = list.map((e, i) => `${String(i + 1).padStart(width)}. ${label(e.view)}`);
        const choice = await ctx.ui.select("Subagent runs", labels);
        const entry = choice === undefined ? undefined : list[labels.indexOf(choice)];
        if (!entry) return;
        const run = entry.run();
        await fleet.show(ctx.ui, run);
        list = allRuns(ctx);
      }
    },
  });
}

/** A row; with `markdown`, that text rendered as Markdown and indented instead of `left`. */
type Row = { left: string; right?: string[]; wrap?: boolean; markdown?: string; indent?: number };

/** Tool-result rows, clipped to the width (stats kept flush right) unless marked to wrap. */
class RowsText implements Component {
  constructor(
    private readonly rows: Row[],
    private readonly dim: (text: string) => string = (text) => text,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const w = Math.max(1, width);
    return this.rows.flatMap((r) => {
      if (r.markdown !== undefined) {
        const pad = " ".repeat(Math.min(r.indent ?? 0, Math.max(0, w - 1)));
        const lines = new Markdown(r.markdown.trim(), 0, 0, getMarkdownTheme()).render(Math.max(1, w - pad.length));
        while (lines.length && !lines.at(-1)?.trim()) lines.pop();
        return lines.map((l) => pad + l);
      }
      return r.wrap ? wrapTextWithAnsi(r.left, w) : [this.line(r.left, r.right, w)];
    });
  }

  /** Stats flush right; on a narrow row they drop whole trailing parts (id, cost, ...) so the identity keeps most of it. */
  private line(left: string, right: string[] | undefined, w: number): string {
    if (!right?.length) return truncateToWidth(left, w, "…");
    const lw = visibleWidth(left);
    const want = Math.min(lw, Math.ceil(w * 0.6));
    let parts = right;
    while (parts.length && visibleWidth(parts.join(" · ")) + 2 + want > w) parts = parts.slice(0, -1);
    if (!parts.length) return truncateToWidth(left, w, "…");
    const stats = this.dim(parts.join(" · "));
    const sw = visibleWidth(stats);
    const kept = truncateToWidth(left, w - sw - 2, "…");
    return kept + " ".repeat(Math.max(2, w - visibleWidth(kept) - sw)) + stats;
  }
}
