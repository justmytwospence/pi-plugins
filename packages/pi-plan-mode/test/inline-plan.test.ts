import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  name: string;
  execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details?: any; terminate?: boolean }>;
};

async function setup(
  options: { select?: string[]; input?: string; gate?: boolean; plansDirectory?: string; cwd?: string } = {},
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
      mock.eventBus.emit(MODE_CHANGED, { mode, cycle: ["default", "acceptEdits", "plan", "auto"] });
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
    "Yes, in a fresh session with only the plan",
    "Edit the plan first",
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
  const { mock, context, tool, emit, inline } = await setup({ select: ["Yes, in a fresh session with only the plan"] });
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
    select: ["Yes, auto-accept edits"],
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
  assert.deepEqual(selects[0]?.options.slice(0, 3), [
    "Yes, and use auto mode",
    "Yes, auto-accept edits",
    "Yes, manually approve edits",
  ]);
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

test("enter_plan_mode lets your agent switch into plan mode itself", async () => {
  const { context, tool, inline, emit } = await setup();
  const result = await tool(ENTER_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(result.content[0]?.text ?? "", /^Entered plan mode\.[\s\S]*Plan mode is active/u);
  assert.equal(inline().active, true);
  assert.equal(await emit("before_agent_start", { prompt: "x" }), undefined, "the tool result was the notice");
  assert.ok(existsSync(inline().planFile.replace(/\/[^/]+$/u, "")), "the plans directory exists");
});
