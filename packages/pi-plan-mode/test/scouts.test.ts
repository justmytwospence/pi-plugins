import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test, vi } from "vitest";
import { FAMILY_CHANNEL, type FamilyRequest, type PreparedAgent } from "../src/family-contract.js";
import { plannerExtension } from "../src/planner/extension.js";
import { PLANNER_ENV } from "../src/planners.js";
import * as scoutProcess from "../src/scout-process.js";
import { formatScoutResults, normalizeScoutTasks, runScout, SCOUT_MODEL_ENV, scoutArgs } from "../src/scout-process.js";
import { normalizePlanModeSettings } from "../src/settings.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  emitEvent(event: unknown) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  exit(code: number) {
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit("close", code), 5);
  }
  kill() {
    this.exit(1);
    return true;
  }
}

function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnProcess = ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: options.env });
    const child = new FakeChild();
    setTimeout(() => script(child), 0);
    return child;
  }) as never;
  return { spawnProcess, calls };
}

const usage = (total: number) => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { total },
});

test("scout tasks validate, and scouts run with read-only tools and no extensions", () => {
  assert.deepEqual(
    normalizeScoutTasks({
      tasks: [
        { task: " look ", label: "" },
        { task: "b", label: "B" },
      ],
    }),
    {
      ok: true,
      tasks: [
        { label: "task 1", task: "look" },
        { label: "B", task: "b" },
      ],
    },
  );
  for (const invalid of [{}, { tasks: [] }, { tasks: [{ task: "" }] }, { tasks: Array(7).fill({ task: "x" }) }]) {
    assert.equal(normalizeScoutTasks(invalid).ok, false, JSON.stringify(invalid));
  }
  const args = scoutArgs({ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" }, "Find X");
  assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-opus-5-5:high");
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.ok(args.includes("--no-extensions"));
  assert.match(args.at(-1) ?? "", /read-only scout[\s\S]*## Task\n\nFind X/u);
});

test("a scout returns its last report and usage, without inheriting the planner environment", async () => {
  const previous = process.env[PLANNER_ENV];
  process.env[PLANNER_ENV] = "1";
  try {
    const { spawnProcess, calls } = fakeSpawn((child) => {
      child.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Looking" }],
          usage: usage(0.01),
          stopReason: "toolUse",
        },
      });
      child.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Found it in a.ts:3" }],
          usage: usage(0.02),
          stopReason: "stop",
        },
      });
      child.exit(0);
    });
    const result = await runScout({
      spec: { provider: "p", modelId: "m" },
      task: { label: "where", task: "find it" },
      cwd: process.cwd(),
      spawnProcess,
      piCommand: { command: "pi", args: [] },
    });
    assert.equal(result.status, "done");
    assert.equal(result.report, "Found it in a.ts:3");
    assert.equal(result.usage.totalTokens, 30);
    assert.ok(Math.abs(result.usage.cost.total - 0.03) < 1e-9);
    assert.equal(calls[0]?.env[PLANNER_ENV], undefined);
    assert.equal(calls[0]?.env[SCOUT_MODEL_ENV], undefined);
  } finally {
    if (previous === undefined) delete process.env[PLANNER_ENV];
    else process.env[PLANNER_ENV] = previous;
  }

  const failing = fakeSpawn((child) => {
    child.emitEvent({
      type: "message_end",
      message: { role: "assistant", content: [], usage: usage(0), stopReason: "error", errorMessage: "quota" },
    });
    child.exit(1);
  });
  const failed = await runScout({
    spec: { provider: "p", modelId: "m" },
    task: { label: "x", task: "y" },
    cwd: process.cwd(),
    spawnProcess: failing.spawnProcess,
    piCommand: { command: "pi", args: [] },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.report, "quota");

  const controller = new AbortController();
  const cancelled = runScout({
    spec: { provider: "p", modelId: "m" },
    task: { label: "x", task: "y" },
    cwd: process.cwd(),
    signal: controller.signal,
    spawnProcess: fakeSpawn(() => undefined).spawnProcess,
    piCommand: { command: "pi", args: [] },
  });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await cancelled).status, "cancelled");
  assert.match(
    formatScoutResults({ provider: "p", modelId: "m" }, [
      { label: "a", status: "done", report: "A", usage: usage(0) as never },
      { label: "b", status: "timeout", report: "Timed out.", usage: usage(0) as never },
    ]),
    /Ran 2 read-only subagents on p\/m\.[\s\S]*## 1\. a\n\nA[\s\S]*## 2\. b \(timeout\)/u,
  );
});

