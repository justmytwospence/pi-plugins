import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { onTestFinished, test, vi } from "vitest";
import {
  CONTINUE_TOOL,
  EXEC_ENTRY,
  EXEC_STATUS_KEY,
  type ExecHost,
  type ExecState,
  FINISH_MESSAGE_TYPE,
  FINISH_TOOL,
  type FinishDetails,
  registerExec,
} from "../src/exec.js";
import { FLOW_CHANNEL, type FlowRequest, type FlowSnapshot, type FlowState } from "../src/flow-contract.js";
import { queryFooterActions } from "../src/footer-actions.js";
import planMode from "../src/index.js";
import type { PlannerSessionFactory } from "../src/planner/session.js";
import { createMockContext, createMockPi } from "./shared/support.js";

initTheme("dark");
const unavailable = "Work model unavailable. Retry completion or use /flow independent.";
const report = { report: "Implemented.", verification: "Local checks passed.", concerns: "Live checks not run." };
const worker = { provider: "test", id: "worker", name: "Worker", reasoning: true };
const planner = { provider: "test", id: "planner", name: "Planner", reasoning: true };
const work = { provider: "test", id: "work", name: "Work", reasoning: true };
const linkedFlow = (): FlowState => ({
  version: 1,
  operatingMode: "linked",
  revision: 4,
  selectedFlow: {
    provider: "test",
    anchorModel: "planner",
    roles: {
      work: { provider: "test", modelId: "work", suggestedThinking: "medium" },
      chat: { provider: "test", modelId: "work", suggestedThinking: "medium" },
      plan: { provider: "test", modelId: "planner" },
      exec: { provider: "test", modelId: "worker" },
    },
  },
});
const decision = (outcome: "accepted" | "changes_requested" = "accepted") =>
  JSON.stringify({
    outcome,
    summary: "Reviewed current implementation.",
    evidence: ["Read the diff."],
    limitations: ["Live checks not run."],
    findings:
      outcome === "accepted"
        ? []
        : [{ id: "F1", title: "Fix", detail: "Missing guard.", requestedChange: "Add guard." }],
  });
type Hook = NonNullable<ExecHost["finishLinked"]>;
type Result = {
  content: Array<{ type: string; text: string }>;
  details?: FinishDetails;
  terminate?: boolean;
  usage?: { cost: { total: number } };
};

