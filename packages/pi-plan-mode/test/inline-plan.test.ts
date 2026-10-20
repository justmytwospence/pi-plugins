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
  } = {},
) {
  const mock = createMockPi();
  const plansDirectory = options.plansDirectory ?? mkdtempSync(join(tmpdir(), "plans-"));
  await planMode(mock.pi, {
    readSettings: async () => ({ thinkingLevel: "inherit" as const, jevToolSelection: false, plansDirectory }),
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
    sessionManager: {
      getSessionId: () => "s",
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      getEntries: () => [],
      getSessionFile: () => "/main.jsonl",
    },
  });
  const gateEvents: Array<{ channel: string; data: any }> = [];
  if (options.gate) {
    // A stand-in for pi-tool-gate: it takes mode requests and announces every change.
    let mode = "auto";
    const announce = () =>
      mock.eventBus.emit(MODE_CHANGED, { mode, cycle: options.cycle ?? ["default", "acceptEdits", "plan", "auto"] });
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
  const { mock, context, tool, emit, inline, selects } = await setup({ select: ["Yes, implement it"] });
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
    "Yes, implement it",
    "Yes, in a fresh session",
    "Edit the plan",
    "No, keep planning",
  ]);
  assert.match(
    result.content[0]?.text ?? "",
    /^User has approved your plan[\s\S]*## Approved Plan:\n# Plan\n\n1\. Do it$/u,
  );
  assert.equal(inline().active, false);
  assert.equal(context.statuses.get("permission-mode"), undefined);
  // The result told your agent: no separate notice.
  assert.equal(await emit("before_agent_start", { prompt: "go" }), undefined);
  assert.equal(await emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } }), undefined);
});

test("keep planning sends your feedback back; Esc stops the turn", async () => {
  const { mock, context, tool, inline } = await setup({
    select: ["No, keep planning", undefined as never],
    input: "use redis",
  });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  const kept = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(kept.content[0]?.text ?? "", /keep planning[\s\S]*use redis/u);
  assert.equal(kept.terminate, undefined);
  assert.equal(inline().active, true);
  const escaped = await tool(EXIT_TOOL).execute("t2", {}, undefined, undefined, context.ctx);
  assert.equal(escaped.terminate, true);
  assert.equal(inline().active, true);
});

test("a fresh-session approval starts /plan's fresh session once the turn is over", async () => {
  const { mock, context, tool, emit, inline } = await setup({ select: ["Yes, in a fresh session"] });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  const result = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.equal(result.terminate, true);
  await emit("agent_settled", {});
  assert.equal(mock.sentUserMessages.at(-1)?.text, "/plan --implement-fresh");
  let created: any;
  (context.ctx as any).newSession = async (options: any) => {
    created = options;
  };
  await mock.commands.get("plan")?.handler("--implement-fresh", context.ctx);
  assert.ok(created?.withSession, "a fresh session gets the plan");
  await emit("agent_settled", {});
  assert.equal(mock.sentUserMessages.length, 1, "only once");
});

test("with pi-tool-gate, plan mode is the gate's mode: /plan asks it, approval picks the next mode", async () => {
  const { mock, context, tool, inline, gateEvents, selects } = await setup({
    gate: true,
    select: ["Yes, accept edits"],
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
  assert.deepEqual(selects[0]?.options.slice(0, 3), ["Yes, auto mode", "Yes, accept edits", "Yes, approve each edit"]);
  assert.deepEqual(
    gateEvents.filter((event) => event.channel === MODE_SET).map((event) => event.data.mode),
    ["plan", "acceptEdits"],
  );
  assert.equal(inline().active, false);
  // Leaving plan mode with Shift+Tab (the gate's cycle) leaves it here too.
  mock.eventBus.emit(MODE_CHANGED, { mode: "plan", cycle: [] });
  assert.equal(inline().active, true);
  mock.eventBus.emit(MODE_CHANGED, { mode: "auto", cycle: [] });
  assert.equal(inline().active, false);
});

test("with the gate's chat mode enabled: approval offers only enabled modes; leaving into chat grants nothing", async () => {
  const { mock, context, tool, emit, inline, selects } = await setup({
    gate: true,
    cycle: ["chat", "plan", "auto"],
    select: [undefined as never],
  });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await emit("before_agent_start", { prompt: "x" });
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.deepEqual(selects[0]?.options, [
    "Yes, auto mode",
    "Yes, in a fresh session",
    "Edit the plan",
    "No, keep planning",
  ]);
  mock.eventBus.emit(MODE_CHANGED, { mode: "chat", cycle: ["chat", "plan", "auto"] });
  const notice = await emit("before_agent_start", { prompt: "y" });
  assert.match(notice.message.content, /left plan mode/u);
  assert.doesNotMatch(notice.message.content, /may now make edits/u);
});

test("plan tools stay top-level so codemode cannot hide the inline plan review", async () => {
  const { tool } = await setup();
  assert.equal(tool(ENTER_TOOL).exposure, "model-only");
  assert.equal(tool(EXIT_TOOL).exposure, "model-only");
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
