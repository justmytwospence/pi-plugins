import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ASK_TOOL, EXEC_ENTRY, EXEC_STATUS_KEY, type ExecState, FINISH_TOOL } from "../src/exec.js";
import planMode from "../src/index.js";
import { ENTER_TOOL } from "../src/inline-plan.js";
import type { PlannerSessionFactory, PlannerSessionOptions } from "../src/planner/session.js";
import { createMockContext, createMockPi } from "./shared/support.js";

const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };

type Result = { content: Array<{ type: string; text: string }>; details?: any; terminate?: boolean; usage?: any };
type Tool = { name: string; execute(...args: unknown[]): Promise<Result> };

/** A fake planner session: each prompt runs `script`, which answers (and may amend the plan file). */
function fakeSessions(script: (prompt: string) => { reply: string; amend?: () => void }) {
  const created: PlannerSessionOptions[] = [];
  const prompts: string[] = [];
  const factory: PlannerSessionFactory = async (_host, options) => {
    created.push(options);
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    const session = {
      isStreaming: false,
      prompt: async (text: string) => {
        prompts.push(text);
        emit({ type: "agent_start" });
        const { reply, amend } = script(text);
        amend?.();
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: reply }],
            usage: { totalTokens: 100, cost: { total: 0.05 } },
          },
        });
        emit({ type: "agent_settled" });
      },
      steer: async () => undefined,
      abort: async () => undefined,
    };
    return {
      session: session as never,
      file: options.storage.kind === "open" ? options.storage.file : "/sessions/new.jsonl",
      subscribe: (listener) => {
        listeners.add(listener as never);
        return () => listeners.delete(listener as never);
      },
      dispose: () => undefined,
    };
  };
  return { factory, created, prompts };
}

async function setup(
  options: {
    planner?: boolean;
    restore?: boolean;
    returnTo?: string;
    plan?: string;
    script?: (prompt: string) => { reply: string; amend?: () => void };
    select?: Array<string | undefined>;
  } = {},
) {
  const mock = createMockPi();
  const sessions = fakeSessions(options.script ?? (() => ({ reply: "Use the cache." })));
  await planMode(mock.pi, {
    readSettings: async () => ({ thinkingLevel: "inherit" as const, jevToolSelection: false }),
    createSession: sessions.factory,
  });
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const planFile = join(dir, "calm-river.md");
  writeFileSync(planFile, options.plan ?? "# Plan\n\nChange `src/a.ts`.\n");
  const answers = [...(options.select ?? [])];
  const selects: Array<{ title: string; options: string[] }> = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    cwd: dir,
    model: sonnet,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
      getAvailable: () => [opus, sonnet],
      getAll: () => [opus, sonnet],
      find: (provider: string, id: string) => [opus, sonnet].find((m) => m.provider === provider && m.id === id),
      isUsingOAuth: () => false,
    },
    select: async (title: string, choices: string[]) => {
      selects.push({ title, options: choices });
      return answers.shift();
    },
    sessionManager: {
      getSessionId: () => "s",
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      getEntries: () => [],
      getSessionFile: () => "/main.jsonl",
    },
  });
  const state: ExecState = {
    active: true,
    planFile,
    implementer: "Claude Sonnet 5.5",
    implementerModel: "anthropic/claude-sonnet-5-5",
    ...(options.planner === false
      ? {}
      : {
          planner: {
            spec: "anthropic/claude-opus-5-5:high",
            name: "Claude Opus 5.5",
            sessionFile: join(dir, "planner.jsonl"),
          },
        }),
    ...(options.restore === false ? {} : { restore: "anthropic/claude-opus-5-5:high" }),
    ...(options.returnTo ? { returnTo: options.returnTo } : {}),
    asks: 0,
    costUsd: 0,
  };
  mock.entries.push({ customType: EXEC_ENTRY, data: state });
  for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "startup" }, context.ctx);
  const tool = (name: string) => mock.tools.find((candidate) => candidate.name === name) as unknown as Tool;
  const emit = async (name: string, payload: Record<string, unknown>) => {
    let result: unknown;
    for (const handler of mock.events.get(name) ?? [])
      result = (await handler({ type: name, ...payload }, context.ctx)) ?? result;
    return result as any;
  };
  const latest = () => mock.entries.filter((entry) => entry.customType === EXEC_ENTRY).at(-1)?.data as ExecState;
  return { mock, context, tool, emit, latest, sessions, planFile, selects };
}

