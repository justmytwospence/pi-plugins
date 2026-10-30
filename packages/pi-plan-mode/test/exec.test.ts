import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  ASK_TOOL,
  CONSULT_TIMEOUT_MS,
  EXEC_ENTRY,
  EXEC_STATUS_KEY,
  type ExecState,
  FINISH_TOOL,
  registerExec,
} from "../src/exec.js";
import planMode from "../src/index.js";
import type { PlannerSessionFactory, PlannerSessionOptions } from "../src/planner/session.js";
import { createMockContext, createMockPi } from "./shared/support.js";

initTheme("dark");
const completion = { report: "Done.", verification: "npm test: passed; live checks not run.", concerns: "None" };

const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };

type Result = { content: Array<{ type: string; text: string }>; details?: any; terminate?: boolean; usage?: any };
type Tool = { name: string; execute(...args: unknown[]): Promise<Result> };

/** A fake planner session: each prompt runs `script`, which answers (and may amend the plan file). */
type ScriptReply = { reply: string; amend?: () => void; error?: string };
function fakeSessions(script: (prompt: string) => ScriptReply | Promise<ScriptReply>, abortDelayMs = 0) {
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
        if (abortDelayMs) await new Promise((resolve) => setTimeout(resolve, abortDelayMs));
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
    completionMaxRevisions?: number;
    abortDelayMs?: number;
    hasUI?: boolean;
    restore?: boolean;
    returnTo?: string;
    plan?: string;
    script?: (prompt: string) => ScriptReply | Promise<ScriptReply>;
    select?: Array<string | undefined>;
  } = {},
) {
  const mock = createMockPi();
  const sessions = fakeSessions(
    options.script ??
      (() => ({
        reply: JSON.stringify({
          outcome: "accepted",
          summary: "Meets plan.",
          evidence: ["Inspected files."],
          limitations: [],
          findings: [],
        }),
      })),
    options.abortDelayMs,
  );
  await planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit" as const,
      jevToolSelection: false,
      ...(options.completionMaxRevisions === undefined
        ? {}
        : { completionMaxRevisions: options.completionMaxRevisions }),
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
      // Every appendEntry advances the source leaf, as in SessionManager.
      getLeafId: () => `entry-${mock.entries.length}`,
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
  assert.equal(
    context.statuses.get(EXEC_STATUS_KEY),
    "exec mode on · implementing · 0 consultations · $0.00 consult · $0.00 review",
  );
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
  assert.equal(
    context.statuses.get(EXEC_STATUS_KEY),
    "exec mode on · implementing · 0 consultations · $0.00 consult · $0.00 review",
  );
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
  assert.match(context.statuses.get(EXEC_STATUS_KEY) ?? "", /1 consultations · \$0\.05 consult · \$0\.00 review$/u);
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

const decision = (outcome = "accepted", extra = {}) =>
  JSON.stringify({
    outcome,
    summary: "Reviewed.",
    evidence: ["Read current implementation."],
    limitations: [],
    findings:
      outcome === "changes_requested"
        ? [{ id: "F1", title: "Fix", detail: "Incorrect.", requestedChange: "Fix it." }]
        : [],
    ...extra,
  });
const submit = (s: Awaited<ReturnType<typeof setup>>, extra = {}, signal?: AbortSignal) =>
  s.tool(FINISH_TOOL).execute("finish", { ...completion, ...extra }, signal, undefined, s.context.ctx);
const command = async (s: Awaited<ReturnType<typeof setup>>, args: string) => {
  const cmd = s.mock.commands.get("plan-exec") as any;
  await cmd.handler(args, s.context.ctx);
};
test("accepted first submission finalizes with exactly one review usage", async () => {
  const s = await setup();
  const result = await submit(s);
  assert.equal(s.latest().active, false);
  assert.equal(result.details.completion, "accepted");
  assert.equal(s.latest().negotiation?.attempts, 1);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.05);
  assert.equal(s.latest().asks, 0);
  assert.equal(s.mock.setModels.length, 1);
  assert.equal(result.usage.cost.total, 0.05);
});
for (const status of ["addressed", "disputed"])
  test(status + " finding then acceptance preserves implementer context until acceptance", async () => {
    let calls = 0;
    const s = await setup({ script: () => ({ reply: decision(++calls === 1 ? "changes_requested" : "accepted") }) });
    const first = await submit(s);
    assert.equal(first.terminate, undefined);
    assert.equal(s.latest().active, true);
    assert.equal(s.latest().negotiation?.phase, "revising");
    assert.equal(s.mock.setModels.length, 0);
    assert.equal(s.latest().pendingReturn, undefined);
    const bad = await submit(s);
    assert.match(bad.content[0].text, /responses|finding/i);
    assert.equal(calls, 1);
    const second = await submit(s, { responses: [{ id: "F1", status, response: "Evidence checked." }] });
    assert.equal(second.details.completion, "accepted");
    assert.equal(second.usage.cost.total, 0.05);
    assert.equal(s.latest().negotiation?.reviewCostUsd, 0.1);
  });
