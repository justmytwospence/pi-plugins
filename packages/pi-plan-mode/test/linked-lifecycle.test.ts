import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBeforeSettleEventResult,
  type ExtensionCommandContext,
  type ExtensionToolContext,
  initTheme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as usage from "@justmytwospence/pi-subscription-usage";
import { onTestFinished, test, vi } from "vitest";
import { APPROVE, CONTEXT_COMPACT, CONTEXT_FRESH, CONTEXT_KEEP } from "../src/approval-picker.js";
import { EXEC_ENTRY, type ExecState } from "../src/exec.js";
import { FAMILY_CHANNEL, type FamilyMembership, type FamilyRequest } from "../src/family-contract.js";
import {
  FLOW_CHANNEL,
  FLOW_ENTRY,
  type FlowRequest,
  type FlowSnapshot,
  type FlowTransitionResult,
  type FlowWorkflow,
  queryFlow,
  requestReplan,
} from "../src/flow-contract.js";
import { FRESH_HANDOFF_CHANNEL, type FreshHandoffRequest } from "../src/fresh-handoff.js";
import type { pickImplementationEffort } from "../src/implementation-effort.js";
import planMode from "../src/index.js";
import { ENTER_TOOL, EXIT_TOOL, INLINE_ENTRY, MODE_CHANGED, MODE_SET } from "../src/inline-plan.js";
import { finishReview, outstanding, reviseNegotiationPlan, startReview } from "../src/negotiation.js";
import * as plannerSessions from "../src/planner/session.js";
import type { PlanModeSettings } from "../src/settings.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");

const GENERAL = { provider: "test", id: "general", name: "General", reasoning: true };
// Deliberately identical planner/worker: model inequality is not execution intent.
const WORKER = { provider: "test", id: "sol", name: "Sol", reasoning: true };
const OTHER = { provider: "other", id: "override", name: "Other model", reasoning: true };
const KEEP = CONTEXT_KEEP;
const COMPACT = CONTEXT_COMPACT;
const LINKED_FRESH = CONTEXT_FRESH;
const PLANNER = { provider: "test", id: "planner", name: "Planner", reasoning: true };
const PLAN = "# Linked lifecycle\n\n1. Implement the approved change.\n";
const CYCLE = ["work", "chat", "plan"];
type MockPi = ReturnType<typeof createMockPi>;
type WorkflowRequest = Extract<FlowRequest, { kind: "workflow" }>;
type ExecutionRequest = Extract<FlowRequest, { kind: "execution" }>;
type InlineState = { active: boolean; planFile?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Protocol fake, not a model guard: only this coordinator mutates the fake model. */
function coordinator(mock: MockPi, ctx: ExtensionCommandContext, planner = WORKER, thinkingPinned?: true) {
  const state: FlowSnapshot = {
    version: 1,
    operatingMode: "linked",
    revision: 7,
    selectedFlow: {
      provider: WORKER.provider,
      anchorModel: GENERAL.id,
      roles: {
        work: { provider: GENERAL.provider, modelId: GENERAL.id },
        chat: { provider: GENERAL.provider, modelId: GENERAL.id },
        plan: { provider: planner.provider, modelId: planner.id },
        exec: {
          provider: WORKER.provider,
          modelId: WORKER.id,
          suggestedThinking: "medium",
          ...(thinkingPinned ? { thinkingPinned } : {}),
        },
      },
    },
    workflow: "work",
    ready: true,
    guardAvailable: true,
    transitioning: false,
  };
  const workflows: WorkflowRequest[] = [];
  const executions: ExecutionRequest[] = [];
  const commits: ExecutionRequest[] = [];
  const attempts: FlowWorkflow[] = [];
  const activated: FlowWorkflow[] = [];
  const legacyRequests: unknown[] = [];
  const publications: Array<{ event: { active: boolean; replanning?: boolean }; snapshot: FlowSnapshot }> = [];
  const snapshot = () => structuredClone(state);
  const result = (error?: string): FlowTransitionResult => ({
    ok: !error,
    snapshot: snapshot(),
    ...(error ? { error } : {}),
  });
  let activate = async (_workflow: FlowWorkflow) => true;

  const transition = async (request: WorkflowRequest | ExecutionRequest): Promise<FlowTransitionResult> => {
    const revision = request.kind === "execution" ? request.expectedRevision : state.revision;
    const manager = ctx.sessionManager;
    const session = manager.getSessionId();
    const current = () =>
      state.revision === revision &&
      ctx.sessionManager === manager &&
      manager.getSessionId() === session &&
      !ctx.signal?.aborted;
    if (!current()) return result("Stale linked transition.");
    const workflow =
      request.kind === "workflow"
        ? request.workflow
        : request.phase === "replan"
          ? "plan"
          : request.phase === "begin" || request.phase === "resume"
            ? "exec"
            : "work";
    state.transitioning = true;
    attempts.push(workflow);
    try {
      const ok = await activate(workflow);
      // The async activation result must never commit into a newer selection/session.
      if (!current()) return result("Stale linked transition.");
      if (!ok) return result("Assigned model unavailable.");
      ctx.model = (
        workflow === "plan" ? planner : workflow === "exec" ? WORKER : GENERAL
      ) as ExtensionCommandContext["model"];
      activated.push(workflow);
      // The real gate stages its lifecycle destination before the owner publishes synchronously.
      state.workflow = workflow;
      if (request.kind === "execution") {
        if (request.phase === "replan") state.replanning = true;
        else delete state.replanning;
        if (
          (request.phase === "begin" || request.phase === "resume") &&
          request.effort?.thinkingLevel &&
          request.effort.thinkingLevel !== mock.thinkingLevel
        )
          mock.rawPi.setThinkingLevel(request.effort.thinkingLevel as never);
        const returned = request.commit();
        assert.equal(returned, undefined, "lifecycle commit must be synchronous");
        commits.push(request);
      }
      mock.eventBus.emit(MODE_CHANGED, { mode: workflow, cycle: CYCLE, source: "transition" });
      return result();
    } finally {
      state.transitioning = false;
    }
  };

  mock.eventBus.on(FLOW_CHANNEL, (data) => {
    const request = data as FlowRequest;
    if (request.kind === "query") request.snapshot = snapshot();
    else if (request.kind === "workflow") {
      workflows.push(request);
      // EventBus.emit does not await listeners: assign the Promise before returning.
      request.result = transition(request);
    } else if (request.kind === "execution") {
      executions.push(request);
      request.result = transition(request);
    }
  });
  mock.eventBus.on("workflow-mode:query", (data) => {
    (data as { reply(value: unknown): void }).reply({ mode: state.workflow, cycle: CYCLE });
  });
  mock.eventBus.on(MODE_SET, (data) => legacyRequests.push(data));
  mock.eventBus.on("workflow-mode:exec", (data) => {
    const event = data as { active: boolean; replanning?: boolean };
    publications.push({ event: structuredClone(event), snapshot: snapshot() });
  });
  return {
    snapshot,
    workflows,
    executions,
    commits,
    attempts,
    activated,
    legacyRequests,
    publications,
    independent: () => {
      state.operatingMode = "independent";
      state.revision++;
    },
    activation: (fn: typeof activate) => {
      activate = fn;
    },
    revise: () => {
      state.revision++;
    },
  };
}

async function fixture(
  options: {
    choice?: string;
    distinctModels?: boolean;
    planners?: boolean;
    thinkingLevel?: "high" | "off";
    thinkingPinned?: true;
    fresh?: boolean;
    settings?: Partial<PlanModeSettings>;
    pickImplementationEffort?: typeof pickImplementationEffort;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "linked-plan-lifecycle-"));
  const mock = createMockPi({
    activeTools: ["read", "write", "edit", "bash"],
    thinkingLevel: options.thinkingLevel ?? "high",
  });
  const seedDirectory = vi.spyOn(plannerSessions, "plannerSessionDir").mockReturnValue(join(directory, "planners"));
  let session = "linked-parent";
  let onBranch = true;
  let app: ReturnType<typeof createCustomSelectorHarness> | undefined;
  const selections: Array<{ title: string; choices: string[] }> = [];
  let select = async (title: string, choices: string[]): Promise<string | undefined> => {
    const choice = options.choice ?? KEEP;
    if (title === "Implementation effort") return choices[0];
    if (choices.includes(CONTEXT_KEEP)) {
      return choice;
    }
    if (choices.includes(APPROVE)) {
      if (choice !== KEEP && choices.includes(`Context: ${KEEP}`)) return `Context: ${KEEP}`;
      return APPROVE;
    }
    return undefined;
  };
  const context = createMockContext({
    cwd: directory,
    mode: options.planners ? "tui" : "rpc",
    hasUI: true,
    model: GENERAL,
    ...(options.planners
      ? {
          custom: (factory: unknown) => {
            app = createCustomSelectorHarness(factory, 140, undefined, 40);
            return app.resultPromise;
          },
        }
      : {
          select: (title: string, choices: string[]) => {
            selections.push({ title, choices });
            assert.ok(selections.length < 100, `Unexpected repeated RPC dialog: ${title}: ${choices.join(", ")}`);
            return select(title, choices);
          },
        }),
    modelRegistry: {
      getAvailable: () => [GENERAL, WORKER, OTHER, PLANNER],
      getAll: () => [GENERAL, WORKER, OTHER, PLANNER],
      find: (provider: string, id: string) =>
        [GENERAL, WORKER, OTHER, PLANNER].find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: async () => ({ ok: false, error: "No network in lifecycle tests" }),
      isUsingOAuth: () => false,
    },
    sessionManager: {
      getSessionId: () => session,
      getSessionFile: () => join(directory, "parent.jsonl"),
      getLeafId: () => "planning-leaf",
      getBranch: () =>
        onBranch
          ? [
              { type: "message", id: "planning-leaf" },
              ...mock.entries.map((entry, index) => ({ type: "custom", id: `entry-${index}`, ...entry })),
            ]
          : [],
      getEntries: () => [],
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "Plan the change.", timestamp: 1 }] }),
    },
  });
  const ctx = context.ctx as ExtensionCommandContext;
  const flow = coordinator(mock, ctx, options.distinctModels ? PLANNER : WORKER, options.thinkingPinned);
  const freshRequests: FreshHandoffRequest[] = [];
  const freshJobs: Array<() => Promise<void>> = [];
  let freshAvailable = options.fresh === true;
  mock.eventBus.on(FRESH_HANDOFF_CHANNEL, (data) => {
    const request = data as FreshHandoffRequest;
    freshRequests.push(request);
    if (!freshAvailable) return;
    request.schedule = (run) => {
      if (!request.isCurrent()) return false;
      freshJobs.push(() =>
        run((options) => (request.isCurrent() ? ctx.newSession(options) : Promise.resolve({ cancelled: true }))),
      );
      return true;
    };
  });
  const setModel = vi.fn(async () => {
    throw new Error("Unprivileged pi.setModel must never be used in Linked.");
  });
  mock.rawPi.setModel = setModel;
  const approvals: unknown[] = [];
  const execPublications: Array<{ active: boolean; replanning?: boolean; source: string }> = [];
  mock.eventBus.on("permission-mode:set", (data) => approvals.push(data));
  mock.eventBus.on("workflow-mode:exec", (data) => execPublications.push(data as (typeof execPublications)[number]));
  const emit = async (name: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
    let result: unknown;
    for (const handler of mock.events.get(name) ?? [])
      result = (await handler({ type: name, ...payload }, ctx)) ?? result;
    return result;
  };
  onTestFinished(async () => {
    await emit("session_shutdown");
    seedDirectory.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });
  const createSession = vi.fn(async () => {
    throw new Error("Lifecycle tests must not start a real planner session.");
  });
  await planMode(mock.pi, {
    pickImplementationEffort:
      options.pickImplementationEffort ?? (async () => ({ kind: "fallback", reason: "classifier unavailable" })),
    readSettings: async () => ({
      thinkingLevel: "inherit",
      jevToolSelection: false,
      plansDirectory: directory,
      defaultImplementationContext: "keep",
      completionReview: false,
      // An available free target must still not leak into Linked choices.
      implementationModelMap: { "test/sol": [{ provider: OTHER.provider, modelId: OTHER.id }] },
      ...options.settings,
    }),
    createSession,
  });
  if (options.planners) {
    mock.entries.push({
      customType: "plan-run",
      data: {
        id: "linked-planners",
        createdAt: 1,
        task: "Approved task",
        state: "active",
        planners: [{ id: "A", spec: "test/sol:high", name: WORKER.name, plan: PLAN, revision: 1 }],
      },
    });
  }
  await emit("session_start", { reason: "startup" });
  const inline = () =>
    mock.entries.filter((entry) => entry.customType === INLINE_ENTRY).at(-1)?.data as InlineState | undefined;
  const tool = (name: string, params: Record<string, unknown> = {}) => {
    const definition = mock.tools.find((candidate) => candidate.name === name) as unknown as ToolDefinition;
    assert.ok(definition, `Missing tool ${name}`);
    return definition.execute(
      name,
      params,
      undefined,
      undefined,
      ctx as ExtensionCommandContext & ExtensionToolContext,
    );
  };
  const enter = async () => {
    const command = mock.commands.get("plan");
    assert.ok(command);
    await command.handler("", ctx);
  };
  const plan = async () => {
    await enter();
    const file = inline()?.planFile;
    assert.ok(file);
    writeFileSync(file, PLAN);
  };
  const guard = async () => {
    const result = (await emit("tool_call", {
      toolName: "write",
      input: { path: join(directory, "source.ts"), content: "change" },
    })) as { block?: boolean } | undefined;
    return result?.block === true;
  };
  type BoundaryEntry = NonNullable<AgentBeforeSettleEventResult["entries"]>[number];
  const boundaryEntries: BoundaryEntry[] = [];
  const settle = async (
    outcome = "completed",
    proposals: BoundaryEntry[] = [],
  ): Promise<AgentBeforeSettleEventResult | undefined> => {
    // Pi passes accumulated proposals to each handler, and commits the final returned entries.
    let entries = proposals;
    let result: AgentBeforeSettleEventResult | undefined;
    for (const handler of mock.events.get("agent_before_settle") ?? []) {
      const next = (await handler({ type: "agent_before_settle", outcome, entries }, ctx)) as
        | AgentBeforeSettleEventResult
        | undefined;
      if (next) {
        result = next;
        entries = next.entries ?? entries;
      }
    }
    boundaryEntries.push(...entries);
    for (const entry of entries) {
      if (entry.type === "custom")
        mock.entries.push({ customType: entry.customType, data: structuredClone(entry.data) });
    }
    return result;
  };
  const execution = () => mock.entries.filter((entry) => entry.customType === EXEC_ENTRY).at(-1)?.data as ExecState;
  const assertNoExec = () => {
    assert.equal(
      execPublications.some((event) => event.active && event.source === "transition"),
      false,
    );
    assert.equal(
      mock.entries.some((entry) => entry.customType === EXEC_ENTRY && (entry.data as ExecState).active),
      false,
    );
    assert.equal(flow.commits.length, 0);
    assert.equal(mock.sentUserMessages.length, 0);
  };
  const assertNoEscape = () => {
    assert.equal(setModel.mock.calls.length, 0, "only the coordinator may activate a linked model");
    assert.deepEqual(flow.legacyRequests, []);
    assert.equal(
      flow.workflows.some((request) => request.workflow === "work"),
      false,
      "no Plan -> Work -> Exec churn",
    );
    assert.deepEqual(approvals, [], "workflow linkage must not change approvals");
  };
  return {
    mock,
    context,
    ctx,
    flow,
    emit,
    inline,
    tool,
    enter,
    plan,
    guard,
    settle,
    execution,
    boundaryEntries,
    execPublications,
    selections,
    freshRequests,
    freshJobs,
    createSession,
    freshAvailable: (available: boolean) => {
      freshAvailable = available;
    },
    abandonBranch: () => {
      onBranch = false;
    },
    assertNoExec,
    assertNoEscape,
    select: (fn: typeof select) => {
      select = fn;
    },
    switchSession: () => {
      session = "new-session";
    },
    app: () => {
      assert.ok(app);
      return app;
    },
  };
}

