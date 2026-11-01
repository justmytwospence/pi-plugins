import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import type { FlowSnapshot } from "../src/flow-contract.js";
import {
  formatModelSpec,
  implementationChoices,
  linkedImplementationChoice,
  parseModelSpec,
  ROLE_MODEL_CHANNEL,
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

function choices(provider: string, planner: string, ids: string[]) {
  return implementationChoices({
    planModel: { provider, modelId: planner, thinkingLevel: "max" },
    map: undefined,
    available: ids.map((id) => ({ provider, id })),
  });
}

test("defaults follow provider-local family order without inheriting planner effort", () => {
  for (const provider of ["openai", "openai-codex"]) {
    const ids = ["gpt-6.1-terra", "gpt-6.1-astra", "gpt-6.1-sol"];
    for (const [planner, expected] of [
      ["gpt-6.1-astra", ["gpt-6.1-sol", "gpt-6.1-terra"]],
      ["gpt-6.1-sol", ["gpt-6.1-terra"]],
      ["gpt-6.1-terra", []],
    ] as const) {
      assert.deepEqual(
        choices(provider, planner, ids),
        expected.map((modelId) => ({
          spec: { provider, modelId },
          source: "default",
        })),
      );
    }
  }
  const ids = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-5"];
  assert.deepEqual(
    choices("anthropic", "claude-fable-5-5", ids).map((c) => c.spec.modelId),
    ["claude-opus-5-5", "claude-sonnet-5-5"],
  );
  assert.deepEqual(
    choices("anthropic", "claude-opus-5-5", ids).map((c) => c.spec.modelId),
    ["claude-sonnet-5-5"],
  );
  assert.deepEqual(choices("anthropic", "claude-sonnet-5-5", ids), []);
});

test("defaults prefer same generation, otherwise highest numeric generation with lexical ties", () => {
  for (const provider of ["openai", "openai-codex"]) {
    assert.deepEqual(
      choices(provider, "gpt-6.1-astra", [
        "gpt-6.10-sol",
        "gpt-6.2-sol",
        "gpt-6.1-sol",
        "gpt-6.2-terra",
        "gpt-6.10-terra",
      ]).map((c) => c.spec.modelId),
      ["gpt-6.1-sol", "gpt-6.10-terra"],
    );
  }
  assert.deepEqual(
    choices("anthropic", "claude-fable-5-5", [
      "claude-opus-6-10",
      "claude-opus-6-2",
      "claude-opus-5-5",
      "claude-sonnet-6-2",
      "claude-sonnet-6-10",
    ]).map((c) => c.spec.modelId),
    ["claude-opus-5-5", "claude-sonnet-6-10"],
  );
  for (const ids of [
    ["gpt-6.1-sol", "gpt-6.01-sol"],
    ["gpt-6.01-sol", "gpt-6.1-sol"],
  ]) {
    assert.equal(choices("openai", "gpt-6-astra", ids)[0]?.spec.modelId, "gpt-6.01-sol");
  }
});

test("defaults ignore other providers, display names, aliases and snapshot IDs", () => {
  assert.deepEqual(
    implementationChoices({
      planModel: { provider: "openai", modelId: "gpt-6.1-astra" },
      map: undefined,
      available: [
        { provider: "openai-codex", id: "gpt-6.1-sol" },
        { provider: "anthropic", id: "claude-sonnet-5-5" },
        { provider: "openai", id: "gpt-6.1-sol-20261001" },
        { provider: "openai", id: "alias", name: "gpt-6.1-terra" },
      ],
    }),
    [],
  );
  assert.deepEqual(choices("anthropic", "claude-opus-5-5", ["claude-sonnet-5-5-20261001", "claude-sonnet-latest"]), []);
  for (const [provider, planner] of [
    ["anthropic", "claude-opus-latest"],
    ["openai", "gpt-6.1-astra-20261001"],
    ["openrouter", "gpt-6.1-astra"],
    ["other", "unknown"],
  ] as const) {
    assert.deepEqual(choices(provider, planner, ["gpt-6.1-sol", "claude-sonnet-5-5"]), []);
  }
  assert.deepEqual(implementationChoices({ planModel: undefined, map: {}, available: [] }), []);
});

function linkedSnapshot(): FlowSnapshot {
  const model = { provider: "openai-codex", modelId: "gpt-6.1-sol" };
  return {
    version: 1,
    operatingMode: "linked",
    revision: 7,
    selectedFlow: {
      provider: model.provider,
      anchorModel: model.modelId,
      roles: {
        work: { ...model },
        chat: { ...model },
        plan: { ...model, suggestedThinking: "high" },
        exec: { ...model, suggestedThinking: "medium" },
      },
    },
    workflow: "plan",
    ready: true,
    guardAvailable: true,
    transitioning: false,
  };
}

const linkedAvailable = [{ provider: "openai-codex", id: "gpt-6.1-sol" }];

test("linked worker includes the same physical planner with explicit execution intent and a detached state", () => {
  const snapshot = linkedSnapshot();
  const choice = linkedImplementationChoice(snapshot, linkedAvailable);
  assert.deepEqual(choice, {
    spec: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "medium" },
    source: "linked",
    intent: "linked-execution",
    flow: {
      version: 1,
      operatingMode: "linked",
      selectedFlow: snapshot.selectedFlow,
      revision: 7,
    },
  });
  assert.ok(choice?.flow?.selectedFlow);
  assert.ok(snapshot.selectedFlow);
  assert.notEqual(choice.flow, snapshot);
  assert.notEqual(choice.flow.selectedFlow, snapshot.selectedFlow);
  assert.notEqual(choice.flow.selectedFlow.roles, snapshot.selectedFlow.roles);
  for (const role of ["work", "chat", "plan", "exec"] as const) {
    assert.notEqual(choice.flow.selectedFlow.roles[role], snapshot.selectedFlow.roles[role]);
  }
  snapshot.selectedFlow.roles.exec.modelId = "changed";
  snapshot.revision++;
  assert.equal(choice.spec.modelId, "gpt-6.1-sol");
  assert.equal(choice.flow.selectedFlow.roles.exec.modelId, "gpt-6.1-sol");
  assert.equal(choice.flow.revision, 7);
  choice.flow.selectedFlow.roles.plan.modelId = "other";
  assert.equal(snapshot.selectedFlow.roles.plan.modelId, "gpt-6.1-sol");
});

