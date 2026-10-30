import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { ASK_TOOL, CONSULT_TIMEOUT_MS, EXEC_ENTRY, EXEC_STATUS_KEY, type ExecState, FINISH_TOOL } from "../src/exec.js";
import planMode from "../src/index.js";
import { ENTER_TOOL } from "../src/inline-plan.js";
import { reviewVerdict } from "../src/planner/prompt.js";
import type { PlannerSessionFactory, PlannerSessionOptions } from "../src/planner/session.js";
import { createMockContext, createMockPi } from "./shared/support.js";

initTheme("dark");
const completion = { report: "Done.", verification: "npm test: passed; live checks not run.", concerns: "None" };
const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };

type Result = { content: Array<{ type: string; text: string }>; details?: any; terminate?: boolean; usage?: any };
type Tool = { name: string; execute(...args: unknown[]): Promise<Result> };

/** A fake planner session: each prompt runs `script`, which answers (and may amend the plan file). */
type ScriptReply = { reply: string; amend?: () => void; error?: string };
function fakeSessions(script: (prompt: string) => ScriptReply | Promise<ScriptReply>) {
  const created: PlannerSessionOptions[] = [];
  const prompts: string[] = [];
  let aborts = 0;
  let disposals = 0;
  let subscriptions = 0;
  let stop: (() => void) | undefined;
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
        session.isStreaming = true;
        emit({ type: "agent_start" });
        const { reply, amend, error } = await Promise.race([
          Promise.resolve().then(() => script(text)),
          new Promise<ScriptReply>((resolve) => {
            stop = () => resolve({ reply: "", error: "aborted" });
          }),
        ]);
        amend?.();
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: reply }],
            usage: { totalTokens: 100, cost: { total: 0.05 } },
            ...(error ? { stopReason: "error", errorMessage: error } : {}),
          },
        });
        session.isStreaming = false;
        emit({ type: "agent_settled" });
      },
      steer: async () => undefined,
      abort: async () => {
        aborts += 1;
        stop?.();
      },
    };
    return {
      session: session as never,
      file: options.storage.kind === "open" ? options.storage.file : "/sessions/new.jsonl",
      subscribe: (listener) => {
        listeners.add(listener as never);
        subscriptions += 1;
        return () => {
          if (listeners.delete(listener as never)) subscriptions -= 1;
        };
      },
      dispose: () => {
        disposals += 1;
      },
    };
  };
  return {
    factory,
    created,
    prompts,
    get aborts() {
      return aborts;
    },
    get disposals() {
      return disposals;
    },
    get subscriptions() {
      return subscriptions;
    },
  };
}

async function setup(
  options: {
    planner?: boolean;
    plannerSpec?: string;
    completionReview?: boolean;
    hasUI?: boolean;
    restore?: boolean;
    returnTo?: string;
    plan?: string;
    script?: (prompt: string) => ScriptReply | Promise<ScriptReply>;
    select?: Array<string | undefined>;
  } = {},
) {
  const mock = createMockPi();
  const sessions = fakeSessions(options.script ?? (() => ({ reply: "Use the cache.\nVerdict: done" })));
  await planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit" as const,
      jevToolSelection: false,
      ...(options.completionReview === undefined ? {} : { completionReview: options.completionReview }),
    }),
    createSession: sessions.factory,
  });
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const planFile = join(dir, "calm-river.md");
  writeFileSync(planFile, options.plan ?? "# Plan\n\nChange `src/a.ts`.\n");
  const answers = [...(options.select ?? [])];
  const selects: Array<{ title: string; options: string[] }> = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: options.hasUI !== false,
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
            spec: options.plannerSpec ?? "anthropic/claude-opus-5-5:high",
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

test("finish_plan reviews by default without a user dialog and returns to the planning model", async () => {
  const { mock, context, tool, latest, selects } = await setup();
  const result = await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
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
  await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
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
  const result = await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
  assert.deepEqual(result.details.changes.edited, ["src/a.ts", "src/other.ts"]);
  assert.deepEqual(result.details.changes.outside, ["src/other.ts"]);
});

