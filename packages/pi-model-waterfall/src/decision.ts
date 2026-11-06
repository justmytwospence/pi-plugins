import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isUsageStale, type ProviderUsage, type UsageWindow } from "@justmytwospence/pi-subscription-usage";

/** Physical model IDs only: a virtual model must never route to another virtual model. */
export const WATERFALL_MODELS = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "openai", id: "gpt-6.1-sol" },
  { provider: "google", id: "antigravity-gemini-4-argon" },
  { provider: "muse-code", id: "muse-wonder-1.0" },
] as const;

export type WaterfallProvider = typeof WATERFALL_MODELS[number]["provider"];
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
export function evaluateAllowance(reading: ProviderUsage | undefined, now: number): string | undefined {
  if (!reading || reading.state !== "ready") return reading?.reason ?? "Subscription allowance is unavailable.";
  if (reading.observedAt === undefined || !Number.isFinite(reading.observedAt) || reading.observedAt > now + 30_000 ||
      isUsageStale(reading, now)) return "Subscription allowance is stale or its reset is due.";
  if (reading.access?.limitReached === true || reading.access?.allowed === false) return "Subscription limit reached.";
  if (!reading.windows.length) return "No applicable subscription allowance window was reported.";
  for (const window of reading.windows) {
    if (!validPercent(window.used)) return `${window.label} allowance percentage is unknown.`;
    if (window.observedAt !== undefined && (!Number.isFinite(window.observedAt) || window.observedAt > now || now - window.observedAt >= 600_000))
      return `${window.label} allowance is stale.`;
    if (window.reset === undefined || !Number.isFinite(window.reset) || window.reset <= now)
      return `${window.label} allowance reset is unknown or due.`;
    if (window.used >= 95) return `${window.label} allowance is ${window.used}% used (95% threshold).`;
  }
  return undefined;
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
  const windows: UsageWindow[] = reading.windows.filter((window) => !window.model || window.model === model);
  return { ...reading, windows };
}