function fixture(options: { linked?: boolean; hook?: Hook | false; review?: boolean; replies?: string[] } = {}) {
  const mock = createMockPi();
  const dir = mkdtempSync(join(tmpdir(), "exec-linked-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const planFile = join(dir, "approved.md");
  writeFileSync(planFile, "# Approved plan\n\nChange `src/a.ts`.\n");
  const coordinator: { snapshot?: FlowSnapshot } = {
    snapshot: {
      ...linkedFlow(),
      workflow: "exec",
      ready: true,
      guardAvailable: true,
      transitioning: false,
    },
  };
  mock.eventBus.on(FLOW_CHANNEL, (data) => {
    const request = data as FlowRequest;
    if (request.kind === "query") request.snapshot = structuredClone(coordinator.snapshot);
  });
  const publications: unknown[] = [];
  mock.eventBus.on("workflow-mode:exec", (data) => publications.push(data));
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    cwd: dir,
    model: worker,
    editorText: "Keep this draft",
    modelRegistry: {
      getAvailable: () => [worker, planner, work],
      getAll: () => [worker, planner, work],
      find: (provider: string, id: string) =>
        [worker, planner, work].find((m) => m.provider === provider && m.id === id),
      getApiKeyAndHeaders: async () => ({ ok: false, error: "No network in tests" }),
      isUsingOAuth: () => false,
    },
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => `entry-${mock.entries.length}`,
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      getSessionFile: () => "/fixture/main.jsonl",
    },
  });
  const ctx = context.ctx as ExtensionContext;
  const prompts: string[] = [];
  const replies = [...(options.replies ?? [decision()])];
  const createSession: PlannerSessionFactory = async () => {
    const listeners = new Set<(event: unknown) => void>();
    return {
      file: join(dir, "planner.jsonl"),
      session: {
        isStreaming: false,
        prompt: async (text: string) => {
          prompts.push(text);
          for (const listener of listeners) listener({ type: "agent_start" });
          const message = {
            role: "assistant",
            content: [{ type: "text", text: replies.shift() ?? decision() }],
            usage: { totalTokens: 100, cost: { total: 0.05 } },
          };
          for (const listener of listeners) listener({ type: "message_end", message });
          for (const listener of listeners) listener({ type: "agent_settled" });
        },
        abort: async () => {},
        steer: async () => {},
      } as never,
      subscribe: (listener) => {
        listeners.add(listener as never);
        return () => {
          listeners.delete(listener as never);
        };
      },
      dispose: () => {},
    };
  };
  const restoreModel = vi.fn(async () => true);
  let hook: Hook =
    options.hook ||
    (async (_ctx, _completion, commit) => {
      commit();
      return true;
    });
  const finishLinked = vi.fn<Hook>((...args) => hook(...args));
  const exec = registerExec(mock.pi, {
    consultantAccess: () => ({}) as never,
    createSession,
    restoreModel,
    ...(options.hook === false ? {} : { finishLinked }),
    completionReview: () => options.review !== false,
    completionMaxRevisions: () => 2,
  });
  const state: ExecState = {
    active: true,
    planFile,
    implementer: "Worker",
    implementerModel: "test/worker",
    planner: { spec: "test/planner:high", name: "Planner", sessionFile: join(dir, "planner.jsonl") },
    restore: "test/planner:high",
    restoreName: "Original planner",
    asks: 2,
    costUsd: 0.2,
    ...(options.linked === false ? {} : { linkedFlow: linkedFlow() }),
  };
  const begin = () => exec.begin(ctx, state, { record: true });
  const tool = (name: string, params: unknown = report, signal?: AbortSignal) => {
    const registered = mock.tools.find((candidate) => candidate.name === name) as unknown as {
      execute(...args: unknown[]): Promise<Result>;
    };
    return registered.execute("call", params, signal, undefined, ctx);
  };
  const event = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
  };
  const command = (args: string) => {
    const registered = mock.commands.get("plan-exec");
    assert.ok(registered);
    return registered.handler(args, ctx);
  };
  const latest = () => mock.entries.filter((entry) => entry.customType === EXEC_ENTRY).at(-1)?.data as ExecState;
  const messages = () =>
    mock.sentMessages.filter(({ message }) => (message as { customType?: string }).customType === FINISH_MESSAGE_TYPE);
  return {
    mock,
    ctx,
    context,
    coordinator,
    publications,
    prompts,
    exec,
    state,
    begin,
    tool,
    event,
    command,
    latest,
    messages,
    restoreModel,
    finishLinked,
    setHook: (next: Hook) => {
      hook = next;
    },
  };
}

test("fresh Linked restoration retains the uninitialized durable seed until bootstrap commits begin", async () => {
  const f = fixture();
  f.mock.entries.push(
    { customType: EXEC_ENTRY, data: structuredClone(f.state) },
    {
      customType: "plan-implementation-runtime",
      data: { model: "test/worker:medium", exec: structuredClone(f.state) },
    },
  );
  const seed = structuredClone(f.mock.entries);
  await f.event("session_start");
  assert.equal(f.exec.active, true, "startup exposes the seeded Exec overlay, never Work");
  assert.ok(f.exec.state?.negotiation?.executionId, "local failure recovery has a negotiation");
  assert.deepEqual(f.mock.entries, seed, "restoration must not make bootstrap look like a duplicate begin");
  assert.deepEqual(f.publications, [{ active: true, source: "restore" }]);
  f.mock.entries.push({ customType: "plan-implementation-runtime-consumed", data: {} });
  f.begin();
  assert.ok(f.latest().negotiation?.executionId);
  const identity = f.latest().negotiation?.executionId;
  await f.event("session_start");
  assert.equal(f.latest().negotiation?.executionId, identity, "ordinary restore preserves the committed identity");
});

