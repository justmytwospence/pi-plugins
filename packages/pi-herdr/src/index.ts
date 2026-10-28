// pi-herdr: pi's own herdr integration, beside the one herdr installs (which reports state and the
// session for resume). Only a TUI session inside herdr does anything; outside herdr nothing is
// registered, and RPC/print sessions (subagents, which inherit the parent's HERDR_PANE_ID) drop
// the tool and report nothing.
//
// - `bg` pane token: background work that will wake the agent (activity.ts).
// - `wait` pane token: what a turn is kept open only to wait on (pi-bg's bg_wait, or its wait for a
//   job at the turn's end), from `herdr:waiting { active, label, id }` holds. herdr still shows the
//   pane working; a client that reads the token (herdr-web-ui's HERDR_WEB_WAIT_TOKEN) knows that
//   typing now ends the wait, as it does in the terminal.
// - The pane's title (session name or first prompt; also the token `task`) and displayed agent
//   name (`pi opus-5-5:xhigh`) (identity.ts).
// - The event-bus bridge other extensions use instead of talking to herdr (bridge.ts).
// - The `herdr` tool: message, read and wait on any agent in herdr (agents.ts), and interactive pi
//   children in a tab, a split or a new worktree (children.ts). Children are also a source for
//   the suite's activity views (children-activity.ts): rows in pi-bg's /tasks, a pill in
//   pi-subagents' list, read-only.
// - The inbox (inbox.ts): messages from other pi-herdr sessions arrive as one marked paste, taken
//   before the editor sees it and delivered with pi.sendMessage, so a draft is never touched; the
//   draft guard (draft-guard.ts) keeps a draft out of prompts other programs type into the pane.
// - `pr` space token: the branch's pull request (pr.ts).
// - Tool calls get a one-line `intent` that herdr-web-ui's chat shows on their row (intent.ts).
// - `summary` pane token: what the last turn did or what a dialog waits on, for alerts (summary.ts).
//   With pi-recap loaded, a settled turn's line is pi-recap's recap (asked for over
//   `recap:summary { reply(promise) }`), so the alert and the recap line are the same text.
//
// Lifecycle: children are restored from the session's current branch (an abandoned branch's
// children are not this conversation's), their replies are delivered only while pi is idle (a
// follow-up queued mid-turn is dropped when the user presses Esc), each awaited turn's reply once,
// and nothing calls pi after session_shutdown (a stale runtime throws).
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION } from "./activity.ts";
import { ACTIVITY_CHANNELS, type HoldEvent } from "./core/activity.ts";
import { ActivityBadges } from "./activity-badges.ts";
import { Agents, type AgentInfo, outcomeText } from "./agents.ts";
import { Bridge, type NotifyEvent, type SplitEvent, type TokenEvent } from "./bridge.ts";
import { ChildrenActivity } from "./children-activity.ts";
import { type ChildRecord, Children, type Exec, type Where } from "./core/children.ts";
import { DraftGuard } from "./draft-guard.ts";
import { ACK_TTL_MS, ackTokenName, Inbox, INBOX_SOURCE, INBOX_TOKEN, INBOX_TTL_MS, inboxTokenValue, messageText, type Outcome, type Sender } from "./inbox.ts";
import { type Call, herdrTarget, socketCall } from "./core/herdr.ts";
import { displayAgent, firstUserText, titleFromPrompt } from "./identity.ts";
import { PR_FIELDS, parsePrView, prToken } from "./core/pr.ts";
import { PaneReporter, WorkspaceReporter } from "./core/report.ts";
import { withIntents } from "./intent.ts";
import { PI_CHILD } from "./session.ts";
import { blockedSummary, type SummaryRegistry, turnSummary } from "./summary.ts";

const TOOL = "herdr";
const CHILD_ENTRY = "pi-herdr:child";
const DELIVERY_ENTRY = "pi-herdr:delivered";
const BG_TTL_MS = 90_000;
const PR_TTL_MS = 10 * 60_000;
const PR_POLL_MS = 3 * 60_000;

const exec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? ((err as any).code as number) : (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
    });
  });