test("reusing a resolved finding ID pauses as a visible review failure", async () => {
  let calls = 0;
  const s = await setup({
    script: () => ({
      reply: decision("changes_requested", {
        findings: [{ id: ++calls === 2 ? "F2" : "F1", title: "Fix", detail: "Incorrect.", requestedChange: "Fix it." }],
      }),
    }),
  });
  await submit(s);
  await submit(s, { responses: [{ id: "F1", status: "addressed", response: "Fixed." }] });
  const result = await submit(s, { responses: [{ id: "F2", status: "addressed", response: "Fixed." }] });
  assert.equal(s.latest().negotiation?.pause?.reason, "failure");
  assert.match(result.details.error, /previously resolved finding ID/);
  assert.equal(result.details.assessment.state, "failed");
  assert.equal(result.details.decision, undefined);
  assert.equal(result.terminate, true);
});

test("two revision cycles exhaust after three reviews; paused calls cannot spend", async () => {
  const s = await setup({ script: () => ({ reply: decision("changes_requested") }) });
  await submit(s);
  const responses = [{ id: "F1", status: "addressed", response: "Fixed." }];
  await submit(s, { responses });
  await submit(s, { responses });
  assert.equal(s.latest().negotiation?.attempts, 3);
  assert.equal(s.latest().negotiation?.revisionsUsed, 2);
  assert.equal(s.latest().negotiation?.phase, "paused");
  assert.equal(s.latest().active, true);
  const blocked = await submit(s, { responses });
  assert.equal(blocked.terminate, true);
  assert.equal(s.sessions.prompts.length, 3);
  assert.equal(s.mock.setModels.length, 0);
  await command(s, "resume Try once more");
  await submit(s, { responses });
  assert.equal(s.latest().negotiation?.attempts, 4);
  assert.equal(s.latest().negotiation?.phase, "paused");
});
for (const reply of [
  "",
  "Verdict: done",
  "{",
  decision("user_needed", { question: "Human check?", recommendation: "Verify it." }),
])
  test("invalid or human-needed review pauses: " + reply.slice(0, 15), async () => {
    const s = await setup({ script: () => ({ reply }) });
    const result = await submit(s);
    assert.equal(result.terminate, true);
    assert.equal(s.latest().active, true);
    assert.equal(s.latest().negotiation?.phase, "paused");
    assert.equal(s.latest().pendingReturn, undefined);
  });
