import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { onTestFinished, test } from "vitest";
import { EXIT_TOOL, registerInlinePlanMode } from "../src/inline-plan.js";
import {
  ASK_PLANNER_TOOL,
  formatMainToolCall,
  formatMainToolResult,
  MainAgentView,
  registerMainChat,
  SUBMIT_MERGED_TOOL,
} from "../src/main-chat.js";
import { createMockContext, createMockPi } from "./shared/support.js";

initTheme("dark");

type Result = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Tool = { execute(...args: unknown[]): Promise<Result> };
const key = "pi-plugins.transcript.v1";
const annotation = (result: { details?: Record<string, unknown> }) => result.details?.[key];
const reload = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tool = (mock: ReturnType<typeof createMockPi>, name: string) => {
  const found = mock.tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found as unknown as Tool;
};
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-checkpoints-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("main-chat marks only completed planner replies, surviving serialization independently of the run", async () => {
  const mock = createMockPi();
  const ctx = createMockContext().ctx;
  let active = false;
  const planner = {
    id: "A",
    status: "idle",
    working: false,
    stats: {},
    revision: 1,
    consult: async () => ({ reply: "Use a cache.", revised: false }),
  };
  registerMainChat(mock.pi, {
    planners: () => (active ? [planner as never] : undefined),
    submitMerged: (plan) => ({ plan, revision: 1, name: "main" }),
  });
  const ask = tool(mock, ASK_PLANNER_TOOL);
  const call = (id: string) => ask.execute(id, { planner: "A", message: "Where?" }, undefined, undefined, ctx);
  const noRun = await call("no-run");
  assert.equal(annotation(noRun), undefined);
  active = true;
  planner.working = true;
  const working = await call("working");
  assert.equal(annotation(working), undefined);
  planner.working = false;
  planner.status = "asking";
  assert.equal(annotation(await call("awaiting-user")), undefined);
  planner.status = "idle";
  const reply = await call("reply-1");
  assert.match(reply.content[0]?.text ?? "", /Use a cache/u);
  assert.deepEqual(annotation(reply), { version: 1, checkpoint: { id: "reply-1", kind: "report" } });
  const saved = reload(reply);
  active = false;
  assert.deepEqual(annotation(saved), annotation(reply));
  assert.equal(annotation(reload(noRun)), undefined, "a later run never promotes an old acknowledgement");
  assert.equal(annotation(reload(working)), undefined);
  planner.consult = async () => ({ reply: "", revised: false, error: "offline" }) as never;
  active = true;
  const failure = await call("reply-2");
  assert.match(failure.content[0]?.text ?? "", /offline/u);
  assert.deepEqual(annotation(reload(failure)), { version: 1, checkpoint: { id: "reply-2", kind: "report" } });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    annotation(await ask.execute("stopped", { planner: "A", message: "x" }, aborted.signal, undefined, ctx)),
    undefined,
  );
  const merged = await tool(mock, SUBMIT_MERGED_TOOL).execute("merged", { plan: "# Plan" }, undefined, undefined, ctx);
  assert.equal(annotation(merged), undefined);
});

const stubTheme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t } as never;

