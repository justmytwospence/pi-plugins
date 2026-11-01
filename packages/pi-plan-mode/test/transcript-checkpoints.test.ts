import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onTestFinished, test } from "vitest";
import { ASK_TOOL, EXEC_ENTRY, type ExecState, FINISH_TOOL } from "../src/exec.js";
import planMode from "../src/index.js";
import { EXIT_TOOL, registerInlinePlanMode } from "../src/inline-plan.js";
import { ASK_PLANNER_TOOL, registerMainChat, SUBMIT_MERGED_TOOL } from "../src/main-chat.js";
import type { PlannerSessionFactory } from "../src/planner/session.js";
import { createMockContext, createMockPi } from "./shared/support.js";

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

test("inline review marks the final displayed plan, not validation, progress or workflow notices", async () => {
  const mock = createMockPi();
  const dir = directory();
  const context = createMockContext({ mode: "rpc", hasUI: true, select: async () => "No, keep planning" });
  const ctx = context.ctx as ExtensionContext;
  const inline = registerInlinePlanMode(mock.pi, {
    plansDirectory: () => dir,
    safeSubcommands: () => undefined,
    executing: () => false,
    toggleKey: () => undefined,
    implementationChoices: () => undefined,
    approved: () => {},
    compactHere: () => {},
    handoff: () => {},
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

test("exec consultation declares its final reply, not its progress", async () => {
  const mock = createMockPi();
  const dir = directory();
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "# Plan\n");
  const factory: PlannerSessionFactory = async () => {
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    return {
      session: {
        isStreaming: false,
        prompt: async () => {
          emit({ type: "agent_start" });
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Use the cache." }],
              usage: { totalTokens: 10, cost: { total: 0 } },
            },
          });
          emit({ type: "agent_settled" });
        },
        steer: async () => undefined,
        abort: async () => undefined,
      } as never,
      file: "/sessions/planner.jsonl",
      subscribe: (listener) => {
        listeners.add(listener as never);
        return () => listeners.delete(listener as never);
      },
      dispose: () => {},
    };
  };
  await planMode(mock.pi, {
    readSettings: async () => ({ thinkingLevel: "inherit" as const, jevToolSelection: false }),
    createSession: factory,
  });
  const model = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet", reasoning: true };
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    cwd: dir,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
      getAvailable: () => [model],
      getAll: () => [model],
      find: () => model,
      isUsingOAuth: () => false,
    },
    sessionManager: {
      getSessionId: () => "s",
      getLeafId: () => `entry-${mock.entries.length}`,
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      getEntries: () => [],
      getSessionFile: () => "/main.jsonl",
    },
  });
  mock.entries.push({
    customType: EXEC_ENTRY,
    data: {
      active: true,
      planFile,
      implementer: "Worker",
      implementerModel: "anthropic/claude-sonnet-5-5",
      planner: { spec: "anthropic/claude-sonnet-5-5", name: "Sonnet", sessionFile: join(dir, "planner.jsonl") },
      asks: 0,
      costUsd: 0,
    } satisfies ExecState,
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "startup" }, context.ctx);
  const updates: Result[] = [];
  const result = await tool(mock, ASK_TOOL).execute(
    "consult-1",
    { message: "Where?" },
    undefined,
    (update: Result) => updates.push(update),
    context.ctx,
  );
  assert.match(result.content[0]?.text ?? "", /Use the cache/u);
  assert.ok(updates.length > 0);
  assert.ok(updates.every((update) => annotation(update) === undefined));
  assert.deepEqual(annotation(reload(result)), { version: 1, checkpoint: { id: "consult-1", kind: "report" } });
});

test("exec marks a completed report but not inactive, validation or progress results", async () => {
  const mock = createMockPi();
  const dir = directory();
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "# Plan\n\nDo the work.\n");
  await planMode(mock.pi, {
    readSettings: async () => ({ thinkingLevel: "inherit" as const, jevToolSelection: false, completionReview: false }),
  });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    cwd: dir,
    sessionManager: {
      getSessionId: () => "s",
      getLeafId: () => `entry-${mock.entries.length}`,
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      getEntries: () => [],
      getSessionFile: () => "/main.jsonl",
    },
  });
  const ctx = context.ctx as ExtensionContext;
  const finish = tool(mock, FINISH_TOOL);
  const inactive = await finish.execute("inactive", {}, undefined, undefined, ctx);
  assert.equal(annotation(inactive), undefined);
  const state: ExecState = {
    active: true,
    planFile,
    implementer: "Worker",
    implementerModel: "test/worker",
    asks: 0,
    costUsd: 0,
  };
  mock.entries.push({ customType: EXEC_ENTRY, data: state });
  for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  assert.equal(
    annotation(await tool(mock, ASK_TOOL).execute("no-planner", { message: "x" }, undefined, undefined, ctx)),
    undefined,
  );
  assert.equal(annotation(await finish.execute("invalid", {}, undefined, undefined, ctx)), undefined);
  const updates: Result[] = [];
  const result = await finish.execute(
    "finish-1",
    { report: "Implemented.", verification: "Tests passed.", concerns: "None" },
    undefined,
    (update: Result) => updates.push(update),
    ctx,
  );
  assert.ok(updates.every((update) => annotation(update) === undefined));
  assert.match(result.content[0]?.text ?? "", /Implemented/u);
  assert.deepEqual(annotation(reload(result)), { version: 1, checkpoint: { id: "finish-1", kind: "report" } });
  assert.equal(annotation(reload(inactive)), undefined);
});