test("unavailable planner pauses; disabled review completes without acceptance", async () => {
  const s = await setup({ planner: false });
  await submit(s);
  assert.equal(s.latest().negotiation?.phase, "paused");
  const disabled = await setup({ completionReview: false });
  const result = await submit(disabled);
  assert.equal(result.details.completion, "no_review");
  assert.equal(disabled.sessions.prompts.length, 0);
});
test("explicit retry preserves costs and uses saved report", async () => {
  let calls = 0;
  const s = await setup({ script: () => ({ reply: ++calls === 1 ? "invalid" : decision() }) });
  await submit(s);
  await command(s, "retry");
  const result = await submit(s, { report: "Unrelated replacement" });
  assert.equal(result.details.report, completion.report);
  assert.equal(s.latest().negotiation?.attempts, 2);
  assert.equal(s.latest().negotiation?.revisionsUsed, 0);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.1);
});
test("reload pauses interrupted reviews and restores touched paths", async () => {
  const s = await setup();
  await s.emit("tool_result", { toolName: "write", input: { path: "src/a.ts" }, content: [], isError: false });
  const saved = structuredClone(s.latest());
  saved.negotiation!.phase = "consulting";
  s.mock.entries.push({ customType: EXEC_ENTRY, data: saved });
  await s.emit("session_tree", {});
  assert.equal(s.latest().negotiation?.pause?.reason, "interrupted");
  assert.ok(s.latest().touched?.some((p) => p.endsWith("src/a.ts")));
});
test("cancelled and timed out reviews pause without returning to planner", async () => {
  try {
    for (const cancel of [true, false]) {
      const s = await setup({ script: () => new Promise(() => {}) });
      const controller = new AbortController();
      if (!cancel) vi.useFakeTimers();
      const resultPromise = submit(s, {}, controller.signal);
      await vi.waitFor(() => assert.equal(s.sessions.prompts.length, 1));
      if (cancel) controller.abort();
      else await vi.advanceTimersByTimeAsync(CONSULT_TIMEOUT_MS);
      const result = await resultPromise;
      assert.equal(result.terminate, true);
      assert.equal(s.latest().active, true);
      assert.equal(s.latest().negotiation?.phase, "paused");
      assert.equal(s.latest().pendingReturn, undefined);
      vi.useRealTimers();
    }
  } finally {
    vi.useRealTimers();
  }
});
test("stale review after tree change does not charge or finalize new state", async () => {
  let resolveReply!: (v: ScriptReply) => void;
  const s = await setup({
    script: () =>
      new Promise((resolve) => {
        resolveReply = resolve;
      }),
  });
  const pending = submit(s);
  await vi.waitFor(() => assert.equal(typeof resolveReply, "function"));
  await s.emit("session_tree", {});
  resolveReply({ reply: decision() });
  await pending;
  assert.equal(s.latest().active, true);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0);
});
test("override requires confirmation, stop abandons without completion", async () => {
  const s = await setup({ script: () => ({ reply: "invalid" }), select: ["Keep paused", "Finish without review"] });
  await submit(s);
  await command(s, "accept");
  assert.equal(s.latest().active, true);
  await command(s, "accept");
  assert.equal(s.latest().active, false);
  assert.equal(s.latest().pendingReturn, undefined);
  const stopped = await setup();
  await command(stopped, "stop");
  assert.equal(stopped.latest().active, false);
});

