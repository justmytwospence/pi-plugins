// pi-auto-effort: sets the thinking level for each message you send. Jev, through Pi's own
// classifier models, answers which level (low to xhigh) the request needs; need(L), the probability
// the work needs at least L, must clear a threshold that rises with subscription pressure, and a
// level goes down only with a clear margin (policy.ts). The bounds are your latest manual level
// (ceiling) or the configured range (free). During a run (tool follow-ups) the level is re-assessed
// only on models that keep their prompt cache across an effort change (midrun.ts); on Codex GPT-6
// models that means configuration_update items (effort-updates.ts). Subscription windows (Anthropic
// 5h/7d, Codex primary/secondary) give the pressure (limits.ts), which is also published to other
// extensions as `quota:pressure`. Opt-in, it also picks a model tier per message while switching
// is cheap (models.ts).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, loadConfig } from "./config.ts";
import { DEFAULT_EFFORT_UPDATES, type EffortUpdatesConfig, emptyState, restoreState, rewritePayload } from "./effort-updates.ts";
import { type ClassifierQuestion, type JevConfig, type JevOutcome, askJev, bool, choice } from "./jev.ts";
import {
  DEFAULT_LIMITS,
  type LimitsPolicy,
  type Pressure,
  Tracker,
  describeWindows,
  limitsPolicy,
  pressureLabel,
  pressureNotice,
  readAnthropicHeaders,
  readCodexHeaders,
} from "./limits.ts";
import { DEFAULT_MID_RUN, MID_RUN_QUESTIONS, type MidRunConfig, globMatch, midRunSupported, runState, shouldAssess } from "./midrun.ts";
import {
  DEFAULT_MODELS,
  type ModelPlan,
  type ModelRef,
  type ModelsConfig,
  type ModelsMode,
  cacheTtlMs,
  isModelsMode,
  modelKey,
  modelPlan,
  modelsConfig,
  parseModel,
  providerTiers,
  shortModelId,
  switchWindow,
  tierQuestion,
} from "./models.ts";
import {
  type Bounds,
  DEFAULT_POLICY,
  JUDGED_LEVELS,
  type Judgment,
  type Policy,
  cumulative,
  decide,
  pickIndex,
  policyConfig,
  pressureValue,
  range,
  threshold,
  trend,
} from "./policy.ts";
import { clip, messageText } from "./transcript.ts";
import { CodexPoller } from "./usage.ts";

export interface EffortConfig extends Record<string, unknown> {
  enabled: boolean;
  jev: JevConfig;
  policy: Policy;
  limits: LimitsPolicy;
  midRun: MidRunConfig;
  effortUpdates: EffortUpdatesConfig;
  models: ModelsConfig;
}

export const DEFAULT_CONFIG: EffortConfig = {
  enabled: true,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_500 },
  policy: DEFAULT_POLICY,
  limits: DEFAULT_LIMITS,
  midRun: DEFAULT_MID_RUN,
  effortUpdates: DEFAULT_EFFORT_UPDATES,
  models: DEFAULT_MODELS,
};

/** Effort-update settings with invalid values replaced by their defaults. */
export function effortUpdatesConfig(value: unknown): EffortUpdatesConfig {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof EffortUpdatesConfig, unknown>>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_EFFORT_UPDATES.enabled,
    models: Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === "string") : DEFAULT_EFFORT_UPDATES.models,
  };
}

/** The `provider/id` globs whose effort changes keep the cache through `configuration_update` items. */
function updateModels(config: EffortConfig): string[] {
  const updates = effortUpdatesConfig(config.effortUpdates);
  return updates.enabled ? updates.models : [];
}

/** Mid-run settings with invalid values replaced by their defaults. */
export function midRunConfig(value: unknown): MidRunConfig {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof MidRunConfig, unknown>>;
  const count = (x: unknown, d: number) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : d);
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_MID_RUN.enabled,
    everyTurns: Math.max(1, count(v.everyTurns, DEFAULT_MID_RUN.everyTurns)),
    errorTurns: count(v.errorTurns, DEFAULT_MID_RUN.errorTurns),
    steps: Math.max(1, count(v.steps, DEFAULT_MID_RUN.steps)),
    models: Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === "string") : DEFAULT_MID_RUN.models,
  };
}

