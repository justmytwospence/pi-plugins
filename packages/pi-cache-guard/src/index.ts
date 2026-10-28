// pi-cache-guard: asks before a prompt that would re-cache a large conversation, and publishes the
// prompt cache's time left as the `cache-guard` status (pi-status-footer folds it into its context
// row). Keeping the cache warm is Pi's own job: `cacheWarming: "idle"` in settings.json. Its
// refreshes are `cache_warm` usage entries, which this clock reads as cache activity.
//
// With Jev set up (`/cache-guard jev`), it also keeps the context lean (`context.ts`): large tool
// output is trimmed as it arrives, and a cold cache can be compacted in about a second.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import path from "node:path";

import { type CacheView, type LastRequest, type ModelInfo, lastRequest, view } from "./clock.ts";
import { loadSettings, saveUserSettings } from "./config.ts";
import { type Lean, leanContext, trimStatus } from "./context.ts";
import { HerdrReporter, alertHeld, whileBlocked } from "./herdr.ts";
import { JEV_LOGINS, type JevState, label, probe } from "./jev.ts";
import { JEV_KEY_URL, JEV_PITCH } from "./lean.ts";
import { type AssistantLike, NOTICE_TYPE, type Notice, detectMiss, noticeLine } from "./notices.ts";
import { type Wire, cachePolicy, echoedRetention, requestedTtl } from "./policy.ts";
import { MODEL_CHOICE, MODEL_OFFERS, type ModelChoice, type ModelOffer, type ModelOffers, collectOffers, oneLine } from "./offers.ts";
import { Text } from "@earendil-works/pi-tui";
import {
  DEFAULT_SETTINGS,
  NAME,
  type Settings,
  describeMiss,
  formatClock,
  formatDuration,
  formatTokens,
  compactionFocus,
  herdrCacheValue,
  worthWarning,
} from "./core.ts";

// Model choice in the cold-cache question: the events, their payloads and the offer cleaning.
export { MODEL_CHOICE, MODEL_OFFERS, OFFER_TIMEOUT_MS, type ModelChoice, type ModelOffer, type ModelOffers, cleanOffers, collectOffers } from "./offers.ts";

const STATUS_KEY = NAME;
const TICK_MS = 1_000;
const SUBCOMMANDS = ["status", "on", "off", "fresh", "compact", "jev"];
/** The `/cache-guard jev` and `/cache-guard compact` choices. */
const JEV_DONE = "Done";
const JEV_ON = "Turn Jev on";
const JEV_LEAVE_OFF = "Leave it off";
const JEV_OFF = "Turn Jev off";
const JEV_OFF_TIPS = "Turn Jev off (no more tips)";
const JEV_ANY = "Use any provider that works (clear jev.provider)";
const JEV_SETUP = "Set up Jev";
const COMPACT_PI = "Compact with Pi's summary";
/** The guidance choices after "Compact first". */
const SUMMARY_DEFAULT = "Default summary";
const SUMMARY_FOCUS = "Focus the summary on this prompt";
const SUMMARY_WRITE = "Write guidance for the summary...";
type ModelLike = NonNullable<ExtensionContext["model"]>;

/**
 * This model's cache lifetime (`policy.ts`): a guaranteed TTL, a typical one (`likely`), or none
 * known. Undefined when there is no model, or nothing is cached (PI_CACHE_RETENTION=none).
 */
export function modelInfo(
  model: ModelLike | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { oauth?: boolean; wire?: Wire } = {},
): ModelInfo | undefined {
  if (!model) return undefined;
  const policy = cachePolicy(model as Parameters<typeof cachePolicy>[0], env, options.oauth ?? false, options.wire);
  if (policy === null) return undefined;
  const cost = model.cost;
  const price = cost && cost.input > 0
    ? { input: cost.input, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite > 0 ? cost.cacheWrite : cost.input }
    : undefined;
  const info: ModelInfo = { provider: model.provider, id: model.id, price };
  if (policy) {
    info.ttlMs = policy.ttlMs;
    info.source = policy.source;
    if (!policy.guaranteed) info.likely = true;
  }
  return info;
}

/** The status text: time left while warm (`~` when estimated), "cold" once the next request misses. */
export function statusText(v: CacheView | undefined): string | undefined {
  if (!v) return undefined;
  if (v.remainingMs !== undefined) return `cache ${v.likely ? "~" : ""}${formatClock(v.remainingMs)}`;
  if (v.cold?.kind === "model") return "cache cold (model)";
  if (v.cold) return v.cold.kind === "idle" ? "cache cold?" : "cache cold";
  return undefined;
}

