import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionAPI,
  type ExtensionContext,
  initTheme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import planMode from "../src/index.js";
import {
  ENTER_TOOL,
  EXIT_TOOL,
  INLINE_ENTRY,
  MODE_CHANGED,
  MODE_SET,
  NOTICE_TYPE,
  PLAN_PROVIDER,
} from "../src/inline-plan.js";
import { createMockContext, createMockPi } from "./shared/support.js";

const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };

type Tool = {
  exposure?: string;
  name: string;
  execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details?: any; terminate?: boolean }>;
};

async function setup(
  options: {
    select?: string[];
    input?: string;
    gate?: boolean;
    cycle?: string[];
    plansDirectory?: string;
    cwd?: string;
    /** Give the session a model (opus) with a sonnet handoff target. */
    models?: boolean;
    prePlanMode?: string;
    switchFails?: boolean;
    implementationModelMap?: Record<string, Array<{ provider: string; modelId: string }>>;
  } = {},
) {
  const mock = createMockPi();
  if (options.switchFails) (mock.pi as ExtensionAPI).setModel = async () => false;
  const plansDirectory = options.plansDirectory ?? mkdtempSync(join(tmpdir(), "plans-"));
  await planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit" as const,
      jevToolSelection: false,
      plansDirectory,
      ...(options.implementationModelMap ? { implementationModelMap: options.implementationModelMap } : {}),
      ...(options.models
        ? {
            implementationModelMap: {
              "anthropic/claude-opus-5-5": [
                {
                  provider: "anthropic",
                  modelId: "claude-sonnet-5-5",
                  thinkingLevel: "high",
                },
              ],
            },
          }
        : {}),
    }),
  });
  const answers = [...(options.select ?? [])];
  const selects: Array<{ title: string; options: string[] }> = [];
  const context = createMockContext({
    // Keep the RPC fallback covered here; the viewport suite drives the real TUI picker.
    mode: "rpc",
    hasUI: true,
    cwd: options.cwd ?? "/work/app",
    select: async (title: string, choices: string[]) => {
      selects.push({ title, options: choices });
      return title === "Implementation effort" && answers.length === 0 ? "high" : answers.shift();
    },
    input: async () => options.input,
    ...(options.models
      ? {
          model: opus,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
            getAvailable: () => [opus, sonnet],
            getAll: () => [opus, sonnet],
            find: (provider: string, id: string) => [opus, sonnet].find((m) => m.provider === provider && m.id === id),
            isUsingOAuth: () => false,
          },
        }
      : {}),
    sessionManager: {
      getSessionId: () => "s",
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      getEntries: () => [],
      getSessionFile: () => "/main.jsonl",
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "plan it", timestamp: 1 }] }),
    },
  });
  const session = (context.ctx as ExtensionContext).sessionManager as unknown as Record<string, unknown>;
  const getLeafId = vi.fn(() => "planning-leaf");
  const newSession = vi.fn(async () => ({ cancelled: false }));
  session.getLeafId = getLeafId;
  (context.ctx as unknown as Record<string, unknown>).newSession = newSession;
  const projection = vi.spyOn((context.ctx as ExtensionContext).sessionManager, "buildSessionProjection");
  const gateEvents: Array<{ channel: string; data: any }> = [];
  if (options.gate) {
    // A stand-in for pi-tool-gate: it takes mode requests and announces every change.
    let mode = "auto";
    const announce = () =>
      mock.eventBus.emit(MODE_CHANGED, {
        mode,
        cycle: options.cycle ?? ["default", "acceptEdits", "plan", "auto"],
        ...(options.prePlanMode && mode === "plan" ? { prePlanMode: options.prePlanMode } : {}),
      });
    mock.eventBus.on(MODE_SET, (data) => {
      gateEvents.push({ channel: MODE_SET, data });
      mode = (data as { mode: string }).mode;
      announce();
    });
    mock.eventBus.on(PLAN_PROVIDER, (data) => gateEvents.push({ channel: PLAN_PROVIDER, data }));
    announce();
  }
  for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "startup" }, context.ctx);
  const tool = (name: string) => mock.tools.find((candidate) => candidate.name === name) as unknown as Tool;
  const emit = async (name: string, payload: Record<string, unknown>) => {
    let result: unknown;
    for (const handler of mock.events.get(name) ?? [])
      result = (await handler({ type: name, ...payload }, context.ctx)) ?? result;
    return result as any;
  };
  const inline = () => mock.entries.filter((entry) => entry.customType === INLINE_ENTRY).at(-1)?.data as any;
  return { mock, context, selects, tool, emit, inline, gateEvents, plansDirectory, getLeafId, newSession, projection };
}

