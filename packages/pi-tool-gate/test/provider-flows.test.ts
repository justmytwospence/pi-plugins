import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  FLOW_BUSY, FLOW_RECOVERY, FLOW_TRANSITION, ROLE_MODEL, ProviderFlowController, isPhysicalChatModel,
  parseFlowState, parseProviderFlow, resolveProviderFlow, restoreFlowState, validateProviderFlow,
  type FlowHost, type FlowModelLease,
} from "../src/provider-flows.ts";
import {
  FLOW_ENTRY, type FlowBus, type FlowExecution, type FlowState, type FlowWorkflow, type ProviderFlow,
} from "../src/flow-contract.ts";

const phases = ["work", "chat", "plan", "exec"] as const;
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PLAN = "/project/plans/approved.md";
type ChatModel = Model<Api>;
type Role = "general" | "planner" | "worker";
type RoleReply = { model: string; thinking?: string };
type RoleRequest = {
  role: Role;
  parent: string;
  thinking: string;
  cwd: string;
  availableModels: { provider: string; id: string }[];
  reply?: RoleReply;
};
type Entry = { id: string; type: string; customType?: string; data?: unknown };
type Permit = { target: { provider: string; id: string }; revision: number };

function model(provider = "alpha", id = "general", overrides: Partial<ChatModel> = {}): ChatModel {
  return {
    provider, id, name: id, api: "openai-completions", baseUrl: "https://unused.invalid",
    input: ["text"], reasoning: true, contextWindow: 100_000, maxTokens: 8_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides,
  };
}
function catalog(provider = "alpha"): ChatModel[] {
  return ["worker", "start", "planner", "general", "alternate"].map(id => model(provider, id));
}
function flow(provider = "alpha"): ProviderFlow {
  return {
    provider, anchorModel: "start",
    roles: {
      work: { provider, modelId: "general", suggestedThinking: "medium" },
      chat: { provider, modelId: "general", suggestedThinking: "medium" },
      plan: { provider, modelId: "planner", suggestedThinking: "low" },
      exec: { provider, modelId: "worker", suggestedThinking: "high" },
    },
  };
}
function linked(selectedFlow = flow(), revision = 4): FlowState {
  return { version: 1, operatingMode: "linked", revision, selectedFlow };
}
function custom(customType: string, data: unknown, id = customType): Entry {
  return { id, type: "custom", customType, data };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** No extension factory, SDK runtime, filesystem, timers, or model transport is involved. */
function harness() {
  const runtime = {
    model: model("alpha", "start") as ChatModel | undefined,
    thinking: "high",
    workflow: "work" as FlowWorkflow,
    replanning: false,
    idle: true,
    roleReady: true as boolean | undefined,
    roleListener: true,
    guardPresent: true,
    session: "session-a",
    entries: [custom("tool-gate:approvals", { version: 1, mode: "default" }, "root")],
    available: [...catalog(), ...catalog("beta")],
    roles: Object.fromEntries(["alpha", "beta"].map(provider => [provider, {
      general: { model: `${provider}/general`, thinking: "medium" },
      planner: { model: `${provider}/planner`, thinking: "low" },
      worker: { model: `${provider}/worker`, thinking: "high" },
    }])) as Record<string, Partial<Record<Role, RoleReply>>>,
    beforeSet: undefined as ((target: ChatModel) => Promise<void>) | undefined,
    ceilings: {} as Record<string, string>,
    approvals: { mode: "default", scope: ["project"] },
  };
  const requests: RoleRequest[] = [];
  const authorizations: Permit[] = [];
  const trace: string[] = [];
  let permit: Permit | undefined;
  let serial = 0;
  let controller!: ProviderFlowController;
  const append = (type: string, data: unknown, customType?: string) => {
    runtime.entries.push({ id: `entry-${++serial}`, type, data, ...(customType ? { customType } : {}) });
  };
  const events: FlowBus = {
    emit: vi.fn((channel: string, value: unknown) => {
      expect(channel).toBe(ROLE_MODEL);
      const request = value as RoleRequest;
      requests.push(structuredClone(request));
      if (runtime.roleListener) request.reply = runtime.roles[request.parent.split("/")[0]!]?.[request.role];
    }),
  };
  const getAvailable = vi.fn(async () => [...runtime.available]);
  const getAll = vi.fn(() => { throw new Error("Unauthenticated catalog must not be used"); });
  const manager = {
    getSessionId: () => runtime.session,
    getLeafId: () => runtime.entries.at(-1)?.id ?? null,
    getBranch: () => runtime.entries,
  };
  // getAvailable is deliberately asynchronous, and model is a live getter like the host.
  // The cast is only the SDK boundary: the controller needs this structural subset.
  const ctx = {
    cwd: "/project/destination",
    get model() { return runtime.model; },
    isIdle: () => runtime.idle,
    sessionManager: manager,
    modelRegistry: { getAvailable, getAll },
  } as unknown as ExtensionContext;
  const lease: FlowModelLease = {
    available: true,
    pauseAvailable: true,
    pause: vi.fn(() => true),
    async apply<T>(target: Permit["target"], revision: number, run: () => Promise<T>): Promise<T> {
      expect(lease.available).toBe(true);
      expect(controller.guardPolicy()).toEqual({ linked: true, revision });
      expect(permit).toBeUndefined();
      permit = { target: { ...target }, revision };
      authorizations.push(structuredClone(permit));
      trace.push(`apply:${target.provider}/${target.id}@${revision}`);
      try { return await run(); }
      finally { permit = undefined; }
    },
    dispose: vi.fn(() => { lease.available = false; trace.push("dispose"); }),
  };
  const setModel = vi.fn(async (target: ChatModel) => {
    expect(permit).toEqual({ target: { provider: target.provider, id: target.id }, revision: controller.guardPolicy().revision });
    permit = undefined;
    trace.push(`set:start:${target.provider}/${target.id}`);
    await runtime.beforeSet?.(target);
    runtime.model = target;
    // Simulate the native setter's per-model default; the coordinator must restore effort.
    runtime.thinking = "low";
    append("model_change", { provider: target.provider, modelId: target.id });
    trace.push(`set:end:${target.provider}/${target.id}`);
    return true;
  });
  const setThinking = vi.fn((requested: string) => {
    const current = runtime.model;
    const ceiling = current ? runtime.ceilings[`${current.provider}/${current.id}`] : undefined;
    runtime.thinking = current?.reasoning === false ? "off"
      : ceiling && levels.indexOf(requested as typeof levels[number]) > levels.indexOf(ceiling as typeof levels[number]) ? ceiling : requested;
    append("thinking_level_change", { thinkingLevel: runtime.thinking });
    trace.push(`thinking:${requested}->${runtime.thinking}`);
  });
  const persist = vi.fn((state: FlowState) => {
    append("custom", structuredClone(state), FLOW_ENTRY);
    trace.push(`persist:${state.operatingMode}@${state.revision}`);
  });
  const changed = vi.fn();
  const host: FlowHost = {
    events, workflow: () => runtime.workflow, replanning: () => runtime.replanning, lease: () => runtime.guardPresent ? lease : undefined,
    setModel, getThinking: () => runtime.thinking, setThinking, persist, changed,
    roleReady: () => runtime.roleReady,
  };
  controller = new ProviderFlowController(host);
  const commitWorkflow = (workflow: FlowWorkflow) => vi.fn(() => {
    trace.push(`commit:${workflow}`);
    runtime.workflow = workflow;
  });
  return {
    runtime, requests, authorizations, trace, events, getAvailable, getAll, manager, ctx, lease, host,
    controller, setModel, setThinking, persist, changed, append, commitWorkflow,
    async start(entries: Entry[] = runtime.entries) {
      runtime.entries = entries;
      return controller.restore(entries, ctx);
    },
    async select(provider = "alpha") {
      const result = await controller.selectProvider(provider, ctx);
      expect(result.ok, result.error).toBe(true);
      return result;
    },
  };
}
type Harness = ReturnType<typeof harness>;
async function selected(workflow: FlowWorkflow = "work") {
  const h = harness();
  h.runtime.workflow = workflow;
  expect((await h.start()).ok).toBe(true);
  await h.select();
  return h;
}
function durable(h: Harness) {
  return structuredClone({
    snapshot: h.controller.snapshot(), model: h.runtime.model, thinking: h.runtime.thinking,
    entries: h.runtime.entries, approvals: h.runtime.approvals,
  });
}
function execution(h: Harness, phase: FlowExecution["phase"] = "begin", planFile = PLAN): Omit<FlowExecution, "commit"> {
  return { phase, expectedRevision: h.controller.snapshot().revision, planFile };
}
async function executing() {
  const h = await selected("plan");
  const begin = vi.fn(() => {
    h.runtime.workflow = "exec";
    h.append("custom", { active: true, planFile: PLAN }, "plan-mode:exec");
  });
  const result = await h.controller.runExecutionTransition(execution(h), h.ctx, begin);
  expect(result.ok, result.error).toBe(true);
  expect(begin).toHaveBeenCalledOnce();
  return h;
}

describe("same-task replanning lifecycle", () => {
  const DRAFT = "/project/plans/revised.md";
  const task = (h: Harness, suspended = false) => ({
    active: true, planFile: PLAN, linkedFlow: h.controller.snapshot(),
    negotiation: { executionId: "task-1", planRevision: 1 },
    ...(suspended ? { replanning: { version: 1, draftFile: DRAFT } } : {}),
  });
  const request = (h: Harness, phase: "replan" | "resume" | "stop" | "finish") => ({
    ...execution(h, phase, phase === "resume" ? DRAFT : PLAN),
    expectedExecutionId: "task-1", expectedPlanRevision: 1,
  });
  const setupTask = async (suspended = false) => {
    const h = await executing();
    h.append("custom", task(h, suspended), "plan-mode:exec");
    if (suspended) { h.runtime.workflow = "plan"; h.runtime.replanning = true; h.runtime.model = model("alpha", "planner"); }
    return h;
  };
  test("replan and resume activate planner/worker before commit without replacing the task flow", async () => {
    const h = await setupTask();
    const captured = structuredClone(h.controller.snapshot().selectedFlow);
    const suspend = vi.fn(() => {
      expect(h.runtime.model?.id).toBe("planner");
      h.runtime.workflow = "plan";
      h.runtime.replanning = true;
      h.append("custom", task(h, true), "plan-mode:exec");
    });
    expect((await h.controller.runExecutionTransition(request(h, "replan"), h.ctx, suspend)).ok).toBe(true);
    expect(h.controller.snapshot()).toMatchObject({ workflow: "plan", replanning: true });
    const resume = vi.fn(() => {
      expect(h.runtime.model?.id).toBe("worker");
      h.runtime.workflow = "exec";
      h.runtime.replanning = false;
      h.append("custom", { ...task(h), planFile: DRAFT, negotiation: { executionId: "task-1", planRevision: 2 } }, "plan-mode:exec");
    });
    expect((await h.controller.runExecutionTransition(request(h, "resume"), h.ctx, resume)).ok).toBe(true);
    expect(h.controller.snapshot().selectedFlow).toEqual(captured);
    expect(h.controller.snapshot()).not.toHaveProperty("replanning");
    expect(h.persist).toHaveBeenCalledOnce(); // Lifecycle cannot rewrite the provider selection.
    expect(suspend).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });
  test("stop from suspended Plan activates Work and legacy optional completion fences still work", async () => {
    const h = await setupTask(true);
    const stop = vi.fn(() => {
      expect(h.runtime.model?.id).toBe("general");
      h.runtime.workflow = "work";
      h.runtime.replanning = false;
      h.append("custom", { active: false }, "plan-mode:exec");
    });
    expect((await h.controller.runExecutionTransition(execution(h, "stop"), h.ctx, stop)).ok).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });
  test.each(["begin", "finish", "replan"] as const)("%s cannot bypass suspended Plan, even on the same physical model", async phase => {
    const h = await setupTask(true);
    h.runtime.model = model("alpha", "worker");
    const before = h.setModel.mock.calls.length;
    const commit = vi.fn();
    expect((await h.controller.runExecutionTransition({ ...request(h, "replan"), phase }, h.ctx, commit)).ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(h.setModel).toHaveBeenCalledTimes(before);
  });
  test.each(["replan", "resume"] as const)("%s validates required identity, safe revision, plan file and immutable assignments before activation", async phase => {
    for (const invalid of ["missing-id", "wrong-id", "missing-revision", "zero", "fraction", "unsafe", "wrong-revision", "file", "flow"]) {
      const h = await setupTask(phase === "resume");
      const input = request(h, phase);
      if (invalid === "missing-id") delete (input as Partial<typeof input>).expectedExecutionId;
      if (invalid === "wrong-id") input.expectedExecutionId = "another-task";
      if (invalid === "missing-revision") delete (input as Partial<typeof input>).expectedPlanRevision;
      if (invalid === "zero") input.expectedPlanRevision = 0;
      if (invalid === "fraction") input.expectedPlanRevision = 1.5;
      if (invalid === "unsafe") input.expectedPlanRevision = Number.MAX_SAFE_INTEGER + 1;
      if (invalid === "wrong-revision") input.expectedPlanRevision = 2;
      if (invalid === "file") input.planFile = phase === "resume" ? PLAN : DRAFT;
      if (invalid === "flow") h.append("custom", { ...task(h, phase === "resume"), linkedFlow: linked(flow("beta")) }, "plan-mode:exec");
      const calls = h.setModel.mock.calls.length;
      const commit = vi.fn();
      const result = await h.controller.runExecutionTransition(input, h.ctx, commit);
      expect(result.ok, invalid).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      expect(h.setModel).toHaveBeenCalledTimes(calls);
    }
  });
  test("legacy execution revision defaults to one, but malformed durable revisions cannot resume", async () => {
    const h = await setupTask();
    h.append("custom", { ...task(h), negotiation: { executionId: "task-1" } }, "plan-mode:exec");
    expect((await h.controller.runExecutionTransition(request(h, "replan"), h.ctx, h.commitWorkflow("plan"))).ok).toBe(true);
    for (const revision of [0, null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await setupTask(true);
      invalid.append("custom", { ...task(invalid, true), negotiation: { executionId: "task-1", planRevision: revision } }, "plan-mode:exec");
      expect((await invalid.controller.runExecutionTransition(request(invalid, "resume"), invalid.ctx, vi.fn())).ok).toBe(false);
    }
  });
  test("a bus caller cannot retarget expected task identity during an awaited activation", async () => {
    const h = await setupTask();
    const entered = deferred();
    const release = deferred();
    h.getAvailable.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return h.runtime.available; });
    const input = request(h, "replan");
    const commit = vi.fn();
    const pending = h.controller.runExecutionTransition(input, h.ctx, commit);
    await entered.promise;
    input.expectedExecutionId = "replacement";
    h.append("custom", { ...task(h), negotiation: { executionId: "replacement", planRevision: 1 } }, "plan-mode:exec");
    release.resolve();
    expect((await pending).ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
  test.each(["replan", "resume"] as const)("%s is one-shot even when queued twice", async phase => {
    const h = await setupTask(phase === "resume");
    const commit = vi.fn(() => {
      h.runtime.workflow = phase === "replan" ? "plan" : "exec";
      h.runtime.replanning = phase === "replan";
      h.append("custom", task(h, phase === "replan"), "plan-mode:exec");
    });
    const input = request(h, phase);
    const results = await Promise.all([
      h.controller.runExecutionTransition(input, h.ctx, commit),
      h.controller.runExecutionTransition(input, h.ctx, commit),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, false]);
    expect(commit).toHaveBeenCalledOnce();
  });
  test.each(["replan", "resume"] as const)("%s rechecks identity/revision/draft/assignments across catalog and model awaits", async phase => {
    for (const boundary of ["catalog", "model"]) for (const change of ["id", "revision", "draft", "flow", "inactive"]) {
      const h = await setupTask(phase === "resume");
      if (change === "draft" && phase === "replan") continue;
      const entered = deferred();
      const release = deferred();
      if (boundary === "catalog") h.getAvailable.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return h.runtime.available; });
      else h.runtime.beforeSet = async () => { entered.resolve(); await release.promise; };
      const commit = vi.fn();
      const pending = h.controller.runExecutionTransition(request(h, phase), h.ctx, commit);
      await entered.promise;
      const next = task(h, phase === "resume");
      if (change === "id") next.negotiation.executionId = "replacement";
      if (change === "revision") next.negotiation.planRevision++;
      if (change === "draft") next.replanning = { version: 1, draftFile: "/other.md" };
      if (change === "flow") next.linkedFlow = { ...next.linkedFlow, selectedFlow: flow("beta") };
      if (change === "inactive") next.active = false;
      h.append("custom", next, "plan-mode:exec");
      release.resolve();
      expect((await pending).ok, boundary + change).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      if (boundary === "model") expect(h.controller.snapshot().blocked).toMatch(/after model mutation/u);
    }
  });
  test.each([null, false, true, {}, [], { version: 2, draftFile: DRAFT }, { version: 1, draftFile: "" }, { version: 1, draftFile: PLAN }])("corrupt suspension %j never authorizes implementation or a replacement begin", async marker => {
    const h = await setupTask(true);
    h.append("custom", { ...task(h), replanning: marker }, "plan-mode:exec");
    for (const phase of ["begin", "resume", "stop"] as const) {
      const commit = vi.fn();
      const result = await h.controller.runExecutionTransition({ ...request(h, "resume"), phase }, h.ctx, commit);
      expect(result.error).toBe("Replanning state is invalid; no implementation was resumed.");
      expect(commit).not.toHaveBeenCalled();
    }
  });
  test("restored suspended task reconciles onto planner; explicit Independent preserves suspension and rejects provider/base-workflow bypasses", async () => {
    const h = await setupTask(true);
    expect((await h.controller.restore(h.runtime.entries, h.ctx)).ok).toBe(true);
    expect(h.runtime.model?.id).toBe("planner");
    expect(h.controller.snapshot()).toMatchObject({ workflow: "plan", replanning: true });
    expect((await h.controller.selectProvider("beta", h.ctx)).ok).toBe(false);
    expect((await h.controller.prepareWorkflow("work", h.ctx)).ok).toBe(false);
    expect((await h.controller.setIndependent(h.ctx)).ok).toBe(true);
    expect(h.controller.snapshot()).toMatchObject({ operatingMode: "independent", workflow: "plan", replanning: true });
    expect((await h.controller.selectProvider("alpha", h.ctx)).ok).toBe(false);
    expect((await h.controller.prepareWorkflow("chat", h.ctx)).ok).toBe(false);
    expect((await h.controller.runExecutionTransition(request(h, "resume"), h.ctx, vi.fn())).ok).toBe(false);
    expect(h.runtime.entries.filter(entry => entry.customType === "plan-mode:exec").at(-1)?.data).toMatchObject({ active: true, replanning: { draftFile: DRAFT } });
  });
  test.each(["discovery", "activation"] as const)("provider selection fences replanning appearing during %s even when workflow remains Plan", async boundary => {
    const h = await selected("plan");
    const entered = deferred();
    const release = deferred();
    if (boundary === "discovery") h.getAvailable.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return h.runtime.available; });
    else h.runtime.beforeSet = async () => { entered.resolve(); await release.promise; };
    const pending = h.controller.selectProvider("beta", h.ctx);
    await entered.promise;
    h.runtime.replanning = true;
    release.resolve();
    expect((await pending).ok).toBe(false);
    expect(h.persist).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().selectedFlow?.provider).toBe("alpha");
  });
});

