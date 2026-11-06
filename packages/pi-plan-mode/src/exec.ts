// Exec mode: a mode of your main chat while an approved plan is being implemented. The footer shows
// its phase/count/cost detail in status `plan-exec`; workflow-mode:exec publishes the lifecycle
// independently of approvals. The planner can stay on call through ask_planner, edits to files
// the plan does not list get a note once, and finish_plan ends it with a structured completion report
// and bounded planner acceptance. Pauses keep the implementation context and require explicit user
// recovery. It is entered only by approving a plan (plan.ts calls begin).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { setToolsActive } from "./active-tools.js";
import {
  ASK_DETAILS_KEY,
  type AskQuestion,
  askUser,
  PLANNER_QUESTION_LABEL,
  toAskQuestions,
  toPlannerAnswers,
} from "./exec-ask.js";
import {
  type AskDetails,
  assessmentSummary,
  type ChangeSummary,
  changeSummaryText,
  decisionText,
  ExecCardRefresh,
  type FinishDetails,
  finishContext,
  finishTitle,
  finishTone,
  negotiationText,
  renderAsk,
  renderFinish,
  responsesText,
} from "./exec-cards.js";
import { pausePresentation, pauseQuestion, stalledQuestion, statusQuestion } from "./exec-interaction.js";
import { discoverFamily } from "./family-contract.js";
import { type FlowState, queryFlow } from "./flow-contract.js";
import { FOOTER_ACTIONS_CHANNEL, type FooterActionsRequest } from "./footer-actions.js";
import { holdBlocked } from "./herdr-blocked.js";
import { type ModelSpec, parseModelSpec } from "./implementation-models.js";
import {
  createNegotiation,
  type FindingResponse,
  finishReview,
  type NegotiationState,
  outstanding,
  parseReviewDecision,
  type ReviewDecision,
  recoverNegotiation,
  restoreNegotiation,
  startReview,
  validateResponses,
} from "./negotiation.js";
import { planDiff, planDiffText } from "./plan-diff.js";
import { inPlan, isPlanFile, planPaths, planTitle, readPlan, tildify } from "./plan-file.js";
import { expandHome } from "./plan-hook.js";
import { type PendingQuestions, type PlannerAccessConfig, PlannerAgent } from "./planner/agent.js";
import {
  CONSULT_POSTPONED,
  CONSULT_WRAP_UP,
  consultMessage,
  postponedAnswerMessage,
  REVIEW_POSTPONED,
  reviewRequest,
  userDiscussionMessage,
} from "./planner/prompt.js";
import { type PlannerSessionFactory, plannerSessionDir } from "./planner/session.js";
import { formatCost } from "./planners.js";
import {
  normalizePlanModeQuestionParams,
  type PlanModeQuestion,
  type PlanModeQuestionAnswer,
} from "./question-tool.js";
import { reviewCard, reviewTitle } from "./review-card.js";
import { emptyUsage, type Usage } from "./scout-process.js";
import { transcriptCheckpoint } from "./transcript-contract.js";

export type { FinishDetails } from "./exec-cards.js";

export const EXEC_ENTRY = "plan-mode:exec";
export const EXEC_STATUS_KEY = "plan-exec";
export const ASK_TOOL = "ask_planner";
export const BACK_COMMAND = "plan-back";
export const FINISH_MESSAGE_TYPE = "plan-mode-finish";
export const FINISH_TOOL = "finish_plan";
export const CONTINUE_TOOL = "continue_plan";
export const EXEC_STATUS_MESSAGE_TYPE = "plan-mode-exec-status";
export const PLANNER_ANSWER_MESSAGE_TYPE = "plan-mode-planner-answer";
export const EXEC_CONTINUE_MESSAGE_TYPE = "plan-mode-exec-continue";
export const EXEC_TOOLS = [FINISH_TOOL, ASK_TOOL, CONTINUE_TOOL] as const;
/** Per question to the planner on call. */
export const CONSULT_TIMEOUT_MS = 10 * 60_000;

export interface ExecState {
  active: boolean;
  planFile: string;
  /** e.g. "Claude Sonnet 5.5" */
  implementer: string;
  /** `provider/id` the handoff switched to; "" when unknown */
  implementerModel: string;
  planner?: { spec: string; name: string; sessionFile: string };
  /** Model spec to restore when finish_plan ends exec mode. */
  restore?: string;
  /** Display name of the original main model, distinct from the consultant. */
  restoreName?: string;
  /** Legacy return leaf, retained only for parsing older active states. */
  returnTo?: string;
  asks: number;
  costUsd: number;
  negotiation?: NegotiationState;
  /** Detached provider assignments and selection revision captured at approval. Absent on legacy executions. */
  linkedFlow?: FlowState;
  /** Authorized completion retained until the Linked Work-model transition commits. */
  pendingCompletion?: FinishDetails;
  touched?: string[];
  /** A planner question the user put off; answering it resumes the implementer. */
  pendingQuestion?: { id: string; questions: PlanModeQuestion[]; implementerMessage: string; plannerNote?: string };
  pendingReturn?: { leaf: string; details: FinishDetails };
  completion?: FinishDetails;
}

export interface ExecHost {
  /** What the planner on call on `spec` may use (planner/access.ts consultantAccess). */
  consultantAccess(ctx: ExtensionContext, planFile: string, spec: ModelSpec): PlannerAccessConfig;
  createSession?: PlannerSessionFactory;
  restoreModel(ctx: ExtensionContext, spec: ModelSpec): Promise<unknown>;
  /** Call commitEnd synchronously only after Work activation and coordinator fencing succeed. */
  finishLinked?(ctx: ExtensionContext, completion: FinishDetails, commitEnd: () => void): Promise<boolean>;
  completionReview(): boolean;
  completionMaxRevisions(): number;
}

export interface ExecController {
  readonly active: boolean;
  readonly state: ExecState | undefined;
  begin(ctx: ExtensionContext, state: ExecState, options: { record: boolean }): void;
  /** The execution menu: whatever needs the user now, else status. "stopped" when exec ended. */
  menu(ctx: ExtensionContext): Promise<"stopped" | "kept">;
}

const NOT_ACTIVE = "No approved plan is being implemented.";
const WORK_MODEL_UNAVAILABLE = "Work model unavailable. Retry completion or use /flow independent.";

function finalResult<T extends { details?: object }>(result: T, id: string) {
  return transcriptCheckpoint(result, { id, kind: "report" });
}

function finishDelivery(details: FinishDetails) {
  return transcriptCheckpoint(
    { customType: FINISH_MESSAGE_TYPE, content: finishMessageText(details), details, display: true },
    { id: randomUUID(), kind: "report" },
  );
}

