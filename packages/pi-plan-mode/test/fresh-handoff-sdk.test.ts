import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionCommandContext,
  ExtensionRunner,
  type ExtensionUIContext,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished, test, vi } from "vitest";
import { LINKED_FRESH } from "../src/approval-picker.js";
import { EXEC_ENTRY, type ExecState } from "../src/exec.js";
import { FLOW_CHANNEL, FLOW_ENTRY, type FlowRequest, type FlowSnapshot, type FlowState } from "../src/flow-contract.js";
import { FRESH_HANDOFF_CHANNEL, type FreshHandoffRequest } from "../src/fresh-handoff.js";
import planMode from "../src/index.js";
import { EXIT_TOOL, INLINE_ENTRY, MODE_CHANGED, MODE_SET } from "../src/inline-plan.js";
import * as plannerSessions from "../src/planner/session.js";
import { createCustomSelectorHarness } from "./support.js";

initTheme("dark");

const PROVIDER = "fresh-handoff-local";
const PLAN = "# Local fresh handoff\n\n1. Implement only the approved change.";
const LIVE_SEED = "The live parent branch contains the consultant's requirements.";
const ABANDONED_SEED = "This abandoned branch must never seed the consultant.";
const RUNTIME_ENTRY = "plan-implementation-runtime";
const CONSUMED_ENTRY = "plan-implementation-runtime-consumed";
const TOOL_ID = "local-exit-plan";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Every awaited boundary has a local deadline, including detached host work. */
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function branchData<T>(manager: SessionManager, customType: string): T | undefined {
  const entry = [...manager.getBranch()]
    .reverse()
    .find((item) => item.type === "custom" && item.customType === customType);
  return entry?.type === "custom" ? (entry.data as T) : undefined;
}

type Generation = {
  command?: ExtensionCommandContext;
  flow: FlowSnapshot;
  executions: Extract<FlowRequest, { kind: "execution" }>[];
  workflows: string[];
  shutdown: boolean;
};

type RuntimeSeed = {
  model: string;
  exec: ExecState;
  consultant: { spec: string; name: string; messages: unknown[] };
};

