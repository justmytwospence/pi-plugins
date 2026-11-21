// Another model can implement an approved plan: the session switches to it for exactly the run that builds
// the plan and returns to your model when that run ends, however it ends. `ask_planner` hands the next
// requests to your model and back within the same run. Nothing here changes the model outside a build.
import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setToolsActive } from "./active-tools.ts";
import { shortModelName } from "./approval-picker.ts";
import { effortOrigin, withEffortOrigin } from "./effort-origin.ts";
import { gateShellReads } from "./gate-shell.ts";
import { MODEL_SPEC_THINKING_LEVELS, type ModelSpec, type ModelSpecThinkingLevel } from "./implementation-models.ts";
import { implementersFor, LEGACY_PAIR_ID, legacyPlanner } from "./implementers.ts";
import { inPlan, isPlanFile, planPaths, readPlan } from "./plan-file.ts";
import { expandHome } from "./plan-hook.ts";
import { PLAN_PAIR_CHANNEL, type PlanPairRequest, type PlanPairSnapshot } from "./plan-pair-contract.ts";
import { isVirtual } from "./routed-model.ts";
import { findBlockedCommandSegment, readCommand, type SafeSubcommands } from "./tool-policy.ts";

/** Same entry name as the removed pairs; only version 2 data is read. */
export const ROUTE_ENTRY = "plan-mode:pair";
export const ROUTE_TOOLS = ["ask_planner", "planner_answer"] as const;
const ANSWER_TYPE = "plan-mode-planner-answer";

export interface BuildRoute {
  /** Your model and the level it planned at; the session returns to it when the build ends. */
  home: ModelSpec;
  worker: { provider: string; modelId: string };
  planFile: string;
  /** The worker's level, kept while the planner answers. */
  workerLevel?: ModelSpecThinkingLevel;
}

export interface RouteState {
  version: 2;
  consult: boolean;
  build?: BuildRoute;
}

export interface RouteHost {
  /** Whether inline plan mode is on. */
  planning(): boolean;
  safeSubcommands(): SafeSubcommands | undefined;
  judgePlanEffort(ctx: ExtensionContext, prompt: string): Promise<ModelSpecThinkingLevel | undefined>;
}

