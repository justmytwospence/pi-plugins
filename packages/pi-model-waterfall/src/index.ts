import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { createProviderUsageCollector, MUSE_NO_USAGE_REASON, readCodexUsage, readPiAnthropicUsage, type ProviderUsage, type UsageSource } from "@justmytwospence/pi-subscription-usage";
import { chooseWaterfall, evaluateAllowance, forPhysicalModel, WATERFALL_MODELS, type WaterfallCandidate } from "./decision.ts";
import { WATERFALL_CHANNEL, type WaterfallRequest, type WaterfallRung, type WaterfallSnapshot } from "./waterfall-contract.ts";

const cancelled = () => new Error("Waterfall quota check cancelled.");
/** Rung state is display-only; reassess at most this often outside a route. */
const ASSESS_MS = 60_000;
const DISABLED = new Set<string>();

/** Classify one checked rung for display: why it would or would not be chosen now. */
export function rungState(candidate: WaterfallCandidate, now: number): WaterfallRung {
  const { provider, model } = candidate;
  if (!candidate.verified) {
    const reason = candidate.reason ?? "Subscription routing is not verified.";
    return { provider, model, state: DISABLED.has(reason) ? "disabled" : "unknown", reason };
  }
  if (candidate.noUsage) return { provider, model, state: "available" };
  const reason = evaluateAllowance(candidate.reading, now);
  if (!reason) return { provider, model, state: "available" };
  const spent = candidate.reading?.windows.filter(w => typeof w.used === "number" && w.used >= 95 && w.reset !== undefined) ?? [];
  if (!spent.length) return { provider, model, state: "unknown", reason };
  return { provider, model, state: "exhausted", reason, resetAt: Math.max(...spent.map(w => w.reset!)) };
}

/** An argument that names the model, provider or both: an explicit choice the waterfall must not override. */
export function explicitModelArg(argv: readonly string[]): boolean {
  return argv.some(arg => arg === "--model" || arg === "-m" || arg === "--provider" || arg.startsWith("--model=") || arg.startsWith("--provider="));
}

/** An Argon quota variant must match the physical model's mapped reasoning level. */
function argonVariant(model: Model<any>, level: ThinkingLevel): string | undefined {
  if (!model.reasoning) return undefined;
  const mapped = model.thinkingLevelMap?.[level];
  const effective = mapped === undefined ? level : mapped;
  if (effective === null) return undefined;
  if (["off", "minimal", "low"].includes(effective)) return "gemini-4-argon-low";
  if (effective === "medium") return "gemini-4-argon-medium";
  if (["high", "xhigh", "max"].includes(effective)) return "gemini-4-argon-high";
  return undefined;
}