test("zero revision setting is snapshotted at legacy migration", async () => {
  const s = await setup({ completionMaxRevisions: 0, script: () => ({ reply: decision("changes_requested") }) });
  assert.equal(s.latest().negotiation?.maxRevisions, 0);
  await submit(s);
  assert.equal(s.latest().negotiation?.pause?.reason, "exhausted");
  assert.equal(s.latest().negotiation?.attempts, 1);
  assert.equal(s.latest().negotiation?.revisionsUsed, 0);
});
test("human answers survive reload and reach the next reviewer as user-provided evidence", async () => {
  let calls = 0;
  const s = await setup({
    script: () => ({
      reply:
        ++calls === 1 ? decision("user_needed", { question: "Permission?", recommendation: "Ask user." }) : decision(),
    }),
  });
  await submit(s);
  await command(s, "retry");
  assert.equal(s.latest().negotiation?.phase, "paused");
  await command(s, "resume User verified readiness manually");
  await s.emit("session_tree", {});
  const result = await submit(s);
  assert.equal(result.details.completion, "accepted");
  assert.match(s.sessions.prompts.at(-1) ?? "", /User-provided answers.*User verified readiness manually/);
});
test("failed return navigation persists and can be retried after reload", async () => {
  const s = await setup({ returnTo: "planning-leaf" });
  await submit(s);
  assert.equal(s.latest().pendingReturn?.leaf, "planning-leaf");
  const ctx = s.context.ctx as any;
  ctx.navigateTree = async () => {
    throw new Error("not now");
  };
  const back = s.mock.commands.get("plan-back")!;
  await back.handler("", ctx);
  assert.ok(s.latest().pendingReturn);
  await s.emit("session_tree", {});
  ctx.navigateTree = async (leaf: string) => {
    ctx.sessionManager.getLeafId = () => leaf;
  };
  await back.handler("", ctx);
  assert.equal(s.mock.sentMessages.length, 1);
  assert.equal(s.latest().pendingReturn, undefined);
  assert.match(JSON.stringify(s.mock.sentMessages.at(-1)), /Negotiation record/);
});
test("failed return after a real leaf switch does not restore the old retry record", async () => {
  const s = await setup({ returnTo: "planning-leaf" });
  await submit(s);
  const ctx = s.context.ctx as any;
  ctx.navigateTree = async () => {
    ctx.sessionManager.getLeafId = () => "other-branch";
    throw new Error("navigation switched before failing");
  };
  await s.mock.commands.get("plan-back")!.handler("", ctx);
  assert.equal(s.latest().pendingReturn, undefined);
  const entries = s.mock.entries.length;
  await s.mock.commands.get("plan-back")!.handler("", ctx);
  await s.emit("agent_settled", { aborted: false });
  assert.equal(s.mock.entries.length, entries);
  assert.equal(s.mock.sentMessages.length, 0);
  assert.equal(s.mock.sentUserMessages.length, 0);
});

test("paused tool-result cards expose reason-specific recovery at narrow and wide widths", async () => {
  const theme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  for (const reason of ["failure", "interrupted", "user_needed", "exhausted"] as const) {
    const s = await setup({
      completionMaxRevisions: 0,
      script: () => ({
        reply:
          reason === "user_needed"
            ? decision("user_needed", { question: "Human check?", recommendation: "Verify it." })
            : reason === "exhausted"
              ? decision("changes_requested")
              : "invalid",
      }),
    });
    let result: Result;
    if (reason === "interrupted") {
      const saved = structuredClone(s.latest());
      saved.negotiation!.phase = "consulting";
      s.mock.entries.push({ customType: EXEC_ENTRY, data: saved });
      await s.emit("session_tree", {});
      result = await submit(s);
    } else result = await submit(s);
    assert.equal(result.details.negotiation.pause.reason, reason);
    const calls = s.sessions.prompts.length;
    const blocked = await submit(s);
    assert.equal(s.sessions.prompts.length, calls, "rendering and paused calls must not retry");
    const tool = s.mock.tools.find((candidate) => candidate.name === FINISH_TOOL) as any;
    // Exercise both the initial pause result and the already-paused guard result, not fabricated details.
    for (const paused of [result, blocked]) {
      for (const width of [46, 120]) {
        const lines = tool.renderResult(paused, { expanded: false, isPartial: false }, theme).render(width);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
        const text = stripVTControlCharacters(lines.join("\n")).replace(/\s+/gu, " ");
        assert.ok(text.includes("Next action"));
        assert.ok(text.includes("/plan-exec accept"));
        assert.ok(text.includes("/plan-exec stop"));
        assert.ok(text.includes("No automatic retry"));
        assert.ok(text.includes("agents cannot authorize recovery"));
        if (reason === "failure" || reason === "interrupted") {
          assert.ok(text.includes("/plan-exec retry"));
          assert.ok(!text.includes("/plan-exec resume"));
        } else {
          assert.ok(text.includes("/plan-exec resume <answer>"));
          assert.ok(!text.includes("/plan-exec retry"));
          if (reason === "exhausted") assert.ok(text.includes("one extra revision-and-review cycle"));
          else assert.ok(text.includes("Human check?"));
        }
      }
    }
  }
});

