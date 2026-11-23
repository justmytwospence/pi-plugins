import type { AvailableImplementationModel, ModelSpec } from "./implementation-models.ts";
import { compareGeneration, familyOf, latestInFamily, loadFamilyTable, TIERS } from "./model-families.ts";

export function bestFamily(
  available: readonly AvailableImplementationModel[],
  provider: string,
  family: string,
  routeId?: string,
): ModelSpec | undefined {
  const table = loadFamilyTable([]);
  const siblings = available.flatMap((model) => {
    if (model.provider !== provider) return [];
    const recognized = familyOf(table, provider, model.id);
    if (!recognized || recognized.family.id !== family || (routeId && recognized.route.id !== routeId)) return [];
    return [{ id: model.id, generation: recognized.generation }];
  });
  siblings.sort(
    (left, right) =>
      compareGeneration(right.generation, left.generation) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const best = siblings[0];
  return best ? { provider, modelId: best.id } : undefined;
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

/** Ids of the removed plan model pairs (`fableplan`, `astraplan-terra`, ...). */
export const LEGACY_PAIR_ID = /^([a-z]+)plan(?:-[a-z]+)?$/;

/**
 * Models that can implement a plan made on `session`: one tier down, then two tiers down, from the shared
 * family table. Only premium and strong families offer any, on routes that derive pairs. A route's `pairs`
 * override names the one-tier-down family.
 */
export function implementersFor(
  session: { provider: string; modelId: string },
  available: readonly AvailableImplementationModel[],
): ModelSpec[] {
  const table = loadFamilyTable([]);
  const own = familyOf(table, session.provider, session.modelId);
  if (!own || !own.route.derivePairs || own.family.source === "provisional") return [];
  const top = Math.max(...own.family.tiers.map((tier) => TIERS.indexOf(tier)));
  if (top < TIERS.indexOf("strong")) return [];
  const ranked = own.route.families.filter((family) => family.source !== "provisional" && family.id !== own.family.id);
  const used = new Set([own.family.id]);
  const override = own.route.pairs?.find((pair) => pair.planner === own.family.id)?.worker;
  const out: ModelSpec[] = [];
  for (const step of [1, 2]) {
    const tier = TIERS[top - step];
    if (!tier) break;
    const candidates =
      step === 1 && override
        ? ranked.filter((family) => family.id === override)
        : ranked.filter((family) => family.tiers.includes(tier) && !used.has(family.id));
    for (const family of candidates) {
      const found = bestFamily(available, session.provider, family.id, own.route.id);
      if (!found || (found.provider === session.provider && found.modelId === session.modelId)) continue;
      out.push(found);
      used.add(family.id);
      break;
    }
  }
  return out;
}

/** The newest available model of a removed pair's planner family, on the pair's provider. */
export function legacyPlanner(
  provider: string,
  family: string,
  available: readonly AvailableImplementationModel[],
): ModelSpec | undefined {
  for (const route of loadFamilyTable([]).routes) {
    if (!route.providers.includes(provider) || !route.families.some((candidate) => candidate.id === family)) continue;
    const found = bestFamily(available, provider, family, route.id);
    if (found) return found;
  }
  return undefined;
}
