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
import { onTestFinished, test, vi } from "vitest";
import { LINKED_FRESH } from "../src/approval-picker.js";
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
} from "../src/flow-contract.js";
import { FRESH_HANDOFF_CHANNEL, type FreshHandoffRequest } from "../src/fresh-handoff.js";
import planMode from "../src/index.js";
import { ENTER_TOOL, EXIT_TOOL, INLINE_ENTRY, MODE_CHANGED, MODE_SET } from "../src/inline-plan.js";
import * as plannerSessions from "../src/planner/session.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");

const GENERAL = { provider: "test", id: "general", name: "General", reasoning: true };
// Deliberately identical planner/worker: model inequality is not execution intent.
const WORKER = { provider: "test", id: "sol", name: "Sol", reasoning: true };
const OTHER = { provider: "other", id: "override", name: "Other model", reasoning: true };
const KEEP = "Execute with linked worker";
const COMPACT = "Compact first, then execute";
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
function coordinator(mock: MockPi, ctx: ExtensionCommandContext) {
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
        plan: { provider: WORKER.provider, modelId: WORKER.id },
        exec: { provider: WORKER.provider, modelId: WORKER.id, suggestedThinking: "medium" },
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
      state.revision === revision && ctx.sessionManager === manager && manager.getSessionId() === session;
    if (!current()) return result("Stale linked transition.");
    const workflow = request.kind === "workflow" ? request.workflow : request.phase === "begin" ? "exec" : "work";
    state.transitioning = true;
    attempts.push(workflow);
    try {
      const ok = await activate(workflow);
      // The async activation result must never commit into a newer selection/session.
      if (!current()) return result("Stale linked transition.");
      if (!ok) return result("Assigned model unavailable.");
      ctx.model = (workflow === "plan" || workflow === "exec" ? WORKER : GENERAL) as ExtensionCommandContext["model"];
      activated.push(workflow);
      if (request.kind === "execution") {
        const returned = request.commit();
        assert.equal(returned, undefined, "lifecycle commit must be synchronous");
        commits.push(request);
      }
      state.workflow = workflow;
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
  return {
    snapshot,
    workflows,
    executions,
    commits,
    attempts,
    activated,
    legacyRequests,
    activation: (fn: typeof activate) => {
      activate = fn;
    },
    revise: () => {
      state.revision++;
    },
  };
}

async function fixture(
  options: { choice?: string; planners?: boolean; thinkingLevel?: "high" | "off"; fresh?: boolean } = {},
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
  let select = async (_title: string, choices: string[]): Promise<string | undefined> =>
    choices.includes(options.choice ?? KEEP)
      ? (options.choice ?? KEEP)
      : choices.includes("high")
        ? choices[0]
        : undefined;
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
            return select(title, choices);
          },
        }),
    modelRegistry: {
      getAvailable: () => [GENERAL, WORKER, OTHER],
      getAll: () => [GENERAL, WORKER, OTHER],
      find: (provider: string, id: string) =>
        [GENERAL, WORKER, OTHER].find((model) => model.provider === provider && model.id === id),
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
  const flow = coordinator(mock, ctx);
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
  const execPublications: Array<{ active: boolean; source: string }> = [];
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
  await planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit",
      jevToolSelection: false,
      plansDirectory: directory,
      defaultImplementationContext: "keep",
      completionReview: false,
      // An available free target must still not leak into Linked choices.
      implementationModelMap: { "test/sol": [{ provider: OTHER.provider, modelId: OTHER.id }] },
    }),
    createSession: async () => {
      throw new Error("Lifecycle tests must not start a real planner session.");
    },
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
  const settle = async () =>
    (await emit("agent_before_settle", { outcome: "completed" })) as AgentBeforeSettleEventResult | undefined;
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
    selections,
    freshRequests,
    freshJobs,
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
    assert.deepEqual(f.selections[0]?.choices, [KEEP, COMPACT, "Edit the plan", "Save for later", "No, keep planning"]);
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

for (const thinkingLevel of ["high", "off"] as const) {
  test(`in-place linked execution retains ${thinkingLevel} rather than the medium worker suggestion`, async () => {
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
      for (const entry of settled?.entries ?? []) {
        if (entry.type === "custom") f.mock.entries.push({ customType: entry.customType, data: entry.data });
      }
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
  answer.resolve(KEEP);
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

async function implementationScreen() {
  const f = await fixture({ planners: true });
  const opened = f.mock.commands.get("planners")?.handler("", f.ctx);
  await vi.waitFor(() => assert.ok(f.app()));
  const app = f.app();
  for (let index = 0; index < 5 && !/⏎ do it/u.test(app.render().join("\n")); index++) app.handleInput("\t");
  app.handleInput("\r");
  assert.match(app.render().join("\n"), /● Implement/u);
  const focus = (label: string) => {
    for (let index = 0; index < 10; index++) {
      if (new RegExp(`${label}\\s+‹`, "u").test(app.render().join("\n"))) return;
      app.handleInput("\u001b[B");
    }
    assert.fail(`Could not focus ${label}: ${app.render().join("\n")}`);
  };
  return { ...f, app, opened, focus };
}

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
    assert.equal(f.selections[1]?.choices[0], "medium");
    assert.ok(f.selections[0]?.choices.includes(LINKED_FRESH));
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
  assert.ok(!f.selections[0]?.choices.includes(LINKED_FRESH));
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
