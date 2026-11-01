import { expect, test } from "vitest";
import { GENERAL, parseAgent } from "../src/agents.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TIER_DESCRIPTIONS, EFFORT_DESCRIPTIONS, TIERS, newestFirst, physicalChatModels, pickQuestions, providerTiers, readPicks, resolve, theta } from "../src/pick.ts";

const scout = parseAgent("---\nname: scout\ndescription: Fast recon\ntools: read, grep\nmodel: anthropic/claude-haiku-5\n---\nYou are a scout.", "user")!;
const reviewer = parseAgent("---\nname: reviewer\ndescription: Code review\nthinking: high\n---\nReview carefully.", "project")!;
const agents = [GENERAL, scout, reviewer];
const parent = { model: "anthropic/claude-sonnet-5-5", thinking: "xhigh" };
const models = { fast: "anthropic/claude-haiku-5", balanced: "anthropic/claude-sonnet-5-5", strong: "anthropic/claude-opus-5-5", premium: "anthropic/claude-fable-5-1" };
const tiers = { models, descriptions: DEFAULT_TIER_DESCRIPTIONS };
const registry = (provider: string, ids: string[]) => ids.map((id) => ({ provider, id }));
const answer = (choice: string, probabilities: Record<string, number> = {}, confidence = 1) => ({ type: "choice" as const, choice, probabilities, confidence });

test("frontmatter parse keeps agent tools and validated turn limits", () => {
  expect(scout).toMatchObject({ name: "scout", tools: ["read", "grep"], model: "anthropic/claude-haiku-5", prompt: "You are a scout.", source: "user" });
  expect(reviewer.thinking).toBe("high");
  expect(parseAgent("no frontmatter", "user")).toBeUndefined();
  expect(parseAgent("---\nname: a\ndescription: d\nmaxTurns: 12\n---\n", "user")?.maxTurns).toBe(12);
  expect(parseAgent("---\nname: a\ndescription: d\nmax_turns: \"5\"\n---\n", "user")?.maxTurns).toBe(5);
  expect(parseAgent("---\nname: a\ndescription: d\nmaxTurns: -1\n---\n", "user")).not.toHaveProperty("maxTurns");
});

test("questions are only for unfixed dimensions, offered tiers are ordered and identify physical candidates", () => {
  expect(TIERS).toEqual(["fast", "balanced", "strong", "premium"]);
  const questions = pickQuestions({}, agents, tiers, true);
  expect(Object.keys(questions)).toEqual(["role", "tier", "effort"]);
  expect(questions.tier?.criteria).toEqual(Object.fromEntries(TIERS.map((tier) => [tier, `${DEFAULT_TIER_DESCRIPTIONS[tier]} Candidate: ${models[tier]}.`])));
  expect(Object.keys(pickQuestions({ agent: "scout", model: "x", thinking: "low" }, agents, tiers, true))).toEqual([]);
  expect(Object.keys(pickQuestions({}, [GENERAL], tiers, false))).toEqual(["effort"]);
  expect(Object.keys(pickQuestions({}, [GENERAL], { ...tiers, models: { strong: models.strong, fast: models.fast } }, true).tier!.criteria)).toEqual(["fast", "strong"]);
  expect(Object.keys(pickQuestions({}, [GENERAL], { ...tiers, models: { fast: models.fast } }, true))).toEqual(["effort"]);
  expect(Object.keys(pickQuestions({}, [GENERAL], { ...tiers, models: {} }, true))).toEqual(["effort"]);
  const prefix = "Judge only the delegated task in task. parent_request is context for interpreting it, not additional work this agent owns. Choose the least costly capability and effort sufficient to complete the task reliably. A role name, long specification, many files, mandatory tests, or an important parent project does not by itself justify escalation. Do not trade away necessary capability merely to save cost. Model capability and reasoning effort are independent decisions.";
  for (const id of ["tier", "effort"]) expect(questions[id]?.instructions?.startsWith(prefix)).toBe(true);
  expect(questions.tier?.instructions).toContain("How capable a model does task need?");
  expect(questions.effort?.instructions).toContain("How much careful reasoning does task need");
  expect((questions.effort as { criteria: unknown }).criteria).toEqual(EFFORT_DESCRIPTIONS);
  expect(DEFAULT_TIER_DESCRIPTIONS).toEqual({
    fast: "Lookups, extraction, concise summaries, scripted or mechanical changes, and running prescribed checks; little unresolved judgment.",
    balanced: "Specified implementation, ordinary debugging with clear symptoms, documentation, focused review, and multi-source research with a clear question.",
    strong: "Substantial unresolved reasoning within this task: interacting changes, difficult review, nontrivial design, or debugging whose cause is not yet known.",
    premium: "Exceptional unresolved difficulty where the flagship model's extra capability is justified: subtle cross-system correctness, unusually hard debugging, or consequential architecture with unresolved trade-offs. Not merely a lengthy specification or routine implementation in a critical project.",
  });
});