test("stale override confirmation cannot finalize a restored execution", async () => {
  const s = await setup({ script: () => ({ reply: "invalid" }) });
  await submit(s);
  let done!: (answer: string) => void;
  (s.context.ctx as any).ui.select = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  const accepting = command(s, "accept");
  await vi.waitFor(() => assert.equal(typeof done, "function"));
  await s.emit("session_tree", {});
  done("Finish without review");
  await accepting;
  assert.equal(s.latest().active, true);
  assert.equal(s.mock.setModels.length, 0);
});
test("no UI override refuses and no return leaf does not schedule navigation", async () => {
  const s = await setup({ hasUI: false, script: () => ({ reply: "invalid" }) });
  await submit(s);
  await command(s, "accept");
  assert.equal(s.latest().active, true);
  assert.equal(s.selects.length, 0);
  const accepted = await setup({ returnTo: "planner", hasUI: false });
  await submit(accepted);
  await accepted.emit("agent_settled", { aborted: false });
  assert.equal(accepted.mock.sentUserMessages.length, 0);
});

test("cancellation drains delayed abort usage exactly once before disposal", async () => {
  const s = await setup({ abortDelayMs: 40, script: () => new Promise(() => {}) });
  const abort = new AbortController();
  const pending = submit(s, {}, abort.signal);
  await vi.waitFor(() => assert.equal(s.sessions.prompts.length, 1));
  abort.abort();
  const result = await pending;
  assert.equal(result.usage.cost.total, 0.05);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.05);
  assert.equal(s.latest().negotiation?.history[0].costUsd, 0.05);
  await submit(s);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.05);
});
test("idle override explicitly schedules return and successful return clears source branch", async () => {
  const s = await setup({
    returnTo: "planning",
    script: () => ({ reply: "invalid" }),
    select: ["Finish without review"],
  });
  await submit(s);
  await command(s, "accept");
  assert.ok(s.mock.sentUserMessages.some((m) => m.text === "/plan-back"));
  const ctx = s.context.ctx as any;
  ctx.navigateTree = async (leaf: string) => {
    assert.equal(s.latest().pendingReturn, undefined, "source must be cleared before navigation");
    ctx.sessionManager.getLeafId = () => leaf;
  };
  await s.mock.commands.get("plan-back")!.handler("", ctx);
  await s.emit("session_tree", {});
  await s.emit("agent_settled", { aborted: false });
  assert.equal(s.mock.sentUserMessages.filter((m) => m.text === "/plan-back").length, 1);
});
test("failed model restoration is recorded and not labeled returned", async () => {
  const s = await setup({ returnTo: "planning" });
  s.mock.rawPi.setModel = async () => false;
  const result = await submit(s);
  assert.equal(result.details.returnedTo, undefined);
  assert.match(result.details.action, /restoration failed/);
  assert.match(s.latest().pendingReturn?.details.action ?? "", /restoration failed/);
});
test("record:false begin seeds its host transaction with fresh identity and snapshotted budget", () => {
  const mock = createMockPi();
  const ctx = createMockContext({ mode: "tui" }).ctx;
  const exec = registerExec(mock.pi, {
    consultantAccess: () => ({}) as never,
    restoreModel: async () => true,
    completionReview: () => true,
    completionMaxRevisions: () => 0,
  });
  const state: ExecState = {
    active: true,
    planFile: "/approved.md",
    implementer: "Model",
    implementerModel: "",
    asks: 0,
    costUsd: 0,
  };
  exec.begin(ctx, state, { record: false });
  assert.equal(mock.entries.length, 0);
  assert.equal(state.negotiation?.maxRevisions, 0);
  const id = state.negotiation?.executionId;
  exec.begin(ctx, state, { record: false });
  assert.notEqual(state.negotiation?.executionId, id);
});
