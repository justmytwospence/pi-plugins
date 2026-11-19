import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { bindGateShell } from "../src/gate-shell.js";
import { EXIT_TOOL, INLINE_ENTRY } from "../src/inline-plan.js";
import { builtinPairs, pairDefinitions, pairKey } from "../src/model-pairs.js";
import { PAIR_ENTRY, pairNote, registerPairs } from "../src/pairs.js";
import { PLAN_PAIR_CHANNEL, queryPlanPair } from "../src/plan-pair-contract.js";
import { SHELL_READS_CHANNEL } from "../src/shell-reads.js";
import { createMockContext } from "./shared/support.js";
import { createMockPi } from "./support.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const models = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Opus 4.5" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
];
const virtual = { provider: "anthropic", id: "opusplan", api: "pi-virtual" };

const premiumPairs = [
  { provider: "anthropic", id: "fableplan", planner: "claude-fable-5-1", worker: "claude-opus-5-1" },
  { provider: "openai", id: "astraplan", planner: "gpt-6-astra", worker: "gpt-6-sol" },
  { provider: "openai-codex", id: "astraplan", planner: "gpt-6-astra", worker: "gpt-6-sol" },
];
const premiumModels = premiumPairs.flatMap(({ provider, planner, worker }) => [
  { provider, id: planner, name: planner },
  { provider, id: worker, name: worker },
]);
const premiumVirtual = (pair: (typeof premiumPairs)[number]) => ({
  provider: pair.provider,
  id: pair.id,
  api: "pi-virtual",
});

