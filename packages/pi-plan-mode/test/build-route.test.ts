import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ROUTE_ENTRY, registerBuildRoute, workerNote } from "../src/build-route.js";
import { bindGateShell } from "../src/gate-shell.js";
import { PLAN_PAIR_CHANNEL, queryPlanPair } from "../src/plan-pair-contract.js";
import { SHELL_READS_CHANNEL } from "../src/shell-reads.js";
import { createMockPi } from "./support.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const fable1 = { provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1" };
const fable2 = { provider: "anthropic", id: "claude-fable-5-2", name: "Claude Fable 5.2" };
type M = typeof opus;

function setup(options: { models?: M[]; failSwitch?: (model: M) => boolean; planning?: boolean } = {}) {
  const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "xhigh" });
  const raw = mock.rawPi as unknown as Record<string, unknown>;
  const models = options.models ?? [opus, sonnet];
  const state = { planning: options.planning ?? false, judged: 0 };
  let current: M = opus;
  const notices: { message: string; level?: string }[] = [];
  const branch: unknown[] = [];
  const ctx = {
    cwd: "/repo",
    get model() {
      return current;
    },
    hasUI: true,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    },
    sessionManager: { getBranch: () => branch },
    ui: {
      notify(message: string, level?: string) {
        notices.push({ message, level });
      },
    },
  };
  const fire = async (name: string, event: unknown = {}) => {
    let last: unknown;
    for (const handler of (mock.events.get(name) ?? []) as Handler[]) last = (await handler(event, ctx)) ?? last;
    return last;
  };
  raw.setModel = async (model: M) => {
    if (options.failSwitch?.(model)) return false;
    const previous = current;
    current = model;
    mock.setModels.push(model);
    await fire("model_select", { model, previousModel: previous, source: "set" });
    return true;
  };
  const controller = registerBuildRoute(mock.pi, {
    planning: () => state.planning,
    safeSubcommands: () => undefined,
    judgePlanEffort: async () => {
      state.judged++;
      return "low";
    },
  });
  const tool = (name: string) =>
    mock.tools.find((candidate) => candidate.name === name) as unknown as {
      execute(
        id: string,
        params: unknown,
        signal: undefined,
        update: undefined,
        ctx: unknown,
      ): Promise<{
        content: { text: string }[];
      }>;
    };
  const call = async (name: string, params: unknown) =>
    (await tool(name).execute("id", params, undefined, undefined, ctx)).content[0]?.text ?? "";
  const entries = () => mock.entries.filter((entry) => entry.customType === ROUTE_ENTRY);
  return {
    mock,
    controller,
    ctx,
    state,
    notices,
    branch,
    fire,
    call,
    entries,
    active: () => mock.rawPi.getActiveTools(),
    select: (model: M) => {
      current = model;
    },
  };
}

test("begin switches to the worker, records the way home and activates the consultation tools", async () => {
  const t = setup();
  assert.ok(!t.active().includes("ask_planner"));
  assert.equal(
    await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md"),
    true,
  );
  assert.deepEqual(t.mock.setModels, [sonnet]);
  assert.deepEqual(t.controller.state.build?.home, { provider: "anthropic", modelId: opus.id, thinkingLevel: "xhigh" });
  assert.deepEqual(t.entries().at(-1)?.data, t.controller.state);
  assert.ok(t.active().includes("ask_planner") && t.active().includes("planner_answer"));
  assert.equal(t.controller.homeName(t.ctx as never), "Opus 5.5");
  assert.deepEqual(queryPlanPair(t.mock.rawPi.events as never), {
    version: 2,
    phase: "build",
    home: { provider: "anthropic", id: opus.id },
    worker: { provider: "anthropic", id: sonnet.id },
    next: { provider: "anthropic", id: sonnet.id },
  });
});