async function executingFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  await f.plan();
  await f.tool(EXIT_TOOL);
  assert.equal((await f.settle())?.continue, true);
  assert.ok(f.execution().negotiation, "the first boundary record must include the durable execution identity");
  return f;
}

async function exhaustedFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await executingFixture(options);
  // Restore a real, previously paid task. No planner/network calls are permitted by the fixture.
  const saved = structuredClone(f.execution());
  const finding = { id: "F1", title: "Retain safety", detail: "Missing guard", requestedChange: "Keep the guard." };
  assert.ok(saved.negotiation);
  let negotiation = { ...saved.negotiation, maxRevisions: 1 };
  for (let round = 0; round < 2; round++) {
    negotiation = finishReview(
      startReview(
        negotiation,
        { report: `Attempt ${round + 1}`, verification: "Focused tests", concerns: "Guard missing" },
        round ? [{ id: "F1", status: "addressed", response: "Added guard." }] : [],
      ),
      {
        decision: {
          outcome: "changes_requested",
          summary: "Keep revising",
          evidence: ["Guard missing"],
          limitations: ["Offline fixture"],
          findings: [finding],
        },
        costUsd: 0.04,
      },
    );
  }
  negotiation.userAnswers = ["Retain the original safety boundary."];
  saved.negotiation = negotiation;
  saved.asks = 3;
  saved.costUsd = 0.12;
  const touchedFile = join(f.ctx.cwd, "source.ts");
  writeFileSync(touchedFile, "unfinished implementation\n");
  saved.touched = [touchedFile];
  saved.pendingQuestion = {
    id: "postponed",
    questions: [
      {
        id: "account",
        header: "Account",
        question: "Which account?",
        options: [
          { label: "Staging", description: "Use the test account." },
          { label: "Production", description: "Use the live account." },
        ],
      },
    ],
    implementerMessage: "Need an account.",
  };
  f.mock.entries.push({ customType: EXEC_ENTRY, data: saved });
  await f.emit("session_tree");
  return { ...f, saved: structuredClone(saved), touchedFile };
}

