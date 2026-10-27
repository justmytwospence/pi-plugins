// pi-bg: background jobs and services for pi.
//
// - bg_run starts a job (a finite command whose result the agent needs) or a service (a server,
//   tunnel or watcher). A job wakes the agent when it exits; a service wakes it once when its
//   `ready` pattern matches, or if it exits.
// - bg_wait keeps the turn going until a job ends, so the agent is visibly working (in pi, herdr,
//   tmux) while it waits. It returns early when the user types, on Esc, or after its timeout.
//   Ending the turn with an agent job running waits the same way (agent_before_settle), and the
//   outcome continues the run.
// - bg_logs reads a log (or lists the tasks); bg_kill stops one.
// - Progress (progress.ts): standard bars (tqdm, pytest, ...) are detected, the agent may declare a
//   format or regex (bg_run's `progress`), and a task may write `done/total` to $PI_BG_PROGRESS. It
//   shows in /tasks rows, the pill, the waiting message and the agent's text; nothing otherwise.
// - Claude Code's layout: a pill under the prompt (`2 tasks`, `1 failed` while a failure is
//   unseen); ↓ then Enter, or a click, opens the background-tasks dialog, as does `/tasks` (aliases
//   `/bashes`, `/ps`, `/bg`). `/stop` stops every task. Outside the TUI, a footer status `bg`.
// - With pi-subagents installed (activity.ts), its list under the prompt ends with this pill, and
//   the dialog lists its runs too.
//
// Other extensions, through pi.events (all optional; without listeners nothing happens):
//   emits  herdr:background {active,label,id}  while an agent job runs that will wake the agent
//                                              (pi-herdr shows it as the pane token $bg)
//          herdr:notify {title,body,sound,unlessFocused}  when a task the user started ends
//          herdr:split {command,cwd}           /bg's "follow in a herdr split" (when pi-herdr answers herdr:probe)
//          bg:tasks {tasks}                    a snapshot after every change (with `progress` when known)
//          bg:killed {id,command,cwd}          after bg_kill or /bg stops a task
//   reads  bg:external {id,label,state,summary?,result?}  outside work bg_wait can wait on (state
//                                              running|done|failed); `result` is Markdown and bg_wait
//                                              renders it as such
//          bg:annotate {task,by,detail?,wait?}  what another extension knows about a task (pi-marimo: the
//                                              kernel state of the notebook a server serves or a job drives);
//                                              `wait` names outside work that bg_wait on the task waits for
//                                              once it is up, and that bg_logs lists under the task. No
//                                              detail clears it.
//          bg:probe {reply}                    reply() when pi-bg is loaded
//
// marimo without pi-marimo (marimo.ts): a `marimo edit nb.py` service is named `marimo nb.py` and is
// ready when marimo prints its URL.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { WORKING_MESSAGE_EVENT } from "./working-message.ts";
import { Type } from "typebox";
import { elapsed, footerStatus, header, marimoNote, nameFromCommand, outcome, progressText, report, runtime, shortProgress, taskLine } from "./format.ts";
import { CATALOGUE, FORMAT_NAMES, bar, eta, etaText, percent } from "./progress.ts";
import { bounded, grep, head, tail } from "./log.ts";
import { type Kind, type Task, type TaskEvent, parsePattern, registry } from "./registry.ts";
import {
  ACTIVITY_CHANGED,
  ACTIVITY_GONE,
  ACTIVITY_HOST,
  ACTIVITY_SECTION,
  type ActivityEntry,
  type ActivityPill,
  type ActivitySection,
  PILL_HOST_PRIORITY,
  hostOutranks,
  readHost,
  stableKey,
} from "./activity.ts";
import { type DialogResult, TasksDialog } from "./dialog.ts";
import { FULL_SCREEN } from "./frame.ts";
import { PillView } from "./pill.ts";
import { LogViewer } from "./viewer.ts";
import { MARIMO_READY, marimoName, marimoServer } from "./marimo.ts";
import { type Block, blocks, blocksView } from "./result-view.ts";
import { reportResultView, runResultView, type WakeDetails, wakeView } from "./rows.ts";

const STARTUP_WAIT_MS = 1_500;

/** Pi's error for a ctx used after the session it belonged to was replaced or reloaded. */
const isStaleCtx = (error: unknown) => error instanceof Error && /\bstale\b/iu.test(error.message);
const WAIT_DEFAULT_S = 1_800;
const WAIT_MAX_S = 3_600;
const LOGS_DEFAULT = 60;
const LOGS_MAX = 400;
const LOGS_BYTES = 12_000;
const EXTERNAL_KEEP_MS = 10 * 60_000;

/** What another extension says about a task (bg:annotate). */
export interface Annotation {
  by: string;
  detail: string;
  wait: string[];
}

export interface External {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
  summary?: string;
  /** Optional completed output, in Markdown; acknowledging its return suppresses a duplicate wake-up. */
  result?: string;
  updatedAt: number;
}

type Reason = "done" | "message" | "timeout" | "aborted";

interface Waiter {
  /** Task or external ids; empty means any running agent job. */
  targets: Set<string>;
  any: boolean;
  /** bg_run's short startup check: takes only its own task, never other tasks' news. */
  silent: boolean;
  finished: Task[];
  readied: Task[];
  externals: External[];
  /** Other tasks that ended (or got ready) meanwhile; delivered with this wait's result. */
  extras: string[];
  resolve: (r: Reason) => void;
}

const RunParams = Type.Object({
  command: Type.String({ description: "Shell command (bash -c), run in its own process group with stdout and stderr to a log file" }),
  kind: Type.Union([Type.Literal("job"), Type.Literal("service")], {
    description: "job: finite, you need its result (tests, builds, fits, exports, long scripts). service: keeps running (dev or notebook servers, tunnels, watchers)",
  }),
  name: Type.Optional(Type.String({ description: "Short label for the footer and lists, e.g. `tests`, `vite`" })),
  ready: Type.Optional(Type.String({ description: "service: regex (case-insensitive, or /src/flags) for the log line that means it is up; you are woken once when it matches" })),
  timeout: Type.Optional(Type.Number({ description: "job: kill it after this many seconds" })),
  keep: Type.Optional(Type.Boolean({ description: "service: leave it running when this pi session ends (a server the user works in)" })),
  progress: Type.Optional(
    Type.String({
      description: `Where its progress shows up in the log, when the command prints countable progress that is not detected on its own: a format (${CATALOGUE.map((f) => f.name).join(", ")}, percent, fraction) or a regex with one group (a percent) or two (done, total), or named groups pct / done and total. "none" turns detection off. Omit it otherwise; never declare progress the command does not print.`,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: the session's)" })),
});

const WaitParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Task id or name; default: whichever running job ends first" })),
  timeout: Type.Optional(Type.Number({ description: `Seconds to wait at most (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S})` })),
});

const LogsParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Task id or name; omit to list all tasks" })),
  lines: Type.Optional(Type.Number({ description: `Lines to return (default ${LOGS_DEFAULT}, max ${LOGS_MAX})` })),
  grep: Type.Optional(Type.String({ description: "Only lines matching this regex (case-insensitive, or /src/flags)" })),
  head: Type.Optional(Type.Boolean({ description: "The first lines instead of the last" })),
});