test("linked worker requires a ready, unblocked guarded flow and never falls back to another available model", () => {
  const snapshot = linkedSnapshot();
  for (const unavailable of [
    undefined,
    { ...snapshot, operatingMode: "independent" as const },
    { ...snapshot, ready: false },
    { ...snapshot, blocked: "Worker unavailable" },
    { ...snapshot, guardAvailable: false },
    { ...snapshot, selectedFlow: undefined },
  ]) {
    assert.equal(linkedImplementationChoice(unavailable, linkedAvailable), undefined);
  }
  for (const available of [
    [],
    [{ provider: "openai", id: "gpt-6.1-sol" }],
    [{ provider: "openai-codex", id: "gpt-6.1-terra" }],
    [{ provider: "openai-codex", id: "alias", name: "gpt-6.1-sol" }],
  ]) {
    assert.equal(linkedImplementationChoice(snapshot, available), undefined);
  }
  assert.ok(snapshot.selectedFlow);
  snapshot.selectedFlow.roles.exec.provider = "openai";
  assert.equal(linkedImplementationChoice(snapshot, [{ provider: "openai", id: "gpt-6.1-sol" }]), undefined);
});

test("linked worker uses only its captured assignment and validates optional suggested effort", () => {
  const snapshot = linkedSnapshot();
  assert.ok(snapshot.selectedFlow);
  const worker = snapshot.selectedFlow.roles.exec;
  worker.modelId = "custom-worker";
  for (const suggestedThinking of [undefined, "invalid", "off", "max"]) {
    worker.suggestedThinking = suggestedThinking;
    assert.deepEqual(
      linkedImplementationChoice(snapshot, [...linkedAvailable, { provider: worker.provider, id: worker.modelId }])
        ?.spec,
      {
        provider: worker.provider,
        modelId: "custom-worker",
        ...(suggestedThinking === "off" || suggestedThinking === "max" ? { thinkingLevel: suggestedThinking } : {}),
      },
    );
  }
});

const opus = { provider: "anthropic", modelId: "opus", thinkingLevel: "xhigh" as const };
const sonnet = { provider: "anthropic", modelId: "sonnet", thinkingLevel: "medium" as const };
const haiku = { provider: "anthropic", modelId: "haiku" };
const available = [opus, sonnet, haiku].map((spec) => ({ provider: spec.provider, id: spec.modelId }));