test("/plan enters plan mode: only the plan file may be written, and only read-only commands run", async () => {
  const { mock, context, emit, inline } = await setup();
  await mock.commands.get("plan")?.handler("", context.ctx);
  const planFile = inline().planFile as string;
  assert.equal(inline().active, true);
  assert.match(planFile, /\/[a-z]+-[a-z]+\.md$/u);
  assert.equal(context.statuses.get("permission-mode"), "⏸ plan mode on");
  assert.deepEqual(
    await emit("tool_call", { toolName: "write", input: { path: planFile, content: "# Plan" } }),
    undefined,
  );
  assert.match(
    (await emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } })).reason,
    /only file you may write is the plan file/u,
  );
  assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "git status && rg foo" } }), undefined);
  assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "npm install left-pad" } })).block, true);

  // Your agent is told once, with your next prompt.
  const first = await emit("before_agent_start", { prompt: "x" });
  assert.equal(first.message.customType, NOTICE_TYPE);
  assert.equal(first.message.display, false);
  assert.match(first.message.content, /Plan mode is active/u);
  assert.match(first.message.content, new RegExp(planFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.equal(await emit("before_agent_start", { prompt: "y" }), undefined);
});

test("/plan with a task enters plan mode and sends the task", async () => {
  const { mock, context, inline } = await setup();
  await mock.commands.get("plan")?.handler("add rate limiting", context.ctx);
  assert.equal(inline().active, true);
  assert.equal(mock.sentUserMessages.at(-1)?.text, "add rate limiting");
});

test("exit_plan_mode needs a written plan, shows it, and implements it here once approved", async () => {
  const { mock, context, tool, emit, inline, selects } = await setup({ select: ["Yes, implement here"] });
  const outside = await tool(EXIT_TOOL).execute("t0", {}, undefined, undefined, context.ctx);
  assert.match(outside.content[0]?.text ?? "", /not in plan mode/u);
  await mock.commands.get("plan")?.handler("", context.ctx);
  const planFile = inline().planFile as string;
  const empty = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(empty.content[0]?.text ?? "", /empty or missing/u);
  writeFileSync(planFile, "# Plan\n\n1. Do it\n");
  const updates: any[] = [];
  const result = await tool(EXIT_TOOL).execute(
    "t2",
    {},
    undefined,
    (update: unknown) => updates.push(update),
    context.ctx,
  );
  assert.equal(updates[0]?.details.outcome, "pending", "the plan shows while you decide");
  const exit = mock.tools.find((candidate) => candidate.name === EXIT_TOOL);
  assert.equal(exit?.ccstyleOwnResult, true, "cc-render must preserve the plan's own result renderer");
  initTheme("dark", false);
  const theme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as ExtensionContext["ui"]["theme"];
  const pending = (exit as unknown as ToolDefinition).renderResult?.(
    updates[0],
    { expanded: false, isPartial: true },
    theme,
    {
      toolCallId: "t2",
      args: {},
      state: {},
      invalidate() {},
      lastComponent: undefined,
      cwd: (context.ctx as ExtensionContext).cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 0,
    },
  );
  assert.ok(pending, "the pending review has a result component");
  const rendered = pending.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(rendered, /Plan/u);
  assert.match(rendered, /1\. Do it/u);
  assert.match(rendered, /Waiting for approval/u);
  assert.deepEqual(selects[0]?.options, [
    "Yes, implement here",
    "Yes, compact plan and implement here",
    "Edit the plan",
    "No, keep planning",
  ]);
  assert.match(
    result.content[0]?.text ?? "",
    /^The user approved the plan\.[\s\S]*reply normally[\s\S]*## Approved plan\n\n# Plan\n\n1\. Do it$/u,
  );
  assert.equal(inline().active, false);
  const exec = mock.entries.filter((entry) => entry.customType === "plan-mode:exec").at(-1)?.data as any;
  assert.equal(exec, undefined, "ordinary implementation never starts exec mode");
  assert.notEqual(result.terminate, true, "the current agent implements without ending its turn");
  assert.doesNotMatch(result.content[0]?.text ?? "", /finish_plan|ask_planner|exec mode|handoff/iu);
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(mock.setModels.length, 0);
  assert.equal(context.statuses.get("permission-mode"), undefined);
  // The result told your agent: no separate notice.
  assert.equal(await emit("before_agent_start", { prompt: "go" }), undefined);
  assert.equal(await emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } }), undefined);
});

