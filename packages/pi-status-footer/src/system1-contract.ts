/** Optional System 1 presentation state. Querying it never performs I/O or inference. */
export const SYSTEM1_STATE_CHANNEL = "pi-plugins.system1-state.v1";
export interface System1Status {
  waterfall: ("jev" | "openai-decisions")[];
  /** Default targets only; feature-specific Jev overrides may differ. */
  candidates: {
    backend: "jev" | "openai-decisions";
    provider: string;
    model: string;
    /** Local configuration, not verified entitlement or funding. */
    local: "unknown" | "configured" | "missing";
    cooldownUntil?: number;
    lastFailure?: { code: string; at: number };
  }[];
  status: "unknown" | "ready" | "fallback" | "unavailable";
  /** Last completed main-registry request, not a universally active model. */
  lastUsed?: {
    backend: "jev" | "openai-decisions";
    provider: string;
    model: string;
    at: number;
    fallback: boolean;
  };
  nextRetryAt?: number;
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
