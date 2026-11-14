import { expect, test } from "vitest";
import { BUILTIN_AGENTS, GENERAL, parseAgent, parseModels } from "../src/agents.ts";
import { DEFAULT_TIER_DESCRIPTIONS, agentDefaults, clampThinking, fixedAgentDefaults, pickQuestions, profileModel, providerTiers, resolve } from "../src/pick.ts";

const agents = BUILTIN_AGENTS;
const role = (name: string) => agents.find((a) => a.name === name)!;
const registry = (provider: string, ids: string[]) => ids.map((id) => ({ provider, id }));
const available = [
  ...registry("anthropic", ["claude-haiku-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]),
  ...registry("openai", ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]),
  ...registry("openai-codex", ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]),
  ...registry("google", ["gemini-3.8-flash-lite", "gemini-3.8-flash", "gemini-4-argon", "antigravity-gemini-3.8-flash", "antigravity-gemini-4-argon", "antigravity-claude-sonnet-5-5", "antigravity-claude-opus-5-5"]),
  ...registry("muse-code", ["muse-spark-1.3", "muse-wonder-1.0"]),
];
const parents = [
  ["anthropic/claude-opus-5-5", ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]],
  ["openai/gpt-6-astra", ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.1-terra", "gpt-6.1-sol"]],
  ["openai-codex/gpt-6-astra", ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.1-terra", "gpt-6.1-sol"]],
  ["google/gemini-4-argon", ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-4-argon", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-4-argon"]],
  ["google/antigravity-gemini-4-argon", ["antigravity-gemini-3.8-flash", "antigravity-gemini-3.8-flash", "antigravity-gemini-4-argon", "antigravity-gemini-3.8-flash", "antigravity-gemini-3.8-flash", "antigravity-gemini-4-argon"]],
  ["google/antigravity-claude-opus-5-5", ["antigravity-claude-sonnet-5-5", "antigravity-claude-sonnet-5-5", "antigravity-claude-opus-5-5", "antigravity-claude-sonnet-5-5", "antigravity-claude-sonnet-5-5", "antigravity-claude-opus-5-5"]],
  ["muse-code/muse-wonder-1.0", ["muse-spark-1.3", "muse-spark-1.3", "muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.3", "muse-wonder-1.0"]],
] as const;
const tiersFor = (parent: string, models = available) => ({ models: providerTiers(parent, {}, {}, models), descriptions: DEFAULT_TIER_DESCRIPTIONS });

// These are fallback decisions without Jev, never hard limits on a role's capability or effort.
test.each(parents)("built-in role baselines without picks for %s", (parent, models) => {
  const names = ["explorer", "worker", "reviewer", "researcher", "writer", "planner"];
  for (const [index, name] of names.entries()) {
    const resolved = resolve({ agent: name }, agents, undefined, tiersFor(parent), { model: parent, thinking: "xhigh" }, { available });
    expect(resolved).toMatchObject({ model: `${parent.split("/")[0]}/${models[index]}`, thinking: name === "explorer" && parent.startsWith("openai") ? "high" : ["explorer"].includes(name) ? "low" : ["reviewer", "planner"].includes(name) ? "high" : "medium", source: { model: "profile", thinking: "profile" }, byJev: { model: false, thinking: false } });
  }
  const general = resolve({ agent: "general" }, agents, undefined, tiersFor(parent), { model: parent, thinking: "xhigh" }, { available });
  expect(general).toMatchObject({ thinking: "medium", source: { thinking: "default" } });
});

test("frontmatter models remain exact per provider and malformed entries are ignored", () => {
  const agent = parseAgent("---\nname: scout\ndescription: d\nmodels:\n  anthropic: anthropic/claude-sonnet-5-5:low\n  openai-codex: gpt-6-luna\n  openai: anthropic/claude-opus-5-5\n  ollama: ollama/llama3:8b\n---\n", "user")!;
  expect(agent.models).toEqual({ anthropic: { model: "anthropic/claude-sonnet-5-5", thinking: "low" }, "openai-codex": { model: "openai-codex/gpt-6-luna" }, ollama: { model: "ollama/llama3:8b" } });
  expect(parseModels("anthropic/claude-sonnet-5-5")).toBeUndefined();
  expect(parseModels({ anthropic: 5, x: "" })).toBeUndefined();
  expect(parseAgent("---\nname: a\ndescription: d\n---\n", "user")).not.toHaveProperty("models");
});

