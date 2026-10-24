// Main's session as a reviewer on another model reads it: a plain transcript of another agent's
// work (the user's messages, main's replies, reasoning and tool calls, tool results clipped), sent
// as user-side text rather than as the reviewer's own turns, so it reads it as someone else's work.
//
// A different model cannot read main's prompt cache, so the reviewer keeps a cache of its own, and
// its requests only ever grow at the end. Main's transcript is split into parts at the points
// earlier requests ended; a part never changes once sent. Each request adds at most one, placed
// where Sidebar's own conversation stood at the time, so parts and Sidebar's exchanges interleave
// in the order they happened and every request extends the previous one.
import { createHash } from "node:crypto";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { summarizeArgs, type PendingCall } from "./transcript.ts";

export const TRANSCRIPT_TAG = "main-transcript";
const RESULT_HEAD = 1_200;
const RESULT_TAIL = 600;
const ARGS_CHARS = 6_000;
const THINKING_CHARS = 8_000;
/** Rough characters per token, for budgets and estimates. */
export const CHARS_PER_TOKEN = 3.5;
/** Share of the reviewer's context window the transcript may fill before older messages are left out. */
const WINDOW_SHARE = 0.6;

type Block = { type?: string; text?: string; thinking?: string; redacted?: boolean; name?: string; id?: string; arguments?: unknown };
type Llm = { role: string; content?: unknown; toolName?: string; isError?: boolean; toolCallId?: string };

function clip(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 80) return text;
  return `${text.slice(0, head)}\n… [${text.length - head - tail} characters left out] …\n${text.slice(-tail)}`;
}

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]).filter((b) => b && typeof b === "object") : [];
}

function textOf(content: unknown): string {
  return blocks(content)
    .map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function renderLlm(message: Llm): string {
  if (message.role === "user") {
    const text = textOf(message.content);
    return text ? `[user]\n${text}` : "";
  }
  if (message.role === "toolResult") {
    const text = textOf(message.content) || "(no output)";
    return `[${message.isError ? "tool error" : "tool result"}: ${message.toolName ?? "tool"}]\n${clip(text, RESULT_HEAD, RESULT_TAIL)}`;
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const block of blocks(message.content)) {
      if (block.type === "thinking" && !block.redacted && block.thinking?.trim()) parts.push(`(reasoning)\n${clip(block.thinking.trim(), THINKING_CHARS, 0)}`);
      else if (block.type === "text" && block.text?.trim()) parts.push(block.text.trim());
      else if (block.type === "toolCall") {
        const args = block.arguments === undefined ? "" : JSON.stringify(block.arguments);
        parts.push(`→ ${block.name ?? "tool"} ${clip(args, ARGS_CHARS, 0)}`);
      }
    }
    return parts.length ? `[main agent]\n${parts.join("\n\n")}` : "";
  }
  return "";
}

const rendered = new WeakMap<object, string>();

/** One message of main's context as transcript text ("" for what the transcript leaves out). */
export function renderMessage(message: AgentMessage): string {
  const key = message as unknown as object;
  const cached = rendered.get(key);
  if (cached !== undefined) return cached;
  const text = (message as { role?: string }).role === "system" ? "" : convertToLlm([message]).map((m) => renderLlm(m as unknown as Llm)).filter(Boolean).join("\n\n");
  rendered.set(key, text);
  return text;
}

/**
 * Main's finished messages: everything before a trailing turn whose tool calls have not all
 * returned. That turn is still changing (its results arrive one by one), so it stays out of the
 * transcript, which must never change once sent; its open calls go to the live status instead.
 */
export function finishedMessages(messages: readonly AgentMessage[]): { finished: AgentMessage[]; pending: PendingCall[] } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Llm;
    if (m.role !== "assistant") continue;
    const calls = blocks(m.content).filter((b) => b.type === "toolCall");
    if (calls.length === 0) break;
    const answered = new Set(messages.slice(i + 1).flatMap((x) => ((x as Llm).role === "toolResult" ? [(x as Llm).toolCallId] : [])));
    const open = calls.filter((c) => !answered.has(c.id));
    if (open.length === 0) break;
    return { finished: messages.slice(0, i), pending: open.map((c) => ({ name: c.name ?? "tool", summary: summarizeArgs(c.arguments) })) };
  }
  return { finished: [...messages], pending: [] };
}

export interface TranscriptView {
  /** One user message per part, in order. */
  messages: AgentMessage[];
  pending: PendingCall[];
  /** Estimated tokens of all parts. */
  tokens: number;
  /** Main's messages left out at the start, to fit the reviewer's context window. */
  omitted: number;
  /** Whether the parts continue an earlier request's (so its cache entry can serve them). */
  continued: boolean;
  /** For each part, how many of Sidebar's own messages come before it. */
  threadAt: number[];
}

function partMessage(text: string, part: number, now: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text: `<${TRANSCRIPT_TAG} part="${part}">\n${text}\n</${TRANSCRIPT_TAG}>` }], timestamp: now } as AgentMessage;
}

/**
 * The transcript's parts for one reviewer cache (Sidebar's questions, or heads-up checks). Each
 * request ends the newest part where main's finished messages end; when earlier messages change
 * (a compaction, /tree), or the transcript outgrows the window, it starts over as one part.
 */