function setup(
  options: {
    planning?: boolean;
    workflow?: string;
    available?: typeof models;
    model?: unknown;
    definitions?: ReturnType<typeof builtinPairs>;
  } = {},
) {
  const mock = createMockPi();
  const registered = new Map<string, { route(request: unknown, ctx: unknown): unknown }>();
  const unregistered: string[] = [];
  const raw = mock.rawPi as unknown as Record<string, unknown>;
  raw.registerVirtualModel = (model: {
    provider: string;
    id: string;
    route(request: unknown, ctx: unknown): unknown;
  }) => {
    registered.set(`${model.provider}/${model.id}`, model);
  };
  raw.unregisterVirtualModel = (provider: string, id: string) => {
    registered.delete(`${provider}/${id}`);
    unregistered.push(`${provider}/${id}`);
  };
  const state = {
    planning: options.planning ?? false,
    workflow: options.workflow as string | undefined,
    judged: [] as string[],
    level: "high" as string | undefined,
  };
  const controller = registerPairs(mock.pi, {
    planning: () => state.planning,
    workflow: () => state.workflow,
    safeSubcommands: () => undefined,
    judgePlanEffort: async (_ctx, prompt) => {
      state.judged.push(prompt);
      return state.level as never;
    },
  });
  controller.define(options.definitions ?? builtinPairs());
  const branch: unknown[] = [];
  const ctx = {
    cwd: "/repo",
    model: options.model ?? virtual,
    modelRegistry: {
      getAvailable: () => options.available ?? models,
      find: (provider: string, id: string) =>
        (options.available ?? models).find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: { getBranch: () => branch },
    hasUI: false,
  };
  const fire = async (name: string, event: unknown = {}) => {
    let last: unknown;
    for (const handler of (mock.events.get(name) ?? []) as Handler[]) last = await handler(event, ctx);
    return last;
  };
  const tool = (name: string) =>
    mock.tools.find((candidate) => candidate.name === name) as {
      execute(
        id: string,
        params: unknown,
        signal: undefined,
        update: undefined,
        ctx: unknown,
      ): Promise<{ content: { text: string }[] }>;
    };
  const route = (reason = "user", thinkingLevel = "medium") => {
    const model = ctx.model as { provider: string; id: string };
    return registered.get(pairKey(model))?.route({ model, thinkingLevel, reason }, ctx) as {
      model: { provider: string; id: string };
      thinkingLevel: string;
    };
  };
  const call = async (name: string, params: unknown) =>
    (await tool(name).execute("id", params, undefined, undefined, ctx)).content[0]?.text ?? "";
  return { mock, controller, state, ctx, fire, route, call, registered, unregistered, branch };
}

const pairEntry = (data: unknown) => ({ type: "custom", customType: PAIR_ENTRY, data });
const modelEntry = (model: { provider: string; id: string }) => ({
  type: "model_change",
  provider: model.provider,
  modelId: model.id,
});

for (const pair of premiumPairs) {
  const key = pairKey(pair);
  const make = (options: Parameters<typeof setup>[0] = {}) =>
    setup({ model: premiumVirtual(pair), available: premiumModels, ...options });

  test(`${key} retains the worker across settlement, follow-ups, chat and temporary planning`, async () => {
    const t = make();
    await t.fire("session_start");
    const parity = (phase: string, id: string, reason = "user") => {
      const routed = t.route(reason, t.mock.thinkingLevel);
      const snapshot = queryPlanPair(t.mock.eventBus);
      assert.equal(routed.model.id, id);
      assert.equal(snapshot?.phase, phase);
      assert.equal(snapshot?.pair, key);
      assert.deepEqual(snapshot?.next, { provider: routed.model.provider, id: routed.model.id });
      assert.equal(snapshot?.thinkingLevel, routed.thinkingLevel);
    };
    parity("work", pair.planner);
    t.state.workflow = "chat";
    parity("chat", pair.planner);
    assert.match(await t.call("ask_planner", { question: "before approval" }), /planner already answers/u);
    t.state.workflow = "work";
    assert.match(await t.call("ask_planner", { question: "before approval" }), /No approved plan/u);
    t.controller.approve(t.ctx as never, "/p/first.md");
    parity("build", pair.worker);
    assert.deepEqual(t.controller.state.workerHandoffs, {
      [key]: { planFile: "/p/first.md", planLevel: "off" },
    });
    assert.equal(t.controller.state.approvalPair, key);
    await t.fire("agent_settled", { aborted: true });
    assert.equal(t.controller.state.implementing, true);
    parity("build", pair.worker, "retry");
    await t.fire("agent_settled", { aborted: false });
    assert.equal(t.controller.state.implementing, false);
    parity("work", pair.worker);
    await t.fire("before_agent_start", { prompt: "an unrelated follow-up" });
    parity("work", pair.worker, "continuation");
    t.state.workflow = "chat";
    parity("chat", pair.worker);
    t.state.planning = true;
    t.controller.phaseChanged(t.ctx as never);
    parity("plan", pair.planner);
    assert.match(await t.call("ask_planner", { question: "while planning" }), /You are in plan mode/u);
    assert.deepEqual(t.controller.state.workerHandoffs?.[key], { planFile: "/p/first.md", planLevel: "off" });
    t.state.planning = false;
    t.controller.phaseChanged(t.ctx as never);
    parity("chat", pair.worker);
    t.state.workflow = "work";
    (t.mock.rawPi as { setThinkingLevel(level: string): void }).setThinkingLevel("xhigh");
    t.controller.approve(t.ctx as never, "/p/revised.md");
    parity("build", pair.worker);
    assert.deepEqual(t.controller.state.workerHandoffs?.[key], { planFile: "/p/revised.md", planLevel: "xhigh" });
    const persisted = t.mock.entries.filter((entry) => entry.customType === PAIR_ENTRY).at(-1)?.data;
    assert.deepEqual(persisted, t.controller.state);
    assert.equal(t.mock.setModels.length, 0, "routing never changes the selected model");
  });

  test(`${key} planning without any approval never creates a handoff`, async () => {
    const t = make({ planning: true });
    t.controller.phaseChanged(t.ctx as never);
    assert.equal(t.route().model.id, pair.planner);
    t.state.planning = false;
    t.controller.phaseChanged(t.ctx as never);
    await t.fire("agent_settled", { aborted: false });
    assert.equal(t.route().model.id, pair.planner);
    assert.equal(t.controller.state.workerHandoffs, undefined);
  });

  test(`${key} restores new snapshots on startup and tree navigation without sibling leakage`, async () => {
    const original = make();
    original.controller.approve(original.ctx as never, "/p/saved.md");
    await original.fire("agent_settled", { aborted: false });
    const history = original.mock.entries
      .filter((entry) => entry.customType === PAIR_ENTRY)
      .map((entry) => pairEntry(entry.data));
    const t = make();
    t.branch.push(...history);
    await t.fire("session_start");
    const { implementing, ...saved } = original.controller.state;
    assert.equal(implementing, false);
    assert.deepEqual(t.controller.state, saved, "restoration may omit a false optional implementing flag");
    assert.equal(t.route().model.id, pair.worker);
    t.branch.splice(0);
    await t.fire("session_tree");
    assert.equal(t.route().model.id, pair.planner, "a branch before approval has no handoff");
    assert.deepEqual(t.controller.state, { version: 1, consult: false });
    t.branch.push(...history);
    await t.fire("session_tree");
    assert.equal(t.route().model.id, pair.worker);
    t.state.planning = true;
    await t.fire("session_start");
    assert.equal(t.route().model.id, pair.planner, "restored inline planning overrides the saved handoff");
    t.state.planning = false;
    assert.equal(t.route().model.id, pair.worker);
    t.branch.splice(
      0,
      t.branch.length,
      pairEntry({
        version: 1,
        consult: false,
        approvalPair: key,
        workerHandoffs: {},
      }),
    );
    await t.fire("session_tree");
    assert.equal(t.route().model.id, pair.planner, "an authoritative empty snapshot clears the map");
  });

  test(`${key} migrates identified legacy approvals, retaining them after legacy settlement`, async () => {
    const t = make();
    t.branch.push(
      modelEntry(pair),
      pairEntry({ version: 1, consult: false, implementing: true, planFile: "/p/legacy.md", planLevel: "high" }),
      pairEntry({ version: 1, consult: false, implementing: false, planFile: "/p/legacy.md", planLevel: "high" }),
    );
    await t.fire("session_start");
    assert.equal(t.route().model.id, pair.worker);
    assert.deepEqual(t.controller.state.workerHandoffs, {
      [key]: { planFile: "/p/legacy.md", planLevel: "high" },
    });
    t.branch.push(pairEntry({ version: 1, consult: false, approvalPair: key }));
    await t.fire("session_tree");
    assert.equal(t.route().model.id, pair.planner, "new identity snapshots without maps are authoritative too");
    assert.equal(t.controller.state.workerHandoffs, undefined);
  });

  for (const workflow of ["work", "chat"]) {
    test(`${key} supports idle worker consultations in ${workflow} with saved metadata and guards`, async () => {
      const t = make();
      await t.fire("session_start");
      (t.mock.rawPi as { setThinkingLevel(level: string): void }).setThinkingLevel("high");
      t.controller.approve(t.ctx as never, "/p/approved.md");
      await t.fire("agent_settled", { aborted: false });
      t.state.workflow = workflow;
      (t.mock.rawPi as { setThinkingLevel(level: string): void }).setThinkingLevel("low");
      assert.match(await t.call("ask_planner", { question: "what next?" }), /The worker asks the planner/);
      assert.equal(t.controller.state.implementing, false);
      assert.equal(t.route("continuation", "low").model.id, pair.planner);
      assert.equal(t.route("continuation", "low").thinkingLevel, "high");
      const snapshot = queryPlanPair(t.mock.eventBus);
      assert.equal(snapshot?.phase, "consult");
      assert.deepEqual(snapshot?.next, { provider: pair.provider, id: pair.planner });
      assert.equal(snapshot?.thinkingLevel, "high");
      assert.equal(await t.fire("tool_call", { toolName: "edit", input: { path: "/p/approved.md" } }), undefined);
      assert.equal(await t.fire("tool_call", { toolName: "write", input: { path: "/p/approved.md" } }), undefined);
      for (const event of [
        { toolName: "write", input: { path: "/p/other.md" } },
        { toolName: "edit", input: { path: "/repo/src/a.ts" } },
        { toolName: "bash", input: { command: "rm x" } },
        { toolName: "bg_run", input: { command: "ls" } },
      ])
        assert.equal(((await t.fire("tool_call", event)) as { block: boolean }).block, true);
      assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "git status" } }), undefined);
      assert.match(await t.call("ask_planner", { question: "again" }), /A consultation is already open/u);
      assert.equal(
        await t.call("planner_answer", { answer: "Do X.", amended: true }),
        "Planner's answer (the plan file was amended; reread it):\n\nDo X.\n\nWorker: continue your work, following this answer.",
      );
      assert.equal(t.route().model.id, pair.worker);
      assert.equal(t.route().thinkingLevel, "medium", "the route uses requested worker effort after consultation");
      assert.equal(queryPlanPair(t.mock.eventBus)?.phase, workflow);
      assert.deepEqual(queryPlanPair(t.mock.eventBus)?.next, { provider: pair.provider, id: pair.worker });
      assert.equal(t.controller.state.workerHandoffs?.[key]?.planLevel, "high");
      assert.match(await t.call("planner_answer", { answer: "again" }), /only answers an open/u);
    });
  }

  test(`${key} closes aborted consultations at agent_settled without ending implementation`, async () => {
    for (const implementing of [true, false]) {
      const t = make();
      await t.fire("session_start");
      t.controller.approve(t.ctx as never, "/p/saved.md");
      if (!implementing) await t.fire("agent_settled", { aborted: false });
      await t.call("ask_planner", { question: "q" });
      assert.equal(t.controller.state.consult, true);
      assert.equal(t.route().model.id, pair.planner);
      const handoffs = structuredClone(t.controller.state.workerHandoffs);
      // Pi skips agent_before_settle when aborted: agent_settled must recover on its own.
      assert.equal(await t.fire("agent_settled", { aborted: true }), undefined);
      assert.equal(t.controller.state.consult, false);
      assert.equal(t.controller.state.implementing, implementing);
      assert.deepEqual(t.controller.state.workerHandoffs, handoffs);
      assert.equal(t.route().model.id, pair.worker);
      assert.equal(queryPlanPair(t.mock.eventBus)?.phase, implementing ? "build" : "work");
      assert.deepEqual(queryPlanPair(t.mock.eventBus)?.next, { provider: pair.provider, id: pair.worker });
      assert.equal(await t.fire("tool_call", { toolName: "write", input: { path: "/repo/src/a.ts" } }), undefined);
      assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "touch x" } }), undefined);
      assert.match(await t.call("planner_answer", { answer: "late answer" }), /only answers an open/u);
      assert.deepEqual(
        t.mock.entries.filter((entry) => entry.customType === PAIR_ENTRY).at(-1)?.data,
        t.controller.state,
      );
      const entries = t.mock.entries.length;
      await t.fire("agent_settled", { aborted: true });
      assert.equal(t.mock.entries.length, entries, "repeated abort recovery is a no-op");
      await t.call("ask_planner", { question: "try again" });
      assert.equal(t.controller.state.consult, true, "the worker may start a new consultation after abort");
    }
  });

  test(`${key} recovers missing answers and aborted idle consultations to the worker`, async () => {
    const t = make();
    t.controller.approve(t.ctx as never, "/p/saved.md");
    await t.fire("agent_settled", { aborted: false });
    for (const outcome of ["completed", "aborted", "error"]) {
      await t.call("ask_planner", { question: "q" });
      const existing = { type: "message", id: "existing" };
      const result = (await t.fire("agent_before_settle", { outcome, entries: [existing] })) as
        | {
            continue: boolean;
            entries: { customType?: string; content?: string }[];
          }
        | undefined;
      if (outcome === "completed") {
        assert.equal(result?.continue, true);
        assert.deepEqual(result?.entries[0], existing);
        assert.equal(result?.entries.at(-1)?.customType, "plan-mode-planner-answer");
        assert.match(
          result?.entries.at(-1)?.content ?? "",
          /Worker: its reply above is the answer; continue your work\./u,
        );
      } else assert.equal(result, undefined);
      assert.equal(t.controller.state.consult, false);
      assert.equal(t.route().model.id, pair.worker);
      assert.ok(t.controller.state.workerHandoffs?.[key]);
      assert.equal(await t.fire("agent_before_settle", { outcome: "completed", entries: [] }), undefined);
    }
  });
}