export function registerExec(pi: ExtensionAPI, host: ExecHost): ExecController {
  let state: ExecState | undefined;
  let epoch = 0;
  let busy = false;
  let shownThisRun = false;
  let implementationDriven = false;
  let stopRequested = false;
  let plannerUnavailable = false;
  let questionHandler: ((pending: PendingQuestions) => void) | undefined;
  let questionsOpen = 0;
  const dialogs = new Set<AbortController>();
  const cancelDialogs = () => {
    for (const controller of dialogs) controller.abort();
    dialogs.clear();
  };
  const cards = new ExecCardRefresh();
  const currentExchange = () => {
    const n = state?.active ? state.negotiation : undefined;
    const last = n?.history.at(-1);
    return n
      ? {
          executionId: n.executionId,
          exchangeId: n.latestExchangeId,
          phase: n.phase,
          unresolvedReviewId: last?.decision && last.decision.outcome !== "accepted" ? last.id : undefined,
        }
      : undefined;
  };
  let pendingReturn: { leaf: string; details: FinishDetails } | undefined;
  const live = (current: ExecState, token: number) => state === current && epoch === token;
  let agent: PlannerAgent | undefined;
  let agentPurpose: "consult" | "review" | undefined;
  const noted = new Set<string>();
  /** Files the agent edited or wrote with its tools while this mode was on. */
  const touched = new Set<string>();
  let hostCtx: ExtensionContext | undefined;
  let finalizing: { current: ExecState; token: number } | undefined;

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A stale runtime after a session switch.
    }
  };

  const updateStatus = (ctx: ExtensionContext | undefined = hostCtx) => {
    cards.refresh();
    if (!ctx?.hasUI) return;
    let text: string | undefined;
    if (state?.active) {
      const n = state.negotiation;
      const phase = state.pendingCompletion
        ? "completion pending"
        : state.pendingQuestion || questionsOpen > 0
          ? "planner asks you"
          : n?.phase === "reviewing"
            ? `review ${n.attempts}`
            : n?.phase === "consulting"
              ? "asking planner"
              : n?.phase === "revising" && busy
                ? `revising · ${outstanding(n).length} findings`
                : n?.phase === "paused"
                  ? n.pause?.reason === "user_needed"
                    ? "needs your answer"
                    : n.pause?.reason === "exhausted"
                      ? "needs your decision"
                      : "review failed"
                  : busy
                    ? "implementing"
                    : "idle";
      text = `exec mode on · ${phase} · ${state.asks} consultations · ${formatCost(state.costUsd)} consult · ${formatCost(n?.reviewCostUsd ?? 0)} review`;
    }
    safely(() => ctx.ui.setStatus(EXEC_STATUS_KEY, text));
  };

  const disposeAgent = () => {
    agent?.dispose();
    agent = undefined;
    agentPurpose = undefined;
  };

  const setTools = () => {
    setToolsActive(pi, [FINISH_TOOL, CONTINUE_TOOL], Boolean(state?.active));
    setToolsActive(pi, [ASK_TOOL], Boolean(state?.active && state.planner));
  };

  const persist = () => {
    if (state) {
      state.touched = [...touched];
      const snapshot = structuredClone(state);
      safely(() => pi.appendEntry(EXEC_ENTRY, snapshot));
    }
  };

  const publishActive = (source: "transition" | "restore" = "transition") => {
    safely(() => pi.events.emit("workflow-mode:exec", { active: state?.active === true, source }));
  };

  const begin = (ctx: ExtensionContext, next: ExecState, options: { record: boolean }) => {
    const linkedFlow = next.linkedFlow === undefined ? undefined : parseLinkedFlow(next.linkedFlow);
    if (next.linkedFlow !== undefined && !linkedFlow) throw new Error("Invalid linked execution flow.");
    epoch++;
    cancelDialogs();
    busy = !ctx.isIdle();
    shownThisRun = false;
    implementationDriven = true;
    stopRequested = false;
    plannerUnavailable = false;
    cards.begin(ctx);
    pendingReturn = undefined;
    hostCtx = ctx;
    disposeAgent();
    noted.clear();
    touched.clear();
    for (const file of next.touched ?? []) touched.add(file);
    // record:false handoffs persist this same input in the host's compaction transaction.
    // Seed it before cloning so that the very first durable entry snapshots the budget/identity.
    next.negotiation = createNegotiation(randomUUID(), host.completionMaxRevisions?.() ?? 2);
    next.touched = [...touched];
    state = structuredClone(next);
    if (linkedFlow) state.linkedFlow = linkedFlow;
    if (options.record) persist();
    setTools();
    updateStatus(ctx);
    publishActive();
  };

  const end = (ctx: ExtensionContext) => {
    if (!state) return;
    state.active = false;
    cancelDialogs();
    cards.end();
    persist();
    disposeAgent();
    noted.clear();
    setToolsActive(pi, EXEC_TOOLS, false);
    updateStatus(ctx);
    publishActive();
  };

  const finalize = async (
    current: ExecState,
    token: number,
    details: FinishDetails,
    ctx: ExtensionContext,
    usage?: Usage,
    signal?: AbortSignal,
    toolCallId?: string,
  ) => {
    const manager = ctx.sessionManager;
    const sessionId = manager.getSessionId?.();
    const currentSession = () =>
      live(current, token) && hostCtx?.sessionManager === manager && manager.getSessionId?.() === sessionId;
    if (!currentSession() || !current.active) return text("Execution changed; finalization discarded.");
    if (finalizing?.current === current && finalizing.token === token)
      return pausedResult("Completion transition is already in progress.");
    const operation = { current, token };
    finalizing = operation;
    // Missing coordinator is not permission to restore the planning model. Only an explicit
    // current Independent snapshot releases the historical Linked completion policy.
    let linked = Boolean(current.linkedFlow);
    let coordinatorPresent = false;
    if (linked) {
      try {
        const flow = queryFlow(pi.events);
        coordinatorPresent = flow?.operatingMode === "linked";
        if (flow?.operatingMode === "independent") linked = false;
      } catch {
        // Preserve the Linked lock if optional discovery fails.
      }
    }
    let committed = false;
    let commitOpen = true;
    const commitEnd = () => {
      if (!commitOpen || committed || !currentSession() || !current.active) return;
      if (linked && (signal?.aborted || ctx.signal?.aborted)) return;
      committed = true;
      current.returnTo = undefined;
      current.pendingReturn = undefined;
      current.pendingCompletion = undefined;
      pendingReturn = undefined;
      // Restore the pre-handoff negotiation, not the temporary Work-model failure pause.
      current.negotiation = restoreNegotiation(details.negotiation) ?? current.negotiation;
      current.completion = structuredClone(details);
      end(ctx);
    };
    try {
      if (linked) {
        current.pendingCompletion = structuredClone(details);
        if (current.negotiation) {
          current.negotiation.phase = "paused";
          current.negotiation.pause = { reason: "failure", action: WORK_MODEL_UNAVAILABLE };
        }
        cancelDialogs();
        persist();
        updateStatus(ctx);
        try {
          if (coordinatorPresent && host.finishLinked && !signal?.aborted && !ctx.signal?.aborted)
            await host.finishLinked(ctx, structuredClone(details), commitEnd);
        } catch {
          // No callback means no committed exit, even if the hook claims success or throws.
        } finally {
          commitOpen = false;
        }
        if (!currentSession()) return text("Execution changed; finalization discarded.");
        if (!committed) {
          shownThisRun = true;
          disposeAgent();
          return {
            content: [{ type: "text", text: WORK_MODEL_UNAVAILABLE }],
            details: {
              ...structuredClone(details),
              completion: undefined,
              negotiation: structuredClone(current.negotiation),
              action: WORK_MODEL_UNAVAILABLE,
            },
            ...(usage ? { usage } : {}),
            terminate: true,
          } as never;
        }
      } else commitEnd();
    } finally {
      commitOpen = false;
      if (finalizing === operation) finalizing = undefined;
    }
    if (!linked && details.completion !== "stopped") {
      const spec = parseModelSpec(current.restore);
      const now = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      if (spec && now === current.implementerModel) {
        let restored = false;
        try {
          restored = (await host.restoreModel(ctx, spec)) !== false;
        } catch {
          /* The final report remains durable even when restoration fails. */
        }
        if (!currentSession()) return text("Execution changed during model restoration.");
        if (restored) {
          const plannerSpec = parseModelSpec(current.planner?.spec);
          details.returnedTo =
            current.restoreName ??
            (plannerSpec &&
            current.planner &&
            plannerSpec.provider === spec.provider &&
            plannerSpec.modelId === spec.modelId
              ? current.planner.name
              : `${spec.provider}/${spec.modelId}`);
        }
        if (!restored) details.action = "Planning model restoration failed; select the model manually.";
      }
    }
    if (currentSession()) {
      current.completion = structuredClone(details);
      persist();
    }
    const result = {
      content: [{ type: "text", text: `${finishMessageText(details)}\n\nExec mode is over. Stop here.` }],
      details,
      ...(usage ? { usage } : {}),
      terminate: true,
    };
    return (toolCallId ? finalResult(result, toolCallId) : result) as never;
  };

  const record = (usage: Usage, ctx: ExtensionContext) => {
    if (!state) return;
    state.asks += 1;
    state.costUsd += usage.cost.total;
    persist();
    updateStatus(ctx);
  };

  const restore = (ctx: ExtensionContext) => {
    epoch++;
    cancelDialogs();
    busy = !ctx.isIdle();
    shownThisRun = false;
    implementationDriven = true;
    stopRequested = false;
    plannerUnavailable = false;
    cards.begin(ctx);
    hostCtx = ctx;
    disposeAgent();
    noted.clear();
    touched.clear();
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === EXEC_ENTRY)?.data;
    state = validState(latest);
    const bootstrap = [...entries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === "plan-implementation-runtime")?.data as
      | { exec?: unknown }
      | undefined;
    const seed = validState(bootstrap?.exec);
    const pendingBootstrap = Boolean(
      state?.active &&
        state.linkedFlow &&
        !state.negotiation &&
        seed?.active &&
        seed.planFile === state.planFile &&
        seed.implementerModel === state.implementerModel &&
        JSON.stringify(seed.linkedFlow) === JSON.stringify(state.linkedFlow) &&
        !entries.some(
          (entry) => entry.type === "custom" && entry.customType === "plan-implementation-runtime-consumed",
        ),
    );
    pendingReturn = state?.pendingReturn;
    if (state) {
      for (const file of state.touched ?? []) touched.add(file);
      state.negotiation ??= createNegotiation(randomUUID(), host.completionMaxRevisions?.() ?? 2);
      const n = state.negotiation;
      if (state.pendingCompletion) {
        n.phase = "paused";
        n.pause = { reason: "failure", action: WORK_MODEL_UNAVAILABLE };
      } else if (n.phase === "reviewing" || n.phase === "consulting") {
        if (n.phase === "reviewing") n.history.at(-1)!.error = "Review interrupted by reload.";
        n.phase = "paused";
        n.pause = { reason: "interrupted", action: "Exchange interrupted by reload; no paid request was retried." };
      }
      // A fresh seed is an overlay for startup reconciliation, not a committed
      // begin. Keep its durable identity uninitialized until the post-start
      // bootstrap activates the worker and calls begin; otherwise the gate must
      // reject that begin as a duplicate. Local recovery still has a negotiation.
      if (!pendingBootstrap) persist();
    }
    if (!state?.active) cards.end();
    setTools();
    updateStatus(ctx);
    publishActive("restore");
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    epoch++;
    cancelDialogs();
    busy = false;
    shownThisRun = false;
    cards.end();
    disposeAgent();
    // Reload replaces this runtime, not the durable execution. Only release transient UI ownership.
    const ctx = hostCtx;
    if (ctx?.hasUI) safely(() => ctx.ui.setStatus(EXEC_STATUS_KEY, undefined));
    hostCtx = undefined;
  });

  /** The planner on call, opened on its seeded session the first time it is asked. */
  const consultant = (ctx: ExtensionContext, purpose: "consult" | "review" = "consult"): PlannerAgent | undefined => {
    if (agent && agentPurpose !== purpose) disposeAgent();
    if (agent) return agent;
    const planner = state?.planner;
    const spec = parseModelSpec(planner?.spec);
    if (!state || !planner || !spec) return undefined;
    agentPurpose = purpose;
    agent = new PlannerAgent({
      id: "P",
      family: discoverFamily(pi.events),
      familyKind: purpose === "review" ? "reviewer" : "consultant",
      familyOperationId: `exec:${state.negotiation?.executionId ?? state.planFile}:${purpose}`,
      spec,
      name: planner.name,
      cwd: ctx.cwd,
      access: host.consultantAccess(ctx, state.planFile, spec),
      timeoutMs: CONSULT_TIMEOUT_MS,
      wrapUpMessage:
        purpose === "review"
          ? "Time is almost up. Stop investigating. Do not modify files or run tests. Return the required strict JSON review decision now, with explicit limitations; missing human-only evidence requires user_needed."
          : CONSULT_WRAP_UP,
      sessionDir: plannerSessionDir(),
      seed: [],
      sessionFile: planner.sessionFile,
      onChange: () => undefined,
      ...(host.createSession ? { createSession: host.createSession } : {}),
    });
    return agent;
  };

  const flags = {
    exposure: "model-only",
    executionMode: "sequential",
    defaultActive: false,
    annotations: { readOnlyHint: true },
  } as const;

  type Action = "retry" | "resume" | "accept" | "stop";
  type Origin = "command" | "tool";
  type ActionResult = {
    content: Array<{ type: "text"; text: string }>;
    details: FinishDetails | undefined;
    terminate?: boolean;
  };
  const pausedResult = (message: string): ActionResult => ({
    content: [{ type: "text", text: message }],
    details: undefined,
    terminate: true,
  });

  // Dialogs own no durable authority. A branch change, recovery or abort invalidates their answer.
  const select = async (
    current: ExecState,
    token: number,
    n: NegotiationState,
    ctx: ExtensionContext,
    origin: Origin,
    title: string,
    choices: string[],
    signal?: AbortSignal,
  ) => {
    const pause = n.pause;
    const phase = n.phase;
    const valid = () =>
      live(current, token) &&
      current.active &&
      current.negotiation === n &&
      n.phase === phase &&
      n.pause === pause &&
      !signal?.aborted &&
      !ctx.signal?.aborted &&
      (origin !== "command" || ctx.isIdle());
    if (!ctx.hasUI || !valid()) return undefined;
    const controller = new AbortController();
    dialogs.add(controller);
    const signals = [controller.signal, signal, ctx.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const dialogSignal = AbortSignal.any(signals);
    const release = holdBlocked(pi.events, title);
    let onAbort: () => void = () => undefined;
    try {
      const aborted = new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined);
        dialogSignal.addEventListener("abort", onAbort, { once: true });
        if (dialogSignal.aborted) onAbort();
      });
      // Native selectors close on abort. Race as well so a stale/missing UI implementation cannot
      // retain the blocked hold after navigation, shutdown or recovery elsewhere.
      const answer = await Promise.race([ctx.ui.select(title, choices, { signal: dialogSignal }), aborted]);
      return !dialogSignal.aborted && valid() ? answer : undefined;
    } catch {
      return undefined;
    } finally {
      dialogSignal.removeEventListener("abort", onAbort);
      dialogs.delete(controller);
      release();
    }
  };

  const applyAction = async (
    current: ExecState,
    token: number,
    action: Action,
    ctx: ExtensionContext,
    origin: Origin,
    answer?: string,
    signal?: AbortSignal,
  ): Promise<ActionResult> => {
    const n = current.negotiation!;
    if (!live(current, token) || !current.active || signal?.aborted || ctx.signal?.aborted)
      return pausedResult("Execution changed or was interrupted; no action taken.");
    if (current.pendingCompletion && action !== "stop") {
      if (action !== "retry") return pausedResult(WORK_MODEL_UNAVAILABLE);
      const result = await finalize(current, token, structuredClone(current.pendingCompletion), ctx, undefined, signal);
      if (origin === "command" && live(current, token) && !current.active && current.completion) {
        pi.sendMessage(finishDelivery(structuredClone(current.completion)));
      }
      return result;
    }
    if (action === "stop" || action === "accept") {
      if (action === "accept" && n.phase !== "paused") return text("Only a paused execution can be overridden.");
      if (action === "accept" || origin === "tool") {
        const title = action === "accept" ? "Finish without planner acceptance?" : "Stop implementation?";
        const positive = action === "accept" ? "Finish without review" : "Stop implementation";
        const selected = await select(
          current,
          token,
          n,
          ctx,
          origin,
          title,
          [positive, action === "accept" ? "Keep paused" : "Keep working"],
          signal,
        );
        if (selected !== positive)
          return pausedResult(
            ctx.hasUI
              ? "No change authorized. Discuss what is needed next."
              : "A UI confirmation is required; no change authorized.",
          );
      }
      const details: FinishDetails = {
        ...(current.pendingCompletion ??
          n.latestReport ??
          (action === "stop"
            ? {
                report: "Implementation stopped.",
                verification: "Not provided.",
                concerns: "Execution abandoned; no completion claimed.",
              }
            : { report: "No report submitted.", verification: "Unknown.", concerns: "Unreviewed." })),
        planFile: current.planFile,
        negotiation: structuredClone(current.pendingCompletion?.negotiation ?? n),
        decision: current.pendingCompletion?.decision ?? n.history.at(-1)?.decision,
        completion: action === "stop" ? "stopped" : "user_override",
        executionId: n.executionId,
        asks: current.asks,
        costUsd: current.costUsd,
      };
      if (action === "stop") {
        current.pendingReturn = undefined;
        pendingReturn = undefined;
      }
      const result = await finalize(current, token, details, ctx, undefined, signal);
      if (origin === "command" && live(current, token) && !current.active) {
        pi.sendMessage(finishDelivery(details));
      }
      return result;
    }
    try {
      current.negotiation = recoverNegotiation(n, action);
    } catch (error) {
      return text(String(error));
    }
    cancelDialogs();
    if (action === "resume" && answer !== undefined) {
      current.negotiation.userAnswers ??= [];
      current.negotiation.userAnswers.push(answer);
    }
    disposeAgent();
    persist();
    updateStatus(ctx);
    const findings = outstanding(current.negotiation)
      .map((f) => `${f.id}: ${f.title}\n${f.detail}\nRequested: ${f.requestedChange}`)
      .join("\n\n");
    const instructions =
      action === "retry"
        ? "The user authorized one retry of the interrupted/failed completion review. Resubmit finish_plan using the saved report and finding responses; do not make unrelated changes. No revision counts were reset."
        : `The user resumed this implementation.${answer !== undefined ? ` User-provided evidence/answer (not independent automated verification): ${answer}` : " One additional revision-and-review cycle was authorized; no counters were reset."}\nOutstanding findings:\n${findings}\nContinue implementation in the existing context, then submit finish_plan with per-finding responses. Further extensions require explicit user approval.`;
    if (origin === "command") pi.sendUserMessage(instructions);
    return text(instructions);
  };

  const cacheUsage = (u: Usage) => ({ input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });

  /** A question dialog that closes on navigation, abort or recovery elsewhere. */
  const dialog = async (
    current: ExecState,
    token: number,
    ctx: ExtensionContext,
    questions: AskQuestion[],
    label: string,
    signal?: AbortSignal,
  ) => {
    if (!ctx.hasUI || !live(current, token) || !current.active) return undefined;
    const controller = new AbortController();
    dialogs.add(controller);
    const signals = [controller.signal, signal, ctx.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const dialogSignal = AbortSignal.any(signals);
    try {
      const result = await askUser(pi, ctx, questions, { label, signal: dialogSignal });
      return !dialogSignal.aborted && live(current, token) && current.active ? result : undefined;
    } finally {
      dialogs.delete(controller);
    }
  };

  type Postponed = { questions: PlanModeQuestion[]; plannerNote?: string };
  let postponed: Postponed | undefined;
  const takePostponed = () => {
    const value = postponed;
    postponed = undefined;
    return value;
  };

  /** Answers the planner's questions in a dialog; the user's Esc postpones them. */
  const serveQuestions =
    (
      planner: PlannerAgent,
      ctx: ExtensionContext,
      current: ExecState,
      token: number,
      base: () => object,
      onUpdate: ((update: unknown) => void) | undefined,
      purpose: "consult" | "review",
      signal?: AbortSignal,
    ) =>
    (pending: PendingQuestions) => {
      void (async () => {
        const questions = toAskQuestions(pending.questions);
        const note = planner.lastReply.trim().slice(0, 2000) || undefined;
        // This update must precede the dialog: it is what Switchyard's adapter claims the form from.
        safely(() =>
          onUpdate?.({
            content: [{ type: "text", text: "Planner asks you…" }],
            details: {
              ...base(),
              pending: true,
              asking: true,
              plannerNote: note,
              [ASK_DETAILS_KEY]: { questions },
            },
          }),
        );
        questionsOpen++;
        updateStatus(ctx);
        let result: Awaited<ReturnType<typeof dialog>>;
        try {
          result = await dialog(current, token, ctx, questions, PLANNER_QUESTION_LABEL, signal);
        } finally {
          questionsOpen--;
        }
        if (!live(current, token)) return;
        if (!ctx.hasUI) planner.answer(undefined);
        else if (result && !result.cancelled) planner.answer(toPlannerAnswers(pending.questions, result));
        else {
          planner.postpone(purpose === "review" ? REVIEW_POSTPONED : CONSULT_POSTPONED);
          if (purpose === "consult") postponed = { questions: pending.questions, plannerNote: note };
        }
        safely(() =>
          onUpdate?.({
            content: [{ type: "text", text: "Planner working…" }],
            details: { ...base(), pending: true },
          }),
        );
        updateStatus(ctx);
      })();
    };

  /** What the user typed into a pause dialog goes to the planner, and its answer is posted as a card. */
  const discussWithPlanner = async (
    current: ExecState,
    token: number,
    ctx: ExtensionContext,
    context: string,
    message: string,
  ): Promise<boolean> => {
    const planner = consultant(ctx, "consult");
    if (!planner || !current.planner) {
      plannerUnavailable = true;
      safely(() => ctx.ui.notify("The planner is unavailable; your message was not sent.", "warning"));
      return false;
    }
    const name = current.planner.name;
    takePostponed();
    questionHandler = serveQuestions(
      planner,
      ctx,
      current,
      token,
      () => ({ question: message, planner: name, fromUser: true }),
      undefined,
      "consult",
    );
    let result: Awaited<ReturnType<PlannerAgent["consult"]>>;
    try {
      result = await planner.consult(userDiscussionMessage(context, message), ctx, "user", ctx.signal, message);
    } finally {
      questionHandler = undefined;
    }
    takePostponed();
    if (!live(current, token)) return false;
    record(result.usage, ctx);
    if (result.error) {
      disposeAgent();
      plannerUnavailable = true;
      safely(() => ctx.ui.notify(`The planner failed: ${result.error}`, "warning"));
      return false;
    }
    plannerUnavailable = false;
    const reply = result.reply.trim();
    pi.sendMessage(
      {
        customType: PLANNER_ANSWER_MESSAGE_TYPE,
        content: reply || "(the planner answered with no text)",
        display: true,
        details: {
          question: message,
          reply,
          planner: name,
          fromUser: true,
          usage: cacheUsage(result.usage),
          costUsd: result.usage.cost.total,
        } satisfies AskDetails,
      },
      { triggerTurn: false },
    );
    return true;
  };

  /** The user answers a planner question they put off; the planner resumes the implementer with its decision. */
  const answerPendingQuestion = async (
    current: ExecState,
    token: number,
    ctx: ExtensionContext,
    typed?: string,
  ): Promise<boolean> => {
    const pq = current.pendingQuestion;
    if (!pq || !current.planner) return false;
    let answers: PlanModeQuestionAnswer[];
    if (typed !== undefined) {
      answers = pq.questions.map((q, i) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        answer: i === 0 ? typed : "No answer. Use your recommendation.",
        wasCustom: true,
      }));
    } else {
      questionsOpen++;
      updateStatus(ctx);
      let result: Awaited<ReturnType<typeof dialog>>;
      try {
        result = await dialog(current, token, ctx, toAskQuestions(pq.questions), PLANNER_QUESTION_LABEL);
      } finally {
        questionsOpen--;
        updateStatus(ctx);
      }
      if (!live(current, token) || !result || result.cancelled) return false;
      answers = toPlannerAnswers(pq.questions, result);
    }
    current.pendingQuestion = undefined;
    persist();
    updateStatus(ctx);
    const restoreQuestion = () => {
      if (!live(current, token)) return;
      current.pendingQuestion = pq;
      persist();
      updateStatus(ctx);
    };
    const planner = consultant(ctx, "consult");
    if (!planner) {
      plannerUnavailable = true;
      safely(() => ctx.ui.notify("The planner is unavailable; your answer was kept for later.", "warning"));
      restoreQuestion();
      return false;
    }
    const name = current.planner.name;
    const before = readPlan(current.planFile);
    takePostponed();
    questionHandler = serveQuestions(
      planner,
      ctx,
      current,
      token,
      () => ({ question: pq.implementerMessage, planner: name }),
      undefined,
      "consult",
    );
    let result: Awaited<ReturnType<PlannerAgent["consult"]>>;
    try {
      result = await planner.consult(
        postponedAnswerMessage(answers, pq.implementerMessage),
        ctx,
        "implementer",
        ctx.signal,
        pq.implementerMessage,
      );
    } finally {
      questionHandler = undefined;
    }
    if (!live(current, token)) return false;
    record(result.usage, ctx);
    const again = takePostponed();
    if (again) {
      current.pendingQuestion = {
        id: randomUUID(),
        questions: again.questions,
        implementerMessage: pq.implementerMessage,
        ...(again.plannerNote ? { plannerNote: again.plannerNote } : {}),
      };
      persist();
      updateStatus(ctx);
      return true;
    }
    if (result.error) {
      disposeAgent();
      plannerUnavailable = true;
      safely(() => ctx.ui.notify(`The planner failed: ${result.error}`, "warning"));
      restoreQuestion();
      return false;
    }
    plannerUnavailable = false;
    const after = readPlan(current.planFile);
    const changes = before === after ? [] : planDiff(before, after);
    const reply = result.reply.trim();
    const amended =
      changes.length > 0
        ? `\n\nIt amended the plan (${tildify(current.planFile)}):\n${planDiffText(changes)}\n\nFollow the amended plan.`
        : "";
    implementationDriven = true;
    pi.sendMessage(
      {
        customType: PLANNER_ANSWER_MESSAGE_TYPE,
        content: `The planner answered after asking the user:\n\n${reply || "(it answered with no text)"}${amended}\n\nContinue the implementation.`,
        display: true,
        details: {
          question: pq.implementerMessage,
          reply,
          planner: name,
          changes,
          usage: cacheUsage(result.usage),
          costUsd: result.usage.cost.total,
        } satisfies AskDetails,
      },
      { triggerTurn: true },
    );
    return true;
  };

  /** The dialog for a pause: every recovery is a choice here, and typed text is a message. */
  const presentPause = async (
    current: ExecState,
    token: number,
    ctx: ExtensionContext,
    origin: Origin,
    signal?: AbortSignal,
  ): Promise<ActionResult> => {
    for (let round = 0; round < 5; round++) {
      if (!live(current, token) || !current.active || signal?.aborted || ctx.signal?.aborted)
        return pausedResult("Execution changed or was interrupted; no recovery authorized.");
      const n = current.negotiation!;
      if (!current.pendingCompletion && n.phase !== "paused")
        return text("Implementation remains active; completion has not been confirmed.");
      const { question, actions } = pauseQuestion(n, Boolean(current.pendingCompletion));
      const reason = current.pendingCompletion ? undefined : n.pause?.reason;
      const result = await dialog(
        current,
        token,
        ctx,
        [question],
        question.header === "Reviewer" ? "Review needs you" : "Review",
        signal,
      );
      if (!live(current, token) || current.negotiation !== n || signal?.aborted || ctx.signal?.aborted)
        return pausedResult("Execution changed or was interrupted; no recovery authorized.");
      const answer = result && !result.cancelled ? result.answers[0] : undefined;
      if (!answer || answer.answer === null)
        return pausedResult(ctx.hasUI ? pauseText(n) : `${pauseText(n)}\nNo UI is available; no recovery authorized.`);
      if (answer.kind === "custom") {
        if (reason === "user_needed") return applyAction(current, token, "resume", ctx, origin, answer.answer, signal);
        if (!(await discussWithPlanner(current, token, ctx, pauseText(n), answer.answer)))
          return pausedResult(pauseText(n));
        continue;
      }
      if (reason === "user_needed" && answer.answer === "Use recommendation") {
        const recommendation = n.history.at(-1)?.decision?.recommendation ?? "the reviewer's recommendation";
        return applyAction(current, token, "resume", ctx, origin, `Use your recommendation: ${recommendation}`, signal);
      }
      const action = actions[answer.answer];
      if (!action) return pausedResult(pauseText(n));
      return applyAction(current, token, action === "extend" ? "resume" : action, ctx, origin, undefined, signal);
    }
    return pausedResult(pauseText(current.negotiation!));
  };

  const continueImplementation = (submit: boolean) => {
    implementationDriven = true;
    pi.sendMessage(
      {
        customType: EXEC_CONTINUE_MESSAGE_TYPE,
        content: submit
          ? "Submit your work now with finish_plan: report, verification and concerns."
          : "Continue implementing the approved plan. Use ask_planner instead of stopping when something needs a decision.",
        display: true,
      },
      { triggerTurn: true },
    );
  };

  const presentStalled = async (current: ExecState, token: number, ctx: ExtensionContext) => {
    const result = await dialog(
      current,
      token,
      ctx,
      [stalledQuestion(planTitle(current.planFile))],
      "Implementer stopped",
    );
    const answer = result && !result.cancelled ? result.answers[0] : undefined;
    if (!answer || answer.answer === null || !live(current, token) || !current.active) return;
    if (answer.kind === "custom") pi.sendUserMessage(answer.answer);
    else if (answer.answer === "Stop implementation") await applyAction(current, token, "stop", ctx, "command");
    else continueImplementation(answer.answer === "Submit for review");
  };

  const presentStatus = async (current: ExecState, token: number, ctx: ExtensionContext) => {
    const result = await dialog(
      current,
      token,
      ctx,
      [statusQuestion(planTitle(current.planFile), current.implementer, current.planner?.name, busy)],
      "Implementing",
    );
    const answer = result && !result.cancelled ? result.answers[0] : undefined;
    if (!answer || answer.answer === null || !live(current, token) || !current.active) return;
    if (answer.answer === "Keep going") return;
    if (answer.answer === "Stop implementation") {
      if (ctx.isIdle()) await applyAction(current, token, "stop", ctx, "command");
      else {
        stopRequested = true;
        ctx.abort();
      }
      return;
    }
    continueImplementation(answer.answer === "Submit for review");
  };

  /** Whatever needs the user now, in priority order; `settle` only opens what the turn's end calls for. */
  const presentNext = async (ctx: ExtensionContext, origin: "settle" | "menu") => {
    const current = state;
    if (!current?.active || !ctx.hasUI || dialogs.size > 0) return;
    hostCtx = ctx;
    const token = epoch;
    if (current.pendingQuestion) {
      await answerPendingQuestion(current, token, ctx);
      return;
    }
    if (current.pendingCompletion || current.negotiation?.phase === "paused") {
      await presentPause(current, token, ctx, "command");
      return;
    }
    if (origin === "menu") await presentStatus(current, token, ctx);
    else await presentStalled(current, token, ctx);
  };

  pi.registerTool({
    name: CONTINUE_TOOL,
    ...flags,
    label: "Continue plan",
    description:
      "Ask to open the paused implementation's recovery dialog (retry, extend, finish without review or stop). The user decides in the dialog.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["retry", "extend", "accept", "stop"] },
      },
    } as never,
    async execute(_id, params: unknown, signal, _onUpdate, ctx) {
      hostCtx = ctx;
      const current = state;
      if (!current?.active) return text(NOT_ACTIVE);
      if (signal?.aborted || ctx.signal?.aborted) return pausedResult("Interrupted; no recovery authorized.");
      const token = epoch;
      const n = current.negotiation!;
      const { action } = (params ?? {}) as { action?: string };
      if (current.pendingCompletion && action !== "stop")
        return action === "retry"
          ? applyAction(current, token, "retry", ctx, "tool", undefined, signal)
          : pausedResult(WORK_MODEL_UNAVAILABLE);
      if (action === "retry" || action === "extend") {
        const matches =
          n.phase === "paused" &&
          (action === "extend"
            ? n.pause?.reason === "exhausted"
            : n.pause?.reason === "failure" || n.pause?.reason === "interrupted");
        if (!matches) return text("This recovery action is not available for the current phase; no change made.");
        return presentPause(current, token, ctx, "tool", signal);
      }
      if (action === "accept" || action === "stop")
        return applyAction(current, token, action, ctx, "tool", undefined, signal);
      return text("Choose retry, extend, accept or stop.");
    },
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") implementationDriven = false;
  });
  pi.on("tool_call", (event) => {
    if (state?.active && state.planner && !plannerUnavailable && event.toolName === "ask_user_question")
      return {
        block: true,
        reason:
          "During plan execution the planner on call asks the user. Call ask_planner with what you need decided; it will ask the user if the decision is theirs.",
      };
    return undefined;
  });
  pi.on("context", (event) => {
    if (!state?.active) return;
    const n = state.negotiation!;
    const pq = state.pendingQuestion;
    const guidance = [
      "An approved plan is being implemented. Human questions do not cancel the task; answer them normally. Follow explicit requests to pause. Keep human-facing explanations concise; do not dump review history or advertise recovery commands.",
      pq
        ? `The planner is waiting for the user's answer to: ${pq.questions.map((q) => q.question).join(" / ")}. Do not work around it; stop and wait.`
        : state.pendingCompletion
          ? `${WORK_MODEL_UNAVAILABLE}\nCompletion is already authorized and saved. Do not implement or rerun review. finish_plan or continue_plan(action=retry) retries only the saved completion handoff.`
          : n.phase === "paused"
            ? `${pauseText(n)}\nDo not implement while paused. The user resolves it in a dialog; answer their questions briefly if they ask.`
            : "Continue the approved implementation unless the user changes direction. Completion requires finish_plan and the existing review safeguards.\nNever ask the user directly or end your turn with a question: use ask_planner. When the user changes direction, tell the planner with ask_planner so it amends the plan, then follow its answer.",
    ].join("\n\n");
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "plan-mode-exec-guidance",
          content: guidance,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!busy) shownThisRun = false;
    busy = true;
    hostCtx = ctx;
    updateStatus(ctx);
  });

  pi.registerTool({
    name: ASK_TOOL,
    ...flags,
    ...{ ccstyleOwnResult: true },
    label: "Ask planner",
    description:
      "Ask the planner that wrote the plan you are implementing, and wait for its answer. It keeps its full research context and can read the current files, including your changes. Use it when the plan does not fit what you find: a step cannot be done as written, a fact it states is wrong, a change it does not list is needed, or it leaves a choice open. It answers with a decision, and amends the plan file when the plan changes.",
    promptSnippet: "Ask the plan's planner when the plan does not fit what you find",
    promptGuidelines: [
      "While implementing an approved plan with its planner on call, call ask_planner instead of improvising whenever the plan does not fit what you find. Say what you found, where, and the options you see; follow its answer. It asks the user itself when the decision is theirs; never ask the user directly.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: {
          type: "string",
          minLength: 1,
          description: "What you found or tried, where, and the options you see.",
        },
      },
    } as never,
    renderCall: (args, theme) => {
      const question = String((args as { message?: unknown } | undefined)?.message ?? "");
      const container = new Container();
      container.addChild(reviewTitle(theme, "Ask planner"));
      if (question) container.addChild(new Text(theme.fg("muted", question), 0, 0));
      return container;
    },
    renderResult: (result, options, theme) =>
      renderAsk(result.details as AskDetails | undefined, options, theme, currentExchange),
    async execute(id, params: unknown, signal, onUpdate, ctx) {
      hostCtx = ctx;
      const current = state;
      if (!current?.active || !current.planner) {
        return text("No planner is on call: you are not implementing a handed-off plan.");
      }
      const token = epoch;
      const n = current.negotiation!;
      if (n.phase === "paused" || n.phase === "reviewing")
        return { content: [{ type: "text", text: pauseText(n) }], details: undefined, terminate: true } as never;
      const message =
        typeof (params as { message?: unknown })?.message === "string"
          ? (params as { message: string }).message.trim()
          : "";
      if (!message) return text("Say what you found and what you need decided.");
      const planner = consultant(ctx);
      if (!planner) {
        plannerUnavailable = true;
        const error =
          "The planner's session is missing; ask the user with ask_user_question about anything the approved plan leaves open.";
        return finalResult(
          {
            content: [{ type: "text", text: error }],
            details: {
              question: message,
              planner: current.planner.name,
              error,
              executionId: n.executionId,
              number: current.asks + 1,
            },
          },
          id,
        ) as never;
      }
      const previousPhase = n.phase;
      n.phase = "consulting";
      n.latestExchangeId = `${n.executionId}:consult:${current.asks + 1}`;
      persist();
      updateStatus(ctx);
      const askIdentity = { number: current.asks + 1, executionId: n.executionId, exchangeId: n.latestExchangeId };
      const before = readPlan(current.planFile);
      const name = current.planner.name;
      const progress = () => {
        if (!live(current, token)) return;
        const activity = planner.stats.lastActivity ?? "thinking";
        onUpdate?.({
          content: [{ type: "text", text: `${name}: ${activity}` }],
          details: { ...askIdentity, question: message, planner: name, pending: true, activity } satisfies AskDetails,
        } as never);
      };
      const unsubscribe = planner.subscribe(progress);
      const onAbort = () => void planner.stop();
      signal?.addEventListener("abort", onAbort, { once: true });
      let result: Awaited<ReturnType<PlannerAgent["consult"]>>;
      takePostponed();
      questionHandler = serveQuestions(
        planner,
        ctx,
        current,
        token,
        () => ({ ...askIdentity, question: message, planner: name }),
        onUpdate as ((update: unknown) => void) | undefined,
        "consult",
        signal,
      );
      try {
        result = await planner.consult(consultMessage(message, "implementer"), ctx, "implementer", signal, message);
      } catch (error) {
        if (!live(current, token)) return text("Execution changed; discarded stale consultation.");
        n.phase = previousPhase;
        disposeAgent();
        persist();
        updateStatus(ctx);
        return finalResult(
          {
            content: [{ type: "text", text: `Planner consultation failed: ${String(error)}` }],
            details: { ...askIdentity, question: message, planner: name, error: String(error) },
          },
          id,
        ) as never;
      } finally {
        questionHandler = undefined;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      }
      if (!live(current, token)) return text("Execution changed; discarded stale planner response.");
      n.phase = previousPhase;
      if (signal?.aborted || result.error) disposeAgent();
      if (result.error) plannerUnavailable = true;
      record(result.usage, ctx);
      const waiting = takePostponed();
      if (waiting && !signal?.aborted && !result.error) {
        plannerUnavailable = false;
        current.pendingQuestion = {
          id: randomUUID(),
          questions: waiting.questions,
          implementerMessage: message,
          ...(waiting.plannerNote ? { plannerNote: waiting.plannerNote } : {}),
        };
        persist();
        updateStatus(ctx);
        shownThisRun = true;
        return finalResult(
          {
            content: [
              {
                type: "text",
                text: "The planner asked the user a question; the user will answer later. Stop now and end your turn. Do not decide it yourself or work around it.",
              },
            ],
            details: {
              ...askIdentity,
              question: message,
              planner: name,
              postponed: true,
              reply: result.reply.trim(),
              usage: cacheUsage(result.usage),
              costUsd: result.usage.cost.total,
            } satisfies AskDetails,
            usage: result.usage,
            terminate: true,
          },
          id,
        ) as never;
      }
      if (signal?.aborted)
        return {
          content: [{ type: "text", text: "Stopped waiting for the planner." }],
          details: {
            ...askIdentity,
            question: message,
            planner: name,
            error: "Consultation cancelled.",
            costUsd: result.usage.cost.total,
          },
          usage: result.usage,
        } as never;
      if (result.error) {
        return finalResult(
          {
            content: [
              {
                type: "text",
                text: `The planner failed: ${result.error}. Decide within the plan, and ask the user with ask_user_question about anything it leaves open.`,
              },
            ],
            details: {
              ...askIdentity,
              error: result.error,
              question: message,
              planner: name,
              usage: cacheUsage(result.usage),
              costUsd: result.usage.cost.total,
            } satisfies AskDetails,
            usage: result.usage,
          },
          id,
        ) as never;
      }
      plannerUnavailable = false;
      const after = readPlan(current.planFile);
      const changes = before === after ? [] : planDiff(before, after);
      const reply = result.reply.trim();
      const body = `The planner answered:\n\n${reply || "(it answered with no text)"}`;
      const amended =
        changes.length > 0
          ? `\n\nIt amended the plan (${tildify(current.planFile)}):\n${planDiffText(changes)}\n\nFollow the amended plan.`
          : "";
      return finalResult(
        {
          content: [{ type: "text", text: `${body}${amended}` }],
          details: {
            ...askIdentity,
            question: message,
            reply,
            planner: name,
            changes,
            usage: cacheUsage(result.usage),
            costUsd: result.usage.cost.total,
          } satisfies AskDetails,
          usage: result.usage,
        },
        id,
      ) as never;
    },
  });

  pi.registerTool({
    name: FINISH_TOOL,
    ...flags,
    ...{ ccstyleOwnResult: true },
    label: "Finish plan",
    description:
      "Submit implementation for completion review. Only explicit acceptance or configured no-review completion ends exec. Address requested findings and resubmit; paused reviews require user recovery.",
    promptSnippet: "Submit an approved plan for completion review",
    promptGuidelines: [
      "Submit report, verification and concerns honestly. On subsequent submissions respond exactly once to each outstanding finding with addressed, disputed or blocked and evidence. Never work around a paused review or reset its budget.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report", "verification", "concerns"],
      properties: {
        responses: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "status", "response"],
            properties: {
              id: { type: "string", minLength: 1 },
              status: { type: "string", enum: ["addressed", "disputed", "blocked"] },
              response: { type: "string", minLength: 1 },
            },
          },
        },
        report: {
          type: "string",
          minLength: 1,
          description: "Markdown: what you changed.",
        },
        verification: {
          type: "string",
          minLength: 1,
          description: "Checks and their results, including failures and anything not run.",
        },
        concerns: {
          type: "string",
          minLength: 1,
          description: "Deviations, failures, and remaining work. Use None only when accurate.",
        },
      },
    } as never,
    renderCall: (_args, theme) => reviewTitle(theme, "Implementation review"),
    renderResult: (result, options, theme) =>
      renderFinish(result.details as FinishDetails | undefined, options, theme, currentExchange),
    async execute(id, params: unknown, signal, onUpdate, ctx) {
      hostCtx = ctx;
      const current = state;
      if (!current?.active) return text(NOT_ACTIVE);
      const token = epoch;
      let n = current.negotiation!;
      if (current.pendingCompletion) {
        if (signal?.aborted || ctx.signal?.aborted) return pausedResult(WORK_MODEL_UNAVAILABLE);
        return finalize(current, token, structuredClone(current.pendingCompletion), ctx, undefined, signal, id);
      }
      if (n.phase === "paused") {
        shownThisRun = true;
        const previous = n.history.at(-1);
        if (!live(current, token) || current.negotiation !== n || signal?.aborted || ctx.signal?.aborted)
          return pausedResult("Execution changed or was interrupted; no action taken.");
        const details: FinishDetails = {
          ...(n.latestReport ?? {
            report: "No report submitted.",
            verification: "Unknown.",
            concerns: "Execution paused.",
          }),
          planFile: current.planFile,
          negotiation: structuredClone(n),
          decision: previous?.decision,
          error: previous?.error,
          executionId: n.executionId,
          exchangeId: n.latestExchangeId,
          round: n.attempts,
          question: n.pause?.question,
          action: pauseText(n),
          asks: current.asks,
          costUsd: current.costUsd,
        };
        return { content: [{ type: "text", text: pauseText(n) }], details, terminate: true } as never;
      }
      const fields = params as Record<string, unknown> | undefined;
      const field = (key: string) => (typeof fields?.[key] === "string" ? fields[key].trim() : "");
      const report = field("report");
      const verification = field("verification");
      const concerns = field("concerns");
      if (!report || !verification || !concerns) {
        return text(
          "Retry finish_plan with nonempty report (what changed), verification (checks and results, including anything not run), and concerns (deviations, failures, and remaining work; use None only when accurate). Exec mode is still active.",
        );
      }
      let responses: FindingResponse[];
      try {
        responses = validateResponses(fields?.responses, outstanding(n));
      } catch (error) {
        return text(String(error));
      }
      const previousAttempt = n.history.at(-1);
      const saved = n.latestReport;
      const retryingSaved = Boolean(previousAttempt?.error && saved);
      const submission = retryingSaved && saved ? saved : { report, verification, concerns };
      if (retryingSaved && previousAttempt?.responses) responses = structuredClone(previousAttempt.responses);
      const changes = await summarizeChanges(current, touched, ctx.cwd);
      if (!live(current, token)) return text("Execution changed; submission discarded.");
      const details: FinishDetails = {
        ...submission,
        responses,
        previousFindings: structuredClone(outstanding(n)),
        executionId: n.executionId,
        report: submission.report,
        planFile: current.planFile,
        changes,
        implementer: current.implementer,
        asks: current.asks,
        costUsd: current.costUsd,
      };
      let usage: Usage | undefined;
      if (!host.completionReview()) {
        details.assessment = { state: "disabled" };
        details.completion = "no_review";
        details.negotiation = structuredClone(n);
        return await finalize(current, token, details, ctx, undefined, signal, id);
      }
      try {
        n = startReview(n, submission, responses);
      } catch (error) {
        return text(String(error));
      }
      current.negotiation = n;
      details.exchangeId = n.latestExchangeId;
      details.round = n.attempts;
      details.negotiation = structuredClone(n);
      persist();
      updateStatus(ctx);
      let decision: ReviewDecision | undefined;
      let reviewCost = 0;
      const runReview = async (): Promise<void> => {
        decision = undefined;
        reviewCost = 0;
        usage = undefined;
        try {
          if (!current.planner) details.assessment = { state: "unavailable", reason: "No planner is on call." };
          else {
            const planner = consultant(ctx, "review");
            if (!planner) {
              details.assessment = { state: "unavailable", reason: "The planner's session is missing or invalid." };
            } else {
              const baseline = planner.stats.costUsd;
              const baselineTokens = planner.stats.totalTokens;
              let started = false;
              const progress = () => {
                if (!live(current, token)) return;
                // The clock stops while the planner waits for you, and restarts after.
                if (planner.pending) {
                  clearTimeout(timer);
                  timer = undefined;
                } else if (!timer && !interrupted && started) {
                  timer = setTimeout(() => interrupt("timed out"), CONSULT_TIMEOUT_MS);
                }
                safely(() =>
                  onUpdate?.({
                    content: [{ type: "text", text: "Planner reviewing…" }],
                    details: { ...details, pending: true, activity: planner.stats.lastActivity },
                  } as never),
                );
              };
              const unsubscribe = planner.subscribe(progress);
              const controller = new AbortController();
              let timer: ReturnType<typeof setTimeout> | undefined;
              let interrupted: "cancelled" | "timed out" | undefined;
              let stopping: Promise<void> | undefined;
              let interrupt: (reason: "cancelled" | "timed out") => void = () => undefined;
              const stopped = new Promise<undefined>((done) => {
                interrupt = (reason) => {
                  if (interrupted) return;
                  interrupted = reason;
                  controller.abort();
                  stopping = planner.stop().catch(() => undefined);
                  done(undefined);
                };
              });
              const onAbort = () => interrupt("cancelled");
              signal?.addEventListener("abort", onAbort, { once: true });
              try {
                progress();
                timer = setTimeout(() => interrupt("timed out"), CONSULT_TIMEOUT_MS);
                started = true;
                questionHandler = serveQuestions(
                  planner,
                  ctx,
                  current,
                  token,
                  () => details,
                  onUpdate as ((update: unknown) => void) | undefined,
                  "review",
                  signal,
                );
                if (signal?.aborted) onAbort();
                const result = interrupted
                  ? undefined
                  : await Promise.race([
                      planner.consult(
                        reviewRequest(submission.report, {
                          verification: submission.verification,
                          concerns: submission.concerns,
                          previousFindings: outstanding(n),
                          responses,
                          userEvidence: n.userAnswers,
                          remainingRevisions:
                            Math.max(0, n.maxRevisions - n.revisionsUsed) + (n.revisionAuthorized ? 1 : 0),
                          planFile: current.planFile,
                          changes: changeSummaryText(details.changes),
                        }),
                        ctx,
                        "completion review",
                        controller.signal,
                      ),
                      stopped,
                    ]);
                // Drain asynchronous final abort usage before disposal; broken aborts get bounded cleanup.
                if (stopping) {
                  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    await Promise.race([
                      stopping,
                      new Promise<void>((resolve) => {
                        cleanupTimer = setTimeout(resolve, 5000);
                      }),
                    ]);
                  } finally {
                    clearTimeout(cleanupTimer);
                  }
                }
                if (!live(current, token)) return;
                usage = result?.usage;
                const costUsd = Math.max(usage?.cost.total ?? 0, planner.stats.costUsd - baseline, 0);
                if (interrupted && (!usage || usage.cost.total < costUsd)) {
                  usage = emptyUsage();
                  usage.cost.total = costUsd;
                  usage.totalTokens = Math.max(0, planner.stats.totalTokens - baselineTokens);
                }
                reviewCost = costUsd;
                if (usage) details.usage = cacheUsage(usage);
                if (interrupted || signal?.aborted) {
                  details.assessment = {
                    state: "failed",
                    reason: `Planner review ${interrupted ?? "cancelled"}.`,
                    costUsd,
                  };
                } else if (result?.error) {
                  details.assessment = { state: "failed", reason: result.error, costUsd };
                } else if (!result?.reply.trim()) {
                  details.assessment = { state: "failed", reason: "The planner returned an empty reply.", costUsd };
                } else {
                  decision = parseReviewDecision(result.reply);
                  details.assessment = {
                    state: "reviewed",
                    planner: current.planner.name,
                    narrative: result.reply.trim(),
                    verdict: decision.outcome === "accepted" ? "done" : "changes",
                    costUsd,
                  };
                }
              } catch (error: unknown) {
                reviewCost = Math.max(0, planner.stats.costUsd - baseline);
                details.assessment = {
                  state: "failed",
                  reason: error instanceof Error ? error.message : String(error),
                  costUsd: reviewCost,
                };
              } finally {
                questionHandler = undefined;
                clearTimeout(timer);
                unsubscribe();
                signal?.removeEventListener("abort", onAbort);
              }
            }
          }
        } catch (error: unknown) {
          details.assessment = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
        }
      };
      await runReview();
      if (!live(current, token)) return text("Execution changed; discarded stale review.");
      let error: string | undefined;
      let retried = false;
      for (;;) {
        if (!live(current, token)) return text("Execution changed; discarded stale review.");
        error =
          details.assessment?.state === "failed" || details.assessment?.state === "unavailable"
            ? details.assessment.reason
            : undefined;
        n = finishReview(n, { decision, error, costUsd: reviewCost });
        error = n.history.at(-1)?.error ?? error;
        // One automatic retry of a provider failure or an unusable reply; never of a timeout,
        // a cancellation, or a planner that is not available.
        if (
          error &&
          !retried &&
          details.assessment?.state === "failed" &&
          !/^Planner review (timed out|cancelled)\.$/u.test(details.assessment.reason) &&
          !signal?.aborted &&
          !ctx.signal?.aborted &&
          n.phase === "paused" &&
          n.pause?.reason === "failure"
        ) {
          try {
            const next = startReview(recoverNegotiation(n, "retry"), submission, responses);
            retried = true;
            disposeAgent();
            n = next;
            current.negotiation = n;
            details.exchangeId = n.latestExchangeId;
            details.round = n.attempts;
            details.negotiation = structuredClone(n);
            persist();
            updateStatus(ctx);
            await runReview();
            continue;
          } catch {
            // Keep the failure and its pause.
          }
        }
        break;
      }
      if (error) {
        disposeAgent();
        details.assessment = { state: "failed", reason: error, costUsd: reviewCost };
      }
      current.negotiation = n;
      decision = n.history.at(-1)?.decision;
      Object.assign(details, {
        negotiation: structuredClone(n),
        decision,
        error,
        pauseReason: n.pause?.reason,
        question: n.pause?.question,
        action: n.phase === "paused" ? pauseText(n) : undefined,
      });
      persist();
      updateStatus(ctx);
      if (decision?.outcome === "accepted") {
        details.completion = "accepted";
        return await finalize(current, token, details, ctx, usage, signal, id);
      }
      if (n.phase === "paused") {
        shownThisRun = true;
        // Show the durable outcome before asking once. Already-paused calls and restores never enter here.
        safely(() => onUpdate?.({ content: [{ type: "text", text: pauseText(n) }], details } as never));
        if (!signal?.aborted && !ctx.signal?.aborted) {
          const result = await presentPause(current, token, ctx, "tool", signal);
          if (!live(current, token)) return text("Execution changed; discarded stale recovery choice.");
          return finalResult(
            {
              ...result,
              content: result.details
                ? result.content
                : [
                    {
                      type: "text",
                      text: `${finishMessageText(details)}\n\n${result.content.map((part) => part.text).join("\n")}`,
                    },
                  ],
              details: result.details ?? details,
              ...(usage ? { usage } : {}),
            },
            id,
          ) as never;
        }
      }
      return finalResult(
        {
          content: [
            {
              type: "text",
              text: `${finishMessageText(details)}\n\n${n.phase === "paused" ? pauseText(n) : "Exec remains active. Fix the findings or provide evidence-backed disputes, then submit finish_plan with a response for every finding."}`,
            },
          ],
          details,
          ...(usage ? { usage } : {}),
          ...(n.phase === "paused" ? { terminate: true } : {}),
        },
        id,
      ) as never;
    },
  });

  const showStatus = (ctx: ExtensionContext) => {
    if (!state?.active) {
      ctx.ui.notify(NOT_ACTIVE, "info");
      return;
    }
    const n = state.negotiation!;
    const message = state.pendingCompletion
      ? `${WORK_MODEL_UNAVAILABLE}\nUse /plan-exec retry to finish the saved handoff without another review.`
      : n.phase === "paused"
        ? `${pauseText(n)}\nRecovery: /plan-exec for choices, /plan-exec accept or /plan-exec stop.`
        : `${busy ? `Implementation active · ${n.phase}. Completion has not been confirmed.` : "Implementation is idle; completion has not been confirmed. Reply to continue or change direction."}\nUse /plan-exec stop to abandon implementation.`;
    ctx.ui.notify(message, "info");
  };

  pi.events.on(FOOTER_ACTIONS_CHANNEL, (data: unknown) => {
    const request = data as FooterActionsRequest | undefined;
    const ctx = hostCtx;
    const current = state;
    if (request?.version !== 1 || !request.actions || !ctx?.hasUI || !current?.active) return;
    const token = epoch;
    const manager = ctx.sessionManager;
    const sessionId = manager.getSessionId?.();
    request.actions["execution.status"] = {
      label: "Execution status",
      run: () => {
        if (
          live(current, token) &&
          current.active &&
          hostCtx?.sessionManager === manager &&
          manager.getSessionId?.() === sessionId
        ) {
          if (hostCtx.hasUI) void presentNext(hostCtx, "menu");
          else showStatus(hostCtx);
        }
      },
    };
  });

  pi.registerCommand("plan-exec", {
    description: "Show implementation status or paused recovery choices; status, retry, resume <answer>, accept, stop",
    handler: async (args, ctx) => {
      const current = state;
      const [action, ...words] = args.trim().split(/\s+/u);
      if (!current?.active || (action === "status" && words.length === 0)) {
        showStatus(ctx);
        return;
      }
      const token = epoch;
      const n = current.negotiation!;
      if (!action) {
        if (ctx.hasUI) await presentNext(ctx, "menu");
        else showStatus(ctx);
        return;
      }
      if (action === "resume" && current.pendingQuestion && words.join(" ").trim()) {
        await answerPendingQuestion(current, token, ctx, words.join(" ").trim());
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait until the implementer is idle.", "warning");
        return;
      }
      if (
        action &&
        (!["retry", "resume", "accept", "stop"].includes(action) ||
          (action !== "resume" && words.length > 0) ||
          (action === "resume" && !words.join(" ").trim()))
      ) {
        ctx.ui.notify("Usage: /plan-exec [status | retry | resume <answer> | accept | stop]", "warning");
        return;
      }
      const result = action
        ? await applyAction(
            current,
            token,
            action as Action,
            ctx,
            "command",
            action === "resume" ? words.join(" ") : undefined,
          )
        : text("");
      // Preserve silent confirmation cancellation and command continuation behavior. Only status
      // requests and refused actions need a notification; obsolete dialogs must not post anywhere.
      const refused =
        ((action === "retry" || action === "resume") && current.negotiation === n) ||
        (action === "accept" && (!ctx.hasUI || n.phase !== "paused"));
      if (live(current, token) && current.active && (!action || refused || current.pendingCompletion))
        ctx.ui.notify(result.content.map((part) => part.text).join("\n"), refused ? "warning" : "info");
    },
  });

  // Explicit recovery of legacy saved returns; normal completion stays on the current branch.
  pi.on("agent_settled", (event, ctx) => {
    busy = false;
    updateStatus(ctx);
    if (!state?.active) return;
    const current = state;
    if (stopRequested) {
      stopRequested = false;
      void applyAction(current, epoch, "stop", ctx, "command");
      return;
    }
    let draft = "";
    let queued = false;
    try {
      draft = ctx.ui.getEditorText?.() ?? "";
      queued = ctx.hasPendingMessages?.() ?? false;
    } catch {
      // A UI without a readable editor: treat it as empty.
    }
    if (!ctx.hasUI || shownThisRun || queued || draft.trim()) return;
    const n = current.negotiation!;
    const needsYou = Boolean(current.pendingQuestion || current.pendingCompletion || n.phase === "paused");
    const stalled =
      !event.aborted &&
      implementationDriven &&
      !current.pendingQuestion &&
      (n.phase === "implementing" || n.phase === "revising");
    // Never await a dialog here: settlement must finish first.
    if (needsYou) void presentNext(ctx, "menu");
    else if (stalled) void presentNext(ctx, "settle");
  });
  pi.registerMessageRenderer(PLANNER_ANSWER_MESSAGE_TYPE, (message, options, theme) =>
    renderAsk(message.details as AskDetails | undefined, { expanded: options.expanded, isPartial: false }, theme),
  );
  pi.registerMessageRenderer(
    EXEC_CONTINUE_MESSAGE_TYPE,
    (message, _options, theme) =>
      new Text(theme.fg("muted", typeof message.content === "string" ? message.content : ""), 0, 0),
  );
  pi.registerMessageRenderer(
    EXEC_STATUS_MESSAGE_TYPE,
    (message, _options, theme) =>
      new Text(
        theme.fg("muted", typeof message.content === "string" ? message.content : "Implementation remains active."),
        0,
        0,
      ),
  );
  pi.registerCommand(BACK_COMMAND, {
    description: "Recover a saved legacy return to the planning branch (explicit only)",
    handler: async (_args, ctx) => {
      const back = pendingReturn;
      if (!back || !ctx.isIdle()) return;
      const token = epoch;
      const owner = state;
      const sessionId = ctx.sessionManager.getSessionId();
      // Asked while still on the implementation branch, where the turn it recaps is.
      const headline = await recapHeadline(pi, 5_000);
      if (epoch !== token || state !== owner || pendingReturn !== back) return;
      // Keep the files: the implementation's changes are the point, and pi-rewind (when loaded) would
      // otherwise offer to restore them to how they were at the plan.
      try {
        pi.events.emit("rewind:keep-files", {});
      } catch {
        // No event bus.
      }
      // Clear durably on the source branch before leaving it, not on the destination branch.
      pendingReturn = undefined;
      if (owner) {
        owner.pendingReturn = undefined;
        persist();
      }
      // persist() appended the clearing entry and advanced the source leaf. Compare against
      // that leaf, not the pre-persist leaf, when deciding whether a failed return is retryable.
      const sourceLeaf = ctx.sessionManager.getLeafId?.();
      try {
        // No model summary of the branch: the implementer's report is the summary, and it goes in as a
        // message the planner reads.
        await ctx.navigateTree(back.leaf, { summarize: false });
      } catch (error: unknown) {
        const leaf = ctx.sessionManager.getLeafId?.();
        if (
          epoch === token &&
          state === owner &&
          ctx.sessionManager.getSessionId() === sessionId &&
          (!sourceLeaf || leaf === sourceLeaf)
        ) {
          pendingReturn = back;
          if (owner) {
            owner.pendingReturn = back;
            persist();
          }
        }
        ctx.ui.notify(
          `Could not return to the planning conversation: ${error instanceof Error ? error.message : String(error)}. Retry /plan-back (the completion report is saved), or use /tree.`,
          "warning",
        );
        return;
      }
      // Our own navigation may cause exactly one session_tree restore. Any other epoch/session/leaf
      // change is external and must not receive a stale completion message or tombstone.
      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        (epoch !== token && (epoch !== token + 1 || state?.active))
      )
        return;
      const leaf = ctx.sessionManager.getLeafId?.();
      if (leaf && leaf !== back.leaf) return;
      pendingReturn = undefined;
      const details: FinishDetails = { ...back.details, ...(headline ? { headline } : {}) };
      pi.sendMessage(finishDelivery(details));
    },
  });
  pi.registerMessageRenderer<FinishDetails>(FINISH_MESSAGE_TYPE, (message, options, theme) =>
    reviewCard(
      theme,
      finishTitle(message.details),
      renderFinish(
        message.details,
        { expanded: options.expanded, isPartial: false, omitTitle: true },
        theme,
        currentExchange,
      ),
      finishTone(message.details),
    ),
  );

  // Tripwire: a note on the first edit of each file the plan does not list. It never blocks.
  pi.on("tool_result", (event, ctx) => {
    if (!state?.active || event.isError) return undefined;
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const file = resolve(ctx.cwd, expandHome(String((event.input as { path?: unknown })?.path ?? "")));
    if (!isPlanFile(file, ctx.cwd, state.planFile)) {
      touched.add(file);
      persist();
    }
    if (noted.has(file)) return undefined;
    const hasPlanner = Boolean(state.planner);
    let note: string | undefined;
    if (isPlanFile(file, ctx.cwd, state.planFile)) {
      if (hasPlanner) {
        note =
          "Note: this is the plan file, which the planner amends. Ask the planner (ask_planner) instead of editing it, unless the user asked you to.";
      }
    } else {
      const paths = planPaths(readPlan(state.planFile));
      if (paths.length > 0 && !inPlan(file, ctx.cwd, paths)) {
        const rel = relative(ctx.cwd, file);
        note = hasPlanner
          ? `Note: ${rel} is not one of the files the plan changes. If changing it departs from the plan, ask_planner before you go further; if the plan implies it (a lockfile, a generated file, a fixture), carry on.`
          : `Note: ${rel} is not one of the files the plan changes. If changing it departs from the plan, record that under the plan file's ## Amendments and mention it in your report; if the plan implies it (a lockfile, a generated file, a fixture), carry on.`;
      }
    }
    noted.add(file);
    if (!note) return undefined;
    return { content: [...event.content, { type: "text" as const, text: note }] };
  });

  return {
    get active() {
      return state?.active === true;
    },
    get state() {
      return state ? structuredClone(state) : undefined;
    },
    async menu(ctx: ExtensionContext) {
      await presentNext(ctx, "menu");
      return state?.active ? "kept" : "stopped";
    },
    begin,
  };
}

