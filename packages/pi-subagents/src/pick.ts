import type { AgentDef } from "./agents.ts";
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
export const DEFAULT_THRESHOLD: Threshold = { relaxed: 0.35, tight: 0.85 };

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

/** Resolve defaults only within the parent's provider. Explicit call models bypass this policy. */
export function providerTiers(
  parentModel: string,
  configured: Partial<Record<Tier, string>>,
  byProvider: Record<string, Partial<Record<Tier, string>>> = {},
  available: readonly { provider: string; id: string }[] = [],
): Partial<Record<Tier, string>> {
  const provider = parentModel.split("/")[0];
  const sameProvider = (model: string | undefined) => model?.startsWith(`${provider}/`) ? model : undefined;
  const models: Partial<Record<Tier, string>> = {};
  // Prefer the matching Sol/Luna generation, and never invent a model absent from the registry.
  const parentId = parentModel.slice(provider.length + 1);
  const sibling = (name: string) => {
    const candidates = available.filter((m) => m.provider === provider && m.id.endsWith(`-${name}`))
      .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
    return candidates.find((m) => m.id === parentId.replace(/-(sol|luna)$/u, `-${name}`)) ?? candidates[0];
  };
  const sol = provider === "openai-codex" ? sibling("sol") : undefined;
  const luna = provider === "openai-codex" ? sibling("luna") : undefined;
  for (const tier of ["fast", "balanced", "strong"] as const) {
    const preset = tier === "fast" ? luna : sol;
    const model = sameProvider(byProvider[provider]?.[tier]) ?? sameProvider(configured[tier]) ??
      (preset ? `${provider}/${preset.id}` : undefined);
    if (model) models[tier] = model;
  }
  return models;
}

export const DEFAULT_TIER_DESCRIPTIONS: Record<Tier, string> = {
  fast: "Lookups, searches, reading and summarizing, scripted or mechanical edits",
  balanced: "Implementing a precisely specified change, ordinary implementation, debugging with clear symptoms, reviews, research",
  strong: "Subtle design, hard debugging, cross-cutting changes, correctness-critical work",
};

/** What the caller or the agent file already decided; Jev fills only the gaps. */
export interface Given {
  agent?: string;
  model?: string;
  thinking?: string;
}

/** The Jev questions for the gaps in `given`, or {} when nothing is left to decide. */
export function pickQuestions(given: Given, agents: readonly AgentDef[], tiers: TierConfig, askTier: boolean): Record<string, ClassifierQuestion> {
  const questions: Record<string, ClassifierQuestion> = {};
  if (!given.agent && agents.length > 1) {
    questions.role = {
      type: "choice",
      instructions: "Which agent is best suited to carry out `task`?",
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

export interface Resolved {
  agent: AgentDef;
  model: string;
  thinking: string;
  /** Which choices Jev made, for display. */
  byJev: { agent: boolean; model: boolean; thinking: boolean };
  tier?: Tier;
  /** The quota pressure Jev's model or effort pick was made under, when above 0. */
  pressure?: number;
}

/**
 * Precedence for each choice: explicit arguments, then the agent file, then Jev, then defaults
 * (`general`, the balanced tier, the parent's model and thinking level).
 */
export function resolve(
  given: Given,
  agents: readonly AgentDef[],
  picks: Picks | undefined,
  tiers: TierConfig,
  parent: { model: string; thinking: string },
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
  const agentModel = agent.model?.startsWith(`${parent.model.split("/")[0]}/`) ? agent.model : undefined;
  let model = given.model ?? agentModel;
  let tier: Tier | undefined;
  if (!model) {
    tier = picks?.tier ?? "balanced";
    const tierModel = tiers.models[tier]?.startsWith(`${parent.model.split("/")[0]}/`) ? tiers.models[tier] : undefined;
    model = tierModel ?? parent.model;
    byJev.model = picks?.tier !== undefined && tierModel !== undefined;
  }
  let thinking = given.thinking ?? agent.thinking;
  if (!thinking && picks?.thinking) {
    thinking = picks.thinking;
    byJev.thinking = true;
  }
  thinking ??= parent.thinking;
  const pressure = picks?.pressure && (byJev.model || byJev.thinking) ? picks.pressure : undefined;
  return { agent, model, thinking, byJev, ...(tier ? { tier } : {}), ...(pressure ? { pressure } : {}) };
}