test("a consumed failed fresh seed restores ordinary Exec recovery rather than deferring forever", async () => {
  const f = fixture();
  f.mock.entries.push(
    { customType: EXEC_ENTRY, data: structuredClone(f.state) },
    {
      customType: "plan-implementation-runtime",
      data: { model: "test/worker:medium", exec: structuredClone(f.state) },
    },
    { customType: "plan-implementation-runtime-consumed", data: {} },
  );
  await f.event("session_start");
  assert.ok(f.latest().negotiation?.executionId);
  assert.equal(f.exec.active, true);
});

function assertPending(s: ReturnType<typeof fixture>, completion: FinishDetails["completion"]) {
  assert.equal(s.exec.active, true);
  assert.equal(s.latest().active, true);
  assert.equal(s.latest().negotiation?.phase, "paused");
  assert.equal(s.latest().negotiation?.pause?.action, unavailable);
  assert.equal(s.latest().pendingCompletion?.completion, completion);
  assert.equal(s.latest().completion, undefined);
  assert.equal(s.restoreModel.mock.calls.length, 0);
  assert.equal(s.messages().length, 0);
  assert.ok(s.mock.rawPi.getActiveTools().includes(FINISH_TOOL));
  assert.ok(s.context.statuses.get(EXEC_STATUS_KEY)?.includes("completion pending"));
  assert.ok(!s.publications.some((entry) => (entry as { active: boolean }).active === false));
}

