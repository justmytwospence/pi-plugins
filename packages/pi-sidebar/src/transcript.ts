// What Sidebar adds after main's last request: the entries main committed since (its reply, tool
// results), a note on what main is doing this second, and Sidebar's own conversation.
import {
  buildContextEntries,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LiveState } from "./protocol.ts";

export interface PendingCall {
  name: string;
  summary: string;
}

export interface MainDelta {
  messages: AgentMessage[];
  /** Tool calls main made that have no result yet; they are described, not replayed. */
  pending: PendingCall[];
  /** Why the delta was left out, when it was (a compaction or a branch switch since the request). */
  skipped?: string;
}

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments?: unknown };

function toolCalls(message: AgentMessage): ToolCallBlock[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return (message.content as Array<{ type: string }>).filter((b): b is ToolCallBlock => b.type === "toolCall");
}

export function summarizeArgs(args: unknown, max = 160): string {
  if (args === undefined || args === null) return "";
  let text: string;
  if (typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    const preferred = record.command ?? record.path ?? record.pattern ?? record.query ?? record.url ?? record.task;
    text = typeof preferred === "string" ? preferred : JSON.stringify(args);
  } else {
    text = typeof args === "string" ? args : JSON.stringify(args);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Entries main committed after the leaf its last request was built from. In a trailing assistant
 * turn whose tool calls have not all returned, the open calls are removed (a provider rejects a
 * call without its result) and described in the live note instead; the calls that did return stay,
 * with their results. That turn's thinking is dropped with them, since thinking may only be replayed
 * with its turn unchanged. All of this sits after the cached prefix, so it costs no cache.
 */
export function mainDelta(entries: SessionEntry[], recordedLeaf: string | null, currentLeaf: string | null): MainDelta {
  if (!recordedLeaf || entries.length === 0) return { messages: [], pending: [] };
  const leaf = currentLeaf ?? entries[entries.length - 1]?.id ?? null;
  const path = buildContextEntries(entries, leaf);
  const at = path.findIndex((entry) => entry.id === recordedLeaf);
  if (at === -1) return { messages: [], pending: [], skipped: "main's history changed since its last request (compaction or /tree)" };
  const after = path.slice(at + 1);
  if (after.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")) {
    return { messages: [], pending: [], skipped: "main is compacting or switching branches" };
  }
  let messages = after.flatMap((entry) => sessionEntryToContextMessages(entry));
  // A request always ends on main's side of the turn, so a leading tool result has lost its call.
  while (messages[0]?.role === "toolResult") messages = messages.slice(1);
  const pending: PendingCall[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = toolCalls(messages[i]!);
    if (calls.length === 0) continue;
    const answered = new Set(
      messages.slice(i + 1).flatMap((m) => (m.role === "toolResult" ? [(m as { toolCallId: string }).toolCallId] : [])),
    );
    const open = calls.filter((call) => !answered.has(call.id));
    if (open.length > 0) {
      for (const call of open) pending.push({ name: call.name, summary: summarizeArgs(call.arguments) });
      const openIds = new Set(open.map((call) => call.id));
      const turn = messages[i] as AgentMessage & { content: Array<{ type: string; id?: string }> };
      const kept = turn.content.filter((block) => block.type !== "thinking" && block.type !== "redactedThinking" && !(block.type === "toolCall" && openIds.has(block.id!)));
      const hasContent = kept.some((block) => block.type === "toolCall" || (block.type === "text" && (block as { text?: string }).text?.trim()));
      messages = hasContent ? [...messages.slice(0, i), { ...turn, content: kept } as AgentMessage, ...messages.slice(i + 1)] : messages.slice(0, i);
    }
    break;
  }
  return { messages, pending };
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function describeLive(live: LiveState | undefined, delta: MainDelta, now = Date.now(), hostAlive = true): string {
  const lines: string[] = [];
  if (!hostAlive) lines.push("The main session has exited; the transcript above is where it stopped.");
  if (!live) {
    lines.push("Main's live status is unavailable.");
  } else if (live.state === "working") {
    lines.push(`Main is working (for ${ago(now - live.since)}).`);
  } else {
    lines.push(`Main is idle (since ${ago(now - live.since)} ago), waiting for the user.`);
  }
  const label = (name: string, summary: string) => `${name}${summary ? ` \`${summary}\`` : ""}`;
  const running = live?.tools ?? [];
  const finished = live?.state === "working" ? (live.finished ?? []) : [];
  for (const tool of running) lines.push(`- Running now: ${label(tool.name, tool.summary)} (${ago(now - tool.startedAt)})`);
  for (const tool of finished) {
    lines.push(`- Finished${tool.isError ? " with an error" : ""}, while other calls of the same turn still run: ${label(tool.name, tool.summary)}`);
    if (tool.preview) lines.push(`  Result:\n${tool.preview.split("\n").map((l) => `    ${l}`).join("\n")}`);
  }
  const shown = new Set([...running, ...finished].map((t) => `${t.name}\u0000${t.summary}`));
  for (const call of delta.pending) {
    if (!shown.has(`${call.name}\u0000${call.summary}`)) lines.push(`- Called, no result yet: ${label(call.name, call.summary)}`);
  }
  if (live?.state === "working" && live.streaming?.trim()) {
    lines.push(`- Writing now: "…${live.streaming.trim()}"`);
  }
  if (delta.skipped) lines.push(`(Recent main activity not shown: ${delta.skipped}.)`);
  return lines.join("\n");
}

export const SIDEBAR_ROLE = [
  "You are Sidebar: the user's read-only side chat, running beside the main session whose conversation is above.",
  "That conversation belongs to the main agent, which carries on with its task in parallel. Do not continue or redo its work, and do not answer its open questions on its behalf.",
  "The user talks to you about what the main agent is doing, why, how the code works, and what its changes mean. Answer from the conversation above first; read files or run read-only commands when that is not enough.",
  "Main's conversation above and the live status before the user's newest message are current, so do not dig through session files, runtime files or environment variables to find out what main is doing.",
  "You cannot change anything: edits, writes and commands that modify state are blocked. When the user wants a change, say what to ask the main session.",
  "Keep answers short unless the user asks for depth.",
].join(" ");

const TIMELINE =
  "Main's conversation above is its latest state. The Sidebar conversation that follows spans time: earlier Sidebar answers were accurate for main as it was when they were given, so when main has moved on since, describe what changed rather than calling them mistakes. The live status just before the user's newest message is the current one.";

function userText(text: string, now: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: now } as AgentMessage;
}

/** Sidebar's standing instructions, placed between main's conversation and Sidebar's own. */
export function roleMessage(now = Date.now()): AgentMessage {
  return userText(`<sidebar>\n${SIDEBAR_ROLE}\n\n${TIMELINE}\n</sidebar>`, now);
}

/** Main's live status, placed just before the user's newest message. */
export function statusMessage(liveText: string, now = Date.now()): AgentMessage {
  return userText(`<sidebar-status at="${new Date(now).toISOString()}">\n${liveText}\n</sidebar-status>`, now);
}

/**
 * Sidebar's request transcript: its own leading system message (the provider needs one; its
 * prompt and tools are replaced by main's when the request is spliced), main's delta, the role
 * note, Sidebar's earlier conversation, the live status, then the user's newest message and
 * whatever Sidebar has done for it so far (tool calls within this turn).
 */
export function assembleContext(sideMessages: AgentMessage[], delta: AgentMessage[], role: AgentMessage, status: AgentMessage): AgentMessage[] {
  const leading = sideMessages[0]?.role === "system" ? [sideMessages[0]] : [];
  const rest = sideMessages.slice(leading.length);
  let newest = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i]!.role === "user") { newest = i; break; }
  }
  if (newest === -1) return [...leading, ...delta, role, ...rest, status];
  return [...leading, ...delta, role, ...rest.slice(0, newest), status, ...rest.slice(newest)];
}
