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

export function splicePayload(api: string, main: unknown, side: unknown): SpliceResult {
  if (!isObject(main)) return { ok: false, reason: "main's last request is missing" };
  if (!isObject(side)) return { ok: false, reason: "Sidebar's request is not an object" };
  if (!SUPPORTED_APIS.has(api)) return { ok: false, reason: `the ${api} API is not supported, so the cache cannot be shared` };
  if (typeof main.model === "string" && typeof side.model === "string" && main.model !== side.model) {
    return { ok: false, reason: `Sidebar is on ${side.model} but main is on ${main.model}` };
  }
  if (api === "anthropic-messages") return spliceAnthropic(main, side);
  if (api === "openai-completions") return spliceChat(main, side);
  return spliceResponses(main, side);
}

// ---------------------------------------------------------------- Anthropic Messages

function spliceAnthropic(main: Json, side: Json): SpliceResult {
  if (!Array.isArray(main.messages) || main.messages.length === 0) return { ok: false, reason: "main's last request has no messages" };
  if (!Array.isArray(side.messages)) return { ok: false, reason: "Sidebar's request has no messages" };
  const mainMessages = clone(main.messages as Json[]);
  const sideMessages = clone(side.messages as Json[]);
  const marker = lastBreakpoint(mainMessages);
  const payload: Json = {
    ...clone(main),
    messages: [...mainMessages, ...sideMessages],
    max_tokens: side.max_tokens ?? main.max_tokens,
    stream: true,
  };
  // Sidebar's own breakpoints may only follow main's, with main's TTL (a longer TTL after a shorter
  // one is rejected), and the whole request may carry at most four.
  const fixed = countBreakpoints(payload.system) + countBreakpoints(payload.tools) + countBreakpoints(mainMessages);
  let room = ANTHROPIC_MAX_BREAKPOINTS - fixed;
  if (room < 0) return { ok: false, reason: `main's request already carries ${fixed} cache breakpoints` };
  const sideBlocks = blocksWithBreakpoints(sideMessages);
  // Keep the latest ones: the trailing breakpoint lets a follow-up reuse Sidebar's own turn.
  for (let i = sideBlocks.length - 1; i >= 0; i--) {
    const block = sideBlocks[i]!;
    if (room > 0 && marker) {
      block.cache_control = clone(marker);
      room--;
    } else {
      delete block.cache_control;
    }
  }
  return { ok: true, payload, mainItems: mainMessages.length, sideItems: sideMessages.length };
}

function messageBlocks(message: Json): Json[] {
  return Array.isArray(message.content) ? (message.content as unknown[]).filter(isObject) : [];
}

function blocksWithBreakpoints(messages: Json[]): Json[] {
  return messages.flatMap(messageBlocks).filter((block) => block.cache_control !== undefined);
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

function lastBreakpoint(messages: Json[]): Json | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messageBlocks(messages[i]!);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const marker = blocks[j]!.cache_control;
      if (isObject(marker)) return marker;
    }
  }
  return undefined;
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