function validPendingQuestion(value: unknown): value is NonNullable<ExecState["pendingQuestion"]> {
  if (!value || typeof value !== "object") return false;
  const pq = value as Record<string, unknown>;
  if (typeof pq.id !== "string" || typeof pq.implementerMessage !== "string") return false;
  if (pq.plannerNote !== undefined && typeof pq.plannerNote !== "string") return false;
  return normalizePlanModeQuestionParams({ questions: pq.questions }).ok;
}

function validState(data: unknown): ExecState | undefined {
  if (!data || typeof data !== "object") return undefined;
  const entry = data as Partial<ExecState>;
  if (typeof entry.active !== "boolean" || typeof entry.planFile !== "string" || !entry.planFile) return undefined;
  if (!entry.active && !entry.pendingReturn) return undefined;
  const negotiation = entry.negotiation === undefined ? undefined : restoreNegotiation(entry.negotiation);
  if (entry.negotiation !== undefined && !negotiation) return undefined;
  const linkedFlow = entry.linkedFlow === undefined ? undefined : parseLinkedFlow(entry.linkedFlow);
  if (entry.linkedFlow !== undefined && !linkedFlow) return undefined;
  const pendingCompletion = entry.pendingCompletion;
  if (
    pendingCompletion &&
    (!linkedFlow ||
      !pendingCompletion.report ||
      pendingCompletion.planFile !== entry.planFile ||
      !["accepted", "no_review", "user_override", "stopped"].includes(pendingCompletion.completion ?? "") ||
      !restoreNegotiation(pendingCompletion.negotiation))
  )
    return undefined;
  const planner = entry.planner;
  const valid =
    planner &&
    typeof planner.spec === "string" &&
    typeof planner.name === "string" &&
    typeof planner.sessionFile === "string";
  return {
    active: entry.active,
    planFile: entry.planFile,
    ...(negotiation ? { negotiation } : {}),
    ...(linkedFlow ? { linkedFlow } : {}),
    ...(pendingCompletion ? { pendingCompletion: structuredClone(pendingCompletion) } : {}),
    ...(entry.completion && typeof entry.completion.report === "string"
      ? { completion: structuredClone(entry.completion) }
      : {}),
    ...(validPendingQuestion(entry.pendingQuestion) ? { pendingQuestion: structuredClone(entry.pendingQuestion) } : {}),
    ...(Array.isArray(entry.touched) && entry.touched.every((p) => typeof p === "string")
      ? { touched: [...entry.touched] }
      : {}),
    ...(entry.pendingReturn &&
    typeof entry.pendingReturn.leaf === "string" &&
    entry.pendingReturn.details &&
    typeof entry.pendingReturn.details.report === "string"
      ? { pendingReturn: structuredClone(entry.pendingReturn) }
      : {}),
    implementer: typeof entry.implementer === "string" ? entry.implementer : "this model",
    implementerModel: typeof entry.implementerModel === "string" ? entry.implementerModel : "",
    ...(valid ? { planner: { spec: planner.spec, name: planner.name, sessionFile: planner.sessionFile } } : {}),
    ...(typeof entry.restore === "string" ? { restore: entry.restore } : {}),
    ...(typeof entry.restoreName === "string" ? { restoreName: entry.restoreName } : {}),
    ...(typeof entry.returnTo === "string" ? { returnTo: entry.returnTo } : {}),
    asks: Number.isSafeInteger(entry.asks) && entry.asks! >= 0 ? entry.asks! : 0,
    costUsd:
      typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd) && entry.costUsd >= 0 ? entry.costUsd : 0,
  };
}