for (const compact of [false, true]) {
  test(`ordinary ${compact ? "compact" : "direct"} approval keeps the session and has no handoff machinery`, async () => {
    const h = await setup({
      models: true,
      select: [compact ? "Yes, compact plan and implement here" : "Yes, implement here", "high"],
    });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    const plan = "# Exact approved plan\n\n1. Preserve `literal` details.\n2. Verify once.";
    writeFileSync(h.inline().planFile, `${plan}\n`);
    const result = await h.tool(EXIT_TOOL).execute("direct", {}, undefined, undefined, h.context.ctx);
    assert.equal(result.details.outcome, "approved");
    assert.equal(result.terminate === true, compact);
    assert.equal(h.inline().active, false);
    const settled = await h.emit("agent_before_settle", { outcome: "completed" });
    const brief = compact ? settled.entries[1].content : result.content[0]?.text;
    assert.ok(brief.endsWith(`## Approved plan\n\n${plan}`));
    assert.doesNotMatch(brief, /ask_planner|finish_plan|exec mode|handoff/iu);
    if (compact) {
      assert.equal(settled.continue, true);
      assert.equal(settled.entries.length, 2);
      assert.equal(settled.entries[0].type, "compaction");
      assert.equal(settled.entries[0].firstKeptEntryId, null);
      assert.equal(settled.entries[1].customType, "plan-mode-implementation");
      assert.equal(settled.entries[1].details.planFile, h.inline().planFile);
    } else assert.equal(settled, undefined);
    assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
    assert.equal((h.context.ctx as ExtensionContext).sessionManager.getSessionId(), "s");
    assert.equal((h.context.ctx as ExtensionContext).model, opus);
    assert.equal(h.mock.thinkingLevels.at(-1), "high");
    assert.equal(h.mock.setModels.length, 0);
    assert.equal(
      h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
      false,
    );
    assert.equal(
      (h.mock.pi as ExtensionAPI).getActiveTools().some((name) => ["finish_plan", "ask_planner"].includes(name)),
      false,
    );
    assert.equal(h.getLeafId.mock.calls.length, 0);
    assert.equal(h.newSession.mock.calls.length, 0);
    assert.equal(h.projection.mock.calls.length, 0, "no consultant session seeded");
  });
}

for (const outcome of ["aborted", "error"]) {
  test(`compact approval does not implement after an ${outcome} turn`, async () => {
    const h = await setup({ select: ["Yes, compact plan and implement here"] });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    writeFileSync(h.inline().planFile, "# Plan\n");
    await h.tool(EXIT_TOOL).execute("compact", {}, undefined, undefined, h.context.ctx);
    assert.equal(await h.emit("agent_before_settle", { outcome }), undefined);
    assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
    assert.equal(h.mock.setModels.length, 0);
    assert.equal(
      h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
      false,
    );
    assert.equal(h.projection.mock.calls.length, 0);
  });
}

