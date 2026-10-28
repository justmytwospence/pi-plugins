import { expect, test } from "vitest";
import { DEFAULT_MODELS, cacheTtlMs, modelPlan, modelsConfig, providerTiers, shortModelId, switchWindow, tierQuestion } from "../src/models.ts";

const config = modelsConfig({
  mode: "auto",
  tiers: {
    anthropic: { fast: "anthropic/claude-haiku-4-5", balanced: "claude-sonnet-4-5", strong: "openai/gpt-5" },
  },
});

test("modelsConfig keeps valid values; invalid ones fall back", () => {
  expect(modelsConfig(undefined)).toEqual(DEFAULT_MODELS);
  expect(modelsConfig({ mode: "always", maxSwitchTokens: -1, tiers: { a: { fast: 3, strong: " a/x " }, b: "junk" } })).toEqual({
    mode: "off",
    maxSwitchTokens: 30_000,
    tiers: { a: { strong: "a/x" } },
  });
});

test("providerTiers: lowest first, bare ids on the provider, other providers skipped", () => {
  expect(providerTiers(config, "anthropic")).toEqual([
    { tier: "fast", provider: "anthropic", id: "claude-haiku-4-5" },
    { tier: "balanced", provider: "anthropic", id: "claude-sonnet-4-5" },
  ]);
  expect(providerTiers(config, "openai")).toEqual([]);
});

test("modelPlan: an unmapped manual model stands in for strong; nothing to choose gives undefined", () => {
  const opus = { provider: "anthropic", id: "claude-opus-4-5" };
  expect(modelPlan(config, opus, opus)).toEqual({
    tiers: [
      { tier: "fast", provider: "anthropic", id: "claude-haiku-4-5" },
      { tier: "balanced", provider: "anthropic", id: "claude-sonnet-4-5" },
      { tier: "strong", ...opus },
    ],
    manualTier: "strong",
    manual: opus,
  });
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
  expect(modelPlan(config, sonnet, sonnet)?.manualTier).toBe("balanced");
  expect(modelPlan(config, { provider: "openai", id: "gpt-5" }, { provider: "openai", id: "gpt-5" })).toBeUndefined();
  const single = modelsConfig({ tiers: { anthropic: { fast: "claude-haiku-4-5" } } });
  expect(modelPlan(single, { provider: "anthropic", id: "claude-haiku-4-5" }, { provider: "anthropic", id: "claude-haiku-4-5" })).toBeUndefined();
  expect(Object.keys(tierQuestion(modelPlan(config, opus, opus)!.tiers).criteria)).toEqual(["fast", "balanced", "strong"]);
});

test("switchWindow: first message, cold cache, or small context", () => {
  expect(switchWindow({ first: true, cold: false, tokens: 1e6, maxSwitchTokens: 30_000 })).toBe("first message");
  expect(switchWindow({ first: false, cold: true, tokens: 1e6, maxSwitchTokens: 30_000 })).toBe("cache is cold");
  expect(switchWindow({ first: false, cold: false, tokens: 29_999, maxSwitchTokens: 30_000 })).toBe("small context");
  expect(switchWindow({ first: false, cold: false, tokens: 30_000, maxSwitchTokens: 30_000 })).toBeUndefined();
  expect(switchWindow({ first: false, cold: false, tokens: null, maxSwitchTokens: 30_000 })).toBeUndefined();
});

test("cacheTtlMs: the model's promptCache, else 5 minutes or an hour with long retention", () => {
  expect(cacheTtlMs(undefined, {})).toBe(300_000);
  expect(cacheTtlMs(undefined, { PI_CACHE_RETENTION: "long" })).toBe(3_600_000);
  expect(cacheTtlMs(undefined, { PI_CACHE_RETENTION: "none" })).toBe(0);
  expect(cacheTtlMs({ promptCache: { short: 600, long: 7200 } }, {})).toBe(600_000);
  expect(cacheTtlMs({ promptCache: { short: 600, long: 7200 } }, { PI_CACHE_RETENTION: "long" })).toBe(7_200_000);
});

test("shortModelId", () => {
  expect(shortModelId("claude-sonnet-4-5-20250929")).toBe("sonnet-4-5");
  expect(shortModelId("anthropic/claude-haiku-4-5")).toBe("haiku-4-5");
  expect(shortModelId("gpt-5 (preview)")).toBe("gpt-5 preview");
});
