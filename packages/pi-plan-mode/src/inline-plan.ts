// Inline plan mode, as Claude Code does it: in your own conversation, no extra screen. While it is
// on, your agent researches read-only and writes its plan to a plan file (the only file it may
// write), then calls exit_plan_mode, which shows you the plan and asks who implements it: hand it
// off to a cheaper model in this session (the host compacts the context down to the plan and
// switches the model), keep the planning model on it, edit the plan first, or keep planning. The
// permission mode returns to what it was before planning. Shift+Tab (pi-tool-gate's mode cycle) or /plan enters it.
//
// With pi-tool-gate installed, the gate owns the mode (manual, accept edits, plan, auto, bypass):
// plan mode is one step of its Shift+Tab cycle, and it judges commands while planning (as Claude
// Code's classifier does). Without it, this extension enforces a read-only shell itself and its
// own shortcut (toggleShortcut) toggles plan mode. The contract is in pi-tool-gate's modes.ts:
//   permission-mode:changed        gate -> all    { mode, previous?, cycle, prePlanMode? }
//   permission-mode:set            any  -> gate   { mode }
//   permission-mode:cycle          any  -> gate   {}
//   permission-mode:plan-provider  plan -> gate   { planFile? }
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { editInTerminal, externalEditorCommand } from "./external-editor.js";
import { implementationBrief, PLAN_STANDARD } from "./handoff.js";
import { holdBlocked } from "./herdr-blocked.js";
import { type ModelSpec, sameModel } from "./implementation-models.js";
import { PlanMarkdown } from "./mermaid-art.js";
import { planDiff, renderPlanDiff } from "./plan-diff.js";
import { newPlanFile, plansDirectoryPath, readPlan, tildify } from "./plan-file.js";
import { expandHome } from "./plan-hook.js";
import { PlanReviewViewport } from "./plan-review-viewport.js";
import { type ReviewStatus, reviewBody, reviewTitle } from "./review-card.js";
import { findBlockedCommandSegment, readCommand, type SafeSubcommands } from "./tool-policy.js";

export const MODE_CHANGED = "permission-mode:changed";
export const MODE_SET = "permission-mode:set";
export const MODE_CYCLE = "permission-mode:cycle";
export const PLAN_PROVIDER = "permission-mode:plan-provider";
export const MODE_STATUS_KEY = "permission-mode";

/** Whether plan mode is on, its plan file, and what your agent was last told. */
export const INLINE_ENTRY = "plan-mode:inline";
/** The (hidden) messages that tell your agent it entered or left plan mode. */
export const NOTICE_TYPE = "plan-mode-notice";
export const ENTER_TOOL = "enter_plan_mode";
export const EXIT_TOOL = "exit_plan_mode";

interface InlineState {
  active: boolean;
  planFile?: string;
  /** Whether your agent was last told plan mode is on. */
  told: boolean;
}

export interface HandoffTarget {
  target: ModelSpec;
  targetName: string;
  planning: ModelSpec;
  planningName: string;
}

export interface Approval {
  plan: string;
  planFile: string;
  edited: boolean;
}

/** Whether a handoff changes the model or its effort (else it is only a fresh context). */
export function handsOffToAnotherModel(who: HandoffTarget): boolean {
  return (
    !sameModel(who.target, who.planning) ||
    (who.target.thinkingLevel ?? undefined) !== (who.planning.thinkingLevel ?? undefined)
  );
}

/** Every approval option must fit in this many characters (docs/clients.md): remote clients wrap rows without a gutter. */
export const OPTION_MAX = 42;
export const EDIT = "Edit the plan";
export const KEEP = "No, keep planning";
export const FRESH_CONTEXT = "Yes, in a fresh context";
export const HERE = "Yes, implement it here";

function clip(name: string, max: number) {
  return name.length <= max ? name : `${name.slice(0, Math.max(0, max - 1))}…`;
}

