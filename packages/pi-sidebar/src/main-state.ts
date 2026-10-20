// What Sidebar knows about the main session, kept in memory in main's own process: its last
// provider request exactly as sent (and which session entry it covered), and what it is doing this
// second (running tools, finished parallel results, the reply it is writing).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { summarizeArgs } from "./transcript.ts";

type Json = Record<string, unknown>;

export interface LiveTool {
  id: string;
  name: string;
  summary: string;
  startedAt: number;
}

/** A tool call that has finished but whose result main has not committed yet (parallel calls). */
export interface FinishedTool extends LiveTool {
  isError: boolean;
  durationMs?: number;
  preview: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What main is doing right now, beyond what its session has committed. */
export interface LiveState {
  state: "idle" | "working";
  since: number;
  tools: LiveTool[];
  finished: FinishedTool[];
  /** The tail of the reply main is streaming (text only, never thinking). */
  streaming?: string;
  lastUsage?: Usage;
}

/** Main's last conversation request. `payload` is the object the provider was sent. */
export interface MainRequest {
  api: string;
  provider: string;
  model: string;
  /** The session leaf when main built this request: entries after it are not in the payload. */
  leafId: string | null;
  sentAt: number;
  payload: Json;
}

const STREAM_TAIL_CHARS = 600;
const PREVIEW_CHARS = 1500;

/** The system prompt text a provider request carries, for telling main's own requests apart. */
export function payloadSystemText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Json;
  const parts: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === "object") {
      const v = value as Json;
      if (typeof v.text === "string") parts.push(v.text);
      else if (v.content !== undefined) collect(v.content);
    }
  };
  collect(p.system);
  collect(p.instructions);
  const list = Array.isArray(p.messages) ? p.messages : Array.isArray(p.input) ? p.input : [];
  const first = list[0] as Json | undefined;
  if (first && (first.role === "system" || first.role === "developer")) collect(first.content);
  return parts.join("\n");
}

/** Whether a request is one of main's conversation requests (not a summary or another session's). */
export function isConversationRequest(payload: unknown, modelId: string | undefined, systemPrompt: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Json;
  if (modelId && typeof p.model === "string" && p.model !== modelId) return false;
  const probe = systemPrompt.trim().slice(0, 200);
  return !probe || payloadSystemText(payload).includes(probe);
}

/** The text of a tool result, shortened, for the live note. */
export function resultPreview(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  const text = Array.isArray(content)
    ? content.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("\n")
    : typeof result === "string" ? result : "";
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}\n… (${trimmed.length - PREVIEW_CHARS} more characters)` : trimmed;
}

export class MainState {
  request: MainRequest | undefined;
  ctx: ExtensionContext | undefined;
  sessionId: string | undefined;
  readonly live: LiveState = { state: "idle", since: Date.now(), tools: [], finished: [] };
  private readonly listeners = new Set<() => void>();

  constructor(pi: ExtensionAPI, private readonly now = () => Date.now()) {
    pi.on("session_start", (_event, ctx) => this.bind(ctx));
    // After /tree or a compaction main's next request starts from a different history: the one in
    // memory no longer describes it, so Sidebar rebuilds from the session until main sends again.
    pi.on("session_tree", (_event, ctx) => { this.ctx = ctx; this.request = undefined; this.changed(); });
    pi.on("session_compact", (_event, ctx) => { this.ctx = ctx; this.request = undefined; this.changed(); });
    pi.on("model_select", (_event, ctx) => { this.ctx = ctx; this.changed(); });

    pi.on("before_provider_request", (event, ctx) => {
      const model = ctx.model;
      if (!model || !isConversationRequest(event.payload, model.id, ctx.getSystemPrompt())) return undefined;
      this.ctx = ctx;
      // A reference, not a copy: handlers that run later may still edit this object in place, and
      // Sidebar copies it only when it builds a request.
      this.request = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        leafId: ctx.sessionManager.getLeafId(),
        sentAt: this.now(),
        payload: event.payload as Json,
      };
      return undefined;
    });

    pi.on("agent_start", () => {
      Object.assign(this.live, { state: "working", since: this.now(), tools: [], finished: [], streaming: undefined });
      this.changed();
    });
    pi.on("agent_end", () => {
      Object.assign(this.live, { state: "idle", since: this.now(), tools: [], finished: [], streaming: undefined });
      this.changed();
    });
    pi.on("message_update", (event) => {
      if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
      const text = (event.message.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      if (!text) return;
      this.live.streaming = text.slice(-STREAM_TAIL_CHARS);
    });
    pi.on("message_end", (event) => {
      const message = event.message as { role: string; toolCallId?: string; usage?: Partial<Usage> };
      if (message.role === "toolResult") this.live.finished = this.live.finished.filter((t) => t.id !== message.toolCallId);
      if (message.role === "assistant") {
        this.live.streaming = undefined;
        if (message.usage) {
          this.live.lastUsage = {
            input: message.usage.input ?? 0,
            output: message.usage.output ?? 0,
            cacheRead: message.usage.cacheRead ?? 0,
            cacheWrite: message.usage.cacheWrite ?? 0,
          };
        }
      }
      this.changed();
    });
    pi.on("tool_execution_start", (event) => {
      if (event.parentToolCallId) return;
      const tool: LiveTool = { id: event.toolCallId, name: event.toolName, summary: summarizeArgs(event.args), startedAt: this.now() };
      this.live.tools = [...this.live.tools.filter((t) => t.id !== tool.id), tool];
      this.changed();
    });
    pi.on("tool_execution_end", (event) => {
      if (event.parentToolCallId) return;
      const started = this.live.tools.find((t) => t.id === event.toolCallId);
      this.live.tools = this.live.tools.filter((t) => t.id !== event.toolCallId);
      if (started) {
        const finished: FinishedTool = {
          ...started,
          isError: !!event.isError,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          preview: resultPreview(event.result),
        };
        this.live.finished = [...this.live.finished.filter((t) => t.id !== started.id), finished];
      }
      this.changed();
    });
  }

  bind(ctx: ExtensionContext): void {
    this.ctx = ctx;
    const id = ctx.sessionManager.getSessionId();
    if (id !== this.sessionId) {
      this.sessionId = id;
      this.request = undefined;
      Object.assign(this.live, { state: "idle", since: this.now(), tools: [], finished: [], streaming: undefined, lastUsage: undefined });
    }
    this.changed();
  }

  /**
   * Main's last answer on the current branch, from its session: when it was written and the prompt
   * tokens its request carried. Available after a restart or `/reload`, when nothing is in memory.
   */
  lastAnswer(): { at: number; promptTokens: number } | undefined {
    const branch = this.ctx?.sessionManager.getBranch() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type?: string; timestamp?: string; message?: { role?: string; timestamp?: number; usage?: Partial<Usage> } };
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const u = entry.message.usage;
      const at = typeof entry.message.timestamp === "number" ? entry.message.timestamp : Date.parse(entry.timestamp ?? "");
      return {
        at: Number.isFinite(at) ? at : 0,
        promptTokens: (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0),
      };
    }
    return undefined;
  }

  /** Prompt tokens of main's last request: from its usage, else its session, else its size. */
  promptTokens(): number {
    const u = this.live.lastUsage;
    if (u && u.input + u.cacheRead + u.cacheWrite > 0) return u.input + u.cacheRead + u.cacheWrite;
    const last = this.lastAnswer();
    if (last && last.promptTokens > 0) return last.promptTokens;
    return this.request ? Math.round(JSON.stringify(this.request.payload).length / 4) : 0;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a listener must not break main's events */ }
    }
  }
}
