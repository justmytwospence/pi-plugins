// Per-message model choice. Jev picks a tier (fast, balanced, strong) of the current provider's
// models by the same threshold rule as the effort level (policy.ts). The tiers come from
// `models.tiers`, else a built-in preset resolved from the models Pi has credentials for. A switch
// re-sends the conversation without a cached prefix, so a step down happens only while switching
// is cheap (first message, cold cache, small context); a step up is worth one cache rewrite and
// happens on any message. The model you pick by hand is remembered; with ceiling bounds no tier
// above it is picked.
import type { ClassifierChoiceQuestion } from "./jev.ts";
import { type Bounds, cumulative, pickIndex } from "./policy.ts";

export const TIERS = ["fast", "balanced", "strong"] as const;
export type ModelTier = (typeof TIERS)[number];

/** `off`: never. `auto`: switch. */
export type ModelsMode = "off" | "auto";

export interface ModelsConfig {
  mode: ModelsMode;
  /** A context below this many tokens is cheap to move to another model even with a warm cache. */
  maxSwitchTokens: number;
  /** Per provider: the `provider/id` of each tier's model. An entry replaces the provider's preset. */
  tiers: Record<string, Partial<Record<ModelTier, string>>>;
}

export const DEFAULT_MODELS: ModelsConfig = { mode: "auto", maxSwitchTokens: 30_000, tiers: {} };

export function isModelsMode(value: unknown): value is ModelsMode {
  return value === "off" || value === "auto";
}

/**
 * `raw` checked against the defaults; invalid values keep the default (an old `suggest` mode
 * included), invalid tier entries are dropped.
 */