test("the finish card shows the report, the changes and a status line, at narrow and wide widths", async () => {
  const { context, tool, emit, planFile } = await setup();
  const dir = planFile.slice(0, planFile.lastIndexOf("/"));
  for (const path of ["src/a.ts", "src/other.ts"]) {
    await emit("tool_result", { toolName: "edit", input: { path: join(dir, path) }, content: [], isError: false });
  }
  const result = await tool(FINISH_TOOL).execute(
    "1",
    { ...completion, report: "Added the flag." },
    undefined,
    undefined,
    context.ctx,
  );
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
  const card = (tool(FINISH_TOOL) as any).renderResult(result, { expanded: false, isPartial: false }, theme);
  for (const width of [46, 120]) {
    const text = card.render(width).join("\n").replace(/\s+/gu, " ");
    assert.match(text, /Added the flag\./u);
    assert.match(text, /Changed · 2 files edited · 1 outside the plan/u);
    assert.match(text, /! src\/other\.ts not in the plan/u);
    assert.match(text, /Finished · assessed done/u);
    assert.match(text, /Claude Sonnet 5\.5 → Claude Opus 5\.5/u);
    assert.match(text, /0 consultations/u);
    assert.match(text, /review \$0\.05/u);
    assert.ok((card.render(width) as string[]).every((line) => visibleWidth(line) <= width));
  }
});

test("finish_plan opts into its own result and exposes the required schema", async () => {
  const { tool } = await setup();
  const registered = tool(FINISH_TOOL) as any;
  assert.equal(registered.ccstyleOwnResult, true);
  assert.deepEqual(registered.parameters.required, ["report", "verification", "concerns"]);
  for (const key of ["report", "verification", "concerns"])
    assert.equal(registered.parameters.properties[key].minLength, 1);
});

test("completion status colors require explicit done and None concerns, not report wording", async () => {
  const { tool, planFile } = await setup();
  for (const [assessment, concerns, expected] of [
    [{ state: "reviewed", verdict: "done" }, "  nOnE  ", "success"],
    [{ state: "reviewed", verdict: "done" }, "A migration remains", "warning"],
    [{ state: "reviewed", verdict: "done" }, undefined, "warning"],
    [{ state: "reviewed", verdict: "unclear" }, "None", "warning"],
    [{ state: "disabled" }, "None", "warning"],
    [{ state: "unavailable", reason: "No session" }, "None", "warning"],
    [{ state: "failed", reason: "Review failed" }, "None", "error"],
    [{ state: "reviewed", verdict: "changes" }, "None", "error"],
  ] as const) {
    const colors: string[] = [];
    const coloredTheme = {
      ...theme,
      fg: (role: string, text: string) => {
        if (text.startsWith("Finished ·")) colors.push(role);
        return text;
      },
    };
    const details = {
      ...completion,
      report: "Everything passed; complete success!",
      planFile,
      concerns,
      assessment: { planner: "Planner", narrative: "Evidence", costUsd: 0, ...assessment },
    };
    const lines = (tool(FINISH_TOOL) as any)
      .renderResult({ details }, { expanded: false, isPartial: false }, coloredTheme)
      .render(46);
    assert.ok(lines.length > 0);
    assert.deepEqual(colors, [expected]);
  }
});

