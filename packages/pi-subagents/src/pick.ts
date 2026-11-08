import { type AgentDef, type ProfileModel, THINKING_LEVELS } from "./agents.ts";
import { type ClassifierAnswer, type ClassifierQuestion, choice } from "./jev.ts";
import { type Tier, providerPolicy, routeBuiltinProfile } from "./provider-policy.ts";
import type { System1ProvenanceRecord } from "./system1.ts";
export type { Tier } from "./provider-policy.ts";

/** Tiers and efforts, weakest first: the order the threshold rule climbs. */
export const TIERS = ["fast", "balanced", "strong", "premium"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** The effort question's options, one description each. */
export const EFFORT_DESCRIPTIONS: Record<(typeof EFFORTS)[number], string> = {
  low: "Lookup, search, summarization, or mechanical work with settled steps.",
  medium: "Specified implementation, tests, documentation, or ordinary debugging with clear symptoms.",
  high: "Substantial reasoning within the delegated task, including interacting changes, nontrivial review, or design in known patterns.",
  xhigh: "Genuinely difficult unresolved reasoning requiring sustained analysis within this task; not just many files, a long specification, or an important surrounding project.",
};

import { climb, theta, type Threshold } from "@justmytwospence/pi-subscription-usage";
export { climb, theta, DEFAULT_THRESHOLD, type Threshold } from "@justmytwospence/pi-subscription-usage";

export interface TierConfig {
  /** `provider/model` per tier; a missing tier uses the parent's model. */
  models: Partial<Record<Tier, string>>;
  descriptions: Record<Tier, string>;
}

/** Numeric-aware model ordering ignores a dated suffix when comparing families. */
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
  available: readonly AvailableModel[] = [],
): Partial<Record<Tier, string>> {
  const provider = parentModel.split("/")[0]!;
  const sameProvider = (model: string | undefined) => model?.startsWith(`${provider}/`) ? model : undefined;
  const parentId = parentModel.slice(provider.length + 1);
  const policy = providerPolicy(parentModel);
  const physical = physicalChatModels(available);
  const configuredModel = (model: string | undefined) => {
    const same = sameProvider(model);
    return same && (!available.length || physical.some((item) => `${item.provider}/${item.id}` === same)) ? same : undefined;
  };
  const suffixes = policy?.generationSuffixes;
  const generation = suffixes ? new RegExp(`-(${Object.values(suffixes).join("|")})$`, "u") : undefined;
  const preset = (tier: Tier) => {
    const pattern = policy?.tiers[tier];
    if (!pattern) return undefined;
    const ids = physical.filter((m) => m.provider === provider && pattern.test(m.id)).map((m) => m.id).sort(newestFirst);
    const suffix = suffixes?.[tier];
    const sibling = suffix && generation?.test(parentId) ? parentId.replace(generation, `-${suffix}`) : undefined;
    const id = (sibling && ids.includes(sibling) ? sibling : undefined) ?? ids[0];
    return id ? `${provider}/${id}` : undefined;
  };
  const models: Partial<Record<Tier, string>> = {};
  for (const tier of TIERS) {
    const model = configuredModel(byProvider[provider]?.[tier]) ?? configuredModel(configured[tier]) ?? preset(tier);
    if (model) models[tier] = model;
  }
  return models;
}

