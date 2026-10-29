import { expect, test } from "vitest";
import { GENERAL, parseAgent } from "../src/agents.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TIER_DESCRIPTIONS, newestFirst, pickQuestions, providerTiers, readPicks, resolve, theta } from "../src/pick.ts";

const scout = parseAgent("---\nname: scout\ndescription: Fast recon\ntools: read, grep\nmodel: anthropic/claude-haiku-5\n---\nYou are a scout.", "user")!;
const reviewer = parseAgent("---\nname: reviewer\ndescription: Code review\nthinking: high\n---\nReview carefully.", "project")!;
const agents = [GENERAL, scout, reviewer];
const tiers = { models: { fast: "anthropic/claude-haiku-5", strong: "anthropic/claude-opus-5-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS };
const parent = { model: "anthropic/claude-sonnet-5-5", thinking: "medium" };

test("parseAgent reads frontmatter", () => {
  expect(scout).toMatchObject({ name: "scout", tools: ["read", "grep"], model: "anthropic/claude-haiku-5", prompt: "You are a scout.", source: "user" });
  expect(reviewer.thinking).toBe("high");
  expect(parseAgent("no frontmatter", "user")).toBeUndefined();
  expect(parseAgent("---\nname: a\ndescription: d\nmaxTurns: 12\n---\n", "user")?.maxTurns).toBe(12);
  expect(parseAgent("---\nname: a\ndescription: d\nmax_turns: \"5\"\n---\n", "user")?.maxTurns).toBe(5);
  expect(parseAgent("---\nname: a\ndescription: d\nmaxTurns: -1\n---\n", "user")).not.toHaveProperty("maxTurns");
});

test("questions only for the gaps", () => {
  expect(Object.keys(pickQuestions({}, agents, tiers, true))).toEqual(["role", "tier", "effort"]);
  expect(Object.keys(pickQuestions({ agent: "scout", model: "x", thinking: "low" }, agents, tiers, true))).toEqual([]);
  expect(Object.keys(pickQuestions({}, [GENERAL], tiers, false))).toEqual(["effort"]);
});

test("readPicks: a role at confidence >= 0.5; tier and effort climb while P(>= option) reaches theta", () => {
  const tier = (probabilities: Record<string, number>) => ({ type: "choice" as const, choice: "x", probabilities, confidence: 0 });
  expect(
    readPicks({
      role: { type: "choice", choice: "reviewer", probabilities: {}, confidence: 0.7 },
      tier: tier({ fast: 0.2, balanced: 0.45, strong: 0.35 }),
      effort: tier({ low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.4 }),
    }),
  ).toEqual({ agent: "reviewer", tier: "balanced", thinking: "high" });
  // The old 0.35 bar climbed to the top on the same answers.
  expect(readPicks({ tier: tier({ fast: 0.2, balanced: 0.45, strong: 0.35 }) }, { threshold: { relaxed: 0.35, tight: 0.85 } })).toEqual({ tier: "strong" });
  expect(readPicks({ role: { type: "choice", choice: "scout", probabilities: {}, confidence: 0.2 } })).toEqual({});
  // Below the relaxed bar for strong, balanced-or-stronger (0.6) still clears it.
  expect(readPicks({ tier: tier({ fast: 0.4, balanced: 0.3, strong: 0.3 }) })).toEqual({ tier: "balanced" });
  // Nothing above the lowest reaches the bar: the lowest.
  expect(readPicks({ tier: tier({ fast: 0.7, balanced: 0.2, strong: 0.1 }) })).toEqual({ tier: "fast" });
  // Without probabilities, the choice counts at its confidence.
  expect(readPicks({ tier: { type: "choice", choice: "strong", probabilities: {}, confidence: 0.3 } })).toEqual({ tier: "fast" });
  expect(readPicks({ effort: { type: "choice", choice: "high", probabilities: {}, confidence: 0.6 } })).toEqual({ thinking: "high" });
});

test("the default bar is the median of Jev's answers, 0.5, tightening to 0.85", () => {
  expect(DEFAULT_THRESHOLD).toEqual({ relaxed: 0.5, tight: 0.85 });
  // Exactly as likely as not clears the relaxed bar.
  expect(readPicks({ tier: { type: "choice", choice: "strong", probabilities: { fast: 0.2, balanced: 0.3, strong: 0.5 }, confidence: 0.5 } })).toEqual({ tier: "strong" });
  expect(readPicks({ tier: { type: "choice", choice: "strong", probabilities: { fast: 0.55, balanced: 0.4, strong: 0.05 }, confidence: 0.5 } })).toEqual({ tier: "fast" });
});

test("quota pressure tightens the bar: theta(p) = relaxed + (tight - relaxed) * p", () => {
  expect(theta(0)).toBeCloseTo(0.5);
  expect(theta(1)).toBeCloseTo(0.85);
  expect(theta(0.5)).toBeCloseTo(0.675);
  expect(theta(2)).toBeCloseTo(0.85);
  expect(theta(0.5, { relaxed: 0.2, tight: 0.6 })).toBeCloseTo(0.4);
  const answers = {
    tier: { type: "choice" as const, choice: "strong", probabilities: { fast: 0.1, balanced: 0.4, strong: 0.5 }, confidence: 0.5 },
    effort: { type: "choice" as const, choice: "high", probabilities: { low: 0.05, medium: 0.25, high: 0.5, xhigh: 0.2 }, confidence: 0.5 },
  };
  expect(readPicks(answers)).toEqual({ tier: "strong", thinking: "high" });
  // p=0.5: the bar is 0.675; strong (0.5) falls short, balanced-or-stronger (0.9) clears it; high-or-above is 0.7.
  expect(readPicks(answers, { pressure: 0.5 })).toEqual({ tier: "balanced", thinking: "high", pressure: 0.5 });
  // p=1: the bar is 0.85; balanced-or-stronger is 0.9, medium-or-above 0.95.
  expect(readPicks(answers, { pressure: 1 })).toEqual({ tier: "balanced", thinking: "medium", pressure: 1 });
  // A configured threshold.
  expect(readPicks(answers, { pressure: 1, threshold: { relaxed: 0.35, tight: 0.95 } })).toEqual({ tier: "fast", thinking: "medium", pressure: 1 });
  expect(readPicks(answers, { pressure: 0, threshold: { relaxed: 0.1, tight: 0.9 } })).toEqual({ tier: "strong", thinking: "xhigh" });
});

test("the effort question is a choice over low|medium|high|xhigh", () => {
  const q = pickQuestions({}, [GENERAL], tiers, false).effort;
  expect(q).toMatchObject({ type: "choice" });
  expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual(["low", "medium", "high", "xhigh"]);
  expect(DEFAULT_TIER_DESCRIPTIONS).toEqual({
    fast: "Lookups, searches, reading and summarizing code or docs, scripted or mechanical edits, running checks and reporting results",
    balanced: "Implementing a precisely specified change, ordinary implementation, debugging with clear symptoms, code reviews, multi-source research",
    strong: "Only when a mistake is costly and the task is genuinely hard: subtle design, hard debugging without clear symptoms, cross-cutting correctness-critical changes",
  });
});

test("resolve carries the pressure only for a model or effort Jev picked", () => {
  expect(resolve({}, agents, { tier: "fast", thinking: "low", pressure: 0.7 }, tiers, parent)).toMatchObject({ pressure: 0.7 });
  expect(resolve({ model: "x/y", thinking: "low" }, agents, { tier: "fast", thinking: "low", pressure: 0.7 }, tiers, parent)).not.toHaveProperty("pressure");
});

test("implicit models stay on the parent's provider, explicit models may cross providers", () => {
  const openai = { model: "openai-codex/gpt-6.1-sol", thinking: "high" };
  expect(resolve({}, agents, { tier: "strong" }, tiers, openai)).toMatchObject({ model: openai.model, byJev: { model: false } });
  expect(resolve({ agent: "scout" }, agents, { tier: "fast" }, tiers, openai)).toMatchObject({ model: openai.model });
  expect(resolve({ model: "anthropic/claude-opus-5-5" }, agents, undefined, tiers, openai)).toMatchObject({ model: "anthropic/claude-opus-5-5" });
});

const registry = (provider: string, ids: string[]) => ids.map((id) => ({ provider, id }));
const claude = registry("anthropic", [
  "claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-haiku-5",
  "claude-sonnet-4-5-20250929", "claude-sonnet-5-5-20260301", "claude-sonnet-5-5",
  "claude-opus-4-20250514", "claude-opus-4-1", "claude-opus-5-5", "claude-fable-5-1",
]);
const codex = registry("openai-codex", ["gpt-5.6-luna", "gpt-6-luna", "gpt-6-terra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.2-terra", "gpt-6.2-sol"]);

test("newest first: numeric-aware, an undated alias before its dated snapshots, then the later date", () => {
  expect(["claude-opus-4-1", "claude-opus-4-20250514", "claude-opus-5-5-20260101", "claude-opus-5-5", "claude-opus-5-5-20260301", "claude-opus-4-10"].sort(newestFirst))
    .toEqual(["claude-opus-5-5", "claude-opus-5-5-20260301", "claude-opus-5-5-20260101", "claude-opus-4-10", "claude-opus-4-1", "claude-opus-4-20250514"]);
  expect(["gpt-6-sol", "gpt-5.6-sol", "gpt-6.2-sol", "gpt-6.1-sol"].sort(newestFirst)).toEqual(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]);
});

test("anthropic presets: the newest registered Haiku, Sonnet and Opus", () => {
  const tiers = { fast: "anthropic/claude-haiku-5", balanced: "anthropic/claude-sonnet-5-5", strong: "anthropic/claude-opus-5-5" };
  expect(providerTiers("anthropic/claude-opus-5-5", {}, {}, claude)).toEqual(tiers);
  // The parent's own generation does not matter for Anthropic.
  expect(providerTiers("anthropic/claude-sonnet-4-5", {}, {}, claude)).toEqual(tiers);
  // Only dated snapshots registered: the latest of them.
  expect(providerTiers("anthropic/x", {}, {}, registry("anthropic", ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5-20251101"]))).toEqual({ balanced: "anthropic/claude-sonnet-4-5-20251101" });
  // Configured tiers win per tier: providerTiers, then a legacy tier on the parent's provider.
  expect(providerTiers("anthropic/claude-opus-5-5", { balanced: "anthropic/claude-fable-5-1", strong: "openai-codex/gpt-6-sol" }, { anthropic: { fast: "anthropic/claude-haiku-4-5" } }, claude))
    .toEqual({ fast: "anthropic/claude-haiku-4-5", balanced: "anthropic/claude-fable-5-1", strong: "anthropic/claude-opus-5-5" });
  // Presets only name registered models of the parent's provider.
  expect(providerTiers("anthropic/claude-opus-5-5", {}, {}, [])).toEqual({});
  expect(providerTiers("anthropic/claude-opus-5-5", {}, {}, registry("openrouter", ["claude-haiku-5"]))).toEqual({});
});

test("openai-codex presets: Luna, Terra and Sol, the parent's generation first, else the newest", () => {
  expect(providerTiers("openai-codex/gpt-6-sol", {}, {}, codex)).toEqual({
    fast: "openai-codex/gpt-6-luna", balanced: "openai-codex/gpt-6-terra", strong: "openai-codex/gpt-6-sol",
  });
  expect(providerTiers("openai-codex/gpt-6.1-sol", {}, {}, codex)).toEqual({
    fast: "openai-codex/gpt-6-luna", balanced: "openai-codex/gpt-6.2-terra", strong: "openai-codex/gpt-6.1-sol",
  });
  expect(providerTiers("openai-codex/gpt-6.2-terra", {}, {}, codex)).toEqual({
    fast: "openai-codex/gpt-6-luna", balanced: "openai-codex/gpt-6.2-terra", strong: "openai-codex/gpt-6.2-sol",
  });
  expect(providerTiers("openai-codex/gpt-6.1-sol", {}, { "openai-codex": { balanced: "openai-codex/custom" } }, codex)).toMatchObject({ balanced: "openai-codex/custom" });
});

test("provider tiers prefer scoped config, then matching legacy config, then the registered presets", () => {
  const model = "openai-codex/gpt-6.1-sol";
  const available = [
    { provider: "openai-codex", id: "gpt-6.1-luna" },
    { provider: "openai-codex", id: "gpt-6.1-sol" },
    { provider: "openai", id: "gpt-6.1-luna" },
  ];
  // No Terra registered: balanced is left to the parent's model.
  expect(providerTiers(model, tiers.models, {}, available)).toEqual({ fast: "openai-codex/gpt-6.1-luna", strong: model });
  expect(providerTiers(model, { fast: model }, { "openai-codex": { strong: "openai-codex/custom" } }, available)).toEqual({
    fast: model, strong: "openai-codex/custom",
  });
  expect(providerTiers(model, tiers.models)).toEqual({});
  expect(providerTiers(parent.model, tiers.models, {}, available)).toEqual(tiers.models);
  // Providers without presets use only their configuration (else the parent's model).
  expect(providerTiers("other/model", tiers.models, {}, available)).toEqual({});
  expect(providerTiers("other/model", {}, {}, registry("other", ["claude-haiku-5", "x-luna"]))).toEqual({});
  expect(providerTiers("__proto__/model", {}, {}, [])).toEqual({});
  expect(providerTiers(model, {}, { "openai-codex": { fast: "anthropic/wrong" } }, [])).toEqual({});
  expect(providerTiers(model, {}, {}, [available[1]!])).toEqual({ strong: model });
});

test("an Anthropic parent's children default to Sonnet, and Jev's tier picks Haiku or Opus", () => {
  const presets = { models: providerTiers("anthropic/claude-opus-5-5", {}, {}, claude), descriptions: DEFAULT_TIER_DESCRIPTIONS };
  const opus = { model: "anthropic/claude-opus-5-5", thinking: "high" };
  expect(resolve({}, [GENERAL], undefined, presets, opus)).toMatchObject({ model: "anthropic/claude-sonnet-5-5", tier: "balanced", byJev: { model: false } });
  expect(resolve({}, [GENERAL], { tier: "fast" }, presets, opus)).toMatchObject({ model: "anthropic/claude-haiku-5", byJev: { model: true } });
  expect(resolve({}, [GENERAL], { tier: "strong" }, presets, opus)).toMatchObject({ model: "anthropic/claude-opus-5-5", byJev: { model: true } });
});

test("precedence: arguments, agent file, Jev, defaults", () => {
  const jev = { agent: "reviewer", tier: "strong" as const, thinking: "low" };
  expect(resolve({}, agents, jev, tiers, parent)).toMatchObject({ agent: { name: "reviewer" }, model: "anthropic/claude-opus-5-5", thinking: "high", byJev: { agent: true, model: true, thinking: false } });
  expect(resolve({ agent: "scout" }, agents, jev, tiers, parent)).toMatchObject({ model: "anthropic/claude-haiku-5", thinking: "low", byJev: { agent: false, model: false, thinking: true } });
  expect(resolve({ agent: "scout", model: "x/y", thinking: "max" }, agents, jev, tiers, parent)).toMatchObject({ model: "x/y", thinking: "max" });
  expect(resolve({}, agents, undefined, tiers, parent)).toMatchObject({ agent: { name: "general" }, model: parent.model, thinking: "medium" });
  expect(resolve({ agent: "nope" }, agents, undefined, tiers, parent)).toEqual({ error: expect.stringMatching(/Unknown agent "nope"/u) });
});

test("resolve records the source of the model and thinking of every combination", () => {
  const src = (r: ReturnType<typeof resolve>) => (r as { source: unknown }).source;
  const tierOnly = { models: { fast: "anthropic/claude-haiku-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS };
  // Explicit arguments win over a profile or file.
  expect(src(resolve({ agent: "scout", model: "x/y", thinking: "low" }, agents, { thinking: "high" }, tiers, parent))).toEqual({ model: "explicit", thinking: "explicit" });
  // The agent file's model and thinking are the profile.
  expect(src(resolve({ agent: "scout" }, agents, undefined, tiers, parent))).toEqual({ model: "profile", thinking: "default" });
  expect(src(resolve({ agent: "reviewer" }, agents, { tier: "strong" }, tiers, parent))).toEqual({ model: "tier", thinking: "profile" });
  // Jev's picks.
  expect(src(resolve({}, [GENERAL], { tier: "fast", thinking: "low" }, tiers, parent))).toEqual({ model: "tier", thinking: "jev" });
  expect(src(resolve({ model: "x/y" }, [GENERAL], { thinking: "low" }, tiers, parent))).toEqual({ model: "explicit", thinking: "jev" });
  expect(src(resolve({ thinking: "max" }, [GENERAL], { tier: "strong" }, tiers, parent))).toEqual({ model: "tier", thinking: "explicit" });
  // Nothing fixed it: the parent's model and thinking.
  const other = { model: "openai/x", thinking: "medium" };
  expect(src(resolve({}, [GENERAL], { tier: "strong" }, tierOnly, other))).toEqual({ model: "default", thinking: "default" });
  expect(src(resolve({}, [GENERAL], undefined, tierOnly, other))).toEqual({ model: "default", thinking: "default" });
  // The balanced tier model with no Jev answer is still a tier pick.
  expect(src(resolve({}, [GENERAL], undefined, { models: { balanced: "anthropic/claude-sonnet-5-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, parent))).toEqual({ model: "tier", thinking: "default" });
});