/** The event other extensions read the main session's prompt cache from (pi-auto-effort, for one). */
export const CACHE_STATE = "cache:state";

/**
 * `cache:state`'s payload. `cold`: the next request re-writes the cache (expired, probably expired
 * after a long idle, a model switch, or nothing cached yet: a new session or a fresh compaction).
 * `tokens`: the cached context the last request left (absent when nothing is cached). `model`:
 * `provider/id` of the model that cache belongs to (the session's model when nothing is cached).
 */
export interface CacheState {
  cold: boolean;
  tokens?: number;
  model?: string;
}

/** The `cache:state` payload for a view of the cache (undefined: nothing cached) and the session's model. */
export function cacheState(v: CacheView | undefined, model: { provider: string; id: string } | undefined): CacheState {
  if (!v) return { cold: true, ...(model ? { model: `${model.provider}/${model.id}` } : {}) };
  return { cold: v.cold !== undefined, tokens: v.last.tokens, model: `${v.last.provider}/${v.last.model}` };
}

/** What `/cache-guard fresh` hands the new session's runtime. */
interface FreshStart {
  text: string;
  images?: ImageContent[];
  provider?: string;
  modelId?: string;
  thinking?: string;
}
const FRESH_KEY = Symbol.for("pi-cache-guard/fresh");

export type Choice = "keep" | "jev" | "compact" | "fresh" | "send" | "mute" | "model";

/** A line of the cold-cache question; `model` (`provider/id`) on a model offer's line. */
export interface MenuItem {
  choice: Choice;
  label: string;
  model?: string;
}

/** Under the cold-cache question while Jev is not set up (and not turned off). */
export const JEV_TIP = "Tip: /cache-guard jev sets up quick compaction, which compacts in about a second without a summary model reading the history (or turns this tip off).";

/**
 * The widest an option of the cold-cache question may be. Pi's own select wraps a longer option
 * onto the next row with no `│` gutter, and Collie reads no dialog with such a row; at the
 * 46-column phone width the cursor and padding leave 42. Counts and Jev's reason go in the title.
 */
export const OPTION_MAX = 42;

/**
 * The ways through a cold cache. Sending is first, so Enter sends (on Jev's pick, when one is
 * offered); Esc still keeps the prompt in the editor. With Jev there are two compactions: Jev's,
 * written in code, and a summary. Every option fits OPTION_MAX columns; the token counts each way
 * re-sends are in the title (`coldTitle`).
 *
 * Model offers (`cache:model-offers`, cleaned): a recommended one (recommended) goes first, so Enter
 * takes it, and "Send anyway" becomes "Send with <current model>"; every other offer follows the
 * mute line as "Send with <label> instead". Without offers the menu is the plain one.
 */
export function choiceMenu(
  _v: CacheView,
  jev: { ready: boolean; filtered: boolean } = { ready: false, filtered: false },
  models: { current?: string; offers?: readonly ModelOffer[] } = {},
): MenuItem[] {
  const offers = models.offers ?? [];
  const pick = offers.find((offer) => offer.recommended);
  const others = offers.filter((offer) => offer !== pick);
  const fit = (prefix: string, name: string, suffix: string) => `${prefix}${oneLine(name, OPTION_MAX - prefix.length - suffix.length)}${suffix}`;
  const sends: MenuItem[] = pick
    ? [
        { choice: "model", model: pick.model, label: fit("Send with ", pick.label, " (recommended)") },
        { choice: "send", label: models.current ? fit("Send with ", models.current, "") : "Send anyway" },
      ]
    : [{ choice: "send", label: "Send anyway" }];
  const switches: MenuItem[] = others.map((offer) => ({ choice: "model", model: offer.model, label: fit("Send with ", offer.label, " instead") }));
  const compactions: MenuItem[] = jev.ready
    ? [
        { choice: "jev", label: "Compact quickly, then send (~1s)" },
        { choice: "compact", label: "Compact with a summary, then send" },
      ]
    : [{ choice: "compact", label: "Compact first, then send" }];
  return [
    ...sends,
    { choice: "mute", label: "Send, and stop asking in this session" },
    ...switches,
    ...compactions,
    { choice: "fresh", label: "Start a new session with this prompt" },
    { choice: "keep", label: "Keep the prompt in the editor" },
  ];
}

