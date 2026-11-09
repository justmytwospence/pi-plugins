// Plan model pairs at run time: virtual models that route each request to the planner while planning
// (or consulting) and to the worker otherwise, plus ask_planner / planner_answer for in-transcript
// consultation. Nothing here changes the selected model.
import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setToolsActive } from "./active-tools.js";
import { effortOrigin, withEffortOrigin } from "./effort-origin.js";
import { MODEL_SPEC_THINKING_LEVELS, type ModelSpec, type ModelSpecThinkingLevel } from "./implementation-models.js";
import { type PairDefinition, pairKey, resolvePair } from "./model-pairs.js";
import { inPlan, isPlanFile, planPaths, readPlan } from "./plan-file.js";
import { expandHome } from "./plan-hook.js";
import { findBlockedCommandSegment, readCommand, type SafeSubcommands } from "./tool-policy.js";

export const PAIR_ENTRY = "plan-mode:pair";
export const PAIR_TOOLS = ["ask_planner", "planner_answer"] as const;
const ANSWER_TYPE = "plan-mode-planner-answer";

export interface PairState {
  version: 1;
  consult: boolean;
  planFile?: string;
  planLevel?: ModelSpecThinkingLevel;
}

export interface PairHost {
  /** Whether inline plan mode is on. */
  planning(): boolean;
  safeSubcommands(): SafeSubcommands | undefined;
  judgePlanEffort(ctx: ExtensionContext, prompt: string): Promise<ModelSpecThinkingLevel | undefined>;
}

export interface SelectedPair {
  def: PairDefinition;
  planner: ModelSpec;
  worker: ModelSpec;
  plannerName: string;
  workerName: string;
}

export interface PairController {
  define(defs: PairDefinition[]): void;
  selected(ctx: ExtensionContext): SelectedPair | undefined;
  approve(ctx: ExtensionContext, planFile: string): void;
  phaseChanged(ctx: ExtensionContext): void;
  readonly state: PairState;
}

const text = (value: string, details?: unknown) => ({
  content: [{ type: "text" as const, text: value }],
  details: details ?? {},
});

