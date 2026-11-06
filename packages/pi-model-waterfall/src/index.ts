import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { createProviderUsageCollector, readPiAnthropicUsage, type ProviderUsage, type UsageSource } from "@justmytwospence/pi-subscription-usage";
import { chooseWaterfall, evaluateAllowance, forPhysicalModel, stickyPhysicalModel, WATERFALL_MODELS, waterfallUnavailable,
  type RouteState, type WaterfallCandidate } from "./decision.ts";
import { WATERFALL_CHANNEL, type WaterfallRequest, type WaterfallRung, type WaterfallSnapshot } from "./waterfall-contract.ts";

const OPENAI_REASON = "Codex quota applicability to modern Sol has not been verified.";
const MUSE_REASON = "Muse historical image and tool-result handoff is lossy and has not been accepted.";
const cancelled = () => new Error("Waterfall quota check cancelled.");
/** Rung state is display-only; reassess at most this often outside a route. */
const ASSESS_MS = 60_000;
const DISABLED = new Set([OPENAI_REASON, MUSE_REASON]);

/** Classify one checked rung for display: why it would or would not be chosen now. */
export function rungState(candidate: WaterfallCandidate, now: number): WaterfallRung {
  const { provider, model } = candidate;
  if (!candidate.verified) {
    const reason = candidate.reason ?? "Subscription routing is not verified.";
    return { provider, model, state: DISABLED.has(reason) ? "disabled" : "unknown", reason };
  }
  const reason = evaluateAllowance(candidate.reading, now);
  if (!reason) return { provider, model, state: "available" };
  const spent = candidate.reading?.windows.filter(w => typeof w.used === "number" && w.used >= 95 && w.reset !== undefined) ?? [];
  if (!spent.length) return { provider, model, state: "unknown", reason };
  return { provider, model, state: "exhausted", reason, resetAt: Math.max(...spent.map(w => w.reset!)) };
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
  let generation = 0;
  // Rung state survives route-snapshot clears: it describes the subscriptions, not a branch.
  let rungs: { list: WaterfallRung[]; at: number } | undefined;
  let session = 0, assessing = false, assessedAt = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const clear = () => { generation++; snapshot = { version: 1, skipped: [], observedAt: Date.now() }; };
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
  pi.on("session_start", (_event, ctx) => {
    clear(); session++; rungs = undefined; assessedAt = 0; collector.dispose(); collector = createProviderUsageCollector();
    stopTicker();
    if (!ctx) return;
    void assess(ctx, true);
    // Allowances reset while a session sits idle; quota reads are cached for minutes.
    ticker = setInterval(() => void assess(ctx), 5 * ASSESS_MS);
    ticker.unref?.();
  });
  pi.on("session_tree", clear);
  pi.on("model_select", clear);
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
    if (provider === "openai") return fail(OPENAI_REASON);
    if (provider === "muse-sdk") return fail(MUSE_REASON);
    const endpoint = provider === "anthropic" ? "https://api.anthropic.com" : "https://cloudcode-pa.googleapis.com";
    if (model.baseUrl !== endpoint) return fail("The physical model has an unverified subscription endpoint.");
    try {
      if (!ctx.modelRegistry.isUsingOAuth(model)) return fail("A local subscription OAuth login is required; API keys are not eligible.");
      const physicalLevel = clampThinkingLevel(model, level) as ThinkingLevel;
      const variant = provider === "google" ? argonVariant(model, physicalLevel) : undefined;
      if (provider === "google" && !variant) return fail("The physical Argon reasoning variant cannot be verified.");
      let reading: ProviderUsage;
      let googleToken: string | undefined;
      if (provider === "anthropic") {
        reading = await interruptible(readPiAnthropicUsage(ctx, { signal }), signal);
        if (reading.state !== "ready") return fail("Pi Anthropic OAuth account allowance is unavailable.");
        // Weekly limits scoped to another model (named by its display name, such as
        // "Fable") do not bind Opus. The all-models weekly window must be known; a 5h
        // window binds whenever the plan reports one, and is absent when it has none.
        const windows = reading.windows.filter(w => w.label === "5h" || w.label === "week" || /opus/i.test(w.label));
        if (!windows.some(w => w.label === "week")) return fail("Required Anthropic weekly allowance is unknown.");
        reading = { ...reading, windows };
      } else {
        googleToken = await interruptible(ctx.modelRegistry.getApiKeyForProvider("google"), signal);
        if (!googleToken) return fail("A local Antigravity OAuth credential is unavailable.");
        const source: UsageSource = { provider, sourceId: id, model: id, variant,
          baseUrl: model.baseUrl, auth: { kind: "local-oauth", token: googleToken } };
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
      if (!current || current.api === "pi-virtual" || current.api !== model.api || current.baseUrl !== endpoint ||
          !ctx.modelRegistry.isUsingOAuth(current) || clampThinkingLevel(current, level) !== physicalLevel ||
          (provider === "google" && (argonVariant(current, physicalLevel) !== variant ||
            await interruptible(ctx.modelRegistry.getApiKeyForProvider("google"), signal) !== googleToken)))
        return fail("The subscription account or physical model changed during the quota read.");
      if (signal?.aborted) throw cancelled();
      return { provider, model: id, verified: true, thinkingLevel: physicalLevel, quotaVariant: variant, reading: forPhysicalModel(reading, id) };
    } catch {
      if (signal?.aborted) throw cancelled();
      return fail("Subscription credential or quota read failed.");
    }
  };

  pi.registerVirtualModel({
    provider: "waterfall", id: "auto", name: "Subscription waterfall (Anthropic → OpenAI → Google → Muse)",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    async route(request, ctx) {
      const epoch = generation;
      const sticky = stickyPhysicalModel(request.reason, request.previous, request.failed, request.messages, request.state);
      const level = sticky?.thinkingLevel ?? request.thinkingLevel;
      const candidates: WaterfallCandidate[] = [];
      for (const physical of WATERFALL_MODELS) {
        if (request.signal?.aborted) throw cancelled();
        if (sticky && (sticky.provider !== physical.provider || sticky.id !== physical.id)) continue;
        candidates.push(await candidate(ctx, physical, level, request.signal));
        if (generation !== epoch || request.signal?.aborted) throw cancelled();
        if (chooseWaterfall(candidates, Date.now()).chosen) break;
      }
      const decision = chooseWaterfall(candidates, Date.now());
      if (request.signal?.aborted) throw cancelled();
      if (!decision.chosen) {
        if (request.reason !== "direct") snapshot = { version: 1, skipped: decision.skipped.map(x => ({ ...x })), observedAt: Date.now() };
        throw waterfallUnavailable(decision);
      }
      let selected;
      try { selected = ctx.modelRegistry.find(decision.chosen.provider, decision.chosen.model); }
      catch { /* A changed registry is not proof of subscription eligibility. */ }
      let eligible = false;
      try { eligible = !!selected && selected.api !== "pi-virtual" && ctx.modelRegistry.isUsingOAuth(selected); }
      catch { /* Never expose registry/credential diagnostics. */ }
      const expectedEndpoint = selected?.provider === "anthropic" ? "https://api.anthropic.com" : "https://cloudcode-pa.googleapis.com";
      const effectiveLevel = decision.chosen.thinkingLevel;
      if (!selected || !eligible || selected.baseUrl !== expectedEndpoint || !effectiveLevel ||
          clampThinkingLevel(selected, level) !== effectiveLevel || generation !== epoch || request.signal?.aborted) {
        if (request.reason !== "direct" && generation === epoch)
          snapshot = { version: 1, skipped: decision.skipped.map(x => ({ ...x })), observedAt: Date.now() };
        throw new Error("Waterfall's verified physical subscription model is no longer available.");
      }
      const physical: RouteState["physical"] = { provider: decision.chosen.provider, id: decision.chosen.model, thinkingLevel: effectiveLevel };
      if (request.reason !== "direct") snapshot = { version: 1, physical: { ...physical, ...(decision.chosen.quotaVariant ? { quotaVariant: decision.chosen.quotaVariant } : {}) }, skipped: decision.skipped.map(x => ({ ...x })), observedAt: Date.now() };
      return { model: selected, thinkingLevel: effectiveLevel, state: { version: 1, physical } satisfies RouteState };
    },
  });
  pi.registerCommand("waterfall", {
    description: "Inspect the last subscription route without fetching quota or sending a model request",
    handler: async (_args, ctx) => {
      const route = snapshot.physical ? `${snapshot.physical.provider}/${snapshot.physical.id}` : "not routed in this session";
      const skipped = snapshot.skipped.length ? snapshot.skipped.map(x => `${x.provider}: ${x.reason}`).join("; ") : "Quota eligibility has not been checked.";
      ctx.ui.notify(`Waterfall: ${route}. ${skipped} Manual /model selection remains available.`, "info");
    },
  });
}