test("a finished build returns to your model and level without a notice", async () => {
  const t = setup();
  await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
  await t.fire("agent_before_settle", { outcome: "completed" });
  assert.equal(t.ctx.model.id, sonnet.id, "the run is not over until it settles");
  await t.fire("agent_settled", { aborted: false });
  assert.equal(t.ctx.model.id, opus.id);
  assert.equal(t.mock.thinkingLevel, "xhigh");
  assert.deepEqual(t.notices, []);
  assert.ok(!t.active().includes("ask_planner"));
  assert.equal(t.controller.state.build, undefined);
  assert.equal(queryPlanPair(t.mock.rawPi.events as never), undefined);
});

test("an aborted or failed build returns to your model with a warning", async () => {
  for (const [event, outcome] of [
    [{ aborted: true }, undefined],
    [{ aborted: false }, "error"],
  ] as const) {
    const t = setup();
    await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
    if (outcome) await t.fire("agent_before_settle", { outcome });
    await t.fire("agent_settled", event);
    assert.equal(t.ctx.model.id, opus.id);
    assert.deepEqual(t.notices, [{ message: "Build on Sonnet 5.5 stopped; back on Opus 5.5.", level: "warning" }]);
  }
});

test("ask_planner switches to your model at its level and planner_answer back to the worker at its level", async () => {
  const t = setup();
  await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
  t.mock.rawPi.setThinkingLevel("medium"); // the worker's level
  const asked = await t.call("ask_planner", { question: "Is src/b.ts needed?" });
  assert.match(asked, /^The implementer asks the planner \(Opus 5\.5\):\n\nIs src\/b\.ts needed\?/u);
  assert.equal(t.ctx.model.id, opus.id);
  assert.equal(t.mock.thinkingLevel, "xhigh");
  assert.equal(queryPlanPair(t.mock.rawPi.events as never)?.phase, "consult");
  assert.equal(queryPlanPair(t.mock.rawPi.events as never)?.next.id, opus.id);
  assert.match(await t.call("ask_planner", { question: "again" }), /already open/u);
  const answered = await t.call("planner_answer", { answer: "No.", amended: true });
  assert.match(answered, /^Planner's answer \(the plan file was amended; reread it\):\n\nNo\./u);
  assert.equal(t.ctx.model.id, sonnet.id);
  assert.equal(t.mock.thinkingLevel, "medium");
  assert.equal(t.controller.state.consult, false);
  assert.equal(t.notices.length, 0, "your own switches are not announced");
  await t.fire("agent_settled", { aborted: false });
  assert.equal(t.ctx.model.id, opus.id);
});

test("ask_planner and planner_answer refuse out of phase", async () => {
  const t = setup();
  assert.match(await t.call("ask_planner", { question: "x" }), /only while another model implements/u);
  assert.match(await t.call("planner_answer", { answer: "x" }), /only answers an open/u);
  await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
  t.state.planning = true;
  assert.match(await t.call("ask_planner", { question: "x" }), /plan mode: you are the planner/u);
});

test("a consultation that ends without planner_answer continues the worker", async () => {
  const t = setup();
  await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
  await t.call("ask_planner", { question: "x" });
  const result = (await t.fire("agent_before_settle", { outcome: "completed", entries: [] })) as {
    continue: boolean;
    entries: { customType: string }[];
  };
  assert.equal(result.continue, true);
  assert.equal(result.entries.at(-1)?.customType, "plan-mode-planner-answer");
  assert.equal(t.ctx.model.id, sonnet.id);
  assert.equal(t.controller.state.consult, false);
  assert.ok(t.controller.state.build, "the build goes on");
});

test("a consultation that is aborted returns to your model like any stopped build", async () => {
  const t = setup();
  await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
  await t.call("ask_planner", { question: "x" });
  await t.fire("agent_settled", { aborted: true });
  assert.equal(t.ctx.model.id, opus.id);
  assert.equal(t.controller.state.build, undefined);
});

test("choosing a model yourself ends the build and is never switched back", async () => {
  const t = setup({ models: [opus, sonnet, fable1] });
  await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
  t.select(fable1);
  await t.fire("model_select", { model: fable1, previousModel: sonnet, source: "set" });
  assert.equal(t.controller.state.build, undefined);
  assert.match(t.notices.at(-1)?.message ?? "", /Fable 5\.1 selected/u);
  const before = t.mock.setModels.length;
  await t.fire("agent_settled", { aborted: false });
  assert.equal(t.mock.setModels.length, before);
  assert.ok(!t.active().includes("ask_planner"));
});

test("entering plan mode during a build returns to your model", async () => {
  const t = setup();
  await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/plan.md");
  t.state.planning = true;
  t.controller.phaseChanged(t.ctx as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(t.ctx.model.id, opus.id);
  assert.deepEqual(t.notices, [{ message: "Back on Opus 5.5 to plan.", level: "info" }]);
});

test("a build left in the session is ended at start, and older entries are ignored", async () => {
  const t = setup();
  t.branch.push({
    type: "custom",
    customType: ROUTE_ENTRY,
    data: {
      version: 2,
      consult: false,
      build: {
        home: { provider: "anthropic", modelId: opus.id, thinkingLevel: "high" },
        worker: { provider: "anthropic", modelId: sonnet.id },
        planFile: "/p/plan.md",
      },
    },
  });
  t.select(sonnet);
  await t.fire("session_start", { reason: "resume" });
  assert.equal(t.ctx.model.id, opus.id);
  assert.deepEqual(t.notices, [
    { message: "The last build on Sonnet 5.5 did not finish; back on Opus 5.5.", level: "warning" },
  ]);
  assert.equal(t.controller.state.build, undefined);

  const old = setup();
  old.branch.push({
    type: "custom",
    customType: ROUTE_ENTRY,
    data: { version: 1, consult: false, implementing: true, planFile: "/p/plan.md" },
  });
  old.select(sonnet);
  await old.fire("session_start", { reason: "resume" });
  assert.equal(old.ctx.model.id, sonnet.id);
  assert.deepEqual(old.notices, []);
});

test("a session left on a removed plan model moves to its planner family's newest model, once", async () => {
  const t = setup({ models: [opus, sonnet, fable1, fable2] });
  t.branch.push({ type: "model_change", provider: "anthropic", modelId: "fableplan" });
  await t.fire("session_start", { reason: "resume" });
  assert.deepEqual(t.mock.setModels, [fable2]);
  assert.equal(t.notices.length, 1);
  assert.match(t.notices[0]?.message ?? "", /Plan model pairs were removed: anthropic\/fableplan is now Fable 5\.2/u);
  for (const id of [opus.id, "something"]) {
    const other = setup({ models: [opus, sonnet, fable1, fable2] });
    other.branch.push({ type: "model_change", provider: "anthropic", modelId: id });
    await other.fire("session_start", { reason: "resume" });
    assert.deepEqual(other.mock.setModels, []);
  }
});

test("a failed switch to the worker leaves nothing behind; a failed return says so", async () => {
  const t = setup({ failSwitch: (model) => model.id === sonnet.id });
  assert.equal(
    await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/p.md"),
    false,
  );
  assert.equal(t.controller.state.build, undefined);
  assert.equal(t.ctx.model.id, opus.id);

  const back = setup({ failSwitch: (model) => model.id === opus.id });
  await back.controller.begin(back.ctx as never, { provider: "anthropic", modelId: sonnet.id }, "/p/p.md");
  await back.fire("agent_settled", { aborted: false });
  assert.equal(back.ctx.model.id, sonnet.id);
  assert.deepEqual(back.notices, [
    { message: "Could not switch back to Opus 5.5. Choose a model with /model.", level: "error" },
  ]);
});

test("workers offers the implementers of the session model, none for Sonnet or a virtual model", () => {
  const t = setup({
    models: [{ ...opus }, sonnet, { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" }],
  });
  assert.deepEqual(
    t.controller.workers(t.ctx as never).map((worker) => [worker.spec.modelId, worker.spec.thinkingLevel, worker.name]),
    [
      [sonnet.id, "xhigh", "Claude Sonnet 5.5"],
      ["claude-haiku-5-5", "xhigh", "Claude Haiku 5.5"],
    ],
  );
  t.select(sonnet);
  assert.deepEqual(t.controller.workers(t.ctx as never), []);
  t.select({ ...opus, api: "pi-virtual" } as never);
  assert.deepEqual(t.controller.workers(t.ctx as never), []);
});

test("the note says who answers and where the session goes after the build", () => {
  assert.equal(workerNote("Claude Opus 5.5"), "Opus 5.5 answers its questions; back to Opus 5.5 when the build ends");
});

test("the consult guard allows the plan file and read-only commands only", async () => {
  const t = setup();
  const dir = mkdtempSync(join(tmpdir(), "route-guard-"));
  try {
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n");
    await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, planFile);
    assert.equal(
      await t.fire("tool_call", { toolName: "edit", input: { path: "/repo/a.ts" } }),
      undefined,
      "no consult",
    );
    await t.call("ask_planner", { question: "x" });
    assert.equal(await t.fire("tool_call", { toolName: "edit", input: { path: planFile } }), undefined);
    assert.match(
      ((await t.fire("tool_call", { toolName: "edit", input: { path: "/repo/a.ts" } })) as { reason: string }).reason,
      /nothing may change except the plan file/u,
    );
    assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "ls -la" } }), undefined);
    assert.equal(
      ((await t.fire("tool_call", { toolName: "bash", input: { command: "rm -rf build" } })) as { block: boolean })
        .block,
      true,
    );
    assert.equal(((await t.fire("tool_call", { toolName: "bg_run", input: {} })) as { block: boolean }).block, true);
    // pi-tool-gate's verdict wins when it is loaded.
    bindGateShell(t.mock.rawPi.events as never);
    t.mock.eventBus.on(SHELL_READS_CHANNEL, (request) => {
      (request as { reads?: boolean }).reads = true;
    });
    assert.equal(await t.fire("tool_call", { toolName: "bash", input: { command: "rm -rf build" } }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unplanned file gets one note per build, and none while the planner answers", async () => {
  const t = setup();
  const dir = mkdtempSync(join(tmpdir(), "route-notes-"));
  try {
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n\n## Changes\n\n- `src/a.ts`: change it.\n");
    await t.controller.begin(t.ctx as never, { provider: "anthropic", modelId: sonnet.id }, planFile);
    const result = (path: string) =>
      t.fire("tool_result", { toolName: "edit", isError: false, input: { path }, content: [] });
    assert.equal(await result("/repo/src/a.ts"), undefined);
    const noted = (await result("/repo/src/b.ts")) as { content: { text: string }[] };
    assert.match(noted.content.at(-1)?.text ?? "", /src\/b\.ts is not one of the files the plan changes/u);
    assert.equal(await result("/repo/src/b.ts"), undefined);
    await t.fire("agent_settled", { aborted: false });
    assert.equal(await result("/repo/src/c.ts"), undefined, "no build, no notes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan-entry effort is judged for a model with workers, not for Sonnet", async () => {
  for (const [model, judged] of [
    [opus, 1],
    [sonnet, 0],
  ] as const) {
    const t = setup({ planning: false });
    t.select(model);
    t.state.planning = true;
    t.controller.phaseChanged(t.ctx as never);
    await t.fire("before_agent_start", { prompt: "plan it" });
    assert.equal(t.state.judged, judged, model.id);
    if (judged) assert.equal(t.mock.thinkingLevel, "low");
  }
});

test("the footer channel is only answered during a build", () => {
  const t = setup();
  assert.equal(PLAN_PAIR_CHANNEL, "pi-plugins.plan-pair.v2");
  assert.equal(queryPlanPair(t.mock.rawPi.events as never), undefined);
});
