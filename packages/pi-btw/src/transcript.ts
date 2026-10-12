// Overlay transcript model: a projection of sub-session events into renderable entries.
// Origin: pi-btw 0.6.1 extensions/btw.ts (MIT, Dan Bachelder).
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { extractMessageText, extractThinking, type BtwDetails, type BtwThreadMode } from "./thread.ts";

export type BtwTurnOutcome = "completed" | "aborted" | "failed";

export type BtwTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end"; outcome?: BtwTurnOutcome }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

export type BtwTranscript = BtwTranscriptEntry[];

export type BtwTranscriptState = {
  entries: BtwTranscript;
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

export function formatToolPreview(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      return path;
    }
  }

  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") {
      return "";
    }
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

export function createEmptyTranscriptState(): BtwTranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    toolCalls: new Map(),
  };
}

export function appendTranscriptEntry<T extends BtwTranscriptEntry>(
  state: BtwTranscriptState,
  entry: Omit<T, "id">,
): T {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as T;
  state.entries.push(nextEntry);
  return nextEntry;
}

export function ensureTranscriptTurn(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    return state.currentTurnId;
  }

  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendTranscriptEntry(state, { type: "turn-boundary", turnId, phase: "start" } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  return turnId;
}

export function finishTranscriptTurn(
  state: BtwTranscriptState,
  turnId?: number | null,
  outcome: BtwTurnOutcome = "completed",
): void {
  const resolvedTurnId = turnId ?? state.currentTurnId;
  if (resolvedTurnId === null || resolvedTurnId === undefined) {
    return;
  }

  const endBoundary = state.entries.find(
    (entry): entry is Extract<BtwTranscriptEntry, { type: "turn-boundary" }> =>
      entry.turnId === resolvedTurnId && entry.type === "turn-boundary" && entry.phase === "end",
  );
  if (endBoundary) {
    endBoundary.outcome = outcome;
  } else {
    appendTranscriptEntry(state, {
      type: "turn-boundary",
      turnId: resolvedTurnId,
      phase: "end",
      outcome,
    } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  }

  for (const entry of state.entries) {
    if (entry.turnId !== resolvedTurnId) {
      continue;
    }

    if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
      entry.streaming = false;
    }
  }

  state.lastTurnId = resolvedTurnId;
  if (state.currentTurnId === resolvedTurnId) {
    state.currentTurnId = null;
  }
}

export function findLatestTranscriptEntry<TType extends BtwTranscriptEntry["type"]>(
  state: BtwTranscriptState,
  turnId: number,
  type: TType,
): Extract<BtwTranscriptEntry, { type: TType }> | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.turnId === turnId && entry.type === type) {
      return entry as Extract<BtwTranscriptEntry, { type: TType }>;
    }
  }

  return undefined;
}

export function ensureTranscriptTurnForUserMessage(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestTranscriptEntry(state, state.currentTurnId, "assistant-text");
    if (currentAssistant && !currentAssistant.streaming) {
      finishTranscriptTurn(state, state.currentTurnId);
    }
  }

  return ensureTranscriptTurn(state);
}

export function upsertUserMessageEntry(state: BtwTranscriptState, turnId: number, text: string): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, "user-message");
  if (existing) {
    existing.text = text;
    return;
  }

  appendTranscriptEntry(state, { type: "user-message", turnId, text } as Omit<Extract<BtwTranscriptEntry, { type: "user-message" }>, "id">);
}

export function upsertTranscriptTextEntry(
  state: BtwTranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }

  appendTranscriptEntry(state, { type, turnId, text, streaming } as Omit<Extract<BtwTranscriptEntry, { type: "thinking" | "assistant-text" }>, "id">);
}

export function summarizeToolResult(value: unknown, maxLength = 400): { content: string; truncated: boolean } {
  let content = "";

  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
    }

    if (!content && typeof toolValue.error === "string") {
      content = toolValue.error;
    }

    if (!content && typeof toolValue.message === "string") {
      content = toolValue.message;
    }
  }

  if (!content) {
    if (typeof value === "string") {
      content = value;
    } else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    }
  }

  if (!content) {
    content = "(no tool output)";
  }

  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

export function ensureToolCallEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const callEntry = appendTranscriptEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-call" }>, "id">);
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

export function upsertToolResultEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
  const existing =
    toolCall.resultEntryId !== undefined
      ? state.entries.find((entry) => entry.id === toolCall.resultEntryId && entry.type === "tool-result")
      : undefined;

  if (existing && existing.type === "tool-result") {
    existing.content = content;
    existing.truncated = truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }

  const resultEntry = appendTranscriptEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content,
    truncated,
    isError,
    streaming,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-result" }>, "id">);
  toolCall.resultEntryId = resultEntry.id;
}

export function applyAssistantMessageToTranscript(
  state: BtwTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const assistantMessage = message;
  const thinking = extractThinking(assistantMessage);
  const answer = extractMessageText(assistantMessage);

  if (thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
  }

  if (answer) {
    upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
  }
}