/** Cancellation also works when a registry or collector implementation ignores AbortSignal. */
async function interruptible<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw cancelled();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export default function modelWaterfall(pi: ExtensionAPI): void {
  let collector = createProviderUsageCollector();
  let snapshot: WaterfallSnapshot = { version: 1, skipped: [], observedAt: Date.now() };
  // Rung state survives route-snapshot clears: it describes the subscriptions, not a branch.
  let rungs: { list: WaterfallRung[]; at: number } | undefined;
  let session = 0, assessing = false, assessedAt = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const clear = () => { snapshot = { version: 1, skipped: [], observedAt: Date.now() }; };
  const assess = async (ctx: ExtensionContext | undefined, force = false) => {
    if (!ctx?.modelRegistry || assessing || (!force && Date.now() - assessedAt < ASSESS_MS)) return;
    const mine = session;
    assessing = true; assessedAt = Date.now();
    try {
      const level = (pi.getThinkingLevel?.() ?? "medium") as ThinkingLevel;
      const list: WaterfallRung[] = [];
      for (const physical of WATERFALL_MODELS) {
        const checked = await candidate(ctx, physical, level).catch((): WaterfallCandidate =>
          ({ provider: physical.provider, model: physical.id, verified: false, reason: "Subscription quota read failed." }));
        list.push(rungState(checked, Date.now()));
      }
      if (mine === session) rungs = { list, at: Date.now() };
    } finally { assessing = false; }
  };
  const stopTicker = () => { if (ticker) clearInterval(ticker); ticker = undefined; };
  pi.on("session_start", (event: { reason?: string } | undefined, ctx) => {
    clear(); session++; rungs = undefined; assessedAt = 0; collector.dispose(); collector = createProviderUsageCollector();
    stopTicker();
    if (!ctx) return;
    void assess(ctx, true);
    if (ctx.hasUI && (event?.reason === "startup" || event?.reason === "new") && !explicitModelArg(process.argv)) void pickStartModel(ctx, session);
    // Allowances reset while a session sits idle; quota reads are cached for minutes.
    ticker = setInterval(() => void assess(ctx), 5 * ASSESS_MS);
    ticker.unref?.();
  });
  pi.on("agent_settled", (_event, ctx) => { void assess(ctx); });
  pi.on("session_shutdown", () => { clear(); session++; rungs = undefined; stopTicker(); collector.dispose(); });
  pi.events.on(WATERFALL_CHANNEL, (value: unknown) => {
    const request = value as WaterfallRequest;
    if (request?.kind !== "query") return;
    const order = WATERFALL_MODELS.map(({ provider, id }) => ({ provider, model: id }));
    request.snapshot = structuredClone(rungs ? { ...snapshot, order, rungs: rungs.list, rungsObservedAt: rungs.at } : { ...snapshot, order });
  });

  const candidate = async (ctx: ExtensionContext, physical: typeof WATERFALL_MODELS[number], level: ThinkingLevel, signal?: AbortSignal): Promise<WaterfallCandidate> => {
    const { provider, id } = physical;
    const fail = (reason: string): WaterfallCandidate => ({ provider, model: id, verified: false, reason });
    if (signal?.aborted) throw cancelled();
    let model;
    try { model = ctx.modelRegistry.find(provider, id); }
    catch { return fail("Physical subscription model is unavailable."); }
    if (!model || model.api === "pi-virtual") return fail("Physical subscription model is unavailable.");
    const endpoint = provider === "anthropic" ? "https://api.anthropic.com" : provider === "google" ? "https://cloudcode-pa.googleapis.com" : undefined;
    if (endpoint && model.baseUrl !== endpoint) return fail("The physical model has an unverified subscription endpoint.");
    try {
      if (provider !== "muse-code" && !ctx.modelRegistry.isUsingOAuth(model)) return fail("A local subscription OAuth login is required; API keys are not eligible.");
      const physicalLevel = clampThinkingLevel(model, level) as ThinkingLevel;
      const variant = provider === "google" ? argonVariant(model, physicalLevel) : undefined;
      if (provider === "google" && !variant) return fail("The physical Argon reasoning variant cannot be verified.");
      let reading: ProviderUsage;
      let credential: string | undefined;
      if (provider === "anthropic") {
        reading = await interruptible(readPiAnthropicUsage(ctx, { signal }), signal);
        if (reading.state !== "ready") return fail("Pi Anthropic OAuth account allowance is unavailable.");
        // Weekly limits scoped to another model (named by its display name, such as
        // "Fable") do not bind Opus. The all-models weekly window must be known; a 5h
        // window binds whenever the plan reports one, and is absent when it has none.
        const windows = reading.windows.filter(w => w.label === "5h" || w.label === "week" || /opus/i.test(w.label));
        if (!windows.some(w => w.label === "week")) return fail("Required Anthropic weekly allowance is unknown.");
        reading = { ...reading, windows };
      } else if (provider === "openai") {
        // The Codex account's windows and access state gate the ChatGPT subscription.
        reading = await interruptible(readCodexUsage(ctx, { signal }), signal);
        if (reading.state !== "ready") return fail("Codex account allowance is unavailable.");
      } else if (provider === "muse-code") {
        credential = await interruptible(ctx.modelRegistry.getApiKeyForProvider("muse-code"), signal);
        if (credential !== "muse-code-local") return fail("pi-muse-bridge's signed-in Muse CLI is required.");
        const source: UsageSource = { provider, sourceId: id, model: id, baseUrl: model.baseUrl, auth: { kind: "local-oauth", token: credential } };
        reading = await interruptible(collector.refresh(source), signal);
        if (reading.state !== "ready") {
          if (reading.reason !== MUSE_NO_USAGE_REASON) return fail("Muse subscription allowance is unavailable.");
          // Nothing used yet in this window: there is no window to exhaust.
          return { provider, model: id, verified: true, thinkingLevel: physicalLevel, noUsage: true,
            reading: { ...reading, state: "ready", observedAt: Date.now(), windows: [] } };
        }
      } else {
        credential = await interruptible(ctx.modelRegistry.getApiKeyForProvider("google"), signal);
        if (!credential) return fail("A local Antigravity OAuth credential is unavailable.");
        const source: UsageSource = { provider, sourceId: id, model: id, variant,
          baseUrl: model.baseUrl, auth: { kind: "local-oauth", token: credential } };
        reading = await interruptible(collector.refresh(source), signal);
        if (reading.state !== "ready") return fail("Exact Antigravity subscription quota is unavailable.");
        // Shared 5h, weekly, Argon weekly and the exact reasoning variant all bind.
        const windows = forPhysicalModel(reading, id).windows;
        if (!["5h", "weekly", "Argon weekly", "model"].every(label => windows.some(w => w.label === label && w.pool === "Gemini")) ||
            !windows.some(w => w.label === "Argon weekly" && w.model === id) ||
            !windows.some(w => w.label === "model" && w.model === id))
          return fail("An applicable shared, Argon weekly or exact reasoning-variant quota is unknown.");
        reading = { ...reading, windows };
      }
      if (signal?.aborted) throw cancelled();
      // A credential/model can change while the read is pending. Neither the
      // previous account's observation nor a newly mapped variant is eligible.
      const current = ctx.modelRegistry.find(provider, id);
      if (!current || current.api === "pi-virtual" || current.api !== model.api || (endpoint && current.baseUrl !== endpoint) ||
          (provider !== "muse-code" && !ctx.modelRegistry.isUsingOAuth(current)) || clampThinkingLevel(current, level) !== physicalLevel ||
          (provider === "google" && (argonVariant(current, physicalLevel) !== variant ||
            await interruptible(ctx.modelRegistry.getApiKeyForProvider("google"), signal) !== credential)) ||
          (provider === "muse-code" && await interruptible(ctx.modelRegistry.getApiKeyForProvider("muse-code"), signal) !== credential))
        return fail("The subscription account or physical model changed during the quota read.");
      if (signal?.aborted) throw cancelled();
      return { provider, model: id, verified: true, thinkingLevel: physicalLevel, quotaVariant: variant, reading: forPhysicalModel(reading, id) };
    } catch {
      if (signal?.aborted) throw cancelled();
      return fail("Subscription credential or quota read failed.");
    }
  };

  /** Switch a new interactive session to the first rung under its quota. Never throws. */
  const pickStartModel = async (ctx: ExtensionContext, mine: number) => {
    try {
      const was = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const level = (pi.getThinkingLevel?.() ?? "medium") as ThinkingLevel;
      const candidates: WaterfallCandidate[] = [];
      for (const physical of WATERFALL_MODELS) {
        candidates.push(await candidate(ctx, physical, level));
        if (mine !== session) return;
        if (chooseWaterfall(candidates, Date.now()).chosen) break;
      }
      if (mine !== session) return;
      const decision = chooseWaterfall(candidates, Date.now());
      const skipped = decision.skipped.map(x => ({ ...x }));
      const reasons = skipped.map(x => `${x.provider}: ${x.reason}`).join("; ");
      // The user picked a model, or sent a turn, while quota was being read.
      if ((ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined) !== was || ctx.isIdle?.() === false) return;
      if (!decision.chosen) {
        snapshot = { version: 1, skipped, observedAt: Date.now() };
        ctx.ui.notify(`Waterfall: no subscription under quota; staying on ${was ?? "the current model"}. ${reasons}`, "warning");
        return;
      }
      const { provider, model: id, thinkingLevel, quotaVariant } = decision.chosen;
      const physical = { provider, id, thinkingLevel: thinkingLevel as string, ...(quotaVariant ? { quotaVariant } : {}) };
      if (was === `${provider}/${id}`) { snapshot = { version: 1, physical, skipped, observedAt: Date.now() }; return; }
      const target = ctx.modelRegistry.find(provider, id);
      if (!target || !(await pi.setModel(target))) {
        ctx.ui.notify(`Waterfall: could not switch to ${provider}/${id}.`, "warning");
        return;
      }
      if (mine !== session) return;
      snapshot = { version: 1, physical, skipped, observedAt: Date.now() };
      ctx.ui.notify(`Waterfall: started on ${provider}/${id}${reasons ? ` (skipped ${reasons})` : ""}.`, "info");
    } catch {
      try { ctx.ui.notify("Waterfall: startup model check failed.", "warning"); } catch { /* UI gone. */ }
    }
  };

  pi.registerCommand("waterfall", {
    description: "Show the model this session started on and each subscription rung's state, without fetching quota",
    handler: async (_args, ctx) => {
      const route = snapshot.physical ? `started on ${snapshot.physical.provider}/${snapshot.physical.id}` : "no startup choice in this session";
      const skipped = snapshot.skipped.length ? snapshot.skipped.map(x => `${x.provider}: ${x.reason}`).join("; ") : "";
      const lines = (rungs?.list ?? []).map(r => `${r.provider}/${r.model}: ${r.state}${r.reason ? ` (${r.reason})` : ""}`);
      ctx.ui.notify([`Waterfall: ${route}.${skipped ? ` ${skipped}` : ""}`, ...lines].join("\n"), "info");
    },
  });
}