test("premium approvals and consultations remain isolated when switching pair identities or physical models", async () => {
  const [fable, astra, codex] = premiumPairs;
  assert.ok(fable && astra && codex);
  const t = setup({ model: premiumVirtual(fable), available: [...models, ...premiumModels] });
  await t.fire("session_start");
  (t.mock.rawPi as { setThinkingLevel(level: string): void }).setThinkingLevel("high");
  t.controller.approve(t.ctx as never, "/p/fable.md");
  await t.fire("agent_settled", { aborted: false });
  t.ctx.model = premiumVirtual(astra);
  await t.fire("model_select");
  assert.equal(t.route().model.id, astra.planner);
  assert.match(await t.call("ask_planner", { question: "q" }), /No approved plan/u);
  (t.mock.rawPi as { setThinkingLevel(level: string): void }).setThinkingLevel("low");
  t.controller.approve(t.ctx as never, "/p/astra.md");
  t.ctx.model = premiumVirtual(codex);
  assert.equal(t.route().model.id, codex.planner, "an active implementation does not transfer to another provider");
  assert.equal(queryPlanPair(t.mock.eventBus)?.phase, "work");
  t.ctx.model = premiumVirtual(fable);
  assert.equal(t.route().model.id, fable.worker);
  assert.match(await t.call("ask_planner", { question: "q" }), /The worker asks the planner/u);
  assert.equal(t.controller.state.implementing, false, "consult entry clears another pair's active implementation");
  assert.equal(t.controller.state.approvalPair, pairKey(fable));
  assert.equal(t.controller.state.planFile, "/p/fable.md");
  assert.equal(t.route().thinkingLevel, "high");
  assert.equal(
    ((await t.fire("tool_call", { toolName: "write", input: { path: "/p/astra.md" } })) as { block: boolean }).block,
    true,
  );
  assert.equal(await t.fire("tool_call", { toolName: "write", input: { path: "/p/fable.md" } }), undefined);
  t.ctx.model = premiumVirtual(astra);
  assert.equal(t.route().model.id, astra.worker, "a different pair does not inherit the open consultation");
  assert.equal(queryPlanPair(t.mock.eventBus)?.phase, "work");
  t.ctx.model = premiumVirtual(fable);
  await t.call("planner_answer", { answer: "a" });
  t.ctx.model = premiumVirtual(astra);
  await t.call("ask_planner", { question: "q" });
  assert.equal(t.controller.state.planFile, "/p/astra.md");
  assert.equal(t.route().thinkingLevel, "low");
  await t.call("planner_answer", { answer: "a" });
  const physical = { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" };
  t.ctx.model = physical;
  await t.fire("model_select");
  assert.equal(t.controller.selected(t.ctx as never), undefined);
  assert.equal(queryPlanPair(t.mock.eventBus), undefined);
  assert.ok(!t.mock.rawPi.getActiveTools().includes("ask_planner"));
  assert.match(await t.call("ask_planner", { question: "q" }), /works only with a plan model pair/u);
  assert.equal(t.ctx.model, physical);
  assert.equal(t.mock.setModels.length, 0);
  t.ctx.model = premiumVirtual(fable);
  await t.fire("model_select");
  assert.equal(t.route().model.id, fable.worker);
  assert.ok(t.mock.rawPi.getActiveTools().includes("ask_planner"));
  assert.deepEqual(t.controller.state.workerHandoffs, {
    [pairKey(fable)]: { planFile: "/p/fable.md", planLevel: "high" },
    [pairKey(astra)]: { planFile: "/p/astra.md", planLevel: "low" },
  });
});

test("model selection cancels a consultation only when leaving its pair and releases its guards", async () => {
  const [fable, astra] = premiumPairs;
  assert.ok(fable && astra);
  const physical = { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" };
  for (const target of [physical, premiumVirtual(astra), virtual]) {
    for (const implementing of [true, false]) {
      const t = setup({ model: premiumVirtual(fable), available: [...models, ...premiumModels] });
      await t.fire("session_start");
      t.controller.approve(t.ctx as never, "/p/fable.md");
      if (!implementing) await t.fire("agent_settled", { aborted: false });
      await t.call("ask_planner", { question: "q" });
      await t.fire("model_select");
      assert.equal(t.controller.state.consult, true, "reselecting the same pair keeps the consultation");
      const handoffs = structuredClone(t.controller.state.workerHandoffs);
      t.ctx.model = target;
      await t.fire("model_select");
      assert.equal(t.controller.state.consult, false, pairKey(target));
      assert.equal(t.controller.state.implementing, implementing, "selection does not end an active implementation");
      assert.equal(t.controller.state.approvalPair, pairKey(fable));
      assert.deepEqual(t.controller.state.workerHandoffs, handoffs);
      assert.equal(await t.fire("tool_call", { toolName: "write", input: { path: "/repo/src/a.ts" } }), undefined);
      assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "touch x" } }), undefined);
      assert.match(await t.call("planner_answer", { answer: "late answer" }), /only answers an open/u);
      assert.deepEqual(
        t.mock.entries.filter((entry) => entry.customType === PAIR_ENTRY).at(-1)?.data,
        t.controller.state,
      );
      if (target.api === "pi-virtual") {
        assert.equal(queryPlanPair(t.mock.eventBus)?.phase, "work", "the previous pair's build does not transfer");
        assert.equal(t.route().model.id, target.id === "astraplan" ? astra.planner : fable.worker);
        assert.ok(t.mock.rawPi.getActiveTools().includes("ask_planner"));
      } else {
        assert.equal(queryPlanPair(t.mock.eventBus), undefined);
        assert.ok(!t.mock.rawPi.getActiveTools().includes("ask_planner"));
      }
      t.ctx.model = premiumVirtual(fable);
      await t.fire("model_select");
      assert.equal(t.route().model.id, fable.worker, "returning restores the worker, not the cancelled consult");
      assert.equal(queryPlanPair(t.mock.eventBus)?.phase, implementing ? "build" : "work");
      await t.call("ask_planner", { question: "new question" });
      assert.equal(t.controller.state.consult, true);
    }
  }
});