test("completion narratives fold but verification, issues and verdict remain visible at real widths", async () => {
  const report = Array.from({ length: 22 }, (_, i) => `Implementation line ${i}`).join("\n");
  const narrative = Array.from({ length: 22 }, (_, i) => `Assessment line ${i}`).join("\n");
  const verification = `${Array.from({ length: 18 }, (_, i) => `Check ${i}: passed`).join("\n")}\nVERIFICATION END`;
  const concerns = `${Array.from({ length: 18 }, (_, i) => `Risk ${i}: needs follow-up`).join("\n")}\nCONCERNS END`;
  const { tool, context } = await setup({ script: () => ({ reply: `${narrative}\nVerdict: changes needed` }) });
  const updates: Result[] = [];
  const result = await tool(FINISH_TOOL).execute(
    "1",
    { report, verification, concerns },
    undefined,
    (update: Result) => updates.push(update),
    context.ctx,
  );
  const render = (value: Result, width: number, expanded = false, isPartial = false) => {
    const lines = (tool(FINISH_TOOL) as any)
      .renderResult(value, { expanded, isPartial }, theme)
      .render(width) as string[];
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `overflow at ${width}`,
    );
    return lines.join("\n").replace(/\s+/gu, " ");
  };
  for (const width of [46, 120]) {
    const collapsed = render(result, width);
    for (const label of [
      "What changed",
      "Verification",
      "Outstanding issues",
      "Planner assessment",
      "VERIFICATION END",
      "CONCERNS END",
      "Verdict: changes needed",
      "0 consultations",
      "review $0.05",
    ])
      assert.ok(collapsed.includes(label), label);
    assert.ok(!collapsed.includes("Implementation line 21"));
    assert.ok(!collapsed.includes("Assessment line 21"));
    assert.match(collapsed, /ctrl\+o to expand/u);
    const expanded = render(result, width, true);
    assert.ok(expanded.includes("Implementation line 21"));
    assert.ok(expanded.includes("Assessment line 21"));
    const update = updates[0];
    assert.ok(update);
    const partial = render(update, width, false, true);
    assert.match(partial, /Planner reviewing…/u);
    assert.ok(partial.includes("VERIFICATION END"));
    assert.ok(partial.includes("CONCERNS END"));
  }
});

test("legacy finish details render unknown verification and assessment, never invented success", async () => {
  const { mock, tool, planFile } = await setup();
  const details = { report: "Old completion report", planFile, asks: 2, costUsd: 0.1 };
  for (const width of [46, 120]) {
    const lines = (tool(FINISH_TOOL) as any)
      .renderResult({ details }, { expanded: false, isPartial: false }, theme)
      .render(width) as string[];
    const text = lines.join("\n").replace(/\s+/gu, " ");
    assert.match(text, /Old completion report/u);
    assert.match(text, /verification is unknown/u);
    assert.match(text, /outstanding issues are unknown/u);
    assert.match(text, /no planner assessment was recorded/u);
    assert.match(text, /2 consultations · \$0\.10/u);
    assert.doesNotMatch(text, /assessed done/u);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const renderer = mock.messageRenderers.get("plan-mode-finish");
    assert.ok(renderer);
    const custom = (renderer({ details }, { expanded: false }, theme) as any).render(width) as string[];
    assert.ok(custom.every((line) => visibleWidth(line) <= width));
    assert.match(custom.join("\n"), /Implementation complete/u);
  }
});

test("/plan-back works without pi-recap: the card just has no headline", async () => {
  const { mock, context, tool } = await setup({ returnTo: "leaf-1" });
  await tool(FINISH_TOOL).execute("1", { ...completion, report: "All done." }, undefined, undefined, context.ctx);
  const messages: any[] = [];
  (mock.rawPi as any).sendMessage = (message: unknown) => messages.push(message);
  const command = (mock as any).commands.get("plan-back");
  await command.handler("", { navigateTree: async () => ({ cancelled: false }), ui: { notify() {} } });
  assert.equal(messages[0].details.headline, undefined);
  assert.match(messages[0].content, /All done\./u);
  assert.match(messages[0].content, /0 consultations/u);
  assert.equal(messages[0].details.assessment.verdict, "done");
  assert.match(messages[0].content, /Verdict: done/u);
  assert.match(messages[0].content, /review \$0\.05/u);
  const renderer = mock.messageRenderers.get("plan-mode-finish");
  assert.ok(renderer);
  for (const width of [46, 120]) {
    const lines = (renderer(messages[0], { expanded: false }, theme) as any).render(width) as string[];
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const text = lines.join("\n").replace(/\s+/gu, " ");
    assert.match(text, /Implementation complete/u);
    assert.match(text, /All done\./u);
    assert.match(text, /Verdict: done/u);
    assert.match(text, /0 consultations/u);
  }
});