/**
 * The cold-cache question: the miss, what each way costs in tokens (sending re-caches the
 * conversation on any model, a summary reads it once, a new session starts empty), and Jev's
 * reason for its model pick when one is offered.
 */
export function coldTitle(
  v: CacheView,
  jev: { ready: boolean; filtered: boolean; missing?: boolean } = { ready: false, filtered: false },
  pick?: ModelOffer,
): string {
  const tokens = formatTokens(v.last.tokens);
  const summary = `a summary reads ${jev.ready && jev.filtered ? "up to " : ""}${tokens}`;
  const ways = `Sending re-caches ${tokens} tokens on any model; ${summary}${jev.ready ? ", a quick compaction none" : ""}; a new session starts empty.`;
  const why = pick ? `\nRecommended: ${pick.label}${pick.note ? ` (${pick.note})` : ""}.` : "";
  return `Prompt cache miss. ${describeMiss(v.cold!, v.last.tokens, undefined)}\n${ways}${why}${jev.missing ? `\n${JEV_TIP}` : ""}`;
}

export default function cacheGuard(pi: ExtensionAPI, options: { herdr?: HerdrReporter; alert?: (body: string) => void } = {}) {
  // Inside a herdr pane (through pi-herdr): the `cache` token, so herdr's agents sidebar shows this
  // session when doomed.
  const herdr = options.herdr ?? new HerdrReporter(pi.events);
  pi.events?.on("herdr:ready", () => herdr.resend());
  // Jev: trimming tool output, and compaction.
  const lean: Lean = leanContext(pi);
  let ctx: ExtensionContext | undefined;
  let settings: Settings = DEFAULT_SETTINGS;
  // A miss found at message_end, written at turn_end once the message itself is in the session.
  let pendingMiss: Notice | undefined;
  // Keep-warm refreshes already noted (Pi has no event for them; the tick looks for new ones).
  let seenWarm = new Set<string>();

  const notify = (notice: Notice) => {
    if (sessionOn && settings.enabled && ctx?.hasUI) pi.appendEntry<Notice>(NOTICE_TYPE, notice);
  };
  /** `cache_warm` usage entries after the last assistant message, oldest first. */
  const recentWarms = (context: ExtensionContext) => {
    const branch = context.sessionManager.getBranch() as Array<{ id?: string; type?: string; kind?: string; note?: string; usage?: { cost?: { total?: number } }; message?: { role?: string } }>;
    const warms = [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type === "message" && entry.message?.role === "assistant") break;
      if (entry.type === "usage" && entry.kind === "cache_warm" && entry.id) warms.unshift(entry);
    }
    return warms;
  };
  const noteWarms = (context: ExtensionContext) => {
    for (const entry of recentWarms(context)) {
      if (seenWarm.has(entry.id!)) continue;
      seenWarm.add(entry.id!);
      notify({ kind: "warm", cost: entry.usage?.cost?.total ?? 0, note: entry.note });
    }
  };
  let sessionOn = true;
  // "Send, and stop asking": the warning is off for this session, the clock and herdr stay on.
  let askOn = true;
  /** Session and settings switches that allow a cold interactive prompt to ask. */
  const warningOn = () => sessionOn && askOn && settings.enabled && settings.warn.enabled;
  /** The warning's state for `/cache-guard status`, naming what turned it off. */
  const warningLine = () => {
    if (!settings.enabled) return "off (\"enabled\": false in settings)";
    if (!settings.warn.enabled) return "off (\"warn.enabled\": false in settings)";
    if (!sessionOn) return `off for this session (/${NAME} on turns it back on)`;
    if (!askOn) return `muted for this session after "Send, and stop asking" (/${NAME} on turns it back on)`;
    return `on, from ${formatTokens(settings.warn.minTokens)} tokens (warn.minTokens)`;
  };
  // A held prompt the `/cache-guard fresh` command carries into a new session.
  let pending: { text: string; images?: ImageContent[] } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let shown: string | undefined;
  // Request start of the assistant message streaming now; the branch only has it at message_end.
  let live: { at: number; provider: string; model: string } | undefined;

  // What the wire said per `provider/model`: the `ttl` Pi requested, the retention OpenAI applied.
  const wires = new Map<string, Wire>();
  const wireFor = (provider: string, id: string) => {
    const key = `${provider}/${id}`;
    let wire = wires.get(key);
    if (!wire) wires.set(key, (wire = {}));
    return wire;
  };
  pi.on("before_provider_request", (event, context) => {
    const request = requestedTtl(event.payload);
    const model = context.model;
    // Only this session's model: other requests (Jev, for one) go to other models.
    if (request && model && request.model === model.id) wireFor(model.provider, model.id).ttl = request.ttl;
    return undefined;
  });
  pi.on("provider_stream_event", (event) => {
    const retention = echoedRetention(event.data);
    if (retention !== undefined) wireFor(event.provider, event.model).retention = retention;
  });
  const infoFor = (context: ExtensionContext) => {
    const model = context.model;
    if (!model) return undefined;
    let oauth = false;
    try {
      oauth = context.modelRegistry.isUsingOAuth(model);
    } catch {
      // An older Pi or a stub registry: treat it as an API key.
    }
    return modelInfo(model, process.env, { oauth, wire: wires.get(`${model.provider}/${model.id}`) });
  };

  const current = (context: ExtensionContext): CacheView | undefined => {
    const info = infoFor(context);
    if (!info) return undefined;
    let last: LastRequest | undefined = lastRequest(context.sessionManager.getBranch());
    if (live && last && live.provider === last.provider && live.model === last.model && live.at > last.at) {
      last = { ...last, at: live.at, realAt: live.at };
    }
    if (!last) return undefined;
    return view(last, info, Date.now(), settings.warn.idleMinutes * 60_000);
  };

  // The last `cache:state` sent, so ticks only emit changes.
  let sentState: string | undefined;
  /**
   * Emits `cache:state` when the view changed since the last one (or always, with `force`: before a
   * prompt and at agent start, so a listener deciding then has a fresh value). Off with `enabled: false`.
   */
  const emitState = (context: ExtensionContext, view: CacheView | undefined, force: boolean) => {
    if (!settings.enabled) return;
    const state = cacheState(view, context.model);
    const key = JSON.stringify(state);
    if (!force && key === sentState) return;
    sentState = key;
    try {
      pi.events?.emit(CACHE_STATE, state);
    } catch {
      // A listener's failure is not ours.
    }
  };

  const publish = () => {
    if (!ctx) return;
    noteWarms(ctx);
    const full = settings.enabled ? current(ctx) : undefined;
    emitState(ctx, full, false);
    const v = sessionOn ? full : undefined;
    const text = statusText(v);
    if (text !== shown) {
      shown = text;
      ctx.ui.setStatus(STATUS_KEY, text);
    }
    herdr.report(v ? herdrCacheValue(v.cold, v.last.tokens, undefined, settings) : undefined);
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (ctx && shown !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
    shown = undefined;
    void herdr.clear();
    ctx = undefined;
    live = undefined;
    sentState = undefined;
  };

  pi.on("session_start", (event, context) => {
    stop();
    const fresh = event.reason === "new" ? (globalThis as Record<symbol, unknown>)[FRESH_KEY] as FreshStart | undefined : undefined;
    if (fresh) {
      delete (globalThis as Record<symbol, unknown>)[FRESH_KEY];
      void startFresh(pi, context, fresh);
    }
    ctx = context;
    sessionOn = true;
    askOn = true;
    settings = loadSettings(context.cwd);
    pendingMiss = undefined;
    seenWarm = new Set(recentWarms(context).map((entry) => entry.id!));
    emitState(context, current(context), true);
    if (!context.hasUI) return;
    publish();
    timer = setInterval(publish, TICK_MS);
    timer.unref?.();
  });
  pi.on("session_shutdown", () => stop());
  // The context or model changed under the clock: drop the streaming message's start time.
  const refresh = (context: ExtensionContext, keepLive: boolean) => {
    if (!ctx) return;
    ctx = context;
    if (!keepLive) live = undefined;
    publish();
  };
  pi.on("model_select", (_event, context) => refresh(context, false));
  pi.on("session_tree", (_event, context) => refresh(context, false));
  pi.on("session_compact", (event, context) => {
    const usage = (event.compactionEntry as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } }).usage;
    if (ctx && usage) {
      notify({ kind: "compaction", tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, cost: usage.cost.total });
    }
    refresh(context, false);
  });
  pi.on("message_end", (event, context) => {
    const message = event.message as unknown as AssistantLike;
    if (!ctx || message.role !== "assistant" || !message.usage || message.stopReason === "error" || message.stopReason === "aborted") return;
    // The session does not have this message yet, so the branch ends at the request before it.
    pendingMiss = detectMiss(context.sessionManager.getBranch(), message, (provider, id) => context.modelRegistry.find(provider, id)?.cost.cacheRead);
  });
  const flushMiss = () => {
    if (pendingMiss) notify(pendingMiss);
    pendingMiss = undefined;
  };
  pi.on("turn_end", () => flushMiss());
  pi.on("agent_end", () => flushMiss());

  pi.registerEntryRenderer<Notice>(NOTICE_TYPE, (entry, _options, theme) => {
    if (!entry.data) return undefined;
    const { text, color } = noticeLine(entry.data);
    return new Text(theme.fg(color, text), 1, 0);
  });
  pi.on("agent_settled", (_event, context) => refresh(context, true));
  // A fresh `cache:state` as each run starts (the prompt's own is sent from the input handler).
  pi.on("agent_start", (_event, context) => {
    if (ctx) emitState(context, current(context), true);
  });
  pi.on("message_start", (event, context) => {
    const message = event.message as { role?: string; timestamp?: number; provider?: string; model?: string };
    if (message.role !== "assistant" || typeof message.timestamp !== "number") return;
    live = { at: message.timestamp, provider: String(message.provider ?? ""), model: String(message.model ?? "") };
    if (ctx) {
      ctx = context;
      publish();
    }
  });

  /** Emits `cache:model-offers` and waits (bounded) for what listeners pushed. */
  const requestOffers = (text: string, tokens: number, current: string | undefined): Promise<ModelOffer[]> => {
    const payload: ModelOffers = { text, tokens, offers: [] };
    try {
      pi.events?.emit(MODEL_OFFERS, payload);
    } catch {
      // A listener's failure is not ours.
    }
    return collectOffers(Array.isArray(payload.offers) ? payload.offers : [], current);
  };
  const emitChoice = (choice: ModelChoice) => {
    try {
      pi.events?.emit(MODEL_CHOICE, choice);
    } catch {
      // A listener's failure is not ours.
    }
  };

  pi.on("input", async (event, context) => {
    // Before any prompt goes out, listeners get the cache as it stands now.
    if (ctx) emitState(context, current(context), true);
    let alerted = false;
    // Every dialog of the cold-cache flow holds `herdr:blocked`; the first also plays the sound and
    // posts a herdr notification, so a prompt sent just before switching away is not left unnoticed.
    // herdr's own sound cannot do this: it plays only for a state change in a space not in view, and
    // the question opens before you have switched.
    const ask = <T>(run: () => Promise<T>) => whileBlocked(pi.events, "Prompt cache miss", () => {
      if (!alerted) {
        const body = `${path.basename(context.cwd)}: ${oneLine(event.text, 80)}`;
        if (options.alert) options.alert(body);
        else alertHeld(pi.events, settings.warn.sound ?? "", body);
      }
      alerted = true;
      return run();
    });
    if (!sessionOn || !askOn || event.source !== "interactive" || event.streamingBehavior !== undefined || !context.hasUI) {
      return { action: "continue" };
    }
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
    settings = loadSettings(context.cwd);
    if (!warningOn()) return { action: "continue" };
    const v = current(context);
    if (!v?.cold) return { action: "continue" };
    // The warning is framed in tokens: prices (undefined here) would switch core to warn.minCost.
    if (!worthWarning(v.last.tokens, undefined, settings)) return { action: "continue" };
    // Other extensions' model offers, gathered while Jev is looked up (OFFER_TIMEOUT_MS at most).
    const model = context.model;
    const [jev, offers] = await Promise.all([
      lean.jev(context),
      requestOffers(event.text, v.last.tokens, model ? `${model.provider}/${model.id}` : undefined),
    ]);
    const menu = choiceMenu(v, { ready: jev.kind === "ready", filtered: settings.compact.filter }, { current: model?.name || model?.id, offers });
    const title = coldTitle(v, { ready: jev.kind === "ready", filtered: settings.compact.filter, missing: jev.kind === "missing" }, offers.find((offer) => offer.recommended));
    const picked = await ask(() => context.ui.select(title, menu.map((item) => item.label)));
    const item = menu.find((entry) => entry.label === picked);
    const choice = item?.choice ?? "keep";
    // Whoever offered the model applies it (pi-auto-effort, at before_agent_start); every other
    // answer is null, so a listener can drop what it held for this prompt.
    emitChoice({ text: event.text, model: choice === "model" ? item?.model ?? null : null });
    const keep = () => {
      context.ui.setEditorText(event.text);
      return { action: "handled" as const };
    };
    const content: string | (TextContent | ImageContent)[] = event.images?.length
      ? [{ type: "text", text: event.text }, ...event.images]
      : event.text;
    switch (choice) {
      case "send":
      case "model":
        return { action: "continue" };
      case "mute":
        askOn = false;
        return { action: "continue" };
      case "fresh":
        // Replacing the session is a command's job: run ours once this input has been handled.
        pending = { text: event.text, images: event.images };
        setTimeout(() => void pi.sendUserMessage(`/${NAME} fresh`, { expandPromptTemplates: true }), 0);
        return { action: "handled" };
      case "jev":
        // Jev judges the history against the held prompt and writes the summary in code. Strict: if
        // Jev fails nothing is compacted (no surprise LLM summary), and the prompt goes back.
        lean.armJevCompaction({ goal: event.text, strict: true });
        context.ui.notify("Compacting quickly, then sending your prompt.", "info");
        context.compact({
          onComplete: () => void pi.sendUserMessage(content),
          onError: (error) => {
            lean.disarm();
            context.ui.notify(`Quick compaction did not run: ${lean.lastFailure() ?? error.message}. Your prompt is back in the editor.`, "warning");
            context.ui.setEditorText(event.text);
          },
        });
        return { action: "handled" };
      case "compact": {
        lean.disarm();
        const how = await ask(() => context.ui.select("Compact first: what should the summary keep?", [SUMMARY_DEFAULT, SUMMARY_FOCUS, SUMMARY_WRITE]));
        let guidance: string | undefined;
        if (how === SUMMARY_FOCUS) guidance = compactionFocus(event.text);
        else if (how === SUMMARY_WRITE) {
          guidance = await ask(() => context.ui.input("Guidance for the summary", "what to keep or stress"));
          if (guidance === undefined) return keep();
        } else if (how !== SUMMARY_DEFAULT) return keep();
        context.ui.notify("Compacting, then sending your prompt.", "info");
        context.compact({
          customInstructions: guidance?.trim() || undefined,
          onComplete: () => void pi.sendUserMessage(content),
          onError: (error) => {
            context.ui.notify(`Compaction failed (${error.message}); your prompt is back in the editor.`, "warning");
            context.ui.setEditorText(event.text);
          },
        });
        return { action: "handled" };
      }
      default:
        return keep();
    }
  });

  /** `/cache-guard jev`: which Jev is in use and whether it answers; or how to set it up. */
  const jevCommand = async (context: ExtensionContext) => {
    const save = (patch: Record<string, unknown>) => {
      try {
        saveUserSettings({ jev: patch });
        return true;
      } catch (error) {
        context.ui.notify(`Could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
        return false;
      }
    };
    const current = loadSettings(context.cwd);
    if (!current.enabled) {
      context.ui.notify("cache-guard is off in its settings (\"enabled\": false), Jev included.", "info");
      return;
    }
    if (!current.jev.enabled) {
      const pick = await context.ui.select(`Jev is off: no trimming, no Jev compaction, no tips.\n${JEV_PITCH}`, [JEV_ON, JEV_LEAVE_OFF]);
      if (pick !== JEV_ON || !save({ enabled: true })) return;
    }
    const state = await lean.refresh(context);
    if (state.kind === "ready") {
      const answer = await probe(context.modelRegistry, state.target);
      const head = answer.ok
        ? `Jev: ${label(state.target)}, answered in ${answer.latencyMs} ms.`
        : `Jev: ${label(state.target)} did not answer (${answer.reason}).`;
      const others = state.others.map((target) => ({ target, text: `Use ${label(target)} instead` }));
      const pick = await context.ui.select(
        `${head} It trims large tool output and compacts in about a second: the cold-cache menu, /cache-guard compact.`,
        [JEV_DONE, ...others.map((o) => o.text), JEV_OFF],
      );
      const other = others.find((o) => o.text === pick);
      if (other && save({ provider: other.target.provider, model: other.target.model })) {
        await lean.refresh(context);
        context.ui.notify(`Jev: ${label(other.target)} from now on.`, "info");
      } else if (pick === JEV_OFF && save({ enabled: false })) {
        await lean.refresh(context);
        context.ui.notify("Jev is off: no trimming, no Jev compaction, no tips. /cache-guard jev turns it back on.", "info");
      }
      return;
    }
    if (state.kind === "off") return;
    const logins = JEV_LOGINS.map((login) => ({ ...login, text: `Log in to ${login.label}` }));
    const options = [...logins.map((l) => l.text), ...(current.jev.provider ? [JEV_ANY] : []), JEV_OFF_TIPS];
    const pick = await context.ui.select(
      `Jev is not set up: ${state.reason}.\n${JEV_PITCH}\nIt needs a TypeSafe API key (${JEV_KEY_URL}; or TYPESAFE_API_KEY in the environment), or a provider that serves Jev: OpenRouter, Vercel AI Gateway, Cloudflare Workers AI, OpenCode.`,
      options,
    );
    const login = logins.find((l) => l.text === pick);
    if (login) {
      context.ui.setEditorText(`/login ${login.provider}`);
      context.ui.notify(`Press Enter to log in to ${login.provider}, then run /cache-guard jev to check.`, "info");
    } else if (pick === JEV_ANY && save({ provider: "", model: "" })) {
      await jevCommand(context);
    } else if (pick === JEV_OFF_TIPS && save({ enabled: false })) {
      await lean.refresh(context);
      context.ui.notify("Jev is off: no trimming, no Jev compaction, no tips. /cache-guard jev turns it back on.", "info");
    }
  };

  /** Jev's compaction, judged against `focus` (or the recent requests). Strict: nothing is spent if Jev fails. */
  const runJevCompaction = (focus: string, context: ExtensionContext, onFailed?: () => void) => {
    lean.armJevCompaction({ strict: true, goal: focus || undefined });
    const started = Date.now();
    context.compact({
      customInstructions: focus || undefined,
      onComplete: () => context.ui.notify(`Compacted quickly in ${((Date.now() - started) / 1000).toFixed(1)} s.`, "info"),
      onError: (error) => {
        lean.disarm();
        onFailed?.();
        context.ui.notify(`Quick compaction did not run: ${lean.lastFailure() ?? error.message}.`, "warning");
      },
    });
  };

  /** `/cache-guard compact [focus]`: Jev's compaction, written in code; nothing is spent if Jev fails. */
  const compactCommand = async (focus: string, context: ExtensionContext) => {
    const jev = await lean.jev(context);
    if (jev.kind !== "ready") {
      const why = jev.kind === "off" ? "Jev is off" : `Jev is not set up (${jev.reason})`;
      const pick = await context.ui.select(`${why}. Compact with Pi's summary instead?`, [COMPACT_PI, JEV_SETUP]);
      if (pick === JEV_SETUP) await jevCommand(context);
      else if (pick === COMPACT_PI) {
        context.compact({
          customInstructions: focus || undefined,
          onError: (error) => context.ui.notify(`Compaction failed: ${error.message}`, "warning"),
        });
      }
      return;
    }
    runJevCompaction(focus, context);
  };

  pi.registerCommand(NAME, {
    description: "Prompt cache and context: status, on, off, fresh, compact [focus], jev",
    getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, context) => {
      const command = args.trim().split(/\s+/u)[0] || "status";
      const rest = args.trim().slice(command.length).trim();
      if (!SUBCOMMANDS.includes(command)) {
        context.ui.notify(`/${NAME}: unknown subcommand "${command}". Use one of: ${SUBCOMMANDS.join(", ")}.`, "warning");
        return;
      }
      if (command !== "compact" && rest) {
        context.ui.notify(`/${NAME} ${command} takes no argument (got "${rest}").`, "warning");
        return;
      }
      if (command === "jev") return jevCommand(context);
      if (command === "compact") return compactCommand(rest, context);
      if (command === "fresh") {
        // A new session (linked to this one) that starts with the held prompt, or the editor's text.
        const carry = pending ?? (context.ui.getEditorText().trim() ? { text: context.ui.getEditorText() } : undefined);
        pending = undefined;
        if (!carry) {
          context.ui.notify("/cache-guard fresh starts a new session with the prompt in the editor; the editor is empty.", "info");
          return;
        }
        // The new session gets a fresh extension runtime: hand it the prompt, model and thinking
        // level through a process-wide slot that its session_start picks up.
        (globalThis as Record<symbol, unknown>)[FRESH_KEY] = {
          ...carry,
          provider: context.model?.provider,
          modelId: context.model?.id,
          thinking: pi.getThinkingLevel(),
        } satisfies FreshStart;
        const result = await context.newSession({ parentSession: context.sessionManager.getSessionFile() });
        if (result.cancelled) {
          delete (globalThis as Record<symbol, unknown>)[FRESH_KEY];
          context.ui.setEditorText(carry.text);
        }
        return;
      }
      if (command === "on" || command === "off") {
        sessionOn = command === "on";
        askOn = sessionOn;
        ctx = context;
        publish();
        context.ui.notify(`cache-guard ${command} for this session`, "info");
        return;
      }
      settings = loadSettings(context.cwd);
      const v = current(context);
      const lines: string[] = [];
      if (!v) {
        lines.push("No cached request on this branch yet (or the context was just compacted).");
      } else {
        const info = infoFor(context);
        lines.push(`Last request: ${v.last.provider}/${v.last.model}, ${formatTokens(v.last.tokens)} tokens, ${formatDuration(Date.now() - v.last.realAt)} ago` +
          (v.last.at > v.last.realAt ? `; refreshed by cache warming ${formatDuration(Date.now() - v.last.at)} ago.` : "."));
        lines.push(info?.ttlMs === undefined
          ? `TTL: not published for ${info?.provider}/${info?.id}; warning after ${settings.warn.idleMinutes}m idle.`
          : info.likely
            ? `TTL: about ${formatDuration(info.ttlMs)} (${info.source}); warning after that, as a likelihood.`
            : `TTL: ${formatDuration(info.ttlMs)} minimum (${info.source}).`);
        if (v.remainingMs !== undefined) lines.push(`Warm: ${v.likely ? "about " : ""}${formatClock(v.remainingMs)} left.`);
        if (v.cold) {
          lines.push(describeMiss(v.cold, v.last.tokens, undefined));
          if (!warningOn()) {
            const reason = sessionOn && settings.enabled && settings.warn.enabled ? "muted for this session" : "off";
            lines.push(`The next prompt is sent without asking: the warning is ${reason}.`);
          } else if (!worthWarning(v.last.tokens, undefined, settings)) {
            lines.push("Below the warning threshold.");
          } else {
            lines.push(context.hasUI ? "The next prompt asks before sending." : "The next prompt is sent without asking: no UI is available.");
          }
        }
      }
      lines.push(`Warning: ${warningLine()}. Keep-warm: Pi's cacheWarming setting (/session shows its next decision).`);
      lines.push(jevLine(await lean.jev(context), settings, lean.savedChars()));
      context.ui.notify(lines.join("\n"), "info");
    },
  });
}

