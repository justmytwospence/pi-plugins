import { describe, expect, test } from "vitest";

import { cachePolicy, echoedRetention, requestedTtl } from "../src/policy.ts";

const MIN = 60_000;
const sol56 = { provider: "openai", id: "gpt-5.6-sol", api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true } };
const gpt55 = { provider: "openai", id: "gpt-5.5", api: "openai-responses", compat: {} };
const codex = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" };

describe("cachePolicy", () => {
  test("Pi's promptCache metadata is a guaranteed minimum", () => {
    const opus = { provider: "anthropic", id: "claude-opus-5-5", promptCache: { short: 300, long: 3600 } };
    expect(cachePolicy(opus, {}, false)).toMatchObject({ ttlMs: 5 * MIN, guaranteed: true });
    expect(cachePolicy(opus, { PI_CACHE_RETENTION: "long" }, true)).toMatchObject({ ttlMs: 60 * MIN, guaranteed: true });
  });

  test("GPT-5.6+ on an API key: 30 minutes minimum, 12 hours when requested", () => {
    expect(cachePolicy(sol56, {}, false)).toMatchObject({ ttlMs: 30 * MIN, guaranteed: true });
    expect(cachePolicy(sol56, {}, false, { ttl: "30m" })).toMatchObject({ ttlMs: 30 * MIN, guaranteed: true });
    expect(cachePolicy(sol56, {}, false, { ttl: "12h" })).toMatchObject({ ttlMs: 12 * 60 * MIN, guaranteed: true });
    // An unknown value falls back to the default the API applies.
    expect(cachePolicy(sol56, {}, false, { ttl: "7d" })).toMatchObject({ ttlMs: 30 * MIN });
  });

  test("the retention regime has no minimum: a typical lifetime", () => {
    // A ChatGPT sign-in, the Codex backend and older models use prompt_cache_retention.
    expect(cachePolicy(sol56, {}, true)).toMatchObject({ ttlMs: 30 * MIN, guaranteed: false });
    expect(cachePolicy(codex, {}, true)).toMatchObject({ ttlMs: 30 * MIN, guaranteed: false });
    expect(cachePolicy(gpt55, { PI_CACHE_RETENTION: "long" }, false)).toMatchObject({ ttlMs: 30 * MIN, guaranteed: false });
    expect(cachePolicy(codex, {}, true, { retention: "in_memory" })).toMatchObject({ ttlMs: 10 * MIN, guaranteed: false });
    expect(cachePolicy(codex, {}, true, { retention: "24h" })!.source).toContain("prompt_cache_retention 24h: typically about 30m");
  });

  test("other providers document nothing; none caches nothing", () => {
    expect(cachePolicy({ provider: "openrouter", id: "openai/gpt-6.1-sol" }, {}, false)).toBeUndefined();
    expect(cachePolicy(sol56, { PI_CACHE_RETENTION: "none" }, false)).toBeNull();
  });
});

describe("wire", () => {
  test("the requested ttl, and the retention OpenAI echoes", () => {
    expect(requestedTtl({ model: "gpt-5.6-sol", prompt_cache_options: { ttl: "12h" } })).toEqual({ model: "gpt-5.6-sol", ttl: "12h" });
    expect(requestedTtl({ model: "gpt-5.6-sol" })).toEqual({ model: "gpt-5.6-sol", ttl: undefined });
    expect(requestedTtl({ messages: [] })).toBeUndefined();
    expect(echoedRetention({ type: "response.completed", response: { prompt_cache_retention: "24h" } })).toBe("24h");
    expect(echoedRetention({ type: "response.output_text.delta", delta: "x" })).toBeUndefined();
  });
});
