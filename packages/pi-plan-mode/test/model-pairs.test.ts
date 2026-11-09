import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILTIN_PAIRS, pairDefinitions, pairKey, resolvePair } from "../src/model-pairs.js";

const catalog = (...ids: string[]) =>
  ids.map((entry) => {
    const slash = entry.indexOf("/");
    return { provider: entry.slice(0, slash), id: entry.slice(slash + 1) };
  });

const def = (key: string) => {
  const found = pairDefinitions(undefined).find((candidate) => pairKey(candidate) === key);
  assert.ok(found, key);
  return found;
};

test("the built-in pairs are the planner families one step down", () => {
  assert.deepEqual(
    BUILTIN_PAIRS.map((pair) => [pairKey(pair), pair.name]),
    [
      ["anthropic/fableplan", "Fable plan, Opus build"],
      ["anthropic/opusplan", "Opus plan, Sonnet build"],
      ["openai-codex/astraplan", "Astra plan, Sol build"],
      ["openai-codex/solplan", "Sol plan, Terra build"],
      ["openai/astraplan", "Astra plan, Sol build"],
      ["openai/solplan", "Sol plan, Terra build"],
    ],
  );
});

test("opusplan resolves to the highest generation of each family", () => {
  const resolved = resolvePair(
    def("anthropic/opusplan"),
    catalog(
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-opus-4-1",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4-5-20250929",
    ),
  );
  assert.deepEqual(resolved, {
    planner: { provider: "anthropic", modelId: "claude-opus-4-5" },
    worker: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  });
});

test("the worker prefers the planner's generation", () => {
  const resolved = resolvePair(
    def("anthropic/fableplan"),
    catalog("anthropic/claude-fable-5-1", "anthropic/claude-opus-5-1", "anthropic/claude-opus-5-5"),
  );
  assert.deepEqual(resolved, {
    planner: { provider: "anthropic", modelId: "claude-fable-5-1" },
    worker: { provider: "anthropic", modelId: "claude-opus-5-1" },
  });
});

test("a missing planner family is an error naming it", () => {
  const resolved = resolvePair(def("anthropic/fableplan"), catalog("anthropic/claude-opus-5-5"));
  assert.deepEqual(resolved, { error: "no available Fable model on anthropic" });
});

test("a missing worker family is an error naming it", () => {
  const resolved = resolvePair(def("anthropic/opusplan"), catalog("anthropic/claude-opus-5-5"));
  assert.deepEqual(resolved, { error: "no available Sonnet model on anthropic" });
});

test("the Astra and Sol pairs resolve on openai-codex and openai", () => {
  for (const provider of ["openai-codex", "openai"]) {
    const resolved = resolvePair(
      def(`${provider}/astraplan`),
      catalog(`${provider}/gpt-6-astra`, `${provider}/gpt-6-sol`, `${provider}/gpt-6-terra`),
    );
    assert.deepEqual(resolved, {
      planner: { provider, modelId: "gpt-6-astra" },
      worker: { provider, modelId: "gpt-6-sol" },
    });
  }
});

test("a custom pair replaces a built-in key in place and a new key is appended", () => {
  const defs = pairDefinitions({
    "anthropic/opusplan": {
      planner: { provider: "anthropic", modelId: "claude-opus-5-5" },
      worker: { provider: "anthropic", modelId: "claude-sonnet-5-1" },
      name: "Mine",
    },
    "openai/deep": {
      planner: { provider: "openai", modelId: "gpt-6-astra" },
      worker: { provider: "openai", modelId: "gpt-6-terra" },
    },
  });
  assert.equal(defs.length, BUILTIN_PAIRS.length + 1);
  assert.equal(defs[1] && pairKey(defs[1]), "anthropic/opusplan");
  assert.equal(defs[1]?.name, "Mine");
  const added = defs[defs.length - 1];
  assert.equal(added && pairKey(added), "openai/deep");
  assert.equal(added?.name, "gpt-6-astra plan, gpt-6-terra build");
  assert.deepEqual(resolvePair(defs[1] as never, catalog("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-1")), {
    planner: { provider: "anthropic", modelId: "claude-opus-5-5" },
    worker: { provider: "anthropic", modelId: "claude-sonnet-5-1" },
  });
  assert.deepEqual(resolvePair(defs[1] as never, catalog("anthropic/claude-opus-5-5")), {
    error: "anthropic/claude-sonnet-5-1 is not available",
  });
});

test("identical planner and worker is an error", () => {
  const defs = pairDefinitions({
    "x/same": {
      planner: { provider: "x", modelId: "m" },
      worker: { provider: "x", modelId: "m" },
    },
  });
  assert.deepEqual(resolvePair(defs[defs.length - 1] as never, catalog("x/m")), {
    error: "planner and worker are the same model",
  });
});