test("one worker can be promoted and demoted across all four tiers and efforts", () => {
  const parent = { model: "openai/gpt-6-astra", thinking: "xhigh" };
  const expected = [
    ["fast", "gpt-6-luna", "low"], ["balanced", "gpt-6.1-terra", "medium"],
    ["strong", "gpt-6.1-sol", "high"], ["premium", "gpt-6-astra", "xhigh"],
  ] as const;
  for (const [tier, id, thinking] of expected) {
    const result = resolve({ agent: "worker" }, agents, { tier, thinking }, tiersFor(parent.model), parent, { available });
    expect(result).toMatchObject({ model: `openai/${id}`, thinking, tier, source: { model: "tier", thinking: "jev" }, byJev: { model: true, thinking: true } });
    if (tier === "premium") expect(result).not.toHaveProperty("note"); // Parent equality is deliberate, not inheritance.
  }
  expect(resolve({ agent: "worker" }, agents, { tier: "premium", thinking: "low" }, tiersFor(parent.model), parent, { available }))
    .toMatchObject({ model: parent.model, thinking: "low", source: { model: "tier", thinking: "jev" } });
  expect(resolve({ agent: "worker" }, agents, { tier: "balanced", thinking: "high" }, tiersFor(parent.model), parent, { available }))
    .toMatchObject({ model: "openai/gpt-6.1-terra", thinking: "high" });
  expect(fixedAgentDefaults(role("worker"), parent.model, available)).toEqual({});
  expect(Object.keys(pickQuestions({ agent: "worker", ...fixedAgentDefaults(role("worker"), parent.model, available) }, agents, tiersFor(parent.model), true))).toEqual(["tier", "effort"]);
});

test("custom model and effort pins suppress only their dimensions, and explicit arguments win independently", () => {
  const pinned = parseAgent("---\nname: scout\ndescription: d\nmodels:\n  openai: gpt-6.1-terra:high\n---\n", "project")!;
  const modelOnly = parseAgent("---\nname: modelOnly\ndescription: d\nmodel: openai/gpt-6-luna\n---\n", "user")!;
  const effortOnly = parseAgent("---\nname: effortOnly\ndescription: d\nthinking: low\n---\n", "user")!;
  const parent = { model: "openai/gpt-6-astra", thinking: "xhigh" };
  const list = [GENERAL, pinned, modelOnly, effortOnly];
  expect(fixedAgentDefaults(pinned, parent.model, available)).toEqual({ model: "openai/gpt-6.1-terra", thinking: "high" });
  expect(pickQuestions({ agent: "scout", ...fixedAgentDefaults(pinned, parent.model, available) }, list, tiersFor(parent.model), true)).toEqual({});
  expect(Object.keys(pickQuestions({ agent: "modelOnly", ...fixedAgentDefaults(modelOnly, parent.model, available) }, list, tiersFor(parent.model), true))).toEqual(["effort"]);
  expect(Object.keys(pickQuestions({ agent: "effortOnly", ...fixedAgentDefaults(effortOnly, parent.model, available) }, list, tiersFor(parent.model), true))).toEqual(["tier"]);
  expect(resolve({ agent: "scout" }, list, { tier: "premium", thinking: "low" }, tiersFor(parent.model), parent, { available }))
    .toMatchObject({ model: "openai/gpt-6.1-terra", thinking: "high", source: { model: "profile", thinking: "profile" }, byJev: { model: false, thinking: false } });
  expect(resolve({ agent: "modelOnly" }, list, { thinking: "high" }, tiersFor(parent.model), parent, { available })).toMatchObject({ model: "openai/gpt-6-luna", thinking: "high", byJev: { model: false, thinking: true } });
  expect(resolve({ agent: "effortOnly" }, list, { tier: "strong" }, tiersFor(parent.model), parent, { available })).toMatchObject({ model: "openai/gpt-6.1-sol", thinking: "low", byJev: { model: true, thinking: false } });
  expect(resolve({ agent: "scout", model: "anthropic/claude-fable-5-1", thinking: "xhigh" }, list, { tier: "fast", thinking: "low" }, tiersFor(parent.model), parent, { available }))
    .toMatchObject({ model: "anthropic/claude-fable-5-1", thinking: "xhigh", source: { model: "explicit", thinking: "explicit" } });
});

