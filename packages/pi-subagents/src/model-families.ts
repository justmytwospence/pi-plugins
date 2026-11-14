// Package-local model family table. Keep all copies byte-identical; no sibling imports.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MODEL_FAMILIES_CHANGED = "pi-plugins.model-families-changed.v1";
export type Tier = "fast" | "balanced" | "strong" | "premium";
export const TIERS: readonly Tier[] = ["fast", "balanced", "strong", "premium"];
export interface ModelInfo {
  provider: string;
  id: string;
  cost?: { input?: number; output?: number };
}
export interface FamilyDef {
  id: string;
  name?: string;
  tiers: Tier[];
}
export interface PairOverride {
  planner: string;
  worker: string;
}
export interface RouteDef {
  /** "google/antigravity-gemini" */
  id: string;
  /** Providers whose models belong to this route. */
  providers: string[];
  /** Key into the built-in role profiles. */
  profileProvider: string;
  /** Route membership: the model id starts with this. */
  prefix: string;
  /** Regex source with named groups `family` and `gen`. */
  match: string;
  genSeparator: "." | "-";
  /** "gemini-{gen}-{family}"; used to find the API twin that prices a subscription route. */
  format: string;
  /** Route id whose models price this route's (Antigravity to API). */
  priceFrom?: string;
  preferParentGeneration?: boolean;
  derivePairs: boolean;
  /** Preference order. */
  families: FamilyDef[];
  ignore?: string[];
  pairs?: PairOverride[];
}
export interface FamiliesFile {
  version: 1;
  routes?: Record<string, { add?: (FamilyDef & { before?: string })[]; ignore?: string[]; pairs?: PairOverride[] }>;
  seen?: Record<string, string[]>;
}
export interface ResolvedFamily {
  id: string;
  name: string;
  tiers: Tier[];
  source: "builtin" | "user" | "provisional";
  price?: number;
}
export interface TableRoute extends Omit<RouteDef, "families"> {
  families: ResolvedFamily[];
}
export interface Discovery {
  route: string;
  family: string;
  name: string;
  newest: string;
  tiers: Tier[];
  price?: number;
  basis?: string;
}
export interface FamilyTable {
  routes: TableRoute[];
  discoveries: Discovery[];
  error?: string;
}
export interface PairSpec {
  provider: string;
  id: string;
  name: string;
  planner: string;
  worker: string;
  routes: string[];
}

