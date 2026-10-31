// pi-auto-effort: sets the thinking level for each message you send. Jev, through Pi's own
// classifier models, answers which level (low to xhigh) the request needs; need(L), the probability
// the work needs at least L, must clear a threshold that rises with subscription pressure, and a
// level goes down only with a clear margin (policy.ts). The bounds are your latest manual level
// (ceiling) or the configured range (free). During a run (tool follow-ups) the level is re-assessed
// only on models that keep their prompt cache across an effort change (midrun.ts); on Codex GPT-6
// models that means configuration_update items (effort-updates.ts). Subscription windows (Anthropic
// 5h/7d, Codex primary/secondary) give the pressure (limits.ts), which is also published to other
// extensions as `quota:pressure`.
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
  type Bounds,
  DEFAULT_POLICY,
  type Decision,
  JUDGED_LEVELS,
  type Judgment,
  type Policy,
  cumulative,
  decide,
  policyConfig,
  pressureValue,
  range,
  threshold,
  trend,
} from "./policy.ts";
import { DEFAULT_PREFILTER, type PrefilterConfig, isGoAhead, prefilterConfig } from "./prefilter.ts";
import { type Counts, countsFromBranch, describeCounts, emptyCounts, tally } from "./stats.ts";
import { clip, messageText } from "./transcript.ts";
import { UNTRUSTED_REPLY } from "./untrusted.ts";
import { CodexPoller } from "./usage.ts";

export interface EffortConfig extends Record<string, unknown> {
  enabled: boolean;
  jev: JevConfig;
  policy: Policy;
  limits: LimitsPolicy;
  midRun: MidRunConfig;
  effortUpdates: EffortUpdatesConfig;
  prefilter: PrefilterConfig;
}

export const DEFAULT_CONFIG: EffortConfig = {
  enabled: true,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_500 },
  policy: DEFAULT_POLICY,
  limits: DEFAULT_LIMITS,
  midRun: DEFAULT_MID_RUN,
  effortUpdates: DEFAULT_EFFORT_UPDATES,
  prefilter: DEFAULT_PREFILTER,
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

/** Settled by the pre-filter instead of a Jev answer: the level stays, with reason `go-ahead`. */
const GO_AHEAD = "go-ahead";

const STATE_ENTRY = "auto-effort:state";
const UPDATES_ENTRY = "auto-effort:effort-updates";
const STATUS_KEY = "auto-effort";
export const PRESSURE_EVENT = "quota:pressure";

const DEPTH_CRITERIA = {
  low: "A lookup, a trivial answer, or a mechanical change",
  medium: "A routine single-file change or a clear question",
  high: "A multi-step change, debugging with clear symptoms, or design inside a known pattern",
  xhigh: "Subtle design, a cross-cutting refactor, hard debugging, or correctness-critical work",
};

export const QUESTIONS: Record<string, ClassifierQuestion> = {
  depth: {
    type: "choice",
    instructions: `How much careful reasoning does the work asked for in \`request\` need from a coding agent, given \`previous_requests\`, \`agent_reply_untrusted\` and \`signals\`? ${UNTRUSTED_REPLY}`,
    criteria: DEPTH_CRITERIA,
  },
  ack: {
    type: "bool",
    instructions:
      'Is `request` a short go-ahead or acknowledgement (like "yes", "go ahead", "continue", "do it") that relies on the plan already discussed, rather than a new task?',
    criteria: { true: "A go-ahead for work already under way", false: "A new or changed request" },
  },
};

/** The questions as they were before `agent_reply_untrusted` (state with `legacy`): for the eval comparison. */
export const LEGACY_QUESTIONS: Record<string, ClassifierQuestion> = {
  ...QUESTIONS,
  depth: {
    type: "choice",
    instructions: "How much careful reasoning does the work asked for in `request` need from a coding agent, given `previous_requests`, `last_outcome` and `signals`?",
    criteria: DEPTH_CRITERIA,
  },
};

