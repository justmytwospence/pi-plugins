import { expect, test } from "vitest";
import { BUILTIN_AGENTS } from "../src/agents.ts";
import { providerPolicy, routeBuiltinProfile } from "../src/provider-policy.ts";

const matches = (parent: string, tier: "fast" | "balanced" | "strong" | "premium", accepted: string[], rejected: string[] = []) => {
  const pattern = providerPolicy(parent)?.tiers[tier];
  expect(pattern, `${parent} ${tier}`).toBeDefined();
  for (const id of accepted) expect(pattern!.test(id), `${id} should match ${parent} ${tier}`).toBe(true);
  for (const id of rejected) expect(pattern!.test(id), `${id} should not match ${parent} ${tier}`).toBe(false);
};

test("Anthropic and both OpenAI provider names route four capability tiers without rewriting provider identity", () => {
  matches("anthropic/claude-opus-5-5", "fast", ["claude-haiku-5"]);
  matches("anthropic/claude-opus-5-5", "balanced", ["claude-sonnet-5-5"]);
  matches("anthropic/claude-opus-5-5", "strong", ["claude-opus-5-5"]);
  matches("anthropic/claude-opus-5-5", "premium", ["claude-fable-5-1"]);
  for (const provider of ["openai", "openai-codex"]) {
    const policy = providerPolicy(`${provider}/gpt-6-astra`)!;
    expect(policy.profileProvider).toBe("openai");
    expect(policy.modelPrefix).toBe("");
    expect(policy.generationSuffixes).toEqual({ fast: "luna", balanced: "terra", strong: "sol" });
    for (const [tier, id] of [["fast", "gpt-6-luna"], ["balanced", "gpt-6.1-terra"], ["strong", "gpt-6.1-sol"], ["premium", "gpt-6-astra"]] as const) {
      matches(`${provider}/gpt-6-astra`, tier, [id]);
    }
  }
});

test("plain and Antigravity Gemini are distinct stable, numeric-only Google routes", () => {
  const plain = "google/gemini-4-argon";
  matches(plain, "fast", ["gemini-3.8-flash-lite", "gemini-4-flash-lite"], ["gemini-3.8-flash", "antigravity-gemini-3.8-flash-lite"]);
  matches(plain, "balanced", ["gemini-3.8-flash"], ["gemini-3.8-flash-lite"]);
  matches(plain, "strong", ["gemini-4-argon", "gemini-3.8-pro"], ["gemini-4-pro-image"]);
  const ag = "google/antigravity-gemini-4-argon";
  expect(providerPolicy(ag)?.modelPrefix).toBe("antigravity-");
  matches(ag, "fast", ["antigravity-gemini-3.8-flash"], ["gemini-3.8-flash", "antigravity-gemini-3.8-flash-lite"]);
  matches(ag, "balanced", ["antigravity-gemini-3.8-flash"]);
  matches(ag, "strong", ["antigravity-gemini-4-argon", "antigravity-gemini-3.8-pro"], ["gemini-4-argon"]);
  for (const parent of [plain, ag]) {
    expect(providerPolicy(parent)?.tiers.premium).toBeUndefined();
    for (const pattern of Object.values(providerPolicy(parent)!.tiers)) {
      for (const id of ["gemini-flash", "gemini-3x-flash", "gemini-3.8-flash-preview", "gemini-3.8-flash-exp", "gemini-3.8-flash-image", "antigravity-gemini-4-argon-preview"]) expect(pattern.test(id), id).toBe(false);
    }
  }
});

test("Antigravity Claude stays under google and never assumes a premium Fable", () => {
  const parent = "google/antigravity-claude-opus-5-5";
  expect(providerPolicy(parent)).toMatchObject({ profileProvider: "anthropic", modelPrefix: "antigravity-" });
  matches(parent, "fast", ["antigravity-claude-sonnet-5-5"], ["claude-sonnet-5-5"]);
  matches(parent, "balanced", ["antigravity-claude-sonnet-5-5"]);
  matches(parent, "strong", ["antigravity-claude-opus-5-5"], ["antigravity-claude-fable-5-1"]);
  expect(providerPolicy(parent)?.tiers.premium).toBeUndefined();
});

test("Muse Standard versioned Spark and Wonder exclude bare aliases, contributor, Full and media variants", () => {
  const parent = "muse-code/muse-wonder-1.0";
  for (const tier of ["fast", "balanced"] as const) matches(parent, tier, ["muse-spark-1.3", "muse-spark-2"], ["muse-spark", "muse-spark-1.3-contributor", "muse-spark-1.3-full", "muse-spark-1.3-image", "muse-spark-preview", "muse-spark-1.3.0-exp"]);
  matches(parent, "strong", ["muse-wonder-1.0"], ["muse-wonder", "muse-wonder-1.0-contributor", "muse-wonder-1.0-full", "muse-wonder-1.0-image"]);
  expect(providerPolicy(parent)?.tiers.premium).toBeUndefined();
});

test("unknown, local, Google unknown and prototype-property providers have no invented hierarchy", () => {
  for (const parent of ["lmstudio/qwen", "mtplx/qwen", "other/model", "google/other", "__proto__/model", "constructor/model", "toString/model", "", "anthropic"]) expect(providerPolicy(parent)).toBeUndefined();
});

test("only built-in profiles rebase the physical provider and route prefix, preserving effort and definitions", () => {
  const worker = BUILTIN_AGENTS.find((a) => a.name === "worker")!;
  const google = worker.models!.google!;
  const anthropic = worker.models!.anthropic!;
  expect(routeBuiltinProfile(google, "google/antigravity-gemini-4-argon", providerPolicy("google/antigravity-gemini-4-argon")!))
    .toEqual({ model: "google/antigravity-gemini-3.8-flash", thinking: "medium" });
  expect(routeBuiltinProfile(anthropic, "google/antigravity-claude-opus-5-5", providerPolicy("google/antigravity-claude-opus-5-5")!))
    .toEqual({ model: "google/antigravity-claude-sonnet-5-5", thinking: "medium" });
  expect(routeBuiltinProfile(worker.models!.openai!, "openai-codex/gpt-6-astra", providerPolicy("openai-codex/gpt-6-astra")!))
    .toEqual({ model: "openai-codex/gpt-6.1-terra", thinking: "medium" });
  expect(google).toEqual({ model: "google/gemini-3.8-flash", thinking: "medium" });
  expect(anthropic).toEqual({ model: "anthropic/claude-sonnet-5-5", thinking: "medium" });
});
