import type { AvailableImplementationModel, ModelSpec } from "./implementation-models.js";
import { compareGeneration, derivePairs, familyName, familyOf, loadFamilyTable } from "./model-families.js";

export type PairEnd = { family: string } | { spec: ModelSpec };

export interface PairDefinition {
  provider: string;
  id: string;
  name: string;
  planner: PairEnd;
  worker: PairEnd;
  /** Built-in pairs: the family-table routes the pair resolves on, tried in order (Antigravity before the API). */
  routes?: string[];
}

/**
 * Built-in pairs, derived from the shared family table: each route's top premium and strong family
 * plans, the top family of the next tier down builds. Only ranked families take part, so the
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
    if (index >= 0) defs[index] = def;
    else defs.push(def);
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
  if ("spec" in def.planner) {
    if (!has(available, def.planner.spec))
      return { error: `${def.planner.spec.provider}/${def.planner.spec.modelId} is not available` };
    planner = def.planner.spec;
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
    if (!has(available, def.worker.spec))
      return { error: `${def.worker.spec.provider}/${def.worker.spec.modelId} is not available` };
    worker = def.worker.spec;
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
