import { expect, test } from "vitest";
import { agentDefaults } from "../src/pick.ts";
import { BUILTIN_AGENTS } from "../src/agents.ts";
import { familyTable, tierModels } from "../src/model-families.ts";
import { providerPolicy } from "../src/provider-policy.ts";

const table = familyTable([]);
const reg = (provider: string, ids: string[]) => ids.map((id) => ({ provider, id }));
const offered = (parent: string, ids: string[], tier: "fast" | "balanced" | "strong" | "premium") =>
  tierModels(table, parent, reg(parent.split("/")[0]!, ids), tier).map((model) => model.slice(model.indexOf("/") + 1));

test("Anthropic and both OpenAI provider names route four capability tiers without rewriting provider identity", () => {
  const claude = ["claude-haiku-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
  expect(["fast", "balanced", "strong", "premium"].map((tier) => offered("anthropic/claude-opus-5-5", claude, tier as "fast")[0]))
    .toEqual(["claude-haiku-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
  for (const provider of ["openai", "openai-codex"]) {
    expect(providerPolicy(`${provider}/gpt-6-astra`, table)?.profileProvider).toBe("openai");
    const ids = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"];
    expect(["fast", "balanced", "strong", "premium"].map((tier) => offered(`${provider}/gpt-6-astra`, ids, tier as "fast")[0]))
      .toEqual(["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]);
  }
});

test("plain and Antigravity Gemini are distinct stable, numeric-only Google routes", () => {
  const plain = "google/gemini-4-argon";
  const ids = ["gemini-3.8-flash-lite", "gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-argon", "gemini-4-carbon", "gemini-3.8-pro", "antigravity-gemini-4-hydrogen", "gemini-4-pro-image", "gemini-3.8-flash-preview", "gemini-3.8-flash-exp", "gemini-3.8-flash-image", "gemini-flash"];
  expect(offered(plain, ids, "fast")).toEqual(["gemini-3.8-flash-lite"]);
  expect(offered(plain, ids, "balanced")).toEqual(["gemini-4-hydrogen", "gemini-3.8-flash"]);
  expect(offered(plain, ids, "strong")).toEqual(["gemini-4-argon", "gemini-3.8-pro"]);
  expect(offered(plain, ids, "premium")).toEqual(["gemini-4-carbon"]);
  const ag = "google/antigravity-gemini-4-argon";
  expect(providerPolicy(ag, table)?.route.id).toBe("google/antigravity-gemini");
  const agIds = ["antigravity-gemini-3.8-flash", "antigravity-gemini-4-hydrogen", "antigravity-gemini-4-argon", "antigravity-gemini-4-carbon", "antigravity-gemini-3.8-pro", "gemini-3.8-flash", "gemini-4-argon", "antigravity-gemini-3.8-flash-lite", "antigravity-gemini-4-argon-preview"];
  expect(offered(ag, agIds, "fast")).toEqual(["antigravity-gemini-4-hydrogen", "antigravity-gemini-3.8-flash"]);
  expect(offered(ag, agIds, "balanced")).toEqual(["antigravity-gemini-4-hydrogen", "antigravity-gemini-3.8-flash"]);
  expect(offered(ag, agIds, "strong")).toEqual(["antigravity-gemini-4-argon", "antigravity-gemini-3.8-pro"]);
  expect(offered(ag, agIds, "premium")).toEqual(["antigravity-gemini-4-carbon"]);
});

test("Antigravity Claude stays under google and never assumes a premium Fable", () => {
  const parent = "google/antigravity-claude-opus-5-5";
  expect(providerPolicy(parent, table)).toMatchObject({ profileProvider: "anthropic" });
  const ids = ["antigravity-claude-sonnet-5-5", "antigravity-claude-opus-5-5", "antigravity-claude-fable-5-1", "claude-sonnet-5-5"];
  expect(offered(parent, ids, "fast")).toEqual(["antigravity-claude-sonnet-5-5"]);
  expect(offered(parent, ids, "balanced")).toEqual(["antigravity-claude-sonnet-5-5"]);
  expect(offered(parent, ids, "strong")).toEqual(["antigravity-claude-opus-5-5"]);
  expect(offered(parent, ids, "premium")).toEqual([]);
});

test("Muse Standard versioned Spark and Wonder exclude bare aliases, contributor, Full and media variants", () => {
  const parent = "muse-code/muse-wonder-1.0";
  const ids = ["muse-spark", "muse-spark-1.3", "muse-spark-2", "muse-spark-1.3-contributor", "muse-spark-1.3-full", "muse-spark-1.3-image", "muse-spark-preview", "muse-wonder", "muse-wonder-1.0", "muse-wonder-1.0-contributor", "muse-wonder-1.0-full"];
  expect(offered(parent, ids, "fast")).toEqual(["muse-spark-2", "muse-spark-1.3"]);
  expect(offered(parent, ids, "strong")).toEqual(["muse-wonder-1.0"]);
  expect(offered(parent, ids, "premium")).toEqual([]);
});

test("unknown, local, Google unknown and prototype-property providers have no invented hierarchy", () => {
  for (const parent of ["lmstudio/qwen", "mtplx/qwen", "other/model", "google/other", "__proto__/model", "constructor/model", "toString/model", "", "anthropic"]) expect(providerPolicy(parent, table)).toBeUndefined();
});

test("built-in role profiles follow the parent's route, keeping its prefix and the role's effort", () => {
  const worker = BUILTIN_AGENTS.find((a) => a.name === "worker")!;
  const available = [...reg("google", ["gemini-4-hydrogen", "antigravity-gemini-4-hydrogen", "antigravity-claude-sonnet-5-5"]), ...reg("openai-codex", ["gpt-6.1-terra"])];
  expect(agentDefaults(worker, "google/antigravity-gemini-4-argon", available)).toEqual({ model: "google/antigravity-gemini-4-hydrogen", thinking: "medium" });
  expect(agentDefaults(worker, "google/gemini-4-argon", available)).toEqual({ model: "google/gemini-4-hydrogen", thinking: "medium" });
  expect(agentDefaults(worker, "google/antigravity-claude-opus-5-5", available)).toEqual({ model: "google/antigravity-claude-sonnet-5-5", thinking: "medium" });
  expect(agentDefaults(worker, "openai-codex/gpt-6-astra", available)).toEqual({ model: "openai-codex/gpt-6.1-terra", thinking: "medium" });
  expect(worker.tiers).toEqual({ anthropic: { tier: "balanced", thinking: "medium" }, openai: { tier: "balanced", thinking: "medium" }, google: { tier: "balanced", thinking: "medium" }, "muse-code": { tier: "balanced", thinking: "medium" } });
});
