// Exec mode: a mode of your main chat while an approved plan is being implemented. The footer shows
// it where the permission mode is (status `plan-exec`; the permission mode underneath still decides
// what runs), the planner that wrote the plan can stay on call through ask_planner, edits to files
// the plan does not list get a note once, and finish_plan ends it with a structured completion report
// and an optional informational planner assessment, both shown in the transcript. It is entered only by approving a plan (plan.ts
// calls `begin`; no key cycles to it) and ended by finish_plan, or replaced by approving a newer plan.
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { setToolsActive } from "./active-tools.js";
import { type ModelSpec, parseModelSpec } from "./implementation-models.js";
import { PlanMarkdown } from "./mermaid-art.js";
import { type DiffLine, planDiff, planDiffText, renderPlanDiff } from "./plan-diff.js";
import { inPlan, isPlanFile, planPaths, planTitle, readPlan, tildify } from "./plan-file.js";
import { expandHome } from "./plan-hook.js";
import { type PlannerAccessConfig, PlannerAgent } from "./planner/agent.js";
import { CONSULT_WRAP_UP, consultMessage, reviewRequest, reviewVerdict } from "./planner/prompt.js";
import { type PlannerSessionFactory, plannerSessionDir } from "./planner/session.js";
import { formatCost } from "./planners.js";
import { COLLAPSED_LINES, type ReviewTone, reviewCard, reviewStatusLine, reviewTitle } from "./review-card.js";
import type { Usage } from "./scout-process.js";

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
}

export interface ExecHost {
  /** What the planner on call on `spec` may use (planner/access.ts consultantAccess). */
  consultantAccess(ctx: ExtensionContext, planFile: string, spec: ModelSpec): PlannerAccessConfig;
  createSession?: PlannerSessionFactory;
  restoreModel(ctx: ExtensionContext, spec: ModelSpec): Promise<unknown>;
  completionReview(): boolean;
}

export interface ExecController {
  readonly active: boolean;
  begin(ctx: ExtensionContext, state: ExecState, options: { record: boolean }): void;
}

interface AskDetails {
  question: string;
  reply?: string;
  planner: string;
  changes?: DiffLine[];
  costUsd?: number;
  pending?: boolean;
  activity?: string;
}

/** What the implementation touched, for the user's decision. */
interface ChangeSummary {
  /** Files the agent edited or wrote, relative to the project. */
  edited: string[];
  /** Of those, the files the plan does not list. */
  outside: string[];
  /** `git diff --shortstat HEAD`, when the project is a repository with changes. */
  git?: string;
}

type CompletionAssessment =
  | { state: "reviewed"; planner: string; narrative: string; verdict: "done" | "changes" | "unclear"; costUsd: number }
  | { state: "disabled" }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; reason: string; costUsd?: number };

interface FinishDetails {
  report: string;
  /** Optional only for completion messages saved before structured reports were introduced. */
  verification?: string;
  concerns?: string;
  assessment?: CompletionAssessment;
  pending?: boolean;
  activity?: string;
  planFile: string;
  changes?: ChangeSummary;
  /** Who implemented it, e.g. `Claude Sonnet 5.5`. */
  implementer?: string;
  /** The model the session went back to, when it did. */
  returnedTo?: string;
  /** One line on how it went, from pi-recap when it is loaded (shown on the card back in the planning conversation). */
  headline?: string;
  /** Questions put to the planner on call, and what they cost. */
  asks?: number;
  costUsd?: number;
}

const NOT_ACTIVE = "No approved plan is being implemented.";

