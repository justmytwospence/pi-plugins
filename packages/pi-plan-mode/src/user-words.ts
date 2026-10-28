// Optional contract with pi-sticky-last-prompt (channel pi-plugins.user-words.v1): it pins the
// latest thing the user told the agent, and asks plugins how to find the user's words in their
// tool results. Copied structurally, with no import; without that extension nothing asks.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const USER_WORDS_CHANNEL = "pi-plugins.user-words.v1";

export interface ToolCallView {
  toolName: string;
  args: unknown;
  result: { content?: unknown; details?: unknown; isError?: boolean };
}

/** The user's words in a finished call's result, or undefined when it carries none. */
export type UserWordsExtractor = (call: ToolCallView) => string | undefined;

export interface UserWordsRequest {
  version: 1;
  register?: (toolName: string, extract: UserWordsExtractor) => void;
}

/** Offer `extract` for `toolName` (`"*"`: any tool) whenever pi-sticky-last-prompt asks. */
export function offerUserWords(pi: ExtensionAPI, toolName: string, extract: UserWordsExtractor): void {
  pi.events?.on?.(USER_WORDS_CHANNEL, (data: unknown) => {
    const request = data as UserWordsRequest | undefined;
    if (request?.version === 1 && typeof request.register === "function") request.register(toolName, extract);
  });
}

/** The text of a result's content blocks. */
export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}