export function handoffLabel(name: string, effort?: string): string {
  const prefix = "Yes, hand off to ";
  if (effort) {
    const full = `${prefix}${name} (${effort})`;
    if (full.length <= OPTION_MAX) return full;
  }
  return `${prefix}${clip(name, OPTION_MAX - prefix.length)}`;
}

export function keepLabel(name: string): string {
  const prefix = "Yes, keep ";
  const suffix = " on it";
  return `${prefix}${clip(name, OPTION_MAX - prefix.length - suffix.length)}${suffix}`;
}

export interface InlineHost {
  safeSubcommands(): SafeSubcommands | undefined;
  /** Where plan files go (default `~/.pi/agent/plans`). */
  plansDirectory(): string | undefined;
  /** Run the plan-complete hook for an approved plan. */
  approved(plan: string, ctx: ExtensionContext): void;
  /** The model a handoff goes to and the planning model, with names; undefined without a session model. */
  handoffTarget(ctx: ExtensionContext): HandoffTarget | undefined;
  /** Hand the approved plan off once this turn ends (fresh context, `who.target`'s model). */
  handoff(approval: Approval, who: HandoffTarget | undefined): void;
  /** Implement it here, by the agent that planned it; returns the tool result's text. */
  implementHere(ctx: ExtensionContext, approval: Approval): string;
  /** Whether an approved plan is being implemented (exec mode). */
  executing(): boolean;
  /** The key that toggles plan mode without pi-tool-gate, for the status line. */
  toggleKey(): string | undefined;
}

export interface InlinePlanMode {
  readonly active: boolean;
  readonly planFile: string | undefined;
  /** Enter plan mode (through the gate when it is there). */
  enter(ctx: ExtensionContext): void;
  /** Toggle (alone) or cycle (with the gate): what the shortcut does. */
  toggle(ctx: ExtensionContext): void;
}

export function enterPlanText(planFile: string, existing: boolean, gate: boolean) {
  return `<system-reminder>
Plan mode is active. The user wants you to research and plan before anything changes. You MUST NOT make any edits (except to the plan file below), run commands that change files or the system, commit, or otherwise make changes, even if asked to; this supersedes any other instructions. ${gate ? "Commands are judged before they run; stick to ones that only read." : "Only read-only shell commands run."}

## Plan file
${existing ? `A plan file from earlier planning exists at ${planFile}. Read it first, then decide: if the request is a different task, overwrite it; if it continues the same task, revise it.` : `No plan file exists yet. Create it at ${planFile} with write.`}
It is the only file you may write. Build the plan there as you go, with write and edit.

## How to plan
1. Explore: read the relevant code with read-only tools (and read-only subagents for broad searches, if you have them). Reuse what exists; find the functions and utilities a change should build on.
2. Ask: when requirements, scope or a trade-off is unclear, ask the user (with your question tool, if you have one) rather than guessing. Do not ask what the code can tell you.
3. Write the plan in the plan file to the standard under "The plan" below.
4. Call ${EXIT_TOOL} when the plan is complete; it shows the plan to the user for approval. Do not ask "is this plan okay?" or "should I proceed?" any other way; that is what ${EXIT_TOOL} does.

## The plan
${PLAN_STANDARD}

End each turn by asking the user a question or by calling ${EXIT_TOOL}. After the user declines a plan, their next message is their feedback: answer it in chat, and revise the plan and call ${EXIT_TOOL} again only once the change is clear. If the user only asked a question that needs no code changes (research, an explanation), answer it and do not call ${EXIT_TOOL}.
</system-reminder>`;
}

export function exitPlanText(planFile: string | undefined, nextMode?: string) {
  // Chat mode (pi-tool-gate's) is read-only too; its own notice says what is allowed.
  const may = nextMode === "chat" ? "" : " You may now make edits, run tools, and take actions.";
  return `<system-reminder>
## Exited plan mode
You have left plan mode.${may}${planFile && existsSync(planFile) ? ` The plan file is at ${planFile} if you need it.` : ""}
</system-reminder>`;
}

