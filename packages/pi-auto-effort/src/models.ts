// Per-message model choice, opt-in, and only when switching is cheap: the session's first message,
// a cold prompt cache, or a small context. Jev picks a tier (fast, balanced, strong) of the current
// provider's configured models by the same threshold rule as the effort level (policy.ts). The
// model you pick by hand is remembered; with ceiling bounds no tier above it is picked.
import type { ClassifierChoiceQuestion } from "./jev.ts";

export const TIERS = ["fast", "balanced", "strong"] as const;
export type ModelTier = (typeof TIERS)[number];

/** `off`: never. `suggest`: a notice with the `/model` command. `auto`: switch. */
export type ModelsMode = "off" | "suggest" | "auto";

export interface ModelsConfig {
  mode: ModelsMode;
  /** A context below this many tokens is cheap to move to another model even with a warm cache. */
  maxSwitchTokens: number;
  /** Per provider: the `provider/id` of each tier's model. */
  tiers: Record<string, Partial<Record<ModelTier, string>>>;
}

export const DEFAULT_MODELS: ModelsConfig = { mode: "off", maxSwitchTokens: 30_000, tiers: {} };

export function isModelsMode(value: unknown): value is ModelsMode {
  return value === "off" || value === "suggest" || value === "auto";
}

/** `raw` checked against the defaults; invalid values keep the default, invalid tier entries are dropped. */
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

export interface ModelPlan {
  /** Candidate models, lowest tier first. */
  tiers: TierModel[];
  /** Your manual model's tier: an unmapped manual model counts as strong. */
  manualTier: ModelTier;
  manual: ModelRef;
}

/**
 * The candidates for a message: the provider's configured tiers, with your manual model standing in
 * for `strong` when it is not mapped and no strong model is configured. Undefined when there is
 * nothing to choose between.
 */
export function modelPlan(config: ModelsConfig, current: ModelRef, manual: ModelRef): ModelPlan | undefined {
  const tiers = providerTiers(config, current.provider);
  if (!tiers.length) return undefined;
  const mapped = tiers.find((t) => modelKey(t) === modelKey(manual));
  const manualTier: ModelTier = mapped?.tier ?? "strong";
  if (!mapped && manual.provider === current.provider && !tiers.some((t) => t.tier === "strong")) tiers.push({ tier: "strong", ...manual });
  if (tiers.length < 2) return undefined;
  return { tiers, manualTier, manual };
}

const TIER_CRITERIA: Record<ModelTier, string> = {
  fast: "Quick, simple work a small fast model does well: a lookup, a trivial answer, or a mechanical change",
  balanced: "Ordinary coding work: a routine change, a clear question, or debugging with clear symptoms",
  strong: "Hard work that needs the strongest model: subtle design, a cross-cutting refactor, hard debugging, or correctness-critical work",
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

/** `claude-sonnet-4-5-20250929` -> `sonnet-4-5`: short enough for the footer, with no parentheses. */
export function shortModelId(id: string): string {
  return id
    .replace(/^.*\//u, "")
    .replace(/^claude-/u, "")
    .replace(/-\d{8}$/u, "")
    .replace(/[()]/gu, "");
}