export function applyTranscriptEvent(state: BtwTranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start": {
      ensureTranscriptTurn(state);
      return;
    }
    case "message_start": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, true);
      }
      return;
    }
    case "message_update": {
      if (event.message.role !== "assistant") {
        return;
      }

      const turnId = ensureTranscriptTurn(state);
      applyAssistantMessageToTranscript(state, turnId, event.message, true);
      return;
    }
    case "message_end": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, false);
      }
      return;
    }
    case "tool_execution_start": {
      const turnId = ensureTranscriptTurn(state);
      ensureToolCallEntry(state, turnId, event.toolCallId, event.toolName, formatToolPreview(event.args));
      return;
    }
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.partialResult);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        false,
        true,
      );
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.result);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        event.isError,
        false,
      );
      return;
    }
    case "turn_end": {
      const stopReason = event.message.role === "assistant" ? event.message.stopReason : "stop";
      const outcome: BtwTurnOutcome =
        stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
      finishTranscriptTurn(state, undefined, outcome);
      return;
    }
    default:
      return;
  }
}

export function appendPersistedTranscriptTurn(state: BtwTranscriptState, details: BtwDetails): void {
  const turnId = ensureTranscriptTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
  }
  upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
  finishTranscriptTurn(state, turnId);
}

export function setTranscriptFailure(state: BtwTranscriptState, message: string): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", `Error: ${message}`, false);
  finishTranscriptTurn(state, turnId, "failed");
}

export function hasStreamingTranscriptEntry(entries: BtwTranscript): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") &&
      entry.streaming,
  );
}

export function getCompletedExchangeCount(entries: BtwTranscript): number {
  const completedTurnIds = new Set(
    entries.flatMap((entry) =>
      entry.type === "turn-boundary" &&
      entry.phase === "end" &&
      (entry.outcome === undefined || entry.outcome === "completed")
        ? [entry.turnId]
        : [],
    ),
  );
  return entries.filter(
    (entry) => entry.type === "assistant-text" && !entry.streaming && completedTurnIds.has(entry.turnId),
  ).length;
}

export const BTW_OVERLAY_CHROME_LINES = 9;
/** Indent applied to transcript block bodies. */
export const BTW_BLOCK_INDENT = "    ";

export function getOverlayTitle(mode: BtwThreadMode): string {
  if (mode === "tangent") {
    return "BTW tangent";
  }
  if (mode === "readonly") {
    return "BTW ask · read-only";
  }
  return "BTW";
}

export function buildTranscriptBadge(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
  foreground: "accent" | "warning" | "success",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

export function buildOverlayTranscript(
  entries: BtwTranscript,
  theme: ExtensionContext["ui"]["theme"],
  markdownTheme: MarkdownTheme,
  contentWidth: number,
): string[] {
  if (entries.length === 0) {
    return [theme.fg("dim", "No BTW thread yet. Ask a side question to start one.")];
  }

  const lines: string[] = [];
  const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
  const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
  const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildTranscriptBadge(theme, "Assistant", "customMessageBg", "success");
  const separator = theme.fg("borderMuted", "────────────────────────────────────────");
  const blockIndent = BTW_BLOCK_INDENT;
  const resultIndent = blockIndent;

  const pushBlankLine = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    const firstLine = bodyLines.shift() ?? "";
    lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
    for (const line of bodyLines) {
      lines.push(`${blockIndent}${style(line)}`);
    }
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; indent?: string; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const indent = options.indent ?? blockIndent;
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    lines.push(header);
    for (const line of bodyLines) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  for (const entry of entries) {
    if (entry.type === "turn-boundary") {
      if (entry.phase === "start" && lines.length > 0) {
        pushBlankLine();
        lines.push(separator);
      }
      continue;
    }

    if (entry.type === "user-message") {
      pushInlineBlock(userBadge, entry.text, { blankBefore: false });
      continue;
    }

    if (entry.type === "thinking") {
      const thinkingHeader = entry.streaming ? `${thinkingBadge} ${theme.fg("warning", "▍")}` : thinkingBadge;
      const markdownLines = new Markdown(entry.text, 0, 0, markdownTheme, {
        color: (text: string) => theme.fg("warning", text),
        italic: true,
      })
        .render(Math.max(1, contentWidth))
        .map((line) => line.replace(/\s+$/u, ""));
      pushBlankLine();
      lines.push(thinkingHeader);
      for (const line of markdownLines) {
        lines.push(line ? `${blockIndent}${line}` : "");
      }
      continue;
    }

    if (entry.type === "tool-call") {
      const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
      const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);
      continue;
    }

    if (entry.type === "tool-result") {
      const resultHeaderLabel = entry.isError
        ? theme.fg("error", "↳ error")
        : entry.streaming
          ? theme.fg("warning", "↳ streaming result")
          : theme.fg("dim", "↳ result");
      const truncationLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
      pushStackedBlock(`${resultHeaderLabel}${truncationLabel}`, entry.content, {
        blankBefore: false,
        indent: resultIndent,
        style: (line) => (entry.isError ? theme.fg("error", line) : theme.fg("dim", line)),
      });
      continue;
    }

    if (entry.type === "assistant-text") {
      const assistantHeader = entry.streaming ? `${assistantBadge} ${theme.fg("warning", "▍")}` : assistantBadge;
      const markdownLines = new Markdown(entry.text, 0, 0, markdownTheme)
        .render(Math.max(1, contentWidth))
        .map((line) => line.replace(/\s+$/u, ""));
      pushBlankLine();
      lines.push(assistantHeader);
      for (const line of markdownLines) {
        lines.push(line ? `${blockIndent}${line}` : "");
      }
    }
  }

  return lines;
}