export const ENTER_GUIDELINES = [
  `Call ${ENTER_TOOL} before starting a non-trivial implementation where planning first pays off: new features, changes across several files, architectural choices, several valid approaches, or unclear requirements. Do not use it for small fixes, single obvious changes, or pure research.`,
];

interface ExitDetails {
  plan?: string;
  planFile?: string;
  outcome?: "pending" | "approved" | "fresh" | "handoff" | "kept";
  /** The permission mode requested on approval (older sessions: the one picked). */
  mode?: string;
  /** The model the plan was handed off to. */
  handoff?: string;
  edited?: boolean;
  /** What the user said should change (older sessions typed it in the review). */
  feedback?: string;
  /** The plan the user last declined, while a revision of it waits for review. */
  previous?: string;
}

export function registerInlinePlanMode(pi: ExtensionAPI, host: InlineHost): InlinePlanMode {
  let state: InlineState = { active: false, told: false };
  /** pi-tool-gate owns the mode; its current mode and cycle. */
  let gate: { mode: string; cycle: string[]; prePlanMode?: string } | undefined;
  /** Restored this session's state (so the gate's early broadcast does not clobber it). */
  let restored = false;
  let hostCtx: ExtensionContext | undefined;
  /** The plan the user last declined: a revision's review shows what changed since. */
  let declined: string | undefined;
  const reviewViewport = new PlanReviewViewport();

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A stale runtime after a session switch.
    }
  };

  const plansDir = () => plansDirectoryPath(host.plansDirectory());

  /** The mode to return to after approval: the one before planning, else auto when it is in the cycle. */
  const resumeMode = () => {
    const before = gate?.prePlanMode;
    if (before && ["default", "acceptEdits", "auto", "bypassPermissions"].includes(before)) return before;
    return gate?.cycle.includes("auto") ? "auto" : "default";
  };

  const persist = () => safely(() => pi.appendEntry(INLINE_ENTRY, { ...state }));

  const announce = () =>
    safely(() => pi.events.emit(PLAN_PROVIDER, { ...(state.planFile ? { planFile: state.planFile } : {}) }));

  const updateStatus = () => {
    const ctx = hostCtx;
    if (!ctx?.hasUI || gate) return;
    const key = host.toggleKey();
    safely(() =>
      ctx.ui.setStatus(MODE_STATUS_KEY, state.active ? `⏸ plan mode on${key ? ` (${key} to cycle)` : ""}` : undefined),
    );
  };

  /** Tell your agent now when it is mid-turn; otherwise before_agent_start tells it with your next prompt. */
  const tellNow = (ctx: ExtensionContext | undefined) => {
    if (!ctx || state.told === state.active) return;
    let idle = true;
    try {
      idle = ctx.isIdle();
    } catch {
      return;
    }
    if (idle) return;
    safely(() =>
      pi.sendMessage(
        { customType: NOTICE_TYPE, content: noticeText(), display: false, details: { active: state.active } },
        { deliverAs: "steer" },
      ),
    );
    state.told = state.active;
  };

  const noticeText = () =>
    state.active
      ? enterPlanText(state.planFile as string, hasPlan(state.planFile), gate !== undefined)
      : exitPlanText(state.planFile, gate?.mode);

  const enterLocal = (ctx: ExtensionContext | undefined) => {
    if (state.active) return;
    // A plan file per session: re-entering continues it, as Claude Code does.
    state.planFile ??= newPlanFile(plansDir());
    safely(() => mkdirSync(dirname(state.planFile as string), { recursive: true }));
    state.active = true;
    announce();
    tellNow(ctx);
    persist();
    updateStatus();
  };

  const exitLocal = (ctx: ExtensionContext | undefined, told?: boolean) => {
    if (!state.active) return;
    state.active = false;
    if (told !== undefined) state.told = told;
    tellNow(ctx);
    persist();
    updateStatus();
  };

  const requestMode = (mode: string) => safely(() => pi.events.emit(MODE_SET, { mode }));

  const enter = (ctx: ExtensionContext) => {
    hostCtx = ctx;
    if (gate) {
      requestMode("plan");
      // The gate answers synchronously; if it did not take plan mode, enter on our own.
      if (!state.active) enterLocal(ctx);
    } else enterLocal(ctx);
  };

  pi.events.on(MODE_CHANGED, (data) => {
    const event = data as { mode?: unknown; cycle?: unknown; prePlanMode?: unknown } | undefined;
    if (typeof event?.mode !== "string") return;
    gate = {
      mode: event.mode,
      cycle: Array.isArray(event.cycle) ? event.cycle.map(String) : [],
      ...(typeof event.prePlanMode === "string" ? { prePlanMode: event.prePlanMode } : {}),
    };
    if (!restored) return;
    if (event.mode === "plan") enterLocal(hostCtx);
    else exitLocal(hostCtx);
  });

  pi.on("session_start", (_event, ctx) => {
    hostCtx = ctx;
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === INLINE_ENTRY)
      ?.data as Partial<InlineState> | undefined;
    state = {
      active: latest?.active === true,
      told: latest?.told === true,
      ...(typeof latest?.planFile === "string" ? { planFile: latest.planFile } : {}),
    };
    declined = lastDeclined(entries);
    restored = true;
    // The gate is the source of truth for the mode when it is there.
    if (gate) {
      if (gate.mode === "plan") {
        state.active = false;
        enterLocal(ctx);
      } else exitLocal(ctx);
    }
    announce();
    updateStatus();
  });

  pi.on("session_shutdown", () => {
    reviewViewport.end();
    hostCtx = undefined;
    restored = false;
    gate = undefined;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    hostCtx = ctx;
    if (state.told === state.active) return undefined;
    // Nothing to say on leaving if your agent never heard it was in plan mode.
    const content = noticeText();
    state.told = state.active;
    persist();
    return { message: { customType: NOTICE_TYPE, content, display: false, details: { active: state.active } } };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!state.active) return undefined;
    const tool = event.toolName;
    const input = event.input as Record<string, unknown>;
    if (tool === "edit" || tool === "write") {
      const file = resolve(ctx.cwd, expandHome(String(input.path ?? "")));
      if (state.planFile && file === resolve(state.planFile)) return undefined;
      return {
        block: true,
        reason: `Plan mode is on: nothing may be edited until the user approves a plan. The only file you may write is the plan file, ${state.planFile}.`,
      };
    }
    // With the gate, commands are its to judge (as Claude Code's classifier does while planning).
    if (gate || tool !== "bash") return undefined;
    const blocked = findBlockedCommandSegment(readCommand(input), host.safeSubcommands() ?? {}, ctx.cwd);
    if (blocked === undefined) return undefined;
    return {
      block: true,
      reason: `Plan mode is on: only read-only commands run until the user approves a plan. Blocked: ${blocked}`,
    };
  });

  pi.registerTool({
    name: ENTER_TOOL,
    exposure: "model-only",
    label: "Enter plan mode",
    description:
      "Switch to plan mode to research and design an approach, with the user's approval, before writing code. In plan mode you can only read and write a plan file; exit_plan_mode then asks the user to approve the plan.",
    promptSnippet: "Enter plan mode before a non-trivial implementation",
    promptGuidelines: ENTER_GUIDELINES,
    parameters: { type: "object", additionalProperties: false, properties: {} } as never,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (host.executing()) {
        return text(
          "You are implementing an approved plan (exec mode): follow it and call finish_plan when it is done; do not start planning again unless the user asks.",
        );
      }
      if (state.active) return text("You are already in plan mode.");
      hostCtx = ctx;
      enter(ctx);
      if (!state.active) return text("Plan mode is not available right now.");
      // The tool result is the notice.
      state.told = true;
      persist();
      return text(`Entered plan mode.\n\n${noticeText()}`);
    },
  });

  pi.registerTool({
    name: EXIT_TOOL,
    // Nested codemode calls have no transcript row to render the plan being approved.
    exposure: "model-only",
    // The plan file is read when this runs: a write or edit to it in the same message must land
    // first, or the review shows the previous plan. One sequential call makes the batch run in order.
    executionMode: "sequential",
    label: "Exit plan mode",
    description:
      "In plan mode, once your plan is written to the plan file and complete: show it to the user and ask for approval to start implementing. It takes no arguments; it reads the plan file. Do not use it for research questions, and do not ask for approval any other way.",
    promptSnippet: "Ask the user to approve the plan in the plan file (plan mode only)",
    parameters: { type: "object", additionalProperties: false, properties: {} } as never,
    renderCall: (_args, theme, context) => reviewTitle(theme, context.isPartial ? "Plan review" : "Plan"),
    renderResult: (result, options, theme, context) => {
      const component = renderExit(result.details as ExitDetails | undefined, options, theme);
      return options.isPartial ? reviewViewport.wrap(context.toolCallId, component) : component;
    },
    async execute(id, _params, signal, onUpdate, ctx) {
      hostCtx = ctx;
      if (!state.active || !state.planFile) {
        return text("You are not in plan mode. This tool only asks the user to approve a plan in plan mode.");
      }
      const planFile = state.planFile;
      let plan = readPlan(planFile);
      if (!plan) {
        return text(
          `The plan file ${planFile} is empty or missing. Write your plan there first, then call ${EXIT_TOOL} again.`,
        );
      }
      if (!ctx.hasUI) return text("There is no user to approve the plan. Stay in plan mode.");
      let edited = false;
      const who = host.handoffTarget(ctx);
      const handoffRow =
        !who || !handsOffToAnotherModel(who) ? FRESH_CONTEXT : handoffLabel(who.targetName, who.target.thinkingLevel);
      const hereRow = who ? keepLabel(who.planningName) : HERE;
      const choices = () => [handoffRow, hereRow, EDIT, KEEP];
      reviewViewport.begin(ctx, id);
      const releaseBlocked = holdBlocked(pi.events, "Review the plan");
      // The agent is waiting on the user: the Working row only takes a plan line.
      ctx.ui.setWorkingVisible?.(false);
      try {
        for (;;) {
          reviewViewport.restart();
          const previous = declined !== undefined && declined !== plan ? declined : undefined;
          onUpdate?.({
            content: [{ type: "text", text: plan }],
            details: { plan, planFile, outcome: "pending", ...(previous ? { previous } : {}) } satisfies ExitDetails,
          } as never);
          const choice = await ctx.ui.select(`Implement this plan? ${tildify(planFile)}`, choices(), { signal });
          if (choice === EDIT) {
            // In your external editor when one is set (pi's externalEditor, or $VISUAL / $EDITOR),
            // else in pi's own.
            const command = externalEditorCommand(ctx.cwd);
            const revised = command
              ? await editInTerminal(ctx.ui as never, command, plan, "plan.md")
              : await ctx.ui.editor("Edit the plan", plan);
            if (command && revised === undefined)
              ctx.ui.notify(`${command.split(" ")[0]} did not save the plan.`, "warning");
            if (revised?.trim() && revised.trim() !== plan) {
              plan = revised.trim();
              edited = true;
              try {
                writeFileSync(planFile, `${plan}\n`);
              } catch (error: unknown) {
                ctx.ui.notify(`Could not save the plan file: ${String(error)}`, "error");
              }
            }
            continue;
          }
          if (choice === undefined || choice === KEEP) {
            // You say what should change in the chat, as your next message.
            const details: ExitDetails = { plan, planFile, outcome: "kept" };
            declined = plan;
            return {
              content: [
                {
                  type: "text",
                  text: "The user declined the plan and wants to keep planning. Stop here: their next message says what should change.",
                },
              ],
              details,
              terminate: true,
            } as never;
          }
          const approval: Approval = { plan, planFile, edited };
          host.approved(plan, ctx);
          declined = undefined;
          // This result tells your agent it left plan mode.
          exitLocal(ctx, false);
          const mode = gate ? resumeMode() : undefined;
          if (mode) requestMode(mode);
          if (choice === handoffRow) {
            host.handoff(approval, who);
            return {
              content: [
                {
                  type: "text",
                  text: `The user approved the plan and handed it off to ${who?.targetName ?? "a fresh context"}, which implements it in this session from the plan alone${who ? "; you stay on call to answer its questions" : ""}. Stop here and do nothing else.`,
                },
              ],
              details: {
                plan,
                planFile,
                outcome: "handoff",
                edited,
                ...(who ? { handoff: who.targetName } : {}),
                ...(mode ? { mode } : {}),
              } satisfies ExitDetails,
              terminate: true,
            } as never;
          }
          return {
            content: [{ type: "text", text: host.implementHere(ctx, approval) }],
            details: { plan, planFile, outcome: "approved", edited, ...(mode ? { mode } : {}) } satisfies ExitDetails,
          } as never;
        }
      } finally {
        releaseBlocked();
        ctx.ui.setWorkingVisible?.(true);
        reviewViewport.end();
      }
    },
  });

  return {
    get active() {
      return state.active;
    },
    get planFile() {
      return state.planFile;
    },
    enter,
    toggle(ctx) {
      hostCtx = ctx;
      if (gate) safely(() => pi.events.emit(MODE_CYCLE, {}));
      else if (state.active) exitLocal(ctx);
      else enterLocal(ctx);
    },
  };
}