test("overrides replace defaults, remove planner identity and duplicates, and retain first effort", () => {
  const base = {
    planModel: opus,
    available,
    map: { "anthropic/opus": [opus, sonnet, { ...sonnet, thinkingLevel: "high" as const }, haiku] },
  };
  assert.deepEqual(implementationChoices(base), [
    { spec: sonnet, source: "map" },
    { spec: haiku, source: "map" },
  ]);
  assert.deepEqual(implementationChoices({ ...base, available: [] }), []);
  assert.deepEqual(implementationChoices({ ...base, available: [{ provider: haiku.provider, id: haiku.modelId }] }), [
    { spec: haiku, source: "map" },
  ]);
  const planner = { provider: "openai", modelId: "gpt-6.1-astra" };
  const defaults = [{ provider: "openai", id: "gpt-6.1-sol" }];
  assert.deepEqual(
    implementationChoices({ planModel: planner, map: { "openai/gpt-6.1-astra": [] }, available: defaults }),
    [],
  );
  assert.deepEqual(
    implementationChoices({ planModel: planner, map: { "openai/gpt-6.1-astra": [haiku] }, available: defaults }),
    [],
  );
  assert.deepEqual(implementationChoices({ planModel: planner, map: { "openai/gpt-6.1-astra": [haiku] }, available }), [
    { spec: haiku, source: "map" },
  ]);
  const plain = { provider: haiku.provider, modelId: haiku.modelId };
  assert.deepEqual(implementationChoices({ ...base, map: { "anthropic/opus": [plain] } }), [
    { spec: plain, source: "map" },
  ]);
});

test("explicit configuration is authoritative even for an unknown planning family or provider", () => {
  assert.deepEqual(
    implementationChoices({
      planModel: { provider: "custom", modelId: "unknown" },
      map: { "custom/unknown": [sonnet, haiku] },
      available,
    }),
    [
      { spec: sonnet, source: "map" },
      { spec: haiku, source: "map" },
    ],
  );
  const planModel = { provider: "openai", modelId: "gpt-6.1-astra" };
  assert.deepEqual(
    implementationChoices({
      planModel,
      map: Object.create({ "openai/gpt-6.1-astra": [] }),
      available: [{ provider: "openai", id: "gpt-6.1-sol" }],
    }),
    [{ spec: { provider: "openai", modelId: "gpt-6.1-sol" }, source: "default" }],
  );
});

test("scoped availability filters defaults, including an empty catalog", () => {
  const planModel = { provider: "openai", modelId: "gpt-6.1-astra" };
  const sol = { provider: "openai", id: "gpt-6.1-sol" };
  const terra = { provider: "openai", id: "gpt-6.1-terra" };
  const ctx = {
    modelRegistry: { getAvailable: () => [sol, terra] },
    scopedModels: [{ model: terra }],
  } as unknown as ExtensionContext;
  assert.deepEqual(
    implementationChoices({ planModel, map: undefined, available: snapshotAvailableImplementationModels(ctx) }),
    [{ spec: { provider: "openai", modelId: terra.id }, source: "default" }],
  );
  assert.deepEqual(choices("openai", planModel.modelId, []), []);
});

test("available scope offers authenticated targets outside the cycling shortlist", () => {
  const astra = { provider: "openai-codex", id: "gpt-6-astra" };
  const sol = { provider: astra.provider, id: "gpt-6-sol" };
  const terra = { provider: astra.provider, id: "gpt-6-terra" };
  const ctx = {
    modelRegistry: { getAvailable: () => [astra, sol, terra] },
    scopedModels: [{ model: astra }, { model: sol }],
  } as unknown as ExtensionContext;
  const planModel = { provider: astra.provider, modelId: astra.id };
  const target = { provider: terra.provider, modelId: terra.id };
  const available = snapshotAvailableImplementationModels(ctx, "available");
  assert.deepEqual(modelCatalog(ctx).available, [astra, sol]);
  assert.deepEqual(modelCatalog(ctx, "available").available, [astra, sol, terra]);
  assert.deepEqual(
    implementationChoices({ planModel, map: undefined, available }).map(({ spec }) => spec.modelId),
    [sol.id, terra.id],
  );
  assert.deepEqual(
    implementationChoices({ planModel, map: { "openai-codex/gpt-6-astra": [target] }, available }).map(
      ({ spec }) => spec,
    ),
    [target],
  );
  assert.deepEqual(implementationChoices({ planModel, map: { "openai-codex/gpt-6-astra": [] }, available }), []);
  assert.deepEqual(
    implementationChoices({
      planModel,
      map: { "openai-codex/gpt-6-astra": [{ ...target, modelId: "unavailable" }] },
      available,
    }),
    [],
  );
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