test("restore rejects malformed snapshots and handoffs without inventing legacy identity", async () => {
  const pair = premiumPairs[0];
  assert.ok(pair);
  const key = pairKey(pair);
  const make = () => setup({ model: premiumVirtual(pair), available: premiumModels });
  const legacy = { version: 1, consult: false, implementing: true, planFile: "/p/legacy.md", planLevel: "high" };
  for (const selection of [undefined, { provider: "unknown", id: "pair" }, virtual]) {
    const t = make();
    if (selection) t.branch.push(modelEntry(selection));
    t.branch.push(pairEntry(legacy), pairEntry({ ...legacy, implementing: false }));
    await t.fire("session_start");
    assert.equal(t.controller.state.workerHandoffs, undefined);
    assert.equal(t.route().model.id, pair.planner);
  }
  for (const value of [
    null,
    [],
    "bad",
    {},
    { planFile: "" },
    { planFile: "  " },
    { planFile: 42 },
    { planFile: "/p/a.md", planLevel: "invalid" },
    { planFile: "/p/a.md", planLevel: null },
  ]) {
    const t = make();
    t.branch.push(modelEntry(pair), pairEntry(legacy));
    // Validate the map value independently of otherwise valid active metadata.
    t.branch.push(pairEntry({ version: 1, consult: false, workerHandoffs: { [key]: value } }));
    await t.fire("session_start");
    assert.equal(t.controller.state.workerHandoffs, undefined, JSON.stringify(value));
    assert.equal(t.route().model.id, pair.planner);
  }
  for (const malformed of [null, [], { version: 2, consult: false }, { version: 1, consult: "yes" }]) {
    const t = make();
    t.branch.push(pairEntry(malformed));
    await t.fire("session_start");
    assert.deepEqual(t.controller.state, { version: 1, consult: false });
  }
  for (const planFile of [undefined, 42, "", " "]) {
    const t = make();
    t.branch.push(modelEntry(pair), pairEntry({ ...legacy, planFile }), pairEntry({ version: 1, consult: false }));
    await t.fire("session_start");
    assert.equal(t.controller.state.workerHandoffs, undefined);
  }
  const t = make();
  t.branch.push(
    pairEntry({
      version: 1,
      consult: false,
      workerHandoffs: {
        [key]: { planFile: "/p/valid.md" },
        "anthropic/opusplan": { planFile: "/p/unchanged.md" },
        "x/unknown": { planFile: "/p/unknown.md" },
        "openai/astraplan": { planFile: "/p/bad.md", planLevel: "invalid" },
      },
    }),
  );
  await t.fire("session_start");
  assert.deepEqual(t.controller.state.workerHandoffs, { [key]: { planFile: "/p/valid.md" } });
  assert.equal(t.route().model.id, pair.worker);
});

test("consulting a restored handoff without saved effort cannot inherit another pair's effort", async () => {
  const [fable, astra] = premiumPairs;
  assert.ok(fable && astra);
  const t = setup({ model: premiumVirtual(fable), available: premiumModels });
  t.branch.push(
    pairEntry({
      version: 1,
      consult: false,
      approvalPair: pairKey(astra),
      planFile: "/p/astra.md",
      planLevel: "xhigh",
      workerHandoffs: {
        [pairKey(fable)]: { planFile: "/p/fable.md" },
        [pairKey(astra)]: { planFile: "/p/astra.md", planLevel: "xhigh" },
      },
    }),
  );
  await t.fire("session_start");
  await t.call("ask_planner", { question: "q" });
  assert.equal(t.controller.state.planFile, "/p/fable.md");
  assert.equal(t.controller.state.planLevel, undefined, "missing saved effort is not another pair's saved effort");
  assert.equal(t.route("continuation", "low").thinkingLevel, "low");
});