const Params = Type.Object({
  action: Type.Union(
    [Type.Literal("list"), Type.Literal("send"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("spawn"), Type.Literal("interrupt"), Type.Literal("close")],
    { description: "list agents; send a message to any agent; read its last reply or screen; wait for its turn to end, then read it (not for children); spawn a child; interrupt a child's turn (Escape); close a child's pane" },
  ),
  task: Type.Optional(Type.String({ description: "spawn: the complete, self-contained task" })),
  name: Type.Optional(Type.String({ description: "spawn: a short name for the child (lowercase, dashes); otherwise from the task. send/read/wait: the agent's herdr name or pane id (a child's name works too). interrupt/close: which child" })),
  machine: Type.Optional(Type.String({ description: "list/send/read/wait: a saved herdr machine (its label, as in `herdr --machine`) instead of this one" })),
  where: Type.Optional(
    Type.Union([Type.Literal("tab"), Type.Literal("split"), Type.Literal("worktree")], {
      description: "spawn: tab in this space for a persistent session sharing this checkout (default); split for side-by-side interaction; worktree for a user-requested independent branch/checkout in its own space (needs branch)",
    }),
  ),
  branch: Type.Optional(Type.String({ description: "spawn with where=worktree: the user-requested independent branch (checked out, tracked or created from HEAD); do not create a worktree without the user's request" })),
  model: Type.Optional(Type.String({ description: "spawn: provider/model; default this session's" })),
  thinking: Type.Optional(Type.String({ description: "spawn: off|minimal|low|medium|high|xhigh|max; default this session's" })),
  focus: Type.Optional(Type.Boolean({ description: "spawn: switch to the child's pane (default false)" })),
  message: Type.Optional(Type.String({ description: "send: the message" })),
  delivery: Type.Optional(
    Type.Union([Type.Literal("steer"), Type.Literal("queue")], {
      description: "send, when the agent is working: steer delivers it into the current turn (after its current tool call; for corrections to what it is doing now); queue delivers it once that turn ends (for new or separate work). Required when the agent is working; ignored when it is idle",
    }),
  ),
  lines: Type.Optional(Type.Number({ description: "read: screen lines when it reads the screen (default 80)" })),
  timeout_ms: Type.Optional(Type.Number({ description: "wait: give up after this long (default 600000, at most 3600000); the agent keeps going" })),
});

/** Test seams: the herdr call and process runner (pi passes nothing). */
export interface HerdrDependencies {
  call?: Call;
  exec?: Exec;
  pollMs?: number;
}

export default function piHerdr(pi: ExtensionAPI, dependencies: HerdrDependencies = {}) {
  const target = herdrTarget();
  if (!target) return;
  const call = dependencies.call ?? socketCall(target.socketPath);
  const run = dependencies.exec ?? exec;
  const pane = new PaneReporter(call, target.paneId);
  // The inbox's tokens: `inbox` (refreshed) and acks (never refreshed), apart from display tokens.
  const inboxPane = new PaneReporter(call, target.paneId, "pi", INBOX_SOURCE);
  const ackPane = new PaneReporter(call, target.paneId, "pi", `${INBOX_SOURCE}-ack`);
  const ackTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Open `herdr:blocked` holds: dialogs waiting on the user. */
  let blockedCount = 0;
  let stopInput: (() => void) | undefined;
  const bridge = new Bridge(call, pane);
  const activity = new ActivityBadges();
  /** Open `herdr:waiting` holds, id to label, oldest first. */
  const waits = new Map<string, string>();
  let anonymousWaits = 0;
  /** Tokens other extensions set before the session started. */
  const pendingTokens = new Map<string, TokenEvent>();

  let active = false;
  let generation = 0;
  let branchAnchor: string | null | undefined;
  const branchCurrent = () => {
    if (!active || !lastCtx) return false;
    try {
      return !branchAnchor || lastCtx.sessionManager.getBranch().some((e) => e.id === branchAnchor);
    } catch {
      return false;
    }
  };
  const anchorBranch = () => { branchAnchor = lastCtx?.sessionManager.getLeafId?.(); };
  /**
   * Runs `fn` only while this runtime's session is live. After session_shutdown pi marks the
   * runtime stale and every pi.* call throws; a child's poll that lands later must not call it.
   */
  const safely = (fn: () => void, owningBranch = true) => {
    if (!active || (owningBranch && !branchCurrent())) return false;
    try {
      fn();
      return true;
    } catch {
      // The runtime went stale between the check and the call.
      return false;
    }
  };
  let workspace: WorkspaceReporter | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let prTimer: ReturnType<typeof setInterval> | undefined;
  let prSoon: ReturnType<typeof setTimeout> | undefined;
  const stopInbox = () => {
    stopInput?.();
    stopInput = undefined;
    guard?.reset();
    inbox.reset();
    for (const t of ackTimers) clearTimeout(t);
    ackTimers.clear();
  };
  const clearTimers = () => {
    for (const t of [refreshTimer, prTimer]) if (t) clearInterval(t);
    if (prSoon) clearTimeout(prSoon);
    refreshTimer = prTimer = prSoon = undefined;
  };
  let prEnabled = process.env.PI_HERDR_PR !== "0";
  let cwd = process.cwd();
  let modelId: string | undefined;
  let thinking: string | undefined;
  let lastCtx: ExtensionContext | undefined;
  /** The first prompt's title, until the session has a name. */
  let promptTitle: string | undefined;
  /** pi-recap's automatic session name, which is for the /resume list, not the pane title. */
  let recapName: string | undefined;

  const updateBg = () => {
    if (active) void pane.setToken("bg", activity.token(), BG_TTL_MS);
  };
  /** The newest wait's label, the one the terminal shows. */
  const updateWait = () => {
    if (active) void pane.setToken("wait", [...waits.values()].at(-1), BG_TTL_MS);
  };

  const updateIdentity = (ctx?: ExtensionContext) => {
    if (!active) return;
    const c = ctx ?? lastCtx;
    if (!promptTitle && c) promptTitle = titleFromPrompt(firstUserText(c.sessionManager.getEntries() as any));
    const name = pi.getSessionName();
    const title = (name && name !== recapName ? name : undefined) ?? promptTitle;
    void pane.setPresentation(title, displayAgent(modelId, thinking));
    void pane.setToken("task", title);
  };

  const refreshPr = async () => {
    if (!branchCurrent() || !prEnabled) return;
    const epoch = generation;
    const current = () => epoch === generation && branchCurrent();
    if (!workspace) {
      const self = await call("pane.get", { pane_id: target.paneId });
      if (!current()) return;
      const id: string | undefined = self.result?.pane?.workspace_id;
      if (!id) return;
      workspace = new WorkspaceReporter(call, id);
    }
    const r = await run("gh", ["pr", "view", "--json", PR_FIELDS], cwd);
    if (!current()) return;
    if (r.code === 127) {
      prEnabled = false;
      return;
    }
    if (r.code === 0) return void workspace.setToken("pr", prToken(parsePrView(r.stdout)), PR_TTL_MS);
    // No PR for this branch (or not a GitHub repo): clear. Other failures (network) keep the last.
    if (/no pull requests found|not a git repository|no git remotes|none of the git remotes/iu.test(r.stderr)) void workspace.setToken("pr", undefined);
  };

  const schedulePr = (ms: number) => {
    if (!branchCurrent() || !prEnabled) return;
    if (prSoon) clearTimeout(prSoon);
    prSoon = setTimeout(() => void refreshPr(), ms);
    prSoon.unref?.();
  };

  /**
   * Replies owed to the agent, sent only while pi is idle (a follow-up queued during a turn is
   * dropped when the user presses Esc); several that pile up go out as one message each, in order.
   * Each awaited turn's reply is delivered once: a record restored and polled again, or saved twice
   * around the same reply, must not repeat it.
   */
  const owed = new Map<string, { rec: ChildRecord; text: string }>();
  const delivered = new Set<string>();
  // A fork changes its session ID but inherits this turn's message/receipt. Identity belongs to
  // the awaited child turn; only receipt membership (rebuilt below) belongs to the active branch.
  const turnKey = (rec: ChildRecord, text: string) => JSON.stringify([
    rec.name, rec.paneId, rec.createdAt, rec.turnId ?? rec.baseline ?? text,
  ]);
  const restoreReceipt = (raw: unknown) => {
    if (typeof raw !== "string") return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      // Accept receipts written by the earlier session-prefixed implementation, too.
      const identity = parsed.length === 5 ? parsed.slice(1) : parsed;
      if (identity.length === 4 && typeof identity[0] === "string" && typeof identity[1] === "string" && typeof identity[2] === "number") delivered.add(JSON.stringify(identity));
    } catch { /* Not a receipt from this producer. */ }
  };
  const flushOwed = () => {
    // Unknown idle state is not permission to enqueue a continuation.
    if (!branchCurrent() || !owed.size) return;
    try {
      if (lastCtx?.isIdle() !== true) return;
    } catch { return; }
    for (const [key, item] of owed) {
      if (!branchCurrent()) return;
      try { if (lastCtx?.isIdle() !== true) return; } catch { return; }
      if (children.records.get(item.rec.name) !== item.rec || turnKey(item.rec, item.text) !== key) { owed.delete(key); continue; }
      if (!delivered.has(key)) {
        const epoch = generation;
        const sent = safely(() => pi.sendMessage(
          { customType: "herdr-child", content: item.text, display: true, details: { name: item.rec.name, paneId: item.rec.paneId, turnKey: key } },
          { triggerTurn: true, deliverAs: "followUp" },
        ));
        if (!sent) return;
        delivered.add(key);
        if (epoch !== generation || !branchCurrent()) return;
        safely(() => { pi.appendEntry(DELIVERY_ENTRY, { key }); anchorBranch(); });
      }
      owed.delete(key);
      children.acknowledge(item.rec);
    }
  };
  const deliver = (rec: ChildRecord, text: string) => {
    if (!branchCurrent()) return;
    const key = turnKey(rec, text);
    owed.set(key, { rec, text });
    flushOwed();
  };

  /** Who this session is, for messages it sends. */
  const self = async (): Promise<Sender> => {
    const me = await call<{ agent?: AgentInfo }>("agent.get", { target: target.paneId });
    let session: string | undefined;
    try { session = pi.getSessionName(); } catch { /* stale runtime */ }
    const name = me.result?.agent?.name ?? (session && session !== recapName ? session : undefined);
    return { pane: target.paneId, ...(name ? { name } : {}), host: hostname().split(".")[0], cwd };
  };
  const agents = new Agents({ call, exec: run, selfPane: target.paneId, cwd: () => cwd, self });

  const inbox = new Inbox({
    isIdle: () => {
      try { return lastCtx?.isIdle(); } catch { return undefined; }
    },
    blocked: () => blockedCount,
    deliver: (env, deliverAs) => safely(() => pi.sendMessage(
      { customType: "herdr-message", content: messageText(env), display: true, details: { id: env.id, from: env.from, delivery: env.delivery } },
      deliverAs ? { triggerTurn: true, deliverAs } : { triggerTurn: true },
    ), false),
    ack: (env, outcome: Outcome) => {
      if (!active) return;
      const key = ackTokenName(env.id);
      void ackPane.setToken(key, outcome, ACK_TTL_MS);
      const t = setTimeout(() => { ackTimers.delete(t); void ackPane.setToken(key, undefined); }, ACK_TTL_MS);
      t.unref?.();
      ackTimers.add(t);
    },
    notify: (message, type) => { safely(() => lastCtx?.ui.notify(message, type), false); },
  });
  const guard = process.env.PI_HERDR_DRAFT_GUARD === "0" ? undefined : new DraftGuard({
    getText: () => lastCtx?.ui.getEditorText() ?? "",
    setText: (text) => { lastCtx?.ui.setEditorText(text); },
    notify: (message, type) => { safely(() => lastCtx?.ui.notify(message, type), false); },
    later: (fn) => { const t = setTimeout(() => { try { if (active) fn(); } catch { /* stale runtime */ } }, 0); t.unref?.(); },
    isEnter: (data) => matchesKey(data, "enter"),
  });

  const children = new Children({
    call,
    agent: PI_CHILD,
    transport: (_rec, text, delivery, info) => agents.sendInbox(info as AgentInfo, text, delivery, { awaitsReply: true }),
    selfPane: target.paneId,
    exec: run,
    isCurrent: branchCurrent,
    ...(dependencies.pollMs ? { pollMs: dependencies.pollMs } : {}),
    persist: (rec) => {
      if (safely(() => { pi.appendEntry(CHILD_ENTRY, rec); anchorBranch(); })) childrenActivity.observe(rec);
    },
    deliver,
    hold: (rec, on) =>
      safely(() => pi.events.emit("herdr:background", on ? { active: true, label: `child ${rec.name}`, id: `child:${rec.name}` } : { active: false, id: `child:${rec.name}` }), on),
  });

  // The children as a source for the suite's activity views (pi-bg's /tasks, pi-subagents' list).
  const childrenActivity = new ChildrenActivity(children, {
    changed: () => { safely(() => pi.events.emit(ACTIVITY_CHANGED, { id: childrenActivity.section.id })); },
    isCurrent: branchCurrent,
  });
  const offerChildren = () => {
    if (childrenActivity.available && branchCurrent() && lastCtx?.mode === "tui") safely(() => pi.events.emit(ACTIVITY_SECTION, { section: childrenActivity.section }));
  };
  pi.events.on(ACTIVITY_HOST, () => offerChildren());

  // The bridge. Listeners go in at load, so nothing emitted before session_start is missed.
  for (const channel of ACTIVITY_CHANNELS) {
    pi.events.on(channel, (e) => {
      activity.apply(channel, e as HoldEvent);
      updateBg();
    });
  }
  pi.events.on("herdr:waiting", (e) => {
    const hold = e as HoldEvent | undefined;
    if (hold?.active) {
      waits.delete(hold.id ?? "");
      waits.set(hold.id ?? `anonymous:${++anonymousWaits}`, hold.label?.trim() || "background work");
    } else if (hold?.id !== undefined) waits.delete(hold.id);
    else {
      // A release without an id ends the oldest hold, as on the activity channels.
      const oldest = waits.keys().next();
      if (!oldest.done) waits.delete(oldest.value);
    }
    updateWait();
  });
  pi.events.on("recap:session-name", (e) => {
    const name = (e as { name?: unknown } | undefined)?.name;
    recapName = typeof name === "string" ? name : undefined;
    updateIdentity();
  });
  pi.events.on("herdr:token", (e) => {
    const t = e as TokenEvent;
    if (!t || typeof t.key !== "string") return;
    if (active) return void bridge.token(t);
    pendingTokens.set(t.key, t);
  });
  pi.events.on("herdr:notify", (e) => {
    if (active) return bridge.notify(e as NotifyEvent);
  });
  pi.events.on("herdr:zoom", (e) => {
    if (active) return bridge.zoom(!!(e as HoldEvent)?.active);
  });
  pi.events.on("herdr:split", (e) => {
    const s = e as SplitEvent;
    if (active) return bridge.split(s);
    s?.done?.(false, "pi-herdr is not active in this session");
  });
  // The `summary` token (summary.ts): what a blocked dialog waits on, set as it opens.
  pi.events.on("herdr:blocked", (e) => {
    const hold = e as HoldEvent | undefined;
    if (hold?.active) blockedCount++;
    else if (hold) {
      blockedCount = Math.max(0, blockedCount - 1);
      // A message held while the dialog was open goes in once it closes.
      if (active && !blockedCount) inbox.flush();
    }
    if (!active || !hold?.active) return;
    try {
      void pane.setToken("summary", blockedSummary(hold.label, (lastCtx?.sessionManager.getBranch() ?? []) as any));
    } catch {
      // The runtime went stale.
    }
  });
  pi.events.on("herdr:probe", (e) => {
    if (active) (e as { reply?: () => void })?.reply?.();
  });

  const restoreBranch = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    anchorBranch();
    owed.clear();
    // Receipts belong to this history, not abandoned sibling branches.
    delivered.clear();
    const saved = new Map<string, ChildRecord>();
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      if (e.type === "custom" && e.customType === CHILD_ENTRY && e.data?.name) saved.set(e.data.name, e.data as ChildRecord);
      if (e.type === "custom" && e.customType === DELIVERY_ENTRY) restoreReceipt(e.data?.key);
      // The message itself is also a durable receipt if shutdown happened before its marker.
      if (e.type === "custom_message" && e.customType === "herdr-child") restoreReceipt(e.details?.turnKey);
    }
    children.restore(saved.values());
    childrenActivity.restored();
    offerChildren();
    for (const rec of children.records.values()) if (rec.pendingReply) deliver(rec, rec.pendingReply);
  };
  // Tree navigation changes the active branch without a session_start. Invalidate every in-flight
  // child read/prompt/poll first; never carry an owed reply or a dismissal across histories.
  pi.on("session_tree", (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    childrenActivity.dispose();
    children.shutdown();
    generation++;
    restoreBranch(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    // Switch/fork can start a new session without shutdown. Release the old holds while live,
    // invalidate retained sections and async work, and cancel timers before replacing the context.
    const hadSource = active && lastCtx?.mode === "tui";
    childrenActivity.dispose();
    if (active) children.shutdown();
    active = false;
    generation++;
    lastCtx = undefined;
    owed.clear();
    clearTimers();
    stopInbox();
    blockedCount = 0;
    if (ctx.mode !== "tui") {
      if (hadSource) {
        try { pi.events.emit(ACTIVITY_GONE, { id: childrenActivity.section.id }); } catch { /* stale runtime */ }
      }
      // A subagent or print run: no pane of its own.
      const tools = pi.getActiveTools();
      if (tools.includes(TOOL)) pi.setActiveTools(tools.filter((t) => t !== TOOL));
      return;
    }
    active = true;
    lastCtx = ctx;
    anchorBranch();
    cwd = ctx.cwd;
    modelId = ctx.model?.id;
    thinking = pi.getThinkingLevel();
    promptTitle = undefined;
    for (const t of pendingTokens.values()) void bridge.token(t);
    pendingTokens.clear();
    updateBg();
    updateWait();
    updateIdentity(ctx);
    // The inbox: other pi-herdr sessions' messages are taken here, before any editor or overlay.
    if (typeof ctx.ui.onTerminalInput === "function") {
      stopInput = ctx.ui.onTerminalInput((data) => inbox.input(data) ?? guard?.input(data));
      void inboxPane.setToken(INBOX_TOKEN, inboxTokenValue(process.pid), INBOX_TTL_MS);
    }

    restoreBranch(ctx);

    refreshTimer = setInterval(() => {
      void pane.refresh();
      void inboxPane.refresh();
      void workspace?.refresh();
    }, 15_000);
    refreshTimer.unref?.();
    if (prEnabled) {
      schedulePr(2_000);
      prTimer = setInterval(() => void refreshPr(), PR_POLL_MS);
      prTimer.unref?.();
    }
    pi.events.emit("herdr:ready", {});
  });

  pi.on("session_shutdown", async () => {
    if (!active) return;
    const hadSource = lastCtx?.mode === "tui";
    childrenActivity.dispose();
    children.shutdown();
    // A surviving host may synchronously announce itself from activity:gone. Invalidate first,
    // so its announcement cannot resurrect a source belonging to this departing runtime.
    active = false;
    generation++;
    lastCtx = undefined;
    if (hadSource) {
      try { pi.events.emit(ACTIVITY_GONE, { id: childrenActivity.section.id }); } catch { /* stale runtime */ }
    }
    // The completed record's pendingReply restores an owed reply in the next runtime.
    owed.clear();
    clearTimers();
    stopInbox();
    await bridge.reset();
    await inboxPane.clearTokens();
    await ackPane.clearTokens();
    await pane.clearAll();
    await workspace?.clearTokens();
  });

  pi.on("model_select", (event) => {
    modelId = event.model?.id;
    updateIdentity();
  });
  pi.on("thinking_level_select", (event) => {
    thinking = event.level;
    updateIdentity();
  });
  pi.on("session_info_changed", () => updateIdentity());
  pi.on("before_agent_start", (event, ctx) => {
    lastCtx = ctx;
    if (!promptTitle && "prompt" in event) promptTitle = titleFromPrompt(event.prompt);
    updateIdentity(ctx);
  });
  // A turn's summary replaces the last one; it is cleared as a run starts so an alert never shows
  // a stale one, and set before settling, so it is there when herdr's integration reports done.
  pi.on("agent_start", () => {
    if (active) void pane.setToken("summary", undefined);
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return undefined;
    const epoch = generation;
    let summary: string | undefined;
    try {
      let recap: Promise<string | undefined> | undefined;
      pi.events.emit("recap:summary", { reply: (p: Promise<string | undefined>) => void (recap = p) });
      summary = recap
        ? await recap
        : await turnSummary(ctx.modelRegistry as unknown as SummaryRegistry, ctx.sessionManager.getBranch() as any);
    } catch {
      return undefined;
    }
    if (epoch === generation && active) await pane.setToken("summary", summary);
    return undefined;
  });
  pi.on("agent_settled", () => {
    schedulePr(5_000);
    flushOwed();
    inbox.flush();
  });
  // herdr-web-ui labels a tool row with the call's `intent`: give calls without a summary one.
  pi.on("message_end", (event) => {
    if (!active) return undefined;
    const message = withIntents(event.message);
    return message ? { message } : undefined;
  });

  pi.registerTool({
    name: TOOL,
    label: "Herdr",
    description:
      "Herdr: talk to any agent in herdr (on this machine, or on a saved herdr machine with `machine`) and start persistent, human-led pi sessions (children) for an explicit interactive-session request or a clear handoff to the user. Children are not for delegated work whose purpose is to report back to this session: use a headless subagent instead, even for long or multi-step tasks. action=list shows the agents. send (name, message; delivery when the agent is working) messages any agent; a pi with pi-herdr gets it through its inbox, which never touches the draft in its editor. read (name) returns its last reply or its screen; wait (name) waits for its turn to end, then reads it. spawn takes `task` (plus optional name, where, branch, model, thinking, focus): a tab shares this checkout in the existing space; a split is for side-by-side interaction; a worktree gets its own space and requires a user-requested independent branch/checkout. A child's replies arrive as messages, so do not poll or wait on it. interrupt and close act on children only.",
    promptSnippet: "Message, read and wait on any herdr agent; start persistent human-led pi sessions in herdr for interactive requests or user handoffs, not report-back subagents",
    promptGuidelines: [
      "Start a herdr child (herdr action=spawn) only for an explicit interactive-session request or a clear persistent, human-led handoff that the user will continue independently. Duration, complexity, the user possibly wanting to watch, and a child's ability to report back are not reasons to use one instead of a headless subagent.",
      "For an interactive handoff sharing the current checkout and branch, use where=tab in the existing Herdr space. Tabs and splits share files; do not treat them as isolated parallel editors. Use where=split only for deliberate side-by-side interaction or when requested, and preserve focus unless asked to switch.",
      "Use where=worktree for an independent branch/checkout only when the user requests a worktree or branch isolation; otherwise ask before creating one. It opens the checkout in its own Herdr space (or adds a tab there if already open). Do not create a new space or worktree merely because work is delegated, long, or parallel.",
      "Give a herdr child a complete, self-contained task: it cannot see this conversation.",
      "A herdr child's reply arrives as a message when its turn ends; end your turn instead of polling, and use herdr action=send for follow-ups.",
      "Message another agent (a child or any other, here or on a saved herdr machine) with herdr action=send, not `herdr agent prompt` in bash: a pi with pi-herdr gets it through its inbox without touching the user's draft there, and the result says whether it started a turn, was steered in, was queued, or is held behind a dialog. If the target is working, choose delivery: steer for a correction to the work it is doing now; queue for new or separate work that should not derail its current turn.",
      "Only a child's replies come back on their own. For any other agent, use herdr action=wait (it waits for the turn to end) or action=read. A reply from another machine or a non-pi agent is a screen read and can be cut short; when you need a long answer from one, ask it to write the answer to a file and send you the path.",
    ],
    parameters: Params,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!branchCurrent()) throw new Error("The herdr tool needs a current interactive pi session inside herdr.");
      if (!branchAnchor) anchorBranch();
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
      const need = (v: string | undefined, what: string) => {
        if (!v?.trim()) throw new Error(`action=${params.action} needs \`${what}\`.`);
        return v.trim();
      };
      const machine = params.machine?.trim() || undefined;
      /** This session's live child by that name (children live on this machine). */
      const child = (name: string) => {
        const rec = machine ? undefined : children.records.get(name);
        return rec && !rec.closed ? rec : undefined;
      };
      const childOnly = (name: string) => {
        if (!child(name)) throw new Error(`action=${params.action} acts only on this session's children, and "${name}" is not one.${children.records.size ? ` Children: ${[...children.records.keys()].join(", ")}.` : ""}`);
        return name;
      };
      switch (params.action) {
        case "spawn": {
          if (machine) throw new Error("Children start on this machine only; drop `machine`.");
          const where: Where = params.where ?? "tab";
          const rec = await children.spawn({
            task: need(params.task, "task"),
            name: params.name,
            where,
            branch: params.branch,
            model: params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
            thinking: params.thinking ?? pi.getThinkingLevel(),
            focus: params.focus,
            cwd: ctx.cwd,
          });
          const place = where === "worktree" ? `worktree ${rec.branch} (${rec.cwd})` : where === "split" ? "a split beside this pane" : "a new tab";
          return text(`Started herdr child "${rec.name}" in ${place}, pane ${rec.paneId}, and sent it the task. Its reply arrives as a message when its turn ends; do not poll.`);
        }
        case "send": {
          const name = need(params.name, "name");
          const message = need(params.message, "message");
          if (child(name)) {
            if (!params.delivery) {
              const status = await children.status(name);
              if (status === "working" || status === "blocked") {
                throw new Error(`${name} is ${status} on a turn now, so nothing was sent. Read it (action=read) if you need to know what it is doing, then send again with delivery=steer to put the message into its current turn (a correction to that work), or delivery=queue to send it when the turn ends (new or separate work).`);
              }
            }
            const { rec, outcome, delivered } = await children.send(name, message, params.delivery);
            const how = outcome === "queued"
              ? `Queued for ${rec.name}: it is still working and gets the message when its current turn ends.`
              : delivered
                ? `Sent to ${rec.name} through its inbox (its draft is untouched): ${outcomeText(rec.name, delivered === "unconfirmed" ? undefined : delivered as Outcome)}`
                : outcome === "steered"
                  ? `Sent to ${rec.name} mid-turn: it steers the turn it is working on.`
                  : `Sent to ${rec.name}.`;
            return text(`${how} Its reply arrives as a message.`);
          }
          const r = await agents.send(name, message, { delivery: params.delivery, machine });
          const label = r.info.name ?? r.info.pane_id!;
          const after = "Its reply is not sent back: use action=wait to wait for its turn to end, or action=read.";
          if (r.via === "inbox") return text(`Sent to ${label} through its inbox (its draft is untouched): ${outcomeText(label, r.outcome)} ${after}`);
          return text(`Typed into ${label}'s terminal with herdr agent prompt: ${r.info.agent ?? "the agent"} there has no pi-herdr inbox, so a draft in its editor would have gone in with the message. ${after}`);
        }
        case "read": {
          const name = need(params.name, "name");
          return text(child(name) ? await children.read(name, params.lines) : await agents.read(name, { machine, lines: params.lines }));
        }
        case "wait": {
          const name = need(params.name, "name");
          if (child(name)) throw new Error(`${name} is this session's child: its reply arrives as a message on its own. End your turn instead of waiting, or use action=read.`);
          return text(await agents.wait(name, { machine, timeoutMs: params.timeout_ms, signal }));
        }
        case "list": {
          const byPane = new Map([...children.records.values()].filter((r) => !r.closed).map((r) => [r.paneId, r.name]));
          const all = await agents.list({ machine, children: byPane });
          return text(machine || !children.records.size ? all : `${all}\n\nThis session's children:\n${await children.list()}`);
        }
        case "interrupt":
          return text(await children.interrupt(childOnly(need(params.name, "name"))));
        case "close":
          return text(await children.close(childOnly(need(params.name, "name"))));
      }
    },
  });
}
