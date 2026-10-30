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
  type AskDetails,
  assessmentSummary,
  type ChangeSummary,
  changeSummaryText,
  ExecCardRefresh,
  type FinishDetails,
  finishContext,
  finishTone,
  renderAsk,
  renderFinish,
} from "./exec-cards.js";
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
import { inPlan, isPlanFile, planPaths, readPlan, tildify } from "./plan-file.js";
import { expandHome } from "./plan-hook.js";
import { type PlannerAccessConfig, PlannerAgent } from "./planner/agent.js";
import { CONSULT_WRAP_UP, consultMessage, reviewRequest } from "./planner/prompt.js";
import { type PlannerSessionFactory, plannerSessionDir } from "./planner/session.js";
import { formatCost } from "./planners.js";
import { reviewCard, reviewTitle } from "./review-card.js";
import { emptyUsage, type Usage } from "./scout-process.js";

export const EXEC_ENTRY = "plan-mode:exec";
export const EXEC_STATUS_KEY = "plan-exec";
export const ASK_TOOL = "ask_planner";
export const BACK_COMMAND = "plan-back";
export const FINISH_MESSAGE_TYPE = "plan-mode-finish";
export const FINISH_TOOL = "finish_plan";
export const EXEC_TOOLS = [FINISH_TOOL, ASK_TOOL] as const;
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
  /** Model spec to return to when finish_plan ends exec mode */
  restore?: string;
  /** The planning conversation's last entry, which finish_plan navigates back to (in-place handoffs). */
  returnTo?: string;
  asks: number;
  costUsd: number;
  negotiation?: NegotiationState;
  touched?: string[];
  pendingReturn?: { leaf: string; details: FinishDetails };
  completion?: FinishDetails;
}

export interface ExecHost {
  /** What the planner on call on `spec` may use (planner/access.ts consultantAccess). */
  consultantAccess(ctx: ExtensionContext, planFile: string, spec: ModelSpec): PlannerAccessConfig;
  createSession?: PlannerSessionFactory;
  restoreModel(ctx: ExtensionContext, spec: ModelSpec): Promise<unknown>;
  completionReview(): boolean;
  completionMaxRevisions(): number;
}

export interface ExecController {
  readonly active: boolean;
  begin(ctx: ExtensionContext, state: ExecState, options: { record: boolean }): void;
}

const NOT_ACTIVE = "No approved plan is being implemented.";