test("consult snapshots retain all handoffs through restore, answer and settlement", async () => {
  const [fable, astra] = premiumPairs;
  assert.ok(fable && astra);
  const t = setup({ model: premiumVirtual(fable), available: premiumModels });
  t.controller.approve(t.ctx as never, "/p/fable.md");
  await t.fire("agent_settled", { aborted: false });
  t.ctx.model = premiumVirtual(astra);
  t.controller.approve(t.ctx as never, "/p/astra.md");
  await t.fire("agent_settled", { aborted: false });
  await t.call("ask_planner", { question: "q" });
  const handoffs = structuredClone(t.controller.state.workerHandoffs);
  const restored = setup({ model: premiumVirtual(astra), available: premiumModels });
  restored.branch.push(pairEntry(structuredClone(t.controller.state)));
  await restored.fire("session_tree");
  assert.equal(restored.route().model.id, astra.planner);
  assert.equal(queryPlanPair(restored.mock.eventBus)?.phase, "consult");
  await restored.call("planner_answer", { answer: "a" });
  await restored.fire("agent_settled", { aborted: false });
  assert.equal(restored.route().model.id, astra.worker);
  assert.deepEqual(restored.controller.state.workerHandoffs, handoffs);
  restored.ctx.model = premiumVirtual(fable);
  assert.equal(restored.route().model.id, fable.worker);
  for (const entry of restored.mock.entries.filter((entry) => entry.customType === PAIR_ENTRY)) {
    assert.deepEqual((entry.data as { workerHandoffs?: unknown }).workerHandoffs, handoffs);
  }
});

test("legacy migration follows each recorded selection rather than the currently selected pair", async () => {
  const [fable, astra] = premiumPairs;
  assert.ok(fable && astra);
  const t = setup({ model: premiumVirtual(fable), available: premiumModels });
  t.branch.push(
    modelEntry(fable),
    pairEntry({ version: 1, consult: false, implementing: true, planFile: "/p/fable.md", planLevel: "high" }),
    modelEntry(astra),
    pairEntry({ version: 1, consult: false, implementing: true, planFile: "/p/astra.md", planLevel: "low" }),
    pairEntry({ version: 1, consult: false, implementing: false }),
  );
  await t.fire("session_start");
  assert.deepEqual(t.controller.state.workerHandoffs, {
    [pairKey(fable)]: { planFile: "/p/fable.md", planLevel: "high" },
    [pairKey(astra)]: { planFile: "/p/astra.md", planLevel: "low" },
  });
  assert.equal(t.route().model.id, fable.worker);
  t.ctx.model = premiumVirtual(astra);
  assert.equal(t.route().model.id, astra.worker);
});

test("unchanged built-ins and newly named custom pairs still return to their planner after settlement", async () => {
  const definitions = pairDefinitions({
    "custom/premium": {
      planner: { provider: "openai", modelId: "gpt-6-astra" },
      worker: { provider: "openai", modelId: "gpt-6-sol" },
    },
  });
  const available = [
    ...models,
    ...premiumModels,
    { provider: "openai", id: "gpt-6-terra", name: "Terra" },
    { provider: "openai-codex", id: "gpt-6-terra", name: "Terra" },
    { provider: "google", id: "gemini-4-carbon", name: "Carbon" },
    { provider: "google", id: "gemini-4-neon", name: "Neon" },
    { provider: "google", id: "gemini-4-argon", name: "Argon" },
    { provider: "google", id: "gemini-4-hydrogen", name: "Hydrogen" },
  ];
  for (const def of definitions.filter((def) => !def.handoff)) {
    const t = setup({ definitions, available, model: { provider: def.provider, id: def.id, api: "pi-virtual" } });
    const pair = t.controller.selected(t.ctx as never);
    assert.ok(pair, pairKey(def));
    t.controller.approve(t.ctx as never, "/p/plan.md");
    assert.equal(t.route().model.id, pair.worker.modelId, pairKey(def));
    assert.equal(t.controller.state.workerHandoffs, undefined);
    t.state.workflow = "chat";
    assert.equal(t.route().model.id, pair.planner.modelId);
    t.state.workflow = "work";
    await t.fire("agent_settled", { aborted: false });
    assert.equal(t.route().model.id, pair.planner.modelId);
  }
});