test("targeted review keeps evidence, separate usage, and consultation counts", async () => {
  const { tool, context, sessions, latest, planFile } = await setup({
    script: () => ({ reply: "Inspected tracked src/a.ts and history; tests are reported only.\nVerdict: done" }),
  });
  await tool(ASK_TOOL).execute("ask", { message: "Which file?" }, undefined, undefined, context.ctx);
  const result = await tool(FINISH_TOOL).execute("finish", completion, undefined, undefined, context.ctx);
  assert.equal(sessions.created.length, 1, "reuse the seeded on-call session");
  assert.equal(sessions.prompts.length, 2);
  const prompt = sessions.prompts[1] ?? "";
  for (const field of [completion.report, completion.verification, completion.concerns, planFile])
    assert.ok(prompt.includes(field));
  assert.match(prompt, /tracked files and commit history/u);
  assert.match(prompt, /Do not modify any files.*or run tests/u);
  assert.match(prompt, /distinguish implementer-reported checks from independently observed evidence/u);
  assert.equal(result.details.assessment.state, "reviewed");
  assert.equal(result.details.assessment.verdict, "done");
  assert.equal(result.details.assessment.costUsd, 0.05);
  assert.equal(result.details.asks, 1);
  assert.equal(result.details.costUsd, 0.05);
  assert.equal(latest().asks, 1, "review is not another ask_planner consultation");
  assert.equal(result.usage.cost.total, 0.05);
  assert.equal(sessions.disposals, 1);
  assert.equal(sessions.subscriptions, 0);
  assert.match(result.content[0]?.text ?? "", /1 consultation/u);
});

test("disabled review and no planner end honestly without opening a session", async () => {
  for (const options of [{ completionReview: false }, { planner: false }]) {
    const { tool, context, sessions, latest } = await setup(options);
    const result = await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
    assert.equal(result.details.assessment.state, "completionReview" in options ? "disabled" : "unavailable");
    assert.equal(sessions.created.length, 0);
    assert.equal(latest().active, false);
    assert.match(result.content[0]?.text ?? "", /0 consultations/u);
  }
});

test("an invalid on-call session and a thrown review preserve completion without inventing success", async () => {
  for (const options of [
    { plannerSpec: "invalid" },
    {
      script: () => {
        throw new Error("review crashed");
      },
    },
  ]) {
    const { tool, context, latest } = await setup(options);
    const result = await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
    assert.ok(["unavailable", "failed"].includes(result.details.assessment.state));
    assert.equal(result.details.report, completion.report);
    assert.equal(result.details.asks, 0);
    assert.equal(latest().active, false);
  }
});

test("timed out review preserves completion and releases subscriptions", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { tool, context, sessions, latest } = await setup({
    script: async () => {
      started();
      return new Promise<ScriptReply>(() => {});
    },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const finish = tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
    await running;
    await vi.advanceTimersByTimeAsync(CONSULT_TIMEOUT_MS);
    const result = await finish;
    assert.equal(result.details.assessment.state, "failed");
    assert.match(result.details.assessment.reason, /timed out/u);
    assert.equal(result.details.report, completion.report);
    assert.equal(result.details.asks, 0);
    assert.equal(latest().active, false);
    assert.equal(sessions.subscriptions, 0);
  } finally {
    vi.useRealTimers();
  }
});

test("missing or blank completion fields leave exec active and instruct retry", async () => {
  for (const params of [
    {},
    { report: "Done" },
    ...Object.keys(completion).map((key) => ({ ...completion, [key]: "  " })),
  ]) {
    const { tool, context, latest, sessions } = await setup();
    const result = await tool(FINISH_TOOL).execute("1", params, undefined, undefined, context.ctx);
    assert.match(result.content[0]?.text ?? "", /Retry finish_plan.*report.*verification.*concerns/u);
    assert.equal(result.terminate, undefined);
    assert.equal(latest().active, true);
    assert.equal(sessions.created.length, 0);
  }
});

test("review verdicts require an unambiguous final line", () => {
  for (const [reply, expected] of [
    ["Evidence.\nVerdict: done", "done"],
    ["Evidence.\n`Verdict: changes needed`", "changes"],
    [" VERDICT: DONE \n", "done"],
    ["Looks good", "unclear"],
    ["Verdict: done\nBut more text follows", "unclear"],
    ["Verdict: done\nVerdict: changes needed", "unclear"],
    ["Verdict: maybe", "unclear"],
    ["", "unclear"],
  ] as const)
    assert.equal(reviewVerdict(reply), expected, reply);
});