test("stale profiles use newest physical model of the exact routed family; missing family retains role effort", () => {
  const newer = registry("anthropic", ["claude-sonnet-6", "claude-sonnet-5-0", "claude-opus-6"]);
  expect(profileModel({ model: "anthropic/claude-sonnet-5-5", thinking: "low" }, "anthropic", newer)).toEqual({ model: "anthropic/claude-sonnet-6", thinking: "low" });
  expect(profileModel({ model: "openai-codex/gpt-6.1-sol" }, "openai-codex", registry("openai-codex", ["gpt-6.2-sol", "gpt-6-sol"]))).toEqual({ model: "openai-codex/gpt-6.2-sol" });
  expect(profileModel({ model: "anthropic/claude-sonnet-5-5" }, "anthropic", registry("anthropic", ["claude-opus-6"]))).toBeUndefined();
  expect(profileModel({ model: "anthropic/claude-custom" }, "anthropic", newer)).toBeUndefined();
  expect(profileModel({ model: "anthropic/claude-sonnet-5-5" }, "anthropic", [])).toEqual({ model: "anthropic/claude-sonnet-5-5" });
  const ag = "google/antigravity-gemini-4-argon";
  expect(agentDefaults(role("worker"), ag, registry("google", ["gemini-3.8-flash", "antigravity-gemini-4.1-flash"])))
    .toEqual({ model: "google/antigravity-gemini-4.1-flash", thinking: "medium" });
  expect(agentDefaults(role("worker"), ag, registry("google", ["gemini-3.8-flash"]))).toEqual({ thinking: "medium" });
  expect(resolve({ agent: "explorer" }, agents, undefined, tiersFor("anthropic/claude-opus-5-5", registry("anthropic", ["claude-opus-5-5"])), { model: "anthropic/claude-opus-5-5", thinking: "xhigh" }, { available: registry("anthropic", ["claude-opus-5-5"]) }))
    .toMatchObject({ model: "anthropic/claude-opus-5-5", thinking: "low", tier: "strong", source: { model: "tier", thinking: "profile" }, byJev: { model: false } });
});

test("profile IDs cannot escape a known registry containing only wrong-provider, classifier or virtual models", () => {
  const entry = { model: "openai/gpt-6.1-sol", thinking: "high" };
  for (const snapshot of [
    registry("anthropic", ["claude-opus-5-5"]),
    [{ provider: "openai", id: "gpt-6.1-sol", type: "classifier" }],
    [{ provider: "openai", id: "gpt-6.1-sol", type: "chat", api: "pi-virtual" }],
  ]) {
    expect(profileModel(entry, "openai", snapshot)).toBeUndefined();
    expect(agentDefaults(role("worker"), "openai/gpt-6-astra", snapshot)).toEqual({ thinking: "medium" });
  }
  expect(profileModel(entry, "openai", [])).toEqual(entry); // Entirely empty raw snapshot is unknown, for legacy callers.
  expect(profileModel(entry, "openai", [
    { provider: "openai", id: "gpt-6.1-sol", type: "classifier" },
    { provider: "openai", id: "gpt-6.2-sol", type: "chat" },
  ])).toEqual({ model: "openai/gpt-6.2-sol", thinking: "high" });
});