/** For tests: the clock and fetch the limits stage uses. */
export interface AutoEffortDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Abort a Codex usage request after this long (default 5 s). */
  codexTimeoutMs?: number;
  /** Environment for the cache TTL estimate (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Payload of the `quota:pressure` event other extensions can listen for. */
export interface QuotaPressureEvent {
  provider: string;
  tier: "none" | "caution" | "critical";
  /** 0 (none), 0.5 (caution) or 1 (critical). */
  p: number;
  /** The limiting window and tier, like "5h caution"; absent at tier none. */
  label?: string;
}

const NO_PRESSURE: Pressure = { tier: "none" };

const STATE_ENTRY = "auto-effort:state";
const UPDATES_ENTRY = "auto-effort:effort-updates";
const STATUS_KEY = "auto-effort";
export const PRESSURE_EVENT = "quota:pressure";
export const CACHE_STATE_EVENT = "cache:state";

export const QUESTIONS: Record<string, ClassifierQuestion> = {
  depth: {
    type: "choice",
    instructions:
      "How much careful reasoning does the work asked for in `request` need from a coding agent, given `previous_requests`, `last_outcome` and `signals`?",
    criteria: {
      low: "A lookup, a trivial answer, or a mechanical change",
      medium: "A routine single-file change or a clear question",
      high: "A multi-step change, debugging with clear symptoms, or design inside a known pattern",
      xhigh: "Subtle design, a cross-cutting refactor, hard debugging, or correctness-critical work",
    },
  },
  ack: {
    type: "bool",
    instructions:
      'Is `request` a short go-ahead or acknowledgement (like "yes", "go ahead", "continue", "do it") that relies on the plan already discussed, rather than a new task?',
    criteria: { true: "A go-ahead for work already under way", false: "A new or changed request" },
  },
};

interface Entry {
  type?: string;
  customType?: string;
  data?: unknown;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; timestamp?: unknown; [key: string]: unknown };
}

/** The Jev state for a new prompt: the request, the two before it, the last answer, and what the last run did. */
export function effortState(prompt: string, entries: readonly unknown[]): Record<string, unknown> {
  const list = entries as Entry[];
  const users: number[] = [];
  list.forEach((entry, i) => {
    if (entry.type === "message" && entry.message?.role === "user") users.push(i);
  });
  // The new prompt may already be on the branch; the previous run is before it.
  const lastUser = users.at(-1);
  if (lastUser !== undefined && messageText(list[lastUser]?.message?.content).trim() === prompt.trim()) users.pop();
  const runStart = users.at(-1);
  const previous = users.slice(-2).map((i) => clip(messageText(list[i]?.message?.content).trim(), 1_000));
  let lastOutcome = "";
  const signals = { last_run_errors: 0, files_edited: 0, tool_calls: 0 };
  if (runStart !== undefined) {
    for (const entry of list.slice(runStart + 1)) {
      const m = entry.message;
      if (entry.type !== "message" || !m) continue;
      if (m.role === "user") break;
      if (m.role === "assistant") {
        const text = messageText(m.content).trim();
        if (text) lastOutcome = text;
        const calls = Array.isArray(m.content) ? m.content.filter((b: { type?: string }) => b?.type === "toolCall") : [];
        signals.tool_calls += calls.length;
      }
      if (m.role === "toolResult") {
        if (m.isError) signals.last_run_errors++;
        if ((m.toolName === "edit" || m.toolName === "write") && !m.isError) signals.files_edited++;
      }
    }
  }
  return {
    request: clip(prompt, 8_000),
    previous_requests: previous.length ? previous : ["(none: this is the first request)"],
    last_outcome: lastOutcome ? clip(lastOutcome, 1_500) : "(none)",
    signals,
  };
}

/** True when the process was started with an explicit `--thinking` level (for example a subagent). */
export function thinkingPinned(argv: readonly string[] = process.argv): boolean {
  return argv.some((a) => a === "--thinking" || a.startsWith("--thinking="));
}