test("idle premium follow-up edits skip stale plan nudges, but active builds still receive them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "premium-pair-notes-"));
  try {
    const plan = join(dir, "plan.md");
    writeFileSync(plan, "## Changes\n\n- \x60src/a.ts\x60: change\n");
    for (const pair of premiumPairs) {
      const t = setup({ model: premiumVirtual(pair), available: premiumModels });
      t.controller.approve(t.ctx as never, plan);
      const event = {
        toolName: "write",
        isError: false,
        input: { path: "/repo/src/b.ts" },
        content: [{ type: "text", text: "ok" }],
      };
      const note = (await t.fire("tool_result", event)) as { content: { text: string }[] };
      assert.match(note.content.at(-1)?.text ?? "", /not one of the files the plan changes/u);
      await t.fire("agent_settled", { aborted: false });
      assert.equal(await t.fire("tool_result", { ...event, input: { path: "/repo/src/unrelated.ts" } }), undefined);
      t.controller.approve(t.ctx as never, plan);
      const next = (await t.fire("tool_result", event)) as { content: { text: string }[] };
      assert.match(next.content.at(-1)?.text ?? "", /call ask_planner/u, "reapproval resets note deduplication");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every built-in pair is registered as a virtual model", () => {
  const { registered } = setup();
  assert.deepEqual([...registered.keys()], builtinPairs().map(pairKey));
});

test("route sends planning to the planner, building to the worker, consulting to the planner", async () => {
  const t = setup({ planning: true });
  assert.equal(t.route().model.id, "claude-opus-4-5");
  assert.equal(t.route("direct").model.id, "claude-opus-4-5");
  t.state.planning = false;
  assert.equal(t.route().model.id, "claude-opus-4-5", "ordinary work stays on the planner");
  t.controller.approve(t.ctx as never, "/p/plan.md");
  assert.equal(t.controller.state.planLevel, "off");
  assert.equal(t.route().model.id, "claude-sonnet-4-5", "an approved plan is implemented on the worker");
  assert.equal(t.route("retry").model.id, "claude-sonnet-4-5");
  await t.call("ask_planner", { question: "why?" });
  const consulting = t.route("continuation", "low");
  assert.equal(consulting.model.id, "claude-opus-4-5");
  assert.equal(consulting.thinkingLevel, "off");
});

test("chat routes to the planner, and the worker serves only while implementing", () => {
  const t = setup({ workflow: "chat" });
  assert.equal(t.route().model.id, "claude-opus-4-5");
  t.controller.approve(t.ctx as never, "/p/plan.md");
  assert.equal(t.route().model.id, "claude-opus-4-5", "chat outranks implementing");
  t.state.workflow = "work";
  assert.equal(t.route().model.id, "claude-sonnet-4-5");
});

test("the implementation ends when the run settles, unless aborted", async () => {
  const t = setup();
  t.controller.approve(t.ctx as never, "/p/plan.md");
  assert.equal(t.controller.state.implementing, true);
  await t.fire("agent_settled", { aborted: true });
  assert.equal(t.route().model.id, "claude-sonnet-4-5", "an aborted run keeps the worker");
  await t.fire("agent_settled", { aborted: false });
  assert.equal(t.controller.state.implementing, false);
  assert.equal(t.route().model.id, "claude-opus-4-5", "back on the planner in work mode");
  assert.ok(
    t.mock.entries.some(
      (entry) => entry.customType === PAIR_ENTRY && (entry.data as { implementing?: boolean }).implementing === false,
    ),
  );
});

test("ask_planner refuses in chat mode", async () => {
  const t = setup({ workflow: "chat" });
  assert.match(await t.call("ask_planner", { question: "x" }), /You are in chat mode: the planner already answers/u);
  assert.equal(t.controller.state.consult, false);
});

test("the pair query publishes phase, next model and level", async () => {
  const t = setup();
  await t.fire("session_start");
  const query = () => queryPlanPair(t.mock.eventBus);
  const opus = { provider: "anthropic", id: "claude-opus-4-5" };
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
  const work = query();
  assert.deepEqual(work, {
    version: 1,
    pair: "anthropic/opusplan",
    phase: "work",
    next: opus,
    planner: opus,
    worker: sonnet,
    thinkingLevel: t.mock.thinkingLevel,
  });
  t.state.planning = true;
  assert.deepEqual([query()?.phase, query()?.next], ["plan", opus]);
  t.state.planning = false;
  t.state.workflow = "chat";
  assert.deepEqual([query()?.phase, query()?.next], ["chat", opus]);
  t.state.workflow = "work";
  t.controller.approve(t.ctx as never, "/p/plan.md");
  assert.deepEqual([query()?.phase, query()?.next], ["build", sonnet]);
  await t.call("ask_planner", { question: "why?" });
  const consult = query();
  assert.deepEqual([consult?.phase, consult?.next], ["consult", opus]);
  assert.equal(consult?.thinkingLevel, t.controller.state.planLevel);
  const none = setup({ model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" } });
  await none.fire("session_start");
  const request: { kind: "query"; snapshot?: unknown } = { kind: "query" };
  none.mock.eventBus.emit(PLAN_PAIR_CHANNEL, request);
  assert.equal(request.snapshot, undefined);
});

test("route throws when a pair cannot be resolved", () => {
  const t = setup({ available: [models[0] as never] });
  assert.throws(() => t.route(), /Opus plan, Sonnet build: no available Sonnet model on anthropic/u);
});

test("ask_planner and planner_answer refuse out of phase", async () => {
  const notPair = setup({ model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" } });
  assert.match(
    await notPair.call("ask_planner", { question: "x" }),
    /works only with a plan model pair selected, such as anthropic\/opusplan\./u,
  );
  const planning = setup({ planning: true });
  assert.match(
    await planning.call("ask_planner", { question: "x" }),
    /You are in plan mode: you are the planner\. Keep planning\./u,
  );
  const t = setup();
  assert.match(await t.call("planner_answer", { answer: "a" }), /only answers an open ask_planner question/u);
  assert.match(await t.call("ask_planner", { question: "x" }), /No approved plan is being implemented/u);
  t.controller.approve(t.ctx as never, "/p/plan.md");
  const text = await t.call("ask_planner", { question: "which file?" });
  assert.match(text, /The implementer asks the planner \(Opus 4\.5\):\n\nwhich file\?/u);
  assert.equal(t.controller.state.consult, true);
  assert.match(
    await t.call("ask_planner", { question: "again" }),
    /A consultation is already open: answer it with planner_answer\./u,
  );
  assert.ok(
    t.mock.entries.some((entry) => entry.customType === PAIR_ENTRY && (entry.data as { consult: boolean }).consult),
  );
});

test("planner_answer hands back, with and without an amended plan", async () => {
  const t = setup();
  t.controller.approve(t.ctx as never, "/p/plan.md");
  await t.call("ask_planner", { question: "q" });
  const plain = await t.call("planner_answer", { answer: "Do X." });
  assert.equal(plain, "Planner's answer:\n\nDo X.\n\nImplementer: continue implementing, following this answer.");
  assert.equal(t.controller.state.consult, false);
  await t.call("ask_planner", { question: "q" });
  assert.match(
    await t.call("planner_answer", { answer: "Do Y.", amended: true }),
    /^Planner's answer \(the plan file was amended; reread it\):/u,
  );
});

test("the consult guard allows the plan file and read-only commands only", async () => {
  const t = setup();
  t.controller.approve(t.ctx as never, "/p/plan.md");
  assert.equal(await t.fire("tool_call", { toolName: "write", input: { path: "/x.ts" } }), undefined);
  await t.call("ask_planner", { question: "q" });
  assert.match(
    ((await t.fire("tool_call", { toolName: "write", input: { path: "/x.ts" } })) as { reason: string }).reason,
    /nothing may change except the plan file/u,
  );
  assert.equal(await t.fire("tool_call", { toolName: "write", input: { path: "/p/plan.md" } }), undefined);
  assert.match(
    ((await t.fire("tool_call", { toolName: "bash", input: { command: "rm x" } })) as { reason: string }).reason,
    /only read-only commands run\. Blocked:/u,
  );
  assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "ls" } }), undefined);
  assert.match(
    ((await t.fire("tool_call", { toolName: "bg_run", input: { command: "ls" } })) as { reason: string }).reason,
    /The planner is answering a question/u,
  );
});

test("with pi-tool-gate answering, the consult guard follows its verdict instead of this package's policy", async () => {
  const verdicts: Record<string, boolean> = { "npm test": false, ls: true, "git status": false };
  bindGateShell({
    on: () => undefined,
    emit: (channel, data) => {
      const request = data as { command: string; reads?: boolean };
      if (channel === SHELL_READS_CHANNEL && request.command in verdicts) request.reads = verdicts[request.command];
    },
  });
  try {
    const t = setup();
    t.controller.approve(t.ctx as never, "/p/plan.md");
    await t.call("ask_planner", { question: "q" });
    // The gate says no to a command this package's own policy would allow, and names the whole command.
    assert.match(
      ((await t.fire("tool_call", { toolName: "bash", input: { command: "git status" } })) as { reason: string })
        .reason,
      /only read-only commands run\. Blocked: git status/u,
    );
    assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "ls" } }), undefined);
    // No answer for a command: this package's own policy decides.
    assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "pwd" } }), undefined);
    assert.equal(
      ((await t.fire("tool_call", { toolName: "bash", input: { command: "rm x" } })) as { block: boolean }).block,
      true,
    );
  } finally {
    bindGateShell(undefined);
  }
});

