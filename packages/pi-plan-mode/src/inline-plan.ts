// Inline plan mode, as Claude Code does it: in your own conversation, no extra screen. While it is
// on, your agent researches read-only and writes its plan to a plan file (the only file it may
// write), then calls exit_plan_mode, which shows you the plan and asks how to implement it: here
// (optionally after compacting to the plan), save a snapshot for later, edit the plan first, or keep
// planning. With a plan model pair selected, the worker model takes over on the next request (see
// pairs.ts). The workflow returns to work after approval, without changing approvals.
// With pi-tool-gate installed, the gate owns workflow and enforces plan's read-only shell under
// either approval setting. Without it, this extension enforces a read-only shell and its configured
// shortcut toggles work/plan.
// Event bus contract (shared with pi-tool-gate; no sibling imports):
//   workflow-mode:set           any -> gate { mode: work|chat|plan } requests a base transition
//   workflow-mode:cycle         any -> gate {} requests the next base workflow
//   workflow-mode:changed       gate -> all { mode: work|chat|plan, previous?, cycle: BaseWorkflowMode[], key?, source: transition|restore }
//   workflow-mode:plan-provider plan -> gate { planFile? } announces plan support and its file
//   workflow-mode:query         any -> gate { entries: readonly unknown[], cwd: string, reply(snapshot): void }
// Query synchronously reduces the supplied destination branch with cwd defaults, without side effects.
// Restore publications are metadata snapshots, never requests to transition or persist.
//   permission-mode:set         any -> gate { mode } requests approvals only
//   permission-mode:cycle       any -> gate {} toggles auto/yolo
//   permission-mode:changed     gate -> all { mode, previous?, cycle } publishes approvals only
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { createApprovalState, pickApproval } from "./approval-picker.js";
import { editInTerminal, externalEditorCommand } from "./external-editor.js";
import { PLAN_STANDARD } from "./handoff.js";
import { remoteUi } from "./switchyard-remote.js";

export { EDIT, HERE, KEEP, OPTION_MAX, SAVE } from "./approval-picker.js";

import { holdBlocked } from "./herdr-blocked.js";
import type { EffortSource, ImplementationEffortRequest } from "./implementation-effort.js";
import type { ModelSpec, ModelSpecThinkingLevel } from "./implementation-models.js";
import { PlanMarkdown } from "./mermaid-art.js";
import { modelCatalog } from "./model-catalog.js";
import {
  newPlanFile,
  planSlug,
  plansDirectoryPath,
  planTextTitle,
  readPlan,
  savePlanSnapshot,
  writePlanFile,
} from "./plan-file.js";
import { expandHome } from "./plan-hook.js";
import { promptPlanName } from "./plan-name-input.js";
import { PlanReviewViewport } from "./plan-review-viewport.js";
import { type ReviewStatus, reviewBody, reviewTitle } from "./review-card.js";
import { type SettingCycleTrigger, settingsCycles } from "./settings-cycle.js";
import { findBlockedCommandSegment, readCommand, type SafeSubcommands } from "./tool-policy.js";
import { transcriptCheckpoint } from "./transcript-contract.js";
import { registerWorkflowRenderer, sendWorkflowTransition, type WorkflowKind } from "./workflow-ui.js";

export const MODE_CHANGED = "workflow-mode:changed";
export const MODE_SET = "workflow-mode:set";
export const MODE_CYCLE = "workflow-mode:cycle";
export const PLAN_PROVIDER = "workflow-mode:plan-provider";
export const MODE_STATUS_KEY = "workflow-mode";

/** Whether plan mode is on, its plan file, and what your agent was last told. */
export const INLINE_ENTRY = "plan-mode:inline";
/** The (hidden) messages that tell your agent it entered or left plan mode. */
export const NOTICE_TYPE = "plan-mode-notice";
export const ENTER_TOOL = "enter_plan_mode";
export const EXIT_TOOL = "exit_plan_mode";

interface InlineState {
  active: boolean;
  planFile?: string;
  /** Only drafts allocated here are promoted on approval; legacy and explicit paths stay put. */
  temporaryDraft?: boolean;
  /** Whether your agent was last told plan mode is on. */
  told: boolean;
}