/** Real AgentSession/ExtensionRunner; only the optional coordinator and host capability are fakes. */
async function fixture(options: { effort?: "high" | "off"; cancelReplacement?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "plan-fresh-sdk-"));
  const generations: Generation[] = [];
  const errors: unknown[] = [];
  const notes: string[] = [];
  const requests: Array<{ session: AgentSession; model: string; messages: unknown[] }> = [];
  const discoveries: Array<{ current: boolean; request: FreshHandoffRequest }> = [];
  const trace: string[] = [];
  const replacementOptions: Parameters<ExtensionCommandContext["newSession"]>[0][] = [];
  const legacy: unknown[] = [];
  const approvalChanges: unknown[] = [];
  const toolResult = deferred<ToolResultEvent>();
  const releaseTool = deferred();
  const settle = deferred<string>();
  const releaseSettle = deferred();
  const dialog = deferred<ReturnType<typeof createCustomSelectorHarness>>();
  const idleWait = deferred();
  const hostDone = deferred();
  let runtime: AgentSessionRuntime | undefined;
  let hostTask: Promise<void> | undefined;
  let turn: Promise<void> | undefined;
  let parentEntriesAtReplacement: unknown[] | undefined;
  let scheduled = 0;
  let idleCompletions = 0;
  let sessionBeforeSwitch = 0;
  let followupRequested = false;
  let app: ReturnType<typeof createCustomSelectorHarness> | undefined;

  onTestFinished(async () => {
    app?.handleInput("tui.select.cancel");
    releaseTool.resolve();
    releaseSettle.resolve();
    try {
      if (turn) await bounded(turn, "cleanup parent run");
      if (hostTask) await bounded(hostTask, "cleanup detached handoff");
      if (runtime) await bounded(runtime.dispose(), "cleanup runtime");
    } finally {
      app?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  vi.spyOn(plannerSessions, "plannerSessionDir").mockReturnValue(join(directory, "consultants"));
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("SDK fixture must never access the network");
  });
  const modelsPath = join(directory, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          api: "anthropic-messages",
          baseUrl: "http://fresh-handoff.invalid",
          apiKey: "local-test-placeholder",
          models: ["planner", "worker"].map((id) => ({
            id,
            name: `Local ${id}`,
            reasoning: true,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    }),
  );
  const models = await ModelRuntime.create({
    modelsPath,
    authPath: join(directory, "auth.json"),
    allowModelNetwork: false,
  });
  const planner = models.getModel(PROVIDER, "planner");
  const worker = models.getModel(PROVIDER, "worker");
  assert.ok(planner);
  assert.ok(worker);
  vi.spyOn(models, "getAvailableSnapshot").mockReturnValue([planner, worker]);
  const inference = [
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
    "streamDeferred",
    "fetchDeferred",
    "generateImages",
    "classify",
  ].map((method) =>
    vi.spyOn(models, method as "stream").mockImplementation(() => {
      throw new Error(`Unexpected model transport: ${method}`);
    }),
  );

  const create: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
    let generation!: Generation;
    const extension = async (pi: ExtensionAPI) => {
      generation = {
        shutdown: false,
        executions: [],
        workflows: [],
        flow: {
          version: 1,
          operatingMode: "linked",
          revision: 7,
          selectedFlow: {
            provider: PROVIDER,
            anchorModel: planner.id,
            roles: {
              work: { provider: PROVIDER, modelId: planner.id },
              chat: { provider: PROVIDER, modelId: planner.id },
              plan: { provider: PROVIDER, modelId: planner.id },
              exec: { provider: PROVIDER, modelId: worker.id, suggestedThinking: "medium" },
            },
          },
          workflow: "work",
          ready: true,
          guardAvailable: true,
          transitioning: false,
        },
      };
      const g = generation;
      generations.push(g);
      const snapshot = () => structuredClone(g.flow);
      pi.events.on(FLOW_CHANNEL, (data) => {
        const request = data as FlowRequest;
        if (request.kind === "query") request.snapshot = snapshot();
        else if (request.kind === "workflow" || request.kind === "execution") {
          request.result = (async () => {
            if (request.kind === "execution") {
              assert.equal(request.expectedRevision, g.flow.revision);
              g.executions.push(request);
              assert.equal(await pi.setModel(worker), true);
              assert.equal(request.commit(), undefined, "consumer commit is synchronous");
              g.flow.workflow = "exec";
            } else {
              g.workflows.push(request.workflow);
              assert.equal(await pi.setModel(planner), true);
              g.flow.workflow = request.workflow;
            }
            pi.events.emit(MODE_CHANGED, {
              mode: g.flow.workflow,
              cycle: ["work", "chat", "plan"],
              source: "transition",
            });
            return { ok: true, snapshot: snapshot() };
          })();
        }
      });
      pi.events.on("workflow-mode:query", (data) => {
        (data as { reply(value: unknown): void }).reply({ mode: g.flow.workflow, cycle: ["work", "chat", "plan"] });
      });
      pi.events.on(MODE_SET, (data) => legacy.push(data));
      pi.events.on("permission-mode:set", (data) => approvalChanges.push(data));
      pi.on("session_start", () => {
        const saved = branchData<FlowState>(sessionManager, FLOW_ENTRY);
        if (saved) Object.assign(g.flow, saved, { workflow: "exec" });
      });
      pi.on("session_before_switch", () => {
        sessionBeforeSwitch++;
        if (options.cancelReplacement) return { cancel: true };
      });
      pi.on("session_shutdown", () => {
        g.shutdown = true;
      });
      pi.events.on(FRESH_HANDOFF_CHANNEL, (data) => {
        const request = data as FreshHandoffRequest;
        assert.equal(request.version, 1);
        assert.equal(request.sessionManager, sessionManager);
        discoveries.push({ current: request.isCurrent(), request });
        // Discovery advertises availability even when it deliberately has no approval.
        // This fake owns only a narrow native replacement, not a tool/settle context.
        let accepted = false;
        const current = () => !g.shutdown && request.isCurrent();
        request.schedule = (run) => {
          if (accepted || !current()) return false;
          accepted = true;
          scheduled++;
          trace.push("accepted");
          hostTask = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              void (async () => {
                if (!current()) return;
                assert.ok(g.command);
                trace.push("waitForIdle");
                idleWait.resolve();
                await g.command.waitForIdle();
                idleCompletions++;
                trace.push("idle");
                if (!current()) return;
                let replaced = false;
                await run(async (replacement) => {
                  if (replaced || !current()) return { cancelled: true };
                  replaced = true;
                  assert.ok(g.command);
                  return g.command.newSession(replacement);
                });
              })().then(resolve, reject);
            }, 0);
          });
          void hostTask.then(
            () => hostDone.resolve(),
            (error) => {
              errors.push(error);
              hostDone.resolve();
            },
          );
          return true;
        };
      });
      await planMode(pi, {
        pickImplementationEffort: async () => ({ kind: "fallback", reason: "offline SDK fixture" }),
        readSettings: async () => ({
          thinkingLevel: "inherit",
          plansDirectory: join(directory, "plans"),
          jevToolSelection: false,
          renderedPlans: false,
          completionReview: false,
        }),
        createSession: async () => {
          throw new Error("No planner model calls in fresh handoff tests");
        },
      });
      // Register after production: the real runner must await both this tool result
      // and this later settle handler, not just plan-mode's completed settle hook.
      pi.on("tool_result", async (event, ctx) => {
        if (event.toolCallId !== TOOL_ID) return;
        assert.equal("newSession" in ctx, false);
        toolResult.resolve(event);
        await releaseTool.promise;
      });
      pi.on("agent_before_settle", async (event, ctx) => {
        assert.equal("newSession" in ctx, false);
        if (generations[0] !== g) return;
        settle.resolve(event.outcome);
        await releaseSettle.promise;
      });
    };
    const services = await createAgentSessionServices({
      cwd: directory,
      agentDir: directory,
      modelRuntime: models,
      settingsManager: SettingsManager.inMemory({
        cacheWarming: "off",
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: planner,
      thinkingLevel: options.effort ?? "high",
    });
    const session = result.session;
    assert.ok(session instanceof AgentSession);
    assert.ok(session.extensionRunner instanceof ExtensionRunner);
    session.agent.streamFunction = (model, context) => {
      assert.equal(model.provider, PROVIDER);
      requests.push({ session, model: model.id, messages: structuredClone(context.messages) });
      const parent = generation === generations[0];
      const callCount = requests.filter((request) => request.session === session).length;
      assert.ok(callCount <= (parent && followupRequested ? 2 : 1), "no automatic parent continuation");
      const review = parent && callCount === 1;
      const reason = review ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant",
        content: review
          ? [{ type: "toolCall", id: TOOL_ID, name: EXIT_TOOL, arguments: {} }]
          : [{ type: "text", text: "Local implementation response." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: reason,
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason, message });
        stream.end(message);
      });
      return stream;
    };
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const manager = SessionManager.inMemory(directory);
  manager.appendMessage({ role: "user", content: ABANDONED_SEED, timestamp: 1 });
  manager.resetLeaf();
  manager.appendMessage({ role: "user", content: LIVE_SEED, timestamp: 2 });
  runtime = await createAgentSessionRuntime(create, { cwd: directory, agentDir: directory, sessionManager: manager });
  const ui = {
    setWidget() {},
    setStatus() {},
    setWorkingVisible() {},
    onTerminalInput: () => () => {},
    notify: (message: string) => notes.push(message),
    custom: (factory: unknown) => {
      app = createCustomSelectorHarness(factory, 140, undefined, 40);
      dialog.resolve(app);
      return app.resultPromise;
    },
  } as unknown as ExtensionUIContext;
  const bind = async (session: AgentSession) => {
    await session.bindExtensions({
      mode: "tui",
      uiContext: ui,
      onError: (error) => errors.push(error),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        fork: (...args) => {
          assert.ok(runtime);
          return runtime.fork(...args);
        },
        navigateTree: (...args) => session.navigateTree(...args),
        switchSession: (...args) => {
          assert.ok(runtime);
          return runtime.switchSession(...args);
        },
        reload: () => session.reload(),
        newSession: async (replacement) => {
          replacementOptions.push(replacement);
          trace.push("replace");
          parentEntriesAtReplacement = structuredClone(session.sessionManager.getEntries());
          assert.ok(runtime);
          return runtime.newSession(replacement);
        },
      },
    });
    const g = generations.at(-1);
    assert.ok(g);
    g.command = session.extensionRunner.createCommandContext();
  };
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  const parent = runtime.session;
  const toolContexts = vi.spyOn(parent.extensionRunner, "createToolContext");
  await bounded(parent.prompt("/plan"), "enter Plan through command runner");
  const inline = () => branchData<{ active: boolean; planFile: string }>(manager, INLINE_ENTRY);
  const planFile = inline()?.planFile;
  assert.ok(planFile);
  writeFileSync(planFile, PLAN);

  const assertParent = async () => {
    assert.equal(runtime?.session, parent);
    assert.equal(parent.model?.id, "planner");
    assert.equal(parent.thinkingLevel, options.effort ?? "high");
    assert.equal(generations[0]?.flow.workflow, "plan");
    assert.equal(inline()?.active, true);
    assert.notEqual(branchData<ExecState>(manager, EXEC_ENTRY)?.active, true);
    assert.equal(generations[0]?.executions.length, 0, "parent never activates worker");
    const guard = await parent.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "guard-probe",
      toolName: "write",
      input: { path: join(directory, "source.ts"), content: "not authorized" },
    });
    assert.equal(guard?.block, true, "actual production Plan guard remains active");
  };
  const start = async (cancel = false) => {
    turn = parent.prompt("Review and approve the local plan.");
    // Attach a rejection handler immediately; bounded() below still reports failure.
    void turn.catch(() => {});
    const picker = await bounded(dialog.promise, "actual tool-opened approval dialog");
    assert.match(picker.render().join("\n"), new RegExp(LINKED_FRESH));
    assert.deepEqual(
      discoveries.map((item) => item.current),
      [false],
    );
    assert.equal(scheduled, 0, "availability discovery is not approval");
    if (cancel) picker.handleInput("tui.select.cancel");
    else {
      picker.handleInput("tui.select.down");
      const selected = picker.handleInput("tui.select.down").join("\n");
      assert.match(selected, /→ Execute in a fresh conversation/u);
      assert.match(selected, /effort: medium/u);
      picker.handleInput("tui.select.confirm");
    }
    const result = await bounded(toolResult.promise, "actual held tool result");
    const call = toolContexts.mock.calls.findIndex(([id]) => id === TOOL_ID);
    assert.notEqual(call, -1, "the SDK creates the actual tool execution context");
    const context = toolContexts.mock.results[call];
    assert.equal(context?.type, "return");
    assert.equal("newSession" in context.value, false, "tool execution has no native replacement capability");
    return result;
  };
  const finishTurn = async (expectSettle = true) => {
    releaseTool.resolve();
    if (expectSettle) await bounded(settle.promise, "later awaited settle handler");
    releaseSettle.resolve();
    assert.ok(turn);
    await bounded(turn, "parent settles without deadlock");
  };
  const assertClean = () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(legacy, [], "no uncoordinated workflow requests");
    assert.deepEqual(approvalChanges, [], "fresh handoff never changes permissions");
    assert.equal(network.mock.calls.length, 0);
    for (const spy of inference) assert.equal(spy.mock.calls.length, 0);
  };
  return {
    directory,
    runtime,
    parent,
    manager,
    generations,
    discoveries,
    requests,
    notes,
    trace,
    replacementOptions,
    start,
    finishTurn,
    followUp: async () => {
      followupRequested = true;
      await bounded(parent.prompt("Continue planning without approving implementation."), "post-abort planning turn");
    },
    assertParent,
    assertClean,
    releaseTool,
    settle,
    releaseSettle,
    idleWait,
    hostDone,
    scheduled: () => scheduled,
    idleCompletions: () => idleCompletions,
    beforeSwitches: () => sessionBeforeSwitch,
    parentEntriesAtReplacement: () => parentEntriesAtReplacement,
  };
}