for (const distinctModels of [false, true]) {
  for (const choice of [KEEP, COMPACT]) {
    test(`real owner Plan → Exec → Plan → Exec retains the ${distinctModels ? "distinct" : "same"}-model task with ${choice}`, async () => {
      const f = await exhaustedFixture({ distinctModels, choice, fresh: true });
      const approvedFile = f.saved.planFile;
      const approvedPlan = readFileSync(approvedFile, "utf8");
      await f.enter();
      const suspended = structuredClone(f.execution());
      const draft = suspended.replanning?.draftFile;
      assert.ok(draft);
      assert.notEqual(draft, approvedFile);
      assert.equal(suspended.active, true);
      assert.equal(suspended.planFile, approvedFile, "the old approval is retained, not edited in place");
      assert.deepEqual(suspended.negotiation, f.saved.negotiation);
      assert.deepEqual(suspended.pendingQuestion, f.saved.pendingQuestion);
      assert.match(readFileSync(draft, "utf8"), /F1: Retain safety[\s\S]*Which account\?/u);
      assert.equal(f.inline()?.planFile, draft);
      assert.equal(f.flow.snapshot().workflow, "plan");
      assert.equal(f.flow.snapshot().replanning, true);
      assert.equal(f.ctx.model?.id, distinctModels ? PLANNER.id : WORKER.id);
      assert.equal(await f.guard(), true);
      assert.match(f.context.statuses.get("plan-exec") ?? "", /replanning/u);
      const replan = f.flow.executions.at(-1);
      assert.equal(replan?.phase, "replan");
      assert.equal(replan?.planFile, approvedFile);
      assert.equal(replan?.expectedExecutionId, f.saved.negotiation?.executionId);
      assert.equal(replan?.expectedPlanRevision, 1);
      assert.notEqual(
        (
          (await f.emit("tool_call", { toolName: "write", input: { path: draft, content: "draft" } })) as
            | { block?: boolean }
            | undefined
        )?.block,
        true,
      );
      assert.equal(
        (
          (await f.emit("tool_call", { toolName: "write", input: { path: approvedFile, content: "unapproved" } })) as {
            block?: boolean;
          }
        )?.block,
        true,
      );
      for (const name of ["ask_planner", "finish_plan", "continue_plan"]) {
        const result = await f.tool(
          name,
          name === "finish_plan" ? { report: "Done", verification: "Tests", concerns: "None" } : {},
        );
        assert.match(JSON.stringify(result.content), /paused while the plan is revised/u);
      }
      const revised = "# Revised lifecycle\n\nKeep the guard and existing changes.\n";
      writeFileSync(draft, revised);
      assert.equal(readFileSync(approvedFile, "utf8"), approvedPlan);
      f.selections.length = 0;
      let contextSelected = false;
      f.select(async (title, choices) => {
        if (title === "Implementation effort") return choices[0];
        if (choices.includes(CONTEXT_KEEP)) {
          assert.deepEqual(
            new Set(choices),
            new Set([CONTEXT_KEEP, CONTEXT_COMPACT]),
            "resume has no fresh context option",
          );
          contextSelected = true;
          return choice;
        }
        if (!contextSelected) return choices.find((label) => label.startsWith("Context:"));
        return APPROVE;
      });
      const approval = await f.tool(EXIT_TOOL);
      assert.equal((approval.details as { outcome: string }).outcome, "handoff");
      assert.equal(f.flow.snapshot().workflow, "plan", "approval waits for the successful turn boundary");
      const boundary = await f.settle();
      assert.equal(boundary?.continue, true);
      assert.equal(
        boundary?.entries?.filter((entry) => entry.type === "compaction").length,
        choice === COMPACT ? 1 : 0,
      );
      const resumed = f.execution();
      assert.equal(resumed.active, true);
      assert.equal(resumed.planFile, draft);
      assert.equal(resumed.replanning, undefined);
      assert.equal(resumed.implementerModel, "test/sol");
      assert.ok(resumed.negotiation);
      assert.ok(f.saved.negotiation);
      assert.deepEqual(resumed.negotiation, reviseNegotiationPlan(f.saved.negotiation));
      assert.deepEqual(outstanding(resumed.negotiation), outstanding(f.saved.negotiation));
      assert.equal(resumed.asks, f.saved.asks);
      assert.equal(resumed.costUsd, f.saved.costUsd);
      assert.deepEqual(resumed.touched, f.saved.touched);
      assert.deepEqual(resumed.pendingQuestion, f.saved.pendingQuestion);
      assert.notEqual(
        resumed.planner?.sessionFile,
        f.saved.planner?.sessionFile,
        "seed a new consultant from revised history",
      );
      assert.equal(readFileSync(f.touchedFile, "utf8"), "unfinished implementation\n");
      assert.equal(readFileSync(approvedFile, "utf8"), approvedPlan);
      assert.equal(f.flow.snapshot().workflow, "exec");
      assert.equal(f.flow.snapshot().replanning, undefined);
      assert.equal(f.ctx.model?.id, WORKER.id);
      assert.deepEqual(
        f.flow.executions.map((request) => request.phase),
        ["begin", "replan", "resume"],
      );
      assert.equal(f.flow.executions.at(-1)?.expectedExecutionId, f.saved.negotiation?.executionId);
      assert.equal(f.flow.executions.at(-1)?.expectedPlanRevision, 1);
      assert.equal(f.flow.executions.at(-1)?.planFile, draft);
      const publications = f.flow.publications.filter(({ event }) => event.active);
      assert.ok(
        publications.some(
          ({ event, snapshot }) => event.replanning && snapshot.workflow === "plan" && snapshot.replanning,
        ),
      );
      assert.ok(
        publications.every(({ event, snapshot }) => snapshot.workflow === (event.replanning ? "plan" : "exec")),
        "publication never exposes an intermediate Work tuple",
      );
      assert.equal(
        f.selections.some(({ choices }) => choices.includes(CONTEXT_FRESH)),
        false,
        "an unfinished task cannot move to a fresh child",
      );
      assert.equal(f.freshJobs.length, 0);
      assert.equal(f.createSession.mock.calls.length, 0, "reapproval neither calls the planner nor retries paid work");
      assert.match(
        JSON.stringify(boundary?.entries),
        /Existing review recovery or the unanswered planner question remains required/u,
      );
      assert.equal(
        f.mock.sentMessages.some(
          ({ message }) => (message as { customType?: string }).customType === "plan-mode-finish",
        ),
        false,
      );
      assert.equal(await f.settle(), undefined);
      f.assertNoEscape();
    });
  }
}

for (const via of ["command", "tool"] as const) {
  for (const success of [true, false]) {
    test(`linked Plan ${via} entry awaits coordinator ${success ? "success" : "failure"}`, async () => {
      const f = await fixture();
      const activation = deferred<boolean>();
      const requested = deferred<void>();
      f.flow.activation(async () => {
        requested.resolve();
        return activation.promise;
      });
      const before = structuredClone(f.mock.entries);
      let completed = false;
      const entering = (via === "command" ? f.enter() : f.tool(ENTER_TOOL)).then(() => {
        completed = true;
      });
      await requested.promise;
      assert.ok(
        f.flow.workflows[0]?.result instanceof Promise,
        "result is assigned synchronously, not returned by emit",
      );
      const snapshot = queryFlow(f.mock.eventBus);
      assert.equal(snapshot?.workflow, "work");
      assert.equal(snapshot?.transitioning, true);
      assert.equal(completed, false);
      assert.notEqual(f.inline()?.active, true);
      assert.equal(await f.guard(), false);
      assert.deepEqual(f.mock.entries, before);
      activation.resolve(success);
      await entering;
      assert.equal(f.flow.snapshot().workflow, success ? "plan" : "work");
      assert.equal(f.inline()?.active === true, success);
      assert.equal(await f.guard(), success);
      assert.equal(f.ctx.model?.id, success ? WORKER.id : GENERAL.id);
      if (!success) {
        assert.deepEqual(f.mock.entries, before, "failure retains the old inline state");
        assert.match(f.context.notifications.at(-1)?.message ?? "", /unavailable/iu);
      }
      f.assertNoExec();
      f.assertNoEscape();
    });
  }
}

