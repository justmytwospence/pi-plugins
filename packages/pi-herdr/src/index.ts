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
//   Beyond children, `send` with `await_reply` tracks any other agent as a peer (children.ts adopt):
//   its reply comes back like a child's. Every awaited reply is also outside work for pi-bg
//   (`bg:external`, id `herdr:<name>`), so `bg_wait` can wait on several at once.
//   The receiver's presence (the user typing holds a message) and rate guard (a sender that keeps
//   starting turns without an answer is deferred) are in inbox.ts; `$typing` shows presence.
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
import { Agents, type AgentInfo, MAX_BROADCAST, outcomeText, TYPING_TOKEN } from "./agents.ts";
import { Bridge, type NotifyEvent, type SplitEvent, type TokenEvent } from "./bridge.ts";
import { ChildrenActivity } from "./children-activity.ts";
import { Crew, CREW_MESSAGE, type Me, SECTION as CREW_SECTION, SEEN_ENTRY, type Seen, syncCrew } from "./crew.ts";
import { type ChildRecord, Children, type Exec, type Where } from "./core/children.ts";
import { DraftGuard } from "./draft-guard.ts";
import { ACK_TTL_MS, ackTokenName, type Delivery, formatAck, Inbox, INBOX_SOURCE, INBOX_TOKEN, INBOX_TTL_MS, inboxTokenValue, messageText, type Outcome, parseRate, Presence, processInboxState, type Reason, type Sender, TYPING_IDLE_MS } from "./inbox.ts";
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
const TYPING_TTL_MS = 30_000;
/** How often a held message rechecks whether the user has stopped typing. */
const HELD_POLL_MS = 300;
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
    [Type.Literal("list"), Type.Literal("send"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("spawn"), Type.Literal("interrupt"), Type.Literal("close"), Type.Literal("crew")],
    { description: "list agents; send a message to any agent; read its last reply or screen; wait for its turn to end, then read it (not for children); spawn a child; interrupt a child's turn (Escape); close a child's pane; crew: this repository's worktree sessions, coordinated from this session (op)" },
  ),
  op: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("claim"), Type.Literal("sync")], {
      description: "crew: status (default) shows every worktree's session, state, PR and last turn, and the directives; claim makes this session the repository's coordinator; sync claims, then opens each worktree's space, resumes its pi there if none runs, and makes each one your child",
    }),
  ),
  takeover: Type.Optional(Type.Boolean({ description: "crew claim/sync: take the coordinator role from another live session; only when the user said so" })),
  task: Type.Optional(Type.String({ description: "spawn: the complete, self-contained task" })),
  name: Type.Optional(Type.String({ description: "spawn: a short name for the child (lowercase, dashes); otherwise from the task. send/read/wait: the agent's herdr name or pane id (a child's name works too; not needed when broadcasting). interrupt/close: which child" })),
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
  await_reply: Type.Optional(Type.Boolean({ description: "send to an agent that is not your child: track its answer to this message and receive it as a message when its turn ends (also waitable with bg_wait herdr:<name>), instead of polling. Children always reply this way" })),
  names: Type.Optional(Type.Array(Type.String(), { description: "send: broadcast the message to these agents (names or pane ids) instead of `name`" })),
  cwd_prefix: Type.Optional(Type.String({ description: "send: broadcast to every agent working in this directory or below it (~ allowed on this machine); instead of `name`" })),
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
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the `typing` pane token is set (one report per burst of typing). */
  let typingOn = false;
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
    for (const t of [flushTimer, typingTimer]) if (t) clearTimeout(t);
    flushTimer = typingTimer = undefined;
    typingOn = false;
    // Held messages stay (process-wide): the next runtime in this pane delivers them.
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
  /** pi-bg's outside work for an awaited reply: `bg_wait herdr:<name>` waits on it. */
  const externalId = (rec: ChildRecord) => `herdr:${rec.name}`;
  const external = (rec: ChildRecord, state: "running" | "done" | "failed", extra: { summary?: string; result?: string } = {}) =>
    safely(() => pi.events.emit("bg:external", { id: externalId(rec), label: `${rec.peer ? "agent" : "child"} ${rec.name}`, state, ...extra }), false);
  /** Awaited replies a `bg_wait` may still consume: external id to the owed reply's key. */
  const externalKeys = new Map<string, string>();
  /** Every awaited reply ends as outside work when its session or branch does (a restore announces it again). */
  const endExternals = (summary: string) => {
    for (const rec of children.records.values()) if (rec.awaiting && !rec.closed) external(rec, "failed", { summary });
  };
  const deliver = (rec: ChildRecord, text: string, reply?: string) => {
    if (!branchCurrent()) return;
    const key = turnKey(rec, text);
    owed.set(key, { rec, text });
    // A reply is the outside work's result; a child that closed or exited has none, and its notice is delivered as a message.
    if (reply !== undefined) {
      externalKeys.set(externalId(rec), key);
      external(rec, "done", { summary: "replied", result: text });
    } else external(rec, "failed", { summary: text.split("\n")[0]?.slice(0, 120) });
    flushOwed();
  };
  // A `bg_wait` handed the reply to the model: it is not delivered again as a message.
  pi.events.on("bg:external-consumed", (e) => {
    const id = (e as { id?: unknown } | undefined)?.id;
    const key = typeof id === "string" ? externalKeys.get(id) : undefined;
    if (!key || !active) return;
    externalKeys.delete(id as string);
    const item = owed.get(key);
    if (!item || !branchCurrent()) return;
    owed.delete(key);
    delivered.add(key);
    safely(() => { pi.appendEntry(DELIVERY_ENTRY, { key }); anchorBranch(); });
    children.acknowledge(item.rec);
  });

  /** Who this session is, for messages it sends. */
  const self = async (): Promise<Sender> => {
    const me = await call<{ agent?: AgentInfo }>("agent.get", { target: target.paneId });
    let session: string | undefined;
    try { session = pi.getSessionName(); } catch { /* stale runtime */ }
    const name = me.result?.agent?.name;
    const title = (session && session !== recapName ? session : undefined) ?? promptTitle;
    return { pane: target.paneId, ...(name ? { name } : title ? { title } : {}), host: hostname().split(".")[0], cwd };
  };
  const agents = new Agents({ call, exec: run, selfPane: target.paneId, cwd: () => cwd, self });
  const crew = new Crew({ call, exec: run, selfPane: target.paneId });
  /** Whether this session's first run has checked that a coordinator it was keeps the role. */
  let crewReclaimed = false;
  /** This session as a crew sees it; `named` also asks herdr for this pane's agent name. */
  const crewMe = async (ctx: ExtensionContext, named = false): Promise<Me> => {
    let session: string | undefined;
    try { session = ctx.sessionManager.getSessionFile(); } catch { /* stale runtime */ }
    const name = named ? (await call<{ agent?: AgentInfo }>("agent.get", { target: target.paneId })).result?.agent?.name : undefined;
    return { paneId: target.paneId, ...(session ? { session } : {}), ...(name ? { name } : {}), cwd: ctx.cwd };
  };

  const draftText = () => {
    try { return lastCtx?.ui.getEditorText() ?? ""; } catch { return ""; }
  };
  const presence = new Presence();
  const inbox = new Inbox({
    isIdle: () => {
      try { return lastCtx?.isIdle(); } catch { return undefined; }
    },
    blocked: () => blockedCount,
    typing: () => presence.active(draftText()),
    deliver: (env, deliverAs) => safely(() => pi.sendMessage(
      { customType: "herdr-message", content: messageText(env), display: true, details: { id: env.id, from: env.from, delivery: env.delivery } },
      // A deferred message starts no turn: it rides along with the user's next prompt.
      deliverAs === "nextTurn" ? { deliverAs } : deliverAs ? { triggerTurn: true, deliverAs } : { triggerTurn: true },
    ), false),
    ack: (env, outcome: Outcome, reason?: Reason) => {
      if (!active) return;
      const key = ackTokenName(env.id);
      void ackPane.setToken(key, formatAck({ outcome, ...(reason ? { reason } : {}) }), ACK_TTL_MS);
      const t = setTimeout(() => { ackTimers.delete(t); void ackPane.setToken(key, undefined); }, ACK_TTL_MS);
      t.unref?.();
      ackTimers.add(t);
    },
    notify: (message, type) => { safely(() => lastCtx?.ui.notify(message, type), false); },
  }, processInboxState(), { rate: parseRate(process.env.PI_HERDR_INBOX_RATE) });
  const guard = process.env.PI_HERDR_DRAFT_GUARD === "0" ? undefined : new DraftGuard({
    getText: () => lastCtx?.ui.getEditorText() ?? "",
    setText: (text) => { lastCtx?.ui.setEditorText(text); },
    notify: (message, type) => { safely(() => lastCtx?.ui.notify(message, type), false); },
    submit: (text) => safely(() => {
      // As Enter would: start a turn when idle, steer the one that is running.
      if (lastCtx?.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: "steer" });
    }, false),
    isEnter: (data) => matchesKey(data, "enter"),
  });

  /**
   * Held messages recheck every HELD_POLL_MS while only the user's typing holds them: the editor
   * is read after the key that changed it has been handled, so a deleted draft or a submit releases
   * them within a moment. A dialog hold is released by its own event.
   */
  const scheduleFlush = () => {
    if (!active || !inbox.held.length || blockedCount > 0 || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (!active) return;
      inbox.flush();
      scheduleFlush();
    }, HELD_POLL_MS);
    flushTimer.unref?.();
  };
  /** One key the user typed (not an envelope or an injected prompt): presence, the `typing` token, held messages. */
  const onKey = (data: string) => {
    const draft = draftText();
    const typed = presence.key(data, draft, matchesKey(data, "enter"));
    if (typed) {
      if (!typingOn) {
        typingOn = true;
        void inboxPane.setToken(TYPING_TOKEN, "1", TYPING_TTL_MS);
      }
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        typingTimer = undefined;
        if (!active || !typingOn) return;
        typingOn = false;
        void inboxPane.setToken(TYPING_TOKEN, undefined);
      }, TYPING_IDLE_MS + 100);
      typingTimer.unref?.();
    }
    if (inbox.held.length) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      // After the editor has handled this key, not before.
      flushTimer = setTimeout(() => { flushTimer = undefined; if (active) { inbox.flush(); scheduleFlush(); } }, 50);
      flushTimer.unref?.();
    }
  };

  const children = new Children({
    call,
    agent: PI_CHILD,
    transport: async (rec, text, delivery, info) => {
      const sent = await agents.sendInbox(info as AgentInfo, text, delivery, { awaitsReply: true, ...(rec.machine ? { machine: rec.machine } : {}) });
      return sent && { outcome: sent.ack ?? "unconfirmed" };
    },
    callFor: (machine) => agents.endpoint(machine),
    selfPane: target.paneId,
    exec: run,
    isCurrent: branchCurrent,
    ...(dependencies.pollMs ? { pollMs: dependencies.pollMs } : {}),
    persist: (rec) => {
      if (safely(() => { pi.appendEntry(CHILD_ENTRY, rec); anchorBranch(); })) childrenActivity.observe(rec);
    },
    deliver,
    hold: (rec, on) => {
      const held = safely(() => pi.events.emit("herdr:background", on ? { active: true, label: `${rec.peer ? "agent" : "child"} ${rec.name}`, id: `child:${rec.name}` } : { active: false, id: `child:${rec.name}` }), on);
      if (on && held) external(rec, "running", { summary: rec.peer ? `awaiting ${rec.name}'s reply${rec.machine ? ` on ${rec.machine}` : ""}` : "awaiting its reply" });
      return held;
    },
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
      if (active && !blockedCount) { inbox.flush(); scheduleFlush(); }
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
    crew.seen = undefined;
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      if (e.type === "custom" && e.customType === SEEN_ENTRY && e.data && typeof e.data === "object") crew.seen = e.data as Seen;
      if (e.type === "custom" && e.customType === CHILD_ENTRY && e.data?.name) saved.set(e.data.name, e.data as ChildRecord);
      if (e.type === "custom" && e.customType === DELIVERY_ENTRY) restoreReceipt(e.data?.key);
      // The message itself is also a durable receipt if shutdown happened before its marker.
      if (e.type === "custom_message" && e.customType === "herdr-child") restoreReceipt(e.details?.turnKey);
    }
    children.restore(saved.values());
    childrenActivity.restored();
    offerChildren();
    for (const rec of children.records.values()) if (rec.pendingReply) deliver(rec, rec.pendingReply, rec.pendingReply);
  };
  // Tree navigation changes the active branch without a session_start. Invalidate every in-flight
  // child read/prompt/poll first; never carry an owed reply or a dismissal across histories.
  pi.on("session_tree", (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    childrenActivity.dispose();
    endExternals("the conversation moved to another branch");
    children.shutdown();
    generation++;
    restoreBranch(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    // Switch/fork can start a new session without shutdown. Release the old holds while live,
    // invalidate retained sections and async work, and cancel timers before replacing the context.
    const hadSource = active && lastCtx?.mode === "tui";
    childrenActivity.dispose();
    if (active) {
      endExternals("the session ended");
      children.shutdown();
    }
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
      stopInput = ctx.ui.onTerminalInput((data) => {
        const taken = inbox.input(data) ?? guard?.input(data);
        if (!taken) onKey(data);
        // A message held for the user's typing is released when they stop, with no further key.
        else if (inbox.held.length) scheduleFlush();
        return taken;
      });
      void inboxPane.setToken(INBOX_TOKEN, inboxTokenValue(process.pid), INBOX_TTL_MS);
      // Messages held when the last runtime ended (/reload, /new) go in now.
      if (inbox.held.length) {
        ctx.ui.notify(`Delivering ${inbox.held.length} held message${inbox.held.length === 1 ? "" : "s"} from other agents.`, "info");
        inbox.flush();
        scheduleFlush();
      }
    }

    restoreBranch(ctx);
    crewReclaimed = false;

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
    endExternals("the session ended");
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
  pi.on("before_agent_start", async (event, ctx) => {
    lastCtx = ctx;
    if (!promptTitle && "prompt" in event) promptTitle = titleFromPrompt(event.prompt);
    updateIdentity(ctx);
    if (!active || ctx.mode !== "tui") return undefined;
    // Crews (crew.ts): the directives and the coordinator link in every pi of the repository, and
    // the coordinator's update on each prompt the user sends it.
    const epoch = generation;
    const me = await crewMe(ctx);
    if (!crewReclaimed) {
      // A coordinator restarted in its pane, or resumed in another, keeps its crew.
      crewReclaimed = true;
      await crew.reclaim(me, async () => (await crewMe(ctx, true)).name).catch(() => false);
    }
    try {
      const section = await crew.section(me);
      if (section && epoch === generation) event.systemPromptOptions.sections[CREW_SECTION] = section;
    } catch { /* no crew this run */ }
    if (event.messageType !== "user") return undefined;
    let digest: Awaited<ReturnType<Crew["digest"]>>;
    try {
      digest = await crew.digest(me);
    } catch {
      return undefined;
    }
    if (!digest || epoch !== generation || !branchCurrent()) return undefined;
    const seen = digest.seen;
    crew.seen = seen;
    safely(() => { pi.appendEntry(SEEN_ENTRY, seen); anchorBranch(); });
    return { message: { customType: CREW_MESSAGE, content: digest.text, display: true } };
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
  // The user wrote to this agent: no sender's messages count against its rate any more.
  pi.on("input", (event) => {
    if (active && event.source === "interactive") inbox.userInput();
    return undefined;
  });
  pi.on("agent_settled", () => {
    schedulePr(5_000);
    flushOwed();
    inbox.flush();
    scheduleFlush();
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
      "Herdr: talk to any agent in herdr (on this machine, or on a saved herdr machine with `machine`) and start persistent, human-led pi sessions (children) for an explicit interactive-session request or a clear handoff to the user. Children are not for delegated work whose purpose is to report back to this session: use a headless subagent instead, even for long or multi-step tasks. action=list shows the agents. send (name, message; delivery when the agent is working) messages any agent; a pi with pi-herdr gets it through its inbox, which never touches the draft in its editor, and the result says whether it started a turn, was steered, queued, held (a dialog is open, or its user is typing) or deferred (it has had many messages from you without its user answering). With await_reply, any agent's answer to that message arrives as a message when its turn ends, like a child's; `bg_wait herdr:<name>` waits for it, alone or with others. send with `names` or `cwd_prefix` instead of `name` broadcasts to several agents at once, with one result line each. read (name) returns its last reply or its screen; wait (name) blocks until its turn ends, then reads it (prefer await_reply). spawn takes `task` (plus optional name, where, branch, model, thinking, focus): a tab shares this checkout in the existing space; a split is for side-by-side interaction; a worktree gets its own space and requires a user-requested independent branch/checkout. A child's replies arrive as messages, so do not poll or wait on it. interrupt and close act on children only. crew (op status|claim|sync) coordinates this repository's worktree sessions from this session: status shows each one's state, PR and last turn; sync opens every worktree's space, resumes its pi and makes it your child; standing rules for all of them go in the directives file it names.",
    promptSnippet: "Message, read and wait on any herdr agent; start persistent human-led pi sessions in herdr for interactive requests or user handoffs, not report-back subagents",
    promptGuidelines: [
      "Start a herdr child (herdr action=spawn) only for an explicit interactive-session request or a clear persistent, human-led handoff that the user will continue independently. Duration, complexity, the user possibly wanting to watch, and a child's ability to report back are not reasons to use one instead of a headless subagent.",
      "For an interactive handoff sharing the current checkout and branch, use where=tab in the existing Herdr space. Tabs and splits share files; do not treat them as isolated parallel editors. Use where=split only for deliberate side-by-side interaction or when requested, and preserve focus unless asked to switch.",
      "Use where=worktree for an independent branch/checkout only when the user requests a worktree or branch isolation; otherwise ask before creating one. It opens the checkout in its own Herdr space (or adds a tab there if already open). Do not create a new space or worktree merely because work is delegated, long, or parallel.",
      "Give a herdr child a complete, self-contained task: it cannot see this conversation.",
      "A herdr child's reply arrives as a message when its turn ends; end your turn instead of polling, and use herdr action=send for follow-ups.",
      "Message another agent (a child or any other, here or on a saved herdr machine) with herdr action=send, not `herdr agent prompt` in bash: a pi with pi-herdr gets it through its inbox without touching the user's draft there, and the result says whether it started a turn, was steered in, was queued, is held behind a dialog or its user's typing, or was deferred. If the target is working, choose delivery: steer for a correction to the work it is doing now; queue for new or separate work that should not derail its current turn.",
      "To hear an agent's answer, send with await_reply and end your turn: the answer arrives as a message, like a child's. To wait on one or several while you work, `bg_wait herdr:<name>` (a remote agent is `herdr:<machine>/<name>`). Use action=wait only without pi-bg, and action=read for a look at its screen. A reply from another machine or a non-pi agent is a screen read and can be cut short; when you need a long answer from one, ask it to write the answer to a file and send you the path.",
      "Do not start a back-and-forth with another agent: a message you were sent says whether your reply goes back on its own, and when it does not, answer only if it asked you to. An agent that has had many messages from you without its user answering gets the next ones deferred (the result says so): stop and tell the user instead of resending. When the result says a message is held because the user is typing or a dialog is open, do not resend it; it is delivered on its own.",
      "Use herdr action=crew only when the user wants this session to coordinate the repository's worktree sessions, or it already does: op=sync sets up or restores every worktree's space and session, op=status shows them all.",
      `Broadcast sparingly: send with \`names\` or \`cwd_prefix\` reaches up to ${MAX_BROADCAST} agents with the same message, only for something every one of them needs; a working agent in the set needs \`delivery\`, or nothing is sent.`,
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
      /** This session's live record for that name or pane id: a child, or an agent whose reply it awaits (on this machine, or `machine`). */
      const tracked = (name: string): ChildRecord | undefined => {
        const rec = children.records.get(machine ? `${machine}/${name}` : name)
          ?? [...children.records.values()].find((r) => !r.closed && r.paneId === name && r.machine === machine);
        return rec && !rec.closed ? rec : undefined;
      };
      const childOnly = (name: string) => {
        const rec = tracked(name);
        if (!rec || rec.peer) throw new Error(`action=${params.action} acts only on this session's children, and "${name}" is not one.${[...children.records.values()].some((r) => !r.peer) ? ` Children: ${[...children.records.values()].filter((r) => !r.peer).map((r) => r.name).join(", ")}.` : ""}`);
        return rec.name;
      };
      const replyTail = (rec: ChildRecord) => `Its reply arrives as a message (\`bg_wait herdr:${rec.name}\` waits on it).`;
      const NO_REPLY = "Its reply is not sent back: send with await_reply to receive it, or use action=read (or wait).";
      /** One message to a child, or to an agent whose reply is awaited, through its record. */
      const viaRecord = async (rec: ChildRecord, message: string, delivery: Delivery | undefined): Promise<string> => {
        if (!delivery) {
          const status = await children.status(rec.name);
          if (status === "working" || status === "blocked") {
            throw new Error(`${rec.name} is ${status} on a turn now, so nothing was sent. Read it (action=read) if you need to know what it is doing, then send again with delivery=steer to put the message into its current turn (a correction to that work), or delivery=queue to send it when the turn ends (new or separate work).`);
          }
        }
        const { outcome, delivered } = await children.send(rec.name, message, delivery);
        if (outcome === "queued") return `Queued for ${rec.name}: it is still working and gets the message when its current turn ends.`;
        if (delivered) return `Sent to ${rec.name} through its inbox (its draft is untouched): ${outcomeText(rec.name, delivered === "unconfirmed" ? undefined : delivered)}`;
        if (rec.peer) return `Typed into ${rec.name}'s terminal with herdr agent prompt: it has no pi-herdr inbox, so a draft in its editor would have gone in with the message.`;
        return outcome === "steered" ? `Sent to ${rec.name} mid-turn: it steers the turn it is working on.` : `Sent to ${rec.name}.`;
      };
      /** One message to one agent. Returns what happened, in words; the reply's tail is the caller's. */
      const sendOne = async (name: string, message: string, delivery: Delivery | undefined): Promise<{ what: string; awaited?: ChildRecord }> => {
        const known = tracked(name);
        if (known) return { what: await viaRecord(known, message, delivery), awaited: known };
        if (params.await_reply) {
          const info = await agents.get(name, machine);
          if (!machine && info.pane_id === target.paneId) throw new Error("That is this session's own pane.");
          const rec = children.adopt({ name: info.name ?? info.pane_id!, paneId: info.pane_id!, ...(machine ? { machine } : {}), cwd: info.cwd ?? ctx.cwd, task: message });
          try {
            return { what: await viaRecord(rec, message, delivery), awaited: rec };
          } catch (error) {
            children.discard(rec);
            throw error;
          }
        }
        const r = await agents.send(name, message, { delivery, machine });
        const label = r.info.name ?? r.info.pane_id!;
        if (r.via === "inbox") return { what: `Sent to ${label} through its inbox (its draft is untouched): ${outcomeText(label, r.outcome, r.reason)}` };
        return { what: `Typed into ${label}'s terminal with herdr agent prompt: ${r.info.agent ?? "the agent"} there has no pi-herdr inbox, so a draft in its editor would have gone in with the message.` };
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
          const message = need(params.message, "message");
          if (params.names?.length || params.cwd_prefix?.trim()) {
            if (params.name?.trim()) throw new Error("Give `name` for one agent, or `names` / `cwd_prefix` to broadcast, not both.");
            const { infos, missing } = await agents.targets({ names: params.names, cwdPrefix: params.cwd_prefix, machine });
            if (!infos.length && !missing.length) return text(`No agents${params.cwd_prefix ? ` work under ${params.cwd_prefix}` : ""} to send to.`);
            // Never steer by default: if any target is busy and no delivery was chosen, nothing goes out.
            const busy = infos.filter((i) => (i.agent_status === "working" || i.agent_status === "blocked") && !params.delivery);
            if (busy.length) throw new Error(`Nothing was sent: ${busy.map((i) => `${i.name ?? i.pane_id} is ${i.agent_status}`).join(", ")}. Send again with delivery=steer (into their current turns) or delivery=queue (after them) for all of them, or leave them out.`);
            const lines = await Promise.all(infos.map(async (info) => {
              const label = info.name ?? info.pane_id!;
              try {
                return `${label}: ${(await sendOne(info.pane_id!, message, params.delivery)).what}`;
              } catch (error) {
                return `${label}: not sent: ${error instanceof Error ? error.message : String(error)}`;
              }
            }));
            for (const m of missing) lines.push(`${m}: not sent: no such agent${machine ? ` on ${machine}` : ""}`);
            return text(`${lines.join("\n")}\n\n${params.await_reply ? "Replies arrive as messages, one per agent that took it." : NO_REPLY}`);
          }
          const { what, awaited } = await sendOne(need(params.name, "name"), message, params.delivery);
          return text(`${what} ${awaited ? replyTail(awaited) : NO_REPLY}`);
        }
        case "read": {
          const name = need(params.name, "name");
          const rec = tracked(name);
          return text(rec && !rec.peer ? await children.read(rec.name, params.lines) : await agents.read(name, { machine, lines: params.lines }));
        }
        case "wait": {
          const name = need(params.name, "name");
          const rec = tracked(name);
          if (rec) throw new Error(`${rec.name}'s reply is awaited and arrives as a message on its own. End your turn instead of waiting, \`bg_wait herdr:${rec.name}\`, or use action=read.`);
          return text(await agents.wait(name, { machine, timeoutMs: params.timeout_ms, signal }));
        }
        case "list": {
          const marks = new Map<string, string>();
          for (const r of children.records.values()) if (!r.closed && r.machine === machine) marks.set(r.paneId, r.peer ? "awaited" : `child ${r.name}`);
          const all = await agents.list({ machine, marks });
          const own = [...children.records.values()].filter((r) => !machine || r.machine === machine);
          return text(own.length ? `${all}\n\nChildren, and agents whose reply is awaited:\n${await children.list()}` : all);
        }
        case "crew": {
          if (machine) throw new Error("A crew is this machine's worktree sessions; drop `machine`.");
          const me = await crewMe(ctx, true);
          const op = params.op ?? "status";
          if (op === "status") return text(await crew.status(me, children.records));
          if (op === "claim") return text((await crew.claim(me, !!params.takeover)).text);
          return text(await syncCrew(crew, { call, exec: run, selfPane: target.paneId }, me, {
            children: children.records,
            uniqueName: (wanted) => children.uniqueName(wanted),
            attach: (opts) => children.attach(opts),
            ...(dependencies.pollMs ? { readyPollMs: dependencies.pollMs } : {}),
          }, !!params.takeover));
        }
        case "interrupt":
          return text(await children.interrupt(childOnly(need(params.name, "name"))));
        case "close": {
          const name = childOnly(need(params.name, "name"));
          const rec = children.records.get(name)!;
          const closed = await children.close(name);
          external(rec, "failed", { summary: "its pane was closed" });
          return text(closed);
        }
      }
    },
  });
}
