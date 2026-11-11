// Package-local contract; optional consumers copy this file, never import a sibling runtime.
export const PLAN_PAIR_CHANNEL = "pi-plugins.plan-pair.v1";
/** plan: plan mode; chat: chat workflow; consult: an ask_planner question is open; build: an approved plan is being implemented (the worker); work: ordinary work on the planner. */
export type PlanPairPhase = "plan" | "chat" | "consult" | "build" | "work";
export interface PlanPairModel {
  provider: string;
  id: string;
}
export interface PlanPairSnapshot {
  version: 1;
  /** The selected pair, `provider/id` (for example `anthropic/opusplan`). */
  pair: string;
  phase: PlanPairPhase;
  /** The physical model the next request routes to: the planner, or the worker in build. */
  next: PlanPairModel;
  planner: PlanPairModel;
  worker: PlanPairModel;
  /** The level the next request uses (a consultation uses the level recorded at approval). */
  thinkingLevel: string;
}
export type PlanPairRequest = { kind: "query"; snapshot?: PlanPairSnapshot };
export interface PlanPairBus {
  emit(channel: string, request: unknown): void;
}
/** Synchronous, read-only, detached snapshot of the selected pair; undefined without one. */
export function queryPlanPair(events: PlanPairBus): PlanPairSnapshot | undefined {
  const request: PlanPairRequest = { kind: "query" };
  try {
    events.emit(PLAN_PAIR_CHANNEL, request);
  } catch {
    return undefined;
  }
  return request.snapshot;
}
