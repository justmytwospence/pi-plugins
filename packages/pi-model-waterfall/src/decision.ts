import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isUsageStale, type ProviderUsage, type UsageWindow } from "@justmytwospence/pi-subscription-usage";

/** Physical model IDs only: a virtual model must never route to another virtual model. */
export const WATERFALL_MODELS = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "openai", id: "gpt-6.1-sol" },
  { provider: "google", id: "antigravity-gemini-4-argon" },
  { provider: "muse-sdk", id: "muse-wonder-1.0" },
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
    const reason = !candidate.verified ? candidate.reason ?? "Subscription routing is not verified." : evaluateAllowance(candidate.reading, now);
    if (!reason) return { chosen: candidate, skipped };
    skipped.push({ provider: candidate.provider, reason });
  }
  return { skipped };
}

export function waterfallUnavailable(decision: WaterfallDecision): Error {
  const details = decision.skipped.map(({ provider, reason }) => `${provider}: ${reason}`).join("; ");
  return new Error(`Waterfall has no verified subscription route below 95%. ${details}. Select a physical model manually, or inspect /waterfall.`);
}

/** A steered user message can arrive before the previous assistant's tools finish. */
export function pendingToolRound(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown } | null;
    if (message?.role !== "assistant") continue;
    const calls = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "toolCall" && typeof part.id === "string") as Array<{ id: string }> : [];
    if (!calls.length) return false;
    const resolved = new Set<string>();
    for (const subsequent of messages.slice(i + 1)) {
      const result = subsequent as { role?: string; toolCallId?: string } | null;
      if (result?.role === "toolResult" && result.toolCallId) resolved.add(result.toolCallId);
    }
    return calls.some(({ id }) => !resolved.has(id));
  }
  return false;
}

export type RouteState = { version: 1; physical: { provider: WaterfallProvider; id: string; thinkingLevel: ThinkingLevel } };
const levels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Only a Pi-persisted route, matching the actual latest/failed request, can stick. */
export function stickyPhysicalModel(reason: string, previous: { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | undefined,
  failed: { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | undefined, messages: readonly unknown[], state: unknown):
  RouteState["physical"] | undefined {
  if (reason !== "continuation" && reason !== "retry" && !(reason === "user" && pendingToolRound(messages))) return undefined;
  if (!state || typeof state !== "object") return undefined;
  const stored = state as Partial<RouteState>;
  const physical = stored.physical;
  if (stored.version !== 1 || !physical || typeof physical !== "object" || !levels.includes(physical.thinkingLevel) ||
      !WATERFALL_MODELS.some(model => model.provider === physical.provider && model.id === physical.id)) return undefined;
  const actual = reason === "retry" ? failed : previous;
  if (!actual || actual.model.provider !== physical.provider || actual.model.id !== physical.id ||
      actual.thinkingLevel !== physical.thinkingLevel) return undefined;
  return { provider: physical.provider, id: physical.id, thinkingLevel: physical.thinkingLevel };
}

/** Do not mistake other models' limits for this model's own applicable windows. */
export function forPhysicalModel(reading: ProviderUsage, model: string): ProviderUsage {
  const windows: UsageWindow[] = reading.windows.filter((window) => !window.model || window.model === model);
  return { ...reading, windows };
}
