import { expect, test } from "vitest";
import { GENERAL, parseAgent } from "../src/agents.ts";
import { DEFAULT_TIER_DESCRIPTIONS, pickQuestions, providerTiers, readPicks, resolve } from "../src/pick.ts";

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

test("readPicks applies the confidence floors", () => {
  expect(
    readPicks({
      role: { type: "choice", choice: "reviewer", probabilities: {}, confidence: 0.7 },
      tier: { type: "choice", choice: "strong", probabilities: {}, confidence: 0.3 },
      effort: { type: "score", score: 2.6, confidence: 0.9 },
    }),
  ).toEqual({ agent: "reviewer", tier: "balanced", thinking: "xhigh" });
  expect(readPicks({ role: { type: "choice", choice: "scout", probabilities: {}, confidence: 0.2 } })).toEqual({});
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