test("the final model's registered levels clamp non-explicit effort, but an explicit effort passes through", () => {
  const plain = { provider: "p", id: "m", reasoning: false };
  const capped = { provider: "p", id: "c", reasoning: true, thinkingLevelMap: { minimal: null } };
  const xhigh = { provider: "p", id: "x", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
  expect(clampThinking("high", plain)).toBe("off");
  expect(clampThinking("xhigh", capped)).toBe("high");
  expect(clampThinking("minimal", capped)).toBe("low");
  expect(clampThinking("xhigh", xhigh)).toBe("xhigh");
  expect(clampThinking("high", undefined)).toBe("high");
  const scout = parseAgent("---\nname: scout\ndescription: d\nmodels:\n  p: p/c:xhigh\n---\n", "user")!;
  expect(agentDefaults(scout, "p/c", [capped])).toEqual({ model: "p/c", thinking: "xhigh" });
  expect(resolve({ agent: "scout" }, [GENERAL, scout], undefined, { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS }, { model: "p/c", thinking: "low" }, { available: [capped] }))
    .toMatchObject({ model: "p/c", thinking: "high", source: { thinking: "profile" } });
  const baseline = { ...role("planner"), tiers: undefined, models: { p: { model: "p/m", thinking: "high" } }, thinking: "high" };
  const final = { provider: "p", id: "reasoning", reasoning: true };
  expect(agentDefaults(baseline, "p/m", [plain, final])).toEqual({ model: "p/m", thinking: "high" });
  expect(resolve({ agent: "planner" }, [baseline], { tier: "strong" }, { models: { strong: "p/reasoning" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, { model: "p/m", thinking: "off" }, { available: [plain, final] }))
    .toMatchObject({ model: "p/reasoning", thinking: "high", source: { model: "tier", thinking: "profile" } });
  const unavailable = parseAgent("---\nname: unavailable\ndescription: d\nmodels:\n  p: p/nonexistent:high\n---\n", "user")!;
  expect(fixedAgentDefaults(unavailable, "p/m", [plain, final])).toEqual({ thinking: "high" });
  expect(Object.keys(pickQuestions({ agent: "unavailable", ...fixedAgentDefaults(unavailable, "p/m", [plain, final]) }, [GENERAL, unavailable], { models: { balanced: "p/reasoning" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, true))).toEqual([]);
  expect(resolve({ agent: "unavailable" }, [GENERAL, unavailable], undefined, { models: { balanced: "p/reasoning" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, { model: "p/m", thinking: "off" }, { available: [plain, final] }))
    .toMatchObject({ model: "p/reasoning", thinking: "high", source: { model: "tier", thinking: "profile" } });
  expect(resolve({ agent: "worker" }, agents, { thinking: "xhigh" }, { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS }, { model: "p/m", thinking: "high" }, { available: [plain] }))
    .toMatchObject({ thinking: "off" });
  expect(resolve({ agent: "worker", thinking: "xhigh" }, agents, undefined, { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS }, { model: "p/m", thinking: "high" }, { available: [plain] }))
    .toMatchObject({ thinking: "xhigh" });
});

test("one offered tier is deterministic without a Jev model pick; none falls back visibly to parent", () => {
  const parent = { model: "openai/gpt-6-astra", thinking: "xhigh" };
  const one = { models: { fast: "openai/gpt-6-luna" }, descriptions: DEFAULT_TIER_DESCRIPTIONS };
  expect(Object.keys(pickQuestions({ agent: "worker" }, agents, one, true))).toEqual(["effort"]);
  expect(resolve({ agent: "worker" }, agents, undefined, one, parent, { available: registry("openai", ["gpt-6-luna"]) }))
    .toMatchObject({ model: "openai/gpt-6-luna", tier: "fast", source: { model: "tier", thinking: "profile" }, byJev: { model: false } });
  const none = { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS };
  expect(resolve({ agent: "general" }, agents, undefined, none, parent, { available: registry("openai", ["gpt-6-astra"]) }))
    .toMatchObject({ model: parent.model, thinking: "medium", source: { model: "default", thinking: "default" }, note: "parent fallback: no usable role or tier mapping for openai" });
});

test("a classified fast Haiku is guarded for forked or long parent context, not for explicit models", () => {
  const parent = { model: "anthropic/claude-opus-5-5", thinking: "high" };
  const tiers = tiersFor(parent.model);
  const fast = { tier: "fast" as const };
  expect(resolve({}, [GENERAL], fast, tiers, parent, { context: {} })).toMatchObject({ model: "anthropic/claude-haiku-5", tier: "fast" });
  expect(resolve({}, [GENERAL], fast, tiers, parent, { context: { parentTokens: 99_000 } })).not.toHaveProperty("note");
  expect(resolve({}, [GENERAL], fast, tiers, parent, { context: { fork: true } })).toMatchObject({ model: "anthropic/claude-sonnet-5-5", tier: "balanced", note: "not Haiku: forked context" });
  expect(resolve({}, [GENERAL], fast, tiers, parent, { context: { parentTokens: 142_400 } })).toMatchObject({ note: "not Haiku: parent context 142k" });
  expect(resolve({ model: "anthropic/claude-haiku-5" }, [GENERAL], fast, tiers, parent, { context: { fork: true } })).not.toHaveProperty("note");
  const singleton = { models: { fast: "anthropic/claude-haiku-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS };
  expect(resolve({ agent: "general" }, agents, undefined, singleton, parent, { context: { fork: true }, available: registry("anthropic", ["claude-haiku-5"]) }))
    .toMatchObject({ model: parent.model, note: "not Haiku: forked context; parent fallback: no usable role or tier mapping for anthropic", byJev: { model: false }, source: { model: "default" } });
});
