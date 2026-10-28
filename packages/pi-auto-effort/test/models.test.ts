import { expect, test } from "vitest";
import {
  DEFAULT_MODELS,
  cacheTtlMs,
  canStepUp,
  compareIds,
  lastCacheActivity,
  modelPlan,
  modelsConfig,
  newestId,
  pickTier,
  presetTierOf,
  presetTiers,
  providerTiers,
  shortModelId,
  switchWindow,
  tierOf,
  tierQuestion,
} from "../src/models.ts";

const config = modelsConfig({
  mode: "auto",
  tiers: {
    anthropic: { fast: "anthropic/claude-haiku-4-5", balanced: "claude-sonnet-4-5", strong: "openai/gpt-5" },
  },
});

test("modelsConfig keeps valid values; invalid ones fall back", () => {
  expect(modelsConfig(undefined)).toEqual(DEFAULT_MODELS);
  expect(DEFAULT_MODELS.mode).toBe("auto");
  // The retired suggest mode falls back to the default.
  expect(modelsConfig({ mode: "suggest" }).mode).toBe("auto");
  expect(modelsConfig({ mode: "off" }).mode).toBe("off");
  expect(modelsConfig({ mode: "always", maxSwitchTokens: -1, tiers: { a: { fast: 3, strong: " a/x " }, b: "junk" } })).toEqual({
    mode: "auto",
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
    preset: false,
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

/** Pi's registry for these providers, as of this writing. */
const REGISTRY = [
  ...["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"],
  ...["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5"],
].map((id) => ({ provider: "anthropic", id }));
const CODEX = ["gpt-5.3-codex-spark", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"].map((id) => ({
  provider: "openai-codex",
  id,
}));

test("compareIds and newestId: numeric-aware, dated snapshots skipped when an alias exists", () => {
  const sorted = ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-5-5", "claude-sonnet-4-5", "claude-sonnet-10"].sort(compareIds);
  expect(sorted).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5", "claude-sonnet-10"]);
  expect(newestId(["gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-sol"])).toBe("gpt-6.1-sol");
  expect(newestId(["claude-opus-4-5", "claude-opus-4-5-20251101"])).toBe("claude-opus-4-5");
  // Without its alias a dated id counts.
  expect(newestId(["claude-opus-4-1", "claude-opus-4-5-20251101"])).toBe("claude-opus-4-5-20251101");
  expect(newestId([])).toBeUndefined();
});

test("presets: Sonnet and Opus on anthropic, Terra and Sol on openai-codex, the newest available, no fast tier", () => {
  expect(presetTiers("anthropic", [...REGISTRY, ...CODEX])).toEqual([
    { tier: "balanced", provider: "anthropic", id: "claude-sonnet-5-5" },
    { tier: "strong", provider: "anthropic", id: "claude-opus-5-5" },
  ]);
  expect(presetTiers("openai-codex", [...REGISTRY, ...CODEX])).toEqual([
    { tier: "balanced", provider: "openai-codex", id: "gpt-5.6-terra" },
    { tier: "strong", provider: "openai-codex", id: "gpt-6.1-sol" },
  ]);
  // Only what has credentials: the newest available, not the newest known.
  expect(presetTiers("anthropic", REGISTRY.filter((m) => !m.id.endsWith("5-5")))).toEqual([
    { tier: "balanced", provider: "anthropic", id: "claude-sonnet-5" },
    { tier: "strong", provider: "anthropic", id: "claude-opus-5" },
  ]);
  expect(presetTiers("openai", [{ provider: "openai", id: "gpt-5" }])).toEqual([]);
  expect(presetTierOf("anthropic", "claude-sonnet-4-5")).toBe("balanced");
  expect(presetTierOf("anthropic", "claude-haiku-4-5")).toBeUndefined();
  expect(presetTierOf("openai-codex", "gpt-6-sol")).toBe("strong");
});

test("modelPlan with a preset: an older model of a family keeps its tier; an explicit entry replaces the preset", () => {
  const preset = modelsConfig({});
  const opus = { provider: "anthropic", id: "claude-opus-5-5" };
  expect(modelPlan(preset, opus, opus, REGISTRY)).toEqual({
    tiers: [
      { tier: "balanced", provider: "anthropic", id: "claude-sonnet-5-5" },
      { tier: "strong", provider: "anthropic", id: "claude-opus-5-5" },
    ],
    manualTier: "strong",
    manual: opus,
    preset: true,
  });
  // Your older Sonnet is your balanced model: picking balanced keeps it.
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
  const plan = modelPlan(preset, sonnet, sonnet, REGISTRY)!;
  expect(plan.manualTier).toBe("balanced");
  expect(pickTier(plan, { balanced: 0.9, strong: 0.1 }, 0.5, "free", "anthropic").target).toEqual(sonnet);
  expect(pickTier(plan, { balanced: 0.3, strong: 0.7 }, 0.5, "free", "anthropic")).toMatchObject({ tier: "strong", target: { id: "claude-opus-5-5" } });
  expect(pickTier(plan, { balanced: 0.3, strong: 0.7 }, 0.5, "ceiling", "anthropic").target).toEqual(sonnet);
  expect(tierOf(plan, { provider: "anthropic", id: "claude-sonnet-5" })).toBe("balanced");
  const explicit = modelsConfig({ tiers: { anthropic: { fast: "claude-haiku-4-5", strong: "claude-opus-4-5" } } });
  expect(modelPlan(explicit, opus, opus, REGISTRY)?.tiers.map((t) => t.id)).toEqual(["claude-haiku-4-5", "claude-opus-4-5"]);
  // No preset, no entry: nothing to choose.
  expect(modelPlan(preset, { provider: "openai", id: "gpt-5" }, { provider: "openai", id: "gpt-5" }, REGISTRY)).toBeUndefined();
});

test("canStepUp: only when the bounds leave a stronger tier", () => {
  const opus = { provider: "anthropic", id: "claude-opus-5-5" };
  const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5" };
  const fromOpus = modelPlan(modelsConfig({}), opus, opus, REGISTRY)!;
  expect(canStepUp(fromOpus, opus, "free")).toBe(false);
  expect(canStepUp(fromOpus, sonnet, "ceiling")).toBe(true);
  const fromSonnet = modelPlan(modelsConfig({}), sonnet, sonnet, REGISTRY)!;
  expect(canStepUp(fromSonnet, sonnet, "free")).toBe(true);
  expect(canStepUp(fromSonnet, sonnet, "ceiling")).toBe(false);
});

test("lastCacheActivity: the last answer, or a cache-warming refresh after it", () => {
  const T = Date.UTC(2026, 0, 1);
  const answer = (at: number) => ({ type: "message", timestamp: new Date(at + 5).toISOString(), message: { role: "assistant", timestamp: at } });
  const warm = (at: number) => ({ type: "usage", kind: "cache_warm", timestamp: new Date(at).toISOString() });
  expect(lastCacheActivity([])).toBeUndefined();
  expect(lastCacheActivity([answer(T)])).toBe(T);
  expect(lastCacheActivity([answer(T), warm(T + 240_000), warm(T + 480_000), { type: "message", message: { role: "user" } }])).toBe(T + 480_000);
  // A warm before the last answer is older than it.
  expect(lastCacheActivity([warm(T + 999_000), answer(T + 1_000_000)])).toBe(T + 1_000_000);
  expect(lastCacheActivity([{ type: "usage", kind: "other", timestamp: new Date(T + 1).toISOString() }, warm(T)])).toBe(T);
});