test("readPicks climbs only offered tiers; unsupported answers and zero candidates yield no tier", () => {
  expect(readPicks({ tier: answer("premium", { fast: 0.1, balanced: 0.1, strong: 0.1, premium: 0.7 }) })).toEqual({ tier: "premium" });
  expect(readPicks({ tier: answer("premium", { fast: 0.1, strong: 0.8, premium: 0.1 }) }, { tiers: ["fast", "strong"] })).toEqual({ tier: "strong" });
  expect(readPicks({ tier: answer("premium", { premium: 1 }) }, { tiers: ["fast", "strong"] })).toEqual({});
  expect(readPicks({ tier: answer("phantom", { phantom: 1 }) }, { tiers: TIERS })).toEqual({});
  for (const probabilities of ([{}, { fast: 0 }, { fast: -0.5 }, { premium: Number.NaN }, { absent: 1 }] as Record<string, number>[])) {
    expect(readPicks({ tier: answer("unknown", probabilities), effort: answer("unknown", { low: probabilities.fast ?? 0 }) }, { tiers: ["fast", "balanced"] })).toEqual({});
  }
  expect(readPicks({ tier: answer("unknown", { balanced: 0.7 }), effort: answer("unknown", { high: 0.8 }) }, { tiers: ["fast", "balanced"] }))
    .toEqual({ tier: "balanced", thinking: "high" });
  expect(readPicks({ tier: answer("fast") }, { tiers: [] })).toEqual({});
  expect(readPicks({ tier: answer("strong", { fast: 0.1, strong: 0.9 }) }, { tiers: ["fast"] })).toEqual({ tier: "fast" });
  expect(readPicks({ role: answer("reviewer", {}, 0.7), tier: answer("strong", { fast: 0.2, balanced: 0.45, strong: 0.35 }), effort: answer("xhigh", { low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.4 }) }))
    .toEqual({ agent: "reviewer", tier: "balanced", thinking: "high" });
  expect(readPicks({ role: answer("scout", {}, 0.2) })).toEqual({});
  expect(readPicks({ tier: answer("strong", {}, 0.3) })).toEqual({ tier: "fast" });
  expect(readPicks({ effort: answer("high", {}, 0.6) })).toEqual({ thinking: "high" });
});

test("threshold and quota-pressure formula remain unchanged with four levels", () => {
  expect(DEFAULT_THRESHOLD).toEqual({ relaxed: 0.5, tight: 0.85 });
  expect(theta(0)).toBeCloseTo(0.5);
  expect(theta(1)).toBeCloseTo(0.85);
  expect(theta(0.5)).toBeCloseTo(0.675);
  expect(theta(2)).toBeCloseTo(0.85);
  expect(theta(0.5, { relaxed: 0.2, tight: 0.6 })).toBeCloseTo(0.4);
  const answers = { tier: answer("premium", { fast: 0.1, balanced: 0.2, strong: 0.2, premium: 0.5 }), effort: answer("xhigh", { low: 0.05, medium: 0.25, high: 0.5, xhigh: 0.2 }) };
  expect(readPicks(answers)).toEqual({ tier: "premium", thinking: "high" });
  expect(readPicks(answers, { pressure: 0.5 })).toEqual({ tier: "strong", thinking: "high", pressure: 0.5 });
  expect(readPicks(answers, { pressure: 1 })).toEqual({ tier: "balanced", thinking: "medium", pressure: 1 });
  expect(readPicks(answers, { pressure: 0, threshold: { relaxed: 0.1, tight: 0.9 } })).toEqual({ tier: "premium", thinking: "xhigh" });
  expect(readPicks({ tier: answer("strong", { fast: 0.2, balanced: 0.3, strong: 0.5 }) }, { tiers: ["fast", "balanced", "strong"] })).toEqual({ tier: "strong" });
});