for (const choice of [KEEP, COMPACT]) {
  test(`same-model linked approval '${choice}' keeps Plan guarded until settle activates worker`, async () => {
    const f = await fixture({ choice });
    await f.plan();
    const approved = await f.tool(EXIT_TOOL);
    assert.equal((approved as { terminate?: boolean }).terminate, true);
    assert.equal((approved.details as { outcome: string }).outcome, "handoff");
    assert.deepEqual(f.selections[0]?.choices, [
      APPROVE,
      `Context: ${KEEP}`,
      "Edit the plan",
      "Save for later",
      "No, keep planning",
    ]);
    assert.match(f.selections[0]?.title ?? "", /test\/sol/u);
    assert.equal(f.ctx.model?.id, WORKER.id, "planner and worker intentionally share a physical model");
    assert.equal(f.inline()?.active, true);
    assert.equal(await f.guard(), true);
    assert.equal(f.flow.executions.length, 0);
    f.assertNoExec();
    await f.emit("agent_end");
    assert.equal(f.flow.executions.length, 0, "agent_end is not the execution boundary");

    const activation = deferred<boolean>();
    const requested = deferred<void>();
    f.flow.activation(async () => {
      requested.resolve();
      return activation.promise;
    });
    const settling = f.settle();
    await requested.promise;
    const request = f.flow.executions[0];
    assert.ok(request?.result instanceof Promise);
    assert.equal(request.phase, "begin");
    assert.equal(request.expectedRevision, f.flow.snapshot().revision);
    assert.equal(request.planFile, f.inline()?.planFile);
    assert.equal(f.inline()?.active, true);
    assert.equal(await f.guard(), true);
    f.assertNoExec();
    activation.resolve(true);
    const settled = await settling;
    assert.equal(settled?.continue, true);
    const entries = settled?.entries ?? [];
    assert.equal(entries.filter((entry) => entry.type === "compaction").length, choice === COMPACT ? 1 : 0);
    const record = entries.find((entry) => entry.type === "custom" && entry.customType === EXEC_ENTRY);
    assert.ok(record?.type === "custom");
    const exec = record.data as ExecState;
    assert.equal(exec.active, true);
    assert.equal(exec.implementerModel, "test/sol");
    assert.equal(exec.linkedFlow?.revision, request.expectedRevision);
    assert.deepEqual(exec.linkedFlow?.selectedFlow, f.flow.snapshot().selectedFlow);
    assert.equal(exec.planFile, request.planFile);
    assert.equal(readFileSync(exec.planFile, "utf8").trim(), PLAN.trim());
    assert.equal(f.inline()?.active, false);
    assert.equal(await f.guard(), false);
    assert.equal(f.flow.snapshot().workflow, "exec");
    assert.deepEqual(f.flow.activated, ["plan", "exec"]);
    assert.equal(f.flow.commits.length, 1);
    assert.equal(await f.settle(), undefined, "consume the approved handoff exactly once");
    assert.equal(f.flow.executions.length, 1);
    f.assertNoEscape();
  });
}

for (const manual of [false, true]) {
  test(`pinned linked approval skips judgment and retains ${manual ? "manual" : "configured"} provenance`, async () => {
    const picker = vi.fn<typeof pickImplementationEffort>();
    const pressure = vi.spyOn(usage, "readSelectionPressure");
    onTestFinished(() => pressure.mockRestore());
    const f = await fixture({ thinkingPinned: true, pickImplementationEffort: picker });
    f.select(async (title, choices) => (title === "Implementation effort" ? (manual ? "high" : choices[0]) : APPROVE));
    await f.plan();
    await f.tool(EXIT_TOOL);
    assert.equal(picker.mock.calls.length, 0);
    assert.equal(pressure.mock.calls.length, 0);
    assert.equal((await f.settle())?.continue, true);
    assert.deepEqual(f.flow.executions[0]?.effort, {
      provider: WORKER.provider,
      modelId: WORKER.id,
      thinkingLevel: manual ? "high" : "medium",
      source: manual ? "manual" : "configured",
    });
    f.assertNoEscape();
  });
}

for (const source of ["legacy", "default", "manual", "configured", "system1", "fallback"] as const) {
  test(`fresh Linked bootstrap preserves approved effort/source and legacy behavior: ${source}`, async () => {
    const picker = vi.fn<typeof pickImplementationEffort>();
    const f = await fixture({ pickImplementationEffort: picker });
    const expected = source === "default" ? undefined : "low";
    const effort = {
      provider: WORKER.provider,
      modelId: WORKER.id,
      ...(expected ? { thinkingLevel: expected } : {}),
      source: source === "default" ? "manual" : source,
    };
    f.mock.entries.push({
      customType: "plan-implementation-runtime",
      data: {
        model: `${WORKER.provider}/${WORKER.id}${expected ? `:${expected}` : ""}`,
        ...(source === "legacy" ? {} : { effort }),
        exec: {
          active: true,
          planFile: "/approved.md",
          implementer: WORKER.name,
          implementerModel: `${WORKER.provider}/${WORKER.id}`,
          linkedFlow: f.flow.snapshot(),
          asks: 0,
          costUsd: 0,
        },
      },
    });
    await f.emit("resources_discover");
    assert.equal(picker.mock.calls.length, 0, "fresh startup must not re-judge an approved tuple");
    assert.equal(f.flow.executions.length, 1);
    assert.deepEqual(f.flow.executions[0]?.effort, source === "legacy" ? undefined : effort);
    assert.equal(f.mock.thinkingLevel, source === "legacy" || source === "default" ? "high" : "low");
    const identity = f.execution().negotiation?.executionId;
    assert.ok(identity);
    const levels = [...f.mock.thinkingLevels];
    await f.emit("session_start");
    await f.emit("resources_discover");
    assert.equal(f.execution().negotiation?.executionId, identity);
    assert.equal(f.flow.executions.length, 1);
    assert.deepEqual(f.mock.thinkingLevels, levels);
    assert.equal(f.mock.entries.filter((e) => e.customType === "plan-implementation-runtime-consumed").length, 1);
    f.assertNoEscape();
  });
}

for (const effort of [
  undefined,
  null,
  false,
  {},
  { provider: "test", modelId: "other", thinkingLevel: "low", source: "manual" },
  { provider: WORKER.provider, modelId: WORKER.id, thinkingLevel: "invalid", source: "manual" },
  { provider: WORKER.provider, modelId: WORKER.id, thinkingLevel: "low", source: "invalid" },
  { provider: WORKER.provider, modelId: WORKER.id, thinkingLevel: "high", source: "manual" },
]) {
  test(`fresh Linked bootstrap rejects supplied malformed or mismatched effort: ${JSON.stringify(effort)}`, async () => {
    const f = await fixture();
    f.mock.entries.push({
      customType: "plan-implementation-runtime",
      data: {
        model: `${WORKER.provider}/${WORKER.id}:low`,
        effort,
        exec: {
          active: true,
          planFile: "/approved.md",
          implementer: WORKER.name,
          implementerModel: `${WORKER.provider}/${WORKER.id}`,
          linkedFlow: f.flow.snapshot(),
          asks: 0,
          costUsd: 0,
        },
      },
    });
    await f.emit("resources_discover");
    assert.equal(f.flow.executions.length, 0);
    assert.deepEqual(f.mock.thinkingLevels, []);
    assert.deepEqual(f.flow.activated, []);
    f.assertNoExec();
    assert.match(f.context.notifications.at(-1)?.message ?? "", /invalid approved effort/u);
    await f.emit("resources_discover");
    assert.equal(f.mock.entries.filter((e) => e.customType === "plan-implementation-runtime-consumed").length, 1);
    f.assertNoEscape();
  });
}

for (const choice of [KEEP, COMPACT]) {
  test(`same-model linked '${choice}' approves the recommendation before entering Exec once`, async () => {
    const recommendation = deferred<Awaited<ReturnType<typeof pickImplementationEffort>>>();
    const requested = deferred<void>();
    const picker = vi.fn<typeof pickImplementationEffort>(async (input) => {
      requested.resolve();
      assert.equal(input.plan, PLAN.trim());
      return recommendation.promise;
    });
    const f = await fixture({ choice, pickImplementationEffort: picker });
    await f.plan();
    const levelsBefore = [...f.mock.thinkingLevels];
    const reviewing = f.tool(EXIT_TOOL);
    await requested.promise;
    assert.equal(f.selections.length, 0, "approval waits for the recommendation");
    assert.equal(f.inline()?.active, true);
    assert.equal(await f.guard(), true);
    f.assertNoExec();
    recommendation.resolve({
      kind: "system1",
      choice: "low",
      confidence: 0.8,
      probabilities: { low: 1, medium: 0, high: 0, xhigh: 0 },
      waterfall: ["jev"],
      targetKey: "test-target",
      fallback: false,
      attempts: [],
      backend: "jev",
      provider: "typesafe",
      model: "jev-latest",
      selectionKey: "typesafe/jev-latest",
    });
    const approved = await reviewing;
    assert.equal((approved as { terminate?: boolean }).terminate, true);
    assert.equal(picker.mock.calls.length, 1);
    assert.equal(f.selections.at(-1)?.title, "Implementation effort");
    assert.equal(f.selections.at(-1)?.choices[0], "low");
    assert.deepEqual(f.mock.thinkingLevels, levelsBefore, "opening and approving do not apply effort");
    assert.equal(await f.guard(), true);
    f.assertNoExec();
    const settled = await f.settle();
    assert.equal(settled?.continue, true);
    assert.equal(settled?.entries?.filter((entry) => entry.type === "compaction").length, choice === COMPACT ? 1 : 0);
    assert.deepEqual(f.mock.thinkingLevels.slice(levelsBefore.length), ["low"]);
    assert.equal(f.mock.thinkingLevel, "low");
    assert.equal(f.flow.snapshot().workflow, "exec");
    assert.equal(f.flow.commits.length, 1);
    assert.equal(await f.guard(), false);
    assert.equal(await f.settle(), undefined);
    assert.equal(f.flow.executions.length, 1);
    assert.deepEqual(f.mock.thinkingLevels.slice(levelsBefore.length), ["low"]);
    f.assertNoEscape();
  });
}

