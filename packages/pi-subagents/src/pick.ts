import { type AgentDef, type ProfileModel, THINKING_LEVELS } from "./agents.ts";
import { type ClassifierAnswer, type ClassifierQuestion, choice } from "./jev.ts";

export type Tier = "fast" | "balanced" | "strong";
/** Tiers and efforts, weakest first: the order the threshold rule climbs. */
export const TIERS = ["fast", "balanced", "strong"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** The effort question's options, one description each. */
export const EFFORT_DESCRIPTIONS: Record<(typeof EFFORTS)[number], string> = {
  low: "A lookup, a search, or a mechanical change",
  medium: "A routine change or a clear question",
  high: "A multi-step change, debugging with clear symptoms, or design in a known pattern",
  xhigh: "Subtle design, a cross-cutting change, hard debugging, or correctness-critical work",
};

/**
 * How sure Jev must be before a pick climbs to a stronger tier or effort: `relaxed` with no quota
 * pressure, `tight` at full pressure, linear in between.
 */
export interface Threshold {
  relaxed: number;
  tight: number;
}
/** 0.5 is the median of Jev's answers: a stronger option is taken once it is at least as likely as not. */
export const DEFAULT_THRESHOLD: Threshold = { relaxed: 0.5, tight: 0.85 };

/** theta(p) = relaxed + (tight - relaxed) * p, with p (quota pressure) clamped to 0..1. */
export function theta(pressure: number, threshold: Threshold = DEFAULT_THRESHOLD): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0;
  const relaxed = finite01(threshold.relaxed, DEFAULT_THRESHOLD.relaxed);
  const tight = finite01(threshold.tight, DEFAULT_THRESHOLD.tight);
  return relaxed + (tight - relaxed) * p;
}