test("failed model switch never starts handoff implementation", async () => {
  const h = await setup({
    models: true,
    switchFails: true,
    select: ["Yes, hand off to Claude Sonnet 5.5 (high)", "high"],
  });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  await h.tool(EXIT_TOOL).execute("failed", {}, undefined, undefined, h.context.ctx);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
  assert.equal(h.projection.mock.calls.length, 0);
  assert.equal(h.getLeafId.mock.calls.length, 1);
  assert.equal(h.newSession.mock.calls.length, 0);
  assert.ok(h.context.notifications.some(({ level }) => level === "warning"));
});

test("aborting during a model switch never starts handoff implementation", async () => {
  const h = await setup({ models: true, select: ["Yes, hand off to Claude Sonnet 5.5 (high)", "high"] });
  const abort = new AbortController();
  (h.context.ctx as ExtensionContext).signal = abort.signal;
  (h.mock.pi as ExtensionAPI).setModel = async () => {
    abort.abort();
    return true;
  };
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  await h.tool(EXIT_TOOL).execute("abort-switch", {}, undefined, undefined, h.context.ctx);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
  assert.equal(h.projection.mock.calls.length, 0);
  assert.equal(h.getLeafId.mock.calls.length, 1);
});

test("cancelling RPC effort returns to actions; action cancel does not approve or implement", async () => {
  const h = await setup({
    models: true,
    select: ["Yes, compact plan and implement here", undefined as never, undefined as never],
  });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  const result = await h.tool(EXIT_TOOL).execute("cancel-effort", {}, undefined, undefined, h.context.ctx);
  assert.equal(h.selects.length, 3);
  assert.equal(h.selects[2]?.title, "Implement this plan?");
  assert.equal(h.selects[2]?.options[0], "Yes, compact plan and implement here");
  assert.equal(result.details.outcome, "kept");
  assert.equal(h.inline().active, true);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(h.mock.setModels.length, 0);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
});

test("RPC effort back navigation can change action before approving", async () => {
  const h = await setup({
    models: true,
    select: ["Yes, compact plan and implement here", undefined as never, "Yes, implement here", "high"],
  });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  const result = await h.tool(EXIT_TOOL).execute("back", {}, undefined, undefined, h.context.ctx);
  assert.equal(h.selects.length, 4);
  assert.equal(h.selects[2]?.options[0], "Yes, compact plan and implement here");
  assert.equal(result.details.outcome, "approved");
  assert.notEqual(result.terminate, true);
  assert.equal(h.inline().active, false);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(h.mock.setModels.length, 0);
});

test("RPC signal abort during effort selection keeps planning without reopening actions", async () => {
  const h = await setup({ models: true });
  const controller = new AbortController();
  const select = vi
    .fn<ExtensionContext["ui"]["select"]>()
    .mockResolvedValueOnce("Yes, compact plan and implement here")
    .mockImplementationOnce(async (_title, _choices, options) => {
      assert.equal(options?.signal, controller.signal);
      controller.abort();
      return undefined;
    });
  (h.context.ctx as ExtensionContext).ui.select = select;
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  const result = await h.tool(EXIT_TOOL).execute("abort-effort", {}, controller.signal, undefined, h.context.ctx);
  assert.equal(select.mock.calls.length, 2);
  assert.equal(result.details.outcome, "kept");
  assert.equal(h.inline().active, true);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(h.mock.setModels.length, 0);
  assert.equal(h.projection.mock.calls.length, 0);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
});

