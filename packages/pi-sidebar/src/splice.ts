// Builds Sidebar's provider request from main's last request, byte for byte, with Sidebar's own
// messages appended. Everything before the seam (model, system prompt, tool declarations, thinking
// and effort settings, cache keys, every earlier message and its cache breakpoint) is main's, so the
// provider serves it from the cache main already wrote. Anything unexpected fails closed.

type Json = Record<string, unknown>;

export type SpliceResult =
  | { ok: true; payload: Json; mainItems: number; sideItems: number }
  | { ok: false; reason: string };

/** APIs whose request shape this module knows. Anything else is refused, never guessed at. */
export const SUPPORTED_APIS = new Set([
  "anthropic-messages",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "openai-completions",
]);

const ANTHROPIC_MAX_BREAKPOINTS = 4;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface SpliceOptions {
  /**
   * Put Sidebar's own cache breakpoint on its part (Anthropic). Off for a one-shot request that
   * nothing reuses, which would only pay to write it.
   */
  sideBreakpoint?: boolean;
}

export function splicePayload(api: string, main: unknown, side: unknown, options: SpliceOptions = {}): SpliceResult {
  if (!isObject(main)) return { ok: false, reason: "main's last request is missing" };
  if (!isObject(side)) return { ok: false, reason: "Sidebar's request is not an object" };
  if (!SUPPORTED_APIS.has(api)) return { ok: false, reason: `the ${api} API is not supported, so the cache cannot be shared` };
  if (typeof main.model === "string" && typeof side.model === "string" && main.model !== side.model) {
    return { ok: false, reason: `Sidebar is on ${side.model} but main is on ${main.model}` };
  }
  if (api === "anthropic-messages") return spliceAnthropic(main, side, options.sideBreakpoint !== false);
  if (api === "openai-completions") return spliceChat(main, side);
  return spliceResponses(main, side);
}

// ---------------------------------------------------------------- Anthropic Messages

function spliceAnthropic(main: Json, side: Json, sideBreakpoint: boolean): SpliceResult {
  if (!Array.isArray(main.messages) || main.messages.length === 0) return { ok: false, reason: "main's last request has no messages" };
  if (!Array.isArray(side.messages)) return { ok: false, reason: "Sidebar's request has no messages" };
  const mainMessages = clone(main.messages as Json[]);
  const sideMessages = clone(side.messages as Json[]);
  const payload: Json = {
    ...clone(main),
    messages: [...mainMessages, ...sideMessages],
    max_tokens: side.max_tokens ?? main.max_tokens,
    stream: true,
  };
  const fixed = countBreakpoints(payload.system) + countBreakpoints(payload.tools) + countBreakpoints(mainMessages);
  if (fixed > ANTHROPIC_MAX_BREAKPOINTS) return { ok: false, reason: `main's request already carries ${fixed} cache breakpoints` };
  if (sideBreakpoint) placeSideBreakpoint(payload, sideMessages.flatMap(messageBlocks), fixed);
  else for (const block of sideMessages.flatMap(messageBlocks)) delete block.cache_control;
  return { ok: true, payload, mainItems: mainMessages.length, sideItems: sideMessages.length };
}

/** Sidebar's own breakpoint: 5 minutes, after every 1-hour one (Anthropic rejects the reverse). */
export const SIDE_BREAKPOINT = { type: "ephemeral" } as const;

const STATUS_PREFIX = "<sidebar-status";

export function isStatusBlock(block: Json): boolean {
  return block.type === "text" && typeof block.text === "string" && block.text.startsWith(STATUS_PREFIX);
}

/**
 * One breakpoint on Sidebar's own part, on its last block before the live status note (which comes
 * last and changes on every request). The next step of an answer, or the next question while main
 * is idle, then reads Sidebar's thread from the cache instead of sending it again.
 *
 * A request may carry four breakpoints. With a Claude subscription login main's already does: two
 * on the system prompt (Claude Code's identity line, then Pi's prompt), one on the tools, one at
 * the end of its conversation. The first is redundant, since the second covers more of the same
 * prefix, and a breakpoint only marks where an entry is written: removing it does not change what
 * main's prefix reads from the cache. Its slot goes to Sidebar.
 */
