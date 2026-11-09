import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  compareGeneration,
  familyOf,
  formatModelSpec,
  parseModelSpec,
  ROLE_MODEL_CHANNEL,
  sameModel,
  snapshotAvailableImplementationModels,
  subagentRoleModel,
} from "../src/implementation-models.js";
import { modelCatalog, normalizeEffort } from "../src/model-catalog.js";
import { createMockPi } from "./shared/support.js";

test("model specs parse provider, slash-containing model IDs, and known effort suffixes", () => {
  assert.deepEqual(parseModelSpec("anthropic/claude-sonnet-5"), {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
  });
  assert.deepEqual(parseModelSpec("anthropic/claude-sonnet-5:high"), {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    thinkingLevel: "high",
  });
  assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-opus:XHIGH"), {
    provider: "openrouter",
    modelId: "anthropic/claude-opus",
    thinkingLevel: "xhigh",
  });
  assert.deepEqual(parseModelSpec("bedrock/anthropic.claude-v1:0"), {
    provider: "bedrock",
    modelId: "anthropic.claude-v1:0",
  });
  for (const invalid of ["", "no-slash", "/missing-provider", "provider/", 42, undefined]) {
    assert.equal(parseModelSpec(invalid), undefined, String(invalid));
  }
  assert.equal(formatModelSpec({ provider: "a", modelId: "b", thinkingLevel: "low" }), "a/b:low");
  assert.equal(formatModelSpec({ provider: "a", modelId: "b" }), "a/b");
});

const opus = { provider: "anthropic", modelId: "opus", thinkingLevel: "xhigh" as const };
const sonnet = { provider: "anthropic", modelId: "sonnet", thinkingLevel: "medium" as const };

test("scoped availability limits the snapshot; the available scope includes models outside the cycling shortlist", () => {
  const astra = { provider: "openai-codex", id: "gpt-6-astra" };
  const sol = { provider: astra.provider, id: "gpt-6-sol" };
  const terra = { provider: astra.provider, id: "gpt-6-terra" };
  const ctx = {
    modelRegistry: { getAvailable: () => [astra, sol, terra] },
    scopedModels: [{ model: astra }, { model: sol }],
  } as unknown as ExtensionContext;
  assert.deepEqual(snapshotAvailableImplementationModels(ctx), [astra, sol]);
  assert.deepEqual(snapshotAvailableImplementationModels(ctx, "available"), [astra, sol, terra]);
  assert.deepEqual(modelCatalog(ctx).available, [astra, sol]);
  assert.deepEqual(modelCatalog(ctx, "available").available, [astra, sol, terra]);
  const unscoped = { modelRegistry: { getAvailable: () => [terra] }, scopedModels: [] } as unknown as ExtensionContext;
  assert.deepEqual(snapshotAvailableImplementationModels(unscoped), [terra]);
  const empty = { modelRegistry: { getAvailable: () => [] }, scopedModels: [] } as unknown as ExtensionContext;
  assert.deepEqual(snapshotAvailableImplementationModels(empty), []);
});

test("sameModel compares provider and model ID only", () => {
  const spec = { provider: "a", modelId: "b", thinkingLevel: "low" as const };
  assert.equal(sameModel({ provider: "a", modelId: "b" }, spec), true);
  assert.equal(sameModel({ provider: "a", modelId: "b" }, { provider: "c", modelId: "b" }), false);
  assert.equal(sameModel(undefined, spec), false);
  assert.equal(sameModel(undefined, undefined), false);
});