export interface Approval {
  plan: string;
  planFile: string;
  edited: boolean;
  thinkingLevel?: ModelSpecThinkingLevel;
  effortSource?: EffortSource;
  /** Implemented on the offered plan model pair's worker (the session switched to the pair). */
  withPair?: true;
}

export interface InlineHost {
  safeSubcommands(): SafeSubcommands | undefined;
  /** Where plan files go (default `~/.pi/agent/plans`). */
  plansDirectory(): string | undefined;
  /** Run the plan-complete hook for an approved plan. */
  approved(plan: string, ctx: ExtensionContext): void;
  /** The model whose effort approval sets (the session model, or a plan pair's worker), with names; undefined without a session model. */
  implementationChoices(
    ctx: ExtensionContext,
    plan: Pick<Approval, "plan" | "planFile">,
  ):
    | {
        planning: ModelSpec;
        planningName: string;
        /** A sentence for the approval question, e.g. who implements and who answers its questions. */
        note?: string;
        /** A plan model pair's worker to offer as well (no pair selected, the session model plans one). */
        alternate?: { model: ModelSpec; name: string };
      }
    | undefined;
  /** Switch the session to the offered pair before implementing on its worker; false when it could not. */
  selectPair?(ctx: ExtensionContext): Promise<boolean>;
  /** A task-level default only; callers retain manual effort choices and approval freshness. */
  implementationEffort?(ctx: ExtensionContext, plan: Pick<Approval, "plan" | "planFile">): ImplementationEffortRequest;
  compactHere(approval: Approval, ctx: ExtensionContext): void;
  /** Implement it here, by the agent that planned it; returns the tool result's text. */
  implementHere(ctx: ExtensionContext, approval: Approval): string;
  /** A plan mode on/off change, for the plan model pair runtime. */
  phaseChanged?(ctx: ExtensionContext): void;
  /** The key that toggles plan mode without pi-tool-gate, for the status line. */
  toggleKey(): string | undefined;
}

export interface InlinePlanMode {
  readonly active: boolean;
  readonly planFile: string | undefined;
  /** pi-tool-gate's current workflow (work, chat or plan); undefined without the gate. */
  readonly workflow: string | undefined;
  /** Enter plan mode (through the gate when it is there). */
  enter(ctx: ExtensionContext, planFile?: string): Promise<void>;
  /** Return to ordinary work without changing approvals. */
  work(ctx: ExtensionContext): Promise<boolean>;
  /** A token invalidated by workflow/branch changes, for pending handoffs. */
  readonly revision: number;
  /** Toggle (alone) or cycle (with the gate): what the shortcut does. */
  toggle(ctx: ExtensionContext, trigger?: SettingCycleTrigger): Promise<boolean>;
}

