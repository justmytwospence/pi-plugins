// Package-local exact copy. Optional workflow coordinator; no runtime sibling imports.
export const FLOW_CHANNEL = "pi-plugins.workflow-flow.v1";
export const FLOW_ENTRY = "tool-gate:flow";
export type OperatingMode = "independent" | "linked";
export type FlowWorkflow = "work" | "chat" | "plan" | "exec";
export type FlowAssignment = { provider: string; modelId: string; suggestedThinking?: string; thinkingPinned?: true };
export type ProviderFlow = {
  provider: string;
  anchorModel: string;
  roles: Record<FlowWorkflow, FlowAssignment>;
};
export interface FlowState {
  version: 1;
  operatingMode: OperatingMode;
  selectedFlow?: ProviderFlow;
  /** Durable selection revision. Restores retain it; branch transactions have private fences. */
  revision: number;
}
/** Plain, detached data: querying never resolves roles, touches disk, or applies a model. */
export interface FlowSnapshot extends FlowState {
  workflow: FlowWorkflow;
  ready: boolean;
  guardAvailable: boolean;
  blocked?: string;
  transitioning: boolean;
  /** An unfinished execution is suspended under effective Plan. Omitted when false. */
  replanning?: boolean;
}
export interface FlowAvailability {
  flows: ProviderFlow[];
  failures: { provider: string; reason: string }[];
}
export interface FlowTransitionResult {
  ok: boolean;
  snapshot: FlowSnapshot;
  error?: string;
}
export type ExecutionPhase = "begin" | "replan" | "resume" | "finish" | "stop";
export interface FlowExecution {
  phase: ExecutionPhase;
  expectedRevision: number;
  /** Required for replan/resume; optional fences for legacy completion owners. */
  expectedExecutionId?: string;
  expectedPlanRevision?: number;
  /** Approved effort for the exact worker; omitted by legacy execution owners. */
  effort?: {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
    source: "manual" | "configured" | "system1" | "fallback";
  };
  /** The approved plan's durable identity, not an inferred model difference. */
  planFile: string;
  /** Synchronous final lifecycle update, after authorized model activation and fencing. */
  commit(): void;
}
export type FlowRequest =
  | { kind: "query"; snapshot?: FlowSnapshot; claimDisplay?: boolean }
  | { kind: "resolve"; result?: Promise<FlowAvailability> }
  | { kind: "open"; result?: Promise<void> }
  | { kind: "replan"; result?: Promise<FlowTransitionResult> }
  | { kind: "workflow"; workflow: Exclude<FlowWorkflow, "exec">; result?: Promise<FlowTransitionResult> }
  | ({ kind: "execution"; result?: Promise<FlowTransitionResult> } & FlowExecution);
export interface FlowBus {
  emit(channel: string, request: unknown): void;
}
export function queryFlow(events: FlowBus, claimDisplay = false): FlowSnapshot | undefined {
  const request: Extract<FlowRequest, { kind: "query" }> = { kind: "query", claimDisplay };
  events.emit(FLOW_CHANNEL, request);
  return request.snapshot;
}
export function resolveFlows(events: FlowBus): Promise<FlowAvailability> | undefined {
  const request: Extract<FlowRequest, { kind: "resolve" }> = { kind: "resolve" };
  events.emit(FLOW_CHANNEL, request);
  return request.result;
}
/** Undefined means the optional coordinator is absent. Emission itself is never awaited. */
export function requestWorkflow(
  events: FlowBus,
  workflow: Exclude<FlowWorkflow, "exec">,
): Promise<FlowTransitionResult> | undefined {
  const request: Extract<FlowRequest, { kind: "workflow" }> = { kind: "workflow", workflow };
  events.emit(FLOW_CHANNEL, request);
  return request.result;
}
export function requestExecution(events: FlowBus, execution: FlowExecution): Promise<FlowTransitionResult> | undefined {
  const request: Extract<FlowRequest, { kind: "execution" }> = { kind: "execution", ...execution };
  events.emit(FLOW_CHANNEL, request);
  return request.result;
}
/** Optional planner-owner capability. The coordinator never creates a revision draft. */
export function requestReplan(events: FlowBus): Promise<FlowTransitionResult> | undefined {
  const request: Extract<FlowRequest, { kind: "replan" }> = { kind: "replan" };
  events.emit(FLOW_CHANNEL, request);
  return request.result;
}
export function openFlow(events: FlowBus): Promise<void> | undefined {
  const request: Extract<FlowRequest, { kind: "open" }> = { kind: "open" };
  events.emit(FLOW_CHANNEL, request);
  return request.result;
}