test("flow revision changing while the effort recommendation is pending expires approval", async () => {
  const recommendation = deferred<Awaited<ReturnType<typeof pickImplementationEffort>>>();
  const requested = deferred<void>();
  const f = await fixture({
    pickImplementationEffort: async () => {
      requested.resolve();
      return recommendation.promise;
    },
  });
  await f.plan();
  const levelsBefore = [...f.mock.thinkingLevels];
  const reviewing = f.tool(EXIT_TOOL);
  await requested.promise;
  f.flow.revise();
  recommendation.resolve({
    kind: "system1",
    choice: "low",
    confidence: 0.8,
    probabilities: { low: 1, medium: 0, high: 0, xhigh: 0 },
    waterfall: ["jev"],
    targetKey: "test-target",
    fallback: false,
    attempts: [],
    backend: "jev",
    provider: "typesafe",
    model: "jev-latest",
    selectionKey: "typesafe/jev-latest",
  });
  const result = await reviewing;
  assert.match(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), /expired/iu);
  assert.deepEqual(f.selections, []);
  assert.deepEqual(f.mock.thinkingLevels, levelsBefore);
  assert.equal(f.inline()?.active, true);
  assert.equal(await f.guard(), true);
  assert.equal(await f.settle(), undefined);
  f.assertNoExec();
  f.assertNoEscape();
});

for (const thinkingLevel of ["high", "off"] as const) {
  test(`in-place linked execution retains ${thinkingLevel} rather than the medium worker suggestion when classification is unavailable`, async () => {
    const f = await fixture({ thinkingLevel });
    await f.plan();
    await f.tool(EXIT_TOOL);
    assert.equal(f.selections[1]?.title, "Implementation effort");
    assert.equal(f.selections[1]?.choices[0], thinkingLevel);
    assert.equal((await f.settle())?.continue, true);
    assert.equal(f.mock.thinkingLevel, thinkingLevel);
  });
}

for (const restore of ["session_tree", "reload"] as const) {
  for (const completion of ["stop", "finish"] as const) {
    test(`linked ${completion} after ${restore} uses the restored revision with retained flow identity`, async () => {
      const f = await fixture();
      await f.plan();
      await f.tool(EXIT_TOOL);
      const settled = await f.settle();
      assert.ok(settled?.entries?.some((entry) => entry.type === "custom" && entry.customType === EXEC_ENTRY));
      const initial = f.flow.snapshot().revision;
      f.flow.revise();
      if (restore === "reload") {
        await f.emit("session_shutdown");
        await f.emit("session_start");
      } else await f.emit("session_tree");
      const prior = f.mock.entries.filter((entry) => entry.customType === EXEC_ENTRY).at(-1)?.data as ExecState;
      assert.equal(prior.linkedFlow?.revision, initial, "durable approval retains its original revision");
      if (completion === "stop") await f.mock.commands.get("plan-exec")?.handler("stop", f.ctx);
      else await f.tool("finish_plan", { report: "Implemented.", verification: "Tests passed.", concerns: "None." });
      const request = f.flow.executions.at(-1);
      assert.equal(request?.phase, completion === "stop" ? "stop" : "finish");
      assert.equal(request?.expectedRevision, initial + 1);
      assert.equal(request?.planFile, prior.planFile);
      const ended = f.mock.entries.filter((entry) => entry.customType === EXEC_ENTRY).at(-1)?.data as ExecState;
      assert.equal(ended.active, false);
      assert.equal(f.flow.snapshot().workflow, "work");
      assert.equal(f.ctx.model?.id, GENERAL.id);
    });
  }
}

test("changing flow revision while the approval UI is open expires the approval", async () => {
  const f = await fixture();
  await f.plan();
  const opened = deferred<void>();
  const answer = deferred<string>();
  f.select(async () => {
    opened.resolve();
    return answer.promise;
  });
  const reviewing = f.tool(EXIT_TOOL);
  await opened.promise;
  f.flow.revise();
  answer.resolve(APPROVE);
  const result = await reviewing;
  assert.match(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), /expired/iu);
  assert.equal(f.inline()?.active, true);
  assert.equal(await f.guard(), true);
  assert.equal(await f.settle(), undefined);
  assert.equal(f.flow.executions.length, 0);
  f.assertNoExec();
  f.assertNoEscape();
});

for (const choice of [KEEP, COMPACT]) {
  test(`flow revision changed after '${choice}' suppresses the pending settle handoff`, async () => {
    const f = await fixture({ choice });
    await f.plan();
    await f.tool(EXIT_TOOL);
    f.flow.revise();
    const entries = structuredClone(f.mock.entries);
    assert.equal(await f.settle(), undefined);
    assert.equal(await f.settle(), undefined);
    assert.deepEqual(f.mock.entries, entries);
    assert.equal(f.flow.executions.length, 0);
    assert.equal(f.inline()?.active, true);
    assert.equal(await f.guard(), true);
    f.assertNoExec();
    f.assertNoEscape();
  });
}

for (const invalidation of ["revision", "session", "abort"] as const) {
  test(`pending worker activation cannot commit after ${invalidation} changes`, async () => {
    const f = await fixture();
    await f.plan();
    await f.tool(EXIT_TOOL);
    const abort = new AbortController();
    f.ctx.signal = abort.signal;
    const activation = deferred<boolean>();
    const requested = deferred<void>();
    f.flow.activation(async () => {
      requested.resolve();
      return activation.promise;
    });
    const settling = f.settle();
    await requested.promise;
    if (invalidation === "revision") f.flow.revise();
    else if (invalidation === "session") f.switchSession();
    else abort.abort();
    const entries = structuredClone(f.mock.entries);
    activation.resolve(true);
    assert.equal(await settling, undefined);
    assert.equal(await f.settle(), undefined);
    assert.deepEqual(f.mock.entries, entries, "no stale Exec or inline exit may be persisted");
    assert.equal(f.inline()?.active, true);
    assert.equal(await f.guard(), true);
    f.assertNoExec();
    f.assertNoEscape();
  });
}

test("failed linked worker activation keeps Plan active without a continuation", async () => {
  const f = await fixture();
  await f.plan();
  await f.tool(EXIT_TOOL);
  f.flow.activation(async () => false);
  assert.equal(await f.settle(), undefined);
  assert.equal(await f.settle(), undefined);
  assert.equal(f.inline()?.active, true);
  assert.equal(await f.guard(), true);
  assert.equal(f.flow.snapshot().workflow, "plan");
  assert.match(f.context.notifications.at(-1)?.message ?? "", /unavailable/iu);
  assert.deepEqual(f.flow.activated, ["plan"]);
  f.assertNoExec();
  f.assertNoEscape();
});

for (const distinctModels of [false, true]) {
  test(`healthy ${distinctModels ? "distinct" : "same"}-model task survives repeated replan/resume boundaries and restore`, async () => {
    const f = await executingFixture({ distinctModels });
    const initial = structuredClone(f.execution());
    for (let revision = 1; revision <= 2; revision++) {
      const request = requestReplan(f.mock.eventBus);
      assert.ok(request instanceof Promise, "owner attaches its result synchronously");
      assert.equal((await request).ok, true);
      const draft = f.execution().replanning?.draftFile;
      assert.ok(draft);
      writeFileSync(draft, `# Revision ${revision + 1}\n\nContinue the same implementation.\n`);
      await f.tool(EXIT_TOOL);
      assert.equal((await f.settle())?.continue, true);
      const resumed = f.execution();
      assert.equal(resumed.negotiation?.executionId, initial.negotiation?.executionId);
      assert.equal(resumed.negotiation?.planRevision, revision + 1);
      assert.equal(resumed.negotiation?.phase, "implementing");
      assert.equal(resumed.negotiation?.attempts, 0);
      assert.equal(resumed.planFile, draft);
      assert.equal(resumed.replanning, undefined);
      await f.emit("session_tree");
      assert.equal(f.flow.snapshot().workflow, "exec");
    }
    assert.deepEqual(
      f.flow.executions.map((request) => request.phase),
      ["begin", "replan", "resume", "replan", "resume"],
    );
    assert.deepEqual(
      f.flow.executions.filter((request) => request.phase === "resume").map((request) => request.expectedPlanRevision),
      [1, 2],
    );
    f.assertNoEscape();
  });
}