function parseLinkedFlow(value: unknown): FlowState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const flow = value as Partial<FlowState>;
  if (
    flow.version !== 1 ||
    flow.operatingMode !== "linked" ||
    typeof flow.revision !== "number" ||
    !Number.isSafeInteger(flow.revision) ||
    flow.revision < 0
  )
    return undefined;
  const selected = flow.selectedFlow;
  if (
    !selected ||
    typeof selected.provider !== "string" ||
    !selected.provider.trim() ||
    typeof selected.anchorModel !== "string" ||
    !selected.anchorModel.trim()
  )
    return undefined;
  for (const role of ["work", "chat", "plan", "exec"] as const) {
    const assignment = selected.roles?.[role];
    if (
      !assignment ||
      assignment.provider !== selected.provider ||
      typeof assignment.modelId !== "string" ||
      !assignment.modelId.trim() ||
      (assignment.suggestedThinking !== undefined && typeof assignment.suggestedThinking !== "string")
    )
      return undefined;
  }
  return { version: 1, operatingMode: "linked", revision: flow.revision, selectedFlow: structuredClone(selected) };
}

function gitShortstat(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      execFile("git", ["--no-optional-locks", "diff", "--shortstat", "HEAD"], { cwd, timeout: 4000 }, (error, stdout) =>
        done(error ? undefined : stdout.trim() || undefined),
      );
    } catch {
      done(undefined);
    }
  });
}

