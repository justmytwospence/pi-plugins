// Optional working-message ownership shared with pi-status-footer. Keep copies identical.
// Claims are keyed by unique wait IDs; updating a claim preserves its priority. The newest
// active claim wins, and releasing an unknown/stale claim never clears a newer one.
export const WORKING_MESSAGE_EVENT = "pi-plugins.working-message.v1";
export interface WorkingMessageClaim {
  owner: string;
  /** Omit to release this owner's claim. */
  message?: string;
}
