// Exec mode: a mode of your main chat while an approved plan is being implemented. The footer shows
// it where the permission mode is (status `plan-exec`; the permission mode underneath still decides
// what runs), the planner that wrote the plan can stay on call through ask_planner, edits to files
// the plan does not list get a note once, and finish_plan ends it with the user's acceptance or the
// planner's review, both shown in the transcript. It is entered only by approving a plan (plan.ts
// calls `begin`; no key cycles to it) and ended by finish_plan, or replaced by approving a newer plan.
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { setToolsActive } from "./active-tools.js";
import { holdBlocked } from "./herdr-blocked.js";
import { type ModelSpec, parseModelSpec } from "./implementation-models.js";
import { PlanMarkdown } from "./mermaid-art.js";
import { type DiffLine, planDiff, planDiffText, renderPlanDiff } from "./plan-diff.js";
import { inPlan, isPlanFile, planPaths, planTitle, readPlan, tildify } from "./plan-file.js";
import { expandHome } from "./plan-hook.js";
import { type PlannerAccessConfig, PlannerAgent } from "./planner/agent.js";
import { CONSULT_WRAP_UP, consultMessage, reviewRequest, reviewVerdict } from "./planner/prompt.js";
import { type PlannerSessionFactory, plannerSessionDir } from "./planner/session.js";
import { formatCost } from "./planners.js";
import { type ReviewStatus, reviewBody, reviewTitle } from "./review-card.js";
import type { Usage } from "./scout-process.js";

export const EXEC_ENTRY = "plan-mode:exec";
export const EXEC_STATUS_KEY = "plan-exec";
export const ASK_TOOL = "ask_planner";
export const FINISH_TOOL = "finish_plan";
export const EXEC_TOOLS = [FINISH_TOOL, ASK_TOOL] as const;
export const FINISH_DONE = "Yes, done";
export const FINISH_REVIEW = "Have the planner review it";
export const FINISH_KEEP = "No, keep going";
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
  /** Model spec to return to on "Yes, done" */
  restore?: string;
  asks: number;
  costUsd: number;
}

export interface ExecHost {
  /** What the planner on call on `spec` may use (planner/access.ts consultantAccess). */
  consultantAccess(ctx: ExtensionContext, planFile: string, spec: ModelSpec): PlannerAccessConfig;
  createSession?: PlannerSessionFactory;
  restoreModel(ctx: ExtensionContext, spec: ModelSpec): Promise<unknown>;
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

interface FinishDetails {
  report: string;
  planFile: string;
  outcome: "pending" | "done" | "review" | "kept";
  changes?: ChangeSummary;
  /** The planner that reviewed (or is reviewing) the work. */
  reviewer?: string;
  /** While the planner reviews: what it is doing. */
  reviewing?: string;
  /** The planner's review without its verdict line. */
  review?: string;
  /** The review's verdict: nothing to fix. */
  reviewClean?: boolean;
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
    label: "Finish plan",
    description:
      "When the approved plan you are implementing is done and its verification passes: show your report to the user, who accepts the work, has the planner review it, or sends you back to keep going.",
    promptSnippet: "Report an approved plan as done, for the user to accept",
    promptGuidelines: [
      "While implementing an approved plan, call finish_plan once it is done and its Verification passes, with your report; do not ask the user whether the work is done any other way.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report"],
      properties: {
        report: {
          type: "string",
          minLength: 1,
          description:
            "Markdown: what you changed, the verification you ran and its results, and each deviation from the plan with how it was settled.",
        },
      },
    } as never,
    renderCall: (_args, theme, context) =>
      reviewTitle(theme, context.isPartial ? "Implementation review" : "Implementation"),
    renderResult: (result, options, theme) => renderFinish(result.details as FinishDetails | undefined, options, theme),
    async execute(_id, params: unknown, signal, onUpdate, ctx) {
      hostCtx = ctx;
      const current = state;
      if (!current?.active) return text(NOT_ACTIVE);
      if (!ctx.hasUI) return text("There is no user to accept the work. Stop here and give your report.");
      const report =
        typeof (params as { report?: unknown })?.report === "string"
          ? (params as { report: string }).report.trim()
          : "";
      const planFile = current.planFile;
      const plannerName = current.planner?.name;
      const changes = await summarizeChanges(current, touched, ctx.cwd);
      let review: { by: string; text: string; clean: boolean } | undefined;
      const show = (extra: Partial<FinishDetails> = {}) =>
        onUpdate?.({
          content: [{ type: "text", text: report }],
          details: {
            report,
            planFile,
            outcome: "pending",
            changes,
            ...(review ? { reviewer: review.by, review: review.text, reviewClean: review.clean } : {}),
            ...extra,
          } satisfies FinishDetails,
        } as never);
      show();
      const releaseBlocked = holdBlocked(pi.events, "Review the implementation");
      ctx.ui.setWorkingVisible?.(false);
      const done = (outcome: FinishDetails["outcome"]): FinishDetails => ({
        report,
        planFile,
        outcome,
        changes,
        ...(review ? { reviewer: review.by, review: review.text, reviewClean: review.clean } : {}),
      });
      try {
        for (;;) {
          const options = [FINISH_DONE, ...(plannerName && !review ? [FINISH_REVIEW] : []), FINISH_KEEP];
          const choice = await ctx.ui.select(acceptTitle(changes, review), options, { signal });
          if (choice === FINISH_DONE) {
            const finished = current;
            end(ctx);
            const spec = parseModelSpec(finished.restore);
            const now = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
            if (spec && now === finished.implementerModel) await host.restoreModel(ctx, spec);
            return {
              content: [
                {
                  type: "text",
                  text: "The user accepted the implementation; the plan is done and exec mode is over. Stop here.",
                },
              ],
              details: done("done"),
              terminate: true,
            } as never;
          }
          if (choice === FINISH_REVIEW) {
            const planner = consultant(ctx);
            if (!planner || !plannerName) continue;
            const progress = () => show({ reviewer: plannerName, reviewing: planner.stats.lastActivity ?? "thinking" });
            const unsubscribe = planner.subscribe(progress);
            const onAbort = () => void planner.stop();
            signal?.addEventListener("abort", onAbort, { once: true });
            progress();
            let result: Awaited<ReturnType<PlannerAgent["consult"]>>;
            try {
              result = await planner.consult(
                reviewRequest(report),
                ctx,
                "implementer",
                signal,
                "Review the implementation",
              );
            } finally {
              unsubscribe();
              signal?.removeEventListener("abort", onAbort);
            }
            if (signal?.aborted) return text("Stopped waiting for the planner.");
            record(result.usage, ctx);
            if (result.error) {
              ctx.ui.notify(`The planner could not review it: ${result.error}`, "warning");
              show();
              continue;
            }
            const reply = result.reply.trim();
            const clean = reviewVerdict(reply) === "done";
            review = { by: plannerName, text: withoutVerdict(reply), clean };
            if (clean) {
              // The review stays on screen above the question; the user decides.
              show();
              continue;
            }
            return {
              content: [
                {
                  type: "text",
                  text: `The user had the planner review your work, and it found:\n\n${reply}\n\nFix these within the plan, then call finish_plan again.`,
                },
              ],
              details: done("review"),
              usage: result.usage,
            } as never;
          }
          return {
            content: [
              {
                type: "text",
                text: "The user wants more done before accepting it. Stop here: their next message says what.",
              },
            ],
            details: done("kept"),
            terminate: true,
          } as never;
        }
      } finally {
        releaseBlocked();
        ctx.ui.setWorkingVisible?.(true);
      }
    },
  });

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