// These helpers validate durable plain data independently of any controller lifecycle.
describe("pure flow parsing and restoration", () => {
  test("parses detached assignments, strips unrelated metadata, and permits optional effort", () => {
    const original = flow();
    const input = { ...original, ignored: "metadata", roles: { ...original.roles, unused: {} } };
    const parsed = parseProviderFlow(input)!;
    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(input);
    expect(parsed.roles.work).not.toBe(input.roles.work);
    expect(parsed.roles.work).not.toBe(parsed.roles.chat);
    parsed.roles.plan.modelId = "mutated";
    expect(original.roles.plan.modelId).toBe("planner");
    for (const phase of phases) delete original.roles[phase].suggestedThinking;
    expect(parseProviderFlow(original)).toEqual(original);
  });

  test.each(levels)("accepts the supported %s thinking suggestion", thinking => {
    const input = flow();
    for (const phase of phases) input.roles[phase].suggestedThinking = thinking;
    expect(parseProviderFlow(input)).toEqual(input);
  });

  test.each([
    undefined, null, [], "alpha", 1, {},
    { ...flow(), provider: "" }, { ...flow(), provider: 1 },
    { ...flow(), anchorModel: "" }, { ...flow(), anchorModel: null },
    { ...flow(), roles: [] }, { ...flow(), roles: null },
  ])("rejects malformed provider-flow data: %j", value => {
    expect(parseProviderFlow(value)).toBeUndefined();
  });

  test.each(phases)("requires a valid provider-local %s assignment", phase => {
    for (const invalid of [undefined, null, [], {}, { provider: "beta", modelId: "general" },
      { provider: "alpha", modelId: "" }, { provider: "alpha", modelId: 12 },
      { provider: "alpha", modelId: "general", suggestedThinking: "automatic" },
      { provider: "alpha", modelId: "general", suggestedThinking: false }]) {
      const input = { ...flow(), roles: { ...flow().roles, [phase]: invalid } };
      expect(parseProviderFlow(input)).toBeUndefined();
    }
  });

  test("Work and Chat must be the same General assignment, including effort", () => {
    const input = flow();
    input.roles.chat.modelId = "alternate";
    expect(parseProviderFlow(input)).toBeUndefined();
    input.roles.chat = { ...input.roles.work, suggestedThinking: "high" };
    expect(parseProviderFlow(input)).toBeUndefined();
  });

  test.each([
    undefined, null, [], {},
    { ...linked(), version: 2 }, { ...linked(), version: "1" },
    { ...linked(), operatingMode: "auto" }, { ...linked(), operatingMode: null },
    ...[-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "4", undefined].map(revision => ({ ...linked(), revision })),
  ])("rejects invalid versioned state: %j", value => {
    expect(parseFlowState(value)).toBeUndefined();
  });

  test("invalid Linked assignments retain the lock instead of silently becoming Independent", () => {
    for (const selectedFlow of [undefined, null, {}, { ...flow(), provider: "beta" }]) {
      expect(parseFlowState({ ...linked(), selectedFlow })).toEqual({ version: 1, operatingMode: "linked", revision: 4 });
    }
    expect(parseFlowState({ version: 1, operatingMode: "independent", revision: 0 })).toEqual({ version: 1, operatingMode: "independent", revision: 0 });
  });

  test("restores only chronological branch-local flow entries, leaving legacy axes alone", () => {
    const defaults = { version: 1, operatingMode: "independent", revision: 0 };
    const unrelated = [null, {}, custom("tool-gate:mode", { mode: "plan" }),
      custom("tool-gate:workflow", { version: 1, mode: "plan" }),
      custom("tool-gate:approvals", { version: 1, mode: "bypassPermissions" }),
      { type: "message", customType: FLOW_ENTRY, data: linked() }];
    expect(restoreFlowState(unrelated)).toEqual(defaults);
    const first = linked(flow("alpha"), 9);
    const latest = linked(flow("beta"), 2);
    const entries = [...unrelated, custom(FLOW_ENTRY, first), custom(FLOW_ENTRY, latest), custom(FLOW_ENTRY, { ...linked(), version: 2 })];
    const before = structuredClone(entries);
    const restored = restoreFlowState(entries);
    expect(restored).toEqual(latest);
    restored.selectedFlow!.roles.plan.modelId = "mutated";
    expect(entries).toEqual(before);
    expect(restoreFlowState([...entries, custom(FLOW_ENTRY, defaults)])).toEqual(defaults);
  });

  test("a damaged known Linked revision restores a blocked lock rather than Independent", () => {
    for (const revision of [undefined, -1, "4"]) {
      expect(restoreFlowState([custom(FLOW_ENTRY, { ...linked(), revision })]))
        .toEqual({ version: 1, operatingMode: "linked", revision: 0 });
    }
  });

  test("the latest malformed Linked snapshot supersedes an older healthy flow without unlocking", () => {
    expect(restoreFlowState([custom(FLOW_ENTRY, linked()), custom(FLOW_ENTRY, { ...linked(flow("beta"), 8), selectedFlow: {} })]))
      .toEqual({ version: 1, operatingMode: "linked", revision: 8 });
  });
});