test("keep planning ends the turn for your reply in the chat; the next review shows what changed", async () => {
  const { mock, context, tool, inline } = await setup({ select: ["No, keep planning", undefined as never] });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  const ui = (context.ctx as ExtensionContext).ui;
  ui.input = async () => assert.fail("no separate feedback prompt");
  const kept = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(kept.content[0]?.text ?? "", /declined the plan[\s\S]*next message/u);
  assert.equal(kept.terminate, true);
  assert.equal(kept.details.outcome, "kept");
  assert.equal(inline().active, true);
  writeFileSync(inline().planFile, "# Plan\n\nUse redis\n");
  const updates: any[] = [];
  const escaped = await tool(EXIT_TOOL).execute(
    "t2",
    {},
    undefined,
    (update: unknown) => updates.push(update),
    context.ctx,
  );
  assert.equal(updates[0]?.details.previous, "# Plan");
  assert.equal(escaped.terminate, true);
  assert.equal(inline().active, true);
});

test("revision summaries are bounded, suppressed on first/identical plans and cleared after editing", async () => {
  const h = await setup();
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  const file = h.inline().planFile;
  const exit = h.tool(EXIT_TOOL);
  const definition = h.mock.tools.find((candidate) => candidate.name === EXIT_TOOL);
  const schema = definition?.parameters as unknown as {
    properties: {
      changes: { minItems: number; maxItems: number; items: { minLength: number; maxLength: number; pattern: string } };
    };
    required?: string[];
  };
  assert.equal(schema.properties.changes.minItems, 1);
  assert.equal(schema.properties.changes.maxItems, 5);
  assert.equal(schema.properties.changes.items.minLength, 1);
  assert.equal(schema.properties.changes.items.maxLength, 240);
  assert.ok(new RegExp(schema.properties.changes.items.pattern).test("Scope changed"));
  assert.equal(new RegExp(schema.properties.changes.items.pattern).test(" "), false);
  assert.equal(schema.required, undefined);
  writeFileSync(file, "# Original");
  const updates: any[] = [];
  const submit = (params: unknown) =>
    exit.execute("summary", params, undefined, (update: any) => updates.push(update), h.context.ctx);
  await submit({ changes: ["Not a revision yet"] });
  assert.equal(updates.at(-1).details.changes, undefined);
  await submit({ changes: ["Identical"] });
  assert.equal(updates.at(-1).details.changes, undefined);
  writeFileSync(file, "# Revised\n\nUse Redis.");
  await submit({ changes: ["Use Redis instead of SQLite."] });
  assert.deepEqual(updates.at(-1).details.changes, ["Use Redis instead of SQLite."]);
  writeFileSync(file, "# Revised again");
  let selection = 0;
  (h.context.ctx as ExtensionContext).ui.select = async () => (selection++ === 0 ? "Edit the plan" : undefined);
  (h.context.ctx as ExtensionContext).ui.editor = async () => "# User-edited";
  const editor = process.env.EDITOR;
  const visual = process.env.VISUAL;
  delete process.env.EDITOR;
  delete process.env.VISUAL;
  try {
    await submit({ changes: ["Agent summary"] });
    assert.deepEqual(updates.at(-2).details.changes, ["Agent summary"]);
    assert.equal(updates.at(-1).details.changes, undefined);
    assert.equal(updates.at(-1).details.plan, "# User-edited");
  } finally {
    if (editor !== undefined) process.env.EDITOR = editor;
    if (visual !== undefined) process.env.VISUAL = visual;
  }
  for (const changes of [[], [" "], ["x".repeat(241)], Array(6).fill("x"), "x", [1]]) {
    const before = updates.length;
    const result = await submit({ changes });
    assert.match(result.content[0]?.text ?? "", /1–5 nonempty strings/u);
    assert.equal(updates.length, before);
  }
});

test("with a model, approval offers direct choices first and configured handoffs after them", async () => {
  const { mock, context, tool, inline, selects } = await setup({ models: true, select: [undefined as never] });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.deepEqual(selects[0]?.options, [
    "Yes, implement here",
    "Yes, compact plan and implement here",
    "Yes, hand off to Claude Sonnet 5.5 (high)",
    "Edit the plan",
    "No, keep planning",
  ]);
  for (const option of selects[0]?.options ?? []) assert.ok(option.length <= 42, option);
});

