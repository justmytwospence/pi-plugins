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
  CONTINUE_TOOL,
  EXEC_ENTRY,
  EXEC_STATUS_KEY,
  EXEC_STATUS_MESSAGE_TYPE,
  type ExecState,
  FINISH_MESSAGE_TYPE,
  FINISH_TOOL,
  registerExec,
} from "../src/exec.js";
import * as execCards from "../src/exec-cards.js";
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
    restoreName?: string;
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
    ...(options.restoreName ? { restoreName: options.restoreName } : {}),
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
    "exec mode on · idle · not completed · 0 consultations · $0.00 consult · $0.00 review",
  );
  for (const name of [ASK_TOOL, FINISH_TOOL, CONTINUE_TOOL]) {
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
  assert.match(s.context.statuses.get(EXEC_STATUS_KEY) ?? "", /idle · not completed · 1 consultations/u);
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

test("without a planner on call, finish_plan and continue_plan remain active", async () => {
  const { mock, context } = await setup({ planner: false });
  assert.ok(!mock.rawPi.getActiveTools().includes(ASK_TOOL));
  assert.ok(mock.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.equal(
    context.statuses.get(EXEC_STATUS_KEY),
    "exec mode on · idle · not completed · 0 consultations · $0.00 consult · $0.00 review",
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

/** New completions never navigate or publish a duplicate tool completion, even on settlement/reload. */
async function assertCompletedInPlace(s: Awaited<ReturnType<typeof setup>>, messages = 0) {
  assert.equal(s.latest().active, false);
  assert.equal(s.latest().returnTo, undefined);
  assert.equal(s.latest().pendingReturn, undefined);
  const navigate = vi.fn(async () => undefined);
  (s.context.ctx as any).navigateTree = navigate;
  await s.emit("agent_settled", { aborted: false });
  await s.emit("session_start", { reason: "reload" });
  await s.mock.commands.get("plan-back")!.handler("", s.context.ctx as any);
  await s.emit("agent_settled", { aborted: false });
  assert.equal(navigate.mock.calls.length, 0);
  assert.equal(s.mock.sentUserMessages.filter((message) => message.text === "/plan-back").length, 0);
  assert.equal(finishMessages(s).length, messages);
}

/** Explicit pre-upgrade inactive fixture; new finalization must never create pendingReturn. */
async function restoreLegacyPendingReturn(s: Awaited<ReturnType<typeof setup>>) {
  const result = await submit(s);
  const legacy = structuredClone(s.latest());
  legacy.active = false;
  legacy.returnTo = "planning-leaf";
  legacy.pendingReturn = { leaf: "planning-leaf", details: structuredClone(result.details) };
  s.mock.entries.push({ customType: EXEC_ENTRY, data: legacy });
  await s.emit("session_tree", {});
  await s.emit("agent_settled", { aborted: false });
  assert.equal(s.mock.sentUserMessages.length, 0, "legacy recovery is explicit only");
  assert.equal(finishMessages(s).length, 0);
}

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
        if (result.details.action && (expanded || result.details.completion))
          assert.ok(text.includes(normalize(result.details.action)));
        if (expanded) assertReadableHistory(text, result.details);
        else if (result.details.completion) {
          assert.ok(text.includes("Verified"));
          assert.ok(text.includes("Outstanding issues"));
          assert.ok(text.includes("ctrl+o for full report"));
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

test("active legacy acceptance restores in place with exactly one review usage", async () => {
  const s = await setup({ returnTo: "legacy-planning-leaf" });
  const result = await submit(s);
  assert.equal(s.latest().active, false);
  assert.equal(result.details.completion, "accepted");
  assertReadableHistory(resultText(result), result.details);
  assert.deepEqual(result.details.negotiation, s.latest().negotiation);
  assertFinishRenders(s, result, "Implementation · Reviewed");
  assert.equal(s.latest().negotiation?.attempts, 1);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.05);
  assert.equal(s.latest().asks, 0);
  assert.equal(s.mock.setModels.length, 1);
  assert.equal(result.details.returnedTo, opus.name);
  assert.equal(result.usage.cost.total, 0.05);
  assert.deepEqual(s.execEvents, [
    { active: true, source: "restore" },
    { active: false, source: "transition" },
  ]);
  assert.equal(s.context.statuses.get(EXEC_STATUS_KEY), undefined);
  assert.ok(!s.mock.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.ok(!s.mock.rawPi.getActiveTools().includes(ASK_TOOL));
  await assertCompletedInPlace(s);
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
test("later acceptance carries every substantive round into tool content without a duplicate completion", async () => {
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
  assertFinishRenders(s, first, "Review 1 · Previous review · Changes requested");
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
  assertFinishRenders(s, second, "Review 2 · Waiting for your answer");
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
  await assertCompletedInPlace(s);
  assertFinishRenders(s, accepted, "Implementation · Reviewed");
});

test("completed registered renderers preview literal report text but retain the full report on expansion", async () => {
  const s = await setup({ returnTo: "planning-leaf" });
  const report = `Literal implementation opening. ${"Detailed implementation evidence. ".repeat(30)}\n\nFinal paragraph retained only on expansion.`;
  const result = await submit(s, { report });
  await assertCompletedInPlace(s);
  // An explicit renderer fixture, not a second completion published by the tool.
  const message = { customType: FINISH_MESSAGE_TYPE, content: resultText(result), details: result.details };
  assertReadableHistory(resultText(result), result.details);
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
        assert.equal(text.split("Implementation · Reviewed").length - 1, 1);
        if (expanded) assertReadableHistory(text, result.details);
        else {
          assert.ok(text.includes("…"));
          assert.ok(text.includes("ctrl+o for full report"));
          assert.ok(!text.includes("Review history"));
          assert.ok(text.length < report.length, "collapsed card must not leak the full report");
        }
      }
    }
  }
  assert.deepEqual(result.details, snapshot);
});

for (const [origin, outcome, title] of [
  ["tool", "accepted", "Implementation · Reviewed"],
  ["tool", "no_review", "Implementation · Review skipped"],
  ["command", "user_override", "Implementation · Review overridden"],
  ["command", "stopped", "Implementation · Not completed"],
] as const)
  test(`registered ${origin} completion renderer has one title and body: ${outcome}`, async () => {
    const s = await setup({
      completionReview: outcome !== "no_review",
      script: () => ({ reply: origin === "tool" ? decision() : "invalid" }),
    });
    const report = {
      report: "Unique changed evidence 界.\nSecond changed line.",
      verification: "Unique verification evidence: targeted tests passed.",
      concerns: "Unique outstanding evidence: live checks not run.",
    };
    const submitted = await submit(s, report);
    if (origin === "command") {
      if (outcome === "user_override") (s.context.ctx as any).ui.select = async () => "Finish without review";
      await command(s, outcome === "stopped" ? "stop" : "accept");
    }
    const message = finishMessages(s).at(-1);
    assert.equal(finishMessages(s).length, origin === "tool" ? 0 : 1);
    const result = origin === "tool" ? submitted : { content: [], details: message.details };
    assert.equal(result.details.completion, outcome);
    const snapshot = structuredClone(result.details);
    const tool = s.mock.tools.find((candidate) => candidate.name === FINISH_TOOL) as any;
    const custom = s.mock.messageRenderers.get(FINISH_MESSAGE_TYPE);
    assert.ok(custom);
    assert.equal(typeof tool.renderCall, "function");
    const renderFinish = vi.spyOn(execCards, "renderFinish");
    try {
      for (const expanded of [false, true]) {
        for (const width of [46, 120]) {
          const backgrounds: string[] = [];
          const theme = {
            ...plainTheme,
            bg: (role: string, text: string) => {
              backgrounds.push(role);
              return text;
            },
          };
          renderFinish.mockClear();
          const toolContent = tool.renderResult(result, { expanded, isPartial: false }, theme);
          assert.equal(renderFinish.mock.calls.length, 1, "tool delegates to the actual content renderer once");
          assert.notEqual(renderFinish.mock.calls[0][1].omitTitle, true, "tool content owns its title");
          const toolLines = toolContent.render(width) as string[];
          assert.deepEqual(backgrounds, [], "Pi supplies the tool shell; content must not add another");
          renderFinish.mockClear();
          // Tool completions are not published twice; the fixture exercises the registered standalone path too.
          const standalone = custom(
            message ?? { customType: FINISH_MESSAGE_TYPE, content: resultText(result), details: result.details },
            { expanded },
            theme as never,
          ) as { render(width: number): string[] };
          assert.equal(renderFinish.mock.calls.length, 1, "standalone delegates to the actual content renderer once");
          assert.equal(renderFinish.mock.calls[0][1].omitTitle, true, "only the standalone shell owns its title");
          const standaloneLines = standalone.render(width);
          assert.ok(backgrounds.length > 0, "standalone completion supplies its own shell");
          assert.ok(backgrounds.every((role) => role === "toolSuccessBg"));
          const toolText = normalize(toolLines.join("\n"));
          const standaloneText = normalize(standaloneLines.join("\n"));
          assert.equal(standaloneText, toolText, "standalone has exactly the same single title and content block");
          for (const lines of [toolLines, standaloneLines]) {
            assert.ok(
              lines.every((line) => visibleWidth(line) <= width),
              `overflow at ${width}`,
            );
            const text = normalize(lines.join("\n"));
            assert.equal(text.split(title).length - 1, 1, "one outcome title");
            for (const value of Object.values(report)) assert.ok(text.includes(normalize(value)));
            if (!expanded) {
              for (const marker of [
                "Unique changed evidence",
                "Unique verification evidence",
                "Unique outstanding evidence",
              ])
                assert.equal(text.split(marker).length - 1, 1, "one copy of each content section");
              assert.ok(text.includes("ctrl+o for full report"));
            }
          }
          assert.equal(
            normalize(standalone.render(width).join("\n")),
            standaloneText,
            "rerender does not append content",
          );
          assert.equal(normalize(toolContent.render(width).join("\n")), toolText);
        }
      }
    } finally {
      renderFinish.mockRestore();
    }
    assert.deepEqual(result.details, snapshot, "actual renderers preserve durable completion details");
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
  assert.equal(result.details.returnedTo, opus.name);
  assertFinishRenders(disabled, result, "Implementation · Review skipped");
  assert.equal(disabled.sessions.prompts.length, 0);
  assert.deepEqual(s.execEvents, [{ active: true, source: "restore" }], "paused execution stays active");
  assert.deepEqual(disabled.execEvents, [
    { active: true, source: "restore" },
    { active: false, source: "transition" },
  ]);
  await assertCompletedInPlace(disabled);
});
test("retry preserves the saved finding responses as well as report and accumulated costs", async () => {
  const reviews = [decision("changes_requested"), "invalid", decision()];
  const s = await setup({ script: () => ({ reply: reviews.shift()! }) });
  await submit(s);
  const responses = [{ id: "F1", status: "addressed", response: "Saved regression evidence." }];
  await submit(s, { responses });
  await command(s, "retry");
  const result = await submit(s, {
    report: "Replacement report",
    responses: [{ id: "F1", status: "disputed", response: "Replacement evidence must not replace saved evidence." }],
  });
  assert.equal(result.details.report, completion.report);
  assert.deepEqual(result.details.negotiation.history.at(-1).responses, responses);
  assert.ok(Math.abs(s.latest().negotiation!.reviewCostUsd - 0.15) < 1e-9);
  assert.equal(s.latest().negotiation?.revisionsUsed, 1);
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
  const s = await setup({
    script: () => ({ reply: "invalid" }),
    select: [undefined, "Keep paused", "Finish without review"],
  });
  await submit(s);
  await command(s, "accept");
  assert.equal(s.latest().active, true);
  await command(s, "accept");
  assert.equal(s.latest().active, false);
  assert.equal(s.latest().pendingReturn, undefined);
  assert.equal(s.latest().completion?.returnedTo, opus.name);
  const override = finishMessages(s).at(-1);
  assert.ok(override);
  assertReadableHistory(override.content, override.details);
  assert.match(override.content, /Completed by user override/u);
  assertFinishRenders(s, { content: [], details: override.details }, "Implementation · Review overridden", override);
  const stopped = await setup({ script: () => ({ reply: "invalid" }) });
  await submit(stopped);
  await command(stopped, "stop");
  assert.equal(stopped.latest().active, false);
  assert.equal(stopped.latest().completion?.completion, "stopped");
  const message = finishMessages(stopped).at(-1);
  assert.ok(message);
  assertReadableHistory(message.content, message.details);
  assert.match(message.content, /Implementation stopped/u);
  assertFinishRenders(stopped, { content: [], details: message.details }, "Implementation · Not completed", message);
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
  await assertCompletedInPlace(s, 1);
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
test("inactive legacy pending return persists and can be explicitly retried after reload", async () => {
  const s = await setup({ returnTo: "planning-leaf" });
  const markers = () =>
    s.mock.sentMessages.filter(
      ({ message }) => (message as { customType?: string }).customType === "workflow:transition",
    );
  assert.deepEqual(markers(), []);
  await restoreLegacyPendingReturn(s);
  const completionMarkers = [
    {
      message: {
        customType: "workflow:transition",
        content: "WORK · edits and actions",
        display: true,
        details: { version: 1, previous: "exec", mode: "work" },
      },
      options: { triggerTurn: false },
    },
  ];
  assert.deepEqual(markers(), completionMarkers);
  assert.equal(s.latest().pendingReturn?.leaf, "planning-leaf");
  const ctx = s.context.ctx as any;
  ctx.navigateTree = async () => {
    throw new Error("not now");
  };
  const back = s.mock.commands.get("plan-back")!;
  await back.handler("", ctx);
  assert.ok(s.latest().pendingReturn);
  assert.deepEqual(markers(), completionMarkers);
  await s.emit("session_tree", {});
  assert.deepEqual(markers(), completionMarkers);
  ctx.navigateTree = async (leaf: string) => {
    ctx.sessionManager.getLeafId = () => leaf;
  };
  await back.handler("", ctx);
  assert.equal(
    s.mock.sentMessages.filter(
      ({ message }) => (message as { customType?: string }).customType !== "workflow:transition",
    ).length,
    1,
  );
  assert.deepEqual(markers(), completionMarkers);
  assert.equal(s.latest().pendingReturn, undefined);
  const message = finishMessages(s).at(-1);
  assert.ok(message);
  assertReadableHistory(message.content, message.details);
  assert.deepEqual(message.details.negotiation, s.latest().completion?.negotiation);
  assertFinishRenders(
    s,
    { content: [{ type: "text", text: message.content }], details: message.details },
    "Implementation · Reviewed",
    message,
  );
});
test("inactive legacy failed return after a real leaf switch does not restore the old retry record", async () => {
  const s = await setup({ returnTo: "planning-leaf" });
  const markers = () =>
    s.mock.sentMessages.filter(
      ({ message }) => (message as { customType?: string }).customType === "workflow:transition",
    );
  assert.deepEqual(markers(), []);
  await restoreLegacyPendingReturn(s);
  const completionMarkers = [
    {
      message: {
        customType: "workflow:transition",
        content: "WORK · edits and actions",
        display: true,
        details: { version: 1, previous: "exec", mode: "work" },
      },
      options: { triggerTurn: false },
    },
  ];
  assert.deepEqual(markers(), completionMarkers);
  const ctx = s.context.ctx as any;
  ctx.navigateTree = async () => {
    ctx.sessionManager.getLeafId = () => "other-branch";
    throw new Error("navigation switched before failing");
  };
  await s.mock.commands.get("plan-back")!.handler("", ctx);
  assert.equal(s.latest().pendingReturn, undefined);
  assert.deepEqual(markers(), completionMarkers);
  const entries = s.mock.entries.length;
  await s.mock.commands.get("plan-back")!.handler("", ctx);
  assert.deepEqual(markers(), completionMarkers);
  await s.emit("agent_settled", { aborted: false });
  assert.equal(s.mock.entries.length, entries);
  assert.equal(
    s.mock.sentMessages.filter(
      ({ message }) => (message as { customType?: string }).customType !== "workflow:transition",
    ).length,
    0,
  );
  assert.deepEqual(markers(), completionMarkers);
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
          if (!expanded) assert.doesNotMatch(text, /\/plan-exec/u);
          if (reason === "failure" || reason === "interrupted") {
            assert.ok(text.includes("Review did not finish"));
            assert.ok(text.includes("No retry has been authorized."));
          } else if (reason === "exhausted") {
            assert.ok(text.includes("Another revision needs your approval"));
            assert.ok(text.includes("Allow one more attempt"));
          } else {
            assert.ok(text.includes("Waiting for your answer"));
            assert.ok(text.includes("Reply here."));
            assert.ok(text.includes("Human check?"));
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
test("no UI override refuses and completion never schedules navigation", async () => {
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
test("idle command override restores in place and publishes exactly one completion", async () => {
  const s = await setup({
    returnTo: "planning",
    script: () => ({ reply: "invalid" }),
    select: [undefined, "Finish without review"],
  });
  await submit(s);
  await command(s, "accept");
  assert.equal(s.mock.setModels.length, 1);
  assert.equal(s.latest().completion?.returnedTo, opus.name);
  await assertCompletedInPlace(s, 1);
});
for (const origin of ["tool", "command"] as const)
  for (const failure of ["false", "throw"] as const)
    test(`${origin} failed model restoration (${failure}) stays actionable in the final card`, async () => {
      const s = await setup({
        returnTo: "planning",
        script: () => ({ reply: origin === "tool" ? decision() : "invalid" }),
      });
      if (origin === "command") await submit(s);
      const restore = vi.fn(async () => {
        if (failure === "throw") throw new Error("Model selection failed");
        return false;
      });
      s.mock.rawPi.setModel = restore;
      let result: Result;
      if (origin === "tool") result = await submit(s);
      else {
        (s.context.ctx as any).ui.select = async () => "Finish without review";
        await command(s, "accept");
        const message = finishMessages(s).at(-1)!;
        result = { content: [{ type: "text", text: message.content }], details: message.details };
      }
      assert.equal(restore.mock.calls.length, 1);
      assert.equal(result.details.returnedTo, undefined);
      assert.equal(result.details.action, "Planning model restoration failed; select the model manually.");
      assert.equal(s.latest().completion?.action, result.details.action);
      assert.equal(s.latest().pendingReturn, undefined);
      await assertCompletedInPlace(s, origin === "tool" ? 0 : 1);
      assertReadableHistory(resultText(result), result.details);
      assertFinishRenders(
        s,
        result,
        origin === "tool" ? "Implementation · Reviewed" : "Implementation · Review overridden",
      );
      assert.doesNotMatch(resultText(result), /Claude Sonnet 5\.5 → Claude Opus/u);
    });
for (const origin of ["tool", "command"] as const)
  for (const identity of ["named", "matching legacy", "different legacy", "manual"] as const)
    test(`${origin} completion preserves restore identity: ${identity}`, async () => {
      const s = await setup({
        completionReview: false,
        returnTo: "legacy-planning-leaf",
        ...(identity === "named"
          ? { restoreName: "Original planning model", plannerSpec: sonnet.provider + "/" + sonnet.id }
          : {}),
        ...(identity === "different legacy" ? { plannerSpec: sonnet.provider + "/" + sonnet.id } : {}),
        script: () => ({ reply: "invalid" }),
      });
      if (identity === "manual")
        (s.context.ctx as any).model = { provider: "test", id: "manual", name: "Manually chosen" };
      let details: any;
      if (origin === "tool") details = (await submit(s)).details;
      else {
        // Override follows the command completion path, with a saved report and explicit confirmation.
        s.latest().negotiation!.phase = "paused";
        s.latest().negotiation!.latestReport = completion;
        s.latest().negotiation!.pause = { reason: "failure", action: "Retry explicitly." };
        await s.emit("session_tree", {});
        (s.context.ctx as any).ui.select = async () => "Finish without review";
        await command(s, "accept");
        details = finishMessages(s).at(-1)?.details;
      }
      assert.equal(details.completion, origin === "tool" ? "no_review" : "user_override");
      assert.equal(s.mock.setModels.length, identity === "manual" ? 0 : 1);
      assert.equal(
        details.returnedTo,
        identity === "manual"
          ? undefined
          : identity === "named"
            ? "Original planning model"
            : identity === "different legacy"
              ? "anthropic/claude-opus-5-5"
              : opus.name,
      );
      assert.equal(details.action, undefined);
      await assertCompletedInPlace(s, origin === "tool" ? 0 : 1);
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

type Scenario = Awaited<ReturnType<typeof setup>>;
const recover = (s: Scenario, action: string, replyId?: string, signal?: AbortSignal) =>
  s
    .tool(CONTINUE_TOOL)
    .execute("continue", { action, ...(replyId ? { replyId } : {}) }, signal, undefined, s.context.ctx);
const guidance = async (s: Scenario) => {
  const messages = [{ role: "user", content: "Original conversation", timestamp: 1 }];
  const before = structuredClone(messages);
  const result = await s.emit("context", { messages });
  assert.deepEqual(messages, before, "guidance must be request-local");
  return result.messages.at(-1).content as string;
};
const eligibleId = async (s: Scenario) => (await guidance(s)).match(/replyId: (\S+)/u)?.[1];
const deliver = async (s: Scenario, text: string, source = "interactive") => {
  await s.emit("input", { text, source });
  await s.emit("message_end", { message: { role: "user", content: [{ type: "text", text }] } });
};
const userPause = () =>
  setup({
    script: () => ({
      reply: decision("user_needed", { question: "Did the manual check pass?", recommendation: "Ask the operator." }),
    }),
  });
const statusMessages = (s: Scenario) =>
  s.mock.sentMessages.filter(({ message }) => (message as any).customType === EXEC_STATUS_MESSAGE_TYPE);

test("continue_plan schema and activation expose no model-authored answer field", async () => {
  const s = await setup({ planner: false });
  const tool = s.mock.tools.find((candidate) => candidate.name === CONTINUE_TOOL) as any;
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(tool.parameters.properties.action.enum, ["answer", "retry", "extend", "accept", "stop"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.answer, undefined);
  assert.ok(s.mock.rawPi.getActiveTools().includes(CONTINUE_TOOL));
  await submit(s);
  await command(s, "stop");
  assert.ok(!s.mock.rawPi.getActiveTools().includes(CONTINUE_TOOL));
  assert.match(resultText(await recover(s, "stop")), /No approved plan/u);
});

for (const source of ["interactive", "rpc"])
  test(`delivered ${source} answer is consumed verbatim without slash commands`, async () => {
    const s = await userPause();
    await submit(s);
    const text = "  Yes, operator checked readiness.\nLogs: all clear.  ";
    await s.emit("input", { text, source });
    assert.equal(await eligibleId(s), undefined, "queued input is not delivered");
    const paused = structuredClone(s.latest());
    await recover(s, "answer", "fabricated");
    assert.deepEqual(s.latest(), paused);
    await s.emit("message_end", { message: { role: "user", content: [{ type: "text", text }] } });
    const id = await eligibleId(s);
    assert.ok(id);
    assert.ok(!JSON.stringify(s.mock.entries).includes(id), "authority must never persist");
    const result = await recover(s, "answer", id);
    assert.equal(result.terminate, undefined);
    assert.equal(s.latest().negotiation?.phase, "revising");
    assert.deepEqual(s.latest().negotiation?.userAnswers, [text]);
    assert.match(resultText(result), /not independent automated verification/u);
    assert.equal(s.mock.sentUserMessages.length, 0);
    const recovered = structuredClone(s.latest());
    await recover(s, "answer", id);
    assert.deepEqual(s.latest(), recovered, "reply IDs are single use");
  });

test("clarification is discussion until explicitly consumed by the model", async () => {
  const s = await userPause();
  await submit(s);
  const saved = structuredClone(s.latest());
  await deliver(s, "What does readiness mean?");
  const text = await guidance(s);
  assert.match(text, /Answer clarification normally/u);
  assert.match(text, /clarification alone is not recovery/u);
  await s.emit("agent_start", {});
  await s.emit("agent_settled", { aborted: false });
  assert.deepEqual(s.latest(), saved);
  assert.equal(s.sessions.prompts.length, 1);
  assert.equal(s.selects.length, 0);
});

for (const kind of ["extension", "ambiguous", "replacement", "reload", "navigation", "shutdown", "image"] as const)
  test(`answer authority fails closed after ${kind}`, async () => {
    const s = await userPause();
    await submit(s);
    await deliver(s, "Yes");
    const old = await eligibleId(s);
    assert.ok(old);
    if (kind === "extension") await deliver(s, "Injected", "extension");
    if (kind === "ambiguous") {
      await s.emit("input", { text: "Same", source: "interactive" });
      await deliver(s, "Same", "extension");
    }
    if (kind === "replacement") await deliver(s, "New answer");
    if (kind === "reload") await s.emit("session_start", { reason: "reload" });
    if (kind === "navigation") await s.emit("session_tree", {});
    if (kind === "shutdown") {
      await s.emit("session_shutdown", {});
      await s.emit("session_start", { reason: "reload" });
    }
    if (kind === "image")
      await s.emit("message_end", {
        message: { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      });
    const saved = structuredClone(s.latest());
    assert.notEqual(await eligibleId(s), old);
    await recover(s, "answer", old);
    assert.deepEqual(s.latest(), saved);
    if (kind !== "replacement") assert.equal(await eligibleId(s), undefined);
  });

for (const action of ["retry", "extend"] as const) {
  for (const choice of [undefined, "Discuss first"] as const)
    test(`${action} cancellation ${choice} preserves the entire pause`, async () => {
      const s = await setup({
        completionMaxRevisions: 0,
        script: () => ({ reply: action === "retry" ? "invalid" : decision("changes_requested") }),
      });
      await submit(s);
      const saved = structuredClone(s.latest());
      (s.context.ctx as any).ui.select = async () => choice;
      assert.equal((await recover(s, action)).terminate, true);
      assert.deepEqual(s.latest(), saved);
      assert.equal(s.sessions.prompts.length, 1);
      assert.equal(s.mock.sentUserMessages.length, 0);
    });
  test(`${action} without UI cannot authorize recovery`, async () => {
    const s = await setup({
      hasUI: false,
      completionMaxRevisions: 0,
      script: () => ({ reply: action === "retry" ? "invalid" : decision("changes_requested") }),
    });
    await submit(s);
    const saved = structuredClone(s.latest());
    assert.match(resultText(await recover(s, action)), /No UI/u);
    assert.deepEqual(s.latest(), saved);
    assert.equal(s.selects.length, 0);
  });
}

test("explicit UI extension authorizes exactly one extra cycle without resetting budget", async () => {
  const s = await setup({
    completionMaxRevisions: 0,
    script: () => ({ reply: decision("changes_requested") }),
    select: [undefined, "Allow one more attempt"],
  });
  await submit(s);
  const n = structuredClone(s.latest().negotiation!);
  const result = await recover(s, "extend");
  assert.equal(result.terminate, undefined);
  assert.equal(s.latest().negotiation?.revisionAuthorized, true);
  assert.equal(s.latest().negotiation?.attempts, n.attempts);
  assert.equal(s.latest().negotiation?.reviewCostUsd, n.reviewCostUsd);
  await submit(s, { responses: [{ id: "F1", status: "addressed", response: "Fixed." }] });
  assert.equal(s.latest().negotiation?.phase, "paused");
  assert.equal(s.latest().negotiation?.revisionsUsed, 1);
  assert.equal(s.latest().negotiation?.revisionAuthorized, false);
  assert.equal(s.latest().negotiation?.maxRevisions, 0);
  await submit(s);
  assert.equal(s.sessions.prompts.length, 2);
  assert.equal(s.mock.sentUserMessages.length, 0);
});

for (const reason of ["failure", "exhausted"] as const)
  test(`new ${reason} automatically asks once, never on paused calls or restoration`, async () => {
    const s = await setup({
      completionMaxRevisions: 0,
      script: () => ({ reply: reason === "failure" ? "invalid" : decision("changes_requested") }),
    });
    await submit(s);
    assert.equal(s.selects.length, 1);
    assert.deepEqual(s.selects[0].options, [
      reason === "failure" ? "Retry review" : "Allow one more attempt",
      "Discuss first",
      "Finish without review",
      "Stop implementation",
    ]);
    await submit(s);
    await s.emit("agent_settled", { aborted: false });
    await s.emit("session_start", { reason: "reload" });
    await s.emit("session_tree", {});
    await submit(s);
    assert.equal(s.selects.length, 1);
    assert.equal(s.sessions.prompts.length, 1);
  });

test("automatic retry preserves the saved report, cost and nonterminating current turn", async () => {
  let calls = 0;
  const s = await setup({
    script: () => ({ reply: ++calls === 1 ? "invalid" : decision() }),
    select: ["Retry review"],
  });
  const first = await submit(s);
  assert.equal(first.terminate, undefined);
  assert.equal(s.latest().negotiation?.phase, "implementing");
  assert.equal(s.sessions.prompts.length, 1, "authorization itself must not spend");
  const accepted = await submit(s, { report: "Replacement", verification: "Replacement", concerns: "Replacement" });
  assert.equal(accepted.details.report, completion.report);
  assert.equal(accepted.details.verification, completion.verification);
  assert.equal(accepted.details.concerns, completion.concerns);
  assert.equal(accepted.details.completion, "accepted");
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.1);
  assert.equal(s.latest().negotiation?.revisionsUsed, 0);
  assert.equal(s.mock.sentUserMessages.length, 0);
});

test("aborted review suppresses automatic recovery UI", async () => {
  const s = await setup({ script: () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = submit(s, {}, controller.signal);
  await vi.waitFor(() => assert.equal(s.sessions.prompts.length, 1));
  controller.abort();
  assert.equal((await pending).terminate, true);
  assert.equal(s.selects.length, 0);
  assert.equal(s.latest().negotiation?.phase, "paused");
});

for (const interruption of ["navigation", "abort"] as const)
  test(`stale recovery selection after ${interruption} cannot mutate or continue`, async () => {
    const s = await setup({ script: () => ({ reply: "invalid" }) });
    await submit(s);
    let resolve!: (value: string) => void;
    (s.context.ctx as any).ui.select = () =>
      new Promise((done) => {
        resolve = done;
      });
    const controller = new AbortController();
    const pending = recover(s, "retry", undefined, controller.signal);
    await vi.waitFor(() => assert.equal(typeof resolve, "function"));
    if (interruption === "navigation") await s.emit("session_tree", {});
    else controller.abort();
    const saved = structuredClone(s.latest());
    resolve("Retry review");
    await pending;
    assert.deepEqual(s.latest(), saved);
    assert.equal(s.mock.sentUserMessages.length, 0);
  });

for (const action of ["stop", "accept"] as const)
  test(`model ${action} requires confirmation and preserves honest final labeling`, async () => {
    const s = await setup({
      returnTo: "planning",
      script: () => ({
        reply: decision("user_needed", {
          question: "Manual check?",
          recommendation: "Ask user.",
          limitations: ["Not independently verified."],
        }),
      }),
    });
    await submit(s);
    const saved = structuredClone(s.latest());
    assert.equal((await recover(s, action)).terminate, true);
    assert.deepEqual(s.latest(), saved);
    const positive = action === "stop" ? "Stop implementation" : "Finish without review";
    (s.context.ctx as any).ui.select = async (title: string, choices: string[]) => {
      assert.equal(title, action === "stop" ? "Stop implementation?" : "Finish without planner acceptance?");
      assert.deepEqual(choices, [positive, action === "stop" ? "Keep working" : "Keep paused"]);
      return positive;
    };
    const result = await recover(s, action);
    assert.equal(result.details.completion, action === "stop" ? "stopped" : "user_override");
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details.decision.limitations, ["Not independently verified."]);
    assert.equal(s.latest().active, false);
    assert.equal(s.mock.sentUserMessages.length, 0);
    if (action === "stop") {
      assert.equal(s.latest().pendingReturn, undefined);
      assert.equal(s.mock.setModels.length, 0);
    } else {
      assert.equal(s.mock.setModels.length, 1);
      assert.equal(result.details.returnedTo, opus.name);
      await assertCompletedInPlace(s);
    }
  });

test("bare command shows active status, paused choices and retains explicit compatibility validation", async () => {
  const s = await userPause();
  await command(s, "");
  assert.equal(s.selects.length, 0);
  assert.match(s.context.notifications.at(-1)?.message ?? "", /idle; completion has not been confirmed/u);
  await submit(s);
  await command(s, "");
  assert.deepEqual(s.selects.at(-1)?.options, ["Answer in chat", "Finish without review", "Stop implementation"]);
  const saved = structuredClone(s.latest());
  for (const args of ["retry extra", "accept extra", "stop extra", "resume", "unknown"]) await command(s, args);
  assert.deepEqual(s.latest(), saved);
  await command(s, "resume Operator confirmed it");
  assert.deepEqual(s.latest().negotiation?.userAnswers, ["Operator confirmed it"]);
  assert.equal(s.mock.sentUserMessages.length, 1);
});

test("settled, not agent_end, publishes nontriggering idle/interrupted status; finalization suppresses it", async () => {
  const s = await setup();
  assert.ok(s.mock.messageRenderers.has(EXEC_STATUS_MESSAGE_TYPE));
  await s.emit("agent_start", {});
  assert.match(s.context.statuses.get(EXEC_STATUS_KEY) ?? "", /implementing/u);
  await s.emit("agent_end", {});
  assert.equal(statusMessages(s).length, 0);
  await s.emit("agent_settled", { aborted: false });
  const idle = statusMessages(s).at(-1);
  assert.ok(idle);
  assert.match((idle.message as { content: string }).content, /idle; completion has not been confirmed/u);
  assert.deepEqual(statusMessages(s).at(-1)?.options, { triggerTurn: false });
  await s.emit("agent_start", {});
  await s.emit("agent_settled", { aborted: true });
  const interrupted = statusMessages(s).at(-1);
  assert.ok(interrupted);
  assert.match((interrupted.message as { content: string }).content, /was interrupted/u);
  await submit(s);
  const count = statusMessages(s).length;
  await s.emit("agent_settled", { aborted: false });
  assert.equal(statusMessages(s).length, count);
});

test("pause status is not duplicated in its run but reappears after discussion moves it out of view", async () => {
  const s = await userPause();
  await s.emit("agent_start", {});
  await submit(s);
  assert.match(s.context.statuses.get(EXEC_STATUS_KEY) ?? "", /waiting for answer/u);
  await s.emit("agent_settled", { aborted: false });
  assert.equal(statusMessages(s).length, 0);
  await s.emit("agent_start", {});
  await s.emit("agent_settled", { aborted: false });
  assert.equal(statusMessages(s).length, 1);
  assert.match((statusMessages(s)[0].message as any).content, /Waiting for your answer/u);
  assert.match((statusMessages(s)[0].message as any).content, /Did the manual check pass\?/u);
});

test("wrong-phase actions and conversational retry requests grant no authority", async () => {
  const s = await setup();
  const saved = structuredClone(s.latest());
  for (const action of ["answer", "retry", "extend", "accept"]) await recover(s, action, "invented");
  assert.deepEqual(s.latest(), saved);
  assert.equal(s.selects.length, 0);
  const failed = await setup({ script: () => ({ reply: "invalid" }) });
  await submit(failed);
  const paused = structuredClone(failed.latest());
  await deliver(failed, "Retry and finish without review if it fails again");
  await guidance(failed);
  await recover(failed, "answer", "invented");
  await recover(failed, "extend");
  assert.deepEqual(failed.latest(), paused);
  assert.equal(failed.selects.length, 1);
});

for (const action of ["stop", "accept"] as const)
  test(`no-UI model ${action} leaves state unchanged`, async () => {
    const s = await setup({ hasUI: false, script: () => ({ reply: "invalid" }) });
    await submit(s);
    const saved = structuredClone(s.latest());
    assert.match(resultText(await recover(s, action)), /UI confirmation is required/u);
    assert.deepEqual(s.latest(), saved);
  });

test("an older pause answer cannot authorize a later reviewer question", async () => {
  const s = await userPause();
  await submit(s);
  await deliver(s, "Yes");
  const old = await eligibleId(s);
  assert.ok(old);
  await recover(s, "answer", old);
  await submit(s);
  const saved = structuredClone(s.latest());
  assert.equal(await eligibleId(s), undefined);
  await recover(s, "answer", old);
  assert.deepEqual(s.latest(), saved);
});

for (const outcome of ["throw", "cancel", "positive", "navigate"] as const)
  test(`dialog blocked hold releases exactly once on ${outcome}`, async () => {
    const s = await setup({ script: () => ({ reply: "invalid" }) });
    await submit(s);
    const holds: any[] = [];
    s.mock.rawPi.events.on("herdr:blocked", (data) => holds.push(data));
    (s.context.ctx as any).ui.select = async () => {
      if (outcome === "throw") throw new Error("UI unavailable");
      if (outcome === "navigate") await s.emit("session_tree", {});
      return outcome === "positive" || outcome === "navigate" ? "Retry review" : undefined;
    };
    await recover(s, "retry");
    assert.equal(holds.length, 2);
    assert.equal(holds[0].active, true);
    assert.deepEqual(holds[1], { active: false });
    assert.equal(s.latest().negotiation?.phase, outcome === "positive" ? "implementing" : "paused");
  });

test("automatic extension returns control without spending or resetting counters", async () => {
  const s = await setup({
    completionMaxRevisions: 0,
    script: () => ({ reply: decision("changes_requested") }),
    select: ["Allow one more attempt"],
  });
  const result = await submit(s);
  assert.equal(result.terminate, undefined);
  assert.equal(s.latest().negotiation?.phase, "revising");
  assert.equal(s.latest().negotiation?.revisionAuthorized, true);
  assert.equal(s.latest().negotiation?.attempts, 1);
  assert.equal(s.latest().negotiation?.reviewCostUsd, 0.05);
  assert.equal(s.sessions.prompts.length, 1);
  assert.equal(s.mock.sentUserMessages.length, 0);
});

for (const exhausted of [false, true])
  test(`paused footer distinguishes ${exhausted ? "approval needed" : "review failed"}`, async () => {
    const s = await setup({
      completionMaxRevisions: 0,
      script: () => ({ reply: exhausted ? decision("changes_requested") : "invalid" }),
    });
    await submit(s);
    assert.ok(s.context.statuses.get(EXEC_STATUS_KEY)?.includes(exhausted ? "approval needed" : "review failed"));
  });