describe("physical, authenticated, provider-local role discovery", () => {
  test.each([
    [{ api: "openai-completions" }, true], [{ api: "openai-completions", type: "chat" }, true],
    [{ api: "pi-virtual" }, false], [{ api: "pi-virtual", type: "chat" }, false],
    [{ api: "classifier", type: "classifier" }, false], [{ api: "images", type: "image" }, false],
    [{ type: "chat" }, false], [{}, false],
  ] as const)("physical chat predicate for %j is %s", (input, expected) => {
    expect(isPhysicalChatModel(input)).toBe(expected);
  });

  test("resolves Work/Chat once through general, with explicit medium, cwd, and authenticated availability", async () => {
    const h = harness();
    h.runtime.roles.alpha.general = { model: "alpha/general" };
    h.runtime.available.push(model("virtual", "router", { api: "pi-virtual" }));
    h.runtime.available.push({ ...model("image-provider", "image"), type: "image" } as unknown as ChatModel);
    h.runtime.available.push({ ...model("classifier-provider", "judge"), type: "classifier" } as unknown as ChatModel);
    const before = durable(h);
    const availability = await h.controller.listFlows(h.ctx);
    expect(availability.failures).toEqual([]);
    expect(availability.flows.map(item => item.provider)).toEqual(["alpha", "beta"]);
    expect(h.requests.map(request => request.role)).toEqual(["general", "planner", "worker", "general", "planner", "worker"]);
    const authenticated = h.runtime.available.filter(isPhysicalChatModel).map(({ provider, id }) => ({ provider, id }));
    for (const request of h.requests) {
      expect(request.thinking).toBe("medium");
      expect(request.cwd).toBe("/project/destination");
      expect(request.availableModels).toEqual(authenticated);
      expect(Object.keys(request).sort()).toEqual(["availableModels", "cwd", "parent", "role", "thinking"]);
    }
    const alpha = availability.flows[0]!;
    expect(alpha.roles.work).toEqual({ provider: "alpha", modelId: "general", suggestedThinking: "medium" });
    expect(alpha.roles.chat).toEqual(alpha.roles.work);
    expect(alpha.roles.chat).not.toBe(alpha.roles.work);
    expect(alpha.roles.plan.modelId).toBe("planner");
    expect(alpha.roles.exec.modelId).toBe("worker");
    expect(h.getAvailable).toHaveBeenCalledOnce();
    expect(h.getAll).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(durable(h)).toEqual(before);
  });

  test("orders providers and anchors stably, preferring the live current model only within its provider", async () => {
    const h = harness();
    h.runtime.available.reverse();
    let result = await h.controller.listFlows(h.ctx);
    expect(result.flows.map(({ provider, anchorModel }) => [provider, anchorModel])).toEqual([["alpha", "start"], ["beta", "alternate"]]);
    h.runtime.model = model("beta", "worker");
    result = await h.controller.listFlows(h.ctx);
    expect(result.flows.map(({ provider, anchorModel }) => [provider, anchorModel])).toEqual([["alpha", "alternate"], ["beta", "worker"]]);
    h.runtime.model = model("alpha", "not-authenticated");
    expect((await h.controller.listFlows(h.ctx)).flows[0]!.anchorModel).toBe("alternate");
    h.runtime.model = undefined;
    expect((await h.controller.listFlows(h.ctx)).flows.map(item => item.anchorModel)).toEqual(["alternate", "alternate"]);
    expect(h.requests.filter(request => request.parent === "beta/worker")).toHaveLength(3);
  });

  test.each(["general", "planner", "worker"] as const)("rejects a cross-provider %s default without substituting another provider", async role => {
    const h = harness();
    h.runtime.roles.alpha[role] = { model: "beta/general" };
    const result = await h.controller.listFlows(h.ctx);
    expect(result.flows.map(item => item.provider)).toEqual(["beta"]);
    expect(result.failures).toEqual([{ provider: "alpha", reason: `${role}: role default must stay inside alpha.` }]);
    expect(h.setModel).not.toHaveBeenCalled();
  });

  test.each(["unauthenticated", "virtual", "non-chat"] as const)("rejects %s assigned models, even when another provider has a usable same-id model", async kind => {
    const h = harness();
    h.runtime.roles.alpha.worker = { model: "alpha/invalid" };
    h.runtime.available.push(model("beta", "invalid"));
    if (kind === "virtual") h.runtime.available.push(model("alpha", "invalid", { api: "pi-virtual" }));
    if (kind === "non-chat") h.runtime.available.push({ ...model("alpha", "invalid"), type: "classifier" } as unknown as ChatModel);
    const result = await h.controller.listFlows(h.ctx);
    expect(result.flows.map(item => item.provider)).toEqual(["beta"]);
    expect(result.failures).toEqual([{ provider: "alpha", reason: "exec: alpha/invalid is not an available authenticated physical chat model." }]);
    expect(h.getAll).not.toHaveBeenCalled();
    expect(h.requests.every(request => !request.availableModels.some(item => item.provider === "alpha" && item.id === "invalid"))).toBe(true);
  });

  test("requires every assignment, even phases other than the current workflow", () => {
    const candidate = flow();
    expect(validateProviderFlow(candidate, catalog())).toBeUndefined();
    expect(validateProviderFlow(candidate, catalog().filter(item => item.id !== "worker"))).toMatch(/^exec: alpha\/worker/u);
    candidate.roles.chat.modelId = "planner";
    expect(validateProviderFlow(candidate, catalog())).toBe("Invalid provider flow snapshot.");
  });

  test("missing role replies and invalid suggestions are actionable provider failures", async () => {
    const h = harness();
    delete h.runtime.roles.alpha.planner;
    h.runtime.roles.beta.worker = { model: "beta/worker", thinking: "automatic" };
    const result = await h.controller.listFlows(h.ctx);
    expect(result.flows).toEqual([]);
    expect(result.failures).toEqual([
      { provider: "alpha", reason: "Role defaults unavailable: pi-subagents has not provided subagents:role-model." },
      { provider: "beta", reason: "worker: unsupported suggested thinking level automatic." },
    ]);
  });

  test("pure resolution does not mistake an unanswered synchronous request for an async reply", () => {
    const events: FlowBus = { emit: vi.fn() };
    expect(() => resolveProviderFlow("alpha", "start", catalog(), "/destination", events)).toThrow(/Role defaults unavailable/u);
  });

  test("empty availability offers no provider or fallback", async () => {
    const h = harness();
    h.runtime.available = [];
    expect(await h.controller.listFlows(h.ctx)).toEqual({ flows: [], failures: [] });
    expect(h.requests).toEqual([]);
    await h.start();
    expect(await h.controller.selectProvider("alpha", h.ctx)).toMatchObject({ ok: false, error: "No available authenticated physical models for alpha." });
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe("startup readiness, branch restoration, and recovery", () => {
  test("Independent is the default before and after startup, with no discovery or mutations", async () => {
    const h = harness();
    expect(h.controller.snapshot()).toEqual({ version: 1, operatingMode: "independent", revision: 0, workflow: "work", ready: false, guardAvailable: true, transitioning: false });
    expect(h.controller.guardPolicy()).toEqual({ linked: false, revision: 0 });
    const result = await h.start();
    expect(result).toMatchObject({ ok: true, snapshot: { operatingMode: "independent", ready: true, revision: 0 } });
    expect(h.getAvailable).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.setThinking).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  });

  test("selection before destination startup is fenced and leaves Independent untouched", async () => {
    const h = harness();
    const before = durable(h);
    expect(await h.controller.selectProvider("alpha", h.ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/u) });
    expect(durable(h)).toEqual(before);
    expect(h.getAvailable).not.toHaveBeenCalled();
  });

  test.each(["missing", "unsupported", "uncaptured"] as const)("a %s guard refuses Linked while Independent workflow changes remain usable", async kind => {
    const h = harness();
    h.runtime.guardPresent = kind !== "missing";
    if (kind === "uncaptured") h.lease.pauseAvailable = false;
    else h.lease.available = false;
    await h.start();
    const before = durable(h);
    const result = await h.controller.selectProvider("alpha", h.ctx);
    expect(result).toMatchObject({ ok: false, error: "Linked mode needs an installed, supported model guard with queue-preserving pause.", snapshot: { guardAvailable: false, operatingMode: "independent" } });
    expect(durable(h)).toEqual(before);
    h.runtime.idle = false;
    const commit = h.commitWorkflow("chat");
    expect((await h.controller.prepareWorkflow("chat", h.ctx, commit)).ok).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(h.authorizations).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });

  test.each([false, undefined] as const)("late role-provider readiness (%s) keeps restored Linked blocked, then reconciles the saved assignments", async readiness => {
    const h = harness();
    h.runtime.workflow = "plan";
    h.runtime.roleReady = readiness;
    h.runtime.roleListener = false;
    const saved = linked();
    const restoring = h.start([custom(FLOW_ENTRY, saved)]);
    expect(h.controller.snapshot()).toMatchObject({ operatingMode: "linked", ready: true, blocked: expect.any(String), transitioning: true });
    expect(h.controller.guardPolicy()).toEqual({ linked: true, revision: 4 });
    const result = await restoring;
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Role defaults unavailable/u) });
    expect(result.snapshot.blocked).toContain(FLOW_RECOVERY);
    expect(h.setModel).not.toHaveBeenCalled();
    const commit = h.commitWorkflow("work");
    expect((await h.controller.prepareWorkflow("work", h.ctx, commit)).ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    h.runtime.roleReady = true;
    h.runtime.roleListener = true;
    h.runtime.roles.alpha.planner = { model: "alpha/alternate", thinking: "max" };
    const recovered = await h.controller.reconcile(h.ctx);
    expect(recovered).toMatchObject({ ok: true, snapshot: { operatingMode: "linked", selectedFlow: saved.selectedFlow, revision: 4, workflow: "plan", transitioning: false } });
    expect(recovered.snapshot.blocked).toBeUndefined();
    expect(h.runtime.model?.id).toBe("planner");
    expect(h.runtime.thinking).toBe("high");
    expect(h.persist).not.toHaveBeenCalled();
  });

  test("optional readiness can be synchronously probed without replacing the stored flow", async () => {
    const h = harness();
    h.runtime.roleReady = undefined;
    // Current defaults may no longer be available/provider-local: only the saved
    // physical snapshot is used. A response establishes the older service's readiness.
    h.runtime.roles.alpha.general = { model: "another-provider/missing", thinking: "max" };
    const result = await h.start([custom(FLOW_ENTRY, linked())]);
    expect(result.ok, result.error).toBe(true);
    expect(h.requests.map(request => request.role)).toEqual(["general"]);
    expect(h.runtime.model?.id).toBe("general");
    expect(result.snapshot.selectedFlow).toEqual(flow());
    expect(h.persist).not.toHaveBeenCalled();
  });

  test.each(phases)("restoration reconciles to the destination %s assignment, not Work or new role defaults", async workflow => {
    const h = harness();
    h.runtime.workflow = workflow;
    h.runtime.thinking = "xhigh";
    h.runtime.roles.alpha = { general: { model: "alpha/alternate" } };
    const result = await h.start([custom(FLOW_ENTRY, linked())]);
    expect(result.ok, result.error).toBe(true);
    expect(h.runtime.model?.id).toBe(flow().roles[workflow].modelId);
    expect(h.runtime.workflow).toBe(workflow);
    expect(h.runtime.thinking).toBe("xhigh");
    expect(h.authorizations).toEqual([{ target: { provider: "alpha", id: flow().roles[workflow].modelId }, revision: 4 }]);
    expect(h.requests).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });

  test("destination branches restore their own durable selection revision and may explicitly be Independent", async () => {
    const h = await selected();
    h.runtime.workflow = "chat";
    let result = await h.start([custom(FLOW_ENTRY, linked(flow("beta"), 0))]);
    expect(result).toMatchObject({ ok: true, snapshot: { selectedFlow: flow("beta"), revision: 0, workflow: "chat" } });
    expect(h.runtime.model?.provider).toBe("beta");
    result = await h.start([custom(FLOW_ENTRY, linked(flow("alpha"), 20))]);
    expect(result.snapshot.revision).toBe(20);
    expect(h.runtime.model?.provider).toBe("alpha");
    const beforeModel = h.runtime.model;
    const writes = h.persist.mock.calls.length;
    result = await h.start([custom("tool-gate:mode", { mode: "plan" })]);
    expect(result.snapshot).toMatchObject({ operatingMode: "independent", revision: 0 });
    expect(result.snapshot.selectedFlow).toBeUndefined();
    expect(h.runtime.model).toBe(beforeModel);
    expect(h.persist).toHaveBeenCalledTimes(writes);
  });

  test("a seeded fresh Exec bootstrap initializes only the matching approved worker once", async () => {
    const h = harness();
    h.runtime.workflow = "exec";
    h.runtime.roleReady = false;
    const saved = linked();
    const seed = { active: true, planFile: PLAN, implementerModel: "alpha/worker", linkedFlow: saved };
    const branch = [custom(FLOW_ENTRY, saved), custom("plan-mode:exec", seed), custom("plan-implementation-runtime", { exec: seed, model: "alpha/worker:high" })];
    expect((await h.start(branch)).ok).toBe(false);
    h.runtime.roleReady = true;
    const commit = vi.fn(() => {
      expect(h.runtime.model?.id).toBe("worker");
      h.append("custom", { ...seed, negotiation: { executionId: "fresh-approved" } }, "plan-mode:exec");
    });
    const request = execution(h);
    expect((await h.controller.runExecutionTransition(request, h.ctx, commit)).ok).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().blocked).toBeUndefined();
    const duplicate = vi.fn();
    expect((await h.controller.runExecutionTransition(request, h.ctx, duplicate)).ok).toBe(false);
    expect(duplicate).not.toHaveBeenCalled();
  });

  test.each(["tree", "reload"] as const)("retained Exec finishes using its durable approved revision after %s restoration", async kind => {
    const original = await executing();
    const approved = execution(original, "finish");
    const branch = structuredClone(original.runtime.entries);
    const h = kind === "reload" ? harness() : original;
    h.runtime.workflow = "exec";
    expect((await h.start(branch)).ok).toBe(true);
    expect(h.controller.snapshot().revision).toBe(approved.expectedRevision);
    expect(h.runtime.model?.id).toBe("worker");
    const commit = h.commitWorkflow("work");
    expect((await h.controller.runExecutionTransition(approved, h.ctx, commit)).ok).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(h.runtime.model?.id).toBe("general");
  });

  test("unavailable restored assignments retain Linked and never substitute another model/provider", async () => {
    const h = harness();
    h.runtime.workflow = "plan";
    h.runtime.available = h.runtime.available.filter(item => !(item.provider === "alpha" && item.id === "planner"));
    const result = await h.start([custom(FLOW_ENTRY, linked())]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("alpha/planner is not an available authenticated physical chat model");
    expect(result.snapshot).toMatchObject({ operatingMode: "linked", selectedFlow: flow(), workflow: "plan", revision: 4 });
    expect(result.snapshot.blocked).toContain(FLOW_RECOVERY);
    expect(h.runtime.model?.id).toBe("start");
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
    h.runtime.available.push(model("alpha", "planner"));
    expect((await h.controller.reconcile(h.ctx)).ok).toBe(true);
    expect(h.runtime.model?.id).toBe("planner");
    expect(h.controller.snapshot().blocked).toBeUndefined();
  });

  test.each(["independent", "valid-provider"] as const)("invalid restored Linked data can recover through %s", async recovery => {
    const h = harness();
    const result = await h.start([custom(FLOW_ENTRY, { ...linked(), selectedFlow: {} })]);
    expect(result).toMatchObject({ ok: false, snapshot: { operatingMode: "linked", blocked: expect.stringMatching(/missing or invalid/u) } });
    expect(result.snapshot.selectedFlow).toBeUndefined();
    expect(h.controller.guardPolicy().linked).toBe(true);
    const modelBefore = h.runtime.model;
    const recovered = recovery === "independent" ? await h.controller.setIndependent(h.ctx) : await h.controller.selectProvider("beta", h.ctx);
    expect(recovered.ok, recovered.error).toBe(true);
    expect(recovered.snapshot.blocked).toBeUndefined();
    expect(recovered.snapshot.revision).toBe(5);
    if (recovery === "independent") {
      expect(h.runtime.model).toBe(modelBefore);
      expect(h.controller.guardPolicy().linked).toBe(false);
    } else expect(h.runtime.model?.provider).toBe("beta");
  });
});

