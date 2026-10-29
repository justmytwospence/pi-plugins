import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatModelSpec,
  implementationTarget,
  parseModelSpec,
  ROLE_MODEL_CHANNEL,
  subagentWorkerModel,
} from "../src/implementation-models.js";
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
const haiku = { provider: "anthropic", modelId: "haiku" };
const available = [
  { provider: "anthropic", id: "opus" },
  { provider: "anthropic", id: "sonnet" },
  { provider: "anthropic", id: "haiku" },
];

test("implementationTarget prefers the map, then the worker model, then the fallback", () => {
  const map = { "anthropic/opus": haiku };
  const base = { planModel: opus, map, worker: sonnet, fallback: opus, available };
  assert.deepEqual(implementationTarget(base), {
    spec: { provider: "anthropic", modelId: "haiku", thinkingLevel: "xhigh" },
    source: "map",
  });
  // A mapped model that is not available falls through to the worker, then the fallback.
  const some = [available[0] as (typeof available)[number], available[1] as (typeof available)[number]];
  assert.deepEqual(implementationTarget({ ...base, available: some }), { spec: sonnet, source: "subagents" });
  assert.deepEqual(implementationTarget({ ...base, available: some, worker: undefined }), {
    spec: opus,
    source: "fallback",
  });
  // An empty list accepts what is configured.
  assert.equal(implementationTarget({ ...base, available: [] })?.source, "map");
  assert.equal(implementationTarget({ ...base, map: undefined, available: [] })?.source, "subagents");
  assert.equal(
    implementationTarget({ planModel: undefined, map: undefined, worker: undefined, fallback: undefined, available }),
    undefined,
  );
  // A mapped entry's own effort wins.
  assert.equal(implementationTarget({ ...base, map: { "anthropic/opus": sonnet } })?.spec.thinkingLevel, "medium");
});

test("subagentWorkerModel asks pi-subagents over the bus and parses its reply", () => {
  const mock = createMockPi();
  assert.equal(subagentWorkerModel(mock.eventBus, opus), undefined, "no listener");
  const seen: unknown[] = [];
  const off = mock.eventBus.on(ROLE_MODEL_CHANNEL, (data) => {
    seen.push({ ...(data as object) });
    (data as { reply?: unknown }).reply = { model: "anthropic/sonnet", thinking: "medium", source: "profile" };
  });
  assert.deepEqual(subagentWorkerModel(mock.eventBus, opus), sonnet);
  assert.deepEqual(seen, [{ role: "worker", parent: "anthropic/opus", thinking: "xhigh" }]);
  off?.();
  mock.eventBus.on(ROLE_MODEL_CHANNEL, (data) => {
    (data as { reply?: unknown }).reply = { model: "nonsense", thinking: "medium" };
  });
  assert.equal(subagentWorkerModel(mock.eventBus, opus), undefined, "an invalid model");
});