/** The Jev line of `/cache-guard status`. */
export function jevLine(jev: JevState, settings: Settings, savedChars: number): string {
  if (jev.kind === "off") return "Jev: off (/cache-guard jev turns it on).";
  if (jev.kind === "missing") return `Jev: not set up (${jev.reason}); /cache-guard jev.`;
  const trim = settings.trim.enabled ? `trimming on${savedChars ? ` (${trimStatus(savedChars)?.replace("lean: ", "")} so far)` : ""}` : "trimming off";
  const compaction = `Quick compaction from the cold-cache menu and /cache-guard compact${settings.compact.filter ? "; it filters /compact too" : ""}`;
  return `Jev: ${label(jev.target)}; ${trim}; ${compaction}.`;
}

/** In the new session: the old session's model and thinking level, then the held prompt. */
async function startFresh(pi: ExtensionAPI, context: ExtensionContext, fresh: FreshStart): Promise<void> {
  const model = fresh.provider && fresh.modelId ? context.modelRegistry.find(fresh.provider, fresh.modelId) : undefined;
  if (model && (context.model?.provider !== model.provider || context.model?.id !== model.id)) await pi.setModel(model);
  if (fresh.thinking) pi.setThinkingLevel(fresh.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
  setTimeout(() => void pi.sendUserMessage(fresh.images?.length ? [{ type: "text", text: fresh.text }, ...fresh.images] : fresh.text), 0);
}