test("main tool renderers own both display slots; a huge merged plan stays compact and expands verbatim", async () => {
  const mock = createMockPi();
  const ctx = createMockContext().ctx;
  const recorded: string[] = [];
  const definitionFor = registerMainChat(mock.pi, {
    planners: () => undefined,
    submitMerged: (plan) => {
      recorded.push(plan);
      return { plan, revision: 2, name: "main" };
    },
  });
  const plan = `# Plan\n\n${Array.from({ length: 2_000 }, (_, index) => `Step ${index + 1}: keep prose`).join("\n")}`;
  const args = Object.freeze({ plan });
  const merged = mock.tools.find((candidate) => candidate.name === SUBMIT_MERGED_TOOL) as unknown as ToolDefinition & {
    ccstyleOwnCall: boolean;
    ccstyleOwnResult: boolean;
  };
  const ask = mock.tools.find((candidate) => candidate.name === ASK_PLANNER_TOOL) as unknown as typeof merged;
  assert.equal(definitionFor(ASK_PLANNER_TOOL), ask);
  assert.equal(definitionFor(SUBMIT_MERGED_TOOL), merged);
  assert.equal(definitionFor("foreign_session_tool"), undefined);
  for (const definition of [ask, merged]) {
    assert.ok(definition.renderCall);
    assert.ok(definition.renderResult);
    assert.equal(definition.ccstyleOwnCall, true);
    assert.equal(definition.ccstyleOwnResult, true);
  }
  const result = await tool(mock, SUBMIT_MERGED_TOOL).execute("merged-original-id", args, undefined, undefined, ctx);
  const saved = structuredClone(result);
  assert.deepEqual(recorded, [plan]);
  assert.deepEqual(result, {
    content: [
      {
        type: "text",
        text: "Recorded as plan M v2. The user can implement or export it from /planners, or ask you to implement it here.",
      },
    ],
    details: undefined,
  });
  assert.equal(annotation(result), undefined);
  for (const width of [46, 120, 180]) {
    const compact = merged.renderCall?.(args as never, stubTheme, { expanded: false } as never).render(width) ?? [];
    assert.ok(compact.length <= 2);
    assert.match(compact.join("\n"), /2002 lines/u);
    assert.doesNotMatch(compact.join("\n"), /Step 1:/u);
    const expanded = merged.renderCall?.(args as never, stubTheme, { expanded: true } as never).render(width) ?? [];
    assert.equal(formatMainToolCall(SUBMIT_MERGED_TOOL, args, true), `Submit merged plan · 2002 lines\n${plan}`);
    // The call is one row; the full plan is in the expanded result block.
    assert.equal(expanded.length, 1);
    const resultLines =
      merged
        .renderResult?.(result as never, { expanded: false, isPartial: false }, stubTheme, {
          isError: false,
          args,
        } as never)
        .render(width) ?? [];
    assert.match(resultLines.join("\n"), /Completed/u);
    const expandedResult =
      merged
        .renderResult?.(result as never, { expanded: true, isPartial: false }, stubTheme, {
          isError: false,
          args,
        } as never)
        .render(width) ?? [];
    assert.ok(expandedResult.join("").includes("Step 1: keep prose"));
    assert.ok([...compact, ...expanded, ...resultLines].every((line) => visibleWidth(line) <= width));
  }
  assert.deepEqual(result, saved);
  assert.equal(args.plan, plan);
  const question = Object.freeze({ planner: "A", message: "Why this cache?\nWhat about invalidation?" });
  assert.equal(
    formatMainToolCall(ASK_PLANNER_TOOL, question),
    "Ask planner A\nWhy this cache? What about invalidation?",
  );
  assert.equal(formatMainToolCall(ASK_PLANNER_TOOL, question, true), `Ask planner A\n${question.message}`);
  assert.match(
    ask
      .renderCall?.(question as never, stubTheme, { expanded: false } as never)
      .render(120)
      .join("\n") ?? "",
    /Ask planner · A: Why this cache/u,
  );
  assert.match(formatMainToolCall(ASK_PLANNER_TOOL, {}), /not specified\nPreparing question/u);
});

test("main result summaries distinguish lifecycle states and leave prose and checkpoint metadata untouched", () => {
  for (const [body, state] of [
    ["Planner A is still working (reading); its plan will arrive.", "Working"],
    ["Planner A is waiting for the user to answer its questions in /planners; ask again after that.", "Asking"],
    ["Planner A answered:\n\nUse a cache.\nKeep invalidation explicit.", "Completed"],
    ["Stopped waiting; planner A may still answer in its lane.", "Aborted"],
    ["Planner A failed: offline", "Failed"],
    ["No /planners run is active.", "Unavailable"],
    ["The plan is empty.", "Invalid input"],
  ]) {
    const result = Object.freeze({
      content: Object.freeze([Object.freeze({ type: "text", text: body })]),
      details: Object.freeze({ [key]: { version: 1, checkpoint: { id: "same-call-id", kind: "report" } } }),
    });
    const saved = structuredClone(result);
    assert.ok(formatMainToolResult(result).startsWith(`${state}\n`));
    assert.equal(formatMainToolResult(result, { expanded: true }), `${state}\n${body}`);
    assert.deepEqual(result, saved);
  }
  const result = { content: [{ type: "text", text: "Still waiting" }] };
  assert.match(formatMainToolResult(result, { isPartial: true }), /^Working\n/u);
  assert.match(formatMainToolResult(result, { isError: true }), /^Failed\n/u);
  assert.equal(formatMainToolResult({}), "Empty result");
  const longReply = { content: [{ type: "text", text: `Planner A answered:\n\n${"long reply\n".repeat(2_000)}` }] };
  assert.ok(formatMainToolResult(longReply).length < 260);
  assert.ok(formatMainToolResult(longReply, { expanded: true }).includes(longReply.content[0]?.text ?? ""));
});