test("inline handoffs use authenticated availability, not the cycling shortlist", async () => {
  const astra = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra" };
  const sol = { ...astra, id: "gpt-6-sol", name: "Sol" };
  const terra = { ...astra, id: "gpt-6-terra", name: "Terra" };
  for (const targets of [undefined, [terra.id], [], ["unavailable"]]) {
    const h = await setup({
      implementationModelMap: targets
        ? { "openai-codex/gpt-6-astra": targets.map((modelId) => ({ provider: astra.provider, modelId })) }
        : undefined,
    });
    const ctx = h.context.ctx as ExtensionContext;
    ctx.model = astra as ExtensionContext["model"];
    Object.assign(ctx, { scopedModels: [{ model: astra }, { model: sol }] });
    Object.assign(ctx.modelRegistry, {
      getAvailable: () => [astra, sol, terra],
      find: (provider: string, id: string) => [astra, sol, terra].find((m) => m.provider === provider && m.id === id),
    });
    await h.mock.commands.get("plan")?.handler("", ctx);
    writeFileSync(h.inline().planFile, "# Plan");
    await h.tool(EXIT_TOOL).execute("availability", {}, undefined, undefined, ctx);
    const choices = h.selects[0]?.options ?? [];
    assert.equal(
      choices.some((choice) => choice.includes("hand off to Sol")),
      targets === undefined,
    );
    assert.equal(
      choices.some((choice) => choice.includes("hand off to Terra")),
      targets === undefined || targets.includes(terra.id),
    );
    assert.equal(
      choices.some((choice) => choice.includes("unavailable")),
      false,
    );
  }
});

test("a handoff compacts the context down to the plan and continues on the target model, once", async () => {
  const { mock, context, tool, emit, inline, getLeafId } = await setup({
    models: true,
    select: ["Yes, hand off to Claude Sonnet 5.5 (high)"],
  });
  const pi = mock.pi as ExtensionAPI;
  const setModel = pi.setModel.bind(pi);
  pi.setModel = async (model) => {
    getLeafId.mockReturnValue("model-change-leaf");
    return setModel(model);
  };
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n\n1. Do it\n");
  const result = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.equal(result.terminate, true);
  assert.equal(result.details.outcome, "handoff");
  assert.equal(result.details.handoff, "Claude Sonnet 5.5");
  assert.match(result.content[0]?.text ?? "", /you stay on call/u);
  const settled = await emit("agent_before_settle", { outcome: "completed" });
  assert.equal(settled.continue, true);
  assert.equal(settled.entries[0].type, "custom");
  assert.equal(settled.entries[0].customType, "plan-mode:exec");
  assert.equal(settled.entries[0].data.active, true);
  assert.equal(settled.entries[0].data.returnTo, "planning-leaf", "return to the leaf before the model switch");
  assert.equal(getLeafId.mock.calls.length, 1);
  assert.equal(settled.entries[0].data.planner.name, "Claude Opus 5.5");
  assert.equal(settled.entries[0].data.restore, "anthropic/claude-opus-5-5:off");
  assert.ok(existsSync(settled.entries[0].data.planner.sessionFile), "the seeded planner session is on disk");
  assert.equal(settled.entries[1].type, "compaction");
  assert.equal(settled.entries[1].firstKeptEntryId, null);
  assert.equal(settled.entries[2].type, "custom_message");
  assert.equal(settled.entries[2].customType, "plan-mode-handoff");
  assert.equal(settled.entries[2].display, true);
  assert.match(settled.entries[2].content, /ask_planner/u);
  assert.match(settled.entries[2].content, /## Approved plan\n\n# Plan\n\n1\. Do it$/u);
  assert.equal(settled.entries[2].details.implementer, "Claude Sonnet 5.5");
  assert.equal(settled.entries[2].details.planner, "Claude Opus 5.5");
  assert.deepEqual(
    mock.setModels.map((model: any) => model.id),
    ["claude-sonnet-5-5"],
  );
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined, "only once");
});

