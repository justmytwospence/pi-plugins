import { describe, expect, it } from "vitest";
import {
  compareNewest,
  cycleChoice,
  favoritePatterns,
  findModel,
  MODEL_ENTRY,
  modelDefault,
  modelFromBranch,
  resolveChoice,
  resolvePattern,
} from "../src/models.ts";

const m = (provider: string, id: string, name?: string) => ({ provider, id, api: provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses", ...(name ? { name } : {}) });
const MODELS = [
  m("anthropic", "claude-opus-4-5-20251101"),
  m("anthropic", "claude-opus-4-5"),
  m("anthropic", "claude-opus-4-8"),
  m("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
  m("anthropic", "claude-fable-5"),
  m("anthropic", "claude-fable-5-1", "Claude Fable 5.1"),
  m("openai-codex", "gpt-5.6-sol"),
  m("openai-codex", "gpt-6-sol"),
  m("openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol"),
  m("openai-codex", "gpt-6-astra", "GPT-6 Astra"),
  m("openai", "gpt-6.1-sol"),
];
const FAVS = ["anthropic/claude-opus-*", "anthropic/claude-fable-*", "openai-codex/gpt-*-sol", "openai-codex/gpt-*-astra:xhigh"];

describe("favorites", () => {
  it("resolves a glob to its newest match", () => {
    expect(resolvePattern("anthropic/claude-opus-*", MODELS).model?.id).toBe("claude-opus-5-5");
    expect(resolvePattern("anthropic/claude-fable-*", MODELS).model?.id).toBe("claude-fable-5-1");
    expect(resolvePattern("openai-codex/gpt-*-sol", MODELS).model).toMatchObject({ provider: "openai-codex", id: "gpt-6.1-sol" });
  });

  it("orders versions, then aliases over dated snapshots", () => {
    expect(compareNewest("gpt-6.1-sol", "gpt-6-sol")).toBeGreaterThan(0);
    expect(compareNewest("claude-opus-5-5", "claude-opus-4-8")).toBeGreaterThan(0);
    expect(compareNewest("claude-opus-4-5", "claude-opus-4-5-20251101")).toBeGreaterThan(0);
  });

  it("takes provider/id, an unambiguous bare id and a thinking suffix", () => {
    expect(resolvePattern("openai/gpt-6.1-sol", MODELS).model?.provider).toBe("openai");
    expect(resolvePattern("gpt-6.1-sol", MODELS).model).toBeUndefined();
    expect(resolvePattern("gpt-6-astra", MODELS).model?.provider).toBe("openai-codex");
    expect(resolvePattern("openai-codex/gpt-*-astra:xhigh", MODELS)).toMatchObject({ thinking: "xhigh", model: { id: "gpt-6-astra" } });
    expect(resolvePattern("anthropic/claude-nope-*", MODELS).model).toBeUndefined();
  });

  it("come from PI_SIDEBAR_MODELS, else Pi's enabled models", () => {
    expect(favoritePatterns({ PI_SIDEBAR_MODELS: " a/b , c/* " }, ["x/y"])).toEqual(["a/b", "c/*"]);
    expect(favoritePatterns({}, ["x/y"])).toEqual(["x/y"]);
    expect(favoritePatterns({}, undefined)).toEqual([]);
  });

  it("finds a favorite by a short name", () => {
    const favorites = FAVS.map((p) => resolvePattern(p, MODELS));
    expect(findModel("sol", favorites, MODELS)?.pattern).toBe("openai-codex/gpt-*-sol");
    expect(findModel("Opus", favorites, MODELS)?.pattern).toBe("anthropic/claude-opus-*");
    expect(findModel("astra", favorites, MODELS)?.thinking).toBe("xhigh");
    expect(findModel("anthropic/claude-opus-4-8", favorites, MODELS)?.model?.id).toBe("claude-opus-4-8");
    expect(findModel("claude", favorites, MODELS)).toBeUndefined();
  });

  it("cycles through same and the favorites that resolve", () => {
    const favorites = [...FAVS, "nope/x"].map((p) => resolvePattern(p, MODELS));
    expect(cycleChoice("same", favorites, 1)).toBe(FAVS[0]);
    expect(cycleChoice(FAVS[3]!, favorites, 1)).toBe("same");
    expect(cycleChoice("same", favorites, -1)).toBe(FAVS[3]);
  });
});

describe("the stored choice", () => {
  it("resolves same, another model, or an unavailable one", () => {
    expect(resolveChoice("same", MODELS)).toEqual({ kind: "same" });
    expect(resolveChoice("openai-codex/gpt-*-sol", MODELS)).toMatchObject({ kind: "other", label: "GPT-6.1 Sol" });
    expect(resolveChoice("nope/x", MODELS)).toEqual({ kind: "unavailable", pattern: "nope/x" });
  });

  it("follows the branch, defaulting to PI_SIDEBAR_MODEL or same", () => {
    const branch = [
      { type: "custom", customType: MODEL_ENTRY, data: { version: 1, model: "a/b", at: 1 } },
      { type: "custom", customType: MODEL_ENTRY, data: { version: 1, model: "same", at: 2 } },
    ];
    expect(modelFromBranch(branch)?.model).toBe("same");
    expect(modelFromBranch(branch.slice(0, 1))?.model).toBe("a/b");
    expect(modelFromBranch([])).toBeUndefined();
    expect(modelDefault({})).toBe("same");
    expect(modelDefault({ PI_SIDEBAR_MODEL: "sol" })).toBe("sol");
  });
});