test("numeric-aware newest and OpenAI generation siblings, premium newest registered, no fabricated IDs", () => {
  expect(["claude-opus-4-1", "claude-opus-4-20250514", "claude-opus-5-5-20260101", "claude-opus-5-5", "claude-opus-5-5-20260301", "claude-opus-4-10"].sort(newestFirst))
    .toEqual(["claude-opus-5-5", "claude-opus-5-5-20260301", "claude-opus-5-5-20260101", "claude-opus-4-10", "claude-opus-4-1", "claude-opus-4-20250514"]);
  const codex = registry("openai-codex", ["gpt-5.6-luna", "gpt-6-luna", "gpt-6-terra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.2-terra", "gpt-6.2-sol", "gpt-6-astra"]);
  expect(providerTiers("openai-codex/gpt-6-sol", {}, {}, codex)).toEqual({ fast: "openai-codex/gpt-6-luna", balanced: "openai-codex/gpt-6-terra", strong: "openai-codex/gpt-6-sol", premium: "openai-codex/gpt-6-astra" });
  expect(providerTiers("openai-codex/gpt-6.1-sol", {}, {}, codex)).toEqual({ fast: "openai-codex/gpt-6-luna", balanced: "openai-codex/gpt-6.2-terra", strong: "openai-codex/gpt-6.1-sol", premium: "openai-codex/gpt-6-astra" });
  expect(providerTiers("openai/gpt-6.1-sol", {}, {}, codex)).toEqual({});
  expect(providerTiers("anthropic/claude-opus-5-5", {}, {}, registry("anthropic", ["claude-haiku-5", "claude-sonnet-5-5", "claude-opus-5-5"])))
    .toEqual({ fast: "anthropic/claude-haiku-5", balanced: "anthropic/claude-sonnet-5-5", strong: "anthropic/claude-opus-5-5" });
});

test("Google/Muse offer only registered stable route candidates, without premium", () => {
  const google = registry("google", ["gemini-3.8-flash-lite", "gemini-3.8-flash", "gemini-4-argon", "antigravity-gemini-3.8-flash", "antigravity-gemini-4-argon", "antigravity-claude-sonnet-5-5", "antigravity-claude-opus-5-5", "gemini-4-argon-preview"]);
  expect(providerTiers("google/gemini-4-argon", {}, {}, google)).toEqual({ fast: "google/gemini-3.8-flash-lite", balanced: "google/gemini-3.8-flash", strong: "google/gemini-4-argon" });
  expect(providerTiers("google/antigravity-gemini-4-argon", {}, {}, google)).toEqual({ fast: "google/antigravity-gemini-3.8-flash", balanced: "google/antigravity-gemini-3.8-flash", strong: "google/antigravity-gemini-4-argon" });
  expect(providerTiers("google/antigravity-claude-opus-5-5", {}, {}, google)).toEqual({ fast: "google/antigravity-claude-sonnet-5-5", balanced: "google/antigravity-claude-sonnet-5-5", strong: "google/antigravity-claude-opus-5-5" });
  expect(providerTiers("muse-code/muse-wonder-1.0", {}, {}, registry("muse-code", ["muse-spark", "muse-spark-1.3", "muse-spark-1.3-contributor", "muse-wonder-1.0", "muse-wonder-1.0-full"])))
    .toEqual({ fast: "muse-code/muse-spark-1.3", balanced: "muse-code/muse-spark-1.3", strong: "muse-code/muse-wonder-1.0" });
});

test("configured tier precedence falls through unavailable, classifier and virtual entries in a known registry", () => {
  const parent = "openai/gpt-6.1-sol";
  const available = [
    { provider: "openai", id: "gpt-6-luna", type: "chat" },
    { provider: "openai", id: "gpt-6.1-terra", type: "chat" },
    { provider: "openai", id: "gpt-6.1-sol", type: "chat" },
    { provider: "openai", id: "custom", type: "chat" },
    { provider: "openai", id: "only-classifier", type: "classifier" },
    { provider: "openai", id: "only-virtual", api: "pi-virtual", type: "chat" },
  ];
  expect(providerTiers(parent, { fast: "openai/absent", balanced: "openai/only-classifier", strong: "openai/only-virtual", premium: "openai/phantom" }, { openai: { fast: "openai/custom", balanced: "openai/custom", strong: "openai/custom" } }, available))
    .toEqual({ fast: "openai/custom", balanced: "openai/custom", strong: "openai/custom" });
  expect(providerTiers(parent, { fast: "openai/only-classifier", balanced: "openai/only-virtual", strong: "openai/absent", premium: "openai/phantom" }, {}, available))
    .toEqual({ fast: "openai/gpt-6-luna", balanced: "openai/gpt-6.1-terra", strong: "openai/gpt-6.1-sol" });
  expect(providerTiers(parent, { fast: "openai/gpt-6-luna" }, { openai: { fast: "openai/custom" } }, available)).toMatchObject({ fast: "openai/custom" });
  expect(providerTiers(parent, { premium: "anthropic/claude-fable-5-1" }, {}, available)).not.toHaveProperty("premium");
});

