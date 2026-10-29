import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
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
  } = {},
) {
  const mock = createMockPi();
  const plansDirectory = options.plansDirectory ?? mkdtempSync(join(tmpdir(), "plans-"));
  await planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit" as const,
      jevToolSelection: false,
      plansDirectory,
      ...(options.models
        ? {
            implementationModelMap: {
              "anthropic/claude-opus-5-5": {
                provider: "anthropic",
                modelId: "claude-sonnet-5-5",
                thinkingLevel: "high",
              },
            },
          }
        : {}),
    }),
  });
  const answers = [...(options.select ?? [])];
  const selects: Array<{ title: string; options: string[] }> = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    cwd: options.cwd ?? "/work/app",
    select: async (title: string, choices: string[]) => {
      selects.push({ title, options: choices });
      return answers.shift();
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
  return { mock, context, selects, tool, emit, inline, gateEvents, plansDirectory };
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
  const { mock, context, tool, emit, inline, selects } = await setup({ select: ["Yes, implement it here"] });
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
  assert.deepEqual(selects[0]?.options, [
    "Yes, in a fresh context",
    "Yes, implement it here",
    "Edit the plan",
    "No, keep planning",
  ]);
  assert.match(
    result.content[0]?.text ?? "",
    /^The user approved your plan\.[\s\S]*## Approved plan\n\n# Plan\n\n1\. Do it$/u,
  );
  assert.equal(inline().active, false);
  const exec = mock.entries.filter((entry) => entry.customType === "plan-mode:exec").at(-1)?.data as any;
  assert.equal(exec.active, true, "implementing here starts exec mode");
  assert.equal(exec.planFile, planFile);
  assert.equal(exec.planner, undefined, "the implementer is the planner");
  const refused = await tool(ENTER_TOOL).execute("t3", {}, undefined, undefined, context.ctx);
  assert.match(refused.content[0]?.text ?? "", /exec mode/u);
  assert.equal(inline().active, false, "exec mode does not re-enter planning");
  assert.equal(context.statuses.get("permission-mode"), undefined);
  // The result told your agent: no separate notice.
  assert.equal(await emit("before_agent_start", { prompt: "go" }), undefined);
  assert.equal(await emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } }), undefined);
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

test("with a model, approval offers a handoff to the mapped model or keeping the planning model", async () => {
  const { mock, context, tool, inline, selects } = await setup({ models: true, select: [undefined as never] });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.deepEqual(selects[0]?.options, [
    "Yes, hand off to Claude Sonnet 5.5 (high)",
    "Yes, keep Claude Opus 5.5 on it",
    "Edit the plan",
    "No, keep planning",
  ]);
  for (const option of selects[0]?.options ?? []) assert.ok(option.length <= 42, option);
});

test("a handoff compacts the context down to the plan and continues on the target model, once", async () => {
  const { mock, context, tool, emit, inline } = await setup({
    models: true,
    select: ["Yes, hand off to Claude Sonnet 5.5 (high)"],
  });
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
  assert.equal(settled.entries[0].data.planner.name, "Claude Opus 5.5");
  assert.equal(settled.entries[0].data.restore, "anthropic/claude-opus-5-5");
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
    select: ["Yes, implement it here"],
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
    "Yes, in a fresh context",
    "Yes, implement it here",
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
    select: ["Yes, implement it here"],
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
  ui.select = async (_title, options) => (calls++ === 0 ? options.find((s) => s === "Edit the plan") : options[0]);
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
      return options[0];
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
