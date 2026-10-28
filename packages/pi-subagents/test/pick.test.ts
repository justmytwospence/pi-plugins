import { expect, test } from "vitest";
import { GENERAL, parseAgent } from "../src/agents.ts";
import { DEFAULT_TIER_DESCRIPTIONS, pickQuestions, providerTiers, readPicks, resolve, theta } from "../src/pick.ts";

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
  ).toEqual({ agent: "reviewer", tier: "strong", thinking: "xhigh" });
  expect(readPicks({ role: { type: "choice", choice: "scout", probabilities: {}, confidence: 0.2 } })).toEqual({});
  // Below the relaxed bar for strong, balanced-or-stronger (0.6) still clears it.
  expect(readPicks({ tier: tier({ fast: 0.4, balanced: 0.3, strong: 0.3 }) })).toEqual({ tier: "balanced" });
  // Nothing above the lowest reaches the bar: the lowest.
  expect(readPicks({ tier: tier({ fast: 0.7, balanced: 0.2, strong: 0.1 }) })).toEqual({ tier: "fast" });
  // Without probabilities, the choice counts at its confidence.
  expect(readPicks({ tier: { type: "choice", choice: "strong", probabilities: {}, confidence: 0.3 } })).toEqual({ tier: "fast" });
  expect(readPicks({ effort: { type: "choice", choice: "high", probabilities: {}, confidence: 0.6 } })).toEqual({ thinking: "high" });
});

test("quota pressure tightens the bar: theta(p) = relaxed + (tight - relaxed) * p", () => {
  expect(theta(0)).toBeCloseTo(0.35);
  expect(theta(1)).toBeCloseTo(0.85);
  expect(theta(0.5)).toBeCloseTo(0.6);
  expect(theta(2)).toBeCloseTo(0.85);
  expect(theta(0.5, { relaxed: 0.2, tight: 0.6 })).toBeCloseTo(0.4);
  const answers = {
    tier: { type: "choice" as const, choice: "strong", probabilities: { fast: 0.1, balanced: 0.4, strong: 0.5 }, confidence: 0.5 },
    effort: { type: "choice" as const, choice: "high", probabilities: { low: 0.05, medium: 0.25, high: 0.5, xhigh: 0.2 }, confidence: 0.5 },
  };
  expect(readPicks(answers)).toEqual({ tier: "strong", thinking: "high" });
  // p=0.5: the bar is 0.6; strong (0.5) falls short, balanced-or-stronger (0.9) clears it; high-or-above is 0.7.
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
  expect(DEFAULT_TIER_DESCRIPTIONS.balanced).toMatch(/implementing a precisely specified change/iu);
  expect(DEFAULT_TIER_DESCRIPTIONS.fast).toMatch(/lookups, searches, reading and summarizing, scripted or mechanical edits/iu);
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

test("provider tiers prefer scoped config, then matching legacy config, then registered Sol/Luna", () => {
  const model = "openai-codex/gpt-6.1-sol";
  const available = [
    { provider: "openai-codex", id: "gpt-6.1-luna" },
    { provider: "openai-codex", id: "gpt-6.1-sol" },
    { provider: "openai", id: "gpt-6.1-luna" },
  ];
  expect(providerTiers(model, tiers.models, {}, available)).toEqual({
    fast: "openai-codex/gpt-6.1-luna", balanced: model, strong: model,
  });
  expect(providerTiers(model, { fast: model }, { "openai-codex": { strong: "openai-codex/custom" } }, available)).toEqual({
    fast: model, balanced: model, strong: "openai-codex/custom",
  });
  expect(providerTiers(model, {}, {}, [
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-6-luna" },
    { provider: "openai-codex", id: "gpt-6-sol" },
    { provider: "openai-codex", id: "gpt-6.1-sol" },
  ])).toEqual({ fast: "openai-codex/gpt-6-luna", balanced: model, strong: model });
  expect(providerTiers(model, tiers.models)).toEqual({});
  expect(providerTiers(parent.model, tiers.models, {}, available)).toEqual(tiers.models);
  expect(providerTiers("other/model", tiers.models, {}, available)).toEqual({});
  expect(providerTiers(model, {}, { "openai-codex": { fast: "anthropic/wrong" } }, [])).toEqual({});
  expect(providerTiers(model, {}, {}, [available[1]!])).toEqual({ balanced: model, strong: model });
});

test("precedence: arguments, agent file, Jev, defaults", () => {
  const jev = { agent: "reviewer", tier: "strong" as const, thinking: "low" };
  expect(resolve({}, agents, jev, tiers, parent)).toMatchObject({ agent: { name: "reviewer" }, model: "anthropic/claude-opus-5-5", thinking: "high", byJev: { agent: true, model: true, thinking: false } });
  expect(resolve({ agent: "scout" }, agents, jev, tiers, parent)).toMatchObject({ model: "anthropic/claude-haiku-5", thinking: "low", byJev: { agent: false, model: false, thinking: true } });
  expect(resolve({ agent: "scout", model: "x/y", thinking: "max" }, agents, jev, tiers, parent)).toMatchObject({ model: "x/y", thinking: "max" });
  expect(resolve({}, agents, undefined, tiers, parent)).toMatchObject({ agent: { name: "general" }, model: parent.model, thinking: "medium" });
  expect(resolve({ agent: "nope" }, agents, undefined, tiers, parent)).toEqual({ error: expect.stringMatching(/Unknown agent "nope"/u) });
});
