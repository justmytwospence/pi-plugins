// Builds the drafting request from the session's last provider request, byte for byte, with the
// drafting messages appended, so the provider serves the whole conversation from the prompt cache
// the session already wrote. Everything before the seam (model, system prompt, tools, thinking
// settings, cache keys, earlier messages and their breakpoints) is the session's. Anything
// unexpected fails, and the caller sends an ordinary uncached request instead.
//
// Adapted from pi-sidebar's splice.ts, trimmed to a one-shot request.

type Json = Record<string, unknown>;

export type SpliceResult = { ok: true; payload: Json } | { ok: false; reason: string };

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

const clone = <T>(value: T): T => structuredClone(value);

export function splicePayload(api: string, main: unknown, side: unknown): SpliceResult {
  if (!isObject(main)) return { ok: false, reason: "no copy of the session's last request" };
  if (!isObject(side)) return { ok: false, reason: "the drafting request is not an object" };
  if (!SUPPORTED_APIS.has(api)) return { ok: false, reason: `the ${api} API is not supported` };
  if (typeof main.model === "string" && typeof side.model === "string" && main.model !== side.model) {
    return { ok: false, reason: `the session's last request used ${main.model}` };
  }
  if (api === "anthropic-messages") return spliceAnthropic(main, side);
  if (api === "openai-completions") return spliceChat(main, side);
  return spliceResponses(main, side);
}

function blocksOf(message: unknown): Json[] {
  return isObject(message) && Array.isArray(message.content) ? (message.content as unknown[]).filter(isObject) : [];
}

function countBreakpoints(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, item) => n + countBreakpoints(item), 0);
  if (!isObject(value)) return 0;
  let n = value.cache_control !== undefined ? 1 : 0;
  if (Array.isArray(value.content)) n += countBreakpoints(value.content);
  return n;
}

function spliceAnthropic(main: Json, side: Json): SpliceResult {
  if (!Array.isArray(main.messages) || main.messages.length === 0) return { ok: false, reason: "the session's last request has no messages" };
  if (!Array.isArray(side.messages)) return { ok: false, reason: "the drafting request has no messages" };
  const mainMessages = clone(main.messages as unknown[]);
  const sideMessages = clone(side.messages as unknown[]);
  const sideBlocks = sideMessages.flatMap(blocksOf);
  for (const block of sideBlocks) delete block.cache_control;
  // One breakpoint at the end, so the follow-up request (after the questions) is cached too.
  const fixed = countBreakpoints(main.system) + countBreakpoints(main.tools) + countBreakpoints(mainMessages);
  if (fixed < ANTHROPIC_MAX_BREAKPOINTS) {
    const last = [...sideBlocks].reverse().find((b) => b.type === "text");
    if (last) last.cache_control = { type: "ephemeral" };
  }
  const payload: Json = { ...clone(main), messages: [...mainMessages, ...sideMessages], stream: true };
  return { ok: true, payload };
}

const isInstruction = (item: unknown) => isObject(item) && (item.role === "system" || item.role === "developer");

function dropLeadingInstructions(items: unknown[]): unknown[] {
  let i = 0;
  while (i < items.length && isInstruction(items[i])) i++;
  return items.slice(i);
}

function spliceResponses(main: Json, side: Json): SpliceResult {
  if (main.previous_response_id || side.previous_response_id) return { ok: false, reason: "chained responses cannot share a prefix" };
  if (!Array.isArray(main.input) || main.input.length === 0) return { ok: false, reason: "the session's last request has no input" };
  if (!Array.isArray(side.input)) return { ok: false, reason: "the drafting request has no input" };
  const payload: Json = { ...clone(main), input: [...clone(main.input as unknown[]), ...dropLeadingInstructions(clone(side.input as unknown[]))] };
  if ("stream" in side) payload.stream = side.stream;
  return { ok: true, payload };
}

function spliceChat(main: Json, side: Json): SpliceResult {
  if (!Array.isArray(main.messages) || main.messages.length === 0) return { ok: false, reason: "the session's last request has no messages" };
  if (!Array.isArray(side.messages)) return { ok: false, reason: "the drafting request has no messages" };
  const payload: Json = { ...clone(main), messages: [...clone(main.messages as unknown[]), ...dropLeadingInstructions(clone(side.messages as unknown[]))] };
  for (const key of ["stream", "stream_options"]) {
    if (key in side) payload[key] = side[key];
    else delete payload[key];
  }
  return { ok: true, payload };
}

/** Whether a provider request is the session's own conversation (not a side request on its model). */
export function isConversationRequest(payload: unknown, modelId: string | undefined, systemPrompt: string): boolean {
  if (!isObject(payload)) return false;
  if (modelId && typeof payload.model === "string" && payload.model !== modelId) return false;
  const probe = systemPrompt.trim().slice(0, 200);
  if (!probe) return true;
  const system = JSON.stringify([payload.system, payload.instructions, Array.isArray(payload.messages) ? payload.messages[0] : undefined, Array.isArray(payload.input) ? payload.input[0] : undefined]);
  return system.includes(JSON.stringify(probe).slice(1, -1));
}