/** A registered model as far as this package reads it (Pi's `Model`, structurally). */
export interface AvailableModel {
  provider: string;
  id: string;
  api?: string;
  type?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

/** Only physical chat models may be selected automatically; accept older registries without type/API. */
export function physicalChatModels(models: readonly AvailableModel[]): AvailableModel[] {
  return models.filter((model) => (model.type === undefined || model.type === "chat") && model.api !== "pi-virtual");
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
 * A profile model must be a registered physical chat model when the registry has entries. With
 * an entirely unknown legacy registry it is used as written; otherwise a stale family profile
 * resolves to its newest registered peer, or yields no model.
 */
export function profileModel(entry: ProfileModel | undefined, provider: string, available: readonly AvailableModel[] = []): ProfileModel | undefined {
  if (!entry || !entry.model.startsWith(`${provider}/`)) return undefined;
  const id = entry.model.slice(provider.length + 1);
  const registered = physicalChatModels(available).filter((m) => m.provider === provider);
  if (!available.length || registered.some((m) => m.id === id)) return entry;
  const family = Object.values(providerPolicy(entry.model)?.tiers ?? {}).find((pattern) => pattern.test(id));
  const newest = family ? registered.map((m) => m.id).filter((m) => family.test(m)).sort(newestFirst)[0] : undefined;
  return newest ? { ...entry, model: `${provider}/${newest}` } : undefined;
}

/**
 * Baselines for a role on the parent's provider: a registered routed profile or explicit agent-file
 * model, plus its role effort. Built-in profiles may follow known provider aliases; user files do not.
 */
export function agentDefaults(agent: AgentDef, parentModel: string, available: readonly AvailableModel[] = []): { model?: string; thinking?: string } {
  const provider = parentModel.split("/")[0]!;
  const policy = agent.source === "builtin" ? providerPolicy(parentModel) : undefined;
  const key = policy?.profileProvider ?? provider;
  const entry = agent.models && Object.hasOwn(agent.models, key) ? agent.models[key] : undefined;
  const fromProfile = profileModel(entry && policy ? routeBuiltinProfile(entry, parentModel, policy) : entry, provider, available);
  const model = fromProfile?.model ?? (agent.model?.startsWith(`${provider}/`) ? agent.model : undefined);
  // A custom profile's authored effort remains fixed even if its model is unavailable; a
  // malformed cross-provider profile cannot pin effort on this provider.
  const authored = agent.source !== "builtin" && entry?.model.startsWith(`${provider}/`) ? entry.thinking : undefined;
  const thinking = fromProfile?.thinking ?? authored ?? agent.thinking;
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
  fast: "Lookups, extraction, concise summaries, scripted or mechanical changes, and running prescribed checks; little unresolved judgment.",
  balanced: "Specified implementation, ordinary debugging with clear symptoms, documentation, focused review, and multi-source research with a clear question.",
  strong: "Substantial unresolved reasoning within this task: interacting changes, difficult review, nontrivial design, or debugging whose cause is not yet known.",
  premium: "Exceptional unresolved difficulty where the flagship model's extra capability is justified: subtle cross-system correctness, unusually hard debugging, or consequential architecture with unresolved trade-offs. Not merely a lengthy specification or routine implementation in a critical project.",
};

/** User/project pins suppress classification; built-in role models and efforts are only baselines. */
export function fixedAgentDefaults(agent: AgentDef | undefined, parentModel: string, available: readonly AvailableModel[]): { model?: string; thinking?: string } {
  return agent && agent.source !== "builtin" ? agentDefaults(agent, parentModel, available) : {};
}

/** What the caller or the agent file already decided; Jev fills only the gaps. */
export interface Given {
  agent?: string;
  model?: string;
  thinking?: string;
}

/**
 * The Jev questions for the gaps in `given`. Include only user/project fixed defaults in `given`;
 * built-in profiles are fallback baselines and must not suppress task-specific classification.
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
  const guidance = "Judge only the delegated task in task. parent_request is context for interpreting it, not additional work this agent owns. Choose the least costly capability and effort sufficient to complete the task reliably. A role name, long specification, many files, mandatory tests, or an important parent project does not by itself justify escalation. Do not trade away necessary capability merely to save cost. Model capability and reasoning effort are independent decisions.";
  const offered = TIERS.filter((tier) => Boolean(tiers.models[tier]));
  if (!given.model && askTier && offered.length > 1) {
    questions.tier = {
      type: "choice",
      instructions: `${guidance} How capable a model does task need?`,
      criteria: Object.fromEntries(offered.map((tier) => [tier, `${tiers.descriptions[tier]} Candidate: ${tiers.models[tier]}.`])),
    };
  }
  if (!given.thinking) {
    questions.effort = {
      type: "choice",
      instructions: `${guidance} How much careful reasoning does task need from the agent doing it?`,
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
export function readPicks(answers: Record<string, ClassifierAnswer>, options: { pressure?: number; threshold?: Threshold; tiers?: readonly Tier[] } = {}): Picks {
  const picks: Picks = {};
  const pressure = Number.isFinite(options.pressure) ? Math.min(1, Math.max(0, options.pressure!)) : 0;
  const bar = theta(pressure, options.threshold);
  const role = choice(answers, "role");
  if (role && role.confidence >= 0.5) picks.agent = role.choice;
  const tiers = options.tiers ?? TIERS;
  const valid = (offered: readonly string[], answer: ReturnType<typeof choice>) =>
    answer && (offered.includes(answer.choice) || offered.some((name) => Number.isFinite(answer.probabilities?.[name]) && answer.probabilities[name]! > 0));
  const tier = choice(answers, "tier");
  if (tiers.length && valid(tiers, tier)) picks.tier = climb(tiers, tier!, bar);
  const effort = choice(answers, "effort");
  if (valid(EFFORTS, effort)) picks.thinking = climb(EFFORTS, effort!, bar);
  if (pressure > 0 && (picks.tier || picks.thinking)) picks.pressure = pressure;
  return picks;
}

/** Where the model and thinking level of a run came from. */
export interface ChoiceSource {
  /** explicit: the call's argument; profile: the agent's profile or file; tier: the automatic tier pick; default: the parent's. */
  model: "explicit" | "profile" | "tier" | "default";
  /** explicit: the call's argument; profile: role/file fallback; jev: task judgment; default: safe medium fallback. */
  thinking: "explicit" | "profile" | "jev" | "default";
}

export interface Resolved {
  agent: AgentDef;
  model: string;
  thinking: string;
  /** Which choices Jev made, for display. */
  byJev: { agent: boolean; model: boolean; thinking: boolean };
  /** Actual classifier route; new fields remain optional when reading older run records. */
  classifier?: System1ProvenanceRecord;
  tier?: Tier;
  /** Where each choice came from. */
  source: ChoiceSource;
  /** The quota pressure Jev's model or effort pick was made under, when above 0. */
  pressure?: number;
  /** Why a selected tier changed or why the parent's model was used, for display. */
  note?: string;
}

export interface ResolveOptions {
  /** Pi's registered models, to check profile models and clamp their thinking. */
  available?: readonly AvailableModel[];
  /** The run's context, for the Haiku guard. */
  context?: RunContextInfo;
  /** Task routing uses a sole candidate; synchronous role-baseline discovery does not. */
  selectSingleTier?: boolean;
}

/**
 * Independent model/effort precedence: explicit call, custom agent pin, task classification,
 * built-in role baseline, balanced/medium fallback, then the parent model with a visible note.
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
  const fixed = fixedAgentDefaults(agent, parent.model, options.available ?? []);
  const provider = parent.model.split("/")[0]!;
  const offered = TIERS.filter((name) => tiers.models[name]?.startsWith(`${provider}/`));
  const validPick = picks?.tier && offered.includes(picks.tier) ? picks.tier : undefined;
  let model = given.model ?? fixed.model;
  let tier: Tier | undefined;
  const source: ChoiceSource = { model: given.model ? "explicit" : fixed.model ? "profile" : "default", thinking: given.thinking ? "explicit" : fixed.thinking ? "profile" : "default" };
  let note: string | undefined;
  if (!model && validPick) {
    tier = validPick;
    if (tier === "fast") {
      note = haikuGuard(tiers.models.fast, options.context);
      if (note) tier = "balanced";
    }
    model = tiers.models[tier]?.startsWith(`${provider}/`) ? tiers.models[tier] : undefined;
    if (model) { source.model = "tier"; byJev.model = true; }
  }
  if (!model && !validPick && options.selectSingleTier !== false && !given.model && !fixed.model && offered.length === 1) {
    tier = offered[0];
    if (tier === "fast") {
      note = haikuGuard(tiers.models.fast, options.context);
      if (note) tier = "balanced";
    }
    model = tiers.models[tier];
    if (model) source.model = "tier";
  }
  if (!model && defaults.model) { model = defaults.model; source.model = "profile"; }
  if (!model && tiers.models.balanced?.startsWith(`${provider}/`)) {
    model = tiers.models.balanced;
    tier = "balanced";
    source.model = "tier";
  }
  if (!model) {
    model = parent.model;
    note = [note, `parent fallback: no usable role or tier mapping for ${provider}`].filter(Boolean).join("; ");
  }
  let thinking = given.thinking ?? fixed.thinking;
  if (!thinking && picks?.thinking && EFFORTS.includes(picks.thinking as (typeof EFFORTS)[number])) {
    thinking = picks.thinking;
    byJev.thinking = true;
    source.thinking = "jev";
  }
  if (!thinking && defaults.thinking) { thinking = defaults.thinking; source.thinking = "profile"; }
  thinking ??= "medium";
  if (!given.thinking) thinking = clampThinking(thinking, physicalChatModels(options.available ?? []).find((m) => `${m.provider}/${m.id}` === model));
  const pressure = picks?.pressure && (byJev.model || byJev.thinking) ? picks.pressure : undefined;
  return { agent, model, thinking, byJev, source, ...(tier ? { tier } : {}), ...(pressure ? { pressure } : {}), ...(note ? { note } : {}) };
}
