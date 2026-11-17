import type { AvailableImplementationModel, ModelSpec } from "./implementation-models.js";
import {
  compareGeneration,
  derivePairs,
  familyName,
  familyOf,
  latestInFamily,
  loadFamilyTable,
} from "./model-families.js";

export type PairEnd = { family: string } | { spec: ModelSpec };

export interface PairDefinition {
  provider: string;
  id: string;
  name: string;
  planner: PairEnd;
  worker: PairEnd;
  /** Built-in pairs: the family-table routes the pair resolves on, tried in order (Antigravity before the API). */
  routes?: string[];
  /** Keep serving the worker after approval, including later work and chat turns. */
  handoff?: "persistent";
}

/** Premium-planner pairs: the worker keeps serving after approval. */
const PERSISTENT = new Set([
  "anthropic/fableplan",
  "anthropic/fableplan-sonnet",
  "openai/astraplan",
  "openai/astraplan-terra",
  "openai-codex/astraplan",
  "openai-codex/astraplan-terra",
]);

/**
 * Built-in pairs, derived from the shared family table: each route's top premium and strong family
 * plans, the top family of the next tier down builds; a premium planner also builds on the balanced tier. Only ranked families take part, so the
 * registry (and its provisional discoveries) is not needed here.
 */
export function builtinPairs(): PairDefinition[] {
  return derivePairs(loadFamilyTable([])).map((spec) => ({
    provider: spec.provider,
    id: spec.id,
    name: spec.name,
    planner: { family: spec.planner },
    worker: { family: spec.worker },
    routes: spec.routes,
    ...(PERSISTENT.has(pairKey(spec)) ? { handoff: "persistent" as const } : {}),
  }));
}

export function pairKey(p: { provider: string; id: string }): string {
  return `${p.provider}/${p.id}`;
}

export type CustomPairs = Readonly<Record<string, { planner: ModelSpec; worker: ModelSpec; name?: string }>>;

export function pairDefinitions(custom: CustomPairs | undefined): PairDefinition[] {
  const defs = builtinPairs();
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
    if (index >= 0) {
      const handoff = defs[index]?.handoff;
      defs[index] = { ...def, ...(handoff ? { handoff } : {}) };
    } else defs.push(def);
  }
  return defs;
}

const has = (available: readonly AvailableImplementationModel[], spec: { provider: string; modelId: string }) =>
  available.some((model) => model.provider === spec.provider && model.id === spec.modelId);

function bestFamily(
  available: readonly AvailableImplementationModel[],
  provider: string,
  family: string,
  prefer?: number[],
  routeId?: string,
): ModelSpec | undefined {
  const table = loadFamilyTable([]);
  const siblings = available.flatMap((model) => {
    if (model.provider !== provider) return [];
    const recognized = familyOf(table, provider, model.id);
    if (!recognized || recognized.family.id !== family || (routeId && recognized.route.id !== routeId)) return [];
    return [{ id: model.id, generation: recognized.generation }];
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
  const asSpecs = available.map((model) => ({ provider: model.provider, modelId: model.id }));
  if ("spec" in def.planner) {
    // A custom pair's model names its family too.
    const spec = latestSpec(def.planner.spec, asSpecs);
    if (!has(available, spec)) return { error: `${spec.provider}/${spec.modelId} is not available` };
    planner = spec;
  } else {
    const family = def.planner.family;
    for (const routeId of def.routes ?? [undefined]) {
      planner = bestFamily(available, def.provider, family, undefined, routeId);
      if (planner) break;
    }
    if (!planner) return { error: `no available ${familyName(family)} model on ${def.provider}` };
  }
  let worker: ModelSpec | undefined;
  if ("spec" in def.worker) {
    const spec = latestSpec(def.worker.spec, asSpecs);
    if (!has(available, spec)) return { error: `${spec.provider}/${spec.modelId} is not available` };
    worker = spec;
  } else {
    const planned = familyOf(loadFamilyTable([]), planner.provider, planner.modelId);
    worker = bestFamily(available, def.provider, def.worker.family, planned?.generation, planned?.route.id);
    if (!worker) return { error: `no available ${familyName(def.worker.family)} model on ${def.provider}` };
  }
  if (planner.provider === worker.provider && planner.modelId === worker.modelId) {
    return { error: "planner and worker are the same model" };
  }
  return {
    planner: { provider: planner.provider, modelId: planner.modelId },
    worker: { provider: worker.provider, modelId: worker.modelId },
  };
}

/**
 * A configured model names its family, not a pinned release: `spec` moved to the newest generation of
 * its family in `available` (same provider and route), effort kept. Other models come back unchanged.
 */
export function latestSpec<T extends { provider: string; modelId: string }>(
  spec: T,
  available: readonly { provider: string; modelId: string }[],
): T {
  const latest = latestInFamily(
    loadFamilyTable([]),
    `${spec.provider}/${spec.modelId}`,
    available.map((model) => ({ provider: model.provider, id: model.modelId })),
  );
  const modelId = latest.slice(spec.provider.length + 1);
  return modelId === spec.modelId ? spec : { ...spec, modelId };
}