test("a consult that ends without planner_answer is recovered at settle", async () => {
  const completed = setup();
  completed.controller.approve(completed.ctx as never, "/p/plan.md");
  await completed.call("ask_planner", { question: "q" });
  const result = (await completed.fire("agent_before_settle", { outcome: "completed", entries: [] })) as {
    continue: boolean;
    entries: { customType: string }[];
  };
  assert.equal(result.continue, true);
  assert.equal(result.entries.at(-1)?.customType, "plan-mode-planner-answer");
  assert.equal(completed.controller.state.consult, false);
  const aborted = setup();
  aborted.controller.approve(aborted.ctx as never, "/p/plan.md");
  await aborted.call("ask_planner", { question: "q" });
  assert.equal(await aborted.fire("agent_before_settle", { outcome: "aborted" }), undefined);
  assert.equal(aborted.controller.state.consult, false);
});

test("plan-entry effort is judged once and a manual change wins", async () => {
  const t = setup({ planning: true });
  t.controller.phaseChanged(t.ctx as never);
  await t.fire("before_agent_start", { prompt: "do it" });
  assert.deepEqual(t.state.judged, ["do it"]);
  assert.equal(t.mock.thinkingLevel, "high");
  await t.fire("before_agent_start", { prompt: "again" });
  assert.equal(t.state.judged.length, 1);
  const manual = setup({ planning: true });
  manual.controller.phaseChanged(manual.ctx as never);
  await manual.fire("thinking_level_select");
  await manual.fire("before_agent_start", { prompt: "x" });
  assert.equal(manual.state.judged.length, 0);
  const notPair = setup({
    planning: true,
    model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" },
  });
  notPair.controller.phaseChanged(notPair.ctx as never);
  await notPair.fire("before_agent_start", { prompt: "x" });
  assert.equal(notPair.state.judged.length, 0);
});

test("approve records the planning level before effort changes", () => {
  const t = setup({});
  (t.mock.rawPi as { setThinkingLevel(level: string): void }).setThinkingLevel("xhigh");
  t.controller.approve(t.ctx as never, "/p/plan.md");
  assert.equal(t.controller.state.planLevel, "xhigh");
  assert.equal(t.controller.state.planFile, "/p/plan.md");
});

test("state restores from the branch and tools follow the selection", async () => {
  const t = setup();
  t.branch.push({
    type: "custom",
    customType: PAIR_ENTRY,
    data: { version: 1, consult: true, planFile: "/p/a.md", planLevel: "high" },
  });
  await t.fire("session_start");
  assert.deepEqual(t.controller.state, { version: 1, consult: true, planFile: "/p/a.md", planLevel: "high" });
  assert.ok(t.mock.rawPi.getActiveTools().includes("ask_planner"));
  const none = setup({ model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" } });
  await none.fire("session_start");
  assert.ok(!none.mock.rawPi.getActiveTools().includes("ask_planner"));
});

test("session_start unregisters unresolvable pairs but not the selected one", async () => {
  const t = setup({ available: models });
  await t.fire("session_start");
  assert.ok(t.unregistered.includes("anthropic/fableplan"));
  assert.ok(!t.unregistered.includes("anthropic/opusplan"));
  const selected = setup({ available: [], model: virtual });
  await selected.fire("session_start");
  assert.ok(!selected.unregistered.includes("anthropic/opusplan"));
});

test("an unplanned file gets one note per approval", async () => {
  const t = setup();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "pairs-"));
  const plan = join(dir, "plan.md");
  writeFileSync(plan, "## Changes\n\n- `src/a.ts`: change\n");
  t.controller.approve(t.ctx as never, plan);
  const event = {
    toolName: "write",
    isError: false,
    input: { path: "/repo/src/b.ts" },
    content: [{ type: "text", text: "ok" }],
  };
  const first = (await t.fire("tool_result", event)) as { content: { text: string }[] };
  assert.match(
    first.content.at(-1)?.text ?? "",
    /src\/b\.ts is not one of the files the plan changes\. If changing it departs from the plan, call ask_planner/u,
  );
  assert.equal(await t.fire("tool_result", event), undefined);
  assert.equal(await t.fire("tool_result", { ...event, input: { path: "/repo/src/a.ts" } }), undefined);
});

test("the plan factory registers the built-in pairs, then custom pairs from the settings", async () => {
  const { default: planMode } = await import("../src/index.js");
  const mock = createMockPi();
  const registered = new Map<string, { name: string; route(request: unknown, ctx: unknown): unknown }>();
  const raw = mock.rawPi as unknown as Record<string, unknown>;
  raw.registerVirtualModel = (model: {
    provider: string;
    id: string;
    name: string;
    route(request: unknown, ctx: unknown): unknown;
  }) => {
    registered.set(`${model.provider}/${model.id}`, model);
  };
  raw.unregisterVirtualModel = (provider: string, id: string) => registered.delete(`${provider}/${id}`);
  await planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit" as const,
      modelPairs: {
        "anthropic/opusplan": {
          planner: { provider: "anthropic", modelId: "claude-opus-4-5" },
          worker: { provider: "anthropic", modelId: "claude-haiku-4-5" },
          name: "Mine",
        },
        "openai/deep": {
          planner: { provider: "openai", modelId: "gpt-6-astra" },
          worker: { provider: "openai", modelId: "gpt-6-terra" },
        },
      },
    }),
  });
  const session = mock.events.get("session_start") as Handler[];
  const available = [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Opus 4.5" },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
  ];
  const ctx = {
    cwd: "/repo",
    hasUI: false,
    model: undefined,
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: PAIR_ENTRY, data: { version: 1, consult: false, implementing: true } },
      ],
      getSessionId: () => "s",
      getLeafId: () => null,
    },
  };
  assert.ok(registered.has("openai/deep"), "a custom pair is registered");
  assert.equal(registered.get("anthropic/opusplan")?.name, "Mine", "a built-in key is replaced by the custom pair");
  assert.ok(registered.has("anthropic/fableplan"), "the other built-ins stay");
  assert.ok(session.length > 0);
  for (const handler of session) await handler({ reason: "startup" }, ctx);
  const request = { model: { provider: "anthropic", id: "opusplan" }, thinkingLevel: "medium", reason: "user" };
  const routed = registered.get("anthropic/opusplan")?.route(request, ctx) as { model: { id: string } };
  assert.equal(routed.model.id, "claude-haiku-4-5", "the replacement's worker routes the build phase");
});