interface Entry {
  type?: string;
  customType?: string;
  data?: unknown;
  thinkingLevel?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; timestamp?: unknown; [key: string]: unknown };
}

export interface EffortStateOptions {
  /** The earlier shape: the agent's reply as `last_outcome`, clipped at 1,500 characters (for the eval comparison). */
  legacy?: boolean;
}

/**
 * The Jev state for a new prompt: the request, the two before it, the agent's last reply
 * (`agent_reply_untrusted`, clipped at 600 characters: Jev is told to treat it as a description
 * only), and what the last run did.
 */
export function effortState(prompt: string, entries: readonly unknown[], options: EffortStateOptions = {}): Record<string, unknown> {
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
    ...(options.legacy
      ? { last_outcome: lastOutcome ? clip(lastOutcome, 1_500) : "(none)" }
      : { agent_reply_untrusted: lastOutcome ? clip(lastOutcome, 600) : "(none)" }),
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

export default function autoEffort(pi: ExtensionAPI, deps: AutoEffortDeps = {}) {
  const now = deps.now ?? Date.now;
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
  // `/auto-effort bounds ...` for this session; undefined follows the settings.
  let sessionBounds: Bounds | undefined;
  let applying = false;
  // Our own setThinkingLevel calls also emit thinking_level_select, during or just after the call.
  let ownLevel: string | undefined;
  let firedWhileApplying = false;
  let lastReason = "";
  // What this session's branch did, for /auto-effort status: tallied from the state entries.
  let counts: Counts = emptyCounts();
  // Tool turns since the last assessment in this run.
  let turnsSince = 0;
  // Request-level effort and configuration_update positions for this conversation.
  let updates = emptyState();
  const pinned = thinkingPinned();
  // Bumped when a prompt, session, branch, model, manual level or gate replaces the state a
  // Jev answer would apply to. Shutdown invalidates callbacks from the old runtime too.
  let generation = 0;

  const active = () => sessionOn && config.enabled && !pinned;
  const policy = () => policyConfig(config.policy);
  const boundsMode = (): Bounds => sessionBounds ?? policy().bounds;

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
    const limited = limitsOn() && pressure.tier !== "none" ? `, limited: ${pressureLabel(pressure)}` : "";
    // pi-status-footer parses this: no parentheses inside the detail.
    const detail = `${arrow} ${bound}${limited}`.replace(/[()]/gu, "");
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
    counts = countsFromBranch(branch, STATE_ENTRY);
    lastNeed = isRecord(data?.need) ? numbers(data.need) : undefined;
    lastTheta = typeof data?.theta === "number" ? data.theta : undefined;
    pressure = NO_PRESSURE;
    // Own changes precede their state entry. Later thinking entries are manual choices
    // that must survive a reload or /tree move even if no new assessment was saved yet.
    for (const entry of branch.slice(savedIndex + 1)) {
      if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") manual(entry.thinkingLevel);
    }
    const savedUpdates = [...branch].reverse().find((e) => e.type === "custom" && e.customType === UPDATES_ENTRY);
    updates = restoreState(savedUpdates?.data);
    status(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    restoreFromBranch(ctx);
    pollCodex(ctx);
  });

  // /tree moved the leaf: the branch below it is the history now, with its own last state.
  pi.on("session_tree", (_event, ctx) => {
    latestCtx = ctx;
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

  pi.on("model_select", (_event, ctx) => {
    pollCodex(ctx);
    generation++;
    turnsSince = 0;
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
   * Applies a judgment: the pressure gives theta, the policy picks a level, and the decision is
   * recorded. `GO_AHEAD` (no Jev call) keeps the level.
   */
  const settle = async (
    ctx: ExtensionContext,
    outcome: JevOutcome | typeof GO_AHEAD,
    j: Judgment | undefined,
    extra: Record<string, unknown>,
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
    const decision: Omit<Decision, "reason"> & { reason: Decision["reason"] | typeof GO_AHEAD } =
      outcome === GO_AHEAD ? { level: current, reason: GO_AHEAD, theta: threshold(policy(), p) } : decide(current, manualLevel, j, policy(), p, bounds);
    // A go-ahead's own need says nothing about the work, so the trend keeps the last one.
    if (j && decision.reason !== "ack") lastNeed = j.need;
    lastTheta = decision.theta;
    lastReason = outcome === GO_AHEAD || outcome.ok ? decision.reason : `assessment unavailable: ${outcome.reason}`;

    if (decision.level !== pi.getThinkingLevel()) setLevel(decision.level);
    lastLevel = pi.getThinkingLevel();
    const data = {
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
      ...(outcome !== GO_AHEAD && outcome.ok ? { latencyMs: outcome.latencyMs, inputTokens: outcome.usage?.input } : {}),
    };
    tally(counts, data);
    pi.appendEntry(STATE_ENTRY, data);
    status(ctx);
  };

  pi.on("before_agent_start", async (event, ctx) => {
    config = loadConfig("auto-effort", DEFAULT_CONFIG, ctx.cwd);
    turnsSince = 0;
    const mine = ++generation;
    // ctx.signal can be a getter for the runtime's current operation. Keep this operation's
    // signal across the await rather than checking a later run's signal when the answer arrives.
    const signal = ctx.signal;
    const text = "prompt" in event && typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (!("prompt" in event) || !active() || !text || signal?.aborted) return;
    latestCtx = ctx;
    // Codex usage refreshes alongside the Jev call; the prompt never waits for it.
    pollCodex(ctx);
    // "yes", "go ahead", "thanks": nothing to assess; the level stays.
    const filter = prefilterConfig(config.prefilter);
    if (filter.enabled && isGoAhead(text, filter)) {
      await settle(ctx, GO_AHEAD, undefined, { phase: "prompt" });
      return;
    }
    const outcome = await askJev(ctx.modelRegistry, config.jev, effortState(event.prompt, ctx.sessionManager.getBranch()), QUESTIONS, signal);
    if (mine !== generation || signal?.aborted || !active()) return;
    const j = judgment(outcome, true);
    await settle(ctx, outcome, j, { phase: "prompt" });
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

  const OPTIONS = ["status", "limits", "on", "off", "bounds ceiling", "bounds free"];

  pi.registerCommand("auto-effort", {
    description: "auto-effort: status, limits, on, off, bounds ceiling|free (this session)",
    getArgumentCompletions: (prefix: string) => OPTIONS.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const [arg = "", value] = args.trim().split(/\s+/u);
      if (arg === "on" || arg === "off") {
        sessionOn = arg === "on";
        // An assessment in flight must not apply after the gate was switched.
        generation++;
        if (!sessionOn) {
          if (pi.getThinkingLevel() !== manualLevel) setLevel(manualLevel);
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
          describeCounts(counts),
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

/** `Assessment: need(medium)=0.90 need(high)=0.55 need(xhigh)=0.10, θ=0.70 (5h caution) → medium, last decision: hold.` */
function jevLine(need: Record<string, number> | undefined, theta: number, pressure: Pressure, level: string | undefined, reason: string) {
  const tag = pressure.tier !== "none" ? ` (${pressureTag(pressure)})` : "";
  const last = reason ? `, last decision: ${reason}` : "";
  if (!need) return `Assessment: none yet, θ=${theta.toFixed(2)}${tag}${last}.`;
  const needs = JUDGED_LEVELS.slice(1)
    .map((l) => `need(${l})=${(need[l] ?? 0).toFixed(2)}`)
    .join(" ");
  return `Assessment: ${needs}, θ=${theta.toFixed(2)}${tag}${level ? ` → ${level}` : ""}${last}.`;
}