async function summarizeChanges(state: ExecState, touched: ReadonlySet<string>, cwd: string): Promise<ChangeSummary> {
  const files = [...touched];
  const paths = planPaths(readPlan(state.planFile));
  const shown = (list: string[]) => list.map((file) => relative(cwd, file) || file).sort();
  const git = await gitShortstat(cwd);
  return {
    edited: shown(files),
    outside: paths.length > 0 ? shown(files.filter((file) => !inPlan(file, cwd, paths))) : [],
    ...(git ? { git } : {}),
  };
}

/** pi-recap's one-line recap of the turn just ended, when it is loaded; undefined otherwise or when slow. */
async function recapHeadline(pi: ExtensionAPI, timeoutMs: number): Promise<string | undefined> {
  let answer: Promise<string | undefined> | undefined;
  try {
    pi.events.emit("recap:summary", {
      reply: (summary: Promise<string | undefined>) => {
        answer = summary;
      },
    });
  } catch {
    return undefined;
  }
  if (!answer) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), timeoutMs);
  });
  try {
    return (await Promise.race([answer, slow]))?.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** What the planner reads once it is back: the implementer's report and what it touched. */
function finishMessageText(details: FinishDetails): string {
  return [
    details.completion === "accepted"
      ? "Accepted"
      : details.completion === "no_review"
        ? "Completed without review"
        : details.completion === "user_override"
          ? "Completed by user override"
          : details.completion === "stopped"
            ? "Implementation stopped"
            : "Implementation review",
    ...(details.negotiation ? ["", negotiationText(details.negotiation)] : []),
    ...(details.headline ? ["", details.headline] : []),
    "",
    "What changed (implementer reported)",
    details.report || "Not provided.",
    "",
    "Verification (implementer reported)",
    details.verification || "Not provided; verification is unknown.",
    "",
    "Outstanding issues (implementer reported)",
    details.concerns || "Not provided; outstanding issues are unknown.",
    "",
    "Planner assessment",
    assessmentSummary(details),
    decisionText(details.decision),
    responsesText(details.responses),
    ...(details.previousFindings?.length ? [decisionText({ findings: details.previousFindings })] : []),
    ...(details.error ? [`Review error: ${details.error}`] : []),
    // Modern assessments also retain the raw protocol reply; its parsed decision is above.
    ...(details.assessment?.state === "reviewed" && !details.decision ? [details.assessment.narrative] : []),
    ...(details.question ? ["", "User question", details.question] : []),
    ...(details.action ? ["", "Next action", details.action] : []),
    "",
    changeSummaryText(details.changes),
    "",
    finishContext(details),
  ].join("\n");
}

function pauseText(n: NegotiationState): string {
  if (n.phase !== "paused") return `Implementation active · ${n.phase}. Completion has not been confirmed.`;
  if (n.pause?.action === WORK_MODEL_UNAVAILABLE) return WORK_MODEL_UNAVAILABLE;
  const presentation = pausePresentation(n);
  return [presentation.title, presentation.question, presentation.reason, presentation.next].filter(Boolean).join("\n");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
