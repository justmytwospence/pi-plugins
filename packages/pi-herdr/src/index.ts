// pi-herdr: pi's own herdr integration, beside the one herdr installs (which reports state and the
// session for resume). Only a TUI session inside herdr does anything; outside herdr nothing is
// registered, and RPC/print sessions (subagents, which inherit the parent's HERDR_PANE_ID) drop
// the tool and report nothing.
//
// - `bg` pane token: background work that will wake the agent (activity.ts).
// - The pane's title (session name or first prompt; also the token `task`) and displayed agent
//   name (`pi opus-5-5:xhigh`) (identity.ts).
// - The event-bus bridge other extensions use instead of talking to herdr (bridge.ts).
// - `herdr_child`: interactive pi children in a tab, a split or a new worktree (children.ts).
//   They are also a source for the suite's activity views (children-activity.ts): rows in pi-bg's
//   /tasks, a pill in pi-subagents' list, read-only.
// - `pr` space token: the branch's pull request (pr.ts).
//
// Lifecycle: children are restored from the session's current branch (an abandoned branch's
// children are not this conversation's), their replies are delivered only while pi is idle (a
// follow-up queued mid-turn is dropped when the user presses Esc), each awaited turn's reply once,
// and nothing calls pi after session_shutdown (a stale runtime throws).
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION } from "./activity.ts";
import { ACTIVITY_CHANNELS, Activity, type HoldEvent } from "./core/activity.ts";
import { Bridge, type NotifyEvent, type SplitEvent, type TokenEvent } from "./bridge.ts";
import { ChildrenActivity } from "./children-activity.ts";
import { type ChildRecord, Children, type Exec, type Where } from "./core/children.ts";
import { type Call, herdrTarget, socketCall } from "./core/herdr.ts";
import { displayAgent, firstUserText, titleFromPrompt } from "./identity.ts";
import { PR_FIELDS, parsePrView, prToken } from "./core/pr.ts";
import { PaneReporter, WorkspaceReporter } from "./core/report.ts";
import { PI_CHILD } from "./session.ts";

const TOOL = "herdr_child";
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
    [Type.Literal("spawn"), Type.Literal("send"), Type.Literal("read"), Type.Literal("list"), Type.Literal("interrupt"), Type.Literal("close")],
    { description: "spawn a child; send it a message; read its last reply or screen; list children; interrupt its turn (Escape); close its pane" },
  ),
  task: Type.Optional(Type.String({ description: "spawn: the complete, self-contained task" })),
  name: Type.Optional(Type.String({ description: "spawn: a short name (lowercase, dashes); otherwise from the task. send/read/interrupt/close: which child" })),
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
  lines: Type.Optional(Type.Number({ description: "read: screen lines while it works (default 80)" })),
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
  const bridge = new Bridge(call, pane);
  const activity = new Activity();
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

  const updateBg = () => {
    if (active) void pane.setToken("bg", activity.token(), BG_TTL_MS);
  };

  const updateIdentity = (ctx?: ExtensionContext) => {
    if (!active) return;
    const c = ctx ?? lastCtx;
    if (!promptTitle && c) promptTitle = titleFromPrompt(firstUserText(c.sessionManager.getEntries() as any));
    const title = pi.getSessionName() ?? promptTitle;
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

  const children = new Children({
    call,
    agent: PI_CHILD,
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
    updateIdentity(ctx);

    restoreBranch(ctx);

    refreshTimer = setInterval(() => {
      void pane.refresh();
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
    await bridge.reset();
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
    if (!promptTitle) promptTitle = titleFromPrompt(event.prompt);
    updateIdentity(ctx);
  });
  pi.on("agent_settled", () => {
    schedulePr(5_000);
    flushOwed();
  });

  pi.registerTool({
    name: TOOL,
    label: "Herdr child",
    description:
      "Start and talk to persistent, human-led pi sessions in herdr, for an explicit interactive-session request or a clear handoff to the user. Not for delegated work whose purpose is to report back to this session: use a headless subagent instead, even for long or multi-step tasks. A tab shares this checkout in the existing space; a split is for side-by-side interaction; a worktree gets its own space and requires a user-requested independent branch/checkout. action=spawn takes `task` (plus optional name, where, branch, model, thinking, focus); replies arrive as messages, so do not poll. action=send (name, message), read (name), list, interrupt (name), close (name).",
    promptSnippet: "Start persistent human-led pi sessions in herdr for interactive requests or user handoffs, not report-back subagents",
    promptGuidelines: [
      "Default to a headless subagent for delegated work that reports back to this session, even when long, multi-step, or parallel. Duration, complexity, and the possibility the user might want to watch are not reasons to create a Herdr pane.",
      "Use herdr_child only for an explicit interactive-session request or a clear persistent, human-led handoff that the user will continue independently. A child's ability to report back does not make it a substitute for a headless subagent.",
      "For an interactive handoff sharing the current checkout and branch, use where=tab in the existing Herdr space. Tabs and splits share files; do not treat them as isolated parallel editors. Use where=split only for deliberate side-by-side interaction or when requested, and preserve focus unless asked to switch.",
      "Use where=worktree for an independent branch/checkout only when the user requests a worktree or branch isolation; otherwise ask before creating one. It opens the checkout in its own Herdr space (or adds a tab there if already open). Do not create a new space or worktree merely because work is delegated, long, or parallel.",
      "Give a herdr child a complete, self-contained task: it cannot see this conversation.",
      "A herdr child's reply arrives as a message when its turn ends; end your turn instead of polling, and use action=send for follow-ups.",
    ],
    parameters: Params,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!branchCurrent()) throw new Error("herdr_child needs a current interactive pi session inside herdr.");
      if (!branchAnchor) anchorBranch();
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
      const need = (v: string | undefined, what: string) => {
        if (!v?.trim()) throw new Error(`action=${params.action} needs \`${what}\`.`);
        return v.trim();
      };
      switch (params.action) {
        case "spawn": {
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
          const rec = await children.send(need(params.name, "name"), need(params.message, "message"));
          return text(`Sent to ${rec.name}. Its reply arrives as a message.`);
        }
        case "read":
          return text(await children.read(need(params.name, "name"), params.lines));
        case "list":
          return text(await children.list());
        case "interrupt":
          return text(await children.interrupt(need(params.name, "name")));
        case "close":
          return text(await children.close(need(params.name, "name")));
      }
    },
  });
}