for (const effort of ["high", "off"] as const) {
  test(`SDK tool approval fresh waits for the entire run, then bootstraps once (${effort} parent)`, async () => {
    const f = await fixture({ effort });
    const result = await f.start();
    assert.equal((result.details as { outcome: string }).outcome, "handoff");
    assert.match(JSON.stringify(result.content), /fresh conversation after this turn settles/u);
    assert.equal(f.scheduled(), 0);
    assert.equal(f.replacementOptions.length, 0);
    await f.assertParent();

    f.releaseTool.resolve();
    assert.equal(await bounded(f.settle.promise, "completed settle"), "completed");
    await bounded(f.idleWait.promise, "detached timer starts idle wait");
    assert.deepEqual(
      f.discoveries.map((item) => item.current),
      [false, true],
      "scheduler rediscovered at settle",
    );
    assert.equal(f.scheduled(), 1, "synchronous acceptance does not block the next settle handler");
    assert.equal(f.idleCompletions(), 0, "later handler still owns the actual run");
    assert.equal(f.replacementOptions.length, 0);
    await f.assertParent();

    await f.finishTurn();
    const parentMessages = structuredClone(f.manager.buildSessionProjection().messages);
    await bounded(f.hostDone.promise, "native fresh replacement and child bootstrap");
    assert.equal(f.replacementOptions.length, 1);
    assert.equal(f.beforeSwitches(), 1);
    assert.deepEqual(f.trace, ["accepted", "waitForIdle", "idle", "replace"]);
    assert.equal(f.generations.length, 2);
    const child = f.runtime.session;
    assert.notEqual(child, f.parent);
    assert.equal(child.model?.id, "worker");
    assert.equal(child.thinkingLevel, "medium");
    const seed = branchData<RuntimeSeed>(child.sessionManager, RUNTIME_ENTRY);
    assert.ok(seed);
    assert.equal(seed.model, `${PROVIDER}/worker:medium`);
    assert.equal(seed.consultant.spec, `${PROVIDER}/planner:${effort}`);
    assert.deepEqual(seed.consultant.messages, parentMessages);
    assert.match(JSON.stringify(seed.consultant.messages), new RegExp(LIVE_SEED));
    assert.doesNotMatch(JSON.stringify(seed.consultant.messages), new RegExp(ABANDONED_SEED));
    assert.ok(seed.consultant.messages.some((message) => (message as { role?: string }).role === "toolResult"));
    assert.equal(f.manager.getSessionFile(), undefined, "nonempty live branch needs no parent file");
    assert.deepEqual(f.manager.getEntries(), f.parentEntriesAtReplacement(), "child bootstrap never writes to parent");
    assert.notEqual(branchData<ExecState>(f.manager, EXEC_ENTRY)?.active, true);
    assert.equal(f.generations[0]?.executions.length, 0);
    assert.equal(f.generations[1]?.executions.length, 1);
    const exec = branchData<ExecState>(child.sessionManager, EXEC_ENTRY);
    assert.equal(exec?.active, true);
    assert.ok(exec?.negotiation?.executionId);
    assert.ok(exec?.planner?.sessionFile);
    assert.match(readFileSync(exec.planner.sessionFile, "utf8"), new RegExp(LIVE_SEED));
    assert.equal(
      child.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === CONSUMED_ENTRY)
        .length,
      1,
    );
    assert.deepEqual(
      f.requests.map((request) => request.model),
      ["planner", "worker"],
    );
    assert.match(JSON.stringify(f.requests[1]?.messages), /Implement only the approved change/u);
    assert.doesNotMatch(JSON.stringify(f.requests[1]?.messages), new RegExp(LIVE_SEED));
    f.assertClean();
  });
}

