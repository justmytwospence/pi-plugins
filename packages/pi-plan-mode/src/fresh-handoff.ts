import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Optional, one-shot host bridge for an explicitly approved plan, never a command dispatcher. */
export const FRESH_HANDOFF_CHANNEL = "pi-plugins.approved-plan-fresh.v1";
export type ApprovedPlanReplacement = ExtensionCommandContext["newSession"];
export interface FreshHandoffRequest {
  version: 1;
  sessionManager: ExtensionContext["sessionManager"];
  /** Exact approved text and its retained file; discovery alone never grants approval. */
  approvedPlan: { planFile: string; plan: string };
  /** The owner fences approval identity, workflow/flow revision, branch and runtime generation. */
  isCurrent(): boolean;
  /** Synchronous acceptance only. The host runs detached, after the current run settles/gets idle.
   * The callback receives only a single-use replacement for this approval, not a host context.
   * Both scheduling and replacement recheck ownership; stale replacements return cancelled.
   */
  schedule?: (run: (replace: ApprovedPlanReplacement) => Promise<void>) => boolean;
}

export function discoverFreshHandoff(
  events: { emit(channel: string, data: unknown): void },
  request: Omit<FreshHandoffRequest, "version" | "schedule">,
): FreshHandoffRequest["schedule"] {
  const message: FreshHandoffRequest = { version: 1, ...request };
  try {
    events.emit(FRESH_HANDOFF_CHANNEL, message);
    return message.schedule;
  } catch {
    return undefined;
  }
}