export const BUILTIN_ROUTES: readonly RouteDef[] = [
  {
    id: "anthropic",
    providers: ["anthropic"],
    profileProvider: "anthropic",
    prefix: "claude-",
    match: String.raw`^claude-(?<family>[a-z]+)-(?<gen>\d+(?:-\d+)*)$`,
    genSeparator: "-",
    format: "claude-{family}-{gen}",
    derivePairs: true,
    families: [
      { id: "fable", tiers: ["premium"] },
      { id: "opus", tiers: ["strong"] },
      { id: "sonnet", tiers: ["balanced"] },
      { id: "haiku", tiers: ["fast"] },
    ],
  },
  {
    id: "openai",
    providers: ["openai-codex", "openai"],
    profileProvider: "openai",
    prefix: "gpt-",
    match: String.raw`^gpt-(?<gen>\d+(?:\.\d+)*)-(?<family>[a-z]+)$`,
    genSeparator: ".",
    format: "gpt-{gen}-{family}",
    preferParentGeneration: true,
    derivePairs: true,
    families: [
      { id: "astra", tiers: ["premium"] },
      { id: "sol", tiers: ["strong"] },
      { id: "terra", tiers: ["balanced"] },
      { id: "luna", tiers: ["fast"] },
    ],
  },
  {
    id: "google/antigravity-claude",
    providers: ["google"],
    profileProvider: "anthropic",
    prefix: "antigravity-claude-",
    match: String.raw`^antigravity-claude-(?<family>[a-z]+)-(?<gen>\d+(?:-\d+)*)$`,
    genSeparator: "-",
    format: "antigravity-claude-{family}-{gen}",
    priceFrom: "anthropic",
    derivePairs: false,
    families: [
      { id: "opus", tiers: ["strong"] },
      { id: "sonnet", tiers: ["fast", "balanced"] },
    ],
  },
  {
    id: "google/antigravity-gemini",
    providers: ["google"],
    profileProvider: "google",
    prefix: "antigravity-gemini-",
    match: String.raw`^antigravity-gemini-(?<gen>\d+(?:\.\d+)*)-(?<family>[a-z]+)$`,
    genSeparator: ".",
    format: "antigravity-gemini-{gen}-{family}",
    priceFrom: "google/gemini",
    derivePairs: true,
    families: [
      { id: "carbon", tiers: ["premium"] },
      { id: "argon", tiers: ["strong"] },
      { id: "pro", tiers: ["strong"] },
      { id: "hydrogen", tiers: ["fast", "balanced"] },
      { id: "flash", tiers: ["fast", "balanced"] },
    ],
    pairs: [{ planner: "carbon", worker: "hydrogen" }],
  },
  {
    id: "google/gemini",
    providers: ["google"],
    profileProvider: "google",
    prefix: "gemini-",
    match: String.raw`^gemini-(?<gen>\d+(?:\.\d+)*)-(?<family>[a-z]+(?:-lite)?)$`,
    genSeparator: ".",
    format: "gemini-{gen}-{family}",
    derivePairs: true,
    families: [
      { id: "carbon", tiers: ["premium"] },
      { id: "argon", tiers: ["strong"] },
      { id: "pro", tiers: ["strong"] },
      { id: "hydrogen", tiers: ["balanced"] },
      { id: "flash", tiers: ["balanced"] },
      { id: "flash-lite", tiers: ["fast"] },
    ],
    pairs: [{ planner: "carbon", worker: "hydrogen" }],
  },
  {
    id: "muse-code",
    providers: ["muse-code"],
    profileProvider: "muse-code",
    prefix: "muse-",
    match: String.raw`^muse-(?<family>[a-z]+)-(?<gen>\d+(?:\.\d+)*)$`,
    genSeparator: ".",
    format: "muse-{family}-{gen}",
    derivePairs: false,
    families: [
      { id: "wonder", tiers: ["strong"] },
      { id: "spark", tiers: ["fast", "balanced"] },
    ],
  },
];

export function agentDir(): string {
  return path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"));
}
export function modelFamiliesPath(): string {
  return path.join(agentDir(), "model-families.json");
}