export class TranscriptParts {
  /** Rendered text per message, from `start`, as last sent. */
  private sent: string[] = [];
  /** Message index (from `start`) where each part ends. */
  private cuts: number[] = [];
  /** How many of Sidebar's messages came before each part. */
  private threadAt: number[] = [];
  /** Main's messages left out at the start. */
  private start = 0;

  reset(): void {
    this.sent = [];
    this.cuts = [];
    this.threadAt = [];
    this.start = 0;
  }

  /** Sidebar's thread was replaced (a fresh thread, /tree): every part goes before it. */
  rebase(): void {
    this.threadAt = this.threadAt.map(() => 0);
  }

  /**
   * The parts for a request now, recording the new part's end. `threadAt` is where a new part goes
   * among Sidebar's own messages (before the question being asked, or after the tool results of
   * the answer in progress).
   */
  build(messages: readonly AgentMessage[], contextWindow: number | undefined, now = Date.now(), threadAt = 0): TranscriptView {
    return this.view(messages, contextWindow, now, true, threadAt);
  }

  /** The same without recording anything (for estimates). */
  peek(messages: readonly AgentMessage[], contextWindow: number | undefined, now = Date.now()): TranscriptView {
    return this.view(messages, contextWindow, now, false, 0);
  }

  private view(messages: readonly AgentMessage[], contextWindow: number | undefined, now: number, record: boolean, newThreadAt: number): TranscriptView {
    const { finished, pending } = finishedMessages(messages);
    const all = finished.map(renderMessage);
    let start = this.start;
    let cuts = this.cuts;
    let threadAt = this.threadAt;
    const lastCut = cuts[cuts.length - 1] ?? 0;
    // The parts already sent must render exactly as before; otherwise start over.
    let intact = start + lastCut <= all.length;
    for (let i = 0; intact && i < lastCut; i++) if (all[start + i] !== this.sent[i]) intact = false;
    if (!intact) {
      start = 0;
      cuts = [];
      threadAt = [];
    }
    const budget = contextWindow ? contextWindow * WINDOW_SHARE * CHARS_PER_TOKEN : Infinity;
    // Characters from each message to the end.
    const suffix = new Array<number>(all.length + 1).fill(0);
    for (let i = all.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + all[i]!.length + 2;
    if (suffix[start]! > budget) {
      // Leave out the oldest messages, with room to grow, starting at a user message where one fits.
      let from = start;
      while (from < all.length && suffix[from]! > budget / 2) from++;
      const user = finished.findIndex((m, i) => i >= from && (m as Llm).role === "user");
      start = user !== -1 && suffix[user]! >= budget / 4 ? user : from;
      cuts = [];
      threadAt = [];
    }
    const continued = cuts.length > 0;
    const total = all.length - start;
    if (total > (cuts[cuts.length - 1] ?? 0)) {
      cuts = [...cuts, total];
      // Never before a part already placed.
      threadAt = [...threadAt, Math.max(newThreadAt, threadAt[threadAt.length - 1] ?? 0)];
    }
    const parts: string[] = [];
    let from = 0;
    for (const cut of cuts) {
      const body = all.slice(start + from, start + cut).filter(Boolean).join("\n\n");
      const lead = from === 0 && start > 0 ? `(The first ${start} messages of main's session are left out here to fit the context window.)\n\n` : "";
      parts.push(`${lead}${body || "(nothing yet)"}`);
      from = cut;
    }
    if (record) {
      this.start = start;
      this.cuts = cuts;
      this.threadAt = threadAt;
      this.sent = all.slice(start);
    }
    const chars = parts.reduce((n, p) => n + p.length, 0);
    return {
      messages: parts.map((text, i) => partMessage(text, i + 1, now)),
      pending,
      tokens: Math.round(chars / CHARS_PER_TOKEN),
      omitted: start,
      continued,
      threadAt,
    };
  }
}

/**
 * A stable id for a reviewer cache, derived from main's session id: OpenAI routes prompt caches by
 * it (`prompt_cache_key`, Codex's session), and it stays the same when Sidebar's session is rebuilt.
 */
export function derivedSessionId(mainId: string, purpose: string): string {
  const s = createHash("sha256").update(`${mainId}\u0000${purpose}`).digest("hex");
  // A UUID's shape (version 8: custom), as session ids have.
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-8${s.slice(13, 16)}-${((parseInt(s[16]!, 16) & 0x3) | 0x8).toString(16)}${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

/** Where a new part goes in Sidebar's messages: before the trailing question(s), else at the end. */
export function newPartAt(thread: readonly AgentMessage[]): number {
  let at = thread.length;
  while (at > 0 && (thread[at - 1] as { role?: string }).role === "user") at--;
  return at;
}

/** Main's parts and Sidebar's messages in the order they happened. */
export function interleave(parts: readonly AgentMessage[], threadAt: readonly number[], thread: readonly AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let next = 0;
  parts.forEach((part, i) => {
    const upto = Math.min(thread.length, Math.max(next, threadAt[i] ?? 0));
    out.push(...thread.slice(next, upto), part);
    next = upto;
  });
  out.push(...thread.slice(next));
  return out;
}