/** What the question puts beside "Accept?": what changed, and what the planner's review found. */
function acceptTitle(changes: ChangeSummary, review: { by: string; clean: boolean } | undefined): string {
  const parts: string[] = [];
  if (changes.edited.length > 0) {
    parts.push(`${changes.edited.length} ${changes.edited.length === 1 ? "file" : "files"} edited`);
  }
  if (changes.outside.length > 0) parts.push(`${changes.outside.length} outside the plan`);
  if (review?.clean) parts.push(`${review.by} found nothing to fix`);
  return `Accept the implementation?${parts.length > 0 ? ` ${parts.join(" · ")}` : ""}`;
}

/** A review without its closing `Verdict:` line, which the card shows as its own heading. */
function withoutVerdict(reply: string): string {
  return reply.replace(/\n?[ \t]*`?verdict:\s*(?:done|changes needed)`?[ \t]*\s*$/iu, "").trim();
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

/** The changes as Markdown, under the implementer's report. */
function changesMarkdown(changes: ChangeSummary | undefined): string {
  if (!changes || (changes.edited.length === 0 && !changes.git)) return "";
  const lines = ["**Changed**", ""];
  for (const file of changes.edited.slice(0, MAX_LISTED)) {
    lines.push(`- \`${file}\`${changes.outside.includes(file) ? " (not in the plan)" : ""}`);
  }
  if (changes.edited.length > MAX_LISTED) lines.push(`- … and ${changes.edited.length - MAX_LISTED} more`);
  if (changes.git) lines.push("", `git diff against HEAD: ${changes.git}`);
  return `\n\n${lines.join("\n")}`;
}

function renderFinish(
  details: FinishDetails | undefined,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  if (!details?.report) return new Container();
  const context = planTitle(details.planFile);
  const status: ReviewStatus =
    details.outcome === "done"
      ? { tone: "success", text: "✓ Accepted", context }
      : details.outcome === "review"
        ? { tone: "warning", text: "Sent back with the planner's review", context }
        : details.outcome === "kept"
          ? { tone: "warning", text: "Kept going", context }
          : { tone: "pending", text: "Waiting for acceptance", context };
  const body = reviewBody(
    theme,
    `${details.report}${changesMarkdown(details.changes)}`,
    status,
    options,
    (md) => new PlanMarkdown(md, getMarkdownTheme(), theme),
  );
  if (!details.review && !details.reviewing) return body;
  // The planner's review, in full, under the status (and so just above the question).
  const container = new Container();
  container.addChild(body);
  container.addChild(new Spacer(1));
  const by = details.reviewer ?? "The planner";
  if (details.reviewing && !details.review) {
    container.addChild(new Text(theme.fg("muted", `${by} is reviewing · ${details.reviewing}`), 0, 0));
    return container;
  }
  const verdict = details.reviewClean ? "found nothing to fix" : "found changes to make";
  container.addChild(
    new Text(theme.fg("toolTitle", theme.bold(`Review by ${by}`)) + theme.fg("dim", ` · ${verdict}`), 0, 0),
  );
  if (details.review) container.addChild(new PlanMarkdown(details.review, getMarkdownTheme(), theme));
  return container;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined } as never;
}
