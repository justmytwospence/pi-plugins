// Package-local contract; optional consumers copy this file, never import a sibling runtime.
export const WATERFALL_CHANNEL = "pi-plugins.model-waterfall.v1";
export interface WaterfallSnapshot {
  version: 1;
  physical?: { provider: string; id: string; thinkingLevel: string; quotaVariant?: string };
  skipped: Array<{ provider: string; reason: string }>;
  observedAt: number;
}
export type WaterfallRequest = { kind: "query"; snapshot?: WaterfallSnapshot };
export interface WaterfallBus { emit(channel: string, request: unknown): void }
/** Synchronous, read-only, detached snapshot; no inference or quota I/O. */
export function queryWaterfall(events: WaterfallBus): WaterfallSnapshot | undefined {
  const request: WaterfallRequest = { kind: "query" };
  events.emit(WATERFALL_CHANNEL, request);
  return request.snapshot;
}