describe("selection snapshots, authorized activation, and independent reasoning", () => {
  test.each(["work", "chat", "plan"] as const)("first Linked selection in %s applies its suggestion only after authorized model activation", async workflow => {
    const h = await selected(workflow);
    const assignment = flow().roles[workflow];
    expect(h.runtime.model?.id).toBe(assignment.modelId);
    expect(h.runtime.workflow).toBe(workflow);
    expect(h.runtime.thinking).toBe(assignment.suggestedThinking);
    expect(h.authorizations).toEqual([{ target: { provider: "alpha", id: assignment.modelId }, revision: 0 }]);
    expect(h.trace).toEqual([
      `apply:alpha/${assignment.modelId}@0`, `set:start:alpha/${assignment.modelId}`, `set:end:alpha/${assignment.modelId}`,
      `thinking:${assignment.suggestedThinking}->${assignment.suggestedThinking}`, "persist:linked@1",
    ]);
    expect(h.persist).toHaveBeenCalledExactlyOnceWith(linked(flow(), 1));
    expect(h.runtime.approvals).toEqual({ mode: "default", scope: ["project"] });
    expect(h.runtime.entries.filter(entry => entry.type === "custom").map(entry => entry.customType)).toEqual(["tool-gate:approvals", FLOW_ENTRY]);
    expect(h.controller.guardPolicy()).toEqual({ linked: true, revision: 1 });
    expect(h.controller.inFlight).toBe(false);
  });

  test("first selection on the already-current model still applies the suggestion without a redundant native setter", async () => {
    const h = harness();
    h.runtime.model = model("alpha", "general");
    await h.start();
    await h.select();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.authorizations).toEqual([]);
    expect(h.runtime.thinking).toBe("medium");
    expect(h.persist).toHaveBeenCalledOnce();
  });

  test("selected, returned, and persisted snapshots are detached; changed defaults take effect only on explicit reselection", async () => {
    const h = await selected();
    const original = h.controller.snapshot();
    const snapshot = h.controller.snapshot();
    snapshot.selectedFlow!.roles.plan.modelId = "alternate";
    h.persist.mock.calls[0]![0].selectedFlow!.roles.exec.modelId = "alternate";
    h.runtime.roles.alpha.planner!.model = "alpha/alternate";
    h.runtime.roles.alpha.general!.thinking = "max";
    const listed = await h.controller.listFlows(h.ctx);
    listed.flows[0]!.roles.work.modelId = "mutated-list";
    expect(h.controller.snapshot()).toEqual(original);
    const discoveryCount = h.requests.length;
    for (let i = 0; i < 3; i++) h.controller.snapshot();
    expect(h.requests).toHaveLength(discoveryCount);
    h.runtime.thinking = "high";
    const commit = h.commitWorkflow("plan");
    const transition = await h.controller.prepareWorkflow("plan", h.ctx, commit);
    expect(transition.ok, transition.error).toBe(true);
    expect(h.runtime.model?.id).toBe("planner");
    expect(h.requests).toHaveLength(discoveryCount);
    expect(h.persist).toHaveBeenCalledOnce();
    expect(h.runtime.thinking).toBe("high");
    const refreshed = await h.select();
    expect(refreshed.snapshot.revision).toBe(2);
    expect(refreshed.snapshot.selectedFlow!.roles.plan.modelId).toBe("alternate");
    expect(h.runtime.model?.id).toBe("alternate");
    expect(h.runtime.workflow).toBe("plan");
    expect(h.runtime.thinking).toBe("high");
    refreshed.snapshot.selectedFlow!.roles.plan.modelId = "mutated-result";
    expect(h.controller.snapshot().selectedFlow!.roles.plan.modelId).toBe("alternate");
  });

  test("the optional readiness helper does not make workflow changes re-resolve an immutable selected flow", async () => {
    const h = harness();
    delete h.host.roleReady;
    await h.start();
    await h.select();
    const requests = h.requests.length;
    h.runtime.roles.alpha.planner = { model: "beta/alternate", thinking: "max" };
    const commit = h.commitWorkflow("plan");
    const result = await h.controller.prepareWorkflow("plan", h.ctx, commit);
    expect(result.ok, result.error).toBe(true);
    expect(h.runtime.model?.id).toBe("planner");
    expect(h.requests).toHaveLength(requests);
    expect(commit).toHaveBeenCalledOnce();
  });

  test("later workflow/provider changes preserve current reasoning, using the native clamp rather than role suggestions", async () => {
    const h = await selected();
    h.runtime.thinking = "max";
    h.runtime.ceilings["alpha/planner"] = "high";
    const commit = h.commitWorkflow("plan");
    expect((await h.controller.prepareWorkflow("plan", h.ctx, commit)).ok).toBe(true);
    expect(h.setThinking).toHaveBeenLastCalledWith("max");
    expect(h.runtime.thinking).toBe("high");
    expect(h.trace.indexOf("set:end:alpha/planner")).toBeLessThan(h.trace.indexOf("thinking:max->high"));
    expect(h.trace.indexOf("thinking:max->high")).toBeLessThan(h.trace.indexOf("commit:plan"));
    h.runtime.thinking = "xhigh";
    h.runtime.available = h.runtime.available.map(item => item.provider === "beta" && item.id === "planner" ? { ...item, reasoning: false } : item);
    await h.select("beta");
    expect(h.setThinking).toHaveBeenLastCalledWith("xhigh");
    expect(h.runtime.thinking).toBe("off");
    expect(h.runtime.workflow).toBe("plan");
    expect(h.authorizations.at(-1)).toEqual({ target: { provider: "beta", id: "planner" }, revision: 1 });
  });

  test("Work to Chat uses the same General model without resetting user reasoning or resolving roles", async () => {
    const h = await selected();
    h.runtime.thinking = "xhigh";
    const beforeCalls = h.requests.length;
    const commit = h.commitWorkflow("chat");
    const result = await h.controller.prepareWorkflow("chat", h.ctx, commit);
    expect(result).toMatchObject({ ok: true, snapshot: { workflow: "chat", revision: 1 } });
    expect(commit).toHaveBeenCalledOnce();
    expect(h.setModel).toHaveBeenCalledOnce();
    expect(h.runtime.thinking).toBe("xhigh");
    expect(h.requests).toHaveLength(beforeCalls);
    expect(h.persist).toHaveBeenCalledOnce();
  });

  test("switching to Independent preserves model, reasoning, workflow, approvals, and active Exec records", async () => {
    const h = await executing();
    h.runtime.thinking = "xhigh";
    const before = durable(h);
    const setterCalls = h.setModel.mock.calls.length;
    const reasoningCalls = h.setThinking.mock.calls.length;
    const result = await h.controller.setIndependent(h.ctx);
    expect(result).toMatchObject({ ok: true, snapshot: { operatingMode: "independent", workflow: "exec", revision: 2 } });
    expect(result.snapshot.selectedFlow).toBeUndefined();
    expect(h.runtime.model).toEqual(before.model);
    expect(h.runtime.thinking).toBe(before.thinking);
    expect(h.runtime.approvals).toEqual(before.approvals);
    expect(h.runtime.entries.slice(0, -1)).toEqual(before.entries);
    expect(h.runtime.entries.at(-1)).toMatchObject({ customType: FLOW_ENTRY, data: { version: 1, operatingMode: "independent", revision: 2 } });
    expect(h.setModel).toHaveBeenCalledTimes(setterCalls);
    expect(h.setThinking).toHaveBeenCalledTimes(reasoningCalls);
    expect(h.controller.guardPolicy()).toEqual({ linked: false, revision: 2 });
    expect((await h.controller.setIndependent(h.ctx)).ok).toBe(true);
    expect(h.persist).toHaveBeenCalledTimes(2);
  });
});

