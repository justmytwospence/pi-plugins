// Plan model pairs: a virtual model per planner/worker pair (Claude Code's opusplan for every family).
import {
  type AvailableImplementationModel,
  compareGeneration,
  familyOf,
  type ModelFamily,
  type ModelSpec,
} from "./implementation-models.js";

export type PairEnd = { family: ModelFamily } | { spec: ModelSpec };

export interface PairDefinition {
  provider: string;
  id: string;
  name: string;
  planner: PairEnd;
  worker: PairEnd;
}

const FAMILY_NAMES: Record<ModelFamily, string> = {
  astra: "Astra",
  sol: "Sol",
  terra: "Terra",
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  carbon: "Carbon",
  argon: "Argon",
  hydrogen: "Hydrogen",
  flash: "Flash",
};

const builtin = (provider: string, id: string, planner: ModelFamily, worker: ModelFamily): PairDefinition => ({
  provider,
  id,
  name: `${FAMILY_NAMES[planner]} plan, ${FAMILY_NAMES[worker]} build`,
  planner: { family: planner },
  worker: { family: worker },
});

export const BUILTIN_PAIRS: readonly PairDefinition[] = [
  builtin("anthropic", "fableplan", "fable", "opus"),
  builtin("anthropic", "opusplan", "opus", "sonnet"),
  builtin("openai-codex", "astraplan", "astra", "sol"),
  builtin("openai-codex", "solplan", "sol", "terra"),
  builtin("openai", "astraplan", "astra", "sol"),
  builtin("openai", "solplan", "sol", "terra"),
  builtin("google", "carbonplan", "carbon", "hydrogen"),
  builtin("google", "argonplan", "argon", "hydrogen"),
];

export function pairKey(p: { provider: string; id: string }): string {
  return `${p.provider}/${p.id}`;
}

export type CustomPairs = Readonly<Record<string, { planner: ModelSpec; worker: ModelSpec; name?: string }>>;

export function pairDefinitions(custom: CustomPairs | undefined): PairDefinition[] {
  const defs = [...BUILTIN_PAIRS];
  for (const [key, value] of Object.entries(custom ?? {})) {
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const provider = key.slice(0, slash);
    const id = key.slice(slash + 1);
    const def: PairDefinition = {
      provider,
      id,
      name: value.name ?? `${value.planner.modelId} plan, ${value.worker.modelId} build`,
      planner: { spec: value.planner },
      worker: { spec: value.worker },
    };
    const index = defs.findIndex((existing) => pairKey(existing) === key);
    if (index >= 0) defs[index] = def;
    else defs.push(def);
  }
  return defs;
}

const has = (available: readonly AvailableImplementationModel[], spec: { provider: string; modelId: string }) =>
  available.some((model) => model.provider === spec.provider && model.id === spec.modelId);

/** Google serves one model on two lanes: Antigravity (subscription, `antigravity-` prefix) and the API. */
export const laneOf = (modelId: string): "antigravity" | "api" =>
  modelId.startsWith("antigravity-") ? "antigravity" : "api";

function bestFamily(
  available: readonly AvailableImplementationModel[],
  provider: string,
  family: ModelFamily,
  prefer?: number[],
  lane?: "antigravity" | "api",
): ModelSpec | undefined {
  const siblings = available.flatMap((model) => {
    if (model.provider !== provider || (lane && laneOf(model.id) !== lane)) return [];
    const recognized = familyOf({ provider, modelId: model.id });
    return recognized?.family === family ? [{ id: model.id, generation: recognized.generation }] : [];
  });
  siblings.sort((left, right) => {
    if (prefer) {
      const leftSame = compareGeneration(left.generation, prefer) === 0;
      const rightSame = compareGeneration(right.generation, prefer) === 0;
      if (leftSame !== rightSame) return Number(rightSame) - Number(leftSame);
    }
    return (
      compareGeneration(right.generation, left.generation) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
  });
  const best = siblings[0];
  return best ? { provider, modelId: best.id } : undefined;
}

export function resolvePair(
  def: PairDefinition,
  available: readonly AvailableImplementationModel[],
): { planner: ModelSpec; worker: ModelSpec } | { error: string } {
  let planner: ModelSpec | undefined;
  if ("spec" in def.planner) {
    if (!has(available, def.planner.spec))
      return { error: `${def.planner.spec.provider}/${def.planner.spec.modelId} is not available` };
    planner = def.planner.spec;
  } else {
    planner =
      bestFamily(available, def.provider, def.planner.family, undefined, "antigravity") ??
      bestFamily(available, def.provider, def.planner.family, undefined, "api");
    if (!planner) return { error: `no available ${FAMILY_NAMES[def.planner.family]} model on ${def.provider}` };
  }
  let worker: ModelSpec | undefined;
  if ("spec" in def.worker) {
    if (!has(available, def.worker.spec))
      return { error: `${def.worker.spec.provider}/${def.worker.spec.modelId} is not available` };
    worker = def.worker.spec;
  } else {
    worker = bestFamily(
      available,
      def.provider,
      def.worker.family,
      familyOf(planner)?.generation,
      laneOf(planner.modelId),
    );
    if (!worker) return { error: `no available ${FAMILY_NAMES[def.worker.family]} model on ${def.provider}` };
  }
  if (planner.provider === worker.provider && planner.modelId === worker.modelId) {
    return { error: "planner and worker are the same model" };
  }
  return {
    planner: { provider: planner.provider, modelId: planner.modelId },
    worker: { provider: worker.provider, modelId: worker.modelId },
  };
}