/** The depth judgment in a Jev outcome: need per level from the `depth` choice, and the go-ahead probability. */
export function judgment(outcome: JevOutcome, withAck: boolean): Judgment | undefined {
  if (!outcome.ok) return undefined;
  const depth = choice(outcome.answers, "depth");
  if (!depth || !isRecord(depth.probabilities)) return undefined;
  const ack = withAck ? bool(outcome.answers, "ack") : 0;
  if (ack === undefined) return undefined;
  return { need: cumulative(depth.probabilities, JUDGED_LEVELS), ack };
}

/** `5h caution`: the limiting window and its tier. */
export function pressureTag(p: Pressure): string {
  return `${p.label ?? p.window ?? "?"} ${p.tier}`;
}

interface ModelCheck {
  plan: ModelPlan;
  /** Why switching is cheap now ("cache is cold"). */
  why: string;
  mode: ModelsMode;
}

interface ModelChoice {
  tier: string;
  need: Record<string, number>;
  to: string;
  why: string;
  action: "keep" | "suggest" | "switched" | "missing" | "failed";
}

interface RegistryModel {
  provider: string;
  id: string;
  name?: string;
}

export default function autoEffort(pi: ExtensionAPI, deps: AutoEffortDeps = {}) {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  let config: EffortConfig = DEFAULT_CONFIG;
  // Your latest manual level: the ceiling in `ceiling` bounds, restored by /auto-effort off.
  let manualLevel = "high";
  // The last judgment's need per level and theta, for the trend arrow and the status.
  let lastNeed: Record<string, number> | undefined;
  let lastTheta: number | undefined;
  let lastLevel: string | undefined;
  let pressure: Pressure = NO_PRESSURE;
  let pressureProvider: string | undefined;
  const trackers = new Map<string, Tracker>();
  const tracker = (provider: string) => {
    let t = trackers.get(provider);
    if (!t) trackers.set(provider, (t = new Tracker()));
    return t;
  };
  let latestCtx: ExtensionContext | undefined;
  const poller = new CodexPoller({
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now,
    timeoutMs: deps.codexTimeoutMs ?? 5_000,
    token: async () => latestCtx?.modelRegistry.getApiKeyForProvider("openai-codex"),
    onAccount: () => trackers.set("openai-codex", new Tracker()),
    record: (readings) => readings.forEach((r) => tracker("openai-codex").record(r)),
  });
  let sessionOn = true;
  // `/auto-effort bounds ...` and `/auto-effort models ...` for this session; undefined follows the settings.
  let sessionBounds: Bounds | undefined;
  let sessionModels: ModelsMode | undefined;
  let applying = false;
  // Our own setThinkingLevel calls also emit thinking_level_select, during or just after the call.
  let ownLevel: string | undefined;
  let firedWhileApplying = false;
  let lastReason = "";
  // Tool turns since the last assessment in this run.
  let turnsSince = 0;
  // Request-level effort and configuration_update positions for this conversation.
  let updates = emptyState();
  const pinned = thinkingPinned();
  // Bumped when a prompt, session, branch, model, manual level or gate replaces the state a
  // Jev answer would apply to. Shutdown invalidates callbacks from the old runtime too.
  let generation = 0;
  // The model you picked by hand, and the model auto picked instead (while it is in use).
  let manualModel: ModelRef | undefined;
  let autoModel: string | undefined;
  let switchingModel = false;
  // pi-cache-guard's latest `cache:state`, when it is loaded; else the time of the last answer.
  let cacheState: { cold: boolean; tokens?: number; model?: string } | undefined;
  let lastResponseAt: number | undefined;

  const active = () => sessionOn && config.enabled && !pinned;
  const policy = () => policyConfig(config.policy);
  const boundsMode = (): Bounds => sessionBounds ?? policy().bounds;
  const models = () => modelsConfig(config.models);
  const modelsMode = (): ModelsMode => sessionModels ?? models().mode;

  /** True when the model keeps its prompt cache across an effort change (mid-run or configuration_update). */
  const cacheSafe = (ctx: ExtensionContext) => midRunSupported(ctx.model, [...midRunConfig(config.midRun).models, ...updateModels(config)]);

  const limits = () => limitsPolicy(config.limits);
  const limitsOn = () => active() && limits().enabled;

  const emitPressure = (provider: string | undefined) => {
    if (!provider) return;
    const payload: QuotaPressureEvent = {
      provider,
      tier: pressure.tier,
      p: pressureValue(pressure.tier),
      ...(pressure.tier !== "none" ? { label: pressureTag(pressure) } : {}),
    };
    pi.events?.emit(PRESSURE_EVENT, payload);
  };

  const status = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const current = pi.getThinkingLevel();
    const bounds = boundsMode();
    const direction = trend(current, manualLevel, lastNeed, lastTheta, policy(), bounds);
    const arrow = direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
    const bound = bounds === "free" ? "free" : `≤${manualLevel}`;
    const marker = autoModel ? ` ≈${shortModelId(autoModel)}` : "";
    const limited = limitsOn() && pressure.tier !== "none" ? `, limited: ${pressureLabel(pressure)}` : "";
    // pi-status-footer parses this: no parentheses inside the detail.
    const detail = `${arrow} ${bound}${marker}${limited}`.replace(/[()]/gu, "");
    ctx.ui.setStatus(STATUS_KEY, active() ? `effort: ${current} (auto ${detail})` : undefined);
  };

  const manual = (level: string) => {
    generation++;
    manualLevel = level;
    lastLevel = level;
  };

  /** Refreshes Codex usage in the background while a Codex model is in use. */
  const pollCodex = (ctx: ExtensionContext) => {
    latestCtx = ctx;
    if (limitsOn() && ctx.model?.provider === "openai-codex") void poller.refresh();
  };

  const limitLines = (ctx: ExtensionContext) => {
    const provider = ctx.model?.provider;
    const views = provider ? trackers.get(provider)?.view(now(), limits()) ?? [] : [];
    if (!limits().enabled) return ["limits: off (settings)"];
    if (!views.length) return [`limits: no readings for ${provider ?? "this model"} yet`];
    return describeWindows(views, now()).map((line) => `limits: ${line}`);
  };

  const currentRef = (ctx: ExtensionContext): ModelRef | undefined => (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);

  /** True when the prompt cache has likely expired: pi-cache-guard's word, else the time since the last answer. */
  const cold = (ctx: ExtensionContext) => {
    // A cache that belongs to another model is no use to this one.
    if (cacheState) return cacheState.cold || (cacheState.model !== undefined && ctx.model !== undefined && cacheState.model !== modelKey(ctx.model));
    if (lastResponseAt === undefined) return false;
    return now() - lastResponseAt > cacheTtlMs(ctx.model as { promptCache?: { short?: number; long?: number } } | undefined, env);
  };

  /** Model candidates for this message, when model choice is on and switching is cheap now. */
  const modelCheck = (ctx: ExtensionContext): ModelCheck | undefined => {
    const mode = modelsMode();
    const current = currentRef(ctx);
    if (mode === "off" || !current) return undefined;
    const settings = models();
    const plan = modelPlan(settings, current, manualModel ?? current);
    if (!plan) return undefined;
    const branch = ctx.sessionManager.getBranch() as Entry[];
    const first = !branch.some((e) => e.type === "message" && e.message?.role === "assistant");
    const tokens = cacheState?.tokens ?? ctx.getContextUsage?.()?.tokens;
    const why = switchWindow({ first, cold: cold(ctx), tokens, maxSwitchTokens: settings.maxSwitchTokens });
    return why ? { plan, why, mode } : undefined;
  };

  const switchModel = async (ctx: ExtensionContext, model: RegistryModel): Promise<boolean> => {
    switchingModel = true;
    applying = true;
    try {
      return await pi.setModel(model as never);
    } catch {
      return false;
    } finally {
      switchingModel = false;
      applying = false;
      ownLevel = undefined;
    }
  };

  const findModel = (ctx: ExtensionContext, ref: ModelRef): RegistryModel | undefined => {
    const registry = ctx.modelRegistry as { find?: (provider: string, id: string) => RegistryModel | undefined } | undefined;
    try {
      return registry?.find?.(ref.provider, ref.id);
    } catch {
      return undefined;
    }
  };

  /** Picks a tier by the threshold rule, then suggests or switches to its model. */
  const chooseModel = async (
    ctx: ExtensionContext,
    check: ModelCheck,
    probabilities: Record<string, number> | undefined,
    j: Judgment | undefined,
    theta: number,
    bounds: Bounds,
  ): Promise<ModelChoice | undefined> => {
    if (!j || !probabilities || j.ack > policy().ackThreshold) return undefined;
    const { plan } = check;
    const order = plan.tiers.map((t) => t.tier);
    const need = cumulative(probabilities, order);
    const manualAt = order.indexOf(plan.manualTier);
    const hi = bounds === "ceiling" && manualAt >= 0 ? manualAt : order.length - 1;
    const pick = plan.tiers[pickIndex(need, order, 0, hi, theta)]!;
    const current = currentRef(ctx);
    // Your own model when its tier is picked; the provider never changes.
    const target: ModelRef = pick.tier === plan.manualTier && plan.manual.provider === current?.provider ? plan.manual : pick;
    const to = modelKey(target);
    const record = { tier: pick.tier, need, to, why: check.why };
    if (current && to === modelKey(current)) return { ...record, action: "keep" };
    const found = findModel(ctx, target);
    const name = found?.name ?? shortModelId(target.id);
    if (check.mode === "suggest") {
      if (ctx.hasUI) ctx.ui.notify(`auto-effort: ${name} would do; ${check.why}: /model ${to}`, "info");
      return { ...record, action: "suggest" };
    }
    if (!found) {
      if (ctx.hasUI) ctx.ui.notify(`auto-effort: no model ${to} in the registry`, "warning");
      return { ...record, action: "missing" };
    }
    if (!(await switchModel(ctx, found))) {
      if (ctx.hasUI) ctx.ui.notify(`auto-effort: could not switch to ${name} (no credentials for ${target.provider})`, "warning");
      return { ...record, action: "failed" };
    }
    const back = to === modelKey(plan.manual);
    autoModel = back ? undefined : to;
    if (ctx.hasUI) ctx.ui.notify(back ? `auto-effort: back to ${name}; ${check.why}` : `auto-effort: ${name} for this request; ${check.why}`, "info");
    return { ...record, action: "switched" };
  };

  /**
   * Rebuild the state from the current branch: its last `auto-effort:state` entry and the
   * effort-update positions. Called at session start and after /tree moves the leaf, since the
   * entries of an abandoned branch describe another history. Fields of older versions (the
   * running average `e`, `dwell`) are ignored.
   */
  const restoreFromBranch = (ctx: ExtensionContext) => {
    generation++;
    turnsSince = 0;
    ownLevel = undefined;
    firedWhileApplying = false;
    const branch = ctx.sessionManager.getBranch() as Entry[];
    const savedIndex = branch.findLastIndex((e) => e.type === "custom" && e.customType === STATE_ENTRY);
    const data = (isRecord(branch[savedIndex]?.data) ? branch[savedIndex]!.data : undefined) as Record<string, unknown> | undefined;
    manualLevel = typeof data?.ceiling === "string" ? data.ceiling : pi.getThinkingLevel();
    lastLevel = typeof data?.level === "string" ? data.level : undefined;
    lastReason = typeof data?.reason === "string" ? data.reason : "";
    lastNeed = isRecord(data?.need) ? numbers(data.need) : undefined;
    lastTheta = typeof data?.theta === "number" ? data.theta : undefined;
    const current = currentRef(ctx);
    manualModel = typeof data?.manualModel === "string" && current ? parseModel(data.manualModel, current.provider) : current;
    autoModel = typeof data?.autoModel === "string" && current && modelKey(current) === data.autoModel ? data.autoModel : undefined;
    pressure = NO_PRESSURE;
    // Own changes precede their state entry. Later thinking and model entries are manual choices
    // that must survive a reload or /tree move even if no new assessment was saved yet.
    for (const entry of branch.slice(savedIndex + 1)) {
      if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") manual(entry.thinkingLevel);
      if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
        manualModel = { provider: entry.provider, id: entry.modelId };
        autoModel = undefined;
      }
    }
    const lastAnswer = branch.findLast((e) => e.type === "message" && e.message?.role === "assistant");
    lastResponseAt = typeof lastAnswer?.message?.timestamp === "number" ? lastAnswer.message.timestamp : undefined;
    const savedUpdates = [...branch].reverse().find((e) => e.type === "custom" && e.customType === UPDATES_ENTRY);
    updates = restoreState(savedUpdates?.data);
    status(ctx);
  };

  pi.events?.on?.(CACHE_STATE_EVENT, (data: unknown) => {
    if (!isRecord(data) || typeof data.cold !== "boolean") return;
    cacheState = {
      cold: data.cold,
      ...(typeof data.tokens === "number" && Number.isFinite(data.tokens) ? { tokens: data.tokens } : {}),
      ...(typeof data.model === "string" ? { model: data.model } : {}),
    };
  });

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    restoreFromBranch(ctx);
    pollCodex(ctx);
  });

  // /tree moved the leaf: the branch below it is the history now, with its own last state.
  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  // On models that take configuration_update items, any effort change (auto, manual, or another
  // extension's) keeps the prompt cache: the request-level effort stays put and the change
  // becomes an item in the input. Independent of /auto-effort on/off.
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || (event.payload as { model?: unknown } | undefined)?.model !== model.id) return undefined;
    const key = `${model.provider}/${model.id}`;
    if (!updateModels(config).some((glob) => globMatch(glob, key))) return undefined;
    if (rewritePayload(updates, event.payload)) pi.appendEntry(UPDATES_ENTRY, { ...updates, transitions: [...updates.transitions] });
    return event.payload;
  });

  pi.on("model_select", (event, ctx) => {
    pollCodex(ctx);
    if (switchingModel) return;
    generation++;
    turnsSince = 0;
    const model = (event as { model?: { provider?: unknown; id?: unknown } } | undefined)?.model;
    if (model && typeof model.provider === "string" && typeof model.id === "string") manualModel = { provider: model.provider, id: model.id };
    if (autoModel !== undefined) {
      autoModel = undefined;
      status(ctx);
    }
  });
  pi.on("message_end", (event) => {
    if ((event as { message?: { role?: string } }).message?.role === "assistant") lastResponseAt = now();
  });
  pi.on("agent_settled", (_event, ctx) => pollCodex(ctx));
  pi.on("session_shutdown", () => {
    generation++;
    latestCtx = undefined;
    ownLevel = undefined;
  });

  pi.on("after_provider_response", (event, ctx) => {
    const provider = ctx.model?.provider;
    const headers = event.headers ?? {};
    if (provider === "anthropic") readAnthropicHeaders(headers, now()).forEach((r) => tracker(provider).record(r));
    else if (provider === "openai-codex") readCodexHeaders(headers, now()).forEach((r) => tracker(provider).record(r));
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const own = applying || (ownLevel !== undefined && event.level === ownLevel);
    ownLevel = undefined;
    if (applying) firedWhileApplying = true;
    if (own) return;
    manual(event.level);
    if (ctx) status(ctx);
  });

  const setLevel = (level: string) => {
    applying = true;
    firedWhileApplying = false;
    try {
      pi.setThinkingLevel(level as never);
    } finally {
      applying = false;
    }
    if (!firedWhileApplying) ownLevel = pi.getThinkingLevel();
  };

  /**
   * Applies a judgment: the pressure gives theta, the policy picks a level (and, before a message,
   * maybe a model), and the decision is recorded.
   */
  const settle = async (
    ctx: ExtensionContext,
    outcome: JevOutcome,
    j: Judgment | undefined,
    extra: Record<string, unknown>,
    model?: { check: ModelCheck; probabilities: Record<string, number> | undefined },
  ) => {
    const current = pi.getThinkingLevel();
    const provider = ctx.model?.provider;
    if (provider !== pressureProvider) {
      if (pressureProvider) trackers.get(pressureProvider)?.clearTiers();
      pressureProvider = provider;
    }
    const previous = pressure;
    pressure = limitsOn() && provider ? (trackers.get(provider)?.assess(now(), limits()) ?? NO_PRESSURE) : NO_PRESSURE;
    if (pressure.tier !== previous.tier && ctx.hasUI) ctx.ui.notify(pressureNotice(pressure, now()), pressure.tier === "none" ? "info" : "warning");
    emitPressure(provider);

    const p = pressureValue(pressure.tier);
    const bounds = boundsMode();
    const decision = decide(current, manualLevel, j, policy(), p, bounds);
    // A go-ahead's own need says nothing about the work, so the trend keeps the last one.
    if (j && decision.reason !== "ack") lastNeed = j.need;
    lastTheta = decision.theta;
    lastReason = outcome.ok ? decision.reason : `unavailable: ${outcome.reason}`;

    const modelChoice = model ? await chooseModel(ctx, model.check, model.probabilities, j, decision.theta, bounds) : undefined;
    // A model switch can change the level (Pi's per-model default); the decision wins.
    if (decision.level !== pi.getThinkingLevel()) setLevel(decision.level);
    lastLevel = pi.getThinkingLevel();
    pi.appendEntry(STATE_ENTRY, {
      ...extra,
      ceiling: manualLevel,
      bounds,
      from: current,
      level: lastLevel,
      reason: lastReason,
      theta: decision.theta,
      p,
      ...(pressure.tier !== "none"
        ? { limit: { tier: pressure.tier, window: pressure.window, used: pressure.used, projected: pressure.projected, exhaustsAt: pressure.exhaustsAt } }
        : {}),
      ...(j ? { need: j.need, ack: j.ack } : {}),
      ...(manualModel ? { manualModel: modelKey(manualModel) } : {}),
      ...(autoModel ? { autoModel } : {}),
      ...(modelChoice ? { model: modelChoice } : {}),
      ...(outcome.ok ? { latencyMs: outcome.latencyMs, inputTokens: outcome.usage?.input } : {}),
    });
    status(ctx);
  };

  pi.on("before_agent_start", async (event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    turnsSince = 0;
    const mine = ++generation;
    // ctx.signal can be a getter for the runtime's current operation. Keep this operation's
    // signal across the await rather than checking a later run's signal when the answer arrives.
    const signal = ctx.signal;
    if (!("prompt" in event) || !active() || !event.prompt.trim() || signal?.aborted) return;
    // Codex usage refreshes alongside the Jev call; the prompt never waits for it.
    pollCodex(ctx);
    const check = modelCheck(ctx);
    const questions = check ? { ...QUESTIONS, tier: tierQuestion(check.plan.tiers) } : QUESTIONS;
    const outcome = await askJev(ctx.modelRegistry, config.jev, effortState(event.prompt, ctx.sessionManager.getBranch()), questions, signal);
    if (mine !== generation || signal?.aborted || !active()) return;
    const j = judgment(outcome, true);
    const probabilities = check && outcome.ok ? choice(outcome.answers, "tier")?.probabilities : undefined;
    await settle(ctx, outcome, j, { phase: "prompt" }, check ? { check, probabilities } : undefined);
  });

  // Between tool turns, on models that take an effort change mid-conversation without losing the
  // cache: the handler is awaited before the next request, which picks up the new level.
  pi.on("turn_end", async (event, ctx) => {
    if (!active()) return;
    const mid = midRunConfig(config.midRun);
    if (!mid.enabled || !cacheSafe(ctx)) return;
    const results = (event.toolResults ?? []) as Array<{ isError?: boolean }>;
    const stop = (event.message as { stopReason?: string } | undefined)?.stopReason;
    const signal = ctx.signal;
    // A turn without tool results ends the run; an error or abort has no next request to change.
    if (!results.length || stop === "error" || stop === "aborted" || signal?.aborted) return;
    turnsSince++;
    if (!shouldAssess(mid, turnsSince, results.filter((r) => r.isError).length)) return;
    turnsSince = 0;
    const mine = generation;
    const outcome = await askJev(ctx.modelRegistry, config.jev, runState(ctx.sessionManager.getBranch(), mid.steps), MID_RUN_QUESTIONS, signal);
    if (mine !== generation || signal?.aborted || !active()) return;
    // Mid-run there is no message to be a go-ahead.
    await settle(ctx, outcome, judgment(outcome, false), { phase: "run", turn: event.turnIndex });
  });

  const OPTIONS = ["status", "limits", "on", "off", "bounds ceiling", "bounds free", "models off", "models suggest", "models auto"];

  pi.registerCommand("auto-effort", {
    description: "auto-effort: status, limits, on, off, bounds ceiling|free, models off|suggest|auto (this session)",
    getArgumentCompletions: (prefix: string) => OPTIONS.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const [arg = "", value] = args.trim().split(/\s+/u);
      if (arg === "on" || arg === "off") {
        sessionOn = arg === "on";
        // An assessment in flight must not apply after the gate was switched.
        generation++;
        if (!sessionOn) {
          if (pi.getThinkingLevel() !== manualLevel) setLevel(manualLevel);
          if (autoModel && manualModel) {
            const found = findModel(ctx, manualModel);
            if (found && (await switchModel(ctx, found))) autoModel = undefined;
          }
          if (pressure.tier !== "none") {
            pressure = NO_PRESSURE;
            emitPressure(ctx.model?.provider);
          }
        }
        status(ctx);
        ctx.ui.notify(`auto-effort ${arg} for this session${sessionOn ? "" : `; back to ${pi.getThinkingLevel()}`}`, "info");
        return;
      }
      if (arg === "bounds") {
        if (value === "ceiling" || value === "free") {
          sessionBounds = value;
          generation++;
          status(ctx);
          ctx.ui.notify(`auto-effort bounds ${value} for this session: ${boundsText(value, manualLevel, policy())}`, "info");
        } else ctx.ui.notify(`auto-effort bounds: ${boundsMode()}. Use /auto-effort bounds ceiling or free.`, "info");
        return;
      }
      if (arg === "models") {
        if (isModelsMode(value)) {
          sessionModels = value;
          generation++;
          status(ctx);
          const provider = ctx.model?.provider;
          const none = value !== "off" && provider && !providerTiers(models(), provider).length ? `; no tiers configured for ${provider} (models.tiers)` : "";
          ctx.ui.notify(`auto-effort models ${value} for this session${none}`, "info");
        } else ctx.ui.notify(`auto-effort models: ${modelsMode()}. Use /auto-effort models off, suggest or auto.`, "info");
        return;
      }
      if (arg === "limits") {
        ctx.ui.notify(limitLines(ctx).join("\n"), "info");
        return;
      }
      const bounds = boundsMode();
      ctx.ui.notify(
        [
          `auto-effort ${active() ? "on" : pinned ? "off (--thinking was given)" : "off"}: ${pi.getThinkingLevel()} now.`,
          `Bounds ${bounds} (${sessionBounds ? "this session" : "settings"}): ${boundsText(bounds, manualLevel, policy())}.`,
          jevLine(lastNeed, lastTheta ?? threshold(policy(), pressureValue(pressure.tier)), pressure, lastLevel, lastReason),
          modelsLine(modelsMode(), sessionModels !== undefined, manualModel, autoModel),
          ...limitLines(ctx),
        ].join("\n"),
        "info",
      );
    },
  });
}

