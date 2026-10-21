// How long a model's prompt cache lives, as precisely as its provider documents it. Pi-only.
//
// - Pi's `promptCache` metadata (Anthropic: 5 minutes, or 1 hour with PI_CACHE_RETENTION=long) is a
//   guaranteed minimum.
// - OpenAI API GPT-5.6 and later (`prompt_cache_options`): a guaranteed minimum of 30 minutes, or 12
//   hours when the request asks for `ttl: "12h"`, refreshed by every read.
// - OpenAI's older regime (`prompt_cache_retention`): no minimum. `24h` entries typically last about
//   30 minutes, `in_memory` ones 5 to 10 minutes. The ChatGPT backends (openai-codex, and `openai`
//   with a ChatGPT sign-in) use it for every model: they echo `prompt_cache_retention: "24h"` and
//   reject `prompt_cache_options`.
//
// What the provider actually applied wins over what the metadata implies: the `ttl` Pi sent, and the
// `prompt_cache_retention` OpenAI echoes in each response.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** OpenAI `prompt_cache_retention`: how long entries typically last (not a guarantee). */
const RETENTION_TYPICAL_MS: Record<string, number> = { "24h": 30 * MINUTE, in_memory: 10 * MINUTE };
/** OpenAI `prompt_cache_options.ttl`: guaranteed minimum lifetimes. */
const OPTIONS_TTL_MS: Record<string, number> = { "30m": 30 * MINUTE, "12h": 12 * HOUR };

export interface CachePolicy {
  ttlMs: number;
  /** A documented minimum. Otherwise a typical lifetime: past it the cache is probably, not certainly, cold. */
  guaranteed: boolean;
  /** Where the lifetime comes from, for `/cache-guard status`. */
  source: string;
}

/** What the wire said about one model's cache: the `ttl` Pi requested, the retention OpenAI applied. */
export interface Wire {
  ttl?: string;
  retention?: string;
}

interface ModelLike {
  provider: string;
  id: string;
  api?: string;
  promptCache?: { short?: number; long?: number };
  compat?: { supportsExplicitPromptCacheMode?: boolean; supportsLongCacheRetention?: boolean };
}

/**
 * The cache lifetime of requests to `model`. `null`: nothing is cached (PI_CACHE_RETENTION=none).
 * `undefined`: the provider documents nothing, so the caller falls back to an idle-time guess.
 * `oauth`: the model is used through a subscription sign-in rather than an API key.
 */
export function cachePolicy(model: ModelLike, env: NodeJS.ProcessEnv, oauth: boolean, wire: Wire = {}): CachePolicy | null | undefined {
  if (env.PI_CACHE_RETENTION === "none") return null;
  const long = env.PI_CACHE_RETENTION === "long";
  const seconds = model.promptCache?.[long ? "long" : "short"];
  if (seconds !== undefined) {
    return { ttlMs: seconds * 1000, guaranteed: true, source: long ? "PI_CACHE_RETENTION=long" : "short retention" };
  }
  if (model.provider !== "openai" && model.provider !== "openai-codex") return undefined;
  // GPT-5.6 and later on the API: a minimum lifetime, 30 minutes unless the request asked for more.
  if (model.provider === "openai" && model.api === "openai-responses" && model.compat?.supportsExplicitPromptCacheMode && !oauth) {
    const ttl = wire.ttl !== undefined && OPTIONS_TTL_MS[wire.ttl] !== undefined ? wire.ttl : "30m";
    return { ttlMs: OPTIONS_TTL_MS[ttl]!, guaranteed: true, source: `OpenAI prompt_cache_options.ttl ${ttl}${wire.ttl === undefined ? " (default)" : ""}` };
  }
  // Everything else OpenAI serves: retention without a minimum. Organizations without Zero Data
  // Retention, and the ChatGPT backends, default to 24h.
  const retention = wire.retention !== undefined && RETENTION_TYPICAL_MS[wire.retention] !== undefined ? wire.retention : "24h";
  const typical = RETENTION_TYPICAL_MS[retention]!;
  const seen = wire.retention === undefined ? " (default)" : "";
  return { ttlMs: typical, guaranteed: false, source: `OpenAI prompt_cache_retention ${retention}${seen}: typically about ${typical / MINUTE}m, no guaranteed minimum` };
}

/** The model a request payload is for, and the `prompt_cache_options.ttl` it asks OpenAI for (none: the default). */
export function requestedTtl(payload: unknown): { model: string; ttl?: string } | undefined {
  const body = payload as { model?: unknown; prompt_cache_options?: { ttl?: unknown } | null } | undefined;
  if (typeof body?.model !== "string") return undefined;
  const ttl = body.prompt_cache_options?.ttl;
  return { model: body.model, ttl: typeof ttl === "string" ? ttl : undefined };
}

/** The `prompt_cache_retention` an OpenAI Responses stream event reports the server applied. */
export function echoedRetention(data: unknown): string | undefined {
  const event = data as { type?: unknown; response?: { prompt_cache_retention?: unknown } } | undefined;
  if (event?.type !== "response.created" && event?.type !== "response.completed" && event?.type !== "response.done") return undefined;
  const retention = event.response?.prompt_cache_retention;
  return typeof retention === "string" ? retention : undefined;
}
