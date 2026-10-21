// One heads-up check: main's last provider request, byte for byte (so main's prompt cache serves
// it), plus main's activity since, heads-up mode's fixed instructions and the status. A single
// request through main's model registry, outside any Pi session, so main's extensions never see it.
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cachePreflight, MISS_MIN_TOKENS, MISS_RATIO } from "../child.ts";
import type { MainState } from "../main-state.ts";
import { splicePayload } from "../splice.ts";
import { describeLive, mainDelta } from "../transcript.ts";
import type { CheckUsage } from "./mode.ts";
import { HEADSUP_ROLE, headsUpStatus } from "./prompt.ts";
import { parseHeadsUp, replyOf, type HeadsUpNote } from "./protocol.ts";

export type CheckResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string; usage?: CheckUsage }
  | { outcome: "none" | "note"; note?: HeadsUpNote; usage: CheckUsage; missed: boolean; raw: string };

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
}

function userText(text: string, now: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: now } as AgentMessage;
}

/** The messages after main's request: its activity since, the instructions, then the status. */
export function checkMessages(delta: readonly AgentMessage[], liveText: string, known: readonly string[], recent: readonly string[], now: number): AgentMessage[] {
  return [
    ...delta,
    userText(`<sidebar-headsup>\n${HEADSUP_ROLE}\n</sidebar-headsup>`, now),
    userText(headsUpStatus({ liveText, known, recent, now }), now),
  ];
}

export async function runCheck(input: CheckInput): Promise<CheckResult> {
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
  const messages = convertToLlm(checkMessages(delta.messages, liveText, input.known, input.recent, now));

  let spliceError: string | undefined;
  const stream: StreamFn = input.stream ?? ((m, c, o) => ctx.modelRegistry.streamSimple(m as never, c as never, o as never));
  let message: { content?: unknown; usage?: Partial<CheckUsage>; stopReason?: string; errorMessage?: string };
  try {
    message = (await stream(model, { systemPrompt: "", messages, tools: [] }, {
      ...(main.sessionId ? { sessionId: main.sessionId } : {}),
      ...(input.thinking && input.thinking !== "off" ? { reasoning: input.thinking } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      maxRetries: 1,
      onPayload: (side: unknown) => {
        const result = splicePayload(request.api, request.payload, side, { sideBreakpoint: false });
        if (result.ok) return result.payload;
        // Never send a request that does not start with main's: abort before anything is generated.
        spliceError = result.reason;
        throw new Error(`heads-up check not sent: ${result.reason}`);
      },
    }).result()) as typeof message;
  } catch (error) {
    if (spliceError) return { outcome: "skipped", reason: spliceError };
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (spliceError) return { outcome: "skipped", reason: spliceError };
  const usage: CheckUsage = {
    input: message.usage?.input ?? 0,
    output: message.usage?.output ?? 0,
    cacheRead: message.usage?.cacheRead ?? 0,
    cacheWrite: message.usage?.cacheWrite ?? 0,
  };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { outcome: "failed", reason: message.errorMessage ?? message.stopReason, usage };
  }
  const expected = main.promptTokens();
  const missed = expected >= MISS_MIN_TOKENS && usage.cacheRead < expected * MISS_RATIO;
  const reply = replyOf(message);
  const note = parseHeadsUp(reply);
  return note ? { outcome: "note", note, usage, missed, raw: reply.text } : { outcome: "none", usage, missed, raw: reply.text };
}