test("familyOf reads provider-local families and numeric generations, and ignores snapshots and aliases", () => {
  assert.deepEqual(familyOf({ provider: "openai", modelId: "gpt-6.10-sol" }), { family: "sol", generation: [6, 10] });
  assert.deepEqual(familyOf({ provider: "openai-codex", modelId: "gpt-6.1-astra" }), {
    family: "astra",
    generation: [6, 1],
  });
  assert.deepEqual(familyOf({ provider: "anthropic", modelId: "claude-fable-5-5" }), {
    family: "fable",
    generation: [5, 5],
  });
  for (const model of [
    { provider: "anthropic", modelId: "claude-sonnet-5-5-20261001" },
    { provider: "anthropic", modelId: "claude-opus-latest" },
    { provider: "openai", modelId: "gpt-6.1-astra-20261001" },
    { provider: "openrouter", modelId: "gpt-6.1-astra" },
    { provider: "other", modelId: "unknown" },
  ]) {
    assert.equal(familyOf(model), undefined, model.modelId);
  }
});

test("compareGeneration compares numerically, padding missing parts with zero", () => {
  assert.ok(compareGeneration([6, 10], [6, 2]) > 0);
  assert.ok(compareGeneration([6, 1], [6, 10]) < 0);
  assert.equal(compareGeneration([6], [6, 0]), 0);
  assert.equal(compareGeneration([6, 1], [6, 1]), 0);
});

test("effort normalization retains supported/default levels and rounds unsupported requests down", () => {
  const supported = [undefined, "low", "medium", "high"] as const;
  assert.equal(normalizeEffort("medium", supported), "medium");
  assert.equal(normalizeEffort("xhigh", supported), "high");
  assert.equal(normalizeEffort("minimal", supported), "low");
  assert.equal(normalizeEffort("max", [undefined, "medium", "low"]), "medium");
  assert.equal(normalizeEffort(undefined, supported), undefined);
  assert.equal(normalizeEffort("high", [undefined]), undefined);
  assert.equal(normalizeEffort("high", []), undefined);
});

test("catalog uses registry capabilities for an unscoped model without offering it", () => {
  const current = {
    provider: "openai",
    id: "gpt-6.1-astra",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
  };
  const scoped = { provider: "openai", id: "gpt-6.1-sol", reasoning: false };
  const ctx = {
    modelRegistry: {
      getAvailable: () => [current, scoped],
      find: (provider: string, id: string) =>
        provider === current.provider && id === current.id ? current : undefined,
    },
    scopedModels: [{ model: scoped }],
  } as unknown as ExtensionContext;
  const catalog = modelCatalog(ctx);
  const spec = { provider: current.provider, modelId: current.id };
  assert.deepEqual(catalog.available, [scoped]);
  assert.deepEqual(catalog.efforts(spec), [undefined, "off", "low", "medium", "high", "xhigh"]);
  assert.equal(normalizeEffort("max", catalog.efforts(spec)), "xhigh");
  assert.deepEqual(catalog.efforts({ provider: scoped.provider, modelId: scoped.id }), [undefined]);
});

test("subagentRoleModel asks pi-subagents over the bus and parses its reply", () => {
  const mock = createMockPi();
  assert.equal(subagentRoleModel(mock.eventBus, "scout", opus), undefined, "no listener");
  const seen: unknown[] = [];
  const off = mock.eventBus.on(ROLE_MODEL_CHANNEL, (data) => {
    seen.push({ ...(data as object) });
    (data as { reply?: unknown }).reply = { model: "anthropic/sonnet", thinking: "medium", source: "profile" };
  });
  assert.deepEqual(subagentRoleModel(mock.eventBus, "scout", opus), sonnet);
  assert.deepEqual(seen, [{ role: "scout", parent: "anthropic/opus", thinking: "xhigh" }]);
  off?.();
  mock.eventBus.on(ROLE_MODEL_CHANNEL, (data) => {
    (data as { reply?: unknown }).reply = { model: "nonsense", thinking: "medium" };
  });
  assert.equal(subagentRoleModel(mock.eventBus, "scout", opus), undefined, "an invalid model");
  assert.equal(
    subagentRoleModel(
      {
        emit: () => {
          throw new Error("unavailable");
        },
      },
      "scout",
      opus,
    ),
    undefined,
  );
});