const KillParams = Type.Object({ id: Type.String({ description: "Task id or name" }) });

/** pi-cc-render draws these tools' call rows but leaves the result row to them (the live task line). */
const OWN_RESULT = { ccstyleOwnResult: true } as const;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default function piBg(pi: ExtensionAPI) {
  const reg = registry();
  const externals = new Map<string, External>();
  const annotations = new Map<string, Annotation>();
  /** Outside work by id; `marimo:fit.py` also finds `marimo:nb/fit.py` when that is the only match. */
  const findExternal = (id: string): External | undefined => {
    const exact = externals.get(id);
    if (exact) return exact;
    const colon = id.indexOf(":");
    if (colon < 0) return undefined;
    const [prefix, rest] = [id.slice(0, colon + 1), id.slice(colon + 1)];
    const hits = [...externals.values()].filter((x) => x.id.startsWith(prefix) && x.id.endsWith(`/${rest}`));
    const running = hits.filter((x) => x.state === "running");
    return running.length === 1 ? running[0] : hits.length === 1 ? hits[0] : undefined;
  };
  /** A running task's annotation. */
  const noteOf = (t: Task): Annotation | undefined => (t.status === "running" ? annotations.get(t.id) : undefined);
  const waiters = new Set<Waiter>();
  const waitingMessages = new Map<string, string>();
  /** Ids whose herdr:background hold is active. */
  const holds = new Set<string>();
  let ctx: ExtensionContext | undefined;
  let attached = false;
  let unsubscribe: (() => void) | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let startupWake: ReturnType<typeof setImmediate> | undefined;
  let sessionGeneration = 0;
  /** The session this instance serves: the only one whose tasks it lists, waits on, wakes and kills. */
  let sessionId = "";
  let lastStatus: string | undefined;
  let herdrActive = false;
  /** The running jobs the agent started: what bg_wait without an id waits for. */
  const agentJobs = () => reg.running(sessionId).filter((t) => t.kind === "job" && t.origin === "agent");
  /** The tasks a bg_wait is waiting on. */
  const waitingIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const w of waiters) {
      if (w.silent) continue;
      for (const id of w.targets) ids.add(id);
      if (w.any) for (const t of agentJobs()) ids.add(t.id);
    }
    return ids;
  };
  /** When the user last sent a message: failures before it no longer alert in the pill. */
  let dismissedAt = 0;
  /** Other extensions' sources (pi-subagents' runs), listed in the dialog. */
  const others = new Map<string, ActivitySection>();
  /** The hosts showing our pill in their list under the prompt (pi-subagents' FleetView), by id. */
  const hosts = new Set<string>();
  const hosted = () => hosts.size > 0;
  /** Our identity as a host (activity.ts): the pill host, which the FleetView host outranks. */
  const me = { host: "bg", priority: PILL_HOST_PRIORITY };
  /** Hosts that outrank us and are present: we host nothing until they are gone. */
  const yieldedTo = new Set<string>();
  /** Whether we host other sources' pills now: in the TUI, shown by no one, outranked by no one. */
  const hosting = () => attached && tui() && !hosted() && yieldedTo.size === 0;
  /** Other sources whose pills ours counts while we host (pi-marimo's notebooks). */
  const guests = new Map<string, ActivitySection>();
  const hostGuest = (s: ActivitySection) => {
    if (!hosting() || typeof s.pill !== "function" || typeof s.setHosted !== "function") return;
    if (guests.get(s.id) === s) return;
    guests.set(s.id, s);
    try {
      s.setHosted(true, me.host);
    } catch {
      guests.delete(s.id);
    }
  };
  const releaseGuests = () => {
    for (const s of guests.values()) {
      try {
        s.setHosted?.(false, me.host);
      } catch {
        // Its session may be gone.
      }
    }
    guests.clear();
  };
  /** Host the others' pills (when we may), announcing ourselves so sources offer themselves again. */
  const startHosting = () => {
    if (!hosting()) return;
    for (const s of others.values()) hostGuest(s);
    emit(ACTIVITY_HOST, { ...me });
  };
  const tui = () => ctx?.mode === "tui";
  /** Our pill and our guests': `2 tasks · 1 notebook`. */
  const combinedPill = (now: number): ActivityPill | undefined => {
    const pills = [pillOf(now)];
    for (const s of guests.values()) {
      try {
        pills.push(s.pill?.(now));
      } catch {
        // Another extension's bug must not break the pill.
      }
    }
    const shown = pills.filter((p): p is ActivityPill => !!p);
    if (!shown.length) return undefined;
    const alerts = shown.map((p) => p.alert).filter(Boolean);
    return { label: shown.map((p) => p.label).join(" · "), ...(alerts.length ? { alert: alerts.join(" · ") } : {}) };
  };
  const pill = new PillView({
    pill: (now) => combinedPill(now),
    open: () => {
      if (ctx) openDialog(ctx.ui).catch(() => undefined);
    },
  }, "pi-bg-pill");
  const bindPill = () => pill.setUI(attached && tui() && !hosted() ? (ctx?.ui as any) : undefined);

  const entryStatus = (t: Task): ActivityEntry["status"] =>
    t.status === "running" ? "running" : t.status === "done" ? "done" : t.status === "killed" ? "stopped" : "failed";
  /** A failure the user has not seen: it ended after their last message and is not dismissed. */
  const alerting = (t: Task) => (t.status === "failed" || t.status === "timeout") && (t.endedAt ?? 0) > dismissedAt && !reg.cleared.has(t.id);
  const pillOf = (now: number): ActivityPill | undefined => {
    void now;
    const running = reg.running(sessionId);
    const failed = reg.list(sessionId).filter(alerting).length;
    if (!running.length && !failed) return undefined;
    // One task's progress, when exactly one running task has any: `2 tasks · fit 45%`.
    const measured = running.filter((t) => t.progress);
    const one = measured.length === 1 ? measured[0] : undefined;
    const count = running.length ? `${running.length} task${running.length === 1 ? "" : "s"}` : "tasks";
    const label = one ? `${count} · ${running.length === 1 ? "" : `${one.name} `}${shortProgress(one)}` : count;
    return { label, ...(failed ? { alert: `${failed} failed` } : {}) };
  };
  /** A row's progress, before its runtime: `45% · ~3m`; the bar goes last, flush right, so bars line up. */
  const progressStats = (t: Task, now: number): string | undefined => {
    const p = t.status === "running" ? t.progress : undefined;
    if (!p) return undefined;
    const left = eta(p, now);
    return `${percent(p)}${left === undefined ? "" : ` · ${etaText(left)}`}`;
  };
  /** `fit ███▌░░░░ 45% · 2:14` for the waiting message. */
  const waitLabel = (t: Task) => {
    const p = t.status === "running" ? t.progress : undefined;
    return p ? `${t.name} ${bar(p.fraction, 8)} ${percent(p)} · ${runtime(t)}` : `${t.name} ${runtime(t)}`;
  };
  const section: ActivitySection = {
    id: "bg",
    title: "tasks",
    noun: "task",
    // Running first (oldest first), then what ended (newest first).
    entries: (now) =>
      [...reg.running(sessionId), ...reg.list(sessionId).filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))].map((t) => ({
        key: t.id,
        label: t.name,
        detail: [noteOf(t)?.detail, t.status === "running" ? t.progress?.note : undefined, t.command.replace(/\s+/gu, " ").trim()].filter(Boolean).join(" · "),
        status: entryStatus(t),
        stats:
          t.status === "running"
            ? [
                waitingIds().has(t.id) ? "waiting" : undefined,
                t.kind === "service" ? (t.ready ? "ready" : t.readyPattern ? "starting" : "service") : undefined,
                progressStats(t, now),
                runtime(t, now),
              ]
                .filter(Boolean)
                .join(" · ") + (t.progress ? ` ${bar(t.progress.fraction)}` : "")
            : `${outcome(t)} · ${runtime(t, now)}`,
        startedAt: t.startedAt,
        ...(t.endedAt ? { endedAt: t.endedAt } : {}),
      })),
    open: (key, ui) => {
      const t = reg.find(key, sessionId);
      return t ? openLog(ui as ExtensionContext["ui"], t) : Promise.resolve();
    },
    stop: (key) => {
      const t = reg.find(key, sessionId);
      if (t?.status === "running") return stopTask(t, "user");
    },
    dismiss: (key) => {
      const t = reg.find(key, sessionId);
      if (!t || t.status === "running") return;
      reg.cleared.add(t.id);
      refresh();
    },
    pill: (now) => pillOf(now),
    openDialog: (ui) => openDialog(ui as ExtensionContext["ui"]),
    setHosted: (on, host) => {
      const id = host ?? "subagents";
      const before = hosted();
      if (on) hosts.add(id);
      else hosts.delete(id);
      if (before === hosted()) return;
      // Hosted, our pill sits beside the guests' in the host's list: they go back to it.
      if (hosted()) releaseGuests();
      else for (const s of others.values()) hostGuest(s);
      bindPill();
      refresh();
    },
  };
  const offerSection = () => {
    if (attached && tui()) emit(ACTIVITY_SECTION, { section });
  };
  pi.events.on(ACTIVITY_HOST, (data) => {
    const other = readHost(data);
    if (other.host === me.host) return;
    offerSection();
    if (hostOutranks(other, me)) {
      // A host under the prompt takes over: our guests' pills belong in its list now.
      yieldedTo.add(other.host);
      releaseGuests();
      pill.update();
    } else if (hosting()) {
      // A lesser host announcing itself yields to us once it hears from us.
      emit(ACTIVITY_HOST, { ...me });
    }
  });
  // Other sources, for the dialog.
  pi.events.on(ACTIVITY_SECTION, (data) => {
    const s = (data as { section?: ActivitySection } | undefined)?.section;
    if (s && s.id !== section.id && typeof s.entries === "function" && typeof s.open === "function") {
      others.set(s.id, s);
      hostGuest(s);
      pill.update();
    }
  });
  pi.events.on(ACTIVITY_GONE, (data) => {
    const id = (data as { id?: string } | undefined)?.id ?? "";
    others.delete(id);
    guests.delete(id);
    // A host that left: it no longer shows us, and no longer outranks us.
    const wasHosted = hosted();
    hosts.delete(id);
    const resumed = yieldedTo.delete(id);
    if (wasHosted !== hosted() || resumed) {
      startHosting();
      bindPill();
      refresh();
    }
    pill.update();
  });
  // A guest's content changed: our pill shows it.
  pi.events.on("activity:prompt-tab", (data) => {
    const request = data as { handled?: boolean; phase?: string } | undefined;
    if (request && !request.handled) request.handled = pill.tab(request.phase === "active");
  });
  pi.events.on(ACTIVITY_CHANGED, (data) => {
    if (guests.has((data as { id?: string } | undefined)?.id ?? "")) pill.update();
  });

  const emit = (channel: string, data: unknown) => {
    try {
      pi.events.emit(channel, data);
    } catch {
      // A failing listener must not break us.
    }
  };

  const snapshot = () =>
    reg.list(sessionId).map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      command: t.command,
      cwd: t.cwd,
      status: t.status,
      ready: t.ready,
      origin: t.origin,
      keep: t.keep,
      willWake: t.origin === "agent" && t.status === "running" && !t.delivered,
      logPath: t.logPath,
      ...(t.progress
        ? { progress: { fraction: t.progress.fraction, source: t.progress.source, ...(t.progress.count ? { count: t.progress.count } : {}), ...(t.progress.note ? { note: t.progress.note } : {}) } }
        : {}),
    }));

  /**
   * Runs a callback that fires outside a pi handler (a timer, a registry event). Pi invalidates a
   * session's ctx on replacement; if one got past us without a session_shutdown, every ctx call
   * throws, and an uncaught throw from a timer takes pi down. Treat it as the shutdown we missed.
   */
  const guarded = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      if (attached && isStaleCtx(error)) detachSession();
      else throw error;
    }
  };

  const updateStatus = () => {
    if (!attached || !ctx?.hasUI) return;
    const s = tui() ? undefined : footerStatus(reg.list(sessionId));
    if (s === lastStatus) return;
    lastStatus = s;
    ctx.ui.setStatus("bg", s);
  };

  /** Hold herdr:background for every agent job that will wake the agent. */
  const syncHolds = () => {
    if (!attached) return;
    const want = new Set([
      ...reg.running(sessionId).filter((t) => t.origin === "agent" && t.kind === "job" && !t.delivered).map((t) => t.id),
      ...[...owed.keys()].filter((id) => reg.tasks.has(id)),
    ]);
    for (const id of want) {
      if (holds.has(id)) continue;
      holds.add(id);
      emit("herdr:background", { active: true, label: reg.tasks.get(id)?.name ?? id, id: `bg:${id}` });
    }
    for (const id of [...holds]) {
      if (want.has(id)) continue;
      holds.delete(id);
      emit("herdr:background", { active: false, id: `bg:${id}` });
    }
  };

  /**
   * Redraws for bg_run rows whose task is running, one per row (keyed by tool call): an ended task's
   * rows redraw once more, then drop. Pi hands each render a fresh invalidate that re-renders at once,
   * so a redraw re-registers its row; keying by row and walking a snapshot keeps a tick finite.
   */
  const liveRows = new Map<string, Map<string, () => void>>();
  const redrawRows = () => {
    for (const [id, redraws] of [...liveRows]) {
      const running = reg.tasks.get(id)?.status === "running";
      for (const [row, redraw] of [...redraws]) {
        try {
          redraw();
        } catch {
          redraws.delete(row);
        }
      }
      if (!running) liveRows.delete(id);
    }
  };
  const refresh = () => {
    redrawRows();
    updateStatus();
    pill.update();
    emit(ACTIVITY_CHANGED, { id: section.id });
    syncHolds();
    emit("bg:tasks", { tasks: snapshot() });
  };

  // ---- waking the agent ----

  const wakeText = (t: Task, kind: "end" | "ready"): string => {
    if (kind === "ready") {
      return `Background service ${t.name} (${t.id}) is ready${t.readyLine ? `: ${t.readyLine}` : ""}. It keeps running; bg_logs ${t.id} reads its log.`;
    }
    const what = t.kind === "job" ? "Background job" : "Background service";
    return `${what} ${t.name} (${t.id}) ended: ${outcome(t)} after ${runtime(t)}.\n\n${report(t)}`;
  };

  /**
   * Wake-ups owed to the agent. They are sent only while pi is idle: a follow-up queued during a turn
   * is dropped when the user presses Esc, and pi would start a turn in the middle of a compaction.
   * Whatever bg_wait, bg_logs or bg_kill delivers meanwhile is no longer owed.
   */
  const owed = new Map<string, "end" | "ready">();
  const wake = (t: Task, kind: "end" | "ready") => {
    owed.set(t.id, kind);
    flushOwed();
  };
  const flushOwed = (c: Pick<ExtensionContext, "isIdle"> | undefined = ctx) => {
    if (!attached || !owed.size || !c?.isIdle()) return;
    const parts: string[] = [];
    const sent: { id: string; kind: "end" | "ready"; status: string }[] = [];
    for (const [id, kind] of owed) {
      const t = reg.tasks.get(id);
      if (!t || (kind === "end" ? t.delivered : t.readyDelivered)) continue;
      if (kind === "end") t.delivered = true;
      else t.readyDelivered = true;
      parts.push(wakeText(t, kind));
      sent.push({ id, kind, status: t.status });
    }
    owed.clear();
    if (!parts.length) return;
    try {
      pi.sendMessage(
        { customType: "pi-bg", content: parts.join("\n\n---\n\n"), display: true, details: { tasks: sent } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // The session went away under us.
    }
    refresh();
  };
  /** After a reload: outcomes that arrived while no session was attached are owed now. */
  const oweFromState = () => {
    for (const t of reg.tasks.values()) {
      if (t.origin !== "agent" || t.sessionId !== sessionId) continue;
      if (t.status !== "running" && !t.delivered) owed.set(t.id, "end");
      else if (t.status === "running" && t.ready && t.readyPattern && !t.readyDelivered) owed.set(t.id, "ready");
    }
  };

  /** Hands an ended or ready task to a waiter; true when one took it. */
  const toWaiter = (t: Task, kind: "end" | "ready"): boolean => {
    for (const w of waiters) {
      const targeted = w.targets.has(t.id) || (w.any && kind === "end" && t.kind === "job" && t.origin === "agent");
      if (!targeted) continue;
      if (kind === "end") {
        t.delivered = true;
        w.finished.push(t);
      } else {
        t.readyDelivered = true;
        w.readied.push(t);
      }
      w.resolve("done");
      return true;
    }
    const open = [...waiters].find((w) => !w.silent);
    if (!open) return false;
    if (kind === "end") t.delivered = true;
    else t.readyDelivered = true;
    open.extras.push(kind === "end" ? `${t.name} (${t.id}) ended: ${outcome(t)} after ${runtime(t)}. bg_logs ${t.id} for its output.` : `${t.name} (${t.id}) is ready${t.readyLine ? `: ${t.readyLine}` : ""}.`);
    return true;
  };

  const notifyUser = (t: Task) => {
    const ok = t.status === "done";
    if (ctx?.hasUI) ctx.ui.notify(`bg: ${t.name} ${outcome(t)} after ${runtime(t)}`, ok ? "info" : "warning");
    emit("herdr:notify", { title: `${t.name} ${ok ? "finished" : outcome(t)}`, body: `ran ${runtime(t)}`, sound: "done", unlessFocused: true });
  };

  const onTask = (e: TaskEvent) => {
    const t = e.task;
    if (e.type === "ready" && t.origin === "agent" && !t.readyDelivered) {
      if (!toWaiter(t, "ready")) wake(t, "ready");
    }
    if (e.type === "end") {
      const awaited = [...waiters].some((w) => w.targets.has(t.id) || (w.any && t.kind === "job" && t.origin === "agent"));
      if (t.killedBy === "session") t.delivered = true;
      else if (awaited) toWaiter(t, "end");
      else if (t.origin === "user" || t.adopted) notifyUser(t);
      else if (t.killedBy === "agent") t.delivered = true;
      else if (!t.delivered) {
        if (t.killedBy === "user") {
          t.delivered = true;
          if (attached) {
            pi.sendMessage(
              { customType: "pi-bg", content: `The user stopped background task ${t.name} (${t.id}) after ${runtime(t)}.`, display: true, details: { id: t.id, kind: "end", status: t.status } },
              { deliverAs: "nextTurn" },
            );
          }
        } else if (!toWaiter(t, "end")) wake(t, "end");
      }
    }
    refresh();
  };

  // ---- waiting ----

  /**
   * The `Waiting on …` working message for one wait: pi's native message, and the same claim on
   * the optional footer's channel (working-message.ts). `set()` paints or refreshes it; `release()`
   * clears it and paints whatever other wait remains.
   */
  const holdWorking = (c: ExtensionContext, generation: number, label: () => string) => {
    const owner = `bg-wait/${randomUUID()}`;
    const live = () => attached && generation === sessionGeneration && c.hasUI;
    const paint = () => c.ui.setWorkingMessage([...waitingMessages.values()].at(-1));
    return {
      set: () => {
        if (!live()) return;
        const message = `Waiting on ${label()}…`;
        waitingMessages.set(owner, message);
        paint();
        emit(WORKING_MESSAGE_EVENT, { owner, message });
      },
      release: () => {
        const owned = waitingMessages.delete(owner);
        if (!owned || !live()) return;
        try {
          paint();
        } finally {
          emit(WORKING_MESSAGE_EVENT, { owner });
        }
      },
    };
  };

  /**
   * The agent ends its turn with a job running that would wake it: wait for the job here, so the
   * run does not settle (pi, herdr and tmux keep showing it working) and the outcome continues the
   * run instead of waking an idle agent. Typing or Esc ends the wait; the job then wakes the agent
   * as usual. Pi exposes no abort signal at this boundary, so Esc is read from the terminal.
   * `event.context.canContinue` is not consulted: after an ordinary reply it is false (the context
   * ends with the assistant message), and the outcome entry this returns is what makes the
   * continuation valid; Pi re-checks it after committing the entries.
   */
  let settleWaiting = false;
  /**
   * Pi takes its working indicator down at agent_end, before this boundary, so a settle-wait put
   * it back up (with the `Waiting on …` message) and it stays up until the run settles. A run the
   * wait continues starts a turn, and Pi owns the indicator again.
   */
  let indicatorRaised = false;
  const lowerIndicator = (c: ExtensionContext) => {
    if (!indicatorRaised) return;
    indicatorRaised = false;
    try {
      // Hidden takes it down; shown again only sets the default back, as no run is streaming now.
      c.ui.setWorkingVisible?.(false);
      c.ui.setWorkingVisible?.(true);
    } catch {
      // UI gone.
    }
  };
  const waitAtSettle = async (event: AgentBeforeSettleEvent, c: ExtensionContext): Promise<BoundaryResult> => {
    if (settleWaiting || !attached || !tui() || event.outcome !== "completed") return {};
    if (c.hasPendingMessages() || !agentJobs().length || [...waiters].some((w) => !w.silent)) return {};
    const generation = sessionGeneration;
    const label = () => agentJobs().map(waitLabel).join(" · ");
    const working = holdWorking(c, generation, label);
    let ticks = 0;
    let waiter: Waiter | undefined;
    let reason: Reason;
    let offKeys: (() => void) | undefined;
    settleWaiting = true;
    try {
      working.set();
      try {
        c.ui.setWorkingVisible?.(true);
        indicatorRaised = true;
      } catch {
        // No indicator to raise: the message still reaches the footer's channel.
      }
      const waiting = waitFor({ targets: new Set(), any: true, silent: false }, WAIT_DEFAULT_S * 1000, () => {
        if (!attached || generation !== sessionGeneration) return "aborted";
        if (c.hasPendingMessages()) return "message";
        if (!agentJobs().length) return "done";
        if (++ticks % 4 === 0) working.set();
        return undefined;
      });
      waiter = waiting.waiter;
      try {
        offKeys = c.ui.onTerminalInput((data) => {
          if (data === "\x1b") waiting.waiter.resolve("aborted");
          return undefined;
        });
      } catch {
        // No terminal input hook: typing still interrupts.
      }
      refresh();
      reason = await waiting.done;
    } finally {
      settleWaiting = false;
      offKeys?.();
      waiter?.resolve("aborted");
      working.release();
    }
    refresh();
    if (reason !== "done" || !waiter?.finished.length) return {};
    const parts: string[] = [];
    const tasks: { id: string; kind: "end"; status: string }[] = [];
    for (const t of waiter.finished) {
      owed.delete(t.id);
      parts.push(wakeText(t, "end"));
      tasks.push({ id: t.id, kind: "end", status: t.status });
    }
    if (waiter.extras.length) parts.push(`Also meanwhile:\n${waiter.extras.map((e) => `- ${e}`).join("\n")}`);
    return {
      entries: [{ type: "custom_message", customType: "pi-bg", content: parts.join("\n\n---\n\n"), display: true, details: { tasks } }],
      continue: true,
    };
  };
  pi.on("agent_before_settle", waitAtSettle);

  const waitFor = (
    w: Omit<Waiter, "resolve" | "finished" | "readied" | "externals" | "extras">,
    timeoutMs: number,
    tick: (() => Reason | undefined) | undefined,
  ): { waiter: Waiter; done: Promise<Reason> } => {
    let resolve!: (r: Reason) => void;
    const done = new Promise<Reason>((r) => {
      resolve = r;
    });
    let settled = false;
    const waiter: Waiter = { ...w, finished: [], readied: [], externals: [], extras: [], resolve: () => {} };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const ticker = tick
      ? setInterval(() => {
          try {
            const r = tick();
            if (r) finish(r);
          } catch {
            finish("aborted");
          }
        }, 250)
      : undefined;
    function finish(r: Reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      waiters.delete(waiter);
      resolve(r);
    }
    waiter.resolve = finish;
    waiters.add(waiter);
    return { waiter, done };
  };

  const externalLine = (x: External) => `${x.label} (${x.id}): ${x.state}${x.summary ? ` · ${x.summary}` : ""}`;
  const consumeExternal = (x: External): Block[] => {
    if (x.state === "running" || typeof x.result !== "string") return [{ text: externalLine(x) }];
    pi.events.emit("bg:external-consumed", { id: x.id });
    return [{ text: externalLine(x) }, { text: x.result, markdown: true }];
  };

  pi.events.on("bg:annotate", (data) => {
    const d = data as { task?: unknown; by?: unknown; detail?: unknown; wait?: unknown } | undefined;
    if (typeof d?.task !== "string" || !reg.tasks.has(d.task)) return;
    if (typeof d.detail !== "string" || !d.detail) annotations.delete(d.task);
    else {
      const wait = Array.isArray(d.wait) ? d.wait.filter((w): w is string => typeof w === "string") : [];
      annotations.set(d.task, { by: typeof d.by === "string" ? d.by : "", detail: d.detail, wait });
    }
    // Only what draws: a bg:tasks snapshot here would bounce back to the annotator.
    pill.update();
    emit(ACTIVITY_CHANGED, { id: section.id });
  });
  pi.events.on("bg:external", (data) => {
    const d = data as Partial<External> | undefined;
    if (!d?.id || typeof d.id !== "string") return;
    const state = d.state === "done" || d.state === "failed" ? d.state : "running";
    const x: External = { id: d.id, label: d.label || d.id, state, summary: d.summary, ...(typeof d.result === "string" ? { result: d.result } : {}), updatedAt: Date.now() };
    // Ended outside work is kept a while for a late bg_wait, then forgotten.
    for (const [id, old] of externals) if (old.state !== "running" && x.updatedAt - old.updatedAt > EXTERNAL_KEEP_MS) externals.delete(id);
    externals.set(x.id, x);
    if (state !== "running") {
      for (const w of waiters) {
        if (!w.targets.has(x.id)) continue;
        w.externals.push(x);
        w.resolve("done");
      }
    }
  });
  pi.events.on("bg:probe", (data) => {
    (data as { reply?: () => void } | undefined)?.reply?.();
  });

  // ---- lifecycle ----

  /** The session's id; a session without one (in memory, before it is persisted) gets a per-instance id. */
  const instanceId = `instance-${randomUUID()}`;
  const sessionIdOf = (c: ExtensionContext): string => {
    try {
      return c.sessionManager.getSessionId() || instanceId;
    } catch {
      return instanceId;
    }
  };

  const detachSession = () => {
    const wasAttached = attached;
    // Invalidate saved/queued callbacks and drop the context before calling any session UI.
    attached = false;
    ctx = undefined;
    sessionGeneration++;
    if (wasAttached) reg.detach(sessionId);
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
    if (startupWake) clearImmediate(startupWake);
    startupWake = undefined;
    const off = unsubscribe;
    unsubscribe = undefined;
    hosts.clear();
    yieldedTo.clear();
    for (const w of [...waiters]) w.resolve("aborted");
    for (const owner of waitingMessages.keys()) emit(WORKING_MESSAGE_EVENT, { owner });
    waitingMessages.clear();
    const activeHolds = [...holds];
    holds.clear();
    try {
      off?.();
    } catch {
      // The subscription's owner may already be gone.
    }
    try {
      pill.dispose();
    } catch {
      // Invalidated UI must not prevent the remaining session cleanup.
    }
    if (wasAttached) emit(ACTIVITY_GONE, { id: section.id });
    releaseGuests();
    for (const id of activeHolds) emit("herdr:background", { active: false, id: `bg:${id}` });
  };

  pi.on("session_start", async (event, c) => {
    // A repeated start must retire the previous session even if its UI can no longer be disposed.
    detachSession();
    const generation = sessionGeneration;
    ctx = c;
    attached = true;
    lastStatus = undefined;
    holds.clear();
    sessionId = sessionIdOf(c);
    reg.attach(sessionId);
    if (event.reason !== "reload") reg.forgetEnded(sessionId);
    if (event.reason === "startup") {
      // Only a session with a UI adopts kept services; a headless one (an in-process planner) just cleans up.
      const adopted = reg.sweep(c.cwd, sessionId, c.hasUI);
      if (adopted.length && c.hasUI) c.ui.notify(`bg: adopted kept service${adopted.length > 1 ? "s" : ""} ${adopted.map((t) => t.name).join(", ")}`, "info");
    }
    hosts.clear();
    yieldedTo.clear();
    bindPill();
    offerSection();
    startHosting();
    unsubscribe = reg.subscribe((e) => {
      if (attached && generation === sessionGeneration && e.task.sessionId === sessionId) guarded(() => onTask(e));
    });
    oweFromState();
    // Once the session is set up; a queued callback from an earlier session is inert.
    startupWake = setImmediate(() => {
      if (!attached || generation !== sessionGeneration) return;
      startupWake = undefined;
      guarded(flushOwed);
    });
    herdrActive = false;
    emit("herdr:probe", {
      reply: () => {
        herdrActive = true;
      },
    });
    // The footer status only exists with a UI: a headless session has nothing to tick.
    if (c.hasUI) {
      statusTimer = setInterval(() => {
        if (generation === sessionGeneration) {
          guarded(updateStatus);
          guarded(redrawRows);
        }
      }, 1_000);
      statusTimer.unref?.();
    }
    refresh();
  });

  pi.on("turn_start", () => {
    indicatorRaised = false;
  });
  pi.on("agent_settled", (_event, c) => {
    lowerIndicator(c);
    flushOwed(c);
  });
  pi.on("session_compact", (_event, c) => flushOwed(c));

  // The user's next message dismisses failures and stops they have had a chance to see.
  pi.on("input", (event) => {
    if ((event as { source?: string }).source !== "interactive") return;
    dismissedAt = Date.now();
    refresh();
  });

  // pi-herdr listens for holds from the moment it loads, so they are never sent twice.
  pi.events.on("herdr:ready", () => {
    herdrActive = true;
  });

  pi.on("session_shutdown", async (event) => {
    const ending = sessionId;
    detachSession();
    try {
      if (event.reason !== "reload") await reg.killAll("session", undefined, ending);
    } finally {
      // Quitting: kept services stay listed for a later pi to adopt, even if killing failed.
      if (event.reason === "quit") reg.release(ending);
    }
  });

  // ---- tools ----

  pi.registerMessageRenderer<WakeDetails>("pi-bg", (message, { expanded }, theme) => {
    const content = typeof message.content === "string" ? message.content : message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    return wakeView(content, message.details, expanded, theme);
  });

  pi.registerTool({
    name: "bg_run",
    label: "Background",
    description:
      "Run a shell command in the background, in its own process group, with its output in a log file. kind=job for a finite command whose result you need: you are woken with its outcome when it exits. kind=service for something that keeps running (dev or notebook server, tunnel, watcher): set `ready` to a regex for the line that means it is up; you are woken once when it matches, or if it exits. Jobs and services stop when this pi session ends, except services with keep=true. Don't pipe through `tail`, `head` or similar; the log keeps the full output, `bg_wait` returns its end, and `bg_logs` with `grep` finds the rest.",
    promptSnippet: "Run long commands (jobs) or servers (services) in the background; wait on them with bg_wait",
    promptGuidelines: [
      "Use bg_run for commands that may take more than a minute (kind=job) and for anything that must keep running (kind=service); plain bash for the rest.",
      "After starting a job, keep doing other useful work. When nothing is left but the job's result, call bg_wait, or end your turn: a running job keeps the turn open until it ends and its outcome continues the turn; the user can still interrupt by typing.",
      "Never poll a background task with sleep loops or repeated bg_logs calls: bg_wait or the wake-up message tells you when it ends.",
      "Use keep=true only for a service the user works in themselves (a notebook or dev server they have open) that should outlive this pi session.",
      `Progress shows on its own for standard bars (${CATALOGUE.map((f) => f.name).join(", ")}). When another command prints countable progress, set bg_run's progress to a preset or regex; in a script you write for bg_run, report it with \`echo "$done/$total [note]" > "$PI_BG_PROGRESS"\`.`,
    ],
    parameters: RunParams,
    ...OWN_RESULT,
    renderCall(args, theme) {
      const a = args as { command?: string; kind?: string };
      return new Text(`${theme.fg("toolTitle", theme.bold("Bash"))} ${(a.command ?? "").replace(/\s+/gu, " ")}${theme.fg("dim", ` · background ${a.kind === "service" ? "service" : "job"}`)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const id = (result.details as { id?: string } | undefined)?.id;
      if (id && !isPartial && reg.tasks.get(id)?.status === "running" && context?.invalidate) {
        const redraws = liveRows.get(id) ?? new Map<string, () => void>();
        redraws.set((context as { toolCallId?: string }).toolCallId ?? id, context.invalidate);
        liveRows.set(id, redraws);
      }
      return runResultView(result as never, expanded, theme, () => (id ? reg.tasks.get(id) : undefined));
    },
    async execute(_id, params, _signal, _onUpdate, c) {
      const kind = params.kind as Kind;
      if (params.ready && kind !== "service") throw new Error("`ready` is for services; a job wakes you when it exits.");
      if (params.ready) parsePattern(params.ready);
      if (params.keep && kind !== "service") throw new Error("`keep` is for services.");
      if (params.timeout && kind !== "job") throw new Error("`timeout` is for jobs; a service runs until it is stopped.");
      // A marimo server without pi-marimo's help still gets a name and a ready line.
      const server = kind === "service" ? marimoServer(params.command) : undefined;
      const cwd = params.cwd ? path.resolve(c.cwd, params.cwd.replace(/^~(?=\/|$)/u, process.env.HOME ?? "~")) : c.cwd;
      if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`No such directory: ${cwd}`);
      const task = reg.start({
        command: params.command,
        name: params.name?.trim() || (server ? marimoName(server) : nameFromCommand(params.command)),
        kind,
        cwd,
        sessionId,
        origin: "agent",
        ready: params.ready ?? (server ? MARIMO_READY : undefined),
        timeoutSec: params.timeout,
        keep: params.keep,
        progress: params.progress,
      });
      // A command that fails at once (a typo, a missing file) is reported here rather than as a wake-up.
      const { waiter, done } = waitFor({ targets: new Set([task.id]), any: false, silent: true }, STARTUP_WAIT_MS, undefined);
      await done;
      refresh();
      if (waiter.finished.length) return text(`${task.name} (${task.kind} ${task.id}) ended at once.\n\n${report(task)}`);
      const lines = [`Started ${task.name} (${task.kind} ${task.id}, pid ${task.pid}). Log: ${task.logPath}`];
      if (task.kind === "job") {
        lines.push(`You will be woken when it exits${task.timeoutSec ? ` (killed after ${task.timeoutSec}s)` : ""}. If nothing else is left to do, call bg_wait or end your turn: the turn stays open until the job ends.`);
      } else if (waiter.readied.length) {
        lines.push(`It is ready: ${task.readyLine}`);
      } else if (task.readyPattern) {
        lines.push(`You will be woken once when a log line matches /${task.readyPattern}/, or if it exits. bg_wait ${task.id} waits for that.`);
      } else {
        lines.push("You will be woken if it exits. Set `ready` next time to be told when it is up.");
      }
      if (task.keep) lines.push("It keeps running after this pi session ends.");
      if (task.progressSpec && task.progressSpec.toLowerCase() !== "none") lines.push(`Progress: ${FORMAT_NAMES.includes(task.progressSpec.toLowerCase()) ? `read as ${task.progressSpec.toLowerCase()} output` : `from log lines matching ${task.progressSpec}`}${task.progress ? `, now ${progressText(task)}` : ""}.`);
      return { ...text(lines.join("\n")), details: { id: task.id } };
    },
  });

  pi.registerTool({
    name: "bg_wait",
    label: "Wait",
    description: `Wait inside this turn for a background job to end (or a service to become ready, when named), then get its outcome and the end of its log. Without id, waits for whichever running job ends first. \`id\` may also name outside work other extensions report, such as \`marimo:<file>\` for a running marimo notebook (pi-marimo); for a marimo server that is up, with pi-marimo installed, its id waits for the notebook's running cells. Returns early when the user sends a message, on Esc, or after \`timeout\` seconds (default ${WAIT_DEFAULT_S}); the job keeps running and still wakes you when it ends.`,
    promptSnippet: "Wait for a background job (keeps the turn working)",
    parameters: WaitParams,
    ...OWN_RESULT,
    renderCall(args, theme) {
      const a = args as { id?: string };
      return new Text(`${theme.fg("toolTitle", theme.bold("Wait"))} ${a.id ? (reg.find(a.id, sessionId)?.name ?? a.id) : "next job"}`, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      // Reports keep the look of Pi's own tool output; a subagent's answer reads as Markdown.
      return reportResultView(result as never, expanded, theme, Boolean((context as { isError?: boolean } | undefined)?.isError));
    },
    async execute(_id, params, signal, _onUpdate, c) {
      const generation = sessionGeneration;
      const timeoutS = Math.min(Math.max(1, Math.round(params.timeout ?? WAIT_DEFAULT_S)), WAIT_MAX_S);
      const targets = new Set<string>();
      let any = false;
      if (params.id) {
        const x = findExternal(params.id);
        const t = x ? undefined : reg.find(params.id, sessionId);
        // A server that is up, with outside work an extension tied to it (a marimo kernel): wait for that.
        const tied = t && t.status === "running" && t.kind === "service" && (t.ready || !t.readyPattern) ? (noteOf(t)?.wait ?? []) : [];
        const tiedRunning = tied.map(findExternal).filter((e): e is External => e?.state === "running");
        if (x) {
          if (x.state !== "running") return blocks(consumeExternal(x));
          targets.add(x.id);
        } else if (!t) {
          const known = [...reg.list(sessionId).map((k) => `${k.id} ${k.name}`), ...[...externals.values()].filter((e) => e.state === "running").map((e) => e.id)];
          throw new Error(`No task or outside work matches "${params.id}". ${known.length ? `Known: ${known.join(", ")}.` : "Nothing is running."}`);
        } else if (t.status !== "running") {
          t.delivered = true;
          refresh();
          return text(report(t));
        } else if (tiedRunning.length) {
          for (const e of tiedRunning) targets.add(e.id);
        } else if (tied.length) {
          t.readyDelivered = true;
          return text(`${report(t)}\n\nNothing is running in it: ${noteOf(t)?.detail}.`);
        } else if (t.kind === "service" && t.ready) {
          t.readyDelivered = true;
          return text(report(t));
        } else {
          if (t.kind === "service" && !t.readyPattern) throw new Error(`${t.name} is a service without a ready pattern: there is nothing to wait for until it exits.`);
          targets.add(t.id);
        }
      } else {
        const jobs = agentJobs();
        if (!jobs.length) {
          const services = reg.running(sessionId).filter((t) => t.kind === "service");
          return text(`Nothing to wait for: no job is running.${services.length ? ` Services: ${services.map((t) => `${t.name} (${outcome(t)})`).join(", ")}.` : ""}`);
        }
        any = true;
      }
      if (c.hasPendingMessages()) {
        return text("Not waiting: messages are queued for you and arrive when your turn ends. End your turn to read them; running jobs keep going and wake you when they end.");
      }
      const names = () => (any ? agentJobs() : [...targets].map((id) => reg.tasks.get(id)).filter((t): t is Task => !!t));
      const label = () => {
        const ts = names();
        if (!ts.length) return [...targets].map((id) => externals.get(id)?.label ?? id).join(" · ") || "outside work";
        return ts.map(waitLabel).join(" · ");
      };
      const started = Date.now();
      const working = holdWorking(c, generation, label);
      let ticks = 0;
      let reason: Reason;
      let waiter: Waiter;
      let cancelWait: (() => void) | undefined;
      try {
        working.set();
        const waiting = waitFor({ targets, any, silent: false }, timeoutS * 1000, () => {
          if (!attached || generation !== sessionGeneration || signal?.aborted) return "aborted";
          if (c.hasPendingMessages()) return "message";
          if (++ticks % 4 === 0) working.set();
          return undefined;
        });
        waiter = waiting.waiter;
        cancelWait = () => waiter.resolve("aborted");
        refresh();
        reason = await waiting.done;
      } finally {
        cancelWait?.();
        working.release();
      }
      refresh();
      const out: Block[] = [];
      for (const t of waiter.finished) out.push({ text: report(t) });
      for (const t of waiter.readied) out.push({ text: report(t) });
      for (const x of waiter.externals) out.push(...consumeExternal(x));
      if (reason !== "done") {
        const still = names().filter((t) => t.status === "running");
        const what = still.length ? still.map((t) => `${t.name} (${[t.id, runtime(t), progressText(t)].filter(Boolean).join(", ")})`).join(", ") : label();
        const why =
          reason === "message"
            ? "Stopped waiting: the user sent a message."
            : reason === "aborted"
              ? "Stopped waiting: interrupted."
              : `Stopped waiting after ${elapsed(Date.now() - started)} (the timeout).`;
        out.push({ text: `${why} Still running: ${what}. It wakes you when it ends; call bg_wait again to keep waiting.` });
      }
      if (waiter.extras.length) out.push({ text: `Also while you waited:\n${waiter.extras.map((e) => `- ${e}`).join("\n")}` });
      // One block per item for the renderer; plain ones are merged so the model reads them as before.
      const merged: Block[] = [];
      for (const b of out) {
        const last = merged.at(-1);
        if (last && !last.markdown && !b.markdown) last.text = `${last.text}\n\n${b.text}`;
        else merged.push({ ...b });
      }
      return blocks(merged);
    },
  });

  pi.registerTool({
    name: "bg_logs",
    label: "Logs",
    description: "Read a background task's log: its status, then the last lines (or the first, or only lines matching `grep`). Without id, lists every task.",
    promptSnippet: "Read a background task's log, or list the tasks",
    parameters: LogsParams,
    ...OWN_RESULT,
    renderCall(args, theme) {
      const a = args as { id?: string };
      return new Text(a.id ? `${theme.fg("toolTitle", theme.bold("Task log"))} ${reg.find(a.id, sessionId)?.name ?? a.id}` : theme.fg("toolTitle", theme.bold("Tasks")), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      return reportResultView(result as never, expanded, theme, Boolean((context as { isError?: boolean } | undefined)?.isError));
    },
    async execute(_id, params) {
      if (!params.id) {
        const tasks = reg.list(sessionId);
        const tied = new Set<string>();
        const lines = tasks.map((t) => {
          const note = noteOf(t);
          if (!note) return taskLine(t);
          for (const id of note.wait) tied.add(findExternal(id)?.id ?? id);
          return `${taskLine(t)}\n    ${note.detail}${note.wait.length ? ` (bg_wait ${t.id} waits for ${note.wait.join(", ")})` : ""}`;
        });
        for (const x of externals.values()) if (x.state === "running" && !tied.has(x.id)) lines.push(`${x.id}  ${x.label}  outside work  running`);
        return text(lines.length ? lines.join("\n") : "No background tasks.");
      }
      const t = reg.find(params.id, sessionId);
      if (!t) throw new Error(`No task matches "${params.id}".`);
      const n = Math.min(Math.max(1, Math.round(params.lines ?? LOGS_DEFAULT)), LOGS_MAX);
      const lines = params.grep ? grep(t.logPath, parsePattern(params.grep), n) : params.head ? head(t.logPath, n) : tail(t.logPath, n);
      if (t.status !== "running") t.delivered = true;
      const { text: body, dropped } = bounded(lines, LOGS_BYTES);
      const what = params.grep ? `lines matching ${params.grep}` : params.head ? "first lines" : "last lines";
      const shown = lines.length - dropped;
      return text(`${header(t)}\nLog: ${t.logPath}\n\n${shown ? `${shown} ${what}${dropped ? ` (${dropped} more cut for length)` : ""}:\n${body}` : `No ${what}.`}`);
    },
  });

  const stopTask = async (t: Task, by: "agent" | "user") => {
    await reg.kill(t.id, by);
    emit("bg:killed", { id: t.id, command: t.command, cwd: t.cwd });
    refresh();
  };

  pi.registerTool({
    name: "bg_kill",
    label: "Stop",
    description: "Stop a background task: SIGTERM to its process group, then SIGKILL after 3 seconds.",
    promptSnippet: "Stop a background task",
    parameters: KillParams,
    ...OWN_RESULT,
    renderCall(args, theme) {
      const a = args as { id?: string };
      return new Text(`${theme.fg("toolTitle", theme.bold("Stop"))} ${a.id ? (reg.find(a.id, sessionId)?.name ?? a.id) : ""}`, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      return reportResultView(result as never, expanded, theme, Boolean((context as { isError?: boolean } | undefined)?.isError));
    },
    async execute(_id, params) {
      const t = reg.find(params.id, sessionId);
      if (!t) throw new Error(`No task matches "${params.id}".`);
      if (t.status !== "running") {
        t.delivered = true;
        return text(`${t.name} (${t.id}) already ended: ${outcome(t)} after ${runtime(t)}.`);
      }
      await stopTask(t, "agent");
      const note = marimoNote(t.command);
      const last = tail(t.logPath, 10);
      return text([`Stopped ${t.name} (${t.id}) after ${runtime(t)}.`, note, last.length ? `Last lines:\n${bounded(last, 3_000).text}` : undefined].filter(Boolean).join("\n\n"));
    },
  });

  // ---- the dialog and its commands ----

  const openLog = async (ui: ExtensionContext["ui"], t: Task) => {
    await ui.custom<void>(
      (tui, theme, _kb, done) => new LogViewer(tui as any, theme as any, t, t.status === "running" ? () => void stopTask(t, "user") : undefined, () => done(undefined)),
      FULL_SCREEN,
    );
  };

  const startUserTask = (c: ExtensionContext, command: string) => {
    const t = reg.start({ command, name: nameFromCommand(command), kind: "job", cwd: c.cwd, sessionId, origin: "user" });
    t.delivered = true;
    refresh();
    c.ui.notify(`bg: started ${t.name} (${t.id})`, "info");
    return t;
  };

  const follow = (c: Pick<ExtensionContext, "ui">, t: Task) =>
    emit("herdr:split", {
      command: `tail -n 200 -F ${JSON.stringify(t.logPath)}`,
      cwd: t.cwd,
      done: (ok: boolean, message: string) => {
        if (!ok) c.ui.notify(`bg: ${message}`, "warning");
      },
    });

  /** The background-tasks dialog; after an entry's view closes, back to the list on that entry. */
  const openDialog = async (ui: ExtensionContext["ui"]) => {
    let initialKey: string | undefined;
    for (;;) {
      const sections = () => [section, ...others.values()];
      const picked: DialogResult = await ui.custom<DialogResult>(
        (tui, theme, _kb, done) => new TasksDialog(tui as any, theme as any, { sections, ownId: section.id, canFollow: herdrActive, initialKey }, done),
        FULL_SCREEN,
      );
      if (!picked) return;
      initialKey = stableKey(picked.kind === "open" ? picked.section.id : section.id, picked.key);
      if (picked.kind === "open") {
        // Another source's view (pi-subagents' conversation) may fail; the dialog comes back regardless.
        try {
          await picked.section.open(picked.key, ui);
        } catch {
          // Shown nothing; back to the list.
        }
      }
      else if (picked.kind === "rerun") {
        const t = reg.find(picked.key, sessionId);
        if (t && ctx) initialKey = stableKey(section.id, startUserTask(ctx, t.command).id);
      } else if (picked.kind === "follow") {
        const t = reg.find(picked.key, sessionId);
        if (t) follow({ ui }, t);
        return;
      }
    }
  };

  const tasksCommand = {
    description: "Background tasks (also /bashes, /ps, /bg): the dialog; `run <command>` starts one, `kill <id>` stops one, `clear` hides ended ones",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["run ", "kill ", "clear"].filter((x) => x.startsWith(prefix));
      return subs.length ? subs.map((x) => ({ value: x, label: x.trim() })) : null;
    },
    handler: async (args: string, c: ExtensionContext) => {
      const [sub, ...rest] = args.trim().split(/\s+/u);
      const arg = args.trim().slice((sub ?? "").length).trim();
      if (sub === "run") {
        if (!arg) return c.ui.notify("Usage: /tasks run <command>", "warning");
        startUserTask(c, arg);
        return;
      }
      if (sub === "kill") {
        const t = reg.find(rest.join(" "), sessionId);
        if (!t || t.status !== "running") return c.ui.notify(`No running task matches "${arg}".`, "warning");
        await stopTask(t, "user");
        return c.ui.notify(`bg: stopped ${t.name}`, "info");
      }
      if (sub === "clear") {
        let n = 0;
        for (const t of reg.list(sessionId)) {
          if (t.status === "running") continue;
          reg.cleared.add(t.id);
          n++;
        }
        refresh();
        return c.ui.notify(n ? `Cleared ${n} ended task${n === 1 ? "" : "s"}.` : "Nothing to clear.", "info");
      }
      if (c.mode === "tui") return openDialog(c.ui);
      // Without the TUI: a plain list.
      const lines = reg.list(sessionId).map((t) => taskLine(t));
      c.ui.notify(lines.length ? lines.join("\n") : "No background tasks.", "info");
    },
  };
  // Claude Code's /tasks and /bashes, Codex's /ps, and our own /bg.
  for (const name of ["tasks", "bashes", "ps", "bg"]) pi.registerCommand(name, tasksCommand);

  // Codex's /stop: stop every background task this pi started (kept services from earlier sessions
  // stay). Other sources' work (subagents, notebooks, herdr children) is stopped from its own
  // commands or with x in /tasks, never from here.
  pi.registerCommand("stop", {
    description: "Stop every background task this session started (not kept services from earlier sessions; subagents, notebooks and herdr children are stopped from /tasks or their own commands)",
    handler: async (_args, c) => {
      const running = reg.running(sessionId).filter((t) => !t.adopted);
      if (!running.length) return c.ui.notify("No background tasks running.", "info");
      await Promise.all(running.map((t) => stopTask(t, "user")));
      c.ui.notify(`bg: stopped ${running.length} task${running.length === 1 ? "" : "s"}`, "info");
    },
  });
}
