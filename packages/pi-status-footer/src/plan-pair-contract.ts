// Package-local contract; optional consumers copy this file, never import a sibling runtime.
export const PLAN_PAIR_CHANNEL = "pi-plugins.plan-pair.v2";
/** build: another model implements an approved plan; consult: your model answers its ask_planner question. */
export type PlanPairPhase = "build" | "consult";
export interface PlanPairModel {
  provider: string;
  id: string;
}
export interface PlanPairSnapshot {
  version: 2;
  phase: PlanPairPhase;
  /** Your model: it answers consultations and serves again when the build ends. */
  home: PlanPairModel;
  worker: PlanPairModel;
  /** The physical model answering now: the worker while building, home while consulting. */
  next: PlanPairModel;
}
export type PlanPairRequest = { kind: "query"; snapshot?: PlanPairSnapshot };
export interface PlanPairBus {
  emit(channel: string, request: unknown): void;
}
/** Synchronous, read-only, detached snapshot of an active build; undefined without one. */
export function queryPlanPair(events: PlanPairBus): PlanPairSnapshot | undefined {
  const request: PlanPairRequest = { kind: "query" };
  try {
    events.emit(PLAN_PAIR_CHANNEL, request);
  } catch {
    return undefined;
  }
  return request.snapshot;
}
