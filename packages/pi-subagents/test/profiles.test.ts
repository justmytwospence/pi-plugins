import { expect, test } from "vitest";
import { BUILTIN_AGENTS, GENERAL, parseAgent, parseModels } from "../src/agents.ts";
import { DEFAULT_TIER_DESCRIPTIONS, agentDefaults, clampThinking, haikuGuard, pickQuestions, profileModel, providerTiers, resolve } from "../src/pick.ts";

const agents = BUILTIN_AGENTS;
const role = (name: string) => agents.find((a) => a.name === name)!;
const registry = (provider: string, ids: string[]) => ids.map((id) => ({ provider, id }));
const claude = registry("anthropic", ["claude-haiku-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
const codex = registry("openai-codex", ["gpt-6-luna", "gpt-6.1-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.1-astra"]);
const available = [...claude, ...codex];
const opus = { model: "anthropic/claude-opus-5-5", thinking: "high" };
const sol = { model: "openai-codex/gpt-6.1-sol", thinking: "medium" };
const tiersFor = (parent: string) => ({ models: providerTiers(parent, {}, {}, available), descriptions: DEFAULT_TIER_DESCRIPTIONS });

test("frontmatter `models` parses per provider, with an optional thinking suffix and bare ids", () => {
  const agent = parseAgent("---\nname: scout\ndescription: d\nmodels:\n  anthropic: anthropic/claude-sonnet-5-5:low\n  openai-codex: gpt-6-luna\n  openai: anthropic/claude-opus-5-5\n  ollama: ollama/llama3:8b\n---\n", "user")!;
  expect(agent.models).toEqual({
    anthropic: { model: "anthropic/claude-sonnet-5-5", thinking: "low" },
    "openai-codex": { model: "openai-codex/gpt-6-luna" },
    // A colon that is not a thinking level is part of the id.
    ollama: { model: "ollama/llama3:8b" },
  });
  expect(parseModels("anthropic/claude-sonnet-5-5")).toBeUndefined();
  expect(parseModels({ anthropic: 5, x: "" })).toBeUndefined();
  expect(parseAgent("---\nname: a\ndescription: d\n---\n", "user")).not.toHaveProperty("models");
});

test("each role resolves its own model and effort on the parent's provider", () => {
  const rows = (parent: typeof opus) => Object.fromEntries(agents.map((a) => {
    const r = resolve({ agent: a.name }, agents, undefined, tiersFor(parent.model), parent, { available }) as { model: string; thinking: string };
    return [a.name, `${r.model.split("/")[1]} ${r.thinking}`];
  }));
  expect(rows(opus)).toEqual({
    general: "claude-sonnet-5-5 high",
    explorer: "claude-sonnet-5-5 low",
    worker: "claude-sonnet-5-5 medium",
    reviewer: "claude-opus-5-5 high",
    researcher: "claude-sonnet-5-5 medium",
    writer: "claude-sonnet-5-5 medium",
    planner: "claude-opus-5-5 high",
  });
  expect(rows(sol)).toEqual({
    general: "gpt-6.1-terra medium",
    explorer: "gpt-6-luna high",
    worker: "gpt-6.1-sol medium",
    reviewer: "gpt-6.1-sol high",
    researcher: "gpt-6.1-terra medium",
    writer: "gpt-6.1-terra medium",
    planner: "gpt-6.1-sol high",
  });
});

test("a Codex parent never gets an Anthropic model implicitly; a provider without a profile uses the tier rules", () => {
  const anthropicOnly = parseAgent("---\nname: scout\ndescription: d\nmodels:\n  anthropic: anthropic/claude-haiku-5:low\n---\n", "user")!;
  const list = [GENERAL, anthropicOnly];
  const r = resolve({ agent: "scout" }, list, { tier: "strong", thinking: "high" }, tiersFor(sol.model), sol, { available });
  expect(r).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "high", tier: "strong", byJev: { model: true, thinking: true } });
  for (const agent of agents) {
    const own = resolve({ agent: agent.name }, agents, { tier: "fast" }, tiersFor(sol.model), sol, { available }) as { model: string };
    expect(own.model).toMatch(/^openai-codex\//u);
  }
  // Another provider: no profile and no presets, so the parent's model.
  const other = { model: "other/model", thinking: "low" };
  expect(resolve({ agent: "reviewer" }, agents, undefined, tiersFor(other.model), other, { available })).toMatchObject({ model: "other/model", thinking: "low" });
});

test("explicit arguments override a profile; Jev's tier and effort answers are ignored for a profiled role", () => {
  const tiers = tiersFor(opus.model);
  expect(resolve({ agent: "reviewer", model: "openai-codex/gpt-6.1-astra", thinking: "xhigh" }, agents, undefined, tiers, opus, { available }))
    .toMatchObject({ model: "openai-codex/gpt-6.1-astra", thinking: "xhigh", byJev: { model: false, thinking: false } });
  expect(resolve({ agent: "explorer", thinking: "medium" }, agents, undefined, tiers, opus, { available })).toMatchObject({ model: "anthropic/claude-sonnet-5-5", thinking: "medium" });
  const r = resolve({}, agents, { agent: "planner", tier: "fast", thinking: "low", pressure: 0.8 }, tiers, opus, { available });
  expect(r).toMatchObject({ agent: { name: "planner" }, model: "anthropic/claude-opus-5-5", thinking: "high", byJev: { agent: true, model: false, thinking: false } });
  expect(r).not.toHaveProperty("pressure");
  expect(r).not.toHaveProperty("tier");
});

test("profiled roles leave no tier or effort question; general and unprofiled providers still ask them", () => {
  const tiers = tiersFor(opus.model);
  const asked = (name: string, parent: string) => Object.keys(pickQuestions({ ...agentDefaults(role(name), parent, available), agent: name }, agents, tiers, true));
  for (const name of ["explorer", "worker", "reviewer", "researcher", "writer", "planner"]) {
    expect(asked(name, opus.model)).toEqual([]);
    expect(asked(name, sol.model)).toEqual([]);
    expect(asked(name, "other/model")).toEqual(["tier", "effort"]);
  }
  expect(asked("general", opus.model)).toEqual(["tier", "effort"]);
});

test("an unregistered profile id falls back to the newest registered model of its family, else to the tier rules", () => {
  const newer = registry("anthropic", ["claude-sonnet-6", "claude-sonnet-5-0", "claude-opus-6"]);
  expect(profileModel({ model: "anthropic/claude-sonnet-5-5", thinking: "low" }, "anthropic", newer)).toEqual({ model: "anthropic/claude-sonnet-6", thinking: "low" });
  expect(profileModel({ model: "openai-codex/gpt-6.1-sol" }, "openai-codex", registry("openai-codex", ["gpt-6.2-sol", "gpt-6-sol"]))).toEqual({ model: "openai-codex/gpt-6.2-sol" });
  // Nothing of the family registered, or no family: no profile model.
  expect(profileModel({ model: "anthropic/claude-sonnet-5-5" }, "anthropic", registry("anthropic", ["claude-opus-6"]))).toBeUndefined();
  expect(profileModel({ model: "anthropic/claude-custom" }, "anthropic", newer)).toBeUndefined();
  // A registry that lists nothing for the provider cannot say: the id as written.
  expect(profileModel({ model: "anthropic/claude-sonnet-5-5" }, "anthropic", [])).toEqual({ model: "anthropic/claude-sonnet-5-5" });
  // Through resolve: the reviewer's Opus id is stale, so the newest Opus.
  expect(resolve({ agent: "reviewer" }, agents, undefined, tiersFor(opus.model), opus, { available: newer })).toMatchObject({ model: "anthropic/claude-opus-6", thinking: "high" });
  // No Sonnet at all: the explorer falls back to the tier rules for model and effort (balanced, else the parent; Jev's effort, else the parent's).
  const opusOnly = registry("anthropic", ["claude-opus-5-5"]);
  const tiers = { models: providerTiers(opus.model, {}, {}, opusOnly), descriptions: DEFAULT_TIER_DESCRIPTIONS };
  expect(resolve({ agent: "explorer" }, agents, undefined, tiers, opus, { available: opusOnly })).toMatchObject({ model: opus.model, tier: "balanced", thinking: "high" });
  expect(resolve({ agent: "explorer" }, agents, { thinking: "low" }, tiers, opus, { available: opusOnly })).toMatchObject({ thinking: "low", byJev: { thinking: true } });
  expect(Object.keys(pickQuestions({ ...agentDefaults(role("explorer"), opus.model, opusOnly), agent: "explorer" }, agents, tiers, true))).toEqual(["tier", "effort"]);
});

test("a fixed effort is clamped to the levels the model supports", () => {
  const plain = { provider: "p", id: "m", reasoning: false };
  const capped = { provider: "p", id: "c", reasoning: true, thinkingLevelMap: { minimal: null } };
  const xhigh = { provider: "p", id: "x", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
  expect(clampThinking("high", plain)).toBe("off");
  expect(clampThinking("xhigh", capped)).toBe("high");
  expect(clampThinking("minimal", capped)).toBe("low");
  expect(clampThinking("xhigh", xhigh)).toBe("xhigh");
  expect(clampThinking("high", undefined)).toBe("high");
  const scout = parseAgent("---\nname: scout\ndescription: d\nmodels:\n  p: p/c:xhigh\n---\n", "user")!;
  expect(agentDefaults(scout, "p/c", [capped])).toEqual({ model: "p/c", thinking: "high" });
});

test("the Haiku guard: a fast pick on Anthropic becomes balanced for a forked run or a parent past 100k tokens", () => {
  const tiers = tiersFor(opus.model);
  const fast = { tier: "fast" as const };
  expect(resolve({}, [GENERAL], fast, tiers, opus, { context: {} })).toMatchObject({ model: "anthropic/claude-haiku-5", tier: "fast" });
  expect(resolve({}, [GENERAL], fast, tiers, opus, { context: { parentTokens: 99_000 } })).not.toHaveProperty("note");
  expect(resolve({}, [GENERAL], fast, tiers, opus, { context: { fork: true } }))
    .toMatchObject({ model: "anthropic/claude-sonnet-5-5", tier: "balanced", note: "not Haiku: forked context", byJev: { model: true } });
  expect(resolve({}, [GENERAL], fast, tiers, opus, { context: { parentTokens: 142_400 } }))
    .toMatchObject({ model: "anthropic/claude-sonnet-5-5", tier: "balanced", note: "not Haiku: parent context 142k" });
  // Not Haiku: no guard (a configured fast model, or another provider).
  expect(haikuGuard("anthropic/claude-sonnet-5-5", { fork: true })).toBeUndefined();
  expect(resolve({}, [GENERAL], fast, tiersFor(sol.model), sol, { context: { fork: true } })).toMatchObject({ model: "openai-codex/gpt-6.1-luna", tier: "fast" });
  // An explicit model is never guarded.
  expect(resolve({ model: "anthropic/claude-haiku-5" }, [GENERAL], fast, tiers, opus, { context: { fork: true } })).toMatchObject({ model: "anthropic/claude-haiku-5" });
});