test("changes-needed, unclear, failed and empty reviews retain the report through /plan-back", async () => {
  for (const [answer, state, verdict] of [
    [{ reply: "Fix src/a.ts.\nVerdict: changes needed" }, "reviewed", "changes"],
    [{ reply: "Evidence is insufficient." }, "reviewed", "unclear"],
    [{ reply: "", error: "provider unavailable" }, "failed", undefined],
    [{ reply: "   " }, "failed", undefined],
  ] as const) {
    const { mock, context, tool, sessions, latest } = await setup({ returnTo: "leaf", script: () => answer });
    const result = await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
    assert.equal(result.details.assessment.state, state);
    assert.equal(result.details.assessment.verdict, verdict);
    assert.equal(result.details.report, completion.report);
    assert.equal(latest().active, false);
    assert.equal(result.details.asks, 0);
    assert.equal(sessions.subscriptions, 0);
    const messages: any[] = [];
    (mock.rawPi as any).sendMessage = (message: unknown) => messages.push(message);
    await mock.commands
      .get("plan-back")
      ?.handler("", { navigateTree: async () => ({ cancelled: false }), ui: { notify() {} } } as never);
    assert.deepEqual(messages[0].details, result.details);
    assert.ok(messages[0].content.includes(completion.report));
    assert.ok(messages[0].content.includes(completion.verification));
    assert.match(messages[0].content, /Planner assessment/u);
    const renderer = mock.messageRenderers.get("plan-mode-finish");
    assert.ok(renderer);
    for (const width of [46, 120]) {
      const lines = (renderer(messages[0], { expanded: false }, theme) as any).render(width) as string[];
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join("\n"), /Implementation complete/u);
    }
  }
});

test("cancelling review still ends exec, restores the model and preserves the return report", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { mock, tool, context, sessions, latest, emit } = await setup({
    returnTo: "leaf",
    script: async () => {
      started();
      return new Promise<ScriptReply>(() => {});
    },
  });
  const controller = new AbortController();
  const updates: Result[] = [];
  const finish = tool(FINISH_TOOL).execute(
    "1",
    completion,
    controller.signal,
    (update: Result) => updates.push(update),
    context.ctx,
  );
  await running;
  assert.ok(updates.some((update) => update.details.pending));
  controller.abort();
  const result = await finish;
  assert.equal(result.details.assessment.state, "failed");
  assert.match(result.details.assessment.reason, /cancel/u);
  assert.equal(result.details.report, completion.report);
  assert.equal(result.details.asks, 0);
  assert.equal(latest().active, false);
  assert.ok(sessions.aborts > 0);
  assert.equal(sessions.subscriptions, 0);
  assert.equal(mock.setModels.length, 1);
  await emit("agent_settled", { aborted: true });
  const messages: any[] = [];
  (mock.rawPi as any).sendMessage = (message: unknown) => messages.push(message);
  await mock.commands
    .get("plan-back")
    ?.handler("", { navigateTree: async () => ({ cancelled: false }), ui: { notify() {} } } as never);
  assert.deepEqual(messages[0].details, result.details);
});

test("no UI or no return leaf avoids tree return, and navigation failure keeps its notice", async () => {
  for (const options of [{ hasUI: false, returnTo: "leaf" }, {}]) {
    const { tool, context, emit, mock } = await setup(options);
    await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
    await emit("agent_settled", { aborted: false });
    assert.equal(mock.sentUserMessages.length, 0);
  }
  const { mock, context, tool } = await setup({ returnTo: "leaf" });
  await tool(FINISH_TOOL).execute("1", completion, undefined, undefined, context.ctx);
  const notes: string[] = [];
  await mock.commands.get("plan-back")?.handler("", {
    navigateTree: async () => {
      throw new Error("missing leaf");
    },
    ui: { notify: (text: string) => notes.push(text) },
  } as never);
  assert.match(notes[0] ?? "", /Could not return.*missing leaf.*\/tree/u);
});