test("SDK tool dialog cancellation retains Plan and never schedules replacement", async () => {
  const f = await fixture();
  const result = await f.start(true);
  assert.equal((result.details as { outcome: string }).outcome, "kept");
  await f.finishTurn();
  assert.equal(f.scheduled(), 0);
  assert.equal(f.replacementOptions.length, 0);
  assert.equal(f.discoveries.length, 1);
  await f.assertParent();
  f.assertClean();
});

test("SDK abort while the approved tool result is held never schedules replacement", async () => {
  const f = await fixture();
  await f.start();
  const aborted = f.parent.abort();
  // Native abort can skip the actionable settle boundary entirely.
  await f.finishTurn(false);
  await bounded(aborted, "native abort completes");
  await f.followUp();
  assert.equal(f.scheduled(), 0, "an aborted approval must not revive on a later completed turn");
  assert.equal(f.replacementOptions.length, 0);
  await f.assertParent();
  f.assertClean();
});

test("SDK native session-before-switch cancellation leaves the approved parent guarded", async () => {
  const f = await fixture({ cancelReplacement: true });
  await f.start();
  await f.finishTurn();
  await bounded(f.hostDone.promise, "cancelled native replacement");
  assert.equal(f.beforeSwitches(), 1);
  assert.equal(f.replacementOptions.length, 1);
  assert.equal(f.generations.length, 1);
  assert.equal(f.requests.length, 1);
  await f.assertParent();
  f.assertClean();
});