test("command replanning is idle-only and never schedules a surprise transition", async () => {
  const f = await executingFixture();
  const before = structuredClone(f.execution());
  Object.assign(f.ctx, { isIdle: () => false });
  await f.enter();
  assert.match(f.context.notifications.at(-1)?.message ?? "", /Implementation is running\. Interrupt it/u);
  assert.deepEqual(f.execution(), before);
  assert.deepEqual(
    f.flow.executions.map((request) => request.phase),
    ["begin"],
  );
  Object.assign(f.ctx, { isIdle: () => true });
  await f.settle();
  assert.equal(f.flow.snapshot().workflow, "exec");
  await f.enter();
  assert.equal(f.flow.snapshot().workflow, "plan");
  assert.equal(f.flow.executions.at(-1)?.phase, "replan");
  f.assertNoEscape();
});

for (const outcome of ["completed", "aborted", "settled-aborted"] as const) {
  test(`tool replanning defers one draft to successful settlement: ${outcome}`, async () => {
    const f = await executingFixture({ distinctModels: true });
    const before = structuredClone(f.execution());
    const records = f.mock.entries.length;
    Object.assign(f.ctx, { isIdle: () => false });
    const request = await f.tool(ENTER_TOOL);
    const duplicate = await f.tool(ENTER_TOOL);
    assert.equal((request as { terminate?: boolean }).terminate, true);
    assert.equal((duplicate as { terminate?: boolean }).terminate, true);
    assert.match(JSON.stringify(request.content), /Stop implementing.*after this turn settles/u);
    assert.equal(f.mock.entries.length, records);
    assert.equal(f.flow.snapshot().workflow, "exec");
    assert.equal(f.ctx.model?.id, WORKER.id);
    assert.deepEqual(
      f.flow.executions.map((entry) => entry.phase),
      ["begin"],
    );
    const proposal = { type: "custom" as const, customType: "another-extension:proposal", data: { keep: true } };
    if (outcome === "settled-aborted") await f.emit("agent_settled", { aborted: true });
    const result = await f.settle(outcome === "aborted" ? "aborted" : "completed", [proposal]);
    if (outcome === "completed") {
      assert.equal(result?.continue, true);
      assert.deepEqual(result.entries?.[0], proposal, "do not discard another extension's boundary proposals");
      assert.equal(f.flow.snapshot().workflow, "plan");
      assert.equal(f.ctx.model?.id, PLANNER.id);
      assert.equal(f.flow.executions.filter((entry) => entry.phase === "replan").length, 1);
      assert.equal(f.execution().negotiation?.executionId, before.negotiation?.executionId);
      assert.ok(f.execution().replanning);
      assert.equal(await f.guard(), true);
    } else {
      assert.equal(result, undefined);
      assert.deepEqual(f.execution(), before);
      assert.equal(f.flow.snapshot().workflow, "exec");
      assert.equal(f.flow.executions.length, 1);
    }
    assert.ok(
      f.mock.entries.some((entry) => entry.customType === proposal.customType),
      "the mock branch commits boundary entries",
    );
    assert.equal(await f.settle(), undefined);
    f.assertNoEscape();
  });
}

for (const phase of ["replan", "resume"] as const) {
  for (const invalidation of ["unavailable", "revision", "session", "abort"] as const) {
    test(`${phase} ${invalidation} leaves the previous approval/task intact`, async () => {
      const f = await exhaustedFixture({ distinctModels: true });
      if (phase === "resume") {
        await f.enter();
        const draft = f.execution().replanning?.draftFile;
        assert.ok(draft);
        writeFileSync(draft, "# Revised plan\n\nKeep safety.\n");
        await f.tool(EXIT_TOOL);
      }
      const prior = structuredClone(f.execution());
      const model = f.ctx.model;
      const controller = new AbortController();
      f.ctx.signal = controller.signal;
      const started = deferred<void>();
      const activation = deferred<boolean>();
      f.flow.activation(async () => {
        started.resolve();
        return activation.promise;
      });
      const pending = phase === "replan" ? f.enter() : f.settle();
      await started.promise;
      assert.deepEqual(f.execution(), prior, "no state changes before model activation");
      if (invalidation === "revision") f.flow.revise();
      else if (invalidation === "session") f.switchSession();
      else if (invalidation === "abort") controller.abort();
      activation.resolve(invalidation !== "unavailable");
      await pending;
      assert.deepEqual(f.execution(), prior);
      assert.equal(f.flow.snapshot().workflow, phase === "resume" ? "plan" : "exec");
      assert.equal(f.inline()?.active, phase === "resume");
      assert.equal(f.flow.commits.at(-1)?.phase, phase === "resume" ? "replan" : "begin");
      if (invalidation === "unavailable") {
        assert.equal(f.ctx.model, model);
        assert.match(f.context.notifications.at(-1)?.message ?? "", /unavailable/iu);
      }
      assert.equal(await f.settle(), undefined);
      f.assertNoEscape();
    });
  }
}

for (const choice of [KEEP, COMPACT]) {
  for (const mutation of ["edit", "delete"] as const) {
    for (const boundary of ["before settle", "during activation"] as const) {
      test(`resumed '${choice}' approval rejects draft ${mutation} ${boundary} without revising the task`, async () => {
        const f = await exhaustedFixture({ choice, distinctModels: true });
        await f.enter();
        const suspended = structuredClone(f.execution());
        const draft = suspended.replanning?.draftFile;
        assert.ok(draft);
        const approvedPlan = readFileSync(suspended.planFile, "utf8");
        writeFileSync(draft, "# Revised plan\n\nKeep safety and the existing implementation.\n");
        const approval = await f.tool(EXIT_TOOL);
        assert.equal((approval.details as { outcome: string }).outcome, "handoff");
        assert.equal(f.inline()?.active, true);
        assert.equal(await f.guard(), true);
        assert.deepEqual(f.execution(), suspended);

        const entries = structuredClone(f.mock.entries);
        const boundaryEntries = structuredClone(f.boundaryEntries);
        const publications = structuredClone(f.execPublications);
        const messages = structuredClone(f.mock.sentMessages);
        const userMessages = structuredClone(f.mock.sentUserMessages);
        const levels = [...f.mock.thinkingLevels];
        const commits = f.flow.commits.length;
        const activation = deferred<boolean>();
        const started = deferred<void>();
        f.flow.activation(async (workflow) => {
          assert.equal(workflow, "exec");
          started.resolve();
          return activation.promise;
        });
        let settling: ReturnType<typeof f.settle> | undefined;
        if (boundary === "during activation") {
          settling = f.settle();
          await started.promise;
          assert.deepEqual(f.execution(), suspended, "activation must not resume the task early");
          assert.equal(await f.guard(), true);
        }
        if (mutation === "edit") writeFileSync(draft, "# Unapproved replacement\n\nRemove the guard.\n");
        else rmSync(draft);
        if (boundary === "before settle") settling = f.settle();
        activation.resolve(true);

        assert.equal(await settling, undefined, "invalidated approval must not produce a continuation or compaction");
        assert.equal(await f.settle(), undefined, "the invalidated handoff is consumed exactly once");
        assert.deepEqual(f.mock.entries, entries, "no resumed execution or inline exit is persisted");
        assert.deepEqual(f.boundaryEntries, boundaryEntries, "no new revision, brief or compaction is proposed");
        assert.deepEqual(f.execution(), suspended, "the durable replanning task is unchanged");
        assert.equal(f.execution().negotiation?.planRevision, f.saved.negotiation?.planRevision);
        assert.deepEqual(f.execution().negotiation, f.saved.negotiation, "review budgets and findings are retained");
        assert.equal(f.execution().asks, f.saved.asks);
        assert.equal(f.execution().costUsd, f.saved.costUsd);
        assert.deepEqual(f.execution().pendingQuestion, f.saved.pendingQuestion);
        assert.deepEqual(f.execution().touched, f.saved.touched);
        assert.equal(readFileSync(f.touchedFile, "utf8"), "unfinished implementation\n");
        assert.equal(readFileSync(suspended.planFile, "utf8"), approvedPlan);
        assert.equal(f.inline()?.active, true);
        assert.equal(f.inline()?.planFile, draft);
        assert.equal(await f.guard(), true, "an expired approval cannot release the readonly guard");
        assert.deepEqual(f.execPublications, publications, "no resumed execution is published");
        assert.deepEqual(f.mock.sentMessages, messages);
        assert.deepEqual(f.mock.sentUserMessages, userMessages, "no implementation continuation is sent");
        assert.deepEqual(f.mock.thinkingLevels, levels);
        assert.equal(f.flow.commits.length, commits);
        assert.equal(f.flow.commits.at(-1)?.phase, "replan");
        assert.deepEqual(
          f.flow.executions.map((request) => request.phase),
          boundary === "before settle" ? ["begin", "replan"] : ["begin", "replan", "resume"],
        );
        if (boundary === "during activation") {
          // The setter may already have activated the worker before the synchronous commit fence fails.
          assert.equal(f.ctx.model?.id, WORKER.id);
          assert.match(f.context.notifications.at(-1)?.message ?? "", /expired/iu);
        }
        assert.equal(f.createSession.mock.calls.length, 0, "invalidated reapproval cannot replay paid work");
        f.assertNoEscape();
      });
    }
  }
}