test("pairFor offers the pair whose planner is the session model, never for a virtual or worker model", async () => {
  const opus = setup({ model: { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" } });
  const offer = opus.controller.pairFor(opus.ctx as never);
  assert.equal(offer && pairKey(offer.def), "anthropic/opusplan");
  assert.deepEqual(offer?.worker, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
  assert.equal(offer?.workerName, "Sonnet 4.5");
  const pair = setup();
  assert.equal(pair.controller.pairFor(pair.ctx as never), undefined);
  const sonnet = setup({ model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" } });
  assert.equal(sonnet.controller.pairFor(sonnet.ctx as never), undefined);
  // A pair pruned at startup (unresolvable then) is not offered.
  const pruned = setup({ available: [], model: { provider: "anthropic", id: "claude-opus-4-5" } });
  await pruned.fire("session_start");
  assert.equal(pruned.controller.pairFor(pruned.ctx as never), undefined);
});

test("pairsFor offers every worker the planner pairs with, and a selected pair's siblings", () => {
  const available = [
    { provider: "anthropic", id: "claude-fable-5", name: "Fable 5" },
    { provider: "anthropic", id: "claude-opus-5", name: "Opus 5" },
    { provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5" },
  ];
  const fable = setup({ available, model: { provider: "anthropic", id: "claude-fable-5", api: "anthropic-messages" } });
  assert.deepEqual(
    fable.controller.pairsFor(fable.ctx as never).map((pair) => [pairKey(pair.def), pair.workerName]),
    [
      ["anthropic/fableplan", "Opus 5"],
      ["anthropic/fableplan-sonnet", "Sonnet 5"],
    ],
  );
  const paired = setup({ available, model: { provider: "anthropic", id: "fableplan", api: "pi-virtual" } });
  assert.deepEqual(
    paired.controller.pairsFor(paired.ctx as never).map((pair) => pairKey(pair.def)),
    ["anthropic/fableplan-sonnet"],
  );
  const opus = setup({ available, model: { provider: "anthropic", id: "opusplan", api: "pi-virtual" } });
  assert.deepEqual(opus.controller.pairsFor(opus.ctx as never), [], "Opus plans only one pair");
});

test("approving with the offered worker switches a plain Opus session to opusplan and keeps the planning level", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: planMode } = await import("../src/index.js");
  const plansDirectory = mkdtempSync(join(tmpdir(), "pair-offer-"));
  const mock = createMockPi({ thinkingLevel: "xhigh" });
  const raw = mock.rawPi as unknown as Record<string, unknown>;
  raw.registerVirtualModel = () => {};
  raw.unregisterVirtualModel = () => {};
  const opus = { provider: "anthropic", id: "claude-opus-4-5", name: "Opus 4.5", api: "anthropic-messages" };
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5", api: "anthropic-messages" };
  const opusplan = { provider: "anthropic", id: "opusplan", name: "Opus plan, Sonnet build", api: "pi-virtual" };
  const catalog = [opus, sonnet, opusplan];
  let current: unknown = opus;
  raw.setModel = async (model: unknown) => {
    mock.setModels.push(model);
    current = model;
    (raw.setThinkingLevel as (level: string) => void)("medium"); // a per-model default
    return true;
  };
  const offered: string[][] = [];
  const titles: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, choices: string[]) => {
      if (!title.startsWith("Implement this plan?")) return undefined;
      titles.push(title);
      offered.push(choices);
      return "Yes, implement with Sonnet 4.5";
    },
    modelRegistry: {
      getAvailable: () => [opus, sonnet],
      find: (provider: string, id: string) => catalog.find((model) => model.provider === provider && model.id === id),
    },
  });
  Object.defineProperty(context.ctx, "model", { get: () => current, configurable: true });
  await planMode(mock.pi, {
    readSettings: async () => ({ thinkingLevel: "inherit" as const, plansDirectory, jevToolSelection: false }),
    pickImplementationEffort: async () => ({ kind: "fallback", reason: "fixture" }),
  });
  try {
    for (const handler of (mock.events.get("session_start") ?? []) as Handler[])
      await handler({ reason: "startup" }, context.ctx);
    const tool = (name: string) =>
      mock.tools.find((candidate) => candidate.name === name) as unknown as {
        execute(...args: unknown[]): Promise<{ content: { text: string }[]; details?: { outcome?: string } }>;
      };
    await tool("enter_plan_mode").execute("enter", {}, undefined, undefined, context.ctx);
    const state = mock.entries.filter((entry) => entry.customType === INLINE_ENTRY).at(-1)?.data as {
      planFile?: string;
    };
    assert.ok(state?.planFile);
    writeFileSync(state.planFile, "# Offer plan\n\nDo it.\n");
    const result = await tool(EXIT_TOOL).execute("exit", {}, undefined, undefined, context.ctx);
    assert.ok(offered[0]?.includes("Yes, compact and implement with Sonnet 4.5"));
    assert.ok(titles[0]?.includes("With Sonnet 4.5, Opus 4.5 answers its questions, then takes over."));
    assert.equal(result.details?.outcome, "approved");
    assert.deepEqual(mock.setModels, [opusplan]);
    const pair = mock.entries.filter((entry) => entry.customType === PAIR_ENTRY).at(-1)?.data as {
      planLevel?: string;
    };
    assert.equal(pair?.planLevel, "xhigh", "the planner keeps the level it planned at");
    assert.match(result.content[0]?.text ?? "", /ask_planner/u);
  } finally {
    rmSync(plansDirectory, { recursive: true, force: true });
  }
});

test("approving on the planner keeps the pair on the planner and ends its persistent handoff", async () => {
  const [fable] = premiumPairs;
  assert.ok(fable);
  const t = setup({ model: premiumVirtual(fable), available: [...models, ...premiumModels] });
  await t.fire("session_start");
  t.controller.approve(t.ctx as never, "/p/fable.md");
  await t.fire("agent_settled", { aborted: false });
  assert.equal(t.route().model.id, fable.worker);
  t.controller.approve(t.ctx as never, "/p/fable-2.md", "planner");
  assert.equal(t.controller.state.implementing, undefined);
  assert.equal(t.controller.state.planFile, undefined);
  assert.equal(t.controller.state.workerHandoffs, undefined);
  assert.equal(t.route().model.id, fable.planner);
  assert.equal(queryPlanPair(t.mock.eventBus)?.phase, "work");
  assert.match(await t.call("ask_planner", { question: "q" }), /No approved plan/u);
  assert.equal(await t.fire("tool_result", { toolName: "edit", input: { path: "/repo/src/x.ts" } }), undefined);
});

test("pairNote states whether the worker stays on", () => {
  assert.equal(
    pairNote({ def: { handoff: "persistent" } as never, workerName: "Claude Opus 5.5", plannerName: "Claude Fable 5" }),
    "Fable 5 answers its questions; Opus 5.5 stays on",
  );
  assert.equal(
    pairNote({ def: {} as never, workerName: "Sonnet 4.5", plannerName: "Opus 4.5" }),
    "Opus 4.5 answers its questions, then takes over",
  );
});