test("a handoff does nothing, and says so, when the turn did not complete", async () => {
  const { mock, context, tool, emit, inline } = await setup({
    models: true,
    select: ["Yes, hand off to Claude Sonnet 5.5 (high)"],
  });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.equal(await emit("agent_before_settle", { outcome: "aborted" }), undefined);
  assert.equal(mock.setModels.length, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /handoff did not happen/u);
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined);
});

test("with pi-tool-gate, plan mode is the gate's mode: /plan asks it, approval picks the next mode", async () => {
  const { mock, context, tool, inline, gateEvents, selects } = await setup({
    gate: true,
    select: ["Yes, implement here"],
  });
  assert.ok(
    gateEvents.some((event) => event.channel === PLAN_PROVIDER),
    "plan mode is offered to the gate",
  );
  await mock.commands.get("plan")?.handler("", context.ctx);
  assert.deepEqual(
    gateEvents.filter((event) => event.channel === MODE_SET).map((event) => event.data.mode),
    ["plan"],
  );
  assert.equal(inline().active, true);
  assert.equal(context.statuses.get("permission-mode"), undefined, "the gate shows the mode");
  const planFile = inline().planFile as string;
  assert.ok(gateEvents.some((event) => event.channel === PLAN_PROVIDER && event.data.planFile === planFile));
  writeFileSync(planFile, "# Plan\n");
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.deepEqual(selects[0]?.options, [
    "Yes, implement here",
    "Yes, compact plan and implement here",
    "Edit the plan",
    "No, keep planning",
  ]);
  assert.deepEqual(
    gateEvents.filter((event) => event.channel === MODE_SET).map((event) => event.data.mode),
    ["plan", "auto"],
    "without a recorded mode, approval returns to auto",
  );
  assert.equal(inline().active, false);
  // Leaving plan mode with Shift+Tab (the gate's cycle) leaves it here too.
  mock.eventBus.emit(MODE_CHANGED, { mode: "plan", cycle: [] });
  assert.equal(inline().active, true);
  mock.eventBus.emit(MODE_CHANGED, { mode: "auto", cycle: [] });
  assert.equal(inline().active, false);
});

test("with the gate's chat mode enabled, leaving into chat grants nothing", async () => {
  const { mock, context, tool, emit, inline } = await setup({
    gate: true,
    cycle: ["chat", "plan", "auto"],
    select: [undefined as never],
  });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await emit("before_agent_start", { prompt: "x" });
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  mock.eventBus.emit(MODE_CHANGED, { mode: "chat", cycle: ["chat", "plan", "auto"] });
  const notice = await emit("before_agent_start", { prompt: "y" });
  assert.match(notice.message.content, /left plan mode/u);
  assert.doesNotMatch(notice.message.content, /may now make edits/u);
});

test("approval returns the gate to the mode it was in before planning", async () => {
  const { mock, context, tool, inline, gateEvents } = await setup({
    gate: true,
    prePlanMode: "bypassPermissions",
    cycle: ["chat", "plan", "bypassPermissions", "auto"],
    select: ["Yes, implement here"],
  });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  const result = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.equal(result.details.mode, "bypassPermissions");
  assert.deepEqual(
    gateEvents.filter((event) => event.channel === MODE_SET).map((event) => event.data.mode),
    ["plan", "bypassPermissions"],
  );
});

test("plan tools stay top-level so codemode cannot hide the inline plan review", async () => {
  const { tool } = await setup();
  assert.equal(tool(ENTER_TOOL).exposure, "model-only");
  assert.equal(tool(EXIT_TOOL).exposure, "model-only");
});

test("exit_plan_mode runs after a plan write in the same message, so it never reviews the previous plan", async () => {
  const { tool } = await setup();
  assert.equal((tool(EXIT_TOOL) as { executionMode?: string }).executionMode, "sequential");
});