test("a restored exec state turns its tools on and shows the footer status", async () => {
  const { mock, context } = await setup();
  assert.ok(mock.rawPi.getActiveTools().includes(ASK_TOOL));
  assert.ok(mock.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.equal(context.statuses.get(EXEC_STATUS_KEY), "exec mode on · Claude Opus 5.5 on call");
  for (const name of [ASK_TOOL, FINISH_TOOL]) {
    const registered = mock.tools.find((candidate) => candidate.name === name) as any;
    assert.equal(registered.exposure, "model-only");
    assert.equal(registered.executionMode, "sequential");
    assert.equal(registered.defaultActive, false);
    assert.deepEqual(registered.annotations, { readOnlyHint: true });
  }
});

test("without a planner on call, only finish_plan is active", async () => {
  const { mock, context } = await setup({ planner: false });
  assert.ok(!mock.rawPi.getActiveTools().includes(ASK_TOOL));
  assert.ok(mock.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.equal(context.statuses.get(EXEC_STATUS_KEY), "exec mode on");
  const ask = mock.tools.find((candidate) => candidate.name === ASK_TOOL) as unknown as Tool;
  const result = await ask.execute("1", { message: "x" }, undefined, undefined, context.ctx);
  assert.match(result.content[0]?.text ?? "", /No planner is on call/u);
});

test("ask_planner opens the seeded session, asks as the implementer, and reports amendments and cost", async () => {
  let planFileRef = "";
  const { tool, context, sessions, latest, planFile } = await setup({
    script: () => ({
      reply: "Use the cache.",
      amend: () => writeFileSync(planFileRef, "# Plan\n\nChange `src/a.ts` and `src/b.ts`.\n"),
    }),
  });
  planFileRef = planFile;
  const result = await tool(ASK_TOOL).execute("1", { message: "Where?" }, undefined, undefined, context.ctx);
  const created = sessions.created[0];
  assert.deepEqual(created?.storage, { kind: "open", file: latest().planner?.sessionFile });
  assert.ok(created?.tools.includes("edit") && created.tools.includes("write"));
  assert.match(sessions.prompts[0] ?? "", /^\[From the implementing agent/u);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /The planner answered:\n\nUse the cache\./u);
  assert.match(text, /It amended the plan/u);
  assert.match(text, /\+ Change `src\/a\.ts` and `src\/b\.ts`\./u);
  assert.equal(latest().asks, 1);
  assert.ok(Math.abs(latest().costUsd - 0.05) < 1e-9);
  assert.match(context.statuses.get(EXEC_STATUS_KEY) ?? "", /1 ask · \$0\.05$/u);
  assert.equal(result.usage.cost.total, 0.05);
});

test("ask_planner rejects an empty message", async () => {
  const { tool, context } = await setup();
  const empty = await tool(ASK_TOOL).execute("1", { message: "  " }, undefined, undefined, context.ctx);
  assert.match(empty.content[0]?.text ?? "", /Say what you found/u);
});

test("the tripwire notes an unplanned file once, and never an error, a planned file or a plan without paths", async () => {
  const { emit, planFile } = await setup();
  const edit = (path: string, isError = false) =>
    emit("tool_result", { toolName: "edit", input: { path }, content: [], isError });
  const noted = await edit("src/other.ts");
  assert.equal(noted.content.length, 1);
  assert.match(noted.content[0].text, /src\/other\.ts is not one of the files the plan changes[\s\S]*ask_planner/u);
  assert.equal(await edit("src/other.ts"), undefined, "once per file");
  assert.equal(await edit("src/a.ts"), undefined, "a file the plan lists");
  assert.equal(await edit("src/c.ts", true), undefined, "an error result");
  const plan = await edit(planFile);
  assert.match(plan.content[0].text, /plan file, which the planner amends/u);
  writeFileSync(planFile, "# Plan\n\nNo paths here.\n");
  assert.equal(await edit("src/d.ts"), undefined, "a plan without paths");
});

test("without a planner the tripwire points at the plan file's amendments", async () => {
  const { emit } = await setup({ planner: false });
  const noted = await emit("tool_result", {
    toolName: "write",
    input: { path: "src/x.ts" },
    content: [],
    isError: false,
  });
  assert.match(noted.content[0].text, /## Amendments/u);
  assert.doesNotMatch(noted.content[0].text, /ask_planner/u);
});

test("finish_plan ends exec mode without asking and returns to the planning model", async () => {
  const { mock, context, tool, latest, selects } = await setup();
  const result = await tool(FINISH_TOOL).execute("1", { report: "Done." }, undefined, undefined, context.ctx);
  assert.equal(result.terminate, true);
  assert.equal(selects.length, 0);
  assert.equal(result.details.implementer, "Claude Sonnet 5.5");
  assert.equal(result.details.returnedTo, "Claude Opus 5.5");
  assert.equal(latest().active, false);
  assert.ok(!mock.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.ok(!mock.rawPi.getActiveTools().includes(ASK_TOOL));
  assert.equal(context.statuses.get(EXEC_STATUS_KEY), undefined);
  assert.deepEqual(
    mock.setModels.map((model: any) => model.id),
    ["claude-opus-5-5"],
  );
});

test("finish_plan leaves the model alone when the session is no longer on the implementer's", async () => {
  const { mock, context, tool } = await setup();
  (context.ctx as any).model = opus;
  await tool(FINISH_TOOL).execute("1", { report: "Done." }, undefined, undefined, context.ctx);
  assert.equal(mock.setModels.length, 0);
});

test("enter_plan_mode refuses while exec mode is on", async () => {
  const { context, tool } = await setup();
  const result = await tool(ENTER_TOOL).execute("1", {}, undefined, undefined, context.ctx);
  assert.match(result.content[0]?.text ?? "", /implementing an approved plan \(exec mode\)/u);
});

test("finish_plan reports what changed and flags files outside the plan", async () => {
  const { context, tool, emit, planFile } = await setup();
  const dir = planFile.slice(0, planFile.lastIndexOf("/"));
  for (const path of ["src/a.ts", "src/other.ts", planFile]) {
    const full = path === planFile ? path : join(dir, path);
    await emit("tool_result", { toolName: "edit", input: { path: full }, content: [], isError: false });
  }
  const result = await tool(FINISH_TOOL).execute("1", { report: "Done." }, undefined, undefined, context.ctx);
  assert.deepEqual(result.details.changes.edited, ["src/a.ts", "src/other.ts"]);
  assert.deepEqual(result.details.changes.outside, ["src/other.ts"]);
});

test("the finish card shows the report, the changes and a status line, at narrow and wide widths", async () => {
  const { context, tool, emit, planFile } = await setup();
  const dir = planFile.slice(0, planFile.lastIndexOf("/"));
  for (const path of ["src/a.ts", "src/other.ts"]) {
    await emit("tool_result", { toolName: "edit", input: { path: join(dir, path) }, content: [], isError: false });
  }
  const result = await tool(FINISH_TOOL).execute("1", { report: "Added the flag." }, undefined, undefined, context.ctx);
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
  const card = (tool(FINISH_TOOL) as any).renderResult(result, { expanded: false, isPartial: false }, theme);
  for (const width of [46, 120]) {
    const text = card.render(width).join("\n").replace(/\s+/gu, " ");
    assert.match(text, /Added the flag\./u);
    assert.match(text, /Changed · 2 files edited · 1 outside the plan/u);
    assert.match(text, /! src\/other\.ts not in the plan/u);
    assert.match(text, /✓ Finished · .*Claude Sonnet 5\.5 → Claude Opus 5\.5/u);
  }
});

test("/plan-back works without pi-recap: the card just has no headline", async () => {
  const { mock, context, tool } = await setup({ returnTo: "leaf-1" });
  await tool(FINISH_TOOL).execute("1", { report: "All done." }, undefined, undefined, context.ctx);
  const messages: any[] = [];
  (mock.rawPi as any).sendMessage = (message: unknown) => messages.push(message);
  const command = (mock as any).commands.get("plan-back");
  await command.handler("", { navigateTree: async () => ({ cancelled: false }), ui: { notify() {} } });
  assert.equal(messages[0].details.headline, undefined);
  assert.match(messages[0].content, /All done\./u);
  assert.match(messages[0].content, /did not consult you/u);
});