function numbers(value: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

function boundsText(bounds: Bounds, manualLevel: string, policy: Policy) {
  const r = range(manualLevel, policy, bounds);
  if (bounds === "free") return `${policy.floor} to ${r ? JUDGED_LEVELS[r.upper] : policy.max}; your last manual level, ${manualLevel}, is not a cap`;
  if (!r) return `left alone: your last manual level, ${manualLevel}, is outside ${policy.floor} to xhigh`;
  return `${policy.floor} to ${manualLevel}, your last manual level`;
}

/** `Jev: need(medium)=0.90 need(high)=0.55 need(xhigh)=0.10, θ=0.70 (5h caution) → medium, last decision: hold.` */
function jevLine(need: Record<string, number> | undefined, theta: number, pressure: Pressure, level: string | undefined, reason: string) {
  const tag = pressure.tier !== "none" ? ` (${pressureTag(pressure)})` : "";
  const last = reason ? `, last decision: ${reason}` : "";
  if (!need) return `Jev: no assessment yet, θ=${theta.toFixed(2)}${tag}${last}.`;
  const needs = JUDGED_LEVELS.slice(1)
    .map((l) => `need(${l})=${(need[l] ?? 0).toFixed(2)}`)
    .join(" ");
  return `Jev: ${needs}, θ=${theta.toFixed(2)}${tag}${level ? ` → ${level}` : ""}${last}.`;
}

function modelsLine(mode: ModelsMode, session: boolean, manual: ModelRef | undefined, auto: string | undefined) {
  const source = session ? "this session" : "settings";
  if (mode === "off") return `Models: off (${source}).`;
  const yours = manual ? `, your model ${modelKey(manual)}` : "";
  return `Models: ${mode} (${source})${yours}${auto ? `, now ${auto}` : ""}.`;
}