export function modelsConfig(raw: unknown): ModelsConfig {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tiers: ModelsConfig["tiers"] = {};
  if (v.tiers && typeof v.tiers === "object" && !Array.isArray(v.tiers)) {
    for (const [provider, map] of Object.entries(v.tiers as Record<string, unknown>)) {
      if (!map || typeof map !== "object") continue;
      const out: Partial<Record<ModelTier, string>> = {};
      for (const tier of TIERS) {
        const spec = (map as Record<string, unknown>)[tier];
        if (typeof spec === "string" && spec.trim()) out[tier] = spec.trim();
      }
      tiers[provider] = out;
    }
  }
  return {
    mode: isModelsMode(v.mode) ? v.mode : DEFAULT_MODELS.mode,
    maxSwitchTokens:
      typeof v.maxSwitchTokens === "number" && Number.isFinite(v.maxSwitchTokens) && v.maxSwitchTokens >= 0 ? v.maxSwitchTokens : DEFAULT_MODELS.maxSwitchTokens,
    tiers,
  };
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface TierModel extends ModelRef {
  tier: ModelTier;
}

export const modelKey = (m: ModelRef) => `${m.provider}/${m.id}`;

/** `provider/id`, or a bare id on `provider`. */
export function parseModel(spec: string, provider: string): ModelRef {
  const slash = spec.indexOf("/");
  return slash > 0 ? { provider: spec.slice(0, slash), id: spec.slice(slash + 1) } : { provider, id: spec };
}

/** The configured tiers of `provider`, lowest first. Entries naming another provider are skipped: the provider is kept. */
export function providerTiers(config: ModelsConfig, provider: string): TierModel[] {
  const map = config.tiers[provider] ?? {};
  const out: TierModel[] = [];
  for (const tier of TIERS) {
    const spec = map[tier];
    if (!spec) continue;
    const ref = parseModel(spec, provider);
    if (ref.provider === provider && ref.id) out.push({ tier, ...ref });
  }
  return out;
}

/** Built-in tiers by model family, for providers without a `models.tiers` entry. No `fast` tier: it is too weak for the main session. */
export const PRESETS: Record<string, Partial<Record<ModelTier, RegExp>>> = {
  anthropic: { balanced: /^claude-sonnet-/u, strong: /^claude-opus-/u },
  "openai-codex": { balanced: /-terra$/u, strong: /-sol$/u },
};

const DATED = /^(.*)-\d{8}$/u;

/** Numeric-aware order of model ids: `claude-sonnet-5-5` after `claude-sonnet-5`, `gpt-6.1-sol` after `gpt-6-sol`. */
export function compareIds(a: string, b: string): number {
  const x = a.split(/(\d+)/u);
  const y = b.split(/(\d+)/u);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    // Odd chunks are digit runs.
    const d = i % 2 === 1 ? Number(x[i]) - Number(y[i]) : x[i]! < y[i]! ? -1 : x[i]! > y[i]! ? 1 : 0;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** The newest id: numeric-aware, descending, skipping an id with an 8-digit date suffix when its undated alias exists. */
export function newestId(ids: readonly string[]): string | undefined {
  const all = new Set(ids);
  const candidates = ids.filter((id) => {
    const alias = DATED.exec(id)?.[1];
    return !(alias && all.has(alias));
  });
  return candidates.sort((a, b) => compareIds(b, a))[0];
}

/** The preset's tier for a model id of `provider`, by family. */
export function presetTierOf(provider: string, id: string): ModelTier | undefined {
  const preset = PRESETS[provider];
  return preset ? TIERS.find((tier) => preset[tier]?.test(id)) : undefined;
}

/** The preset tiers of `provider`, lowest first: the newest available model of each tier's family. */
export function presetTiers(provider: string, available: readonly ModelRef[]): TierModel[] {
  const preset = PRESETS[provider];
  if (!preset) return [];
  const ids = available.filter((m) => m.provider === provider).map((m) => m.id);
  const out: TierModel[] = [];
  for (const tier of TIERS) {
    const family = preset[tier];
    const id = family ? newestId(ids.filter((i) => family.test(i))) : undefined;
    if (id) out.push({ tier, provider, id });
  }
  return out;
}

export interface ModelPlan {
  /** Candidate models, lowest tier first. */
  tiers: TierModel[];
  /** Your manual model's tier: by family with a preset; an unmapped manual model counts as strong. */
  manualTier: ModelTier;
  manual: ModelRef;
  /** The tiers come from a built-in preset, not `models.tiers`. */
  preset: boolean;
}

/**
 * The candidates for a message: the provider's configured tiers, else its preset from the
 * `available` models; your manual model stands in for `strong` when it is not mapped and no strong
 * model is there. Undefined when there is nothing to choose between.
 */
export function modelPlan(config: ModelsConfig, current: ModelRef, manual: ModelRef, available: readonly ModelRef[] = []): ModelPlan | undefined {
  const preset = config.tiers[current.provider] === undefined;
  const tiers = preset ? presetTiers(current.provider, available) : providerTiers(config, current.provider);
  if (!tiers.length) return undefined;
  const mapped = tiers.find((t) => modelKey(t) === modelKey(manual));
  const family = preset && manual.provider === current.provider ? presetTierOf(manual.provider, manual.id) : undefined;
  const manualTier: ModelTier = mapped?.tier ?? family ?? "strong";
  if (!mapped && manual.provider === current.provider && !tiers.some((t) => t.tier === manualTier)) {
    tiers.push({ tier: manualTier, ...manual });
    tiers.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  }
  if (tiers.length < 2) return undefined;
  return { tiers, manualTier, manual, preset };
}

/** The model a tier stands for: your own model for its tier (same provider), else the tier's model. */
export function tierTarget(plan: ModelPlan, tier: TierModel, provider: string): ModelRef {
  return tier.tier === plan.manualTier && plan.manual.provider === provider ? plan.manual : tier;
}

/** The tier of a model: mapped, your own, by preset family, else your model's tier. */
export function tierOf(plan: ModelPlan, ref: ModelRef): ModelTier {
  const key = modelKey(ref);
  const mapped = plan.tiers.find((t) => modelKey(t) === key);
  if (mapped) return mapped.tier;
  if (key === modelKey(plan.manual)) return plan.manualTier;
  return (plan.preset ? presetTierOf(ref.provider, ref.id) : undefined) ?? plan.manualTier;
}

export const tierRank = (tier: ModelTier) => TIERS.indexOf(tier);

/** The highest plan index the bounds allow: your model's tier with `ceiling`, any with `free`. */
export function upperIndex(plan: ModelPlan, bounds: Bounds): number {
  const manualAt = plan.tiers.findIndex((t) => t.tier === plan.manualTier);
  return bounds === "ceiling" && manualAt >= 0 ? manualAt : plan.tiers.length - 1;
}

export interface TierPick {
  tier: ModelTier;
  /** need per tier: the probability the work needs at least that tier. */
  need: Record<string, number>;
  target: ModelRef;
}

/** The highest tier within the bounds whose need clears theta, else the lowest, and the model it stands for. */
export function pickTier(plan: ModelPlan, probabilities: Record<string, number>, theta: number, bounds: Bounds, provider: string): TierPick {
  const order = plan.tiers.map((t) => t.tier);
  const need = cumulative(probabilities, order);
  const pick = plan.tiers[pickIndex(need, order, 0, upperIndex(plan, bounds), theta)]!;
  return { tier: pick.tier, need, target: tierTarget(plan, pick, provider) };
}

/** True when the bounds allow a tier above `current`'s, the only switch worth a cache rewrite. */
export function canStepUp(plan: ModelPlan, current: ModelRef, bounds: Bounds): boolean {
  const rank = tierRank(tierOf(plan, current));
  return plan.tiers.slice(0, upperIndex(plan, bounds) + 1).some((t) => tierRank(t.tier) > rank);
}

const TIER_CRITERIA: Record<ModelTier, string> = {
  fast: "Quick, simple work a small fast model does well: a lookup, a trivial answer, or a mechanical change",
  balanced: "Ordinary coding work: a routine change, a clear question, or debugging with clear symptoms",
  strong: "Hard work that needs the strongest model: subtle design, a cross-cutting refactor, hard debugging, or correctness-critical work",
};

/** A short reason for an offer, shown in pi-cache-guard's cold-cache dialog. */
export const TIER_NOTES: Record<ModelTier, string> = {
  fast: "Jev: simple work",
  balanced: "Jev: routine work",
  strong: "Jev: hard work",
};

/** The `tier` choice question over the plan's tiers. */
export function tierQuestion(tiers: readonly TierModel[]): ClassifierChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const t of tiers) criteria[t.tier] = TIER_CRITERIA[t.tier];
  return {
    type: "choice",
    instructions:
      "Which class of model should a coding agent use for the work asked for in `request`, given `previous_requests`, `last_outcome` and `signals`? Pick the cheapest class that will do it well.",
    criteria,
  };
}

