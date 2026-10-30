import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH = 512;

export const MODEL_SPEC_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelSpecThinkingLevel = (typeof MODEL_SPEC_THINKING_LEVELS)[number];

export interface ImplementationModelOverride {
  provider: string;
  modelId: string;
}

/** A model plus an optional thinking level, written as `provider/modelId[:thinking]`. */
export interface ModelSpec extends ImplementationModelOverride {
  thinkingLevel?: ModelSpecThinkingLevel;
}

export type ImplementationContextChoice = "keep" | "clear";
export const IMPLEMENTATION_CONTEXT_CHOICES = ["keep", "clear"] as const;

export interface AvailableImplementationModel {
  provider: string;
  id: string;
  name?: string;
}

export function isPendingImplementationModelIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH
  );
}

/**
 * Parse `provider/modelId[:thinking]`. The provider ends at the first slash, so model IDs may
 * contain slashes (OpenRouter-style IDs). A trailing `:level` is only treated as a thinking
 * suffix when it names a known level, so IDs such as `model:0` survive intact.
 */
export function parseModelSpec(value: unknown): ModelSpec | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  let thinkingLevel: ModelSpecThinkingLevel | undefined;
  const colon = text.lastIndexOf(":");
  if (colon > 0) {
    const suffix = text.slice(colon + 1).toLowerCase();
    if ((MODEL_SPEC_THINKING_LEVELS as readonly string[]).includes(suffix)) {
      thinkingLevel = suffix as ModelSpecThinkingLevel;
      text = text.slice(0, colon);
    }
  }
  const slash = text.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = text.slice(0, slash).trim();
  const modelId = text.slice(slash + 1).trim();
  if (!isPendingImplementationModelIdentifier(provider) || !isPendingImplementationModelIdentifier(modelId)) {
    return undefined;
  }
  return { provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function formatModelKey(model: ImplementationModelOverride) {
  return `${model.provider}/${model.modelId}`;
}

export function formatModelSpec(spec: ModelSpec) {
  return spec.thinkingLevel ? `${formatModelKey(spec)}:${spec.thinkingLevel}` : formatModelKey(spec);
}

export function sameModel(
  left: ImplementationModelOverride | undefined,
  right: ImplementationModelOverride | undefined,
) {
  return (
    left !== undefined && right !== undefined && left.provider === right.provider && left.modelId === right.modelId
  );
}

export function snapshotAvailableImplementationModels(ctx: ExtensionContext): AvailableImplementationModel[] {
  const getAvailable = ctx.modelRegistry.getAvailable;
  const availableModels = typeof getAvailable === "function" ? getAvailable.call(ctx.modelRegistry) : [];
  const scopedModels = ctx.scopedModels ?? [];
  if (scopedModels.length === 0) return availableModels;
  return scopedModels.flatMap((entry) => {
    const availableModel = availableModels.find(
      (model) => model.provider === entry.model.provider && model.id === entry.model.id,
    );
    return availableModel ? [availableModel] : [];
  });
}

/** pi-subagents' channel (its src/index.ts ROLE_MODEL): which model and effort a role gets for a parent model. */
export const ROLE_MODEL_CHANNEL = "subagents:role-model";

/** The model pi-subagents gives `role` for a session on `parent`; undefined without pi-subagents. */
export function subagentRoleModel(
  events: { emit(channel: string, data: unknown): void },
  role: string,
  parent: ModelSpec,
): ModelSpec | undefined {
  const request: { role: string; parent: string; thinking?: string; reply?: { model?: unknown; thinking?: unknown } } =
    {
      role,
      parent: formatModelKey(parent),
      ...(parent.thinkingLevel ? { thinking: parent.thinkingLevel } : {}),
    };
  try {
    events.emit(ROLE_MODEL_CHANNEL, request);
  } catch {
    return undefined;
  }
  const spec = parseModelSpec(request.reply?.model);
  if (!spec) return undefined;
  const thinking = request.reply?.thinking;
  const level = (MODEL_SPEC_THINKING_LEVELS as readonly unknown[]).includes(thinking)
    ? (thinking as ModelSpecThinkingLevel)
    : undefined;
  return { provider: spec.provider, modelId: spec.modelId, ...(level ? { thinkingLevel: level } : {}) };
}

export type ImplementationSource = "map" | "default";
export interface ImplementationChoice {
  spec: ModelSpec;
  source: ImplementationSource;
}

type ModelFamily = "astra" | "sol" | "terra" | "fable" | "opus" | "sonnet";

function familyOf(model: ImplementationModelOverride): { family: ModelFamily; generation: number[] } | undefined {
  const match =
    model.provider === "openai" || model.provider === "openai-codex"
      ? /^gpt-(\d+(?:\.\d+)*)-(astra|sol|terra)$/u.exec(model.modelId)
      : model.provider === "anthropic"
        ? /^claude-(fable|opus|sonnet)-(\d+(?:-\d+)*)$/u.exec(model.modelId)
        : undefined;
  if (!match) return undefined;
  const anthropic = model.provider === "anthropic";
  const generation = (anthropic ? match[2] : match[1]) as string;
  // Dated Anthropic snapshots are not generation IDs.
  if (anthropic && generation.split("-").some((part) => /^\d{8}$/u.test(part))) return undefined;
  return {
    family: (anthropic ? match[1] : match[2]) as ModelFamily,
    generation: generation.split(anthropic ? "-" : ".").map(Number),
  };
}

function compareGeneration(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const LOWER_FAMILIES: Partial<Record<ModelFamily, ModelFamily[]>> = {
  astra: ["sol", "terra"],
  sol: ["terra"],
  fable: ["opus", "sonnet"],
  opus: ["sonnet"],
};

/** Ordered, available, distinct handoff targets; explicit entries (including []) replace defaults. */
export function implementationChoices(input: {
  planModel: ModelSpec | undefined;
  map: Readonly<Record<string, readonly ModelSpec[]>> | undefined;
  available: readonly AvailableImplementationModel[];
}): ImplementationChoice[] {
  const planner = input.planModel;
  if (!planner) return [];
  const key = formatModelKey(planner);
  const mapped = input.map !== undefined && Object.hasOwn(input.map, key);
  let candidates: readonly ModelSpec[];
  if (mapped) {
    candidates = input.map?.[key] ?? [];
  } else {
    const planningFamily = familyOf(planner);
    if (!planningFamily) return [];
    candidates = (LOWER_FAMILIES[planningFamily.family] ?? []).flatMap((family) => {
      const siblings = input.available.flatMap((model) => {
        if (model.provider !== planner.provider) return [];
        const spec = { provider: model.provider, modelId: model.id };
        const recognized = familyOf(spec);
        return recognized?.family === family ? [{ spec, generation: recognized.generation }] : [];
      });
      siblings.sort((left, right) => {
        const leftSame = compareGeneration(left.generation, planningFamily.generation) === 0;
        const rightSame = compareGeneration(right.generation, planningFamily.generation) === 0;
        return (
          Number(rightSame) - Number(leftSame) ||
          compareGeneration(right.generation, left.generation) ||
          (left.spec.modelId < right.spec.modelId ? -1 : left.spec.modelId > right.spec.modelId ? 1 : 0)
        );
      });
      return siblings[0] ? [siblings[0].spec] : [];
    });
  }
  const seen = new Set<string>();
  return candidates.flatMap((spec) => {
    const identity = formatModelKey(spec);
    if (
      sameModel(planner, spec) ||
      seen.has(identity) ||
      !input.available.some((model) => model.provider === spec.provider && model.id === spec.modelId)
    ) {
      return [];
    }
    seen.add(identity);
    return [{ spec, source: mapped ? ("map" as const) : ("default" as const) }];
  });
}