export function registerPairs(pi: ExtensionAPI, host: PairHost): PairController {
  let state: PairState = { version: 1, consult: false };
  let defs: PairDefinition[] = [];
  const registered = new Set<string>();
  const noted = new Set<string>();
  let planEffortPending = false;
  let manualSincePlanEntry = false;
  let wasPlanning = false;
  const virtualApi = typeof (pi as { registerVirtualModel?: unknown }).registerVirtualModel === "function";

  const persist = () => {
    try {
      pi.appendEntry(PAIR_ENTRY, structuredClone(state));
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

  const selected = (ctx: ExtensionContext): SelectedPair | undefined => {
    const model = ctx.model;
    if (!model) return undefined;
    const key = pairKey(model);
    const def = defs.find((candidate) => pairKey(candidate) === key);
    if (!def) return undefined;
    const resolved = resolvePair(def, available(ctx));
    if ("error" in resolved) return undefined;
    const name = (spec: ModelSpec) => ctx.modelRegistry.find(spec.provider, spec.modelId)?.name ?? spec.modelId;
    return { def, ...resolved, plannerName: name(resolved.planner), workerName: name(resolved.worker) };
  };

  const register = (def: PairDefinition) => {
    const api = pi as unknown as {
      registerVirtualModel(model: unknown): void;
    };
    api.registerVirtualModel({
      provider: def.provider,
      id: def.id,
      name: def.name,
      thinkingLevels: MODEL_SPEC_THINKING_LEVELS,
      input: ["text", "image"],
      route(request: { model: { provider: string; id: string }; thinkingLevel: string }, ctx: ExtensionContext) {
        const current = defs.find((candidate) => pairKey(candidate) === pairKey(request.model)) ?? def;
        const resolved = resolvePair(current, available(ctx));
        if ("error" in resolved) throw new Error(`${current.name}: ${resolved.error}`);
        const phase = state.consult ? "consult" : host.planning() ? "plan" : "build";
        const target = phase === "build" ? resolved.worker : resolved.planner;
        const model = ctx.modelRegistry.find(target.provider, target.modelId);
        if (!model) throw new Error(`${current.name}: ${target.provider}/${target.modelId} is not available`);
        const thinkingLevel = phase === "consult" ? (state.planLevel ?? request.thinkingLevel) : request.thinkingLevel;
        return { model, thinkingLevel };
      },
    });
  };

  const define = (next: PairDefinition[]) => {
    if (!virtualApi) return;
    defs = next;
    const keys = new Set(next.map(pairKey));
    for (const key of [...registered]) {
      if (keys.has(key)) continue;
      const slash = key.indexOf("/");
      try {
        (pi as unknown as { unregisterVirtualModel(p: string, i: string): void }).unregisterVirtualModel(
          key.slice(0, slash),
          key.slice(slash + 1),
        );
      } catch {
        // Already gone.
      }
      registered.delete(key);
    }
    for (const def of next) {
      register(def);
      registered.add(pairKey(def));
    }
  };

  const restore = (ctx: ExtensionContext) => {
    state = { version: 1, consult: false };
    try {
      for (const entry of ctx.sessionManager.getBranch() as readonly {
        type?: string;
        customType?: string;
        data?: unknown;
      }[]) {
        if (entry.type !== "custom" || entry.customType !== PAIR_ENTRY) continue;
        const data = entry.data as Partial<PairState> | undefined;
        if (data?.version !== 1 || typeof data.consult !== "boolean") continue;
        state = {
          version: 1,
          consult: data.consult,
          ...(typeof data.planFile === "string" ? { planFile: data.planFile } : {}),
          ...(typeof data.planLevel === "string" &&
          (MODEL_SPEC_THINKING_LEVELS as readonly string[]).includes(data.planLevel)
            ? { planLevel: data.planLevel as ModelSpecThinkingLevel }
            : {}),
        };
      }
    } catch {
      // Keep the default.
    }
    noted.clear();
  };

  const syncTools = (ctx: ExtensionContext) => {
    if (!virtualApi) return;
    setToolsActive(pi, PAIR_TOOLS, selected(ctx) !== undefined);
  };

  const prune = (ctx: ExtensionContext) => {
    if (!virtualApi) return;
    const current = ctx.model ? pairKey(ctx.model) : undefined;
    for (const def of defs) {
      const key = pairKey(def);
      if (key === current || !registered.has(key)) continue;
      if (!("error" in resolvePair(def, available(ctx)))) continue;
      try {
        (pi as unknown as { unregisterVirtualModel(p: string, i: string): void }).unregisterVirtualModel(
          def.provider,
          def.id,
        );
      } catch {
        // Already gone.
      }
      registered.delete(key);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    wasPlanning = host.planning();
    define(defs);
    prune(ctx);
    syncTools(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    syncTools(ctx);
  });
  pi.on("model_select", (_event, ctx) => syncTools(ctx));

  pi.on("thinking_level_select", () => {
    if (effortOrigin() !== "plan-mode") manualSincePlanEntry = true;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!planEffortPending || !host.planning() || !selected(ctx) || manualSincePlanEntry) return undefined;
    planEffortPending = false;
    let level: ModelSpecThinkingLevel | undefined;
    try {
      level = await host.judgePlanEffort(ctx, String((event as { prompt?: unknown }).prompt ?? ""));
    } catch {
      level = undefined;
    }
    if (level && host.planning() && selected(ctx) && !manualSincePlanEntry) {
      withEffortOrigin("plan-mode", () => pi.setThinkingLevel(level as never));
    }
    return undefined;
  });

  pi.registerTool({
    name: "ask_planner",
    label: "Ask the planner",
    description:
      "Hands this conversation to the planning model of your model pair (it planned; you implement). Use it when the approved plan does not fit what you find (a step cannot be done as written, a fact it states is wrong, an unlisted change is needed, or it leaves a choice open), or for a hard design decision. The planner reads this whole conversation, including your changes, answers, and may amend the plan file; then you continue. Do not use it for questions only the user can answer.",
    promptSnippet: "Ask the planning model of your plan model pair about the plan or a decision during implementation",
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: { question: { type: "string", minLength: 1 } },
    } as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const question = String((params as { question?: unknown }).question ?? "");
      const pair = selected(ctx);
      if (!pair)
        return text("ask_planner works only with a plan model pair selected, such as anthropic/opusplan.") as never;
      if (host.planning()) return text("You are in plan mode: you are the planner. Keep planning.") as never;
      if (state.consult) return text("A consultation is already open: answer it with planner_answer.") as never;
      state = { ...state, consult: true };
      persist();
      const file = state.planFile ? ` (${state.planFile})` : "";
      return text(
        `The implementer asks the planner (${pair.plannerName}):\n\n${question}\n\nPlanner: you are answering now, not implementing. This conversation shows the implementer's changes so far. Investigate with read-only tools as needed. Change nothing except the plan file${file}: if your answer changes the plan, edit it and add a dated line under a "## Amendments" heading at its end. If the decision belongs to the user (a product choice, a permission, a check only a human can do), ask them with ask_user_question. Then call planner_answer with your answer; the implementer continues from it.`,
        { question, planner: pair.plannerName },
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
    async execute(_id, params) {
      const { answer, amended } = params as { answer: string; amended?: boolean };
      if (!state.consult) return text("planner_answer only answers an open ask_planner question.") as never;
      state = { ...state, consult: false };
      persist();
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
      if (state.planFile && isPlanFile(input.path, ctx.cwd, state.planFile)) return undefined;
      return { block: true, reason: `${lead} nothing may change except the plan file.` };
    }
    if (tool === "bash") {
      const blocked = findBlockedCommandSegment(readCommand(input), host.safeSubcommands() ?? {}, ctx.cwd);
      if (blocked === undefined) return undefined;
      return { block: true, reason: `${lead} only read-only commands run. Blocked: ${blocked}` };
    }
    if (tool === "bg_run") return { block: true, reason: `${lead} only read-only commands run.` };
    return undefined;
  });

  pi.on("agent_before_settle", (event) => {
    if (!state.consult) return undefined;
    state = { ...state, consult: false };
    persist();
    if (event.outcome !== "completed") return undefined;
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

  pi.on("tool_result", (event, ctx) => {
    if (event.isError || state.consult || host.planning() || !state.planFile || !selected(ctx)) return undefined;
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const file = resolve(ctx.cwd, expandHome(String((event.input as { path?: unknown })?.path ?? "")));
    if (isPlanFile(file, ctx.cwd, state.planFile) || noted.has(file)) return undefined;
    noted.add(file);
    const paths = planPaths(readPlan(state.planFile));
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
    define,
    selected,
    approve(ctx, planFile) {
      if (!selected(ctx)) return;
      state = { version: 1, consult: false, planFile, planLevel: pi.getThinkingLevel() as ModelSpecThinkingLevel };
      noted.clear();
      persist();
    },
    phaseChanged(ctx) {
      const planning = host.planning();
      if (planning && !wasPlanning) {
        planEffortPending = true;
        manualSincePlanEntry = false;
      }
      wasPlanning = planning;
      syncTools(ctx);
    },
    get state() {
      return state;
    },
  };
}
