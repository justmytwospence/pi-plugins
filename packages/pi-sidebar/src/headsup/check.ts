// One heads-up check: main's last provider request, byte for byte (so main's prompt cache serves
// it), plus main's activity since, heads-up mode's fixed instructions and the status. A single
// request through main's model registry, outside any Pi session, so main's extensions never see it.
// Share drafts (a blog draft from a share note) go through the same request with other instructions.
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { anchorPayload, cachePreflight, mainLabel, MISS_MIN_TOKENS, MISS_RATIO, replayMessages } from "../child.ts";
import { derivedSessionId, type TranscriptParts } from "../foreign.ts";
import type { ModelLike } from "../models.ts";
import type { MainState } from "../main-state.ts";
import { requestedCacheTtlMs, splicePayload } from "../splice.ts";
import { describeLive, mainDelta } from "../transcript.ts";
import type { CheckUsage } from "./mode.ts";
import { foreignHeadsUpIntro, HEADSUP_SYSTEM, headsUpRole, headsUpStatus } from "./prompt.ts";
import { parseHeadsUp, replyOf, type HeadsUpNote } from "./protocol.ts";

export type CheckResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string; usage?: CheckUsage }
  | { outcome: "none" | "note"; note?: HeadsUpNote; usage: CheckUsage; missed: boolean; raw: string; cacheTtlMs?: number };

type StreamLike = { result(): Promise<unknown> };
/** `modelRegistry.streamSimple`, injectable for tests. */
export type StreamFn = (model: unknown, context: unknown, options: Record<string, unknown>) => StreamLike;

export interface CheckInput {
  main: MainState;
  known: readonly string[];
  recent: readonly string[];
  thinking?: string;
  now?: number;
  signal?: AbortSignal;
  stream?: StreamFn;
  /** Check on another model than main's, reading main's session as a transcript. */
  foreign?: ForeignCheck;
  /** Whether the check may also suggest something worth sharing. */
  share?: boolean;
}

export interface ForeignCheck {
  model: ModelLike;
  label: string;
  thinking?: string;
  /** The checks' own transcript parts (their cache is apart from Sidebar's questions'). */
  parts: TranscriptParts;
  /** Whether the model's own cache should still hold the transcript (the last check was within its TTL). */
  warm: boolean;
}

const HEADSUP_SEAM = (text: string): boolean => text.startsWith("<sidebar-headsup>\n");

function userText(text: string, now: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: now } as AgentMessage;
}

/** The messages after main's request: its activity since, the instructions, then the status. */
export function checkMessages(delta: readonly AgentMessage[], liveText: string, known: readonly string[], recent: readonly string[], now: number, share = false): AgentMessage[] {
  return sideMessages(delta, headsUpRole(share), headsUpStatus({ liveText, known, recent, now }), now);
}

function sideMessages(delta: readonly AgentMessage[], instructions: string, status: string, now: number): AgentMessage[] {
  return [...delta, userText(`<sidebar-headsup>\n${instructions}\n</sidebar-headsup>`, now), userText(status, now)];
}

export interface SideInput {
  main: MainState;
  thinking?: string;
  now?: number;
  signal?: AbortSignal;
  stream?: StreamFn;
  foreign?: ForeignCheck;
  /** Fixed instructions (the cached part of a foreign request ends just before them). */
  instructions: string;
  /** The part after them, given main's live state. */
  status: (liveText: string) => string;
  maxTokens?: number;
}

export type SideReply =
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string; usage?: CheckUsage }
  | { outcome: "reply"; text: string; toolCalls: number; usage: CheckUsage; missed: boolean; cacheTtlMs?: number };