test("enter_plan_mode lets your agent switch into plan mode itself", async () => {
  const { context, tool, inline, emit } = await setup();
  const result = await tool(ENTER_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(result.content[0]?.text ?? "", /^Entered plan mode\.[\s\S]*Plan mode is active/u);
  assert.equal(inline().active, true);
  assert.equal(await emit("before_agent_start", { prompt: "x" }), undefined, "the tool result was the notice");
  assert.ok(existsSync(inline().planFile.replace(/\/[^/]+$/u, "")), "the plans directory exists");
});

test("Edit the plan opens your external editor in pi's terminal, and saves what you wrote", async () => {
  const { mock, context, tool, inline } = await setup();
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n\nDo it.");
  const dir = mkdtempSync(join(tmpdir(), "plan-editor-"));
  const editor = join(dir, "fake-editor");
  // Records the file it was given, then writes the revised plan into it.
  writeFileSync(editor, `#!/bin/sh\necho "$1" > "${dir}/opened"\nprintf '# Better plan\\n\\nDo it well.\\n' > "$1"\n`, {
    mode: 0o755,
  });
  const previous = process.env.EDITOR;
  process.env.EDITOR = editor;
  const terminal: string[] = [];
  let calls = 0;
  const ui = (context.ctx as ExtensionContext).ui;
  ui.select = async (_title, options) => {
    const label = calls++ === 0 ? "Edit the plan" : "Yes, implement here";
    return options.find((s) => s === label);
  };
  ui.editor = async () => assert.fail("pi's editor is not used when an external one is set");
  (ui as unknown as { custom: unknown }).custom = (
    factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown,
  ) =>
    new Promise((resolve) => {
      factory(
        {
          stop: () => terminal.push("stop"),
          start: () => terminal.push("start"),
          requestRender: () => terminal.push("render"),
        },
        undefined,
        undefined,
        resolve,
      );
    });
  try {
    await tool(EXIT_TOOL).execute("edit", {}, undefined, undefined, context.ctx);
  } finally {
    if (previous === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previous;
  }
  assert.deepEqual(terminal, ["stop", "start", "render"], "pi hands its terminal to the editor and takes it back");
  assert.match(readFileSync(join(dir, "opened"), "utf8"), /plan\.md\n$/u, "a Markdown file");
  assert.equal(readFileSync(inline().planFile, "utf8"), "# Better plan\n\nDo it well.\n", "the plan file is updated");
});

for (const outcome of ["approve", "cancel", "feedback", "edit", "throw", "abort"] as const) {
  test(`plan review releases its blocked hold after ${outcome}`, async () => {
    const { mock, context, tool, inline } = await setup();
    await mock.commands.get("plan")?.handler("", context.ctx);
    writeFileSync(inline().planFile, "# Plan\n\nDo it.");
    const holds: unknown[] = [];
    mock.eventBus.on("herdr:blocked", (data) => holds.push(data));
    const controller = new AbortController();
    let calls = 0;
    const ui = (context.ctx as ExtensionContext).ui;
    ui.select = async (_title, options) => {
      assert.deepEqual(holds, [{ active: true, label: "Review the plan" }]);
      if (outcome === "throw") throw new Error("dialog failed");
      if (outcome === "abort") {
        controller.abort();
        return undefined;
      }
      if (outcome === "cancel") return undefined;
      if (outcome === "feedback") return options.find((s) => s === "No, keep planning");
      if (outcome === "edit" && calls++ === 0) return options.find((s) => s === "Edit the plan");
      return options.find((s) => s === "Yes, implement here");
    };
    ui.input = async () => {
      assert.equal(holds.length, 1);
      return "Revise it";
    };
    ui.editor = async () => {
      assert.equal(holds.length, 1);
      return "# Edited plan";
    };
    const result = tool(EXIT_TOOL).execute("review", {}, controller.signal, undefined, context.ctx);
    if (outcome === "throw") await assert.rejects(result, /dialog failed/);
    else await result;
    assert.deepEqual(holds, [{ active: true, label: "Review the plan" }, { active: false }]);
    if (["cancel", "feedback", "throw", "abort"].includes(outcome)) assert.equal(inline().active, true);
  });
}
