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
// - `pr` space token: the branch's pull request (pr.ts).
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ACTIVITY_CHANNELS, Activity, type HoldEvent } from "./core/activity.ts";
import { Bridge, type NotifyEvent, type SplitEvent, type TokenEvent } from "./bridge.ts";
import { type ChildRecord, Children, type Exec, type Where } from "./core/children.ts";
import { herdrTarget, socketCall } from "./core/herdr.ts";
import { displayAgent, firstUserText, titleFromPrompt } from "./identity.ts";
import { PR_FIELDS, parsePrView, prToken } from "./core/pr.ts";
import { PaneReporter, WorkspaceReporter } from "./core/report.ts";
import { PI_CHILD } from "./session.ts";

const TOOL = "herdr_child";
const CHILD_ENTRY = "pi-herdr:child";
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
      description: "spawn: a new tab in this space (default), a split beside this pane, or a new worktree's own space (needs branch)",
    }),
  ),
  branch: Type.Optional(Type.String({ description: "spawn with where=worktree: the branch (checked out, tracked or created from HEAD)" })),
  model: Type.Optional(Type.String({ description: "spawn: provider/model; default this session's" })),
  thinking: Type.Optional(Type.String({ description: "spawn: off|minimal|low|medium|high|xhigh|max; default this session's" })),
  focus: Type.Optional(Type.Boolean({ description: "spawn: switch to the child's pane (default false)" })),
  message: Type.Optional(Type.String({ description: "send: the message" })),
  lines: Type.Optional(Type.Number({ description: "read: screen lines while it works (default 80)" })),
});

export default function piHerdr(pi: ExtensionAPI) {
  const target = herdrTarget();
  if (!target) return;
  const call = socketCall(target.socketPath);
  const pane = new PaneReporter(call, target.paneId);
  const bridge = new Bridge(call, pane);
  const activity = new Activity();
  /** Tokens other extensions set before the session started. */
  const pendingTokens = new Map<string, TokenEvent>();

  let active = false;
  let workspace: WorkspaceReporter | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let prTimer: ReturnType<typeof setInterval> | undefined;
  let prSoon: ReturnType<typeof setTimeout> | undefined;
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
    if (!active || !prEnabled) return;
    if (!workspace) {
      const self = await call("pane.get", { pane_id: target.paneId });
      const id: string | undefined = self.result?.pane?.workspace_id;
      if (!id) return;
      workspace = new WorkspaceReporter(call, id);
    }
    const r = await exec("gh", ["pr", "view", "--json", PR_FIELDS], cwd);
    if (r.code === 127) {
      prEnabled = false;
      return;
    }
    if (r.code === 0) return void workspace.setToken("pr", prToken(parsePrView(r.stdout)), PR_TTL_MS);
    // No PR for this branch (or not a GitHub repo): clear. Other failures (network) keep the last.
    if (/no pull requests found|not a git repository|no git remotes|none of the git remotes/iu.test(r.stderr)) void workspace.setToken("pr", undefined);
  };

  const schedulePr = (ms: number) => {
    if (!prEnabled) return;
    if (prSoon) clearTimeout(prSoon);
    prSoon = setTimeout(() => void refreshPr(), ms);
    prSoon.unref?.();
  };

  const children = new Children({
    call,
    agent: PI_CHILD,
    selfPane: target.paneId,
    exec,
    persist: (rec) => pi.appendEntry(CHILD_ENTRY, rec),
    deliver: (rec, text) =>
      pi.sendMessage({ customType: "herdr-child", content: text, display: true, details: { name: rec.name, paneId: rec.paneId } }, { triggerTurn: true, deliverAs: "followUp" }),
    hold: (rec, on) => pi.events.emit("herdr:background", on ? { active: true, label: `child ${rec.name}`, id: `child:${rec.name}` } : { active: false, id: `child:${rec.name}` }),
  });

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

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") {
      // A subagent or print run: no pane of its own.
      const tools = pi.getActiveTools();
      if (tools.includes(TOOL)) pi.setActiveTools(tools.filter((t) => t !== TOOL));
      return;
    }
    active = true;
    lastCtx = ctx;
    cwd = ctx.cwd;
    modelId = ctx.model?.id;
    thinking = pi.getThinkingLevel();
    promptTitle = undefined;
    for (const t of pendingTokens.values()) void bridge.token(t);
    pendingTokens.clear();
    updateBg();
    updateIdentity(ctx);

    const saved = new Map<string, ChildRecord>();
    for (const e of ctx.sessionManager.getEntries() as any[]) {
      if (e.type === "custom" && e.customType === CHILD_ENTRY && e.data?.name) saved.set(e.data.name, e.data as ChildRecord);
    }
    children.records.clear();
    children.restore(saved.values());

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
    active = false;
    children.shutdown();
    for (const t of [refreshTimer, prTimer]) if (t) clearInterval(t);
    if (prSoon) clearTimeout(prSoon);
    refreshTimer = prTimer = prSoon = undefined;
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
  pi.on("agent_settled", () => schedulePr(5_000));

  pi.registerTool({
    name: TOOL,
    label: "Herdr child",
    description:
      "Start and talk to herdr children: interactive pi sessions in their own herdr pane (a new tab, a split beside this pane, or a new git worktree's space) that the user can watch, type to and take over, and that outlive this turn. action=spawn takes `task` (plus optional name, where, branch, model, thinking, focus); the child's reply to each message arrives as a message, so do not poll. action=send (name, message), read (name), list, interrupt (name), close (name).",
    promptSnippet: "Start interactive pi children in herdr panes or worktrees and exchange messages with them",
    promptGuidelines: [
      "Use a subagent for a bounded task that only needs to return a result. Use herdr_child when the work is long or open-ended, belongs on its own branch (where=worktree), or the user may want to watch, steer or take it over.",
      "Give a herdr child a complete, self-contained task: it cannot see this conversation.",
      "A herdr child's reply arrives as a message when its turn ends; end your turn instead of polling, and use action=send for follow-ups.",
    ],
    parameters: Params,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!active) throw new Error("herdr_child needs an interactive pi session inside herdr.");
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
