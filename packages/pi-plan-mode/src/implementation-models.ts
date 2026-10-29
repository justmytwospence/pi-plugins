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

/** The model pi-subagents gives its worker role for a session on `parent`; undefined without pi-subagents. */
export function subagentWorkerModel(
  events: { emit(channel: string, data: unknown): void },
  parent: ModelSpec,
): ModelSpec | undefined {
  const request: { role: string; parent: string; thinking?: string; reply?: { model?: unknown; thinking?: unknown } } =
    {
      role: "worker",
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

export type ImplementationSource = "map" | "subagents" | "fallback";

/**
 * The default implementing model for a plan written on `planModel`: its implementationModelMap entry,
 * then pi-subagents' worker model, then `fallback`. A candidate missing from a non-empty `available`
 * list is skipped.
 */
export function implementationTarget(input: {
  planModel: ModelSpec | undefined;
  map: Readonly<Record<string, ModelSpec>> | undefined;
  worker: ModelSpec | undefined;
  fallback: ModelSpec | undefined;
  available: readonly { provider: string; id: string }[];
}): { spec: ModelSpec; source: ImplementationSource } | undefined {
  const usable = (spec: ModelSpec) =>
    input.available.length === 0 ||
    input.available.some((model) => model.provider === spec.provider && model.id === spec.modelId);
  const mapped = input.planModel ? input.map?.[formatModelKey(input.planModel)] : undefined;
  if (mapped && usable(mapped)) {
    const thinkingLevel = mapped.thinkingLevel ?? input.planModel?.thinkingLevel;
    return {
      spec: { provider: mapped.provider, modelId: mapped.modelId, ...(thinkingLevel ? { thinkingLevel } : {}) },
      source: "map",
    };
  }
  if (input.worker && usable(input.worker)) return { spec: input.worker, source: "subagents" };
  if (input.fallback) return { spec: input.fallback, source: "fallback" };
  return undefined;
}