for (const lifecycle of ["session_tree", "reload"] as const) {
  test(`replanning ${lifecycle} restores the execution draft without an inline record`, async () => {
    const f = await exhaustedFixture();
    await f.enter();
    const suspended = structuredClone(f.execution());
    const draft = suspended.replanning?.draftFile;
    assert.ok(draft);
    // Supplementary inline entries may not survive a compaction/reload boundary.
    for (let index = f.mock.entries.length - 1; index >= 0; index--)
      if (f.mock.entries[index]?.customType === INLINE_ENTRY) f.mock.entries.splice(index, 1);
    if (lifecycle === "reload") {
      await f.emit("session_shutdown");
      await f.emit("session_start");
    } else await f.emit("session_tree");
    assert.equal(f.inline(), undefined, "restore does not allocate or persist a replacement draft");
    assert.equal(await f.guard(), true);
    assert.equal(f.flow.snapshot().workflow, "plan");
    assert.deepEqual(f.execution(), suspended);
    f.select(async () => "No, keep planning");
    const review = await f.tool(EXIT_TOOL);
    assert.equal((review.details as { planFile: string }).planFile, draft);
    assert.equal((review.details as { outcome: string }).outcome, "kept");
    assert.equal(
      (review.details as { previous: string }).previous,
      PLAN.trim(),
      "restored comparison baseline is the last approval",
    );
    assert.deepEqual(f.execution(), suspended);
    assert.equal(f.createSession.mock.calls.length, 0, "restore must not replay paid consultation/review");
    assert.equal(await f.settle(), undefined);
    f.assertNoEscape();
  });
}

for (const choice of [undefined, "No, keep planning", "Save for later"]) {
  test(`replanning ${choice ?? "Escape"} retains the paused budget and distinct draft`, async () => {
    const f = await exhaustedFixture();
    await f.enter();
    const before = structuredClone(f.execution());
    const draft = before.replanning?.draftFile;
    assert.ok(draft);
    f.ctx.ui.input = async () => "revised-snapshot";
    f.select(async (_title, choices) => (choices.includes("Enter different name") ? "Enter different name" : choice));
    const result = await f.tool(EXIT_TOOL);
    assert.equal((result.details as { outcome: string }).outcome, choice === "Save for later" ? "saved" : "kept");
    if (choice === "Save for later") {
      const savedFile = (result.details as { savedFile: string }).savedFile;
      assert.notEqual(savedFile, draft);
      assert.notEqual(savedFile, before.planFile);
      assert.equal(readFileSync(savedFile, "utf8").trim(), readFileSync(draft, "utf8").trim());
      assert.match(JSON.stringify(result.content), /Implementation remains paused in Plan/u);
    }
    assert.deepEqual(f.execution(), before);
    assert.equal(f.inline()?.active, true);
    assert.equal(f.inline()?.planFile, draft);
    assert.equal(await f.guard(), true);
    assert.equal(await f.settle(), undefined);
    assert.deepEqual(
      f.flow.executions.map((request) => request.phase),
      ["begin", "replan"],
    );
    f.assertNoEscape();
  });
}

test("explicit Independent recovery refuses approval until the suspended task is stopped", async () => {
  const f = await exhaustedFixture();
  await f.enter();
  const suspended = structuredClone(f.execution());
  f.flow.independent();
  const opened = f.selections.length;
  const refused = await f.tool(EXIT_TOOL);
  assert.match(
    JSON.stringify(refused.content),
    /This suspended Linked task is now Independent\. Stop implementation before approving another plan/u,
  );
  assert.equal(f.selections.length, opened, "no replacement approval dialog");
  assert.deepEqual(f.execution(), suspended);
  assert.equal(await f.guard(), true);
  await f.mock.commands.get("plan-exec")?.handler("stop", f.ctx);
  assert.equal(f.execution().active, false);
  assert.equal(f.execution().replanning, undefined);
  assert.deepEqual(
    f.flow.executions.map((request) => request.phase),
    ["begin", "replan"],
    "Independent stop does not require a Linked model transition",
  );
  f.select(async () => "No, keep planning");
  await f.enter();
  const nextPlan = f.inline()?.planFile;
  assert.ok(nextPlan);
  writeFileSync(nextPlan, "# New independent plan\n");
  const next = await f.tool(EXIT_TOOL);
  assert.doesNotMatch(JSON.stringify(next.content), /suspended Linked task/u);
  assert.equal((next.details as { outcome: string }).outcome, "kept");
});

async function implementationScreen(options: { settings?: Partial<PlanModeSettings> } = {}) {
  const f = await fixture({ planners: true, ...options });
  const opened = f.mock.commands.get("planners")?.handler("", f.ctx);
  await vi.waitFor(() => assert.ok(f.app()));
  const app = f.app();
  for (let index = 0; index < 5 && !/⏎ do it/u.test(app.render().join("\n")); index++) app.handleInput("\t");
  app.handleInput("\r");
  assert.match(app.render().join("\n"), /● Implement/u);
  await vi.waitFor(() => assert.doesNotMatch(app.render().join("\n"), /choosing\.\.\./u));
  const focus = (label: string) => {
    for (let index = 0; index < 10; index++) {
      if (new RegExp(`${label}\\s+‹`, "u").test(app.render().join("\n"))) return;
      app.handleInput("\u001b[B");
    }
    assert.fail(`Could not focus ${label}: ${app.render().join("\n")}`);
  };
  return { ...f, app, opened, focus };
}

test("/planners Linked fresh retains the worker suggestion when classification is unavailable", async () => {
  const f = await implementationScreen({ settings: { defaultImplementationThinkingLevel: "low" } });
  f.focus("Context");
  f.app.handleInput("\u001b[C");
  f.app.handleInput("\u001b[C");
  assert.match(f.app.render().join("\n"), /fresh session with only the plan/u);
  assert.match(f.app.render().join("\n"), /Effort\s+medium/u);
  Object.assign(f.ctx, { newSession: async () => ({ cancelled: true }) });
  f.app.handleInput("\r");
  await f.opened;
});

