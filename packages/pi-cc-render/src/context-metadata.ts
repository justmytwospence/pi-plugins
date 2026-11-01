import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/** Optional read-only metadata discovery; querying never creates a context or reads prompt data. */
export const CONTEXT_METADATA_CHANNEL = "pi-plugins.context-metadata.v1";
export interface ContextMetadataRequest {
  version: 1;
  sessionManager: object;
  /** Read fresh SDK prompt options on invocation; stale or unavailable hosts return undefined. */
  read?: () => BuildSystemPromptOptions | undefined;
}
export function queryContextMetadata(
  events: { emit(channel: string, data: unknown): void },
  sessionManager: object,
): ContextMetadataRequest["read"] {
  const request: ContextMetadataRequest = { version: 1, sessionManager };
  events.emit(CONTEXT_METADATA_CHANNEL, request);
  return request.read;
}