/** Why switching now is cheap, or undefined when it is not. */
export function switchWindow(input: { first: boolean; cold: boolean; tokens?: number | null; maxSwitchTokens: number }): string | undefined {
  if (input.first) return "first message";
  if (input.cold) return "cache is cold";
  if (typeof input.tokens === "number" && input.tokens < input.maxSwitchTokens) return "small context";
  return undefined;
}

interface CacheModel {
  promptCache?: { short?: number; long?: number };
}

/**
 * How long the model's prompt cache lives, estimated: its `promptCache` metadata, else 5 minutes
 * (1 hour with PI_CACHE_RETENTION=long); 0 with PI_CACHE_RETENTION=none.
 */
export function cacheTtlMs(model: CacheModel | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (env.PI_CACHE_RETENTION === "none") return 0;
  const long = env.PI_CACHE_RETENTION === "long";
  const seconds = model?.promptCache?.[long ? "long" : "short"];
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return long ? 3_600_000 : 300_000;
}

interface ActivityEntry {
  type?: string;
  kind?: string;
  timestamp?: unknown;
  message?: { role?: string; timestamp?: unknown };
}

/**
 * The time of the last cache activity on the branch: the last assistant message, or a later Pi
 * cache-warming refresh (`usage` entries of kind `cache_warm`), whichever is latest.
 */
export function lastCacheActivity(entries: readonly unknown[]): number | undefined {
  let latest: number | undefined;
  const seen = (t: unknown) => {
    const at = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : Number.NaN;
    if (Number.isFinite(at)) latest = Math.max(latest ?? at, at);
  };
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as ActivityEntry | undefined;
    if (entry?.type === "usage" && entry.kind === "cache_warm") seen(entry.timestamp);
    else if (entry?.type === "message" && entry.message?.role === "assistant") {
      seen(entry.message.timestamp ?? entry.timestamp);
      break;
    }
  }
  return latest;
}

/** `claude-sonnet-4-5-20250929` -> `sonnet-4-5`: short enough for the footer, with no parentheses. */
export function shortModelId(id: string): string {
  return id
    .replace(/^.*\//u, "")
    .replace(/^claude-/u, "")
    .replace(/-\d{8}$/u, "")
    .replace(/[()]/gu, "");
}
