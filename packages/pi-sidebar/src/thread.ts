// Sidebar's conversation is stored in main's session as hidden custom entries (never sent to main's
// model): one entry per exchange, and a reset marker for a fresh thread. Rebuilding it from main's
// current branch makes it follow `/tree` and resume.
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const EXCHANGE_ENTRY = "sidebar:exchange";
export const RESET_ENTRY = "sidebar:reset";

const TOOL_RESULT_CHARS = 4000;

export interface ExchangeData {
  version: 1;
  messages: AgentMessage[];
  timestamp: number;
}

type Entry = { type?: string; customType?: string; data?: unknown };

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters not kept in Sidebar's history)` : text;
}

/** A copy of an exchange small enough to store: long tool results are cut and images dropped. */
export function compactExchange(messages: readonly AgentMessage[], maxChars = TOOL_RESULT_CHARS): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return structuredClone(message);
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return structuredClone(message);
    const kept = content.flatMap((block: { type?: string; text?: string }) => {
      if (block?.type === "text" && typeof block.text === "string") return [{ ...block, text: truncateText(block.text, maxChars) }];
      if (block?.type === "image") return [{ type: "text", text: "(image not kept in Sidebar's history)" }];
      return [structuredClone(block)];
    });
    return { ...structuredClone(message), content: kept } as AgentMessage;
  });
}

/** Sidebar's thread on a branch: every exchange after the last reset, in order. */
export function threadFromBranch(branch: readonly unknown[]): AgentMessage[] {
  let messages: AgentMessage[] = [];
  for (const raw of branch) {
    const entry = raw as Entry;
    if (entry?.type !== "custom") continue;
    if (entry.customType === RESET_ENTRY) messages = [];
    else if (entry.customType === EXCHANGE_ENTRY) {
      const data = entry.data as Partial<ExchangeData> | undefined;
      if (Array.isArray(data?.messages)) messages.push(...data.messages);
    }
  }
  return messages;
}
