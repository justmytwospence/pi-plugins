/** Optional, synchronous capability discovery. Providers own behavior; rendering never does I/O. */
export const FOOTER_ACTIONS_CHANNEL = "pi-plugins.footer-actions.v1";
export type FooterActionId =
  | "workflow.cycle"
  | "workflow.open"
  | "flow.open"
  | "execution.status"
  | "approvals.open"
  | "context.open"
  | "context.skills"
  | "cache.status"
  | "mcp.open"
  | "system1.open"
  | "headsup.open";
export interface FooterAction {
  label: string;
  key?: string;
  /** Effective enabled state, not action availability. */
  active?: boolean;
  /** Must validate the provider's current session/generation when invoked. */
  run(): Promise<void> | void;
}
export interface FooterActionsRequest {
  version: 1;
  actions: Partial<Record<FooterActionId, FooterAction>>;
}
export function queryFooterActions(events: {
  emit(channel: string, data: unknown): void;
}): FooterActionsRequest["actions"] {
  const request: FooterActionsRequest = { version: 1, actions: {} };
  events.emit(FOOTER_ACTIONS_CHANNEL, request);
  return request.actions;
}
