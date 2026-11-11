import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isUsageStale, selectGooglePool, type ProviderUsage, type UsageWindow } from "@justmytwospence/pi-subscription-usage";

/** Physical model IDs only: a virtual model must never route to another virtual model. */
export const SUPPORTED_WATERFALL_MODELS = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "openai", id: "gpt-6.1-sol" },
  { provider: "google", id: "antigravity-gemini-4-argon" },
  { provider: "muse-code", id: "muse-wonder-1.0" },
] as const;

export type WaterfallProvider = typeof SUPPORTED_WATERFALL_MODELS[number]["provider"];
export const DEFAULT_WATERFALL_ORDER = ["anthropic", "openai", "google"] as const satisfies readonly WaterfallProvider[];
/** Resolve a validated configured active order against the supported physical catalog. */
export function waterfallModels(order: readonly WaterfallProvider[]) {
  return order.map(provider => SUPPORTED_WATERFALL_MODELS.find(model => model.provider === provider)!);
}
export type WaterfallCandidate = {
  provider: WaterfallProvider;
  model: string;
  reading?: ProviderUsage;
  /** A verified subscription transport, credential, account and model entitlement. */
  verified: boolean;
  /** Physical level after Pi's model-specific clamp, never the virtual level. */
  thinkingLevel?: ThinkingLevel;
  quotaVariant?: string;
  reason?: string;
  /** Muse has not been used in this window: no windows exist yet, and none can be exhausted. */
  noUsage?: boolean;
};
export type WaterfallDecision = {
  chosen?: WaterfallCandidate;
  skipped: Array<{ provider: WaterfallProvider; reason: string }>;
};

const validPercent = (percent: unknown): percent is number =>
  typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100;

/**
 * Reject unknown windows rather than treating an absent number as unused quota.
 * Callers must first select only windows applicable to this physical model/pool.
 */
export type AllowanceInspection = {
  state: "available" | "exhausted" | "unknown";
  reason?: string;
  resetAt?: number;
  blockingQuota?: { scope: "shared" | "model" | "variant"; label: string };
  /** The most-used applicable window, once every window is validated. */
  tightest?: { label: string; used: number };
};
export function inspectAllowance(reading: ProviderUsage | undefined, now: number): AllowanceInspection {
  const unknown = (reason: string): AllowanceInspection => ({ state: "unknown", reason });
  if (!reading || reading.state !== "ready") return unknown(reading?.reason ?? "Subscription allowance is unavailable.");
  if (reading.observedAt === undefined || !Number.isFinite(reading.observedAt) || reading.observedAt > now + 30_000 ||
      isUsageStale(reading, now)) return unknown("Subscription allowance is stale or its reset is due.");
  if (reading.access?.limitReached === true || reading.access?.allowed === false) return unknown("Subscription limit reached.");
  if (!reading.windows.length) return unknown("No applicable subscription allowance window was reported.");
  for (const window of reading.windows) {
    if (!validPercent(window.used)) return unknown(`${window.label} allowance percentage is unknown.`);
    if (window.observedAt !== undefined && (!Number.isFinite(window.observedAt) || window.observedAt > now || now - window.observedAt >= 600_000))
      return unknown(`${window.label} allowance is stale.`);
    if (window.reset === undefined || !Number.isFinite(window.reset) || window.reset <= now)
      return unknown(`${window.label} allowance reset is unknown or due.`);
  }
  // Validate every applicable observation before claiming exhaustion/reset metadata.
  const peak = reading.windows.reduce((max, window) => window.used! > max.used! ? window : max);
  const tightest = { label: peak.label, used: peak.used! };
  const spent = reading.windows.filter(window => window.used! >= 95);
  const first = spent[0];
  if (!first) return { state: "available", tightest };
  return { state: "exhausted", reason: `${first.label} allowance is ${first.used}% used (95% waterfall threshold).`,
    resetAt: Math.max(...spent.map(window => window.reset!)),
    ...(first.scope ? { blockingQuota: { scope: first.scope, label: first.label } } : {}), tightest };
}

/** Compatibility wrapper used by selection; inspection also supplies display state. */
export function evaluateAllowance(reading: ProviderUsage | undefined, now: number): string | undefined {
  return inspectAllowance(reading, now).reason;
}

/** The first verified rung with all of its applicable windows below 95% wins. */
export function chooseWaterfall(candidates: readonly WaterfallCandidate[], now: number): WaterfallDecision {
  const skipped: WaterfallDecision["skipped"] = [];
  for (const candidate of candidates) {
    const reason = !candidate.verified ? candidate.reason ?? "Subscription routing is not verified." : candidate.noUsage ? undefined : evaluateAllowance(candidate.reading, now);
    if (!reason) return { chosen: candidate, skipped };
    skipped.push({ provider: candidate.provider, reason });
  }
  return { skipped };
}

/** Do not mistake other models' limits for this model's own applicable windows. */
export function forPhysicalModel(reading: ProviderUsage, model: string): ProviderUsage {
  const windows: UsageWindow[] = reading.provider === "google" ? selectGooglePool(reading, model) :
    reading.windows.filter((window) => !window.model || window.model === model);
  return { ...reading, windows };
}