export interface BuildRouteController {
  /** The models that can implement a plan made on the session model, best default first. */
  workers(ctx: ExtensionContext): { spec: ModelSpec; name: string }[];
  /** Switch the session to the worker for the build; false (nothing changed) when that failed. */
  begin(ctx: ExtensionContext, worker: ModelSpec, planFile: string): Promise<boolean>;
  /** Undo a begin whose approval did not go through. */
  cancel(ctx: ExtensionContext): Promise<void>;
  /** Your model's display name while a build is active. */
  homeName(ctx: ExtensionContext): string | undefined;
  phaseChanged(ctx: ExtensionContext): void;
  readonly state: RouteState;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const level = (value: unknown): ModelSpecThinkingLevel | undefined =>
  typeof value === "string" && (MODEL_SPEC_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ModelSpecThinkingLevel)
    : undefined;

function readModel(value: unknown): ModelSpec | undefined {
  if (!record(value) || typeof value.provider !== "string" || typeof value.modelId !== "string") return undefined;
  const thinkingLevel = level(value.thinkingLevel);
  return {
    provider: value.provider,
    modelId: value.modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function readBuild(value: unknown): BuildRoute | undefined {
  if (!record(value)) return undefined;
  const home = readModel(value.home);
  const worker = readModel(value.worker);
  if (!home || !worker || typeof value.planFile !== "string" || !value.planFile.trim()) return undefined;
  const workerLevel = level(value.workerLevel);
  return {
    home,
    worker: { provider: worker.provider, modelId: worker.modelId },
    planFile: value.planFile,
    ...(workerLevel ? { workerLevel } : {}),
  };
}

/** A clause for the approval's Model line: who answers the worker's questions, and what happens after the build. */
export const workerNote = (homeName: string) =>
  `${shortModelName(homeName)} answers its questions; back to ${shortModelName(homeName)} when the build ends`;

const text = (value: string, details?: unknown) => ({
  content: [{ type: "text" as const, text: value }],
  details: details ?? {},
});

export function registerBuildRoute(pi: ExtensionAPI, host: RouteHost): BuildRouteController {
  let state: RouteState = { version: 2, consult: false };
  const noted = new Set<string>();
  let planEffortPending = false;
  let manualSincePlanEntry = false;
  let wasPlanning = false;
  /** Switches this module makes itself: their model_select events are not the user's choice. */
  let own = 0;
  let outcome: string | undefined;

  const persist = () => {
    try {
      pi.appendEntry(ROUTE_ENTRY, structuredClone(state));
    } catch {
      // A session without entries keeps the state in memory.
    }
  };

  const available = (ctx: ExtensionContext) => {
    try {
      return ctx.modelRegistry.getAvailable();
    } catch {
      return [];
    }
  };
  const name = (ctx: ExtensionContext, spec: { provider: string; modelId: string }) =>
    shortModelName(ctx.modelRegistry.find(spec.provider, spec.modelId)?.name ?? spec.modelId);
  const syncTools = () => setToolsActive(pi, ROUTE_TOOLS, !!state.build);

  const switchTo = async (
    ctx: ExtensionContext,
    spec: { provider: string; modelId: string },
    thinkingLevel?: ModelSpecThinkingLevel,
  ): Promise<boolean> => {
    const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
    if (!model) return false;
    let ok = false;
    own++;
    try {
      ok = await withEffortOrigin("plan-mode", () => pi.setModel(model));
    } catch {
      ok = false;
    } finally {
      own--;
    }
    // A model switch may apply that model's own default level.
    if (ok && thinkingLevel) withEffortOrigin("plan-mode", () => pi.setThinkingLevel(thinkingLevel as never));
    return ok;
  };

  const onModel = (ctx: ExtensionContext, spec: { provider: string; modelId: string }) =>
    ctx.model?.provider === spec.provider && ctx.model.id === spec.modelId;

  const end = async (ctx: ExtensionContext, reason: "completed" | "stopped" | "restored" | "planning") => {
    const build = state.build;
    if (!build) return;
    state = { version: 2, consult: false };
    persist();
    syncTools();
    const ok = onModel(ctx, build.home) || (await switchTo(ctx, build.home, build.home.thinkingLevel));
    if (!ctx.hasUI) return;
    const worker = name(ctx, build.worker);
    const home = name(ctx, build.home);
    if (!ok) ctx.ui.notify(`Could not switch back to ${home}. Choose a model with /model.`, "error");
    else if (reason === "stopped") ctx.ui.notify(`Build on ${worker} stopped; back on ${home}.`, "warning");
    else if (reason === "restored")
      ctx.ui.notify(`The last build on ${worker} did not finish; back on ${home}.`, "warning");
    else if (reason === "planning") ctx.ui.notify(`Back on ${home} to plan.`, "info");
  };

  const restore = (ctx: ExtensionContext) => {
    state = { version: 2, consult: false };
    try {
      for (const entry of ctx.sessionManager.getBranch() as readonly {
        type?: string;
        customType?: string;
        data?: unknown;
      }[]) {
        if (entry.type !== "custom" || entry.customType !== ROUTE_ENTRY) continue;
        const data = entry.data;
        if (!record(data) || data.version !== 2 || typeof data.consult !== "boolean") continue;
        const build = readBuild(data.build);
        state = { version: 2, consult: build ? data.consult : false, ...(build ? { build } : {}) };
      }
    } catch {
      state = { version: 2, consult: false };
    }
    noted.clear();
  };

  /** A session left on a removed `<family>plan` model moves to that family's newest model. */
  const migrateLegacy = async (ctx: ExtensionContext) => {
    let last: { provider?: unknown; modelId?: unknown } | undefined;
    try {
      for (const entry of ctx.sessionManager.getBranch() as readonly {
        type?: string;
        provider?: unknown;
        modelId?: unknown;
      }[])
        if (entry.type === "model_change") last = entry;
    } catch {
      return;
    }
    if (typeof last?.provider !== "string" || typeof last.modelId !== "string") return;
    const match = LEGACY_PAIR_ID.exec(last.modelId);
    if (!match || ctx.modelRegistry.find(last.provider, last.modelId)) return;
    const target = legacyPlanner(last.provider, match[1] as string, available(ctx));
    if (!target || onModel(ctx, target)) return;
    const ok = await switchTo(ctx, target);
    if (ok && ctx.hasUI)
      ctx.ui.notify(
        `Plan model pairs were removed: ${last.provider}/${last.modelId} is now ${name(ctx, target)}. Choose who implements when you approve a plan.`,
        "info",
      );
  };

  const workers = (ctx: ExtensionContext) => {
    const model = ctx.model;
    if (!model || isVirtual(model)) return [];
    const current = pi.getThinkingLevel() as ModelSpecThinkingLevel;
    return implementersFor({ provider: model.provider, modelId: model.id }, available(ctx)).map((spec) => ({
      spec: { ...spec, ...(current ? { thinkingLevel: current } : {}) },
      name: ctx.modelRegistry.find(spec.provider, spec.modelId)?.name ?? spec.modelId,
    }));
  };

  const snapshot = (): PlanPairSnapshot | undefined => {
    const build = state.build;
    if (!build) return undefined;
    const home = { provider: build.home.provider, id: build.home.modelId };
    const worker = { provider: build.worker.provider, id: build.worker.modelId };
    return {
      version: 2,
      phase: state.consult ? "consult" : "build",
      home,
      worker,
      next: state.consult ? home : worker,
    };
  };
  pi.events?.on(PLAN_PAIR_CHANNEL, (data) => {
    const request = data as PlanPairRequest | undefined;
    if (request?.kind !== "query") return;
    try {
      request.snapshot = snapshot();
    } catch {
      // A footer query never breaks routing.
    }
  });

  // The run that implements the plan is over once it settles, however it ended.
  pi.on("agent_settled", async (event, ctx) => {
    const ended = outcome;
    outcome = undefined;
    if (!state.build) return;
    const stopped = (event as { aborted?: boolean }).aborted || (ended !== undefined && ended !== "completed");
    await end(ctx, stopped ? "stopped" : "completed");
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    outcome = event.outcome;
    if (!state.consult) return undefined;
    const build = state.build;
    state = { ...state, consult: false };
    persist();
    if (!build || event.outcome !== "completed") return undefined;
    await switchTo(ctx, build.worker, build.workerLevel);
    return {
      entries: [
        ...(event.entries ?? []),
        {
          type: "custom_message" as const,
          customType: ANSWER_TYPE,
          content:
            "The planner finished without calling planner_answer. Implementer: its reply above is the answer; continue implementing.",
          display: false,
        },
      ],
      continue: true,
    } as never;
  });

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    wasPlanning = host.planning();
    if (state.build) await end(ctx, "restored");
    await migrateLegacy(ctx);
    syncTools();
  });
  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
    if (state.build) await end(ctx, "restored");
    syncTools();
  });
  pi.on("session_shutdown", () => {
    outcome = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    if (own > 0 || !state.build) return;
    const picked = (event as { model?: { provider: string; id: string } }).model ?? ctx.model;
    const selected = name(ctx, { provider: picked?.provider ?? "", modelId: picked?.id ?? "" });
    state = { version: 2, consult: false };
    persist();
    syncTools();
    if (ctx.hasUI) ctx.ui.notify(`${selected} selected; the build continues on it and it stays selected.`, "info");
  });

  pi.on("thinking_level_select", () => {
    if (effortOrigin() !== "plan-mode") manualSincePlanEntry = true;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!planEffortPending || !host.planning() || manualSincePlanEntry || workers(ctx).length === 0) return undefined;
    planEffortPending = false;
    let judged: ModelSpecThinkingLevel | undefined;
    try {
      judged = await host.judgePlanEffort(ctx, String((event as { prompt?: unknown }).prompt ?? ""));
    } catch {
      judged = undefined;
    }
    if (judged && host.planning() && !manualSincePlanEntry) {
      withEffortOrigin("plan-mode", () => pi.setThinkingLevel(judged as never));
    }
    return undefined;
  });

  pi.registerTool({
    name: "ask_planner",
    label: "Ask the planner",
    description:
      "Hands this conversation from the model implementing an approved plan to the model that planned it. Use it when the approved plan does not fit what you find (a step cannot be done as written, a fact it states is wrong, an unlisted change is needed, or it leaves a choice open), or for a hard design decision. The planner reads this whole conversation, including your changes, answers, and may amend the plan file; then you continue. Do not use it for questions only the user can answer.",
    promptSnippet: "Ask the model that planned the approved plan about it or a hard decision while you implement it",
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: { question: { type: "string", minLength: 1 } },
    } as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const question = String((params as { question?: unknown }).question ?? "");
      if (host.planning()) return text("You are in plan mode: you are the planner. Keep planning.") as never;
      const build = state.build;
      if (!build)
        return text(
          "ask_planner works only while another model implements an approved plan. Answer directly.",
        ) as never;
      if (state.consult) return text("A consultation is already open: answer it with planner_answer.") as never;
      state = {
        ...state,
        consult: true,
        build: { ...build, workerLevel: pi.getThinkingLevel() as ModelSpecThinkingLevel },
      };
      persist();
      const home = name(ctx, build.home);
      if (!(await switchTo(ctx, build.home, build.home.thinkingLevel))) {
        state = { ...state, consult: false };
        persist();
        return text(`Could not switch to ${home}; continue implementing on your own judgment.`) as never;
      }
      return text(
        `The implementer asks the planner (${home}):\n\n${question}\n\nPlanner: you are answering now, not implementing. This conversation shows the implementer's changes so far. Investigate with read-only tools as needed. Change nothing except the plan file (${build.planFile}): if your answer changes the plan, edit it and add a dated line under a "## Amendments" heading at its end. If the decision belongs to the user (a product choice, a permission, a check only a human can do), ask them with ask_user_question. Then call planner_answer with your answer; the implementer continues from it.`,
        { question, planner: home },
      ) as never;
    },
  });

  pi.registerTool({
    name: "planner_answer",
    label: "Answer the implementer",
    description:
      "Only while answering ask_planner: give the implementer your answer and hand the conversation back to it.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string", minLength: 1 }, amended: { type: "boolean" } },
    } as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { answer, amended } = params as { answer: string; amended?: boolean };
      const build = state.build;
      if (!state.consult || !build) return text("planner_answer only answers an open ask_planner question.") as never;
      state = { ...state, consult: false };
      persist();
      await switchTo(ctx, build.worker, build.workerLevel);
      return text(
        `Planner's answer${amended ? " (the plan file was amended; reread it)" : ""}:\n\n${answer}\n\nImplementer: continue implementing, following this answer.`,
      ) as never;
    },
  });

  pi.on("tool_call", (event, ctx) => {
    if (!state.consult) return undefined;
    const tool = event.toolName;
    const input = event.input as Record<string, unknown>;
    const lead = "The planner is answering a question:";
    if (tool === "edit" || tool === "write") {
      if (state.build && isPlanFile(input.path, ctx.cwd, state.build.planFile)) return undefined;
      return { block: true, reason: `${lead} nothing may change except the plan file.` };
    }
    if (tool === "bash") {
      const command = readCommand(input);
      // pi-tool-gate's read-only analysis, when it is loaded; otherwise this package's own policy.
      const gate = gateShellReads(command, ctx.cwd);
      if (gate === true) return undefined;
      const blocked =
        gate === false
          ? command.trim() || "(empty command)"
          : findBlockedCommandSegment(command, host.safeSubcommands() ?? {}, ctx.cwd);
      if (blocked === undefined) return undefined;
      return { block: true, reason: `${lead} only read-only commands run. Blocked: ${blocked}` };
    }
    if (tool === "bg_run") return { block: true, reason: `${lead} only read-only commands run.` };
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    const build = state.build;
    if (event.isError || state.consult || host.planning() || !build) return undefined;
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const file = resolve(ctx.cwd, expandHome(String((event.input as { path?: unknown })?.path ?? "")));
    if (isPlanFile(file, ctx.cwd, build.planFile) || noted.has(file)) return undefined;
    noted.add(file);
    const paths = planPaths(readPlan(build.planFile));
    if (paths.length === 0 || inPlan(file, ctx.cwd, paths)) return undefined;
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `\n\nNote: ${relative(ctx.cwd, file)} is not one of the files the plan changes. If changing it departs from the plan, call ask_planner before going further; if the plan implies it, carry on.`,
        },
      ],
    };
  });

  return {
    workers,
    async begin(ctx, worker, planFile) {
      const model = ctx.model;
      if (!model) return false;
      state = {
        version: 2,
        consult: false,
        build: {
          home: {
            provider: model.provider,
            modelId: model.id,
            thinkingLevel: pi.getThinkingLevel() as ModelSpecThinkingLevel,
          },
          worker: { provider: worker.provider, modelId: worker.modelId },
          planFile,
        },
      };
      noted.clear();
      persist();
      if (!(await switchTo(ctx, worker))) {
        state = { version: 2, consult: false };
        persist();
        return false;
      }
      syncTools();
      return true;
    },
    async cancel(ctx) {
      await end(ctx, "completed");
    },
    homeName(ctx) {
      return state.build ? name(ctx, state.build.home) : undefined;
    },
    phaseChanged(ctx) {
      const planning = host.planning();
      if (planning && !wasPlanning) {
        planEffortPending = true;
        manualSincePlanEntry = false;
        if (state.build) void end(ctx, "planning");
      }
      wasPlanning = planning;
      syncTools();
    },
    get state() {
      return state;
    },
  };
}