describe("idle and Exec restrictions", () => {
  test.each(["select", "independent"] as const)("busy user %s requests cannot alter the selected tuple", async action => {
    const h = await selected();
    h.runtime.idle = false;
    const before = durable(h);
    const calls = h.getAvailable.mock.calls.length;
    const result = action === "select" ? await h.controller.selectProvider("beta", h.ctx) : await h.controller.setIndependent(h.ctx);
    expect(result).toMatchObject({ ok: false, error: FLOW_BUSY });
    expect(durable(h)).toEqual(before);
    expect(h.getAvailable).toHaveBeenCalledTimes(calls);
  });

  test("Independent retains mid-run workflow semantics without discovery or model writes", async () => {
    const h = harness();
    await h.start();
    h.runtime.idle = false;
    expect((await h.controller.setIndependent(h.ctx)).ok).toBe(true);
    const commit = h.commitWorkflow("plan");
    const prepared = h.controller.prepareWorkflow("plan", h.ctx, commit);
    // Independent's legacy mid-run commit is synchronous, not queued behind a microtask.
    expect(commit).toHaveBeenCalledOnce();
    expect(h.runtime.workflow).toBe("plan");
    expect((await prepared).ok).toBe(true);
    expect(h.controller.guardPolicy()).toEqual({ linked: false, revision: 0 });
    expect(h.getAvailable).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.setThinking).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  test("tool-owned Plan entry and approved execution remain awaited and available mid-run", async () => {
    const h = await selected();
    h.runtime.idle = false;
    const plan = h.commitWorkflow("plan");
    expect((await h.controller.prepareWorkflow("plan", h.ctx, plan)).ok).toBe(true);
    const begin = h.commitWorkflow("exec");
    expect((await h.controller.runExecutionTransition(execution(h), h.ctx, begin)).ok).toBe(true);
    expect(h.runtime.model?.id).toBe("worker");
    expect(h.runtime.workflow).toBe("exec");
    expect(plan).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledOnce();
  });

  test.each(["independent", "linked"] as const)("Exec refuses provider selection and base workflow changes in %s mode", async mode => {
    const h = mode === "linked" ? await executing() : harness();
    if (mode === "independent") { await h.start(); h.runtime.workflow = "exec"; }
    const before = durable(h);
    for (const provider of ["alpha", "beta"]) {
      expect(await h.controller.selectProvider(provider, h.ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/during Exec/u) });
    }
    for (const workflow of ["work", "chat", "plan"] as const) {
      const commit = h.commitWorkflow(workflow);
      expect(await h.controller.prepareWorkflow(workflow, h.ctx, commit)).toMatchObject({ ok: false, error: expect.stringMatching(/Exec is active/u) });
      expect(commit).not.toHaveBeenCalled();
    }
    expect(durable(h)).toEqual(before);
  });

  test("a user request that becomes busy while role availability awaits fails before model activation", async () => {
    const h = await selected();
    const waiting = deferred<ChatModel[]>();
    const entered = deferred();
    h.getAvailable.mockImplementationOnce(() => { entered.resolve(); return waiting.promise; });
    const before = durable(h);
    const pending = h.controller.selectProvider("beta", h.ctx);
    await entered.promise;
    h.runtime.idle = false;
    waiting.resolve(h.runtime.available);
    expect(await pending).toMatchObject({ ok: false, error: FLOW_BUSY });
    expect(durable(h)).toEqual(before);
  });
});

describe("user selection restrictions after asynchronous preparation", () => {
  test("becoming busy during the activation availability check also prevents a user provider change", async () => {
    const h = await selected();
    const entered = deferred();
    const available = deferred<ChatModel[]>();
    h.getAvailable.mockResolvedValueOnce([...h.runtime.available]);
    h.getAvailable.mockImplementationOnce(() => { entered.resolve(); return available.promise; });
    const before = durable(h);
    const pending = h.controller.selectProvider("beta", h.ctx);
    await entered.promise;
    h.runtime.idle = false;
    available.resolve(h.runtime.available);
    expect(await pending).toMatchObject({ ok: false, error: FLOW_BUSY });
    expect(durable(h)).toEqual(before);
    expect(h.setModel).toHaveBeenCalledOnce();
  });

  test("entering Exec during provider discovery prevents a late provider/model selection", async () => {
    const h = await selected("plan");
    const entered = deferred();
    const available = deferred<ChatModel[]>();
    h.getAvailable.mockImplementationOnce(() => { entered.resolve(); return available.promise; });
    const pending = h.controller.selectProvider("beta", h.ctx);
    await entered.promise;
    h.runtime.workflow = "exec";
    const before = durable(h);
    available.resolve(h.runtime.available);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Exec/u);
    expect(durable(h)).toEqual({ ...before, snapshot: { ...before.snapshot, transitioning: false } });
    expect(h.setModel).toHaveBeenCalledOnce();
  });
});

