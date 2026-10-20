// Thread state, persisted entry formats, argument parsing and handoff extraction.
// Origin: pi-btw 0.6.1 extensions/btw.ts (MIT, Dan Bachelder). The persisted custom entry
// types and their payload shapes are unchanged so existing sessions rehydrate.
import { buildSessionContext, type AgentSession, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, ThinkingLevel as AiThinkingLevel, UserMessage } from "@earendil-works/pi-ai";

export const BTW_MESSAGE_TYPE = "btw-note";
export const BTW_ENTRY_TYPE = "btw-thread-entry";
export const BTW_RESET_TYPE = "btw-thread-reset";
export const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override";
export const BTW_THINKING_OVERRIDE_TYPE = "btw-thinking-override";

export const BTW_SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

export const BTW_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

export const BTW_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
export const BTW_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

export type SessionThinkingLevel = "off" | AiThinkingLevel;
export type BtwThreadMode = "contextual" | "tangent" | "readonly";
export type SessionModel = NonNullable<ExtensionCommandContext["model"]>;
/**
 * Loose model reference parsed from `/btw:model <provider> <id> <api>` and persisted to
 * session entries. Resolved to a full SessionModel via ctx.modelRegistry.find(...).
 */
export type BtwModelRef = Pick<SessionModel, "provider" | "id" | "api">;

export type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

export type ParsedBtwArgs = {
  question: string;
  save: boolean;
};

export type SaveState = "not-saved" | "saved" | "queued";

export type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

export type BtwModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

export type BtwThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

export type ResolvedBtwModel = {
  model: SessionModel | null;
  source: "override" | "main" | "none";
  configuredOverride: SessionModel | null;
  fallbackReason?: string;
};

export type ResolvedBtwSettings = {
  model: SessionModel | null;
  modelSource: "override" | "main" | "none";
  configuredModelOverride: SessionModel | null;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: "override" | "main";
  fallbackReason?: string;
};

export function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

export function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === customType;
}

export function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

export function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

export function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

export function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

export function parseBtwModelArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; model: BtwModelRef }
  | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) {
    return { action: "invalid", message: "Usage: /btw:model <provider> <model> <api> | clear" };
  }

  const [provider, id, api] = parts;
  return { action: "set", model: { provider, id, api } as BtwModelRef };
}

export function parseBtwThinkingArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel }
  | { action: "invalid"; message: string } {
  const trimmed = typeof args === "string" ? args.trim() : "";
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(trimmed)) {
    return { action: "invalid", message: "Usage: /btw:thinking off|minimal|low|medium|high|xhigh|max | clear" };
  }
  return { action: "set", thinkingLevel: trimmed as SessionThinkingLevel };
}

export function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

/**
 * Explicit built-in tool selections, never inherited from the parent runtime.
 * The readonly mode selects read/grep/find/ls, not a security sandbox; the other
 * modes use the upstream coding-tool set (read/bash/edit/write).
 */
export const BTW_TOOLS_BY_MODE: Record<BtwThreadMode, readonly string[]> = {
  contextual: ["read", "bash", "edit", "write"],
  tangent: ["read", "bash", "edit", "write"],
  readonly: ["read", "grep", "find", "ls"],
};

export function buildBtwSeedState(
  ctx: ExtensionCommandContext,
  thread: BtwDetails[],
  mode: BtwThreadMode,
  sessionModel: SessionModel | null,
): { messages: Message[]; sideThreadStartIndex: number } {
  const messages: Message[] = [];

  if (mode === "contextual" || mode === "readonly") {
    try {
      messages.push(
        ...(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]).filter(
          // SDK 1.1 stores tool declarations in system messages. Inherit conversation
          // context, not the parent's tool loadout or system-message replay state.
          (message) => message.role !== "system" && !isVisibleBtwMessage(message),
        ),
      );
    } catch {
      messages.push(
        ...ctx.sessionManager.getEntries().flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }

          const message = entry as unknown as Partial<Message> & { role?: string; customType?: string; content?: unknown };
          if (typeof message.role !== "string" || !Array.isArray(message.content)) {
            return [];
          }

          return message.role === "system" || isVisibleBtwMessage({ role: message.role, customType: message.customType }) ? [] : [message as Message];
        }),
      );
    }
  }

  const sideThreadStartIndex = messages.length;

  if (thread.length > 0) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_USER_TEXT }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_ASSISTANT_TEXT }],
        provider: sessionModel?.provider ?? "unknown",
        model: sessionModel?.id ?? "unknown",
        api: sessionModel?.api ?? "openai-responses",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    );

    for (const entry of thread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: entry.provider,
          model: entry.model,
          api: entry.api || sessionModel?.api || ctx.model?.api || "openai-responses",
          usage:
            entry.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }
  }

  return {
    messages,
    sideThreadStartIndex,
  };
}


export function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return null;
}

export type BtwHandoffExchange = {
  user: string;
  assistant: string;
};

export function buildBtwMessageContent(question: string, answer: string): string {
  return `**Question**\n\n${question}\n\n**Answer**\n\n${answer}`;
}

/**
 * The saved note's message content: a plain headline, then the question and answer. Only
 * herdr-web-ui reads this text (the model never sees btw notes, and the TUI draws them from
 * details); its phone chat labels the collapsed card with the first line.
 */
export function buildBtwNoteContent(question: string, answer: string): string {
  const first = question.split("\n").find((line) => line.trim())?.trim() ?? "";
  const headline = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return `Side question (/btw): ${headline}\n\n${buildBtwMessageContent(question, answer)}`;
}

export function formatThread(thread: BtwHandoffExchange[]): string {
  return thread.map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`).join("\n\n---\n\n");
}

export function isThreadContinuationMarker(messages: Message[], index: number): boolean {
  const userMessage = messages[index];
  const assistantMessage = messages[index + 1];
  return (
    userMessage?.role === "user" &&
    extractMessageText(userMessage) === BTW_CONTINUE_THREAD_USER_TEXT &&
    assistantMessage?.role === "assistant" &&
    extractMessageText(assistantMessage) === BTW_CONTINUE_THREAD_ASSISTANT_TEXT
  );
}

export function extractBtwHandoffThread(messages: readonly unknown[], sideThreadStartIndex: number): BtwHandoffExchange[] {
  const handoffMessages = messages.slice(sideThreadStartIndex) as Message[];
  const threadMessages = isThreadContinuationMarker(handoffMessages as Message[], 0) ? handoffMessages.slice(2) : handoffMessages;
  const exchanges: BtwHandoffExchange[] = [];
  let currentUser = "";
  let currentAssistant = "";
  let excludeCurrent = false;

  const pushCurrent = () => {
    if (!excludeCurrent && (currentUser || currentAssistant)) {
      exchanges.push({
        user: currentUser.trim() || "(No user prompt)",
        assistant: currentAssistant.trim() || "(No assistant response)",
      });
    }
    currentUser = "";
    currentAssistant = "";
    excludeCurrent = false;
  };

  for (const message of threadMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (message.role === "user") {
      const text = extractMessageText(message).trim();
      if (!text) {
        continue;
      }
      pushCurrent();
      currentUser = text;
      continue;
    }

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      excludeCurrent = true;
      continue;
    }

    const text = extractMessageText(message).trim();
    if (text) {
      currentAssistant = currentAssistant ? `${currentAssistant}\n\n${text}` : text;
    }
  }

  pushCurrent();
  return exchanges;
}