export function placeSideBreakpoint(payload: Json, sideBlocks: Json[], fixed: number): void {
  for (const block of sideBlocks) delete block.cache_control;
  let used = fixed;
  if (used >= ANTHROPIC_MAX_BREAKPOINTS) {
    const system = Array.isArray(payload.system) ? (payload.system as unknown[]).filter(isObject) : [];
    const marked = system.filter((block) => block.cache_control !== undefined);
    if (marked.length < 2) return;
    delete marked[0]!.cache_control;
    used--;
  }
  for (let i = sideBlocks.length - 1; i >= 0; i--) {
    const block = sideBlocks[i]!;
    if (isStatusBlock(block) || block.type === "thinking" || block.type === "redacted_thinking") continue;
    block.cache_control = { ...SIDE_BREAKPOINT };
    return;
  }
}

function messageBlocks(message: Json): Json[] {
  return Array.isArray(message.content) ? (message.content as unknown[]).filter(isObject) : [];
}

function countBreakpoints(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((n, item) => n + countBreakpoints(item), 0);
  }
  if (!isObject(value)) return 0;
  let n = value.cache_control !== undefined ? 1 : 0;
  if (Array.isArray(value.content)) n += countBreakpoints(value.content);
  return n;
}


// ---------------------------------------------------------------- OpenAI Responses (and Codex)

function isInstructionItem(item: unknown): boolean {
  return isObject(item) && (item.role === "system" || item.role === "developer");
}

function dropLeadingInstructions(items: unknown[]): unknown[] {
  let i = 0;
  while (i < items.length && isInstructionItem(items[i])) i++;
  return items.slice(i);
}

function spliceResponses(main: Json, side: Json): SpliceResult {
  if (main.previous_response_id || side.previous_response_id) {
    return { ok: false, reason: "requests chained by previous_response_id cannot share a prefix" };
  }
  if (!Array.isArray(main.input) || main.input.length === 0) return { ok: false, reason: "main's last request has no input" };
  if (!Array.isArray(side.input)) return { ok: false, reason: "Sidebar's request has no input" };
  const mainInput = clone(main.input as unknown[]);
  const sideInput = dropLeadingInstructions(clone(side.input as unknown[]));
  const payload: Json = { ...clone(main), input: [...mainInput, ...sideInput] };
  if ("stream" in side) payload.stream = side.stream;
  if ("max_output_tokens" in side) payload.max_output_tokens = side.max_output_tokens;
  else delete payload.max_output_tokens;
  return { ok: true, payload, mainItems: mainInput.length, sideItems: sideInput.length };
}

// ---------------------------------------------------------------- OpenAI Chat Completions

function spliceChat(main: Json, side: Json): SpliceResult {
  if (!Array.isArray(main.messages) || main.messages.length === 0) return { ok: false, reason: "main's last request has no messages" };
  if (!Array.isArray(side.messages)) return { ok: false, reason: "Sidebar's request has no messages" };
  const mainMessages = clone(main.messages as unknown[]);
  const sideMessages = dropLeadingInstructions(clone(side.messages as unknown[]));
  const payload: Json = { ...clone(main), messages: [...mainMessages, ...sideMessages] };
  for (const key of ["stream", "stream_options", "max_tokens", "max_completion_tokens"]) {
    if (key in side) payload[key] = side[key];
    else delete payload[key];
  }
  return { ok: true, payload, mainItems: mainMessages.length, sideItems: sideMessages.length };
}

/** An empty request the provider rejects without generating, for when aborting is not enough. */
export function inertPayload(api: string, side: unknown): unknown {
  if (!isObject(side)) return side;
  if (api === "anthropic-messages" || api === "openai-completions") return { ...side, messages: [] };
  return { ...side, input: [] };
}

/** The cache TTL main's request asked for, in milliseconds. */
export function requestedCacheTtlMs(api: string, payload: unknown): number {
  if (!isObject(payload)) return 5 * 60_000;
  if (api === "anthropic-messages") {
    const ttl = JSON.stringify([payload.system, payload.tools, payload.messages]).includes('"ttl":"1h"');
    return ttl ? 60 * 60_000 : 5 * 60_000;
  }
  // OpenAI keeps prompt caches for minutes in memory, up to 24h with extended retention.
  if (payload.prompt_cache_retention === "24h") return 24 * 60 * 60_000;
  return 5 * 60_000;
}
