// Package-local contract; optional consumers copy this file, never import a sibling runtime.
export const WATERFALL_CHANNEL = "pi-plugins.model-waterfall.v1";
/** One configured active waterfall rung, as last assessed in the background. Display-only. */
export interface WaterfallRung {
  provider: string;
  model: string;
  /** available: would be chosen now; exhausted: an applicable window is at 95% or more;
   * disabled: deliberately not a candidate; unknown: credentials or quota cannot be verified. */
  state: "available" | "exhausted" | "disabled" | "unknown";
  reason?: string;
  /** When every exhausted window has reset (epoch ms). */
  resetAt?: number;
  /** First applicable quota at the waterfall threshold, when its scope is known. */
  blockingQuota?: { scope: "shared" | "model" | "variant"; label: string };
  /** The most-used applicable window (percent used), whenever the allowance could be verified. */
  tightest?: { label: string; used: number };
}
export interface WaterfallSnapshot {
  version: 1;
  physical?: { provider: string; id: string; thinkingLevel: string; quotaVariant?: string };
  skipped: Array<{ provider: string; reason: string }>;
  observedAt: number;
  /** The configured active rungs in waterfall order, present from load, before any assessment. */
  order?: Array<{ provider: string; model: string }>;
  /** Rungs in waterfall order; absent until the first background assessment. */
  rungs?: WaterfallRung[];
  rungsObservedAt?: number;
}
export type WaterfallRequest = { kind: "query"; snapshot?: WaterfallSnapshot };
export interface WaterfallBus { emit(channel: string, request: unknown): void }
/** Synchronous, read-only, detached snapshot; no inference or quota I/O. */
export function queryWaterfall(events: WaterfallBus): WaterfallSnapshot | undefined {
  const request: WaterfallRequest = { kind: "query" };
  events.emit(WATERFALL_CHANNEL, request);
  return request.snapshot;
}
