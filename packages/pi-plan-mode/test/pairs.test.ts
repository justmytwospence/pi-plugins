import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILTIN_PAIRS, pairKey } from "../src/model-pairs.js";
import { PAIR_ENTRY, registerPairs } from "../src/pairs.js";
import { createMockPi } from "./support.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const models = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Opus 4.5" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
];
const virtual = { provider: "anthropic", id: "opusplan", api: "pi-virtual" };

function setup(options: { planning?: boolean; available?: typeof models; model?: unknown } = {}) {
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
  const state = { planning: options.planning ?? false, judged: [] as string[], level: "high" as string | undefined };
  const controller = registerPairs(mock.pi, {
    planning: () => state.planning,
    safeSubcommands: () => undefined,
    judgePlanEffort: async (_ctx, prompt) => {
      state.judged.push(prompt);
      return state.level as never;
    },
  });
  controller.define([...BUILTIN_PAIRS]);
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
  const route = (reason = "user", thinkingLevel = "medium") =>
    registered.get("anthropic/opusplan")?.route({ model: virtual, thinkingLevel, reason }, ctx) as {
      model: { id: string };
      thinkingLevel: string;
    };
  const call = async (name: string, params: unknown) =>
    (await tool(name).execute("id", params, undefined, undefined, ctx)).content[0]?.text ?? "";
  return { mock, controller, state, ctx, fire, route, call, registered, unregistered, branch };
}

test("every built-in pair is registered as a virtual model", () => {
  const { registered } = setup();
  assert.deepEqual([...registered.keys()], BUILTIN_PAIRS.map(pairKey));
});

test("route sends planning to the planner, building to the worker, consulting to the planner", async () => {
  const t = setup({ planning: true });
  assert.equal(t.route().model.id, "claude-opus-4-5");
  assert.equal(t.route("direct").model.id, "claude-opus-4-5");
  t.state.planning = false;
  assert.equal(t.route().model.id, "claude-sonnet-4-5");
  assert.equal(t.route("retry").model.id, "claude-sonnet-4-5");
  t.controller.approve(t.ctx as never, "/p/plan.md");
  assert.equal(t.controller.state.planLevel, "off");
  await t.call("ask_planner", { question: "why?" });
  const consulting = t.route("continuation", "low");
  assert.equal(consulting.model.id, "claude-opus-4-5");
  assert.equal(consulting.thinkingLevel, "off");
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

test("a consult that ends without planner_answer is recovered at settle", async () => {
  const completed = setup();
  await completed.call("ask_planner", { question: "q" });
  const result = (await completed.fire("agent_before_settle", { outcome: "completed", entries: [] })) as {
    continue: boolean;
    entries: { customType: string }[];
  };
  assert.equal(result.continue, true);
  assert.equal(result.entries.at(-1)?.customType, "plan-mode-planner-answer");
  assert.equal(completed.controller.state.consult, false);
  const aborted = setup();
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
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
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
    sessionManager: { getBranch: () => [], getSessionId: () => "s", getLeafId: () => null },
  };
  assert.ok(registered.has("openai/deep"), "a custom pair is registered");
  assert.equal(registered.get("anthropic/opusplan")?.name, "Mine", "a built-in key is replaced by the custom pair");
  assert.ok(registered.has("anthropic/fableplan"), "the other built-ins stay");
  assert.ok(session.length > 0);
  const request = { model: { provider: "anthropic", id: "opusplan" }, thinkingLevel: "medium", reason: "user" };
  const routed = registered.get("anthropic/opusplan")?.route(request, ctx) as { model: { id: string } };
  assert.equal(routed.model.id, "claude-haiku-4-5", "the replacement's worker routes the build phase");
});
