/** Optional System 1 presentation state. Querying it never performs I/O or inference. */
export const SYSTEM1_STATE_CHANNEL = "pi-plugins.system1-state.v1";
export interface System1Status {
  backend: "jev" | "openai-decisions";
  label: "Jev" | "Decisions";
  provider: string;
  model: string;
  /** Local configuration, not verified entitlement or funding. */
  availability: "unknown" | "configured" | "unavailable";
  reason?: string;
}
export interface System1StateRequest {
  version: 1;
  state?: System1Status;
}
export function querySystem1State(events: { emit(channel: string, data: unknown): void }): System1Status | undefined {
  const request: System1StateRequest = { version: 1 };
  events.emit(SYSTEM1_STATE_CHANNEL, request);
  return request.state;
}