export function registerExec(pi: ExtensionAPI, host: ExecHost): ExecController {
  let state: ExecState | undefined;
  let agent: PlannerAgent | undefined;
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
    if (!ctx?.hasUI) return;
    let text: string | undefined;
    if (state?.active) {
      text = "exec mode on";
      if (state.planner) text += ` · ${state.planner.name} on call`;
      if (state.asks > 0)
        text += ` · ${state.asks} ${state.asks === 1 ? "ask" : "asks"} · ${formatCost(state.costUsd)}`;
    }
    safely(() => ctx.ui.setStatus(EXEC_STATUS_KEY, text));
  };

  const disposeAgent = () => {
    agent?.dispose();
    agent = undefined;
  };

  const setTools = () => {
    setToolsActive(pi, [FINISH_TOOL], Boolean(state?.active));
    setToolsActive(pi, [ASK_TOOL], Boolean(state?.active && state.planner));
  };

  const persist = () => {
    if (state) {
      const snapshot = { ...state };
      safely(() => pi.appendEntry(EXEC_ENTRY, snapshot));
    }
  };

  const begin = (ctx: ExtensionContext, next: ExecState, options: { record: boolean }) => {
    hostCtx = ctx;
    disposeAgent();
    noted.clear();
    touched.clear();
    state = { ...next };
    if (options.record) persist();
    setTools();
    updateStatus(ctx);
  };

  const end = (ctx: ExtensionContext) => {
    if (!state) return;
    state = { ...state, active: false };
    persist();
    disposeAgent();
    noted.clear();
    touched.clear();
    setToolsActive(pi, EXEC_TOOLS, false);
    state = undefined;
    updateStatus(ctx);
  };

  const record = (usage: Usage, ctx: ExtensionContext) => {
    if (!state) return;
    state.asks += 1;
    state.costUsd += usage.cost.total;
    persist();
    updateStatus(ctx);
  };

  const restore = (ctx: ExtensionContext) => {
    hostCtx = ctx;
    disposeAgent();
    noted.clear();
    touched.clear();
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
    const latest = [...entries]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === EXEC_ENTRY)?.data;
    state = validState(latest);
    setTools();
    updateStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    disposeAgent();
    hostCtx = undefined;
  });

  /** The planner on call, opened on its seeded session the first time it is asked. */
  const consultant = (ctx: ExtensionContext): PlannerAgent | undefined => {
    if (agent) return agent;
    const planner = state?.planner;
    const spec = parseModelSpec(planner?.spec);
    if (!state || !planner || !spec) return undefined;
    agent = new PlannerAgent({
      id: "P",
      spec,
      name: planner.name,
      cwd: ctx.cwd,
      access: host.consultantAccess(ctx, state.planFile, spec),
      timeoutMs: CONSULT_TIMEOUT_MS,
      wrapUpMessage: CONSULT_WRAP_UP,
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
    renderResult: (result, options, theme) => renderAsk(result.details as AskDetails | undefined, options, theme),
    async execute(_id, params: unknown, signal, onUpdate, ctx) {
      hostCtx = ctx;
      const current = state;
      if (!current?.active || !current.planner) {
        return text("No planner is on call: you are not implementing a handed-off plan.");
      }
      const message =
        typeof (params as { message?: unknown })?.message === "string"
          ? (params as { message: string }).message.trim()
          : "";
      if (!message) return text("Say what you found and what you need decided.");
      const planner = consultant(ctx);
      if (!planner) {
        return text(
          "The planner's session is missing; decide within the plan, and ask the user about anything it leaves open.",
        );
      }
      const before = readPlan(current.planFile);
      const name = current.planner.name;
      const progress = () => {
        const activity = planner.stats.lastActivity ?? "thinking";
        onUpdate?.({
          content: [{ type: "text", text: `${name}: ${activity}` }],
          details: { question: message, planner: name, pending: true, activity } satisfies AskDetails,
        } as never);
      };
      const unsubscribe = planner.subscribe(progress);
      const onAbort = () => void planner.stop();
      signal?.addEventListener("abort", onAbort, { once: true });
      let result: Awaited<ReturnType<PlannerAgent["consult"]>>;
      try {
        result = await planner.consult(consultMessage(message, "implementer"), ctx, "implementer", signal, message);
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted) return text("Stopped waiting for the planner.");
      record(result.usage, ctx);
      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: `The planner failed: ${result.error}. Decide within the plan, and ask the user about anything it leaves open.`,
            },
          ],
          details: { question: message, planner: name, costUsd: result.usage.cost.total } satisfies AskDetails,
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
      "Finish implementing the approved plan: report what changed, verification results, and outstanding issues honestly. This ends exec mode even if the informational planner assessment finds changes needed.",
    promptSnippet: "Report an approved plan as done",
    promptGuidelines: [
      "When implementation of an approved plan is finished, call finish_plan with report, verification, and concerns. Include failed or unrun checks and remaining work; use concerns: None only when accurate.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report", "verification", "concerns"],
      properties: {
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
    renderCall: (_args, theme) => reviewTitle(theme, "Implementation complete"),
    renderResult: (result, options, theme) => renderFinish(result.details as FinishDetails | undefined, options, theme),
    async execute(_id, params: unknown, signal, onUpdate, ctx) {
      hostCtx = ctx;
      const current = state;
      if (!current?.active) return text(NOT_ACTIVE);
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
      const details: FinishDetails = {
        report,
        verification,
        concerns,
        planFile: current.planFile,
        changes: await summarizeChanges(current, touched, ctx.cwd),
        implementer: current.implementer,
        asks: current.asks,
        costUsd: current.costUsd,
      };
      let usage: Usage | undefined;
      try {
        if (!host.completionReview()) details.assessment = { state: "disabled" };
        else if (!current.planner) {
          details.assessment = { state: "unavailable", reason: "No planner is on call." };
        } else {
          const planner = consultant(ctx);
          if (!planner) {
            details.assessment = { state: "unavailable", reason: "The planner's session is missing or invalid." };
          } else {
            const baseline = planner.stats.costUsd;
            const progress = () => {
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
            let interrupt: (reason: "cancelled" | "timed out") => void = () => undefined;
            const stopped = new Promise<undefined>((done) => {
              interrupt = (reason) => {
                interrupted = reason;
                controller.abort();
                void planner.stop().catch(() => undefined);
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
                      reviewRequest(report, {
                        verification,
                        concerns,
                        planFile: current.planFile,
                        changes: changeSummaryText(details.changes),
                      }),
                      ctx,
                      "completion review",
                      controller.signal,
                    ),
                    stopped,
                  ]);
              usage = result?.usage;
              const costUsd = usage?.cost.total ?? Math.max(0, planner.stats.costUsd - baseline);
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
                details.assessment = {
                  state: "reviewed",
                  planner: current.planner.name,
                  narrative: result.reply.trim(),
                  verdict: reviewVerdict(result.reply),
                  costUsd,
                };
              }
            } catch (error: unknown) {
              details.assessment = {
                state: "failed",
                reason: error instanceof Error ? error.message : String(error),
                costUsd: Math.max(0, planner.stats.costUsd - baseline),
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
      } finally {
        end(ctx);
      }
      const spec = parseModelSpec(current.restore);
      const now = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      const restored = Boolean(spec && now === current.implementerModel);
      if (spec && restored) await host.restoreModel(ctx, spec);
      if (restored && current.planner) details.returnedTo = current.planner.name;
      if (current.returnTo && ctx.hasUI) pendingReturn = { leaf: current.returnTo, details };
      return {
        content: [{ type: "text", text: `${finishMessageText(details)}\n\nExec mode is over. Stop here.` }],
        details,
        ...(usage ? { usage } : {}),
        terminate: true,
      } as never;
    },
  });

  // Back to the planning conversation: a tool cannot navigate the session tree, a command can, and a
  // command sent once the turn has settled runs outside the streaming turn.
  let pendingReturn: { leaf: string; details: FinishDetails } | undefined;
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
      pendingReturn = undefined;
      if (!back) return;
      // Asked while still on the implementation branch, where the turn it recaps is.
      const headline = await recapHeadline(pi, 5_000);
      // Keep the files: the implementation's changes are the point, and pi-rewind (when loaded) would
      // otherwise offer to restore them to how they were at the plan.
      try {
        pi.events.emit("rewind:keep-files", {});
      } catch {
        // No event bus.
      }
      try {
        // No model summary of the branch: the implementer's report is the summary, and it goes in as a
        // message the planner reads.
        await ctx.navigateTree(back.leaf, { summarize: false });
      } catch (error: unknown) {
        ctx.ui.notify(
          `Could not return to the planning conversation: ${error instanceof Error ? error.message : String(error)}. Use /tree.`,
          "warning",
        );
        return;
      }
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
      "Implementation complete",
      renderFinish(message.details, { expanded: options.expanded, isPartial: false }, theme),
      finishTone(message.details),
    ),
  );

  // Tripwire: a note on the first edit of each file the plan does not list. It never blocks.
  pi.on("tool_result", (event, ctx) => {
    if (!state?.active || event.isError) return undefined;
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const file = resolve(ctx.cwd, expandHome(String((event.input as { path?: unknown })?.path ?? "")));
    if (!isPlanFile(file, ctx.cwd, state.planFile)) touched.add(file);
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
  if (entry.active !== true || typeof entry.planFile !== "string" || !entry.planFile) return undefined;
  const planner = entry.planner;
  const valid =
    planner &&
    typeof planner.spec === "string" &&
    typeof planner.name === "string" &&
    typeof planner.sessionFile === "string";
  return {
    active: true,
    planFile: entry.planFile,
    implementer: typeof entry.implementer === "string" ? entry.implementer : "this model",
    implementerModel: typeof entry.implementerModel === "string" ? entry.implementerModel : "",
    ...(valid ? { planner: { spec: planner.spec, name: planner.name, sessionFile: planner.sessionFile } } : {}),
    ...(typeof entry.restore === "string" ? { restore: entry.restore } : {}),
    ...(typeof entry.returnTo === "string" ? { returnTo: entry.returnTo } : {}),
    asks: typeof entry.asks === "number" ? entry.asks : 0,
    costUsd: typeof entry.costUsd === "number" ? entry.costUsd : 0,
  };
}

function renderAsk(details: AskDetails | undefined, options: { expanded: boolean; isPartial: boolean }, theme: Theme) {
  const container = new Container();
  if (!details) return container;
  if (details.pending) {
    container.addChild(new Text(theme.fg("muted", `${details.planner} · ${details.activity ?? "thinking"}`), 0, 0));
    return container;
  }
  if (details.reply) container.addChild(new PlanMarkdown(details.reply, getMarkdownTheme(), theme));
  if (details.changes && details.changes.length > 0) {
    container.addChild(new Text(theme.fg("muted", "Amended the plan:"), 0, 0));
    container.addChild(new Text(renderPlanDiff(theme, details.changes), 0, 0));
  }
  container.addChild(
    new Text(
      theme.fg("dim", `${details.planner}${details.costUsd !== undefined ? ` · ${formatCost(details.costUsd)}` : ""}`),
      0,
      0,
    ),
  );
  void options;
  return container;
}

const MAX_LISTED = 10;

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

/** `+20 -2` colored from `git diff --shortstat`'s `20 insertions(+), 2 deletions(-)`. */
function diffstat(theme: Theme, git: string): string {
  const files = /(\d+) files? changed/u.exec(git)?.[1];
  const added = /(\d+) insertions?\(\+\)/u.exec(git)?.[1];
  const removed = /(\d+) deletions?\(-\)/u.exec(git)?.[1];
  const parts = [
    ...(added ? [theme.fg("success", `+${added}`)] : []),
    ...(removed ? [theme.fg("error", `-${removed}`)] : []),
  ];
  if (parts.length === 0) return theme.fg("dim", git);
  return `${parts.join(" ")}${files ? theme.fg("dim", ` across ${files} ${files === "1" ? "file" : "files"} (git diff against HEAD)`) : ""}`;
}

/** What the implementation touched: a heading with counts, one row per file, then the diffstat. */
function renderChanges(theme: Theme, changes: ChangeSummary | undefined): Component[] {
  if (!changes || (changes.edited.length === 0 && !changes.git)) return [];
  const rows: string[] = [];
  const counts = [
    ...(changes.edited.length > 0
      ? [`${changes.edited.length} ${changes.edited.length === 1 ? "file" : "files"} edited`]
      : []),
    ...(changes.outside.length > 0 ? [`${changes.outside.length} outside the plan`] : []),
  ];
  rows.push(
    theme.fg("toolTitle", theme.bold("Changed")) +
      (counts.length > 0 ? theme.fg("dim", ` · ${counts.join(" · ")}`) : ""),
  );
  for (const file of changes.edited.slice(0, MAX_LISTED)) {
    rows.push(
      changes.outside.includes(file)
        ? `  ${theme.fg("warning", "!")} ${file} ${theme.fg("warning", "not in the plan")}`
        : `  ${theme.fg("dim", "•")} ${file}`,
    );
  }
  if (changes.edited.length > MAX_LISTED) {
    rows.push(theme.fg("dim", `  … and ${changes.edited.length - MAX_LISTED} more`));
  }
  if (changes.git) rows.push(`  ${diffstat(theme, changes.git)}`);
  return [new Spacer(1), new Text(rows.join("\n"), 0, 0)];
}

function renderFinish(
  details: FinishDetails | undefined,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  const container = new Container();
  const section = (label: string, value: string, fold = false) => {
    if (container.children.length > 0) container.addChild(new Spacer(1));
    container.addChild(reviewTitle(theme, label));
    const lines = value.split("\n");
    const folded = fold && !options.expanded && lines.length > COLLAPSED_LINES;
    container.addChild(
      new PlanMarkdown(folded ? lines.slice(0, COLLAPSED_LINES).join("\n") : value, getMarkdownTheme(), theme),
    );
    if (folded) {
      const more = lines.length - COLLAPSED_LINES;
      container.addChild(
        new Text(theme.fg("dim", `… ${more} more line${more === 1 ? "" : "s"} (ctrl+o to expand)`), 0, 0),
      );
    }
  };
  if (details?.headline) container.addChild(new Text(theme.fg("dim", theme.bold(`※ ${details.headline}`)), 0, 0));
  section("What changed", details?.report || "Not provided.", true);
  section("Verification", details?.verification || "Not provided; verification is unknown.");
  section("Outstanding issues", details?.concerns || "Not provided; outstanding issues are unknown.");
  section("Planner assessment", assessmentSummary(details));
  if (details?.assessment?.state === "reviewed") {
    const narrative = new Container();
    const lines = details.assessment.narrative.split("\n");
    const folded = !options.expanded && lines.length > COLLAPSED_LINES;
    narrative.addChild(
      new PlanMarkdown(
        folded ? lines.slice(0, COLLAPSED_LINES).join("\n") : details.assessment.narrative,
        getMarkdownTheme(),
        theme,
      ),
    );
    if (folded) {
      const more = lines.length - COLLAPSED_LINES;
      narrative.addChild(
        new Text(theme.fg("dim", `… ${more} more line${more === 1 ? "" : "s"} (ctrl+o to expand)`), 0, 0),
      );
    }
    container.addChild(narrative);
  }
  for (const part of renderChanges(theme, details?.changes)) container.addChild(part);
  container.addChild(new Spacer(1));
  const tone = finishTone(details);
  container.addChild(
    new Text(
      reviewStatusLine(theme, {
        tone,
        text: details?.pending
          ? "Planner reviewing…"
          : tone === "success"
            ? "Finished · assessed done"
            : tone === "error"
              ? "Finished · attention needed"
              : "Finished · review limitations",
        context: finishContext(details),
      }),
      0,
      0,
    ),
  );
  return container;
}

function finishTone(details: FinishDetails | undefined): ReviewTone {
  if (details?.pending) return "pending";
  const assessment = details?.assessment;
  if (assessment?.state === "failed" || (assessment?.state === "reviewed" && assessment.verdict === "changes"))
    return "error";
  return assessment?.state === "reviewed" &&
    assessment.verdict === "done" &&
    details?.concerns?.trim().toLowerCase() === "none"
    ? "success"
    : "warning";
}

function assessmentSummary(details: FinishDetails | undefined): string {
  if (details?.pending) return `Planner reviewing…${details.activity ? ` (${details.activity})` : ""}`;
  const assessment = details?.assessment;
  if (!assessment) return "Unavailable: no planner assessment was recorded.";
  switch (assessment.state) {
    case "disabled":
      return "Disabled: automatic completion review is off.";
    case "unavailable":
      return `Unavailable: ${assessment.reason}`;
    case "failed":
      return `Review failed: ${assessment.reason}`;
    case "reviewed": {
      const verdict =
        assessment.verdict === "done"
          ? "done"
          : assessment.verdict === "changes"
            ? "changes needed"
            : "unclear (no unambiguous final verdict)";
      return `${assessment.planner} · Verdict: ${verdict}. Informational assessment, not user approval.`;
    }
  }
}

function finishContext(details: FinishDetails | undefined): string {
  const asks = details?.asks ?? 0;
  const assessment = details?.assessment;
  const reviewCost = assessment && "costUsd" in assessment ? assessment.costUsd : undefined;
  const who =
    details?.returnedTo && details.returnedTo !== details.implementer
      ? `${details.implementer ?? "Unknown implementer"} → ${details.returnedTo}`
      : (details?.implementer ?? "Unknown implementer");
  return [
    details?.planFile ? planTitle(details.planFile) : "Plan",
    who,
    `${asks} ${asks === 1 ? "consultation" : "consultations"}${details?.costUsd !== undefined ? ` · ${formatCost(details.costUsd)}` : ""}`,
    ...(reviewCost !== undefined ? [`review ${formatCost(reviewCost)}`] : []),
  ].join(" · ");
}

function changeSummaryText(changes: ChangeSummary | undefined): string {
  return [
    `Files edited: ${changes?.edited.join(", ") || "none recorded"}`,
    `Not in the plan: ${changes?.outside.join(", ") || "none recorded"}`,
    `git diff against HEAD: ${changes?.git || "no summary available (does not rule out committed work)"}`,
  ].join("\n");
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
    "Implementation complete",
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
    "",
    changeSummaryText(details.changes),
    "",
    finishContext(details),
  ].join("\n");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