export function registerExec(pi: ExtensionAPI, host: ExecHost): ExecController {
  let state: ExecState | undefined;
  let epoch = 0;
  const cards = new ExecCardRefresh();
  const currentExchange = () => {
    const n = state?.active ? state.negotiation : undefined;
    const last = n?.history.at(-1);
    return n
      ? {
          executionId: n.executionId,
          exchangeId: n.latestExchangeId,
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
      const phase =
        n?.phase === "reviewing"
          ? `review ${n.attempts}`
          : n?.phase === "revising"
            ? `revising · ${outstanding(n).length} findings`
            : n?.phase === "paused"
              ? `paused · ${n.pause?.reason === "user_needed" || n.pause?.reason === "exhausted" ? "user needed" : "review unavailable"}`
              : (n?.phase ?? "implementing");
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
    setToolsActive(pi, [FINISH_TOOL], Boolean(state?.active));
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
    epoch++;
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
    if (options.record) persist();
    setTools();
    updateStatus(ctx);
    publishActive();
  };

  const end = (ctx: ExtensionContext) => {
    if (!state) return;
    state.active = false;
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
  ) => {
    if (!live(current, token)) return text("Execution changed; finalization discarded.");
    if (current.returnTo && ctx.hasUI && details.completion !== "stopped") {
      pendingReturn = { leaf: current.returnTo, details: structuredClone(details) };
      current.pendingReturn = pendingReturn;
    }
    current.completion = structuredClone(details);
    end(ctx);
    if (details.completion !== "stopped") {
      const spec = parseModelSpec(current.restore);
      const now = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      if (spec && now === current.implementerModel) {
        let restored = false;
        try {
          restored = (await host.restoreModel(ctx, spec)) !== false;
        } catch {
          /* The final report remains durable even when restoration fails. */
        }
        if (!live(current, token)) return text("Execution changed during model restoration.");
        if (restored && current.planner) details.returnedTo = current.planner.name;
        if (!restored) details.action = "Planning model restoration failed; select the model manually.";
      }
    }
    if (live(current, token)) {
      current.completion = structuredClone(details);
      persist();
    }
    if (pendingReturn && live(current, token)) {
      pendingReturn.details = structuredClone(details);
      current.pendingReturn = pendingReturn;
      persist();
    }
    return {
      content: [{ type: "text", text: `${finishMessageText(details)}\n\nExec mode is over. Stop here.` }],
      details,
      ...(usage ? { usage } : {}),
      terminate: true,
    } as never;
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
    pendingReturn = state?.pendingReturn;
    if (state) {
      for (const file of state.touched ?? []) touched.add(file);
      state.negotiation ??= createNegotiation(randomUUID(), host.completionMaxRevisions?.() ?? 2);
      const n = state.negotiation;
      if (n.phase === "reviewing" || n.phase === "consulting") {
        if (n.phase === "reviewing") n.history.at(-1)!.error = "Review interrupted by reload.";
        n.phase = "paused";
        n.pause = { reason: "interrupted", action: "Exchange interrupted by reload; no paid request was retried." };
      }
      persist();
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

  pi.registerTool({
    name: ASK_TOOL,
    ...flags,
    ...{ ccstyleOwnResult: true },
    label: "Ask planner",
    description:
      "Ask the planner that wrote the plan you are implementing, and wait for its answer. It keeps its full research context and can read the current files, including your changes. Use it when the plan does not fit what you find: a step cannot be done as written, a fact it states is wrong, a change it does not list is needed, or it leaves a choice open. It answers with a decision, and amends the plan file when the plan changes.",
    promptSnippet: "Ask the plan's planner when the plan does not fit what you find",
    promptGuidelines: [
      "While implementing an approved plan with its planner on call, call ask_planner instead of improvising whenever the plan does not fit what you find. Say what you found, where, and the options you see; follow its answer, and ask the user when it says the decision is theirs.",
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
    async execute(_id, params: unknown, signal, onUpdate, ctx) {
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
        const error = "The planner's session is missing; ask the user about anything the approved plan leaves open.";
        return {
          content: [{ type: "text", text: error }],
          details: {
            question: message,
            planner: current.planner.name,
            error,
            executionId: n.executionId,
            number: current.asks + 1,
          },
        } as never;
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
      try {
        result = await planner.consult(consultMessage(message, "implementer"), ctx, "implementer", signal, message);
      } catch (error) {
        if (!live(current, token)) return text("Execution changed; discarded stale consultation.");
        n.phase = previousPhase;
        disposeAgent();
        persist();
        updateStatus(ctx);
        return {
          content: [{ type: "text", text: `Planner consultation failed: ${String(error)}` }],
          details: { ...askIdentity, question: message, planner: name, error: String(error) },
        } as never;
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      }
      if (!live(current, token)) return text("Execution changed; discarded stale planner response.");
      n.phase = previousPhase;
      if (signal?.aborted || result.error) disposeAgent();
      record(result.usage, ctx);
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
        return {
          content: [
            {
              type: "text",
              text: `The planner failed: ${result.error}. Decide within the plan, and ask the user about anything it leaves open.`,
            },
          ],
          details: {
            ...askIdentity,
            error: result.error,
            question: message,
            planner: name,
            costUsd: result.usage.cost.total,
          } satisfies AskDetails,
          usage: result.usage,
        } as never;
      }
      const after = readPlan(current.planFile);
      const changes = before === after ? [] : planDiff(before, after);
      const reply = result.reply.trim();
      const body = `The planner answered:\n\n${reply || "(it answered with no text)"}`;
      const amended =
        changes.length > 0
          ? `\n\nIt amended the plan (${tildify(current.planFile)}):\n${planDiffText(changes)}\n\nFollow the amended plan.`
          : "";
      return {
        content: [{ type: "text", text: `${body}${amended}` }],
        details: {
          ...askIdentity,
          question: message,
          reply,
          planner: name,
          changes,
          costUsd: result.usage.cost.total,
        } satisfies AskDetails,
        usage: result.usage,
      } as never;
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
    async execute(_id, params: unknown, signal, onUpdate, ctx) {
      hostCtx = ctx;
      const current = state;
      if (!current?.active) return text(NOT_ACTIVE);
      const token = epoch;
      let n = current.negotiation!;
      if (n.phase === "paused") {
        const previous = n.history.at(-1);
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
      const saved = n.latestReport;
      const submission = n.history.at(-1)?.error && saved ? saved : { report, verification, concerns };
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
        return await finalize(current, token, details, ctx);
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
      try {
        if (!current.planner) details.assessment = { state: "unavailable", reason: "No planner is on call." };
        else {
          const planner = consultant(ctx, "review");
          if (!planner) {
            details.assessment = { state: "unavailable", reason: "The planner's session is missing or invalid." };
          } else {
            const baseline = planner.stats.costUsd;
            const baselineTokens = planner.stats.totalTokens;
            const progress = () => {
              if (!live(current, token)) return;
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
              if (!live(current, token)) return text("Execution changed; discarded stale review.");
              usage = result?.usage;
              const costUsd = Math.max(usage?.cost.total ?? 0, planner.stats.costUsd - baseline, 0);
              if (interrupted && (!usage || usage.cost.total < costUsd)) {
                usage = emptyUsage();
                usage.cost.total = costUsd;
                usage.totalTokens = Math.max(0, planner.stats.totalTokens - baselineTokens);
              }
              reviewCost = costUsd;
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
              clearTimeout(timer);
              unsubscribe();
              signal?.removeEventListener("abort", onAbort);
            }
          }
        }
      } catch (error: unknown) {
        details.assessment = { state: "failed", reason: error instanceof Error ? error.message : String(error) };
      }
      if (!live(current, token)) return text("Execution changed; discarded stale review.");
      let error =
        details.assessment?.state === "failed" || details.assessment?.state === "unavailable"
          ? details.assessment.reason
          : undefined;
      n = finishReview(n, { decision, error, costUsd: reviewCost });
      error = n.history.at(-1)?.error ?? error;
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
        return await finalize(current, token, details, ctx, usage);
      }
      return {
        content: [
          {
            type: "text",
            text: `${finishMessageText(details)}\n\n${n.phase === "paused" ? pauseText(n) : "Exec remains active. Fix the findings or provide evidence-backed disputes, then submit finish_plan with a response for every finding."}`,
          },
        ],
        details,
        ...(usage ? { usage } : {}),
        ...(n.phase === "paused" ? { terminate: true } : {}),
      } as never;
    },
  });

  pi.registerCommand("plan-exec", {
    description: "Inspect or explicitly recover a paused implementation: retry, resume <answer>, accept, stop",
    handler: async (args, ctx) => {
      const current = state;
      if (!current?.active) {
        ctx.ui.notify(NOT_ACTIVE, "info");
        return;
      }
      const token = epoch;
      const n = current.negotiation!;
      const [action, ...words] = args.trim().split(/\s+/u);
      const findings = outstanding(n)
        .map((f) => `${f.id}: ${f.title}\n${f.detail}\nRequested: ${f.requestedChange}`)
        .join("\n\n");
      if (!action) {
        ctx.ui.notify(`${n.phase}\n${findings}\n${pauseText(n)}`, "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait until the implementer is idle.", "warning");
        return;
      }
      if ((action === "stop" || action === "accept") && words.length) {
        ctx.ui.notify("Usage: /plan-exec [retry | resume <answer> | accept | stop]", "warning");
        return;
      }
      if (action === "stop") {
        const report = n.latestReport ?? {
          report: "Implementation stopped.",
          verification: "Not provided.",
          concerns: "Execution abandoned; no completion claimed.",
        };
        const details: FinishDetails = {
          ...report,
          planFile: current.planFile,
          negotiation: structuredClone(n),
          completion: "stopped",
          executionId: n.executionId,
        };
        current.pendingReturn = undefined;
        pendingReturn = undefined;
        await finalize(current, token, details, ctx);
        if (live(current, token))
          pi.sendMessage({
            customType: FINISH_MESSAGE_TYPE,
            content: finishMessageText(details),
            details,
            display: true,
          });
        return;
      }
      if (action === "accept") {
        if (n.phase !== "paused") {
          ctx.ui.notify("Only a paused execution can be overridden.", "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("A UI confirmation is required; execution remains paused.", "warning");
          return;
        }
        const release = holdBlocked(pi.events, "Finish without planner acceptance?");
        let answer: string | undefined;
        try {
          answer = await ctx.ui.select("Finish without planner acceptance?", ["Finish without review", "Keep paused"]);
        } finally {
          release();
        }
        if (!live(current, token) || answer !== "Finish without review" || !ctx.isIdle()) return;
        const details: FinishDetails = {
          ...(n.latestReport ?? { report: "No report submitted.", verification: "Unknown.", concerns: "Unreviewed." }),
          planFile: current.planFile,
          negotiation: structuredClone(n),
          decision: n.history.at(-1)?.decision,
          completion: "user_override",
          executionId: n.executionId,
          asks: current.asks,
          costUsd: current.costUsd,
        };
        await finalize(current, token, details, ctx);
        if (live(current, token) && pendingReturn)
          pi.sendUserMessage(`/${BACK_COMMAND}`, { expandPromptTemplates: true });
        if (live(current, token))
          pi.sendMessage({
            customType: FINISH_MESSAGE_TYPE,
            content: finishMessageText(details),
            details,
            display: true,
          });
        return;
      }
      if (
        (action !== "retry" && action !== "resume") ||
        (action === "retry" && words.length) ||
        (action === "resume" && !words.join(" ").trim())
      ) {
        ctx.ui.notify("Usage: /plan-exec [retry | resume <answer> | accept | stop]", "warning");
        return;
      }
      try {
        current.negotiation = recoverNegotiation(n, action);
      } catch (error) {
        ctx.ui.notify(String(error), "warning");
        return;
      }
      if (action === "resume") {
        current.negotiation.userAnswers ??= [];
        current.negotiation.userAnswers.push(words.join(" "));
      }
      disposeAgent();
      persist();
      updateStatus(ctx);
      pi.sendUserMessage(
        action === "retry"
          ? "The user authorized one retry of the interrupted/failed completion review. Resubmit finish_plan using the saved report and finding responses; do not make unrelated changes. No revision counts were reset."
          : `The user resumed this implementation. User-provided evidence/answer (not independent automated verification): ${words.join(" ")}\nOutstanding findings:\n${findings}\nAddress these in the existing context, then submit finish_plan with per-finding responses. An exhausted budget gets one additional revision-and-review cycle only; further extensions require another explicit /plan-exec resume command.`,
      );
    },
  });

  // Back to the planning conversation: a tool cannot navigate the session tree, a command can, and a
  // command sent once the turn has settled runs outside the streaming turn.
  pi.on("agent_settled", (event) => {
    if (!pendingReturn) return;
    // Keep the report available to /plan-back even when review cancellation aborts the turn.
    if (event.aborted) return;
    pi.sendUserMessage(`/${BACK_COMMAND}`, { expandPromptTemplates: true });
  });
  pi.registerCommand(BACK_COMMAND, {
    description: "Return to the planning conversation after an implementation (runs by itself)",
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
      pi.sendMessage({
        customType: FINISH_MESSAGE_TYPE,
        content: finishMessageText(details),
        details,
        display: true,
      });
    },
  });
  pi.registerMessageRenderer<FinishDetails>(FINISH_MESSAGE_TYPE, (message, options, theme) =>
    reviewCard(
      theme,
      message.details?.completion === "stopped"
        ? "Implementation stopped"
        : message.details?.completion === "accepted"
          ? "Accepted"
          : message.details?.completion === "no_review"
            ? "Completed without review"
            : message.details?.completion === "user_override"
              ? "Completed by user override"
              : "Implementation review",
      renderFinish(message.details, { expanded: options.expanded, isPartial: false }, theme, currentExchange),
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
    begin,
  };
}

function validState(data: unknown): ExecState | undefined {
  if (!data || typeof data !== "object") return undefined;
  const entry = data as Partial<ExecState>;
  if (typeof entry.active !== "boolean" || typeof entry.planFile !== "string" || !entry.planFile) return undefined;
  if (!entry.active && !entry.pendingReturn) return undefined;
  const negotiation = entry.negotiation === undefined ? undefined : restoreNegotiation(entry.negotiation);
  if (entry.negotiation !== undefined && !negotiation) return undefined;
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
    ...(entry.completion && typeof entry.completion.report === "string"
      ? { completion: structuredClone(entry.completion) }
      : {}),
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
    ...(typeof entry.returnTo === "string" ? { returnTo: entry.returnTo } : {}),
    asks: Number.isSafeInteger(entry.asks) && entry.asks! >= 0 ? entry.asks! : 0,
    costUsd:
      typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd) && entry.costUsd >= 0 ? entry.costUsd : 0,
  };
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
    ...(details.negotiation
      ? [
          "",
          `Negotiation record (${details.negotiation.attempts} review rounds; cumulative review cost ${formatCost(details.negotiation.reviewCostUsd)}):`,
          JSON.stringify(details.negotiation, null, 2),
        ]
      : []),
    ...(details.headline ? ["", details.headline] : []),
    "",
    "What changed",
    details.report || "Not provided.",
    "",
    "Verification",
    details.verification || "Not provided; verification is unknown.",
    "",
    "Outstanding issues",
    details.concerns || "Not provided; outstanding issues are unknown.",
    "",
    "Planner assessment",
    assessmentSummary(details),
    ...(details.assessment?.state === "reviewed" ? [details.assessment.narrative] : []),
    ...(details.question ? ["", "User question", details.question] : []),
    ...(details.action ? ["", "Next action", details.action] : []),
    "",
    changeSummaryText(details.changes),
    "",
    finishContext(details),
  ].join("\n");
}

function pauseText(n: NegotiationState): string {
  const recovery =
    n.pause?.reason === "failure" || n.pause?.reason === "interrupted"
      ? "/plan-exec retry to authorize one review retry using the saved report."
      : n.pause?.reason === "exhausted"
        ? "/plan-exec resume <answer> to provide evidence and authorize one extra revision-and-review cycle."
        : "/plan-exec resume <answer> to provide the requested user answer or evidence and resume implementation.";
  return `Exec ${n.phase}. ${n.pause?.action ?? ""}${n.pause?.question ? `\nQuestion: ${n.pause.question}` : ""}\nUser recovery: ${recovery}\nOr /plan-exec accept for a confirmed unreviewed override, or /plan-exec stop to abandon execution without claiming completion. No automatic retry; agents cannot authorize recovery.`;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