test("raw nonempty wrong-provider/classifier-only snapshots are known unavailable; raw empty retains legacy configured IDs", () => {
  const wrong = registry("other", ["gpt-6.1-sol"]);
  expect(providerTiers("openai/gpt-6.1-sol", { fast: "openai/custom" }, { openai: { strong: "openai/custom" } }, wrong)).toEqual({});
  expect(providerTiers("openai/gpt-6.1-sol", { fast: "openai/custom" }, {}, [{ provider: "openai", id: "custom", type: "classifier" }])).toEqual({});
  expect(providerTiers("openai/gpt-6.1-sol", { fast: "openai/custom", premium: "anthropic/wrong" }, {}, [])).toEqual({ fast: "openai/custom" });
  expect(providerTiers("__proto__/model", {}, {}, [])).toEqual({});
});

test("automatic candidates exclude non-chat and virtual IDs, but duplicate classifier/chat IDs keep physical metadata", () => {
  const entries = [
    { provider: "anthropic", id: "claude-fable-5-1", type: "classifier", reasoning: false },
    { provider: "anthropic", id: "claude-opus-5-5", api: "pi-virtual", type: "chat" },
    { provider: "anthropic", id: "claude-sonnet-5-5", type: "classifier", reasoning: false },
    { provider: "anthropic", id: "claude-sonnet-5-5", type: "chat", reasoning: true },
    { provider: "anthropic", id: "claude-haiku-5" },
  ];
  expect(physicalChatModels(entries).map((model) => [model.id, model.reasoning])).toEqual([["claude-sonnet-5-5", true], ["claude-haiku-5", undefined]]);
  expect(providerTiers("anthropic/claude-opus-5-5", {}, {}, entries)).toEqual({ fast: "anthropic/claude-haiku-5", balanced: "anthropic/claude-sonnet-5-5" });
  expect(providerTiers("anthropic/claude-opus-5-5", { premium: "anthropic/claude-fable-5-1", strong: "anthropic/claude-opus-5-5" }, {}, entries)).not.toHaveProperty("premium");
  expect(resolve({ agent: "general" }, [GENERAL], { tier: "balanced", thinking: "high" }, { models: { balanced: "anthropic/claude-sonnet-5-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, parent, { available: physicalChatModels(entries) }))
    .toMatchObject({ thinking: "high" });
});

test("unoffered classifier picks cannot escape provider or route; parent fallback gets a visible reason", () => {
  expect(resolve({ agent: "scout" }, agents, { tier: "premium", thinking: "low" }, { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS }, { model: "other/model", thinking: "xhigh" }))
    .toMatchObject({ model: "other/model", thinking: "low", source: { model: "default", thinking: "jev" }, note: "parent fallback: no usable role or tier mapping for other", byJev: { model: false, thinking: true } });
  expect(resolve({}, [GENERAL], { tier: "strong" }, { models: { strong: "anthropic/claude-opus-5-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, { model: "openai/gpt-6-astra", thinking: "xhigh" }))
    .toMatchObject({ model: "openai/gpt-6-astra", thinking: "medium", note: "parent fallback: no usable role or tier mapping for openai" });
  const explicit = resolve({ model: "anthropic/claude-opus-5-5" }, agents, undefined, tiers, { model: "openai/gpt-6-astra", thinking: "xhigh" });
  expect(explicit).toMatchObject({ model: "anthropic/claude-opus-5-5", source: { model: "explicit" } });
});

test("Haiku guard joins its reason to parent fallback if balanced and role mappings are absent", () => {
  const fastOnly = { models: { fast: "anthropic/claude-haiku-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS };
  expect(resolve({}, [GENERAL], { tier: "fast" }, fastOnly, { model: "anthropic/claude-opus-5-5", thinking: "high" }, { context: { fork: true } }))
    .toMatchObject({ model: "anthropic/claude-opus-5-5", note: "not Haiku: forked context; parent fallback: no usable role or tier mapping for anthropic", source: { model: "default" } });
});

test("pressure is recorded only for a picked model or effort, never for explicit-only choices", () => {
  expect(resolve({}, agents, { tier: "fast", thinking: "low", pressure: 0.7 }, tiers, parent)).toMatchObject({ pressure: 0.7 });
  expect(resolve({ model: "x/y", thinking: "low" }, agents, { tier: "fast", thinking: "low", pressure: 0.7 }, tiers, parent)).not.toHaveProperty("pressure");
  expect(resolve({ agent: "scout" }, agents, undefined, tiers, parent)).toMatchObject({ source: { model: "profile", thinking: "default" } });
});