test("M passes its optional originating-session renderer resolver to seeded, live and reset chats", () => {
  const lookedUp: string[] = [];
  const view = new MainAgentView({
    model: () => ({ name: "Main", spec: { provider: "test", modelId: "main" } }),
    merged: () => undefined,
    cwd: () => "/repo",
    onChange: () => {},
    toolDefinition: (name) => {
      lookedUp.push(name);
      return name === "main_owned"
        ? {
            renderCall: () => new Text("Main session's own call", 0, 0),
            renderResult: () => new Text("Main session's own result", 0, 0),
          }
        : undefined;
    },
  });
  const entries = [
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "seed-id", name: "main_owned", arguments: {} }] },
    },
    {
      type: "message",
      message: { role: "toolResult", toolCallId: "seed-id", content: [{ type: "text", text: "machine data" }] },
    },
  ];
  const shown = () =>
    view.chat
      .render(120)
      .map((line) => stripVTControlCharacters(line))
      .join("\n");
  for (let reset = 0; reset < 2; reset += 1) {
    view.reset(entries);
    assert.match(shown(), /Main session's own call[\s\S]*Main session's own result/u);
    view.apply({ type: "tool_execution_start", toolCallId: "live-id", toolName: "main_owned", args: {} });
    view.apply({
      type: "tool_execution_end",
      toolCallId: "live-id",
      result: { content: [{ type: "text", text: "live machine data" }] },
    });
    assert.equal(shown().match(/Main session's own result/gu)?.length, 2);
    assert.doesNotMatch(shown(), /machine data/u);
  }
  assert.ok(lookedUp.length >= 4);
  assert.ok(lookedUp.every((name) => name === "main_owned"));
});

test("inline review marks the final displayed plan, not validation, progress or workflow notices", async () => {
  const mock = createMockPi();
  const dir = directory();
  const context = createMockContext({ mode: "rpc", hasUI: true, select: async () => "No, keep planning" });
  const ctx = context.ctx as ExtensionContext;
  const inline = registerInlinePlanMode(mock.pi, {
    plansDirectory: () => dir,
    safeSubcommands: () => undefined,
    toggleKey: () => undefined,
    implementationChoices: () => undefined,
    approved: () => {},
    compactHere: () => {},
    implementHere: () => "implement",
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);
  const exit = tool(mock, EXIT_TOOL);
  assert.equal(annotation(await exit.execute("inactive", {}, undefined, undefined, ctx)), undefined);
  inline.enter(ctx);
  assert.ok(inline.planFile);
  writeFileSync(inline.planFile, "# Checkpoint plan\n\nDo the work.\n");
  assert.equal(annotation(await exit.execute("invalid", { changes: [] }, undefined, undefined, ctx)), undefined);
  const updates: Result[] = [];
  const result = await exit.execute("review-1", {}, undefined, (update: Result) => updates.push(update), ctx);
  assert.ok(updates.length > 0);
  assert.ok(updates.every((update) => annotation(update) === undefined));
  assert.equal(result.details?.plan, "# Checkpoint plan\n\nDo the work.");
  assert.deepEqual(annotation(reload(result)), { version: 1, checkpoint: { id: "review-1", kind: "plan" } });
  for (const { message } of mock.sentMessages) assert.equal(annotation(message as Result), undefined);
});