test("scouts explicitly load observation under --no-extensions and merge its environment", async () => {
  const observation = {
    agentId: "scout-uuid",
    membership: { version: 1, familyId: "family", agentId: "scout-uuid" },
    observer: () => undefined,
    extensions: ["/observer.ts"],
    env: { FAMILY_TEST: "member" },
    finish: vi.fn(),
    dispose: vi.fn(),
  } satisfies PreparedAgent;
  const spawned = fakeSpawn((child) => {
    child.emitEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "report" }],
        stopReason: "stop",
      },
    });
    child.exit(0);
  });
  await runScout({
    observation,
    spec: { provider: "p", modelId: "m" },
    task: { label: "x", task: "y" },
    cwd: "/repo",
    extensions: ["/research.ts"],
    spawnProcess: spawned.spawnProcess,
    piCommand: { command: "pi", args: [] },
  });
  assert.equal(spawned.calls[0]?.env.FAMILY_TEST, "member");
  assert.ok(spawned.calls[0]?.args.includes("--no-session"));
  assert.ok(spawned.calls[0]?.args.includes("--no-extensions"));
  assert.ok(spawned.calls[0]?.args.includes("/observer.ts"));
  assert.ok(spawned.calls[0]?.args.includes("/research.ts"));
  assert.deepEqual(observation.finish.mock.calls, [["done", undefined]]);
  assert.equal(observation.dispose.mock.calls.length, 1);

  const cancelled = new AbortController();
  cancelled.abort();
  const noSpawn = fakeSpawn(() => undefined);
  const result = await runScout({
    observation,
    spec: { provider: "p", modelId: "m" },
    task: { label: "x", task: "y" },
    cwd: "/repo",
    signal: cancelled.signal,
    spawnProcess: noSpawn.spawnProcess,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(noSpawn.calls.length, 0);
});

test("planner scouts enroll as descendants and carry UUIDs through compact view metadata", async () => {
  const observation = {
    agentId: "descendant",
    membership: { version: 1, familyId: "family", agentId: "descendant" },
    observer: () => undefined,
    extensions: ["/observer.ts"],
    env: {},
    finish: () => {},
    dispose: () => {},
  } satisfies PreparedAgent;
  const prepare = vi.fn(async () => observation);
  const run = vi.spyOn(scoutProcess, "runScout").mockResolvedValue({
    label: "look",
    status: "done",
    report: "found",
    usage: scoutProcess.emptyUsage(),
  });
  try {
    let execute!: (...args: unknown[]) => Promise<unknown>;
    plannerExtension({
      tools: new Set(),
      grantPrefixes: [],
      guardExtensionPath: "/guard.ts",
      scouts: { spec: { provider: "p", modelId: "m" }, extensions: [], tools: [] },
      ask: async () => undefined,
      onPlan: () => {},
    })({
      registerTool: (tool: { name: string; execute: typeof execute }) => {
        if (tool.name === "plan_subagents") execute = tool.execute;
      },
      on: () => {},
      events: {
        emit: (channel: string, data: FamilyRequest) => {
          assert.equal(channel, FAMILY_CHANNEL);
          data.service = { prepare } as unknown as FamilyRequest["service"];
        },
      },
    } as never);
    const updates: Array<{ details: { scouts: Array<{ familyAgentId?: string }> } }> = [];
    await execute(
      "call",
      { tasks: [{ label: "look", task: "find" }] },
      undefined,
      (update: (typeof updates)[number]) => updates.push(update),
      { cwd: "/repo" },
    );
    assert.equal(prepare.mock.calls.length, 1);
    assert.equal(run.mock.calls[0]?.[0].observation, observation);
    assert.equal(updates.at(-1)?.details.scouts[0]?.familyAgentId, "descendant");
  } finally {
    run.mockRestore();
  }
});

test("scoutModelMap normalizes like the implementation map", () => {
  assert.deepEqual(
    normalizePlanModeSettings({ scoutModelMap: { "anthropic/claude-fable-5-1": "anthropic/claude-opus-5-5:high" } })
      ?.scoutModelMap,
    { "anthropic/claude-fable-5-1": { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" } },
  );
  assert.equal(normalizePlanModeSettings({ scoutModelMap: { bad: "anthropic/x" } }), undefined);
});