function finite01(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/**
 * The highest of `options` (weakest first) whose P(this option or stronger) reaches `bar`; else the
 * lowest. An answer without probabilities counts its choice at its confidence.
 */
export function climb<T extends string>(options: readonly T[], answer: { choice: string; probabilities: Record<string, number>; confidence: number }, bar: number): T {
  const probabilities = options.some((o) => Number.isFinite(answer.probabilities?.[o]))
    ? answer.probabilities
    : { [answer.choice]: answer.confidence };
  let atLeast = 0;
  for (let i = options.length - 1; i > 0; i--) {
    const p = probabilities[options[i]!];
    atLeast += Number.isFinite(p) ? p! : 0;
    // A hair of slack, so 0.35 + 0.5 summed in floating point still meets 0.85.
    if (atLeast >= bar - 1e-9) return options[i]!;
  }
  return options[0]!;
}

export interface TierConfig {
  /** `provider/model` per tier; a missing tier uses the parent's model. */
  models: Partial<Record<Tier, string>>;
  descriptions: Record<Tier, string>;
}

/**
 * Built-in tier models per provider, as id patterns over Pi's registry: the newest registered match
 * fills a tier nothing is configured for. A provider without presets uses the parent's model.
 */
export const TIER_PRESETS: Record<string, Record<Tier, RegExp>> = {
  anthropic: { fast: /^claude-haiku-/u, balanced: /^claude-sonnet-/u, strong: /^claude-opus-/u },
  "openai-codex": { fast: /-luna$/u, balanced: /-terra$/u, strong: /-sol$/u },
};
/** Each tier's id suffix, where a preset prefers the parent's own generation (`gpt-6.1-sol` -> `gpt-6.1-luna`). */
const GENERATIONS: Record<string, Record<Tier, string>> = { "openai-codex": { fast: "luna", balanced: "terra", strong: "sol" } };
const DATED = /-(\d{8})$/u;

/**
 * Newest first: ids compared numerically with any 8-digit date suffix set aside, then an undated
 * alias before its dated snapshots, then the later date.
 */
export function newestFirst(a: string, b: string): number {
  const base = (id: string) => id.replace(DATED, "");
  const byBase = base(b).localeCompare(base(a), "en", { numeric: true });
  if (byBase) return byBase;
  const dateA = a.match(DATED)?.[1];
  const dateB = b.match(DATED)?.[1];
  if (!dateA !== !dateB) return dateA ? 1 : -1;
  return (dateB ?? "").localeCompare(dateA ?? "");
}

/**
 * Tier models for the parent's provider: its `providerTiers` entry, then a matching legacy `tiers`
 * entry, then the provider's preset over the registry (`available`), per tier. Only models on the
 * parent's provider; presets only name registered models. Explicit call models bypass this.
 */
export function providerTiers(
  parentModel: string,
  configured: Partial<Record<Tier, string>>,
  byProvider: Record<string, Partial<Record<Tier, string>>> = {},
  available: readonly { provider: string; id: string }[] = [],
): Partial<Record<Tier, string>> {
  const provider = parentModel.split("/")[0]!;
  const sameProvider = (model: string | undefined) => model?.startsWith(`${provider}/`) ? model : undefined;
  const parentId = parentModel.slice(provider.length + 1);
  const presets = Object.hasOwn(TIER_PRESETS, provider) ? TIER_PRESETS[provider] : undefined;
  const suffixes = Object.hasOwn(GENERATIONS, provider) ? GENERATIONS[provider] : undefined;
  const generation = suffixes ? new RegExp(`-(${Object.values(suffixes).join("|")})$`, "u") : undefined;
  const preset = (tier: Tier) => {
    const pattern = presets?.[tier];
    if (!pattern) return undefined;
    const ids = available.filter((m) => m.provider === provider && pattern.test(m.id)).map((m) => m.id).sort(newestFirst);
    const sibling = suffixes && generation?.test(parentId) ? parentId.replace(generation, `-${suffixes[tier]}`) : undefined;
    const id = (sibling && ids.includes(sibling) ? sibling : undefined) ?? ids[0];
    return id ? `${provider}/${id}` : undefined;
  };
  const models: Partial<Record<Tier, string>> = {};
  for (const tier of ["fast", "balanced", "strong"] as const) {
    const model = sameProvider(byProvider[provider]?.[tier]) ?? sameProvider(configured[tier]) ?? preset(tier);
    if (model) models[tier] = model;
  }
  return models;
}

/** A registered model as far as this package reads it (Pi's `Model`, structurally). */
export interface AvailableModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

/** The thinking levels a registered model supports, as Pi computes them (`getSupportedThinkingLevels`). */
export function supportedThinking(model: AvailableModel): string[] {
  if (model.reasoning === false) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** `level`, or the nearest level the model supports (up first, then down), as Pi clamps it. Unknown models pass through. */
export function clampThinking(level: string, model: AvailableModel | undefined): string {
  if (!model || model.reasoning === undefined) return level;
  const supported = supportedThinking(model);
  if (supported.includes(level)) return level;
  const index = THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]);
  if (index < 0) return level;
  for (let i = index; i < THINKING_LEVELS.length; i++) if (supported.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  for (let i = index - 1; i >= 0; i--) if (supported.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  return level;
}

/**
 * A role's profile model on `provider`, checked against the registry: used as is when registered or
 * when the registry lists nothing for the provider; else the newest registered model of the same
 * preset family (a stale Sonnet id becomes the newest Sonnet); else none (the tier rules apply).
 */
export function profileModel(entry: ProfileModel | undefined, provider: string, available: readonly AvailableModel[] = []): ProfileModel | undefined {
  if (!entry || !entry.model.startsWith(`${provider}/`)) return undefined;
  const id = entry.model.slice(provider.length + 1);
  const registered = available.filter((m) => m.provider === provider);
  if (!registered.length || registered.some((m) => m.id === id)) return entry;
  const presets = Object.hasOwn(TIER_PRESETS, provider) ? TIER_PRESETS[provider] : undefined;
  const family = presets ? Object.values(presets).find((pattern) => pattern.test(id)) : undefined;
  const newest = family ? registered.map((m) => m.id).filter((m) => family.test(m)).sort(newestFirst)[0] : undefined;
  return newest ? { ...entry, model: `${provider}/${newest}` } : undefined;
}

/**
 * What an agent fixes for a parent on `parentModel`'s provider: its profile model there, else its
 * `model` when on that provider (an implicit model never leaves the parent's provider), and the
 * profile's thinking, else the agent's, clamped to what the model supports when it is registered.
 */
export function agentDefaults(agent: AgentDef, parentModel: string, available: readonly AvailableModel[] = []): { model?: string; thinking?: string } {
  const provider = parentModel.split("/")[0]!;
  const entry = agent.models && Object.hasOwn(agent.models, provider) ? agent.models[provider] : undefined;
  const fromProfile = profileModel(entry, provider, available);
  const model = fromProfile?.model ?? (agent.model?.startsWith(`${provider}/`) ? agent.model : undefined);
  let thinking = fromProfile?.thinking ?? agent.thinking;
  if (thinking && model) thinking = clampThinking(thinking, available.find((m) => `${m.provider}/${m.id}` === model));
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/** Haiku's price multiplies past this many prompt tokens. */
export const HAIKU_CONTEXT_LIMIT = 100_000;

/** What the run brings to its child's context, for the Haiku guard. */
export interface RunContextInfo {
  /** The run forks the parent's conversation. */
  fork?: boolean;
  /** The parent's context now, in tokens. */
  parentTokens?: number;
}

/**
 * Why the fast tier must not be Haiku for this run (it forks the parent's context, or the parent's
 * context is past Haiku's long-context price step), or undefined when Haiku is fine.
 */
export function haikuGuard(fastModel: string | undefined, info: RunContextInfo = {}): string | undefined {
  if (!fastModel?.startsWith("anthropic/") || !/claude-haiku-/u.test(fastModel)) return undefined;
  if (info.fork) return "not Haiku: forked context";
  if ((info.parentTokens ?? 0) > HAIKU_CONTEXT_LIMIT) return `not Haiku: parent context ${Math.round(info.parentTokens! / 1000)}k`;
  return undefined;
}

export const DEFAULT_TIER_DESCRIPTIONS: Record<Tier, string> = {
  fast: "Lookups, searches, reading and summarizing code or docs, scripted or mechanical edits, running checks and reporting results",
  balanced: "Implementing a precisely specified change, ordinary implementation, debugging with clear symptoms, code reviews, multi-source research",
  strong: "Only when a mistake is costly and the task is genuinely hard: subtle design, hard debugging without clear symptoms, cross-cutting correctness-critical changes",
};

/** What the caller or the agent file already decided; Jev fills only the gaps. */
export interface Given {
  agent?: string;
  model?: string;
  thinking?: string;
}

/**
 * The Jev questions for the gaps in `given`, or {} when nothing is left to decide. Fill `given` with
 * what a named agent fixes (`agentDefaults`), so a profiled role is not asked for a tier or effort.
 */
export function pickQuestions(given: Given, agents: readonly AgentDef[], tiers: TierConfig, askTier: boolean): Record<string, ClassifierQuestion> {
  const questions: Record<string, ClassifierQuestion> = {};
  if (!given.agent && agents.length > 1) {
    questions.role = {
      type: "choice",
      instructions: "Which agent is best suited to carry out `task`? Choose general only when no other agent's description fits.",
      criteria: Object.fromEntries(agents.map((a) => [a.name, a.description])),
    };
  }
  if (!given.model && askTier) {
    questions.tier = {
      type: "choice",
      instructions: "How capable a model does `task` need?",
      criteria: tiers.descriptions,
    };
  }
  if (!given.thinking) {
    questions.effort = {
      type: "choice",
      instructions: "How much careful reasoning does `task` need from the agent doing it?",
      criteria: { ...EFFORT_DESCRIPTIONS },
    };
  }
  return questions;
}

export interface Picks {
  agent?: string;
  tier?: Tier;
  thinking?: string;
  /** The quota pressure the tier and effort were picked under, when above 0. */
  pressure?: number;
}

/**
 * Read Jev's answers: a role at confidence >= 0.5; a tier and an effort by one rule, the highest
 * option whose P(it or stronger) reaches theta(pressure), else the lowest. Quota pressure on the
 * parent's provider (0..1) raises the bar, so picks move toward cheaper tiers and lower efforts.
 */
export function readPicks(answers: Record<string, ClassifierAnswer>, options: { pressure?: number; threshold?: Threshold } = {}): Picks {
  const picks: Picks = {};
  const pressure = Number.isFinite(options.pressure) ? Math.min(1, Math.max(0, options.pressure!)) : 0;
  const bar = theta(pressure, options.threshold);
  const role = choice(answers, "role");
  if (role && role.confidence >= 0.5) picks.agent = role.choice;
  const tier = choice(answers, "tier");
  if (tier) picks.tier = climb(TIERS, tier, bar);
  const effort = choice(answers, "effort");
  if (effort) picks.thinking = climb(EFFORTS, effort, bar);
  if (pressure > 0 && (picks.tier || picks.thinking)) picks.pressure = pressure;
  return picks;
}

/** Where the model and thinking level of a run came from. */
export interface ChoiceSource {
  /** explicit: the call's argument; profile: the agent's profile or file; tier: the automatic tier pick; default: the parent's. */
  model: "explicit" | "profile" | "tier" | "default";
  /** explicit: the call's argument; profile: the agent's profile or file; jev: Jev's effort pick; default: the parent's. */
  thinking: "explicit" | "profile" | "jev" | "default";
}

export interface Resolved {
  agent: AgentDef;
  model: string;
  thinking: string;
  /** Which choices Jev made, for display. */
  byJev: { agent: boolean; model: boolean; thinking: boolean };
  tier?: Tier;
  /** Where each choice came from. */
  source: ChoiceSource;
  /** The quota pressure Jev's model or effort pick was made under, when above 0. */
  pressure?: number;
  /** Why the pick differs from Jev's answer (the Haiku guard), for display. */
  note?: string;
}

export interface ResolveOptions {
  /** Pi's registered models, to check profile models and clamp their thinking. */
  available?: readonly AvailableModel[];
  /** The run's context, for the Haiku guard. */
  context?: RunContextInfo;
}

/**
 * Precedence for each choice: explicit arguments, then the agent (its profile for the parent's
 * provider, else its own `model` and `thinking`), then Jev, then defaults (`general`, the balanced
 * tier, the parent's model and thinking level). A role whose profile fixes the model and thinking
 * ignores Jev's tier and effort answers.
 */
export function resolve(
  given: Given,
  agents: readonly AgentDef[],
  picks: Picks | undefined,
  tiers: TierConfig,
  parent: { model: string; thinking: string },
  options: ResolveOptions = {},
): Resolved | { error: string } {
  const byJev = { agent: false, model: false, thinking: false };
  let agentName = given.agent;
  if (!agentName && picks?.agent && agents.some((a) => a.name === picks.agent)) {
    agentName = picks.agent;
    byJev.agent = true;
  }
  agentName ??= "general";
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) return { error: `Unknown agent "${agentName}". Available: ${agents.map((a) => a.name).join(", ")}.` };

  // Agent files are defaults too: switching the main session's provider must not silently
  // launch children against a different subscription. Only an explicit call model may do that.
  const defaults = agentDefaults(agent, parent.model, options.available);
  const provider = parent.model.split("/")[0];
  let model = given.model ?? defaults.model;
  let tier: Tier | undefined;
  const source: ChoiceSource = { model: given.model ? "explicit" : defaults.model ? "profile" : "default", thinking: given.thinking ? "explicit" : defaults.thinking ? "profile" : "default" };
  let note: string | undefined;
  if (!model) {
    tier = picks?.tier ?? "balanced";
    if (tier === "fast") {
      note = haikuGuard(tiers.models.fast, options.context);
      if (note) tier = "balanced";
    }
    const tierModel = tiers.models[tier]?.startsWith(`${provider}/`) ? tiers.models[tier] : undefined;
    model = tierModel ?? parent.model;
    byJev.model = picks?.tier !== undefined && tierModel !== undefined;
    if (tierModel) source.model = "tier";
  }
  let thinking = given.thinking ?? defaults.thinking;
  if (!thinking && picks?.thinking) {
    thinking = picks.thinking;
    byJev.thinking = true;
    source.thinking = "jev";
  }
  thinking ??= parent.thinking;
  const pressure = picks?.pressure && (byJev.model || byJev.thinking) ? picks.pressure : undefined;
  return { agent, model, thinking, byJev, source, ...(tier ? { tier } : {}), ...(pressure ? { pressure } : {}), ...(note ? { note } : {}) };
}