/** The plan last declined on this branch, unless a later review approved one. */
function lastDeclined(entries: readonly unknown[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    const message = (entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } })
      .message;
    if (message?.role !== "toolResult" || message.toolName !== EXIT_TOOL) continue;
    const details = message.details as ExitDetails | undefined;
    if (details?.outcome === "kept") return details.plan;
    if (details?.outcome === "approved" || details?.outcome === "handoff" || details?.outcome === "fresh")
      return undefined;
  }
  return undefined;
}

function hasPlan(file: string | undefined) {
  return Boolean(file && readPlan(file));
}

const MODE_WORDS: Record<string, string> = {
  auto: "auto mode",
  bypassPermissions: "yolo mode",
  acceptEdits: "accepting edits",
  default: "approving edits manually",
};

function renderExit(
  details: ExitDetails | undefined,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  const plan = details?.plan;
  if (!plan) return new Container();
  const outcome = details?.outcome ?? "pending";
  const context = details?.planFile ? tildify(details.planFile) : undefined;
  const status: ReviewStatus =
    outcome === "approved" || outcome === "handoff"
      ? {
          tone: "success",
          text: `✓ Approved${details?.edited ? " (edited)" : ""}${
            outcome === "handoff"
              ? `, handed off${details?.handoff ? ` to ${details.handoff}` : ""}`
              : ", implementing here"
          }${details?.mode ? `, ${MODE_WORDS[details.mode] ?? details.mode}` : ""}`,
          context,
        }
      : outcome === "fresh"
        ? { tone: "success", text: "✓ Approved, implementing in a fresh session", context }
        : outcome === "kept"
          ? {
              tone: "warning",
              text: details?.feedback ? `Kept planning: ${details.feedback}` : "Kept planning",
              context,
            }
          : { tone: "pending", text: "Waiting for approval", context };
  const body = reviewBody(theme, plan, status, options, (text) => new PlanMarkdown(text, getMarkdownTheme(), theme));
  const changes = outcome === "pending" && details?.previous ? planDiff(details.previous, plan) : [];
  if (changes.length === 0) return body;
  // While a revision waits for review, what changed since the declined plan comes first.
  const container = new Container();
  container.addChild(new Text(theme.fg("muted", "Changes since the plan you declined:"), 0, 0));
  container.addChild(new Text(renderPlanDiff(theme, changes), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(body);
  return container;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