for (const action of ["finish", "stop"] as const) {
  test(`linked ${action} activates Work before committing exit exactly once`, async () => {
    const s = fixture({ review: false });
    s.begin();
    let commit!: () => void;
    let release!: (ok: boolean) => void;
    s.setHook(async (_ctx, completion, commitEnd) => {
      assert.equal(s.exec.active, true);
      assert.equal(completion.completion, action === "stop" ? "stopped" : "no_review");
      assert.equal(completion.planFile, s.state.planFile);
      assert.ok(s.latest().pendingCompletion);
      commit = commitEnd;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = action === "stop" ? s.command("stop") : s.tool(FINISH_TOOL);
    await vi.waitFor(() => assert.equal(typeof commit, "function"));
    assertPending(s, action === "stop" ? "stopped" : "no_review");
    s.ctx.model = work as never;
    commit();
    const saved = structuredClone(s.latest());
    commit();
    assert.deepEqual(s.latest(), saved);
    assert.equal(s.exec.active, false);
    release(true);
    await pending;
    commit();
    assert.equal(s.latest().pendingCompletion, undefined);
    assert.equal(s.latest().completion?.completion, action === "stop" ? "stopped" : "no_review");
    assert.equal(s.restoreModel.mock.calls.length, 0);
    assert.equal(s.messages().length, action === "stop" ? 1 : 0);
    assert.deepEqual(s.publications, [
      { active: true, source: "transition" },
      { active: false, source: "transition" },
    ]);
    assert.equal(s.context.statuses.get(EXEC_STATUS_KEY), undefined);
  });
}

for (const failure of ["false", "throw", "no commit", "missing hook", "missing coordinator"] as const) {
  test(`linked completion fails closed on ${failure} and retains accepted paid review`, async () => {
    let delayedCommit: (() => void) | undefined;
    const s = fixture({
      hook:
        failure === "missing hook"
          ? false
          : async (_ctx, _details, commit) => {
              delayedCommit = commit;
              if (failure === "throw") throw new Error("Work unavailable");
              return failure === "no commit";
            },
    });
    if (failure === "missing coordinator") s.coordinator.snapshot = undefined;
    s.begin();
    const result = await s.tool(FINISH_TOOL);
    assert.equal(result.content[0].text, unavailable);
    assert.equal(result.details?.completion, undefined, "do not render a false completion");
    assert.equal(result.terminate, true);
    assert.equal(result.usage?.cost.total, 0.05);
    assertPending(s, "accepted");
    assert.equal(s.latest().pendingCompletion?.decision?.outcome, "accepted");
    assert.equal(s.latest().negotiation?.attempts, 1);
    assert.equal(s.latest().negotiation?.reviewCostUsd, 0.05);
    const snapshot = structuredClone(s.latest());
    delayedCommit?.();
    assert.deepEqual(s.latest(), snapshot, "a callback retained by a failed hook expires");
    await s.event("session_start");
    assert.deepEqual(s.latest(), snapshot);
    assert.equal(s.prompts.length, 1);
  });
}

for (const retry of ["finish", "command", "continue"] as const) {
  test(`${retry} retries saved accepted completion after reload without review or budget changes`, async () => {
    const s = fixture({ hook: async () => false, replies: [decision("changes_requested"), decision()] });
    s.begin();
    await s.tool(FINISH_TOOL);
    await s.tool(FINISH_TOOL, {
      ...report,
      responses: [{ id: "F1", status: "addressed", response: "Added regression." }],
    });
    assertPending(s, "accepted");
    const intent = structuredClone(s.latest().pendingCompletion);
    const originalFlow = structuredClone(s.latest().linkedFlow);
    await s.event("session_shutdown");
    await s.event("session_start");
    assert.deepEqual(s.latest().pendingCompletion, intent);
    assert.deepEqual(s.latest().linkedFlow, originalFlow);
    assert.ok(s.coordinator.snapshot);
    s.coordinator.snapshot.revision++;
    s.setHook(async (_ctx, details, commit) => {
      assert.deepEqual(details, intent);
      commit();
      return true;
    });
    const result =
      retry === "finish"
        ? await s.tool(FINISH_TOOL, { ...report, report: "Must not replace saved report." })
        : retry === "continue"
          ? await s.tool(CONTINUE_TOOL, { action: "retry" })
          : await s.command("retry");
    assert.equal(s.prompts.length, 2);
    assert.deepEqual(s.latest().completion, intent);
    assert.equal(s.latest().negotiation?.attempts, 2);
    assert.equal(s.latest().negotiation?.revisionsUsed, 1);
    assert.equal(s.latest().negotiation?.reviewCostUsd, 0.1);
    assert.equal(s.latest().asks, 2);
    assert.equal(s.latest().costUsd, 0.2);
    assert.equal(s.latest().pendingCompletion, undefined);
    assert.equal(s.exec.active, false);
    assert.equal((result as Result | undefined)?.usage, undefined, "retry must not charge the paid review again");
    assert.equal(s.messages().length, retry === "command" ? 1 : 0);
    assert.equal(s.mock.sentUserMessages.length, 0, "completion retry never resumes implementation");
  });
}

for (const action of ["stop", "accept"] as const) {
  test(`authorized ${action} intent survives Work failure/reload without new approval or review`, async () => {
    const s = fixture({ hook: async () => false, replies: ["invalid"] });
    s.begin();
    await s.tool(FINISH_TOOL);
    const select = vi.fn(async () => "Finish without review");
    s.ctx.ui.select = select;
    await s.command(action);
    assertPending(s, action === "stop" ? "stopped" : "user_override");
    assert.equal(select.mock.calls.length, action === "accept" ? 1 : 0);
    const intent = structuredClone(s.latest().pendingCompletion);
    await s.event("session_start");
    s.setHook(async (_ctx, details, commit) => {
      assert.deepEqual(details, intent);
      commit();
      return true;
    });
    await s.command("retry");
    assert.deepEqual(s.latest().completion, intent);
    assert.equal(s.prompts.length, 1);
    assert.equal(select.mock.calls.length, action === "accept" ? 1 : 0);
    assert.equal(s.messages().length, 1);
    assert.equal(s.restoreModel.mock.calls.length, 0);
  });
}

for (const action of ["finish", "stop", "manual"] as const) {
  test(`explicit Independent permits historical Linked ${action} finalization with legacy restore semantics`, async () => {
    const s = fixture({ review: false, hook: async () => false });
    s.begin();
    if (action === "stop") await s.command("stop");
    else await s.tool(FINISH_TOOL);
    const intent = structuredClone(s.latest().pendingCompletion);
    assert.ok(s.coordinator.snapshot);
    s.coordinator.snapshot = { ...s.coordinator.snapshot, operatingMode: "independent", revision: 5 };
    if (action === "manual") s.ctx.model = { ...worker, id: "manual" } as never;
    await s.command("retry");
    assert.equal(s.exec.active, false);
    assert.equal(s.latest().completion?.completion, intent?.completion);
    assert.ok(s.latest().linkedFlow, "historical identity stays recorded");
    assert.equal(s.finishLinked.mock.calls.length, 1);
    assert.equal(s.restoreModel.mock.calls.length, action === "finish" ? 1 : 0);
    assert.equal(s.latest().completion?.returnedTo, action === "finish" ? "Original planner" : undefined);
  });
}

test("a new runtime restores the saved completion without another paid review", async () => {
  const first = fixture({ hook: async () => false });
  first.begin();
  await first.tool(FINISH_TOOL);
  const saved = structuredClone(first.latest());
  await first.event("session_shutdown");
  const replacement = fixture();
  replacement.mock.entries.push({ customType: EXEC_ENTRY, data: saved });
  await replacement.event("session_start");
  assert.deepEqual(replacement.exec.state, saved);
  await replacement.command("retry");
  assert.deepEqual(replacement.latest().completion, saved.pendingCompletion);
  assert.equal(replacement.prompts.length, 0);
  assert.equal(replacement.latest().negotiation?.reviewCostUsd, 0.05);
  assert.equal(replacement.messages().length, 1);
  assert.equal(first.latest().active, true, "the old runtime has no completion authority");
});

test("legacy state remains Independent even if an unrelated coordinator advertises Linked", async () => {
  const s = fixture({ linked: false, review: false });
  s.mock.entries.push({ customType: EXEC_ENTRY, data: s.state });
  await s.event("session_start");
  assert.equal(s.exec.state?.linkedFlow, undefined);
  await s.tool(FINISH_TOOL);
  assert.equal(s.exec.active, false);
  assert.equal(s.finishLinked.mock.calls.length, 0);
  assert.equal(s.restoreModel.mock.calls.length, 1);
});

test("linked state and getter are detached; restore keeps the assignments and revision", async () => {
  const s = fixture();
  const approved = structuredClone(s.state.linkedFlow);
  s.begin();
  assert.ok(s.state.linkedFlow?.selectedFlow);
  s.state.linkedFlow.selectedFlow.roles.work.modelId = "mutated input";
  const exposed = s.exec.state;
  assert.ok(exposed?.linkedFlow?.selectedFlow);
  exposed.linkedFlow.revision = 99;
  exposed.linkedFlow.selectedFlow.roles.exec.modelId = "mutated getter";
  assert.deepEqual(s.exec.state?.linkedFlow, approved);
  await s.event("session_start");
  assert.deepEqual(s.exec.state?.linkedFlow, approved);
  assert.equal(s.finishLinked.mock.calls.length, 0);
});

for (const change of ["tree", "shutdown", "begin"] as const) {
  test(`a completion callback cannot end execution after ${change}`, async () => {
    let commit!: () => void;
    let release!: (ok: boolean) => void;
    const s = fixture({
      review: false,
      hook: async (_ctx, _details, callback) => {
        commit = callback;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    s.begin();
    const pending = s.tool(FINISH_TOOL);
    await vi.waitFor(() => assert.equal(typeof commit, "function"));
    if (change === "begin") s.begin();
    else await s.event(change === "tree" ? "session_tree" : "session_shutdown");
    const saved = structuredClone(s.mock.entries);
    commit();
    release(true);
    await pending;
    assert.deepEqual(s.mock.entries, saved);
    assert.ok(!s.publications.some((entry) => (entry as { active: boolean }).active === false));
  });
}

for (const action of ["finish", "stop"] as const) {
  for (const interruption of ["tool signal", "context signal", "session identity"] as const) {
    test(`retained ${action} callback is fenced by ${interruption} before lifecycle delivery`, async () => {
      let commit!: () => void;
      let release!: (ok: boolean) => void;
      const s = fixture({
        review: false,
        hook: async (_ctx, _details, callback) => {
          commit = callback;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      });
      const controller = new AbortController();
      if (interruption === "context signal") Object.defineProperty(s.ctx, "signal", { value: controller.signal });
      s.ctx.ui.select = async () => "Stop implementation";
      s.begin();
      const pending = s.tool(
        action === "finish" ? FINISH_TOOL : CONTINUE_TOOL,
        action === "finish" ? report : { action: "stop" },
        interruption === "tool signal" ? controller.signal : undefined,
      );
      await vi.waitFor(() => assert.equal(typeof commit, "function"));
      const entries = structuredClone(s.mock.entries);
      if (interruption === "session identity") s.ctx.sessionManager.getSessionId = () => "replacement-session";
      else controller.abort();
      commit();
      release(true);
      await pending;
      commit();
      assert.deepEqual(s.mock.entries, entries);
      assertPending(s, action === "finish" ? "no_review" : "stopped");
    });
  }
}

for (const phase of ["finish", "stop"] as const) {
  for (const lifecycle of ["resume", "tree", "reload"] as const) {
    test(`plan host ${phase} uses the live flow revision after ${lifecycle} with unchanged assignments`, async () => {
      const original = fixture({ review: false });
      original.begin();
      const saved = structuredClone(original.latest());
      await original.event("session_shutdown");
      const mock = createMockPi();
      mock.entries.push({ customType: EXEC_ENTRY, data: saved });
      let flow: FlowSnapshot = {
        ...linkedFlow(),
        workflow: "exec",
        ready: true,
        guardAvailable: true,
        transitioning: false,
      };
      const requests: Extract<FlowRequest, { kind: "execution" }>[] = [];
      const context = createMockContext({
        mode: "tui",
        hasUI: true,
        cwd: original.ctx.cwd,
        model: worker,
        modelRegistry: original.ctx.modelRegistry,
        sessionManager: {
          getSessionId: () => "restored-session",
          getLeafId: () => `entry-${mock.entries.length}`,
          getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
          getSessionFile: () => "/fixture/restored.jsonl",
        },
      });
      mock.eventBus.on(FLOW_CHANNEL, (data) => {
        const request = data as FlowRequest;
        if (request.kind === "query") request.snapshot = structuredClone(flow);
        if (request.kind === "execution") {
          requests.push(request);
          assert.equal(request.phase, phase);
          assert.equal(request.expectedRevision, flow.revision);
          assert.equal(request.planFile, saved.planFile);
          request.result = Promise.resolve().then(() => {
            request.commit();
            flow = { ...flow, workflow: "work" };
            return { ok: true, snapshot: structuredClone(flow) };
          });
        }
      });
      await planMode(mock.pi, {
        readSettings: async () => ({ thinkingLevel: "inherit", jevToolSelection: false, completionReview: false }),
      });
      const event = async (name: string, reason?: string) => {
        for (const handler of mock.events.get(name) ?? []) await handler({ reason }, context.ctx);
      };
      await event("session_start", "startup");
      flow.revision += 10;
      if (lifecycle !== "tree") await event("session_shutdown", lifecycle);
      await event(lifecycle === "tree" ? "session_tree" : "session_start", lifecycle);
      const latest = () => mock.entries.filter((entry) => entry.customType === EXEC_ENTRY).at(-1)?.data as ExecState;
      assert.equal(latest().linkedFlow?.revision, saved.linkedFlow?.revision);
      assert.deepEqual(latest().linkedFlow?.selectedFlow, flow.selectedFlow);
      if (phase === "stop") await mock.commands.get("plan-exec")?.handler("stop", context.ctx);
      else {
        const tool = mock.tools.find((candidate) => candidate.name === FINISH_TOOL) as unknown as {
          execute(...args: unknown[]): Promise<Result>;
        };
        await tool.execute("finish", report, undefined, undefined, context.ctx);
      }
      assert.equal(requests.length, 1);
      assert.equal(latest().active, false);
      assert.equal(latest().completion?.completion, phase === "stop" ? "stopped" : "no_review");
      assert.equal(mock.setModels.length, 0, "Linked completion never uses the unprivileged planning-model restore");
      await event("session_shutdown");
    });
  }
}

test("pending completion refuses paid recovery and concurrent or aborted handoffs", async () => {
  let release!: (ok: boolean) => void;
  const s = fixture({
    review: false,
    hook: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  s.begin();
  const pending = s.tool(FINISH_TOOL);
  await vi.waitFor(() => assert.equal(typeof release, "function"));
  await s.tool(FINISH_TOOL);
  assert.equal(s.finishLinked.mock.calls.length, 1);
  release(false);
  await pending;
  const saved = structuredClone(s.latest());
  for (const action of ["resume human answer", "accept"]) await s.command(action);
  for (const action of ["extend", "answer"]) await s.tool(CONTINUE_TOOL, { action, replyId: "invented" });
  const controller = new AbortController();
  controller.abort();
  await s.tool(FINISH_TOOL, report, controller.signal);
  assert.deepEqual(s.latest(), saved);
  assert.equal(s.finishLinked.mock.calls.length, 1);
  assert.equal(s.prompts.length, 0);
  assert.equal(s.mock.sentUserMessages.length, 0);
});

test("footer status and /plan-exec status are notification-only, including pending and busy states", async () => {
  const s = fixture({ review: false, hook: async () => false });
  assert.equal(queryFooterActions(s.mock.eventBus)["execution.status"], undefined);
  s.begin();
  const select = vi.fn(async () => {
    throw new Error("Status must not open a recovery dialog");
  });
  s.ctx.ui.select = select;
  for (const paused of [false, true]) {
    if (paused) await s.tool(FINISH_TOOL);
    s.ctx.isIdle = () => false;
    const entries = structuredClone(s.mock.entries);
    const tools = s.mock.rawPi.getActiveTools();
    const action = queryFooterActions(s.mock.eventBus)["execution.status"];
    assert.ok(action);
    await action.run();
    const footerNotice = s.context.notifications.at(-1);
    await s.command("status");
    assert.deepEqual(s.context.notifications.at(-1), footerNotice);
    assert.match(footerNotice?.message ?? "", /\/plan-exec/u);
    if (paused) assert.ok(footerNotice?.message.startsWith(unavailable));
    assert.deepEqual(s.mock.entries, entries);
    assert.deepEqual(s.mock.rawPi.getActiveTools(), tools);
    assert.equal(s.context.editorText, "Keep this draft");
    assert.equal(s.mock.sentUserMessages.length, 0);
    assert.equal(s.mock.sentMessages.length, 0);
  }
  assert.equal(select.mock.calls.length, 0);
});

for (const lifecycle of ["session_tree", "session_start", "session_shutdown", "begin", "end"] as const) {
  test(`footer status ignores stale closures after ${lifecycle}`, async () => {
    const s = fixture({ review: false });
    s.begin();
    const action = queryFooterActions(s.mock.eventBus)["execution.status"];
    assert.ok(action);
    if (lifecycle === "begin") s.begin();
    else if (lifecycle === "end") await s.tool(FINISH_TOOL);
    else await s.event(lifecycle);
    const notices = s.context.notifications.length;
    await action.run();
    assert.equal(s.context.notifications.length, notices);
    if (lifecycle === "session_shutdown" || lifecycle === "end")
      assert.equal(queryFooterActions(s.mock.eventBus)["execution.status"], undefined);
  });
}
