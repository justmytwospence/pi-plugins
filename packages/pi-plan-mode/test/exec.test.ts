import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  ASK_TOOL,
  CONSULT_TIMEOUT_MS,
  EXEC_ENTRY,
  EXEC_STATUS_KEY,
  type ExecState,
  FINISH_MESSAGE_TYPE,
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
  const execEvents: unknown[] = [];
  mock.rawPi.events.on("workflow-mode:exec", (data) => execEvents.push(data));
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
  return { mock, context, tool, emit, latest, sessions, planFile, selects, execEvents };
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

test("shutdown clears UI without ending exec, and a fresh runtime restores it", async () => {
  const s = await setup({ returnTo: "planning-leaf" });
  await s.tool(ASK_TOOL).execute("ask", { message: "Check the plan." }, undefined, undefined, s.context.ctx);
  const saved = structuredClone(s.latest());
  const entries = s.mock.entries.length;
  await s.emit("session_shutdown", {});
  await s.emit("session_shutdown", {});
  assert.equal(s.context.statuses.get(EXEC_STATUS_KEY), undefined);
  assert.equal(s.mock.entries.length, entries, "shutdown must not append a durable end");
  assert.deepEqual(s.latest(), saved);
  assert.deepEqual(
    s.execEvents,
    [{ active: true, source: "restore" }],
    "shutdown must not publish an inactive execution",
  );
  assert.equal(s.mock.setModels.length, 0);
  assert.equal(s.sessions.subscriptions, 0);
  assert.equal(s.sessions.disposals, 1);

  const replacement = createMockPi();
  const events: unknown[] = [];
  replacement.rawPi.events.on("workflow-mode:exec", (data) => events.push(data));
  const restoreModel = vi.fn(async () => true);
  const exec = registerExec(replacement.pi, {
    consultantAccess: () => ({}) as never,
    restoreModel,
    completionReview: () => true,
    completionMaxRevisions: () => 2,
  });
  for (const handler of replacement.events.get("session_start") ?? [])
    await handler({ reason: "reload" }, s.context.ctx);
  assert.equal(exec.active, true);
  assert.deepEqual(events, [{ active: true, source: "restore" }]);
  assert.ok(replacement.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.ok(replacement.rawPi.getActiveTools().includes(ASK_TOOL));
  assert.match(s.context.statuses.get(EXEC_STATUS_KEY) ?? "", /implementing · 1 consultations/u);
  const restored = replacement.entries.at(-1)?.data as ExecState;
  assert.deepEqual(restored, saved, "reload preserves identity, costs, return navigation and model state");
  assert.equal(restoreModel.mock.calls.length, 0);
});

test("tree restore publishes only the active branch's authoritative exec state", async () => {
  const s = await setup();
  const active = structuredClone(s.latest());
  const manager = (s.context.ctx as ExtensionContext).sessionManager;
  const branch = manager.getBranch;
  for (const data of [undefined, { ...active, active: false }, { active: "invalid" }, active]) {
    manager.getBranch = () => (data ? [{ type: "custom", customType: EXEC_ENTRY, data }] : []) as never;
    await s.emit("session_tree", {});
    const expected = data === active;
    assert.deepEqual(s.execEvents.at(-1), { active: expected, source: "restore" });
    assert.equal(s.mock.rawPi.getActiveTools().includes(FINISH_TOOL), expected);
    assert.equal(s.mock.rawPi.getActiveTools().includes(ASK_TOOL), expected);
    assert.equal(Boolean(s.context.statuses.get(EXEC_STATUS_KEY)), expected);
  }
  manager.getBranch = branch;
  assert.deepEqual(s.execEvents, [
    { active: true, source: "restore" },
    { active: false, source: "restore" },
    { active: false, source: "restore" },
    { active: false, source: "restore" },
    { active: true, source: "restore" },
  ]);
  assert.equal(s.mock.setModels.length, 0);
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
const plainTheme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};
const normalize = (text: string) => stripVTControlCharacters(text).replace(/\s+/gu, " ").trim();
const resultText = (result: Result) => result.content.map((part) => part.text).join("\n");
const finishMessages = (s: Awaited<ReturnType<typeof setup>>) =>
  s.mock.sentMessages.map(({ message }) => message as any).filter((m) => m.customType === FINISH_MESSAGE_TYPE);

/** Assert the model-visible prose, independently of the presentation helpers under test. */
function assertReadableHistory(text: string, details: any) {
  const prose = normalize(text);
  const includes = (value: string) => assert.ok(prose.includes(normalize(value)), `Missing readable content: ${value}`);
  for (const value of [details.report, details.verification, details.concerns, details.error, details.question])
    if (value) includes(value);
  const n = details.negotiation;
  assert.ok(n, "the complete negotiation stays available in details");
  includes(`cumulative review cost $${n.reviewCostUsd.toFixed(2)}`);
  includes(`Revisions used: ${n.revisionsUsed}`);
  includes(`Revision limit: ${n.maxRevisions}`);
  includes(`Revision authorized: ${n.revisionAuthorized}`);
  for (const [index, round] of n.history.entries()) {
    includes(`Review ${index + 1}`);
    for (const value of [round.report.report, round.report.verification, round.report.concerns, round.error])
      if (value) includes(value);
    includes(`Review cost: $${round.costUsd.toFixed(2)}`);
    for (const response of round.responses ?? [])
      includes(`Response ${response.id} (${response.status}): ${response.response}`);
    if (round.decision) {
      includes(`Decision: ${round.decision.outcome}`);
      includes(round.decision.summary);
      for (const value of [...round.decision.evidence, ...round.decision.limitations]) includes(value);
      for (const finding of round.decision.findings) {
        includes(`Finding ${finding.id}: ${finding.title}`);
        includes(finding.detail);
        includes(`Requested change: ${finding.requestedChange}`);
      }
      for (const value of [round.decision.question, round.decision.recommendation]) if (value) includes(value);
    }
  }
  for (const answer of n.userAnswers ?? []) includes(answer);
  assert.ok((prose.match(/Review cost:/gu) ?? []).length >= n.history.length, "every round retains its own cost");
  assert.doesNotMatch(
    text,
    /```json|"(?:outcome|history|executionId|report|verification|findings)"\s*:|Negotiation record/u,
  );
}

/** Render registered callbacks, including the custom-message shell rather than just its body. */
function assertFinishRenders(s: Awaited<ReturnType<typeof setup>>, result: Result, title: string, message?: any) {
  const tool = s.mock.tools.find((candidate) => candidate.name === FINISH_TOOL) as any;
  const snapshot = structuredClone(result.details);
  for (const expanded of [false, true]) {
    for (const width of [46, 120]) {
      const components = [tool.renderResult(result, { expanded, isPartial: false }, plainTheme)];
      if (message) {
        const renderer = s.mock.messageRenderers.get(FINISH_MESSAGE_TYPE)!;
        components.push(renderer(message, { expanded }, plainTheme));
      }
      for (const component of components) {
        const lines = component.render(width) as string[];
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `overflow at ${width}`,
        );
        const text = normalize(lines.join("\n"));
        assert.equal(text.split(title).length - 1, 1, `one outcome title at ${width}, expanded=${expanded}`);
        assert.ok(text.includes(normalize(result.details.report)));
        if (result.details.action) assert.ok(text.includes(normalize(result.details.action)));
        if (expanded) assertReadableHistory(text, result.details);
        else if (result.details.completion) {
          assert.ok(text.includes("Verification (implementer reported)"));
          assert.ok(text.includes("Outstanding issues (implementer reported)"));
          assert.ok(text.includes("ctrl+o to expand"));
          const outcomeStatus = {
            accepted: "Reviewed",
            no_review: "Review skipped",
            user_override: "Review overridden",
            stopped: "Not completed",
          }[result.details.completion as "accepted" | "no_review" | "user_override" | "stopped"];
          assert.ok(text.includes(outcomeStatus));
          assert.ok(!text.includes("Review history"), "completed cards keep full rounds behind expansion");
          assert.ok(!text.includes("Files edited:"), "completed cards keep file lists behind expansion");
        }
        assert.doesNotMatch(text, /"(?:outcome|history|report)"\s*:/u);
      }
    }
  }
  assert.deepEqual(result.details, snapshot, "rendering must not mutate durable details");
  if (message) assert.deepEqual(message.details.negotiation, result.details.negotiation);
}

test("accepted first submission finalizes with exactly one review usage", async () => {
  const s = await setup();
  const result = await submit(s);
  assert.equal(s.latest().active, false);
  assert.equal(result.details.completion, "accepted");
  assertReadableHistory(resultText(result), result.details);
  assert.deepEqual(result.details.negotiation, s.latest().negotiation);
  assertFinishRenders(s, result, "Implementation · Accepted");
  assert.equal(s.latest().negotiation?.attempts, 1);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.05);
  assert.equal(s.latest().asks, 0);
  assert.equal(s.mock.setModels.length, 1);
  assert.equal(result.usage.cost.total, 0.05);
  assert.deepEqual(s.execEvents, [
    { active: true, source: "restore" },
    { active: false, source: "transition" },
  ]);
  assert.equal(s.context.statuses.get(EXEC_STATUS_KEY), undefined);
  assert.ok(!s.mock.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.ok(!s.mock.rawPi.getActiveTools().includes(ASK_TOOL));
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
test("later acceptance carries every substantive round into tool content and the returned custom message", async () => {
  const finding = (id: string) => ({
    id,
    title: `Repair ${id}`,
    detail: `Observed defect ${id}.`,
    requestedChange: `Add regression coverage ${id}.`,
  });
  const reviews = [
    decision("changes_requested", {
      summary: "First review found three gaps.",
      evidence: ["Read initial diff."],
      limitations: ["Integration environment unavailable."],
      findings: [finding("F-alpha"), finding("F-beta"), finding("F-gamma")],
    }),
    decision("user_needed", {
      summary: "Human evidence is required.",
      evidence: ["Read revised diff."],
      limitations: ["Cannot verify production access."],
      question: "Has the operator verified readiness?",
      recommendation: "Obtain operator evidence before finishing.",
    }),
    "invalid review payload",
    decision("accepted", {
      summary: "Final evidence satisfies the plan.",
      evidence: ["Read regression results."],
      limitations: ["Production smoke check remains manual."],
    }),
  ];
  const s = await setup({ returnTo: "planning-leaf", script: () => ({ reply: reviews.shift()! }) });
  const first = await submit(s, {
    report: "Initial implementation report.",
    verification: "Initial unit checks passed; integration not run.",
    concerns: "Three suspected edge cases remain.",
  });
  const initialDetails = structuredClone(first.details);
  assertReadableHistory(resultText(first), first.details);
  assertFinishRenders(s, first, "Review 1 · Changes requested");
  const responses = [
    { id: "F-alpha", status: "addressed", response: "Added a failing-then-passing regression." },
    { id: "F-beta", status: "disputed", response: "Existing guard rejects this input; verified by test." },
    { id: "F-gamma", status: "blocked", response: "Operator access is required to reproduce." },
  ];
  const second = await submit(s, {
    report: "Revised implementation report.",
    verification: "Revised checks passed; production not run.",
    concerns: "Waiting on operator access.",
    responses,
  });
  assertReadableHistory(resultText(second), second.details);
  assertFinishRenders(s, second, "Review 2 · User input needed");
  await command(s, "resume Operator verified readiness with deployment logs");
  const failed = await submit(s, {
    report: "Final implementation report.",
    verification: "All local checks passed; live smoke check not run.",
    concerns: "Manual production smoke check remains.",
    responses,
  });
  assert.equal(failed.details.negotiation.pause.reason, "failure");
  assertReadableHistory(resultText(failed), failed.details);
  await command(s, "retry");
  const accepted = await submit(s, { report: "Must not replace the saved report.", responses });
  assert.equal(accepted.details.completion, "accepted");
  assert.equal(accepted.details.report, "Final implementation report.");
  assert.equal(accepted.details.negotiation.history.length, 4);
  assert.equal(accepted.details.negotiation.reviewCostUsd, 0.2);
  assert.deepEqual(accepted.details.negotiation.history[1].responses, responses);
  assert.deepEqual(accepted.details.negotiation, s.latest().negotiation);
  assert.deepEqual(first.details, initialDetails, "later reviews do not rewrite earlier result details");
  assertReadableHistory(resultText(accepted), accepted.details);
  const ctx = s.context.ctx as any;
  ctx.navigateTree = async (leaf: string) => {
    ctx.sessionManager.getLeafId = () => leaf;
  };
  await s.mock.commands.get("plan-back")!.handler("", ctx);
  const message = finishMessages(s).at(-1);
  assert.ok(message);
  assertReadableHistory(message.content, message.details);
  assert.deepEqual(message.details.negotiation, accepted.details.negotiation);
  assertFinishRenders(s, accepted, "Implementation · Accepted", message);
});

test("completed registered renderers preview literal report text but retain the full report on expansion", async () => {
  const s = await setup({ returnTo: "planning-leaf" });
  const report = `Literal implementation opening. ${"Detailed implementation evidence. ".repeat(30)}\n\nFinal paragraph retained only on expansion.`;
  const result = await submit(s, { report });
  const ctx = s.context.ctx as any;
  ctx.navigateTree = async (leaf: string) => {
    ctx.sessionManager.getLeafId = () => leaf;
  };
  await s.mock.commands.get("plan-back")!.handler("", ctx);
  const message = finishMessages(s).at(-1);
  assert.ok(message);
  assertReadableHistory(resultText(result), result.details);
  assertReadableHistory(message.content, message.details);
  const tool = s.mock.tools.find((candidate) => candidate.name === FINISH_TOOL) as any;
  const custom = s.mock.messageRenderers.get(FINISH_MESSAGE_TYPE);
  assert.ok(custom);
  const snapshot = structuredClone(result.details);
  for (const expanded of [false, true]) {
    for (const width of [46, 120]) {
      const components = [
        tool.renderResult(result, { expanded, isPartial: false }, plainTheme),
        custom(message, { expanded }, plainTheme),
      ];
      for (const component of components) {
        const lines = component.render(width) as string[];
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const text = normalize(lines.join("\n"));
        assert.ok(text.includes("Literal implementation opening."));
        assert.equal(text.includes("Final paragraph retained only on expansion."), expanded);
        assert.equal(text.split("Implementation · Accepted").length - 1, 1);
        if (expanded) assertReadableHistory(text, result.details);
        else {
          assert.ok(text.includes("…"));
          assert.ok(text.includes("ctrl+o to expand"));
          assert.ok(!text.includes("Review history"));
          assert.ok(text.length < report.length, "collapsed card must not leak the full report");
        }
      }
    }
  }
  assert.deepEqual(result.details, snapshot);
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
    assertReadableHistory(resultText(result), result.details);
  });
test("unavailable planner pauses; disabled review completes without acceptance", async () => {
  const s = await setup({ planner: false });
  await submit(s);
  assert.equal(s.latest().negotiation?.phase, "paused");
  const disabled = await setup({ completionReview: false, returnTo: "planning-leaf" });
  const result = await submit(disabled);
  assert.equal(result.details.completion, "no_review");
  assertReadableHistory(resultText(result), result.details);
  assert.match(resultText(result), /Completed without review/u);
  const ctx = disabled.context.ctx as any;
  ctx.navigateTree = async (leaf: string) => {
    ctx.sessionManager.getLeafId = () => leaf;
  };
  await disabled.mock.commands.get("plan-back")!.handler("", ctx);
  const message = finishMessages(disabled).at(-1);
  assert.ok(message);
  assertReadableHistory(message.content, message.details);
  assertFinishRenders(disabled, result, "Implementation · Completed without review", message);
  assert.equal(disabled.sessions.prompts.length, 0);
  assert.deepEqual(s.execEvents, [{ active: true, source: "restore" }], "paused execution stays active");
  assert.deepEqual(disabled.execEvents, [
    { active: true, source: "restore" },
    { active: false, source: "transition" },
  ]);
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
  assert.deepEqual(s.execEvents, [
    { active: true, source: "restore" },
    { active: true, source: "restore" },
  ]);
});
test("override requires confirmation, stop abandons without completion", async () => {
  const s = await setup({ script: () => ({ reply: "invalid" }), select: ["Keep paused", "Finish without review"] });
  await submit(s);
  await command(s, "accept");
  assert.equal(s.latest().active, true);
  await command(s, "accept");
  assert.equal(s.latest().active, false);
  assert.equal(s.latest().pendingReturn, undefined);
  const override = finishMessages(s).at(-1);
  assert.ok(override);
  assertReadableHistory(override.content, override.details);
  assert.match(override.content, /Completed by user override/u);
  assertFinishRenders(
    s,
    { content: [], details: override.details },
    "Implementation · Completed by user override",
    override,
  );
  const stopped = await setup({ script: () => ({ reply: "invalid" }) });
  await submit(stopped);
  await command(stopped, "stop");
  assert.equal(stopped.latest().active, false);
  assert.equal(stopped.latest().completion?.completion, "stopped");
  const message = finishMessages(stopped).at(-1);
  assert.ok(message);
  assertReadableHistory(message.content, message.details);
  assert.match(message.content, /Implementation stopped/u);
  assertFinishRenders(
    stopped,
    { content: [], details: message.details },
    "Implementation · Implementation stopped",
    message,
  );
  assert.deepEqual(stopped.execEvents, [
    { active: true, source: "restore" },
    { active: false, source: "transition" },
  ]);
  assert.deepEqual(s.execEvents, [
    { active: true, source: "restore" },
    { active: false, source: "transition" },
  ]);
  assert.equal(stopped.mock.setModels.length, 0, "stop does not restore the planning model");
  assert.equal(stopped.context.statuses.get(EXEC_STATUS_KEY), undefined);
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
  const message = finishMessages(s).at(-1);
  assert.ok(message);
  assertReadableHistory(message.content, message.details);
  assert.deepEqual(message.details.negotiation, s.latest().completion?.negotiation);
  assertFinishRenders(
    s,
    { content: [{ type: "text", text: message.content }], details: message.details },
    "Implementation · Accepted",
    message,
  );
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
      for (const expanded of [false, true])
        for (const width of [46, 120]) {
          const lines = tool.renderResult(paused, { expanded, isPartial: false }, theme).render(width);
          assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
          const text = stripVTControlCharacters(lines.join("\n")).replace(/\s+/gu, " ");
          if (expanded) assertReadableHistory(text, paused.details);
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

test("legacy custom finish messages without details render unavailable, never accepted", async () => {
  const s = await setup();
  const renderer = s.mock.messageRenderers.get(FINISH_MESSAGE_TYPE);
  assert.ok(renderer);
  for (const expanded of [false, true]) {
    for (const width of [46, 120]) {
      const component = renderer(
        { customType: FINISH_MESSAGE_TYPE, content: "Legacy completion text.", details: undefined },
        { expanded },
        plainTheme,
      ) as { render(width: number): string[] };
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const text = normalize(lines.join("\n"));
      assert.equal(text.split("Implementation review unavailable").length - 1, 1);
      assert.doesNotMatch(text, /Accepted|Reviewed|Completed without review/u);
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
for (const failure of ["false", "throw"] as const)
  test(`failed model restoration (${failure}) stays actionable in the final card`, async () => {
    const s = await setup({ returnTo: "planning" });
    const restore = vi.fn(async () => {
      if (failure === "throw") throw new Error("Model selection failed");
      return false;
    });
    s.mock.rawPi.setModel = restore;
    const result = await submit(s);
    assert.equal(restore.mock.calls.length, 1);
    assert.equal(result.details.returnedTo, undefined);
    assert.equal(result.details.action, "Planning model restoration failed; select the model manually.");
    assert.equal(s.latest().completion?.action, result.details.action);
    assert.match(s.latest().pendingReturn?.details.action ?? "", /restoration failed/);
    assertReadableHistory(resultText(result), result.details);
    assertFinishRenders(s, result, "Implementation · Accepted");
    assert.doesNotMatch(resultText(result), /Claude Sonnet 5\.5 → Claude Opus/u);
  });
test("record:false begin seeds its host transaction with fresh identity and snapshotted budget", () => {
  const mock = createMockPi();
  const ctx = createMockContext({ mode: "tui" }).ctx;
  const execEvents: unknown[] = [];
  mock.rawPi.events.on("workflow-mode:exec", (data) => {
    assert.equal(exec.active, true);
    assert.ok(mock.rawPi.getActiveTools().includes(FINISH_TOOL));
    execEvents.push(data);
  });
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
  assert.deepEqual(execEvents, [
    { active: true, source: "transition" },
    { active: true, source: "transition" },
  ]);
});