export function enterPlanText(planFile: string, existing: boolean) {
  return `<system-reminder>
Plan mode is active. The user wants you to research and plan before anything changes. You MUST NOT make any edits (except to the plan file below), run commands that change files or the system, commit, or otherwise make changes, even if asked to; this supersedes any other instructions. Only read-only shell commands run.

## Plan file
${existing ? `A plan file from earlier planning exists at ${planFile}. Read it first, then decide: if the request is a different task, overwrite it; if it continues the same task, revise it.` : `No plan file exists yet. Create it at ${planFile} with write.`}
It is the only file you may write. Build the plan there as you go, with write and edit.

## How to plan
1. Explore: read the relevant code with read-only tools (and read-only subagents for broad searches, if you have them). Reuse what exists; find the functions and utilities a change should build on.
2. Ask: when requirements, scope or a trade-off is unclear, ask the user (with your question tool, if you have one) rather than guessing. Do not ask what the code can tell you.
3. Write the plan in the plan file to the standard under "The plan" below. Start with a concise first Markdown heading describing the actual task, not a generic "Plan" heading.
4. On revised submissions, supply ${EXIT_TOOL}'s optional changes: 1–5 concise decision/scope changes since the declined plan, not copied paragraphs. Call ${EXIT_TOOL} when the plan is complete; it shows the plan so the user can approve it, save it for later, edit it, or keep planning. Do not ask "is this plan okay?" or "should I proceed?" any other way; that is what ${EXIT_TOOL} does.

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
  savedFile?: string;
  outcome?: "pending" | "approved" | "kept" | "saved";
  /** The permission mode requested on approval (older sessions: the one picked). */
  mode?: string;
  edited?: boolean;
  /** What the user said should change (older sessions typed it in the review). */
  feedback?: string;
  /** The plan the user last declined, while a revision of it waits for review. */
  previous?: string;
  /** Concise agent-supplied decision/scope changes, only for a differing declined plan. */
  changes?: string[];
}

export function registerInlinePlanMode(pi: ExtensionAPI, host: InlineHost): InlinePlanMode {
  const settings = settingsCycles(pi);
  const workflowOwner = {};
  registerWorkflowRenderer(pi);
  let state: InlineState = { active: false, told: false };
  /** pi-tool-gate owns the mode; its current mode and cycle. */
  let gate: { mode: string; cycle: string[] } | undefined;
  let revision = 0;
  let generation = 0;
  /** An exit tool result supplies its own notice; do not queue a redundant planner turn. */
  let toolExitGeneration: number | undefined;
  let branchAnchor: string | undefined;
  /** Restored this session's state (so the gate's early broadcast does not clobber it). */
  let restored = false;
  let hostCtx: ExtensionContext | undefined;
  /** The plan the user last declined: a revision's review shows what changed since. */
  let declined: string | undefined;
  const reviewViewport = new PlanReviewViewport();
  let presentedMode: WorkflowKind | undefined;
  const effectiveMode = (): WorkflowKind => (state.active ? "plan" : "work");
  const presentTransition = () => {
    const mode = effectiveMode();
    const previous = presentedMode;
    presentedMode = mode;
    if (!gate && previous && previous !== mode && !settings.isCommitting("workflow"))
      sendWorkflowTransition(pi, previous, mode);
  };

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A stale runtime after a session switch.
    }
  };

  const plansDir = () => plansDirectoryPath(host.plansDirectory());

  const persist = () => safely(() => pi.appendEntry(INLINE_ENTRY, { ...state }));

  const announce = () =>
    safely(() => pi.events.emit(PLAN_PROVIDER, { ...(state.planFile ? { planFile: state.planFile } : {}) }));

  const updateStatus = () => {
    const ctx = hostCtx;
    if (!ctx?.hasUI || gate) return;
    const key = host.toggleKey();
    safely(() =>
      ctx.ui.setStatus(
        MODE_STATUS_KEY,
        `workflow: ${state.active ? "plan" : "work"}${key ? ` (${key} to cycle)` : ""}`,
      ),
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
      ? enterPlanText(state.planFile as string, hasPlan(state.planFile))
      : exitPlanText(state.planFile, gate?.mode);

  const allocatePlanFile = () => {
    if (state.planFile) return;
    state.planFile = newPlanFile(plansDir());
    state.temporaryDraft = true;
    safely(() => mkdirSync(dirname(state.planFile as string), { recursive: true }));
    if (state.active) persist();
    announce();
  };

  const enterLocal = (ctx: ExtensionContext | undefined) => {
    if (!settings.isCommitting("workflow")) settings.cancel("Plan entered explicitly.");
    // Restoration never allocates; a genuine entry (even into restored plan mode) may do so.
    allocatePlanFile();
    if (state.active) return;
    state.active = true;
    revision++;
    announce();
    tellNow(ctx);
    persist();
    updateStatus();
    presentTransition();
    if (ctx) safely(() => host.phaseChanged?.(ctx));
  };

  const exitLocal = (ctx: ExtensionContext | undefined, told?: boolean) => {
    if (!settings.isCommitting("workflow")) settings.cancel("Plan exited explicitly.");
    if (!state.active) return;
    state.active = false;
    revision++;
    if (told !== undefined) state.told = told;
    tellNow(ctx);
    persist();
    updateStatus();
    presentTransition();
    if (ctx) safely(() => host.phaseChanged?.(ctx));
  };

  const requestMode = async (mode: "work" | "plan"): Promise<boolean> => {
    settings.cancel("Workflow selected explicitly.");
    const request: { mode: string; result?: Promise<{ ok: boolean } | boolean | undefined> } = { mode };
    try {
      pi.events.emit(MODE_SET, request);
      if (request.result) {
        const result = await request.result;
        return typeof result === "boolean" ? result : result?.ok !== false;
      }
      // Older gate providers publish synchronously; standalone mode has no responder.
      return gate === undefined || gate.mode === mode;
    } catch (error: unknown) {
      hostCtx?.ui.notify(`Workflow transition failed: ${String(error)}`, "warning");
      return false;
    }
  };

  const requestWorkFromTool = async (): Promise<boolean> => {
    const owner = generation;
    toolExitGeneration = owner;
    try {
      return gate ? await requestMode("work") : true;
    } finally {
      if (toolExitGeneration === owner) toolExitGeneration = undefined;
    }
  };

  const enter = async (ctx: ExtensionContext, planFile?: string): Promise<boolean> => {
    settings.cancel("Plan entered explicitly.");
    // Fresh handoff recovery can precede our lifecycle handler. Be ready to persist
    // the genuine transition before asking the gate to enter plan mode.
    if (!restored) restore(ctx);
    hostCtx = ctx;
    const enteringGeneration = generation;
    if (gate && !(await requestMode("plan"))) return false;
    if (enteringGeneration !== generation || !restored) return false;
    if (planFile && planFile !== state.planFile) {
      state.planFile = planFile;
      state.temporaryDraft = false;
      persist();
      announce();
    }
    enterLocal(ctx);
    return state.active;
  };

  pi.events.on(MODE_CHANGED, (data) => {
    const event = data as { mode?: unknown; cycle?: unknown; source?: unknown } | undefined;
    if (typeof event?.mode !== "string" || !["work", "chat", "plan"].includes(event.mode)) return;
    const previous = gate?.mode;
    if (previous !== event.mode && !settings.isCommitting("workflow")) settings.cancel("Workflow changed externally.");
    gate = {
      mode: event.mode,
      cycle: Array.isArray(event.cycle) ? event.cycle.map(String) : [],
    };
    if (event.source === "restore") return;
    if (previous !== event.mode) revision++;
    // A gate loaded first may broadcast while the host is already on another branch. Do not
    // write an inline record or send a notice there before our own restoration runs.
    const branch = hostCtx?.sessionManager.getBranch();
    if (branchAnchor && !branch?.some((entry) => entry.id === branchAnchor)) restored = false;
    if (!restored) return;
    if (event.mode === "plan") enterLocal(hostCtx);
    else exitLocal(hostCtx, event.mode === "work" && toolExitGeneration === generation ? false : undefined);
    branchAnchor = hostCtx?.sessionManager.getLeafId?.() ?? undefined;
  });

  const restore = (ctx: ExtensionContext) => {
    settings.cancel("Plan state restored.");
    generation++;
    restored = false;
    revision++;
    reviewViewport.end();
    hostCtx = ctx;
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === INLINE_ENTRY)
      ?.data as Partial<InlineState> | undefined;
    state = {
      active: latest?.active === true,
      told: latest?.told === true,
      temporaryDraft: latest?.temporaryDraft === true,
      ...(typeof latest?.planFile === "string" ? { planFile: latest.planFile } : {}),
    };
    declined = lastDeclined(entries);
    // Query the destination itself, never the previous branch's cached gate mode. The
    // responder is registered at factory time, so lifecycle handler order is irrelevant.
    safely(() =>
      pi.events.emit("workflow-mode:query", {
        entries,
        cwd: ctx.cwd,
        reply: (snapshot: { mode: string; cycle?: string[] }) => {
          gate = { mode: snapshot.mode, cycle: snapshot.cycle ?? [] };
          state.active = snapshot.mode === "plan";
        },
      }),
    );
    // Announcing may elicit a gate's initial (pre-restore) broadcast. It is not a transition.
    announce();
    restored = true;
    branchAnchor = ctx.sessionManager.getLeafId?.() ?? undefined;
    updateStatus();
    presentedMode = effectiveMode();
    safely(() => host.phaseChanged?.(ctx));
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    generation++;
    reviewViewport.end();
    revision++;
    branchAnchor = undefined;
    hostCtx = undefined;
    restored = false;
    gate = undefined;
    presentedMode = undefined;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    hostCtx = ctx;
    if (restored && state.active) allocatePlanFile();
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
    // With the gate, its workflow guard lets only read-only commands run (its own analysis).
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
    executionMode: "sequential",
    exposure: "model-only",
    label: "Enter plan mode",
    description:
      "Switch to plan mode to research and design an approach, with the user's approval, before writing code. In plan mode you can only read and write a plan file; exit_plan_mode then asks the user to approve the plan.",
    promptSnippet: "Enter plan mode before a non-trivial implementation",
    promptGuidelines: ENTER_GUIDELINES,
    parameters: { type: "object", additionalProperties: false, properties: {} } as never,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      settings.cancel("Plan entry requested by tool.");
      if (state.active) return text("You are already in plan mode.");
      hostCtx = ctx;
      if (!(await enter(ctx))) return text("Plan mode is not available right now.");
      // The tool result is the notice.
      state.told = true;
      persist();
      return text(`Entered plan mode.\n\n${noticeText()}`);
    },
  });

  pi.registerTool({
    name: EXIT_TOOL,
    ...{ ccstyleOwnResult: true },
    // Nested codemode calls have no transcript row to render the plan being approved.
    exposure: "model-only",
    // The plan file is read when this runs: a write or edit to it in the same message must land
    // first, or the review shows the previous plan. One sequential call makes the batch run in order.
    executionMode: "sequential",
    label: "Exit plan mode",
    description:
      "In plan mode, once your plan is complete: show it for the user to approve implementation, save for later, edit, or keep planning. It reads the plan file; optionally provide changes on revised submissions (concise decision/scope changes since the declined plan, not copied paragraphs). Do not use it for research questions, and do not ask for approval any other way.",
    promptSnippet: "Show the plan for approval, saving, editing, or continued planning (plan mode only)",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", minLength: 1, maxLength: 240, pattern: "\\S" },
          description:
            "Concise decision/scope changes since the last declined plan, not copied paragraphs. Omit on first submission.",
        },
      },
    } as never,
    renderCall: (_args, theme, context) => reviewTitle(theme, context.isPartial ? "Plan review" : "Plan"),
    renderResult: (result, options, theme, context) => {
      const component = renderExit(result.details as ExitDetails | undefined, options, theme);
      return options.isPartial ? reviewViewport.wrap(context.toolCallId, component) : component;
    },
    async execute(id, params, signal, onUpdate, ctx) {
      settings.cancel("Plan review requested by tool.");
      const supplied = (params as { changes?: unknown } | undefined)?.changes;
      if (
        supplied !== undefined &&
        (!Array.isArray(supplied) ||
          supplied.length < 1 ||
          supplied.length > 5 ||
          !supplied.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 240))
      ) {
        return text("changes must contain 1–5 nonempty strings, each at most 240 characters.");
      }
      let changes = supplied as string[] | undefined;
      hostCtx = ctx;
      if (!state.active || !state.planFile) {
        return text("You are not in plan mode. This tool only asks the user to approve a plan in plan mode.");
      }
      let planFile = state.planFile;
      let plan = readPlan(planFile);
      if (!plan) {
        return text(
          `The plan file ${planFile} is empty or missing. Write your plan there first, then call ${EXIT_TOOL} again.`,
        );
      }
      if (!ctx.hasUI) return text("There is no user to approve the plan. Stay in plan mode.");
      const submittedPlan = plan;
      // A new review supersedes any earlier approval still waiting for idle.
      const approvalRevision = ++revision;
      const approvalGeneration = generation;
      const approvalSession = ctx.sessionManager.getSessionId?.();
      const approvalAnchor = ctx.sessionManager.getLeafId?.();
      const sameDestination = () =>
        restored &&
        generation === approvalGeneration &&
        ctx.sessionManager.getSessionId?.() === approvalSession &&
        (!approvalSession ||
          !approvalAnchor ||
          ctx.sessionManager.getBranch().some((entry) => entry.id === approvalAnchor));
      const current = () => sameDestination() && revision === approvalRevision && state.active;
      let edited = false;
      const models = host.implementationChoices(ctx, { plan, planFile });
      const pickerState = createApprovalState();
      let effortRequest: ImplementationEffortRequest | undefined;
      const catalog = modelCatalog(ctx, "available");
      const reasoning = (spec: ModelSpec | undefined) =>
        spec && catalog.efforts(spec).some((level) => level !== undefined);
      const needsEffortDefault = reasoning(
        models?.planning ?? (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined),
      );
      reviewViewport.begin(ctx, id);
      const releaseBlocked = holdBlocked(pi.events, "Review the plan");
      // The agent is waiting on the user: the Working row only takes a plan line.
      ctx.ui.setWorkingVisible?.(false);
      try {
        for (;;) {
          reviewViewport.restart();
          const baseline = declined ?? (edited ? submittedPlan : undefined);
          const previous = baseline !== undefined && baseline !== plan ? baseline : undefined;
          onUpdate?.({
            content: [{ type: "text", text: plan }],
            details: {
              plan,
              planFile,
              outcome: "pending",
              ...(previous ? { previous, ...(changes ? { changes: [...changes] } : {}) } : {}),
            } satisfies ExitDetails,
          } as never);
          const request = needsEffortDefault ? host.implementationEffort?.(ctx, { plan, planFile }) : undefined;
          if (effortRequest !== request) {
            effortRequest?.dispose();
            effortRequest = request;
          }
          const recommendations = new Map<string, ModelSpecThinkingLevel>();
          if (request && models?.planning && reasoning(models.planning)) {
            const effort = await request.pick(models.planning, signal);
            if (effort.kind === "system1")
              recommendations.set(`${models.planning.provider}/${models.planning.modelId}`, effort.thinkingLevel);
            if (!current() || readPlan(planFile) !== plan || (!signal?.aborted && !request.isCurrent()))
              return text(
                "Plan review expired because the plan, workflow, branch, model or System 1 changed. Approve the plan again.",
              );
          }
          const alternate = models?.alternate;
          if (request && alternate && reasoning(alternate.model)) {
            const effort = await request.pick(alternate.model, signal);
            if (effort.kind === "system1")
              recommendations.set(`${alternate.model.provider}/${alternate.model.modelId}`, effort.thinkingLevel);
            if (!current() || readPlan(planFile) !== plan || (!signal?.aborted && !request.isCurrent()))
              return text(
                "Plan review expired because the plan, workflow, branch, model or System 1 changed. Approve the plan again.",
              );
          }
          const picked = await pickApproval(
            ctx,
            {
              ...(models?.planning ? { planning: models.planning } : {}),
              ...(models?.note ? { note: models.note } : {}),
              ...(alternate && host.selectPair ? { alternate } : {}),
              ...(request ? { effortDefaultKey: request.key } : {}),
              recommendations,
            },
            pickerState,
            signal,
            remoteUi(pi),
          );
          if (!current() || readPlan(planFile) !== plan || (!signal?.aborted && request && !request.isCurrent()))
            return text(
              "Plan review expired because the plan, workflow, branch, model or System 1 changed. Approve the plan again.",
            );
          const choice = signal?.aborted ? undefined : picked?.choice;
          if (choice?.kind === "edit") {
            effortRequest?.dispose();
            effortRequest = undefined;
            // In your external editor when one is set (pi's externalEditor, or $VISUAL / $EDITOR),
            // else in pi's own.
            const command = picked?.remote ? undefined : externalEditorCommand(ctx.cwd);
            const revised = command
              ? await editInTerminal(ctx.ui as never, command, plan, "plan.md")
              : await ctx.ui.editor("Edit the plan", plan);
            if (!current() || (!signal?.aborted && request && !request.isCurrent()))
              return text(
                "Plan review expired because the workflow, branch, model or System 1 changed. Approve the plan again.",
              );
            if (signal?.aborted) continue;
            if (command && revised === undefined)
              ctx.ui.notify(`${command.split(" ")[0]} did not save the plan.`, "warning");
            if (revised?.trim() && revised.trim() !== plan) {
              plan = revised.trim();
              changes = undefined;
              edited = true;
              try {
                writeFileSync(planFile, `${plan}\n`);
              } catch (error: unknown) {
                ctx.ui.notify(`Could not save the plan file: ${String(error)}`, "error");
              }
            }
            continue;
          }
          if (choice?.kind === "save") {
            if (signal?.aborted || !current())
              return text("Plan review expired because the workflow or branch changed. Approve the plan again.");
            const title = planSlug(planTextTitle(plan));
            const suggestion = title === "plan" || title === "the-plan" ? "" : title;
            const restoreScrollKeys = reviewViewport.suspendScrollKeys();
            let name: string | undefined;
            try {
              name = await promptPlanName(ctx, { suggestion, directory: plansDir() }, signal, remoteUi(pi));
            } finally {
              restoreScrollKeys();
            }
            if (signal?.aborted || !current())
              return text("Plan review expired because the workflow or branch changed. Approve the plan again.");
            if (name === undefined) continue;
            let savedFile: string;
            try {
              if (signal?.aborted || !current())
                return text("Plan review expired because the workflow or branch changed. Approve the plan again.");
              savedFile = savePlanSnapshot(plansDir(), plan, name);
            } catch (error: unknown) {
              ctx.ui.notify(
                `Could not save the plan: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
              continue;
            }
            if (!(await requestWorkFromTool()))
              return text(
                `Saved the plan at ${savedFile}, but Work is unavailable. Stay in plan mode; this is not approval to implement.`,
              );
            if (!sameDestination()) return text("Plan review expired because the workflow or branch changed.");
            declined = undefined;
            state.planFile = undefined;
            state.temporaryDraft = false;
            state.told = false;
            announce();
            exitLocal(ctx, false);
            persist();
            return transcriptCheckpoint(
              {
                content: [
                  {
                    type: "text",
                    text: `Saved the plan for later at ${savedFile}. This is not approval to implement. Stop here and wait for the user's next request.`,
                  },
                ],
                details: { plan, planFile, savedFile, outcome: "saved", edited, mode: "work" } satisfies ExitDetails,
                terminate: true,
              },
              { id, kind: "plan" },
            ) as never;
          }
          if (choice === undefined || choice.kind === "keep") {
            // You say what should change in the chat, as your next message.
            const details: ExitDetails = {
              plan,
              planFile,
              outcome: "kept",
              ...(previous ? { previous, ...(changes ? { changes: [...changes] } : {}) } : {}),
            };
            declined = plan;
            return transcriptCheckpoint(
              {
                content: [
                  {
                    type: "text",
                    text: "The user declined the plan and wants to keep planning. Stop here: their next message says what should change.",
                  },
                ],
                details,
                terminate: true,
              },
              { id, kind: "plan" },
            ) as never;
          }
          if (state.temporaryDraft) {
            try {
              planFile = writePlanFile(plansDir(), plan);
            } catch (error: unknown) {
              ctx.ui.notify(`Could not save the approved plan: ${String(error)}`, "error");
              return text(
                "Could not save the approved plan. Stay in plan mode and approve it again after fixing the error.",
              );
            }
            state.planFile = planFile;
            state.temporaryDraft = false;
            persist();
            announce();
          }
          const approval: Approval = {
            plan,
            planFile,
            edited,
            thinkingLevel: picked?.thinkingLevel,
            effortSource: picked?.effortSource ?? "fallback",
            ...(choice.withPair ? { withPair: true as const } : {}),
          };
          const mode = "work";
          // Switching to the pair while still planning routes nothing yet: the pair plans on this same model.
          if (choice.withPair) {
            const switched = (await host.selectPair?.(ctx)) === true;
            if (!sameDestination()) return text("Plan review expired because the workflow or branch changed.");
            if (!switched)
              return text(
                `Could not switch to the plan model pair for ${alternate?.name ?? "its worker"}. Stay in plan mode and approve the plan again.`,
              );
          }
          if (!(await requestWorkFromTool()))
            return text("Work is unavailable. Stay in plan mode and approve the plan again.");
          if (!sameDestination()) return text("Plan review expired because the workflow or branch changed.");
          exitLocal(ctx, false);
          host.approved(plan, ctx);
          declined = undefined;
          if (choice.kind === "compact-here") {
            host.compactHere(approval, ctx);
            return transcriptCheckpoint(
              {
                content: [
                  {
                    type: "text",
                    text: "The user approved the plan. Stop here; implementation continues in this session after compaction to the approved plan.",
                  },
                ],
                details: {
                  plan,
                  planFile,
                  outcome: "approved",
                  edited,
                  ...(previous ? { previous, ...(changes ? { changes: [...changes] } : {}) } : {}),
                  mode,
                } satisfies ExitDetails,
                terminate: true,
              },
              { id, kind: "plan" },
            ) as never;
          }
          return transcriptCheckpoint(
            {
              content: [{ type: "text", text: host.implementHere(ctx, approval) }],
              details: {
                plan,
                planFile,
                outcome: "approved",
                edited,
                ...(previous ? { previous, ...(changes ? { changes: [...changes] } : {}) } : {}),
                mode,
              } satisfies ExitDetails,
            },
            { id, kind: "plan" },
          ) as never;
        }
      } finally {
        effortRequest?.dispose();
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
    get workflow() {
      return gate?.mode;
    },
    async enter(ctx, planFile) {
      await enter(ctx, planFile);
    },
    async work(ctx) {
      settings.cancel("Work selected explicitly.");
      if (!restored) restore(ctx);
      hostCtx = ctx;
      const leavingGeneration = generation;
      if (gate && !(await requestMode("work"))) return false;
      if (leavingGeneration !== generation || !restored) return false;
      exitLocal(ctx, false);
      return !state.active;
    },
    get revision() {
      return revision;
    },
    async toggle(ctx, trigger) {
      hostCtx = ctx;
      if (gate) {
        const request: {
          userInitiated: true;
          cycleTrigger?: SettingCycleTrigger;
          result?: Promise<{ ok: boolean } | boolean | undefined>;
        } = { userInitiated: true, cycleTrigger: trigger };
        try {
          pi.events.emit(MODE_CYCLE, request);
          const result = await request.result;
          return typeof result === "boolean" ? result : result?.ok !== false;
        } catch (error: unknown) {
          ctx.ui.notify(`Workflow transition failed: ${String(error)}`, "warning");
          return false;
        }
      }
      const ownerGeneration = generation;
      const session = ctx.sessionManager.getSessionId();
      const anchor = ctx.sessionManager.getLeafId?.();
      return settings.stage(
        ctx,
        {
          key: "workflow",
          owner: workflowOwner,
          read: () => (state.active ? "plan" : "work"),
          next: (value) => (value === "plan" ? "work" : "plan"),
          format: (value) => value,
          validate: () => undefined,
          apply: (value) => {
            if (value === "plan") enterLocal(ctx);
            else exitLocal(ctx);
            return true;
          },
          current: () =>
            restored &&
            generation === ownerGeneration &&
            ctx.sessionManager === hostCtx?.sessionManager &&
            session === ctx.sessionManager.getSessionId() &&
            (!anchor || ctx.sessionManager.getBranch().some((entry) => entry.id === anchor)),
        },
        trigger,
      );
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
    if (
      details?.outcome === "approved" ||
      (details?.outcome as string) === "handoff" ||
      (details?.outcome as string) === "fresh" ||
      details?.outcome === "saved"
    )
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
  const status: ReviewStatus =
    outcome === "approved" || (outcome as string) === "handoff" || (outcome as string) === "fresh"
      ? {
          tone: "success",
          text: `✓ Approved${details?.edited ? " (edited)" : ""}, implementing here${details?.mode && details.mode !== "work" ? `, ${MODE_WORDS[details.mode] ?? details.mode}` : ""}`,
        }
      : outcome === "saved"
        ? { tone: "neutral", text: "Saved for later", context: details?.savedFile }
        : outcome === "kept"
          ? {
              tone: "warning",
              text: details?.feedback ? `Kept planning: ${details.feedback}` : "Kept planning",
            }
          : { tone: "pending", text: "Waiting for approval" };
  const card = reviewBody(theme, plan, status, options, (text) => new PlanMarkdown(text, getMarkdownTheme(), theme));
  // While it waits, one more row of the card's background under the status, above the question.
  const body = new Container();
  body.addChild(card);
  if (outcome === "pending") body.addChild(new Spacer(1));
  if (outcome !== "pending" || !details?.previous || details.previous === plan) return body;
  // The full current plan remains authoritative; never guess a semantic summary from a diff.
  const container = new Container();
  if (details.changes?.length) {
    container.addChild(
      new PlanMarkdown(
        `### What changed\n\n${details.changes.map((change) => `- ${change}`).join("\n")}`,
        getMarkdownTheme(),
        theme,
      ),
    );
  } else {
    container.addChild(new Text("Plan revised since your last review.", 0, 0));
  }
  container.addChild(new Spacer(1));
  container.addChild(body);
  return container;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