for (const policy of ["keep", "compact", "fresh"] as const) {
  test(`/planners Linked offers only worker execution with ${policy} context policy`, async () => {
    const f = await implementationScreen();
    assert.match(f.app.render().join("\n"), /Execute with linked worker: Sol/u);
    assert.doesNotMatch(f.app.render().join("\n"), /Mode\s+(?:‹ )?(?:Here|Handoff)/u);
    f.focus("Model");
    f.app.handleInput("\u001b[C");
    assert.match(f.app.render().join("\n"), /Model\s+‹ Sol ›/u);
    assert.doesNotMatch(f.app.render().join("\n"), /Other model/u);
    f.focus("Context");
    if (policy !== "keep") f.app.handleInput("\u001b[C");
    if (policy === "fresh") f.app.handleInput("\u001b[C");
    assert.match(
      f.app.render().join("\n"),
      policy === "keep"
        ? /this conversation, plus the plan/u
        : policy === "compact"
          ? /compact to plan \(same session\)/u
          : /fresh session with only the plan/u,
    );

    type Compaction = { customInstructions: string; onComplete(result: unknown): void };
    let compact: Compaction | undefined;
    const children: Array<{ customType: string; data: unknown }> = [];
    const newSession = vi.fn(async (options: { setup(manager: unknown): Promise<void> }) => {
      await options.setup({
        getSessionId: () => "linked-child",
        appendCustomEntry: (customType: string, data: unknown) => children.push({ customType, data }),
      });
      // Stop at the bootstrap boundary; the gate owns fresh-runtime activation.
      return { cancelled: false };
    });
    Object.assign(f.ctx, {
      compact: (options: Compaction) => {
        compact = options;
      },
      newSession,
    });
    f.app.handleInput("\r");
    await f.opened;
    if (policy === "compact") {
      await vi.waitFor(() => assert.ok(compact));
      assert.ok(compact);
      assert.equal(f.inline()?.active, true);
      assert.equal(await f.guard(), true);
      assert.equal(f.flow.executions.length, 0, "wait for explicit compaction before worker activation");
      f.assertNoExec();
      const result = (await f.emit("session_before_compact", {
        customInstructions: compact.customInstructions,
        signal: new AbortController().signal,
        preparation: { tokensBefore: 1234 },
      })) as { compaction: { summary: string; firstKeptEntryId: null; details: unknown } };
      assert.match(result.compaction.summary, /# Linked lifecycle/u);
      assert.equal(result.compaction.firstKeptEntryId, null);
      compact.onComplete(result.compaction);
      compact.onComplete(result.compaction);
    }
    if (policy === "fresh") {
      await vi.waitFor(() => assert.equal(newSession.mock.calls.length, 1));
      await vi.waitFor(() => assert.equal(children.length, 3));
      assert.deepEqual(
        children.map((entry) => entry.customType),
        [FLOW_ENTRY, EXEC_ENTRY, "plan-implementation-runtime"],
      );
      const exec = children[1]?.data as ExecState;
      const flow = children[0]?.data as FlowSnapshot;
      assert.equal(flow.operatingMode, "linked");
      assert.equal(flow.revision, f.flow.snapshot().revision);
      assert.deepEqual(exec.linkedFlow?.selectedFlow, flow.selectedFlow);
      assert.equal(exec.active, true);
      assert.equal(exec.implementerModel, "test/sol");
      assert.equal(
        (children[2]?.data as { model: string } | undefined)?.model,
        "test/sol:medium",
        "fresh implementation starts with the worker suggestion",
      );
      assert.equal(readFileSync(exec.planFile, "utf8").trim(), PLAN.trim());
      assert.equal(f.flow.executions.length, 0, "the parent must not activate the worker for the child");
      assert.equal(compact, undefined);
      assert.equal(f.inline()?.active, true);
      f.assertNoExec();
    } else {
      await vi.waitFor(() => assert.equal(f.mock.sentUserMessages.length, 1));
      assert.equal(f.flow.commits.length, 1);
      assert.equal(f.flow.snapshot().workflow, "exec");
      assert.equal(f.inline()?.active, false);
      assert.equal(
        f.mock.thinkingLevel,
        "high",
        "in-place transitions preserve current effort rather than the role suggestion",
      );
      assert.equal(newSession.mock.calls.length, 0);
      if (policy === "keep") assert.equal(compact, undefined, "keeping history never implicitly compacts");
    }
    f.assertNoEscape();
  });
}

for (const thinkingLevel of ["high", "off"] as const) {
  test(`inline fresh handoff starts with worker suggestion, not parent ${thinkingLevel}`, async () => {
    const f = await fixture({ fresh: true, choice: LINKED_FRESH, thinkingLevel });
    const children: Array<{ customType: string; data: unknown }> = [];
    const replace = vi.fn<ExtensionCommandContext["newSession"]>(async (options) => {
      await options?.setup?.({
        appendCustomEntry: (customType: string, data: unknown) => children.push({ customType, data }),
      } as never);
      return { cancelled: false };
    });
    f.ctx.newSession = replace;
    await f.plan();
    const result = await f.tool(EXIT_TOOL);
    assert.equal((result as { terminate?: boolean }).terminate, true);
    assert.match(JSON.stringify(result.content), /fresh conversation after this turn settles/u);
    assert.equal(f.selections.at(-1)?.choices[0], "medium");
    assert.ok(f.selections.some((selection) => selection.choices.includes(LINKED_FRESH)));
    assert.ok(LINKED_FRESH.length <= 42);
    assert.equal(f.freshJobs.length, 0, "tool only records explicit approval, not a replacement");
    assert.equal(await f.guard(), true);
    assert.equal(await f.settle(), undefined, "settle schedules without waiting for its own idle");
    assert.equal(f.freshJobs.length, 1);
    assert.equal(replace.mock.calls.length, 0);
    assert.equal(await f.guard(), true);
    await f.freshJobs.shift()?.();
    assert.equal(replace.mock.calls.length, 1);
    assert.deepEqual(
      children.map((entry) => entry.customType),
      [FLOW_ENTRY, EXEC_ENTRY, "plan-implementation-runtime"],
    );
    const runtime = children[2]?.data as { model: string; exec: ExecState; consultant: { messages: unknown[] } };
    assert.equal(runtime.model, "test/sol:medium");
    assert.equal(runtime.exec.planFile, f.inline()?.planFile);
    assert.deepEqual(runtime.consultant.messages, f.ctx.sessionManager.buildSessionProjection().messages);
    assert.equal(f.mock.thinkingLevel, thinkingLevel, "the parent never activates the worker");
    assert.equal(await f.settle(), undefined);
    assert.equal(await f.guard(), true);
    f.assertNoExec();
    f.assertNoEscape();
  });
}

for (const invalidation of ["flow", "branch", "session", "reload", "plan", "review", "abort"] as const) {
  for (const boundary of ["before settle", "after schedule"] as const) {
    test(`fresh approval expires on ${invalidation} ${boundary}`, async () => {
      const f = await fixture({ fresh: true, choice: LINKED_FRESH });
      const replace = vi.fn<ExtensionCommandContext["newSession"]>(async () => ({ cancelled: false }));
      f.ctx.newSession = replace;
      const controller = new AbortController();
      f.ctx.signal = controller.signal;
      await f.plan();
      await f.tool(EXIT_TOOL);
      if (boundary === "after schedule") await f.settle();
      if (invalidation === "flow") f.flow.revise();
      else if (invalidation === "branch") f.abandonBranch();
      else if (invalidation === "session") f.switchSession();
      else if (invalidation === "reload") {
        await f.emit("session_shutdown");
        await f.emit("session_start");
      } else if (invalidation === "plan") writeFileSync(f.inline()?.planFile as string, "# Different unapproved plan");
      else if (invalidation === "review") {
        f.select(async () => undefined);
        await f.tool(EXIT_TOOL);
      } else controller.abort();
      const records = structuredClone(f.mock.entries);
      await f.settle();
      for (const job of f.freshJobs.splice(0)) await job();
      assert.equal(replace.mock.calls.length, 0);
      assert.deepEqual(f.mock.entries, records, "no stale parent or child lifecycle writes");
      f.assertNoExec();
      f.assertNoEscape();
    });
  }
}

for (const cancelled of ["dialog", "turn", "replacement"] as const) {
  test(`fresh handoff ${cancelled} cancellation retains Plan without execution`, async () => {
    const f = await fixture({ fresh: true, choice: LINKED_FRESH });
    const replace = vi.fn<ExtensionCommandContext["newSession"]>(async () => ({ cancelled: true }));
    f.ctx.newSession = replace;
    await f.plan();
    if (cancelled === "dialog") f.select(async () => undefined);
    await f.tool(EXIT_TOOL);
    await f.emit("agent_before_settle", { outcome: cancelled === "turn" ? "aborted" : "completed" });
    for (const job of f.freshJobs.splice(0)) await job();
    assert.equal(replace.mock.calls.length, cancelled === "replacement" ? 1 : 0);
    assert.equal(f.inline()?.active, true);
    assert.equal(await f.guard(), true);
    f.assertNoExec();
    f.assertNoEscape();
  });
}

test("absent fresh host omits the option and supplies the /planners keyboard path", async () => {
  const f = await fixture();
  await f.plan();
  f.select(async () => undefined);
  await f.tool(EXIT_TOOL);
  assert.ok(!f.selections.some((selection) => selection.choices.includes(LINKED_FRESH)));
  assert.ok(f.context.notifications.some((notice) => /For a fresh conversation, use \/planners/u.test(notice.message)));
  assert.equal(f.freshJobs.length, 0);
  f.assertNoExec();
});

test("fresh host disappearing after approval retains Plan with a concrete keyboard fallback", async () => {
  const f = await fixture({ fresh: true, choice: LINKED_FRESH });
  await f.plan();
  await f.tool(EXIT_TOOL);
  f.freshAvailable(false);
  await f.settle();
  assert.equal(f.freshJobs.length, 0);
  assert.equal(await f.guard(), true);
  assert.match(f.context.notifications.at(-1)?.message ?? "", /use \/planners/u);
  f.assertNoExec();
});

for (const invalidation of ["flow", "branch", "reload", "plan"] as const) {
  test(`fresh handoff fences ${invalidation} again after awaited family preparation`, async () => {
    const f = await fixture({ fresh: true, choice: LINKED_FRESH });
    const replace = vi.fn<ExtensionCommandContext["newSession"]>(async () => ({ cancelled: false }));
    f.ctx.newSession = replace;
    await f.plan();
    await f.tool(EXIT_TOOL);
    await f.settle();
    const preparation = deferred<FamilyMembership>();
    const started = deferred<void>();
    const cancel = vi.fn();
    const off = f.mock.eventBus.on(FAMILY_CHANNEL, (data) => {
      (data as FamilyRequest).service = {
        prepareHandoff: () => {
          started.resolve();
          return preparation.promise;
        },
      } as never;
    });
    const replacing = f.freshJobs.shift()?.();
    await started.promise;
    assert.equal(replace.mock.calls.length, 0);
    if (invalidation === "flow") f.flow.revise();
    else if (invalidation === "branch") f.abandonBranch();
    else if (invalidation === "plan") writeFileSync(f.inline()?.planFile as string, "# Unapproved");
    else {
      await f.emit("session_shutdown");
      await f.emit("session_start");
    }
    const records = structuredClone(f.mock.entries);
    preparation.resolve({ version: 1, familyId: "family", agentId: "child", cancel });
    await replacing;
    off();
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(replace.mock.calls.length, 0);
    assert.deepEqual(f.mock.entries, records);
    f.assertNoExec();
  });
}