describe("preparation and activation failures do not commit metadata or lifecycle changes", () => {
  test.each(["availability", "roles", "false-setter", "throwing-setter", "unavailable-assignment"] as const)("failed provider selection (%s) preserves the old tuple and actual error", async failure => {
    const h = await selected();
    const before = durable(h);
    const persists = h.persist.mock.calls.length;
    if (failure === "availability") h.getAvailable.mockRejectedValueOnce(new Error("Credential lookup failed"));
    if (failure === "roles") h.runtime.roles.beta.worker = { model: "alpha/worker" };
    if (failure === "false-setter") h.setModel.mockResolvedValueOnce(false);
    if (failure === "throwing-setter") h.setModel.mockRejectedValueOnce(new Error("OAuth expired"));
    if (failure === "unavailable-assignment") h.runtime.available = h.runtime.available.filter(item => !(item.provider === "beta" && item.id === "worker"));
    const expected = { availability: "Credential lookup failed", roles: "worker: role default must stay inside beta.", "false-setter": "Model activation failed: beta/general.", "throwing-setter": "OAuth expired", "unavailable-assignment": "exec: beta/worker is not an available authenticated physical chat model." }[failure];
    const result = await h.controller.selectProvider("beta", h.ctx);
    expect(result).toMatchObject({ ok: false, error: expected, snapshot: { transitioning: false } });
    expect(durable(h)).toEqual(before);
    expect(h.persist).toHaveBeenCalledTimes(persists);
    expect(h.controller.inFlight).toBe(false);
  });

  test.each([false, true])("failed workflow model activation (throws=%s) never invokes the final callback", async throws => {
    const h = await selected();
    const before = durable(h);
    if (throws) h.setModel.mockRejectedValueOnce(new Error("Planner credentials expired"));
    else h.setModel.mockResolvedValueOnce(false);
    const commit = h.commitWorkflow("plan");
    const result = await h.controller.prepareWorkflow("plan", h.ctx, commit);
    expect(result).toMatchObject({ ok: false, error: throws ? "Planner credentials expired" : "Model activation failed: alpha/planner." });
    expect(commit).not.toHaveBeenCalled();
    expect(durable(h)).toEqual(before);
    expect(h.persist).toHaveBeenCalledOnce();
    expect((await h.controller.prepareWorkflow("plan", h.ctx, commit)).ok).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });

  test("availability is validated again before activation, not only while listing providers", async () => {
    const h = await selected();
    h.getAvailable.mockResolvedValueOnce([...h.runtime.available]);
    h.getAvailable.mockResolvedValueOnce(h.runtime.available.filter(item => !(item.provider === "beta" && item.id === "general")));
    const before = durable(h);
    const result = await h.controller.selectProvider("beta", h.ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("beta/general is not an available authenticated physical chat model");
    expect(durable(h)).toEqual(before);
    expect(h.authorizations).toHaveLength(1);
  });

  test.each(["model", "thinking"] as const)("a post-mutation %s error blocks the flow without committing workflow or flow metadata", async failure => {
    const h = await selected();
    const before = h.controller.snapshot();
    const originalSetter = h.setModel.getMockImplementation()!;
    if (failure === "model") h.setModel.mockImplementationOnce(async target => {
      await originalSetter(target);
      throw new Error("Post-model extension failed");
    });
    else h.setThinking.mockImplementationOnce(() => { throw new Error("Native thinking setter failed"); });
    const commit = h.commitWorkflow("plan");
    const result = await h.controller.prepareWorkflow("plan", h.ctx, commit);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(failure === "model" ? "Post-model extension failed" : "Native thinking setter failed");
    expect(result.snapshot.blocked).toContain(FLOW_RECOVERY);
    expect(result.snapshot.selectedFlow).toEqual(before.selectedFlow);
    expect(result.snapshot.revision).toBe(before.revision);
    expect(h.runtime.model?.id).toBe("planner");
    expect(h.runtime.workflow).toBe("work");
    expect(commit).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledOnce();
    expect(h.controller.guardPolicy().linked).toBe(true);
  });

  test("missing availability is a concrete failure, not fallback to an unauthenticated catalog", async () => {
    const h = await selected();
    const before = durable(h);
    const ctx = { ...h.ctx, modelRegistry: {} } as ExtensionContext;
    expect(await h.controller.selectProvider("beta", ctx)).toMatchObject({ ok: false, error: "Model availability is unavailable in this session." });
    expect(durable(h)).toEqual(before);
    expect(h.getAll).not.toHaveBeenCalled();
  });
});

describe("explicit approved execution and Work handoff", () => {
  test("Plan to Exec works with the same physical model, explicit plan identity and selection revision", async () => {
    const h = harness();
    h.runtime.workflow = "plan";
    h.runtime.roles.alpha.worker = { model: "alpha/planner", thinking: "max" };
    await h.start();
    await h.select();
    h.runtime.thinking = "high";
    const commit = h.commitWorkflow("exec");
    const result = await h.controller.runExecutionTransition(execution(h), h.ctx, commit);
    expect(result).toMatchObject({ ok: true, snapshot: { workflow: "exec", revision: 1 } });
    expect(commit).toHaveBeenCalledOnce();
    expect(h.setModel).toHaveBeenCalledOnce();
    expect(h.authorizations).toEqual([{ target: { provider: "alpha", id: "planner" }, revision: 0 }]);
    expect(h.runtime.model?.id).toBe("planner");
    expect(h.runtime.thinking).toBe("high");
    expect(h.persist).toHaveBeenCalledOnce();
  });

  test.each(["revision", "identity", "workflow", "independent"] as const)("rejects invalid begin %s before any model or lifecycle mutation", async invalid => {
    const h = await selected("plan");
    const phase = execution(h);
    if (invalid === "revision") phase.expectedRevision--;
    if (invalid === "identity") phase.planFile = " \n ";
    if (invalid === "workflow") h.runtime.workflow = "work";
    if (invalid === "independent") await h.controller.setIndependent(h.ctx);
    const before = durable(h);
    const commit = h.commitWorkflow("exec");
    const result = await h.controller.runExecutionTransition(phase, h.ctx, commit);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch({ revision: /revision is stale/u, identity: /approved plan identity/u, workflow: /lifecycle changed/u, independent: /requires a selected provider flow/u }[invalid]);
    expect(commit).not.toHaveBeenCalled();
    expect(durable(h)).toEqual(before);
  });

  test.each(["finish", "stop"] as const)("%s activates Work before the lifecycle callback, never the prior planning model", async phase => {
    const h = await executing();
    const entered = deferred();
    const release = deferred();
    h.runtime.beforeSet = async () => { entered.resolve(); await release.promise; };
    h.runtime.thinking = "xhigh";
    const intent = execution(h, phase);
    const commit = vi.fn(() => {
      expect(h.runtime.model?.id).toBe("general");
      expect(h.runtime.workflow).toBe("exec");
      expect(h.runtime.thinking).toBe("xhigh");
      h.runtime.workflow = "work";
      h.append("custom", { active: false, planFile: PLAN, phase }, "plan-mode:exec");
    });
    const pending = h.controller.runExecutionTransition(intent, h.ctx, commit);
    await entered.promise;
    expect(commit).not.toHaveBeenCalled();
    expect(h.runtime.workflow).toBe("exec");
    expect(h.runtime.model?.id).toBe("worker");
    expect(h.controller.inFlight).toBe(true);
    expect(h.controller.snapshot().transitioning).toBe(true);
    release.resolve();
    const result = await pending;
    expect(result).toMatchObject({ ok: true, snapshot: { workflow: "work", transitioning: false, revision: 1 } });
    expect(commit).toHaveBeenCalledOnce();
    expect(h.authorizations.map(item => item.target.id)).toEqual(["planner", "worker", "general"]);
    expect(h.authorizations.at(-1)!.revision).toBe(1);
    expect(h.persist).toHaveBeenCalledOnce();
  });

  test.each(["finish", "stop"] as const)("failed %s Work activation preserves Exec and the owner's completion intent for retry", async phase => {
    const h = await executing();
    const completion = { active: true, planFile: PLAN, pendingCompletion: { phase, text: "already reviewed" } };
    h.append("custom", completion, "plan-mode:exec");
    const intent = execution(h, phase);
    const before = durable(h);
    const commit = h.commitWorkflow("work");
    h.setModel.mockRejectedValueOnce(new Error("Work credentials unavailable"));
    const failed = await h.controller.runExecutionTransition(intent, h.ctx, commit);
    expect(failed).toMatchObject({ ok: false, error: "Work credentials unavailable" });
    expect(commit).not.toHaveBeenCalled();
    expect(durable(h)).toEqual(before);
    expect(h.runtime.entries.at(-1)!.data).toEqual(completion);
    const retried = await h.controller.runExecutionTransition(intent, h.ctx, commit);
    expect(retried.ok, retried.error).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(h.runtime.workflow).toBe("work");
    expect(h.runtime.model?.id).toBe("general");
    expect(h.persist).toHaveBeenCalledOnce();
  });

  test.each(["finish", "stop"] as const)("an unavailable Work assignment on %s preserves the completion intent and can be retried without substitution", async phase => {
    const h = await executing();
    const completion = { active: true, planFile: PLAN, pendingCompletion: { phase, text: "approved completion" } };
    h.append("custom", completion, "plan-mode:exec");
    h.runtime.available = h.runtime.available.filter(item => !(item.provider === "alpha" && item.id === "general"));
    const before = durable(h);
    const intent = execution(h, phase);
    const commit = h.commitWorkflow("work");
    const failed = await h.controller.runExecutionTransition(intent, h.ctx, commit);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("alpha/general is not an available authenticated physical chat model");
    expect(durable(h)).toEqual(before);
    expect(commit).not.toHaveBeenCalled();
    expect(h.setModel).toHaveBeenCalledTimes(2);
    h.runtime.available.push(model("alpha", "general"));
    const retried = await h.controller.runExecutionTransition(intent, h.ctx, commit);
    expect(retried.ok, retried.error).toBe(true);
    expect(h.runtime.model).toMatchObject({ provider: "alpha", id: "general" });
    expect(commit).toHaveBeenCalledOnce();
    expect(h.runtime.entries.filter(entry => entry.customType === "plan-mode:exec").at(-1)!.data).toEqual(completion);
  });

  test.each(["finish", "stop"] as const)("%s verifies the latest active execution identity, not an older matching record", async phase => {
    for (const latest of [undefined, { active: false, planFile: PLAN }, { active: true, planFile: "/project/plans/other.md" }]) {
      const h = await executing();
      if (latest) h.append("custom", latest, "plan-mode:exec");
      else h.runtime.entries = h.runtime.entries.filter(entry => entry.customType !== "plan-mode:exec");
      const before = durable(h);
      const commit = h.commitWorkflow("work");
      const result = await h.controller.runExecutionTransition(execution(h, phase), h.ctx, commit);
      expect(result).toMatchObject({ ok: false, error: "Approved plan identity changed before completion." });
      expect(commit).not.toHaveBeenCalled();
      expect(durable(h)).toEqual(before);
    }
  });

  test.each(["workflow", "execution"] as const)("a throwing %s final commit exposes a blocked flow after activation", async kind => {
    const h = await selected(kind === "workflow" ? "work" : "plan");
    const before = h.controller.snapshot();
    const commit = vi.fn(() => { throw new Error("Lifecycle persistence failed"); });
    const result = kind === "workflow"
      ? await h.controller.prepareWorkflow("plan", h.ctx, commit)
      : await h.controller.runExecutionTransition(execution(h), h.ctx, commit);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Flow commit failed after model activation: Lifecycle persistence failed");
    expect(result.snapshot.blocked).toBe(result.error);
    expect(result.snapshot.blocked).toContain(FLOW_RECOVERY);
    expect(result.snapshot.revision).toBe(before.revision);
    expect(result.snapshot.selectedFlow).toEqual(before.selectedFlow);
    expect(h.runtime.model?.id).toBe(kind === "workflow" ? "planner" : "worker");
    expect(h.runtime.workflow).toBe(before.workflow);
    expect(commit).toHaveBeenCalledOnce();
    expect(h.controller.guardPolicy().linked).toBe(true);
    const later = h.commitWorkflow("chat");
    expect((await h.controller.prepareWorkflow("chat", h.ctx, later)).ok).toBe(false);
    expect(later).not.toHaveBeenCalled();
    const reconcile = await h.controller.reconcile(h.ctx);
    expect(reconcile.ok).toBe(false);
    expect(reconcile.snapshot.blocked).toContain("Lifecycle persistence failed");
    expect((await h.controller.setIndependent(h.ctx)).ok).toBe(true);
    expect(h.controller.snapshot().blocked).toBeUndefined();
  });

  test("first activation stays locked through the post-setter microtask and durable commit", async () => {
    const h = harness();
    await h.start();
    const thinking = h.setThinking.getMockImplementation()!;
    let lockedAfterActivation = false;
    h.setThinking.mockImplementationOnce(level => {
      thinking(level);
      queueMicrotask(() => { lockedAfterActivation = h.controller.guardPolicy().linked; });
    });
    const persist = h.persist.getMockImplementation()!;
    h.persist.mockImplementationOnce(state => {
      expect(h.controller.guardPolicy().linked).toBe(true);
      persist(state);
    });
    expect((await h.controller.selectProvider("alpha", h.ctx)).ok).toBe(true);
    expect(lockedAfterActivation).toBe(true);
  });

  test("failed Independent persistence cannot silently unlink the existing selection", async () => {
    const h = await selected();
    const before = h.controller.snapshot();
    h.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    expect((await h.controller.setIndependent(h.ctx)).ok).toBe(false);
    expect(h.controller.snapshot()).toMatchObject({ operatingMode: "linked", selectedFlow: before.selectedFlow, revision: before.revision, blocked: expect.any(String) });
    expect(h.controller.guardPolicy().linked).toBe(true);
  });

  test("failed first-activation persistence blocks even before Linked metadata can commit", async () => {
    const h = harness();
    await h.start();
    h.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    expect((await h.controller.selectProvider("alpha", h.ctx)).ok).toBe(false);
    expect(h.controller.snapshot()).toMatchObject({ operatingMode: "independent", blocked: expect.any(String) });
    expect(h.controller.guardPolicy().linked).toBe(true);
    const commit = vi.fn();
    expect((await h.controller.prepareWorkflow("chat", h.ctx, commit)).ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect((await h.controller.setIndependent(h.ctx)).ok).toBe(true);
    expect(h.controller.guardPolicy().linked).toBe(false);
  });

  test("throwing flow persistence reports blocked rather than claiming a coherent successful selection", async () => {
    const h = await selected();
    h.persist.mockImplementationOnce(() => { throw new Error("Disk full"); });
    const result = await h.controller.selectProvider("beta", h.ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Flow commit failed after model activation: Disk full");
    expect(result.snapshot.blocked).toBe(result.error);
    expect(h.runtime.model?.provider).toBe("beta");
    expect(h.controller.guardPolicy().linked).toBe(true);
  });
});

describe("asynchronous fencing, serialization, and shutdown", () => {
  test.each(["session", "branch", "restore"] as const)("stale %s during awaited preparation never starts a model write or commit", async invalidation => {
    const h = await selected();
    const entered = deferred();
    const available = deferred<ChatModel[]>();
    h.getAvailable.mockImplementationOnce(() => { entered.resolve(); return available.promise; });
    const calls = h.setModel.mock.calls.length;
    const persists = h.persist.mock.calls.length;
    const pending = h.controller.selectProvider("beta", h.ctx);
    await entered.promise;
    if (invalidation === "session") h.runtime.session = "session-b";
    if (invalidation === "branch") h.runtime.entries = [custom("branch", {}, "unrelated-leaf")];
    if (invalidation === "restore") await h.start([custom("branch", {}, "destination")]);
    const destination = h.controller.snapshot();
    available.resolve(h.runtime.available);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/u), snapshot: { transitioning: false } });
    expect(h.setModel).toHaveBeenCalledTimes(calls);
    expect(h.persist).toHaveBeenCalledTimes(persists);
    expect(h.controller.snapshot()).toEqual({ ...destination, transitioning: false });
    expect(h.controller.inFlight).toBe(false);
  });

  test.each(["session", "branch", "restore"] as const)("stale %s while native model activation awaits cannot publish thinking, flow metadata, or final callbacks", async invalidation => {
    const h = await selected();
    const entered = deferred();
    const release = deferred();
    h.runtime.beforeSet = async () => { entered.resolve(); await release.promise; };
    const thinkingCalls = h.setThinking.mock.calls.length;
    const persistCalls = h.persist.mock.calls.length;
    const commit = h.commitWorkflow("plan");
    const pending = h.controller.prepareWorkflow("plan", h.ctx, commit);
    await entered.promise;
    if (invalidation === "session") h.runtime.session = "session-b";
    if (invalidation === "branch") h.runtime.entries = [custom("branch", {}, "new-leaf")];
    if (invalidation === "restore") await h.start([custom("branch", {}, "destination")]);
    release.resolve();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancelled/u);
    expect(commit).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledTimes(persistCalls);
    expect(h.setThinking).toHaveBeenCalledTimes(thinkingCalls);
    expect(h.runtime.workflow).toBe("work");
    expect(h.controller.snapshot().blocked).toBeUndefined();
    expect(h.controller.inFlight).toBe(false);
    // The host's already-entered native setter is not cancellable by a pure controller.
    // session_before_switch/tree prevention is covered by the integration/guard tests.
  });

  test.each(["preparation", "model"] as const)("stale execution lifecycle during awaited %s cannot invoke the approved begin callback", async boundary => {
    const h = await selected("plan");
    const entered = deferred();
    const release = deferred();
    if (boundary === "preparation") h.getAvailable.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return h.runtime.available; });
    else h.runtime.beforeSet = async () => { entered.resolve(); await release.promise; };
    const commit = h.commitWorkflow("exec");
    const pending = h.controller.runExecutionTransition(execution(h), h.ctx, commit);
    await entered.promise;
    h.runtime.workflow = "work";
    release.resolve();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lifecycle changed|cancelled/u);
    expect(commit).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledOnce();
    expect(h.runtime.workflow).toBe("work");
    if (boundary === "preparation") expect(h.setModel).toHaveBeenCalledOnce();
  });

  test.each(["finish", "stop"] as const)("an execution identity replaced during %s preparation cannot complete a different plan", async phase => {
    const h = await executing();
    const entered = deferred();
    const available = deferred<ChatModel[]>();
    h.getAvailable.mockImplementationOnce(() => { entered.resolve(); return available.promise; });
    const commit = h.commitWorkflow("work");
    const pending = h.controller.runExecutionTransition(execution(h, phase), h.ctx, commit);
    await entered.promise;
    h.append("custom", { active: true, planFile: "/project/plans/replacement.md" }, "plan-mode:exec");
    available.resolve(h.runtime.available);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/identity changed|cancelled/u);
    expect(commit).not.toHaveBeenCalled();
    expect(h.runtime.workflow).toBe("exec");
    expect(h.runtime.model?.id).toBe("worker");
    expect(h.setModel).toHaveBeenCalledTimes(2);
  });

  test("a stale reconciliation failure cannot block a newly restored Independent destination", async () => {
    const h = harness();
    const entered = deferred();
    const available = deferred<ChatModel[]>();
    h.getAvailable.mockImplementationOnce(() => { entered.resolve(); return available.promise; });
    const restoring = h.start([custom(FLOW_ENTRY, linked())]);
    await entered.promise;
    const destination = await h.start([custom("branch", {}, "new-leaf")]);
    expect(destination.ok).toBe(true);
    available.reject(new Error("Old branch credential failure"));
    expect((await restoring).ok).toBe(false);
    expect(h.controller.snapshot()).toMatchObject({ operatingMode: "independent", revision: 0, transitioning: false });
    expect(h.controller.snapshot().blocked).toBeUndefined();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  test("normal model/thinking entry appends preserve the branch fence", async () => {
    const h = await selected();
    h.runtime.beforeSet = async () => { h.append("message", { role: "assistant", content: "same branch" }); };
    const commit = h.commitWorkflow("plan");
    expect((await h.controller.prepareWorkflow("plan", h.ctx, commit)).ok).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(h.runtime.entries.some(entry => entry.id === "root")).toBe(true);
  });

  test("serializes lifecycle transitions so a second model cannot start before the first callback", async () => {
    const h = await selected();
    const entered = deferred();
    const release = deferred();
    h.runtime.beforeSet = async target => {
      if (target.id === "planner") { entered.resolve(); await release.promise; }
    };
    const planCommit = h.commitWorkflow("plan");
    const first = h.controller.prepareWorkflow("plan", h.ctx, planCommit);
    await entered.promise;
    const chatCommit = h.commitWorkflow("chat");
    const second = h.controller.prepareWorkflow("chat", h.ctx, chatCommit);
    expect(h.setModel).toHaveBeenCalledTimes(2);
    expect(planCommit).not.toHaveBeenCalled();
    expect(chatCommit).not.toHaveBeenCalled();
    expect(h.controller.inFlight).toBe(true);
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.ok)).toEqual([true, true]);
    expect(h.trace.indexOf("commit:plan")).toBeLessThan(h.trace.lastIndexOf("set:start:alpha/general"));
    expect(h.trace.indexOf("set:end:alpha/planner")).toBeLessThan(h.trace.indexOf("commit:plan"));
    expect(h.trace.lastIndexOf("set:end:alpha/general")).toBeLessThan(h.trace.indexOf("commit:chat"));
    expect(h.runtime.workflow).toBe("chat");
    expect(h.controller.snapshot().transitioning).toBe(false);
    expect(h.controller.inFlight).toBe(false);
  });

  test("a base workflow request queued behind approved begin cannot exit newly active Exec", async () => {
    const h = await selected("plan");
    const entered = deferred();
    const release = deferred();
    h.runtime.beforeSet = async target => {
      if (target.id === "worker") { entered.resolve(); await release.promise; }
    };
    const begin = h.commitWorkflow("exec");
    const first = h.controller.runExecutionTransition(execution(h), h.ctx, begin);
    await entered.promise;
    const chat = h.commitWorkflow("chat");
    const second = h.controller.prepareWorkflow("chat", h.ctx, chat);
    release.resolve();
    const [started, refused] = await Promise.all([first, second]);
    expect(started.ok, started.error).toBe(true);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/Exec|lifecycle changed|cancelled/u);
    expect(begin).toHaveBeenCalledOnce();
    expect(chat).not.toHaveBeenCalled();
    expect(h.runtime.workflow).toBe("exec");
    expect(h.runtime.model?.id).toBe("worker");
    expect(h.setModel).toHaveBeenCalledTimes(2);
  });

  test("queued selection captures its revision and cannot silently override a newly committed selection", async () => {
    const h = await selected();
    const entered = deferred();
    const release = deferred();
    h.runtime.beforeSet = async () => { entered.resolve(); await release.promise; };
    const first = h.controller.selectProvider("beta", h.ctx);
    await entered.promise;
    const second = h.controller.selectProvider("alpha", h.ctx);
    release.resolve();
    const [applied, stale] = await Promise.all([first, second]);
    expect(applied.ok, applied.error).toBe(true);
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/u) });
    expect(h.controller.snapshot()).toMatchObject({ revision: 2, selectedFlow: { provider: "beta" }, transitioning: false });
    expect(h.setModel).toHaveBeenCalledTimes(2);
    expect(h.persist).toHaveBeenCalledTimes(2);
  });

  test("a failed serialized operation does not poison the queue for a valid following transition", async () => {
    const h = await selected();
    const entered = deferred();
    const release = deferred();
    h.setModel.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("One failed activation");
    });
    const firstCommit = h.commitWorkflow("plan");
    const first = h.controller.prepareWorkflow("plan", h.ctx, firstCommit);
    await entered.promise;
    const secondCommit = h.commitWorkflow("chat");
    const second = h.controller.prepareWorkflow("chat", h.ctx, secondCommit);
    release.resolve();
    const [failed, applied] = await Promise.all([first, second]);
    expect(failed).toMatchObject({ ok: false, error: "One failed activation" });
    expect(applied.ok, applied.error).toBe(true);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).toHaveBeenCalledOnce();
    expect(h.runtime.workflow).toBe("chat");
    expect(h.controller.inFlight).toBe(false);
    expect(h.controller.snapshot().transitioning).toBe(false);
  });

  test.each([
    ["preparation", "success"], ["preparation", "failure"],
    ["model", "success"], ["model", "failure"],
  ] as const)("initial selection awaiting %s refuses Independent controls until %s settles", async (boundary, outcome) => {
    const h = harness();
    await h.start();
    const before = durable(h);
    const entered = deferred();
    const release = deferred();
    const wait = async () => {
      entered.resolve();
      await release.promise;
      if (outcome === "failure") throw new Error("Initial authentication failed");
    };
    if (boundary === "preparation") h.getAvailable.mockImplementationOnce(async () => { await wait(); return h.runtime.available; });
    else h.runtime.beforeSet = wait;
    const pending = h.controller.selectProvider("alpha", h.ctx);
    try {
      // enqueue locks synchronously, even before discovery/selecting/activation can start.
      expect(h.getAvailable).not.toHaveBeenCalled();
      expect(h.controller.inFlight).toBe(true);
      expect(h.controller.guardPolicy()).toEqual({ linked: true, revision: 0 });
      expect(h.controller.snapshot()).toMatchObject({ operatingMode: "independent", revision: 0, transitioning: true });
      const independent = h.controller.setIndependent(h.ctx);
      const sameWorkflow = h.commitWorkflow("work");
      const same = h.controller.prepareWorkflow("work", h.ctx, sameWorkflow);
      expect(sameWorkflow).not.toHaveBeenCalled();
      expect(await independent).toMatchObject({ ok: false, error: FLOW_TRANSITION });
      expect(await same).toMatchObject({ ok: false, error: FLOW_TRANSITION });
      await entered.promise;
      expect(await h.controller.setIndependent(h.ctx)).toMatchObject({ ok: false, error: FLOW_TRANSITION });
      for (const workflow of ["work", "chat", "plan"] as const) {
        const commit = h.commitWorkflow(workflow);
        expect(await h.controller.prepareWorkflow(workflow, h.ctx, commit)).toMatchObject({ ok: false, error: FLOW_TRANSITION });
        expect(commit).not.toHaveBeenCalled();
      }
      expect(durable(h)).toEqual({ ...before, snapshot: { ...before.snapshot, transitioning: true } });
      expect(h.persist).not.toHaveBeenCalled();
      expect(h.setThinking).not.toHaveBeenCalled();
    } finally { release.resolve(); }
    const result = await pending;
    h.runtime.beforeSet = undefined;
    if (outcome === "failure") {
      expect(result).toMatchObject({ ok: false, error: "Initial authentication failed" });
      expect(durable(h)).toEqual(before);
      expect(h.controller.guardPolicy()).toEqual({ linked: false, revision: 0 });
      expect((await h.controller.setIndependent(h.ctx)).ok).toBe(true);
      expect(h.persist).not.toHaveBeenCalled();
      await h.select();
    } else {
      expect(result).toMatchObject({ ok: true, snapshot: { operatingMode: "linked", revision: 1, transitioning: false } });
    }
    expect(h.controller.guardPolicy()).toEqual({ linked: true, revision: 1 });
    expect(h.persist).toHaveBeenCalledOnce();
    const plan = h.commitWorkflow("plan");
    expect((await h.controller.prepareWorkflow("plan", h.ctx, plan)).ok).toBe(true);
    expect(plan).toHaveBeenCalledOnce();
    expect(h.runtime.model?.id).toBe("planner");
    expect((await h.controller.setIndependent(h.ctx)).ok).toBe(true);
    expect(h.controller.snapshot()).toMatchObject({ operatingMode: "independent", workflow: "plan", revision: 2, transitioning: false });
    expect(h.controller.guardPolicy()).toEqual({ linked: false, revision: 2 });
  });

  test.each([
    ["selection", "preparation"], ["selection", "model"],
    ["workflow", "preparation"], ["workflow", "model"],
  ] as const)("shutdown drains %s awaiting %s and fences queued work before disposing the lease", async (operation, boundary) => {
    const h = await selected();
    const before = durable(h);
    const entered = deferred();
    const release = deferred();
    const settled = vi.fn();
    if (boundary === "preparation") h.getAvailable.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return h.runtime.available; });
    else h.runtime.beforeSet = async () => {
      entered.resolve();
      await release.promise;
      expect(h.lease.available).toBe(true);
      expect(h.lease.dispose).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
    };
    const commit = h.commitWorkflow("plan");
    const pending = operation === "selection" ? h.controller.selectProvider("beta", h.ctx) : h.controller.prepareWorkflow("plan", h.ctx, commit);
    await entered.promise;
    const queuedCommit = h.commitWorkflow("chat");
    const queued = h.controller.prepareWorkflow("chat", h.ctx, queuedCommit);
    const persists = h.persist.mock.calls.length;
    const thinkingCalls = h.setThinking.mock.calls.length;
    const modelCalls = h.setModel.mock.calls.length;
    const availabilityCalls = h.getAvailable.mock.calls.length;
    h.changed.mockImplementation(() => { h.trace.push(`inFlight:${h.controller.inFlight}`); });
    const shutdown = h.controller.shutdown();
    const completion = shutdown.then(settled);
    try {
      expect(shutdown).toBeInstanceOf(Promise);
      expect(h.controller.shutdown()).toBe(shutdown);
      expect(h.controller.snapshot()).toMatchObject({ ready: false, guardAvailable: true, transitioning: true });
      expect(h.lease.available).toBe(true);
      expect(h.lease.dispose).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(h.runtime.entries).toEqual(before.entries);
    } finally { release.resolve(); }
    const results = await Promise.all([pending, queued]);
    await completion;
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/cancelled/u);
    }
    expect(settled).toHaveBeenCalledOnce();
    expect(h.lease.dispose).toHaveBeenCalledOnce();
    expect(h.lease.available).toBe(false);
    expect(h.trace.at(-1)).toBe("dispose");
    expect(h.trace).toContain("inFlight:false");
    expect(h.trace.indexOf("inFlight:false")).toBeLessThan(h.trace.indexOf("dispose"));
    expect(commit).not.toHaveBeenCalled();
    expect(queuedCommit).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledTimes(persists);
    expect(h.setThinking).toHaveBeenCalledTimes(thinkingCalls);
    expect(h.setModel).toHaveBeenCalledTimes(modelCalls);
    expect(h.getAvailable).toHaveBeenCalledTimes(availabilityCalls);
    expect(h.runtime.workflow).toBe("work");
    expect(h.controller.inFlight).toBe(false);
    expect(h.controller.snapshot()).toEqual({ ...before.snapshot, ready: false, guardAvailable: false });
    if (boundary === "model") {
      const target = operation === "selection" ? { provider: "beta", modelId: "general" } : { provider: "alpha", modelId: "planner" };
      // An already-entered native setter really mutates after auth; shutdown must drain it,
      // not pretend that disposing a lease can cancel a write that was authorized at entry.
      expect(h.runtime.model).toMatchObject({ provider: target.provider, id: target.modelId });
      expect(h.runtime.thinking).toBe("low");
      expect(h.runtime.entries.slice(before.entries.length)).toEqual([{ id: expect.any(String), type: "model_change", data: target }]);
      expect(h.trace.indexOf(`set:end:${target.provider}/${target.modelId}`)).toBeLessThan(h.trace.indexOf("dispose"));
    } else {
      expect(h.runtime.model).toEqual(before.model);
      expect(h.runtime.thinking).toBe(before.thinking);
      expect(h.runtime.entries).toEqual(before.entries);
    }
    const later = await h.controller.selectProvider("beta", h.ctx);
    expect(later).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/u) });
    expect(h.getAvailable).toHaveBeenCalledTimes(availabilityCalls);
    expect(h.setModel).toHaveBeenCalledTimes(modelCalls);
    expect(h.persist).toHaveBeenCalledTimes(persists);
    await h.controller.shutdown();
    expect(h.lease.dispose).toHaveBeenCalledOnce();
  });
});