/** "flash-lite" becomes "Flash-Lite". */
export function familyName(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

const regexCache = new Map<string, RegExp>();
function regexOf(source: string): RegExp {
  let regex = regexCache.get(source);
  if (!regex) {
    regex = new RegExp(source, "u");
    regexCache.set(source, regex);
  }
  return regex;
}

/** A model id's family and generation on a route; undefined for other shapes and dated snapshots. */
export function parseId(
  route: Pick<RouteDef, "match" | "genSeparator">,
  id: string,
): { family: string; generation: number[] } | undefined {
  const groups = regexOf(route.match).exec(id)?.groups;
  if (!groups?.family || !groups.gen) return undefined;
  const parts = groups.gen.split(route.genSeparator);
  if (parts.some((part) => part.length >= 8)) return undefined;
  return { family: groups.family, generation: parts.map(Number) };
}

export function compareGeneration(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The first route whose providers include `provider` and whose prefix starts `id`. */
export function routeOf<T extends Pick<RouteDef, "providers" | "prefix">>(
  routes: readonly T[],
  provider: string,
  id: string,
): T | undefined {
  return routes.find((route) => route.providers.includes(provider) && id.startsWith(route.prefix));
}

/**
 * The route of a parent model: its id's route, else the provider's only route (an Anthropic or OpenAI
 * model outside the known id shapes keeps its provider's tiers). Google has three routes, so no fallback.
 */
export function parentRoute<T extends Pick<RouteDef, "providers" | "prefix">>(
  routes: readonly T[],
  provider: string,
  id: string,
): T | undefined {
  const exact = routeOf(routes, provider, id);
  if (exact) return exact;
  const own = routes.filter((route) => route.providers.includes(provider));
  return own.length === 1 ? own[0] : undefined;
}

const validTiers = (value: unknown): value is Tier[] =>
  Array.isArray(value) && value.every((tier) => TIERS.includes(tier as Tier));
const validFamily = (value: unknown): boolean => {
  const entry = value as Record<string, unknown> | null;
  return (
    !!entry &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    validTiers(entry.tiers) &&
    (entry.name === undefined || typeof entry.name === "string") &&
    (entry.before === undefined || typeof entry.before === "string")
  );
};
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

function validateFile(value: unknown): string | undefined {
  const file = value as Record<string, unknown> | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return "not a JSON object";
  if (file.version !== 1) return "version must be 1";
  if (file.routes !== undefined) {
    if (!file.routes || typeof file.routes !== "object" || Array.isArray(file.routes)) return "routes must be an object";
    for (const [route, entry] of Object.entries(file.routes as Record<string, Record<string, unknown>>)) {
      if (!entry || typeof entry !== "object") return `routes.${route} must be an object`;
      if (entry.add !== undefined && !(Array.isArray(entry.add) && entry.add.every(validFamily)))
        return `routes.${route}.add needs entries with an id and tiers from ${TIERS.join(", ")}`;
      if (entry.ignore !== undefined && !strings(entry.ignore)) return `routes.${route}.ignore must be a list of ids`;
      if (
        entry.pairs !== undefined &&
        !(
          Array.isArray(entry.pairs) &&
          entry.pairs.every(
            (pair) => typeof pair?.planner === "string" && typeof pair?.worker === "string",
          )
        )
      )
        return `routes.${route}.pairs needs planner and worker ids`;
    }
  }
  if (file.seen !== undefined) {
    if (!file.seen || typeof file.seen !== "object" || Array.isArray(file.seen)) return "seen must be an object";
    for (const [route, ids] of Object.entries(file.seen as Record<string, unknown>))
      if (!strings(ids)) return `seen.${route} must be a list of ids`;
  }
  return undefined;
}

let cached: { key: string; result: { file: FamiliesFile; error?: string } } | undefined;
/** The user file; absent is empty, and a broken file is reported while the built-in families stay in force. */
export function readFamiliesFile(): { file: FamiliesFile; error?: string } {
  const file = modelFamiliesPath();
  let key: string;
  try {
    const stat = statSync(file);
    key = `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return { file: { version: 1 } };
  }
  if (cached?.key === key) return cached.result;
  let result: { file: FamiliesFile; error?: string };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const problem = validateFile(parsed);
    result = problem ? { file: { version: 1 }, error: problem } : { file: parsed as FamiliesFile };
  } catch (error) {
    result = { file: { version: 1 }, error: error instanceof Error ? error.message : String(error) };
  }
  cached = { key, result };
  return result;
}

export function writeFamiliesFile(file: FamiliesFile): void {
  const target = modelFamiliesPath();
  const dir = path.dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temporary, target);
}

const priceOfInfo = (model: ModelInfo | undefined): number | undefined => {
  if (!model?.cost) return undefined;
  const price = (model.cost.input ?? 0) + (model.cost.output ?? 0);
  return price > 0 ? price : undefined;
};

/**
 * The built-in routes with the user file applied and, for the registry in `catalog`, the families it
 * contains that the table does not rank: placed provisionally by registry price, never in premium.
 */
export function familyTable(
  catalog: readonly ModelInfo[],
  file: FamiliesFile = { version: 1 },
  error?: string,
  routes: readonly RouteDef[] = BUILTIN_ROUTES,
): FamilyTable {
  const byKey = new Map(catalog.map((model) => [`${model.provider}/${model.id}`, model]));
  const resolved: TableRoute[] = routes.map((route) => {
    const user = file.routes?.[route.id];
    const families: ResolvedFamily[] = route.families.map((family) => ({
      id: family.id,
      name: family.name ?? familyName(family.id),
      tiers: [...family.tiers],
      source: "builtin",
    }));
    for (const add of user?.add ?? []) {
      if (families.some((family) => family.id === add.id)) continue;
      const entry: ResolvedFamily = {
        id: add.id,
        name: add.name ?? familyName(add.id),
        tiers: [...add.tiers],
        source: "user",
      };
      const index = add.before ? families.findIndex((family) => family.id === add.before) : -1;
      families.splice(index < 0 ? families.length : index, 0, entry);
    }
    return {
      ...route,
      families,
      ignore: [...new Set([...(route.ignore ?? []), ...(user?.ignore ?? [])])],
      pairs: user?.pairs ?? route.pairs,
    };
  });

  const discoveries: Discovery[] = [];
  for (const route of resolved) {
    const members = new Map<string, { id: string; model: ModelInfo; generation: number[] }[]>();
    for (const model of catalog) {
      if (routeOf(resolved, model.provider, model.id)?.id !== route.id) continue;
      const parsed = parseId(route, model.id);
      if (!parsed) continue;
      const list = members.get(parsed.family) ?? [];
      list.push({ id: model.id, model, generation: parsed.generation });
      members.set(parsed.family, list);
    }
    const newestOf = (family: string) =>
      [...(members.get(family) ?? [])].sort((a, b) => compareGeneration(b.generation, a.generation) || (a.id < b.id ? -1 : 1))[0];
    const priceOf = (family: string): number | undefined => {
      const newest = newestOf(family);
      if (!newest) return undefined;
      const own = priceOfInfo(newest.model);
      if (own !== undefined || !route.priceFrom) return own;
      const twin = resolved.find((candidate) => candidate.id === route.priceFrom);
      if (!twin) return undefined;
      const id = twin.format
        .replace("{family}", family)
        .replace("{gen}", newest.generation.join(twin.genSeparator));
      for (const provider of twin.providers) {
        const price = priceOfInfo(byKey.get(`${provider}/${id}`));
        if (price !== undefined) return price;
      }
      return undefined;
    };
    for (const family of route.families) family.price = priceOf(family.id);

    const ranked = new Set(route.families.map((family) => family.id));
    let frontier: number[] | undefined;
    for (const [family, list] of members)
      if (ranked.has(family))
        for (const entry of list) if (!frontier || compareGeneration(entry.generation, frontier) > 0) frontier = entry.generation;
    for (const [family] of members) {
      if (ranked.has(family) || route.ignore?.includes(family)) continue;
      const newest = newestOf(family)!;
      if (frontier && compareGeneration(newest.generation, frontier) < 0) continue;
      const price = priceOf(family);
      const name = familyName(family);
      let base: ResolvedFamily | undefined;
      if (price !== undefined)
        for (const candidate of route.families)
          if (
            candidate.source !== "provisional" &&
            candidate.price !== undefined &&
            candidate.price <= price &&
            (!base || candidate.price > base.price!)
          )
            base = candidate;
      const tiers = base
        ? [...new Set(base.tiers.map((tier): Tier => (tier === "premium" ? "strong" : tier)))]
        : [];
      const basis = base ? `priced like ${base.name}` : "no price";
      const entry: ResolvedFamily = { id: family, name, tiers, source: "provisional", ...(price !== undefined ? { price } : {}) };
      const index = base ? route.families.indexOf(base) : route.families.length;
      route.families.splice(index, 0, entry);
      discoveries.push({
        route: route.id,
        family,
        name,
        newest: newest.id,
        tiers,
        ...(price !== undefined ? { price } : {}),
        basis,
      });
    }
  }
  return { routes: resolved, discoveries, ...(error ? { error } : {}) };
}

export function loadFamilyTable(catalog: readonly ModelInfo[]): FamilyTable {
  const { file, error } = readFamiliesFile();
  return familyTable(catalog, file, error);
}

/** `provider/id` models offered for a tier on the parent's route, best first. */
export function tierModels(
  table: FamilyTable,
  parentModel: string,
  available: readonly { provider: string; id: string }[],
  tier: Tier,
): string[] {
  const slash = parentModel.indexOf("/");
  if (slash <= 0) return [];
  const provider = parentModel.slice(0, slash);
  const parentId = parentModel.slice(slash + 1);
  const route = parentRoute(table.routes, provider, parentId);
  if (!route) return [];
  const candidates: { id: string; rank: number; generation: number[] }[] = [];
  for (const model of available) {
    if (model.provider !== provider || routeOf(table.routes, provider, model.id)?.id !== route.id) continue;
    const parsed = parseId(route, model.id);
    const rank = parsed ? route.families.findIndex((family) => family.id === parsed.family && family.tiers.includes(tier)) : -1;
    if (parsed && rank >= 0) candidates.push({ id: model.id, rank, generation: parsed.generation });
  }
  candidates.sort(
    (a, b) => a.rank - b.rank || compareGeneration(b.generation, a.generation) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const parent = route.preferParentGeneration ? parseId(route, parentId) : undefined;
  const top = candidates[0];
  if (parent && top) {
    const sibling = candidates.find(
      (candidate) => candidate.rank === top.rank && compareGeneration(candidate.generation, parent.generation) === 0,
    );
    if (sibling && sibling !== top) {
      candidates.splice(candidates.indexOf(sibling), 1);
      candidates.unshift(sibling);
    }
  }
  return candidates.map((candidate) => `${provider}/${candidate.id}`);
}

export function familyOf(
  table: FamilyTable,
  provider: string,
  id: string,
): { route: TableRoute; family: ResolvedFamily; generation: number[] } | undefined {
  const route = routeOf(table.routes, provider, id);
  const parsed = route && parseId(route, id);
  const family = parsed && route.families.find((candidate) => candidate.id === parsed.family);
  return route && parsed && family ? { route, family, generation: parsed.generation } : undefined;
}

/** Plan model pairs for every route that derives them: the top premium and strong families, each over the next tier down. */
export function derivePairs(table: FamilyTable): PairSpec[] {
  const specs = new Map<string, PairSpec>();
  const next: Record<string, Tier> = { premium: "strong", strong: "balanced" };
  for (const route of table.routes) {
    if (!route.derivePairs) continue;
    const ranked = route.families.filter((family) => family.source !== "provisional");
    for (const provider of route.providers) {
      for (const planTier of ["premium", "strong"] as const) {
        const planner = ranked.find((family) => family.tiers.includes(planTier));
        if (!planner) continue;
        const override = route.pairs?.find((pair) => pair.planner === planner.id)?.worker;
        const worker = override
          ? ranked.find((family) => family.id === override)
          : ranked.find((family) => family.tiers.includes(next[planTier]!));
        if (!worker || worker.id === planner.id) continue;
        const key = `${provider}/${planner.id}plan`;
        const existing = specs.get(key);
        if (existing) {
          if (!existing.routes.includes(route.id)) existing.routes.push(route.id);
        } else {
          specs.set(key, {
            provider,
            id: `${planner.id}plan`,
            name: `${planner.name} plan, ${worker.name} build`,
            planner: planner.id,
            worker: worker.id,
            routes: [route.id],
          });
        }
      }
    }
  }
  return [...specs.values()];
}

export function confirmFamily(
  file: FamiliesFile,
  route: string,
  family: FamilyDef & { before?: string },
): FamiliesFile {
  const { ignore: previous, ...entry } = file.routes?.[route] ?? {};
  const add = [...(entry.add ?? []).filter((item) => item.id !== family.id), family];
  const ignore = (previous ?? []).filter((id) => id !== family.id);
  return { ...file, routes: { ...file.routes, [route]: { ...entry, add, ...(ignore.length ? { ignore } : {}) } } };
}

export function ignoreFamily(file: FamiliesFile, route: string, id: string): FamiliesFile {
  const entry = file.routes?.[route] ?? {};
  const add = (entry.add ?? []).filter((item) => item.id !== id);
  const ignore = [...new Set([...(entry.ignore ?? []), id])];
  const { add: _dropped, ...rest } = entry;
  return { ...file, routes: { ...file.routes, [route]: { ...rest, ...(add.length ? { add } : {}), ignore } } };
}

export function markSeen(file: FamiliesFile, discoveries: readonly Pick<Discovery, "route" | "family">[]): FamiliesFile {
  const seen: Record<string, string[]> = { ...file.seen };
  for (const { route, family } of discoveries) seen[route] = [...new Set([...(seen[route] ?? []), family])].sort();
  return { ...file, seen };
}

export function describeTable(table: FamilyTable): string {
  const lines: string[] = [];
  for (const route of table.routes) {
    lines.push(route.id);
    for (const family of route.families) {
      const basis = family.source === "provisional" ? ` (${table.discoveries.find((d) => d.route === route.id && d.family === family.id)?.basis ?? "no price"})` : "";
      lines.push(`  ${family.name}  ${family.tiers.join(", ") || "unrouted"}  ${family.source}${basis}`);
    }
    if (route.ignore?.length) lines.push(`  ignored: ${route.ignore.join(", ")}`);
  }
  if (table.error) lines.push(`model-families.json: ${table.error}; using built-in families.`);
  return lines.join("\n");
}