/** One side request about main's session, on main's cache or on another model's. */
export async function sideRequest(input: SideInput): Promise<SideReply> {
  if (input.foreign) return foreignRequest(input, input.foreign);
  const now = input.now ?? Date.now();
  const { main } = input;
  const ctx = main.ctx;
  const request = main.request;
  if (!ctx) return { outcome: "skipped", reason: "main's session is not ready" };
  if (!request) return { outcome: "skipped", reason: "no copy of main's last request in memory" };
  const cache = cachePreflight(main, now);
  if (cache.kind === "refuse") return { outcome: "skipped", reason: cache.reason };
  if (cache.kind === "confirm") return { outcome: "skipped", reason: "main's prompt cache has probably expired" };
  const model = ctx.modelRegistry.find(request.provider, request.model);
  if (!model) return { outcome: "skipped", reason: `main's model ${request.provider}/${request.model} is not available` };

  const delta = mainDelta(ctx.sessionManager.getEntries() as never, request.leafId, ctx.sessionManager.getLeafId());
  if (delta.skipped) return { outcome: "skipped", reason: delta.skipped };
  const liveText = describeLive(main.live, delta, now);
  const messages = convertToLlm(sideMessages(delta.messages, input.instructions, input.status(liveText), now));

  let spliceError: string | undefined;
  const stream: StreamFn = input.stream ?? ((m, c, o) => ctx.modelRegistry.streamSimple(m as never, c as never, o as never));
  let message: Reply;
  try {
    message = (await stream(model, { systemPrompt: "", messages, tools: [] }, {
      ...(main.sessionId ? { sessionId: main.sessionId } : {}),
      ...(input.thinking && input.thinking !== "off" ? { reasoning: input.thinking } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
      maxRetries: 1,
      onPayload: (side: unknown) => {
        const result = splicePayload(request.api, request.payload, side, { sideBreakpoint: false });
        if (result.ok) return result.payload;
        // Never send a request that does not start with main's: abort before anything is generated.
        spliceError = result.reason;
        throw new Error(`heads-up check not sent: ${result.reason}`);
      },
    }).result()) as Reply;
  } catch (error) {
    if (spliceError) return { outcome: "skipped", reason: spliceError };
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (spliceError) return { outcome: "skipped", reason: spliceError };
  const usage = usageOf(message);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { outcome: "failed", reason: message.errorMessage ?? message.stopReason, usage };
  }
  const expected = main.promptTokens();
  const missed = expected >= MISS_MIN_TOKENS && usage.cacheRead < expected * MISS_RATIO;
  return { outcome: "reply", ...replyOf(message), usage, missed };
}

export async function runCheck(input: CheckInput): Promise<CheckResult> {
  const reply = await sideRequest({
    main: input.main,
    ...(input.thinking ? { thinking: input.thinking } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.stream ? { stream: input.stream } : {}),
    ...(input.foreign ? { foreign: input.foreign } : {}),
    instructions: headsUpRole(!!input.share),
    status: (liveText) => headsUpStatus({ liveText, known: input.known, recent: input.recent, now: input.now ?? Date.now() }),
  });
  if (reply.outcome !== "reply") return reply;
  const note = parseHeadsUp(reply);
  const extra = reply.cacheTtlMs !== undefined ? { cacheTtlMs: reply.cacheTtlMs } : {};
  const base = { usage: reply.usage, missed: reply.missed, raw: reply.text, ...extra };
  return note ? { outcome: "note", note, ...base } : { outcome: "none", ...base };
}

type Reply = { content?: unknown; usage?: Partial<CheckUsage>; stopReason?: string; errorMessage?: string };

function usageOf(message: Reply): CheckUsage {
  return {
    input: message.usage?.input ?? 0,
    output: message.usage?.output ?? 0,
    cacheRead: message.usage?.cacheRead ?? 0,
    cacheWrite: message.usage?.cacheWrite ?? 0,
  };
}

/**
 * A request on another model: main's session as a transcript (the checks' own parts, so their cache
 * builds up check by check), the instructions, then the status. Main's request is not needed.
 */
async function foreignRequest(input: SideInput, foreign: ForeignCheck): Promise<SideReply> {
  const now = input.now ?? Date.now();
  const { main } = input;
  const ctx = main.ctx;
  if (!ctx) return { outcome: "skipped", reason: "main's session is not ready" };
  const view = foreign.parts.build(replayMessages(ctx, false).messages, foreign.model.contextWindow, now);
  if (view.messages.length === 0) return { outcome: "skipped", reason: "main's session has nothing to read yet" };
  const liveText = describeLive(main.live, { messages: [], pending: view.pending }, now);
  const intro = foreignHeadsUpIntro({ sidebar: foreign.label, main: mainLabel(ctx) });
  const messages = convertToLlm(sideMessages(view.messages, `${intro}\n\n${input.instructions}`, input.status(liveText), now));
  const stream: StreamFn = input.stream ?? ((m, c, o) => ctx.modelRegistry.streamSimple(m as never, c as never, o as never));
  const thinking = foreign.thinking ?? input.thinking;
  const mainId = main.sessionId ?? ctx.sessionManager.getSessionId();
  let cacheTtlMs: number | undefined;
  let message: Reply;
  try {
    message = (await stream(foreign.model, { systemPrompt: HEADSUP_SYSTEM, messages, tools: [] }, {
      ...(mainId ? { sessionId: derivedSessionId(mainId, "headsup") } : {}),
      ...(thinking && thinking !== "off" ? { reasoning: thinking } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
      maxRetries: 1,
      // One breakpoint where the transcript ends: the next check reads it from the cache.
      onPayload: (payload: unknown) => {
        const out = anchorPayload(foreign.model.api, payload, HEADSUP_SEAM, false);
        cacheTtlMs = requestedCacheTtlMs(foreign.model.api, out);
        return out;
      },
    }).result()) as Reply;
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const usage = usageOf(message);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { outcome: "failed", reason: message.errorMessage ?? message.stopReason, usage };
  }
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  // Only a check its own cache should have served can miss it.
  const missed = foreign.warm && view.continued && total >= MISS_MIN_TOKENS && usage.cacheRead < total * MISS_RATIO;
  return { outcome: "reply", ...replyOf(message), usage, missed, ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}) };
}
