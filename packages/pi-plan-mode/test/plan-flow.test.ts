import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import * as usage from "@justmytwospence/pi-subscription-usage";
import { onTestFinished, test, vi } from "vitest";
import { withEffortOrigin } from "../src/effort-origin.js";
import { directImplementationBrief } from "../src/handoff.js";
import type { pickImplementationEffort } from "../src/implementation-effort.js";
import planMode from "../src/index.js";
import { MODE_CHANGED, MODE_SET, PLAN_PROVIDER } from "../src/inline-plan.js";
import type { JevToolPick, pickToolsWithJev } from "../src/jev-tool-picker.js";
import type { PlannerSessionFactory } from "../src/planner/session.js";
import type { PlanModeSettings } from "../src/settings.js";
import { SETTINGS_REASONING_COMMITTED, settingsCycles } from "../src/settings-cycle.js";
import { resolveSystem1Target, SYSTEM1_CHANGED } from "../src/system1.js";
import type { TaskEffortJudgment } from "../src/task-effort.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");
const SONNET = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function compactionDispatcher(mock: ReturnType<typeof createMockPi>) {
  const handlers = [...(mock.events.get("session_before_compact") ?? [])];
  assert.ok(handlers.length > 0, "plan-mode registers compaction handlers");
  return async (event: unknown, ctx: ExtensionContext) => {
    let result: unknown;
    for (const handler of handlers) {
      const response = await handler(event, ctx);
      if (response !== undefined) {
        assert.equal(result, undefined, "only one handler overrides compaction");
        result = response;
      }
    }
    return result;
  };
}

/** Planner sessions that submit `# Plan from <model>` for any prompt (or, with `ask`, ask first). */
function fakeSessions(ask = false, failFirst?: { model: string; error: string }) {
  const prompts: Array<{ model: string; text: string }> = [];
  const disposed: string[] = [];
  const emitters: Array<(event: unknown) => void> = [];
  const factory: PlannerSessionFactory = async (_host, options) => {
    const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
    (options.policy as (pi: unknown) => void)({
      registerTool: (tool: { name: string; execute(...args: unknown[]): Promise<unknown> }) =>
        tools.set(tool.name, tool),
      on: () => undefined,
      getAllTools: () => [],
    });
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    emitters.push(emit);
    return {
      session: {
        isStreaming: false,
        prompt: async (text: string) => {
          prompts.push({ model: options.spec.modelId, text });
          emit({ type: "agent_start" });
          if (
            failFirst?.model === options.spec.modelId &&
            prompts.filter((p) => p.model === failFirst.model).length === 1
          ) {
            emit({
              type: "message_end",
              message: { role: "assistant", content: [], stopReason: "error", errorMessage: failFirst.error },
            });
            emit({ type: "agent_settled" });
            return;
          }
          if (ask) {
            await tools.get("plan_mode_question")?.execute("q", {
              questions: [
                {
                  id: "lang",
                  header: "Language",
                  question: "Which?",
                  options: [
                    { label: "Python", description: "Py" },
                    { label: "Node", description: "JS" },
                  ],
                },
              ],
            });
          }
          await tools
            .get("plan_mode_complete")
            ?.execute("1", { plan: `# Plan from ${options.spec.modelId} #${prompts.length}` });
          emit({ type: "agent_settled" });
        },
        steer: async () => undefined,
        abort: async () => undefined,
        setModel: async (model: { id: string }) => {
          prompts.push({ model: options.spec.modelId, text: `[setModel ${model.id}]` });
        },
        setThinkingLevel: (level: string) => {
          prompts.push({ model: options.spec.modelId, text: `[setThinkingLevel ${level}]` });
        },
        getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
      } as never,
      file: `/sessions/${options.spec.modelId}.jsonl`,
      subscribe: (listener) => {
        listeners.add(listener as never);
        return () => listeners.delete(listener as never);
      },
      dispose: () => {
        disposed.push(options.spec.modelId);
      },
    };
  };
  return { factory, prompts, disposed, emitters };
}

function setup(
  options: {
    ask?: boolean;
    failFirst?: { model: string; error: string };
    login?: (providerId: string, show: (dialog: never) => void) => Promise<void>;
    settings?: Partial<PlanModeSettings>;
    thinkingLevel?: string;
    approval?: "auto" | "bypassPermissions";
    configureContext?: (ctx: ExtensionContext) => void;
    pickTools?: typeof pickToolsWithJev;
    pickImplementationEffort?: typeof pickImplementationEffort;
  } = {},
) {
  const mock = createMockPi({ thinkingLevel: options.thinkingLevel ?? "high" });
  const sessions = fakeSessions(options.ask, options.failFirst);
  const ready = planMode(mock.pi, {
    ...(options.login ? { login: options.login } : {}),
    ...(options.pickTools ? { pickTools: options.pickTools } : {}),
    pickImplementationEffort:
      options.pickImplementationEffort ?? (async () => ({ kind: "fallback", reason: "fixture unavailable" })),
    readSettings: async () => ({
      thinkingLevel: "inherit",
      planners: [{ provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "low" }],
      jevToolSelection: false,
      ...options.settings,
    }),
    createSession: sessions.factory,
  });
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  const sent: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    model: SONNET,
    custom: async (factory: unknown) => {
      harness = createCustomSelectorHarness(factory, 140, undefined, 40);
      return harness.resultPromise;
    },
    modelRegistry: {
      getAvailable: () => [SONNET, OPUS],
      find: (provider: string, id: string) =>
        [SONNET, OPUS].find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    },
    sessionManager: {
      getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })),
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "earlier" }] }),
      getSessionFile: () => "/main.jsonl",
      getSessionId: () => "main",
    },
  });
  const workflowRequests: string[] = [];
  const approvalRequests: string[] = [];
  if (options.approval) {
    mock.eventBus.on(MODE_SET, (data) => {
      const mode = (data as { mode: string }).mode;
      workflowRequests.push(mode);
      mock.eventBus.emit(MODE_CHANGED, { mode, cycle: ["work", "chat", "plan"] });
    });
    mock.eventBus.on(PLAN_PROVIDER, () => {
      mock.eventBus.emit(MODE_CHANGED, { mode: workflowRequests.at(-1) ?? "work", cycle: ["work", "chat", "plan"] });
    });
    mock.eventBus.on("permission-mode:set", (data) => approvalRequests.push((data as { mode: string }).mode));
    mock.eventBus.emit("permission-mode:changed", { mode: options.approval, cycle: ["auto", "bypassPermissions"] });
  }
  options.configureContext?.(context.ctx as ExtensionContext);
  (context.ctx as { sendUserMessage?: unknown }).sendUserMessage = async (text: string) => sent.push(text);
  return { mock, context, sessions, sent, ready, workflowRequests, approvalRequests, harness: () => harness };
}

for (const stale of ["none", "event", "file", "event-roundtrip", "manual", "disabled"] as const) {
  test(`/planners late System 1 preselection preserves selection after ${stale}`, async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const directory = mkdtempSync(join(tmpdir(), "plan-preselection-"));
    process.env.PI_CODING_AGENT_DIR = directory;
    onTestFinished(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    });
    let finish!: (pick: JevToolPick) => void;
    let input: Parameters<typeof pickToolsWithJev>[0] | undefined;
    const state = setup({
      settings: {
        jevToolSelection: stale !== "disabled",
        alwaysOffer: [],
        plannerToolsets: {
          research: { label: "Research", tools: ["research"], extensions: [], enabled: false, scouts: false },
        },
      },
      pickTools: (request) => {
        input = request;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await state.ready;
    const opened = state.mock.commands.get("planners")?.handler("plan it", state.context.ctx);
    await flush();
    const app = state.harness();
    assert.ok(app);
    assert.match(app.render().join("\n"), /System 1 tool picks/u);
    app.handleInput("\u001b[B");
    app.handleInput("\r");
    assert.match(app.render().join("\n"), /● Tools/u);
    if (stale === "disabled") {
      assert.equal(input, undefined, "legacy feature-off setting makes zero classifier calls");
      assert.doesNotMatch(app.render().join("\n"), /picking tools/u);
    } else {
      assert.ok(input);
      assert.match(app.render().join("\n"), /System 1.*Preferred Jev; picking tools/u);
      const target = resolveSystem1Target({ provider: "typesafe", model: "jev-latest" });
      assert.ok(target.ok);
      if (stale === "file")
        writeFileSync(join(directory, "system1.json"), JSON.stringify({ backend: "openai-decisions" }));
      if (stale === "event" || stale === "event-roundtrip") state.mock.eventBus.emit(SYSTEM1_CHANGED, {});
      if (stale === "event-roundtrip") state.mock.eventBus.emit(SYSTEM1_CHANGED, {});
      if (stale === "manual") app.handleInput("n");
      finish({
        kind: "jev",
        backend: target.backend,
        provider: target.provider,
        model: target.model,
        selectionKey: target.key,
        waterfall: [target.backend],
        targetKey: JSON.stringify([target.backend, target.provider, target.model]),
        fallback: false,
        attempts: [],
        probabilities: Object.fromEntries(input.capabilities.map((capability) => [capability.id, 0.9])),
        selected: Object.fromEntries(input.capabilities.map((capability) => [capability.id, true])),
      });
      await flush();
      const screen = app.render().join("\n");
      if (stale === "none") {
        assert.match(screen, /Jev picked/u);
        assert.match(screen, /\[x\] research/u);
      } else if (stale === "manual") {
        assert.match(screen, /Your own changes were kept/u);
        assert.match(screen, /\[ \] research/u);
        assert.match(screen, /90% suggested/u);
      } else {
        assert.match(screen, /System 1 changed/u);
        assert.match(screen, /\[ \] research/u);
        assert.doesNotMatch(screen, /90% suggested|Jev picked/u);
      }
    }
    app.handleInput("\u0003");
    app.handleInput("\u001b");
    await opened;
  });
}

for (const reversed of [false, true]) {
  for (const change of ["none", "manual", "tail", "order", "event"] as const) {
    test(`/planners preferred waterfall and actual fallback remain distinct (${reversed}, ${change})`, async () => {
      const previous = process.env.PI_CODING_AGENT_DIR;
      const directory = mkdtempSync(join(tmpdir(), "plan-waterfall-preselection-"));
      process.env.PI_CODING_AGENT_DIR = directory;
      onTestFinished(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
      });
      const waterfall = reversed ? (["openai-decisions", "jev"] as const) : (["jev", "openai-decisions"] as const);
      writeFileSync(join(directory, "system1.json"), JSON.stringify({ waterfall }));
      const target = resolveSystem1Target({ provider: "typesafe", model: "jev-latest" });
      assert.ok(target.ok);
      let finish!: (pick: JevToolPick) => void;
      let input: Parameters<typeof pickToolsWithJev>[0] | undefined;
      const state = setup({
        settings: {
          jevToolSelection: true,
          alwaysOffer: [],
          plannerToolsets: {
            research: { label: "Research", tools: ["research"], extensions: [], enabled: false, scouts: false },
          },
        },
        pickTools: (request) => {
          input = request;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      });
      await state.ready;
      const opened = state.mock.commands.get("planners")?.handler("plan it", state.context.ctx);
      await flush();
      const app = state.harness();
      assert.ok(app);
      app.handleInput("\u001b[B");
      app.handleInput("\r");
      assert.ok(input);
      assert.match(app.render().join("\n"), reversed ? /Preferred Decisions → Jev/u : /Preferred Jev → Decisions/u);
      if (change === "manual") app.handleInput("n");
      if (change === "tail" || change === "order") {
        writeFileSync(
          join(directory, "system1.json"),
          JSON.stringify({
            waterfall: change === "tail" ? [waterfall[0]] : [...waterfall].reverse(),
          }),
        );
      }
      if (change === "event") state.mock.eventBus.emit(SYSTEM1_CHANGED, {});
      const winner = waterfall[1];
      const provider = winner === "jev" ? "typesafe" : "system1-openai";
      const model = winner === "jev" ? "jev-latest" : "gpt-6-luna";
      finish({
        kind: "jev",
        backend: winner,
        provider,
        model,
        waterfall: [...waterfall],
        selectionKey: target.key,
        targetKey: JSON.stringify([winner, provider, model]),
        fallback: true,
        attempts: [],
        probabilities: Object.fromEntries(input.capabilities.map((capability) => [capability.id, 0.9])),
        selected: Object.fromEntries(input.capabilities.map((capability) => [capability.id, true])),
      });
      await flush();
      const screen = app.render().join("\n");
      if (change === "none" || change === "manual") {
        assert.match(screen, reversed ? /Jev \(fallback\) picked/u : /Decisions \(fallback\) picked/u);
        assert.match(screen, /90% suggested/u);
        assert.match(screen, change === "manual" ? /\[ \] research/u : /\[x\] research/u);
        if (change === "manual") assert.match(screen, /Your own changes were kept/u);
      } else {
        assert.match(screen, /System 1 changed/u);
        assert.match(screen, /\[ \] research/u);
        assert.doesNotMatch(screen, /90% suggested|\(fallback\) picked/u);
      }
      app.handleInput("\u0003");
      app.handleInput("\u001b");
      await opened;
    });
  }
}

async function implementationScreen(
  options: Parameters<typeof setup>[0] & { planModel?: string; plannerFiles?: Record<string, string> } = {},
) {
  const state = setup(options);
  await state.ready;
  state.mock.entries.push({
    customType: "plan-run",
    data: {
      id: "implementation-test",
      createdAt: 1,
      task: "approved task",
      state: "active",
      planners: [
        {
          id: "A",
          spec: options.planModel ?? "anthropic/claude-sonnet-5-5:low",
          name: SONNET.name,
          plan: "# Exact A\n\nDo A.",
          sessionFile: options.plannerFiles?.A,
          revision: 1,
        },
        {
          id: "B",
          spec: "anthropic/claude-opus-5-5:low",
          name: OPUS.name,
          plan: "# Exact B\n\nDo B.",
          sessionFile: options.plannerFiles?.B,
          revision: 1,
        },
      ],
      merged: {
        plan: "# Exact M\n\nDo M.",
        revision: 1,
        name: SONNET.name,
        spec: options.planModel ?? "anthropic/claude-sonnet-5-5",
      },
    },
  });
  for (const handler of state.mock.events.get("session_start") ?? []) await handler({}, state.context.ctx);
  const opened = state.mock.commands.get("planners")?.handler("", state.context.ctx);
  await flush();
  const app = state.harness();
  assert.ok(app);
  for (let index = 0; index < 5 && !/⏎ do it/u.test(app.render().join("\n")); index++) app.handleInput("\t");
  app.handleInput("\r");
  assert.match(app.render().join("\n"), /● Implement/u);
  if (!options.pickImplementationEffort) await flush();
  const focus = (label: string) => {
    for (let index = 0; index < 10; index++) {
      if (new RegExp(`${label}\\s+‹`, "u").test(app.render().join("\n"))) return;
      app.handleInput("\u001b[B");
    }
    assert.fail(`Could not focus ${label}: ${app.render().join("\n")}`);
  };
  return { ...state, app, opened, focus };
}

function effortPick(thinkingLevel: "low" | "medium" | "high" | "xhigh"): TaskEffortJudgment {
  const target = resolveSystem1Target({ provider: "typesafe", model: "jev-latest" });
  assert.ok(target.ok);
  return {
    kind: "system1",
    choice: thinkingLevel,
    confidence: 0.8,
    probabilities: {
      low: Number(thinkingLevel === "low"),
      medium: Number(thinkingLevel === "medium"),
      high: Number(thinkingLevel === "high"),
      xhigh: Number(thinkingLevel === "xhigh"),
    },
    waterfall: ["jev"],
    targetKey: target.key,
    fallback: false,
    attempts: [],
    backend: "jev",
    provider: "typesafe",
    model: "jev-latest",
    selectionKey: target.key,
  };
}

function deferredEffort() {
  const calls: Array<{
    input: Parameters<typeof pickImplementationEffort>[0];
    finish: (result: TaskEffortJudgment) => void;
  }> = [];
  const pick: typeof pickImplementationEffort = (input) => new Promise((finish) => calls.push({ input, finish }));
  return { calls, pick };
}

for (const invalidation of ["manual", "dispose"] as const) {
  test(`/planners cancels a pending quota wait without trusting its late answer: ${invalidation}`, async () => {
    const reads: Array<{
      target: { provider: string; id: string };
      signal?: AbortSignal;
      finish: (pressure: usage.SelectionPressure) => void;
    }> = [];
    const pressure = vi
      .spyOn(usage, "readSelectionPressure")
      .mockImplementation(
        (_ctx, target, options) => new Promise((finish) => reads.push({ target, signal: options?.signal, finish })),
      );
    onTestFinished(() => pressure.mockRestore());
    const pick = vi.fn<typeof pickImplementationEffort>().mockResolvedValue(effortPick("low"));
    const state = await implementationScreen({ pickImplementationEffort: pick });
    await flush();
    assert.equal(reads.length, 1);
    if (invalidation === "manual") {
      for (const handler of state.mock.events.get("thinking_level_select") ?? []) await handler({}, state.context.ctx);
    } else state.app.handleInput("\u001b");
    assert.equal(reads[0]?.signal?.aborted, true);
    reads[0]?.finish({ state: "ready", tier: "critical", p: 1 });
    await flush();
    assert.doesNotMatch(state.app.render().join("\n"), /Effort\s+low/u);
    if (invalidation !== "dispose") state.app.handleInput("\u001b");
    for (const handler of state.mock.events.get("session_shutdown") ?? []) await handler({}, state.context.ctx);
    await state.opened;
    assert.deepEqual(state.mock.thinkingLevels, []);
  });
}

for (const change of [
  "manual",
  "owned",
  "forged",
  "malformed",
  "mismatched",
  "committed",
  "committed-owned",
] as const) {
  test(`/planners validates reasoning invalidation: ${change}`, async () => {
    const requests = deferredEffort();
    const state = await implementationScreen({ pickImplementationEffort: requests.pick });
    const emitNative = async () => {
      for (const handler of state.mock.events.get("thinking_level_select") ?? []) await handler({}, state.context.ctx);
    };
    if (change === "manual") await emitNative();
    else if (change === "owned") await withEffortOrigin("flow", emitNative);
    else if (change === "forged") state.mock.eventBus.emit(SETTINGS_REASONING_COMMITTED, { level: "high" });
    else {
      const cycles = settingsCycles(state.mock.pi);
      const staged = cycles.stage(state.context.ctx, {
        key: "reasoning",
        owner: {},
        read: () => "high",
        next: () => "medium",
        format: String,
        validate: () => undefined,
        current: () => true,
        apply: () => {
          const emit = () =>
            state.mock.eventBus.emit(
              SETTINGS_REASONING_COMMITTED,
              change === "malformed" ? { level: false } : { level: change === "mismatched" ? "low" : "high" },
            );
          if (change === "committed-owned") withEffortOrigin("plan-mode", emit);
          else emit();
          return true;
        },
      });
      await cycles.flush();
      await staged;
    }
    const invalidated = change === "manual" || change === "committed";
    assert.equal(requests.calls[0]?.input.signal?.aborted, invalidated);
    requests.calls[0]?.finish(effortPick("low"));
    await flush();
    const screen = state.app.render().join("\n");
    if (invalidated) assert.doesNotMatch(screen, /Effort\s+low/u);
    else assert.match(screen, /Effort\s+low/u);
    state.app.handleInput("\u001b");
    for (const handler of state.mock.events.get("session_shutdown") ?? []) await handler({}, state.context.ctx);
    await state.opened;
    assert.deepEqual(state.mock.thinkingLevels, []);
  });
}

for (const manual of [false, true]) {
  test(`/planners refreshes a live plan revision and ${manual ? "retains manual effort" : "reclassifies the default"}`, async () => {
    const requests = deferredEffort();
    const state = await implementationScreen({ pickImplementationEffort: requests.pick });
    if (manual) {
      state.focus("Effort");
      state.app.handleInput("\u001b[D"); // inherited high -> medium while the first default is pending
    }
    const submit = state.mock.tools.find((tool) => tool.name === "plan_submit_merged");
    assert.ok(submit && typeof submit.execute === "function");
    await submit.execute(
      "revised-plan",
      { plan: "# Revised M\n\nExecute the new revision." },
      undefined,
      undefined,
      state.context.ctx,
    );
    assert.match(state.app.render().join("\n"), /M \(merged\).*v2/u);
    // A manual default needs no new judgment for Here, but other unpinned offered
    // models can still need one; either way an old result cannot replace it.
    requests.calls[0]?.finish(effortPick("low"));
    for (const call of requests.calls.slice(1)) call.finish(effortPick("high"));
    await flush();
    if (manual) assert.match(state.app.render().join("\n"), /Effort\s+‹ medium ›/u);
    else {
      assert.equal(requests.calls.length, 2);
      assert.equal(requests.calls[1]?.input.plan, "# Revised M\n\nExecute the new revision.");
      assert.match(state.app.render().join("\n"), /Effort\s+high/u);
    }
    state.app.handleInput("\r");
    await state.opened;
    await flush();
    assert.equal(state.mock.thinkingLevel, manual ? "medium" : "high");
    assert.match(state.mock.sentUserMessages.at(-1)?.text ?? "", /# Revised M/u);
  });
}

for (const clear of [false, true]) {
  test(`/planners Here recommends effort for the same model with ${clear ? "compact" : "kept"} context`, async () => {
    const requests = deferredEffort();
    const state = await implementationScreen({ pickImplementationEffort: requests.pick });
    assert.equal(requests.calls.length, 1);
    assert.equal(requests.calls[0]?.input.plan, "# Exact M\n\nDo M.");
    assert.match(requests.calls[0]?.input.conversation ?? "", /approved task/u);
    assert.match(state.app.render().join("\n"), /choosing\.\.\./u);
    state.app.handleInput("\r");
    assert.equal(state.mock.sentUserMessages.length, 0, "a pending untouched default cannot be approved");
    requests.calls[0]?.finish(effortPick("low"));
    await flush();
    assert.match(state.app.render().join("\n"), /Effort\s+low/u);
    let compact: { onComplete(result: unknown): void; customInstructions: string } | undefined;
    Object.assign(state.context.ctx, {
      compact: (options: typeof compact) => {
        compact = options;
      },
    });
    if (clear) {
      state.focus("Context");
      state.app.handleInput("\u001b[C");
    }
    state.app.handleInput("\r");
    await state.opened;
    await flush();
    if (clear) {
      assert.ok(compact);
      const before = compactionDispatcher(state.mock);
      assert.ok(before);
      const result = (await before(
        {
          customInstructions: compact.customInstructions,
          signal: new AbortController().signal,
          preparation: { tokensBefore: 10 },
        },
        state.context.ctx,
      )) as { compaction: unknown };
      compact.onComplete(result.compaction);
    }
    assert.equal(state.mock.thinkingLevel, "low");
    assert.equal(state.mock.setModels.length, 0);
    assert.equal(state.mock.sentUserMessages.length, 1);
  });
}

test("/planners reclassifies changed base keys without calls on context cycling", async () => {
  const requests = deferredEffort();
  const state = await implementationScreen({
    pickImplementationEffort: requests.pick,
  });
  requests.calls[0]?.finish(effortPick("low"));
  await flush();
  state.focus("Context");
  state.app.handleInput("\u001b[C");
  state.app.handleInput("\u001b[C");
  assert.equal(requests.calls.length, 1);
  state.focus("Plan");
  state.app.handleInput("\u001b[C");
  assert.equal(requests.calls.length, 2);
  assert.match(requests.calls[1]?.input.plan ?? "", /# Exact A/u);
  requests.calls[1]?.finish(effortPick("xhigh"));
  await flush();
  assert.match(state.app.render().join("\n"), /Effort\s+high/u, "normalize xhigh to supported high");
  state.app.handleInput("\u001b[D");
  await flush();
  assert.equal(requests.calls.length, 3, "changing the base key disposes its old judgment");
  requests.calls[2]?.finish(effortPick("low"));
  await flush();
  assert.match(state.app.render().join("\n"), /Effort\s+low/u);
  for (const handler of state.mock.events.get("session_shutdown") ?? []) await handler({}, state.context.ctx);
  await state.opened;
});

test("/planners manual effort wins a pending race and permits approval", async () => {
  const requests = deferredEffort();
  const state = await implementationScreen({ pickImplementationEffort: requests.pick });
  state.focus("Effort");
  state.app.handleInput("\u001b[D");
  assert.match(state.app.render().join("\n"), /Effort\s+‹ medium ›/u);
  state.app.handleInput("\r");
  await state.opened;
  requests.calls[0]?.finish(effortPick("xhigh"));
  await flush();
  assert.equal(state.mock.thinkingLevel, "medium");
  assert.equal(state.mock.sentUserMessages.length, 1);
});

for (const stale of ["dispose", "tree", "backend"] as const) {
  test(`/planners ignores a late recommendation after ${stale}`, async () => {
    const requests = deferredEffort();
    const state = await implementationScreen({ pickImplementationEffort: requests.pick });
    if (stale === "dispose") state.app.handleInput("\u001b");
    else if (stale === "backend") state.mock.eventBus.emit(SYSTEM1_CHANGED, {});
    else for (const handler of state.mock.events.get("session_tree") ?? []) await handler({}, state.context.ctx);
    requests.calls[0]?.finish(effortPick("low"));
    await flush();
    assert.equal(state.mock.thinkingLevel, "high");
    assert.equal(state.mock.sentUserMessages.length, 0);
    if (stale === "dispose") assert.equal(requests.calls[0]?.input.signal?.aborted, true);
    else assert.doesNotMatch(state.app.render().join("\n"), /Effort\s+low/u);
    for (const handler of state.mock.events.get("session_shutdown") ?? []) await handler({}, state.context.ctx);
    await state.opened;
  });
}

test("/planners unavailable recommendation preserves the inherited baseline", async () => {
  const requests = deferredEffort();
  const state = await implementationScreen({ thinkingLevel: "off", pickImplementationEffort: requests.pick });
  requests.calls[0]?.finish({ kind: "fallback", reason: "unavailable" });
  await flush();
  assert.match(state.app.render().join("\n"), /Effort\s+off/u);
  state.app.handleInput("\r");
  await state.opened;
  assert.equal(state.mock.thinkingLevel, "off");
});

for (const author of ["A", "B", "M"]) {
  for (const clear of [false, true]) {
    test(`/planners Here implements ${author} with ${clear ? "same-session compaction" : "conversation kept"}`, async () => {
      const approval = clear ? "bypassPermissions" : "auto";
      const plansDirectory = mkdtempSync(join(tmpdir(), "plan-flow-names-"));
      onTestFinished(() => rmSync(plansDirectory, { recursive: true, force: true }));
      const existingFile = join(plansDirectory, `exact-${author.toLowerCase()}.md`);
      writeFileSync(existingFile, "# Earlier plan\n\nKeep this content.\n");
      const state = await implementationScreen({ approval, settings: { plansDirectory } });
      const { mock, context, sessions, app, focus } = state;
      let children = 0;
      let compaction:
        | { customInstructions: string; onComplete(result: unknown): void; onError(error: Error): void }
        | undefined;
      Object.assign(context.ctx, {
        newSession: async () => {
          children++;
          return { cancelled: false };
        },
        compact: (options: typeof compaction) => {
          compaction = options;
        },
      });
      focus("Plan");
      for (
        let index = 0;
        index < 3 && !new RegExp(`Plan\\s+‹ ${author}(?: | ·)`, "u").test(app.render().join("\n"));
        index++
      )
        app.handleInput("\u001b[C");
      assert.match(app.render().join("\n"), new RegExp(`Plan\\s+‹ ${author}(?: | ·)`, "u"));
      focus("Effort");
      app.handleInput("\u001b[D");
      if (clear) {
        focus("Context");
        app.handleInput("\u001b[C");
      }
      app.handleInput("\r");
      await state.opened;
      await flush();
      const plan = `# Exact ${author}\n\nDo ${author}.`;
      if (clear) {
        assert.ok(compaction);
        assert.equal(mock.sentUserMessages.length, 0);
        const before = compactionDispatcher(mock);
        assert.ok(before);
        assert.equal(await before({ customInstructions: "ordinary compaction" }, context.ctx), undefined);
        const result = (await before(
          {
            customInstructions: compaction.customInstructions,
            signal: new AbortController().signal,
            preparation: { tokensBefore: 1234 },
          },
          context.ctx,
        )) as { compaction: { summary: string; firstKeptEntryId: null; tokensBefore: number; details: unknown } };
        assert.match(result.compaction.summary, new RegExp(`# Exact ${author}`, "u"));
        assert.ok(result.compaction.summary.endsWith(plan));
        assert.equal(result.compaction.firstKeptEntryId, null);
        assert.equal(result.compaction.tokensBefore, 1234);
        compaction.onComplete(result.compaction);
        compaction.onComplete(result.compaction);
      }
      const brief = mock.sentUserMessages.at(-1)?.text ?? "";
      assert.ok(brief.endsWith(plan));
      const planFile = join(plansDirectory, `exact-${author.toLowerCase()}-2.md`);
      assert.equal(readFileSync(planFile, "utf8"), `${plan}\n`, "save the selected current plan text");
      assert.equal(readFileSync(existingFile, "utf8"), "# Earlier plan\n\nKeep this content.\n");
      assert.equal(brief, directImplementationBrief({ plan, planFile }));
      assert.match(brief, /reply normally/u);
      assert.doesNotMatch(brief, /finish_plan|ask_planner|handed it to you/u);
      assert.equal(mock.sentUserMessages.length, 1);
      assert.equal(mock.thinkingLevel, "medium");
      assert.equal(mock.setModels.length, 0);
      assert.equal(children, 0);
      assert.equal(sessions.prompts.length, 0, "no consultant prompt");
      assert.equal(state.workflowRequests.at(-1), "work");
      assert.deepEqual(state.approvalRequests, [], `${approval} approvals are untouched`);
      assert.ok(
        !mock.entries.some(
          (entry) => entry.customType === "plan-mode:exec" || entry.customType === "plan-implementation-runtime",
        ),
      );
    });
  }
}

for (const outcome of ["error", "cancel", "tree", "shutdown"] as const) {
  test(`/planners direct compaction does not implement after ${outcome}`, async () => {
    const state = await implementationScreen();
    let compact:
      | { customInstructions: string; onComplete(result: unknown): void; onError(error: Error): void }
      | undefined;
    Object.assign(state.context.ctx, {
      compact: (options: typeof compact) => {
        compact = options;
      },
    });
    state.focus("Context");
    state.app.handleInput("\u001b[C");
    state.app.handleInput("\r");
    await state.opened;
    await flush();
    assert.ok(compact);
    const before = compactionDispatcher(state.mock);
    assert.ok(before);
    const controller = new AbortController();
    if (outcome === "cancel") controller.abort();
    const override = await before(
      { customInstructions: compact.customInstructions, signal: controller.signal, preparation: { tokensBefore: 10 } },
      state.context.ctx,
    );
    if (outcome === "cancel") assert.deepEqual(override, { cancel: true });
    if (outcome === "error" || outcome === "cancel") compact.onError(new Error("Compaction cancelled"));
    else
      for (const handler of state.mock.events.get(outcome === "tree" ? "session_tree" : "session_shutdown") ?? [])
        await handler({}, state.context.ctx);
    compact.onComplete({});
    assert.equal(state.mock.sentUserMessages.length, 0);
    assert.ok(!state.mock.entries.some((entry) => entry.customType === "plan-mode:exec"));
    assert.equal(await before({ customInstructions: compact.customInstructions }, state.context.ctx), undefined);
  });
}

type DirectCompactionResult = {
  summary: string;
  firstKeptEntryId: string | null;
  details: { planMode: { direct: string } };
};

for (const cacheFirst of [false, true]) {
  test(`/planners direct compaction preserves the exact brief with cache-guard ${cacheFirst ? "first" : "last"}`, async () => {
    const state = await implementationScreen();
    const { leanContext } = await import(new URL("../../pi-cache-guard/src/context.ts", import.meta.url).href);
    const planHandlers = [...(state.mock.events.get("session_before_compact") ?? [])];
    const lean = leanContext(state.mock.pi);
    const cacheHandlers = (state.mock.events.get("session_before_compact") ?? []).filter(
      (handler) => !planHandlers.includes(handler),
    );
    assert.equal(cacheHandlers.length, 1, "cache-guard registers one compaction handler");
    lean.armJevCompaction({ strict: true });
    let compact:
      | { customInstructions: string; onComplete(result: unknown): void; onError(error: Error): void }
      | undefined;
    Object.assign(state.context.ctx, {
      compact: (options: typeof compact) => {
        compact = options;
      },
    });
    state.focus("Context");
    state.app.handleInput("\u001b[C");
    state.app.handleInput("\r");
    await state.opened;
    await flush();
    assert.ok(compact);
    const handlers = [...(state.mock.events.get("session_before_compact") ?? [])];
    assert.equal(handlers.length, planHandlers.length + 1, "compose the real plan-mode and cache-guard handlers");
    if (cacheFirst) handlers.reverse();
    let result: DirectCompactionResult | undefined;
    for (const handler of handlers) {
      const response = (await handler(
        {
          customInstructions: compact.customInstructions,
          signal: new AbortController().signal,
          preparation: { tokensBefore: 1234 },
        },
        state.context.ctx,
      )) as { cancel?: boolean; compaction?: DirectCompactionResult } | undefined;
      assert.notEqual(response?.cancel, true);
      if (response?.compaction) result = response.compaction;
    }
    assert.ok(result);
    assert.equal(
      result.summary,
      directImplementationBrief({ plan: "# Exact M\n\nDo M.", planFile: result.details.planMode.direct }),
    );
    assert.equal(result.firstKeptEntryId, null);
    compact.onComplete(result);
    compact.onComplete(result);
    assert.equal(state.mock.sentUserMessages.length, 1);
    assert.equal(state.mock.sentUserMessages[0]?.text, result.summary);
    assert.equal(lean.lastFailure(), undefined);
    // The reserved marker must not consume a previously armed quick compaction.
    const cacheHandler = cacheHandlers[0];
    assert.ok(cacheHandler);
    assert.deepEqual(await cacheHandler({ customInstructions: "ordinary" }, state.context.ctx), { cancel: true });
  });
}

for (const replacement of ["summary", "firstKeptEntryId", "details"] as const) {
  test(`/planners direct compaction stops when a third party replaces ${replacement}`, async () => {
    const state = await implementationScreen();
    let compact:
      | { customInstructions: string; onComplete(result: unknown): void; onError(error: Error): void }
      | undefined;
    let attempts = 0;
    Object.assign(state.context.ctx, {
      compact: (options: typeof compact) => {
        attempts++;
        compact = options;
      },
    });
    const planHandler = compactionDispatcher(state.mock);
    const thirdPartyHandler = () => ({
      compaction: {
        summary: "Third-party summary",
        firstKeptEntryId: "retained-entry",
        tokensBefore: 1234,
        details: { planMode: { direct: "another-plan.md" } },
      },
    });
    state.mock.events.get("session_before_compact")?.push(thirdPartyHandler);
    state.focus("Context");
    state.app.handleInput("\u001b[C");
    state.app.handleInput("\r");
    await state.opened;
    await flush();
    assert.ok(compact);
    const event = {
      customInstructions: compact.customInstructions,
      signal: new AbortController().signal,
      preparation: { tokensBefore: 1234 },
    };
    const intended = ((await planHandler(event, state.context.ctx)) as { compaction: DirectCompactionResult })
      .compaction;
    const override = thirdPartyHandler().compaction;
    assert.ok(intended);
    assert.ok(override);
    // Change only one field, so every part of the completion contract is checked independently.
    const result = { ...intended, [replacement]: override[replacement] };
    compact.onComplete(result);
    compact.onComplete(intended);
    assert.equal(state.mock.sentUserMessages.length, 0);
    assert.equal(attempts, 1, "a replaced compaction must not retry");
    assert.ok(existsSync(intended.details.planMode.direct));
    assert.ok(
      state.context.notifications.some(
        ({ message, level }) => level === "warning" && /replaced; implementation did not start/u.test(message),
      ),
    );
    assert.equal(await planHandler(event, state.context.ctx), undefined);
  });
}

test("/planners Here retains off effort and offers no Mode or Model rows", async () => {
  const state = await implementationScreen({ thinkingLevel: "off" });
  assert.match(state.app.render().join("\n"), /Effort\s+off/u);
  assert.doesNotMatch(state.app.render().join("\n"), /Mode\s+/u);
  state.focus("Plan");
  state.app.handleInput("\u001b[C");
  state.app.handleInput("\u001b[C");
  await flush();
  assert.doesNotMatch(state.app.render().join("\n"), /Mode\s+/u);
  state.app.handleInput("\r");
  await state.opened;
  await flush();
  assert.equal(state.mock.thinkingLevel, "off");
  assert.equal(state.mock.setModels.length, 0);
  assert.match(state.mock.sentUserMessages.at(-1)?.text ?? "", /reply normally/u);
});

test("direct brief authorizes ordinary verification and a plain final response", () => {
  const brief = directImplementationBrief({ plan: "# Approved", planFile: "/approved.md", edited: true });
  assert.match(brief, /Implement it now in this conversation/u);
  assert.match(brief, /reply normally/u);
  assert.match(brief, /edited by the user/u);
  assert.doesNotMatch(brief, /exec mode|finish_plan|ask_planner|consult|handoff/iu);
});

test("/planners opens on the settings, goes through tools, plans with two planners, and implements", async () => {
  const { mock, context, sessions, harness } = setup();
  const command = mock.commands.get("planners");
  assert.ok(command);
  const opened = command.handler("add a cache", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  let screen = app.render().join("\n");
  assert.match(screen, /● Settings/u);
  assert.match(screen, /Task\s*\n {3}─+\n {4}add a cache/u, "the task is a box under its label");

  // Tab moves into the task's multi-line editor and back out.
  app.handleInput("\t");
  screen = app.render().join("\n");
  assert.match(screen, /shift\+⏎ new line/u);
  app.handleInput("\u001b[F");
  for (const char of " and its tests") app.handleInput(char);
  app.handleInput("\t");
  screen = app.render().join("\n");
  assert.match(screen, /\n {4}add a cache and its tests/u);
  assert.doesNotMatch(screen, /shift\+⏎ new line/u, "editing ended");
  assert.match(screen, /Planner A\s+‹ Claude Sonnet 5\.5 ›/u, "the rows have focus again");
  assert.doesNotMatch(screen, /default/u, "efforts are real levels");

  // Subagents get their own effort row, under theirs, once they have a model.
  const underSubagents = () => {
    const lines = app.render();
    const index = lines.findIndex((line) => line.includes("subagents"));
    return { subagents: lines[index] ?? "", next: lines[index + 1] ?? "" };
  };
  assert.match(underSubagents().next, /Planner B/u, "no subagent effort without subagents");
  for (let row = 0; row < 2; row += 1) app.handleInput("\u001b[B");
  app.handleInput("\u001b[C");
  let rows = underSubagents();
  assert.match(rows.subagents, /subagents\s+‹ Claude Sonnet 5\.5 ›\s*$/u, "the model row shows only the model");
  assert.match(rows.next, /^ {7}effort\s+medium/u, "subagents start at medium");
  app.handleInput("\u001b[B");
  app.handleInput("\u001b[D");
  rows = underSubagents();
  assert.match(rows.next, /effort\s+‹ low ›/u);
  assert.match(rows.subagents, /Claude Sonnet 5\.5/u, "the effort changes without the model");
  app.handleInput("\u001b[C");
  for (let row = 0; row < 3; row += 1) app.handleInput("\u001b[A");

  // Enter on a row goes on (Tab would move to the task).
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /● Tools/u);
  assert.doesNotMatch(screen, /▶ Start/u, "no start row in the tools");
  app.handleInput("\r");
  assert.match(app.render().join("\n"), /Start planning with 2 planners\?/u);
  app.handleInput("\r");
  await flush();
  screen = app.render().join("\n");
  assert.match(screen, /● Review/u);
  assert.match(screen, /A · Claude Sonnet 5\.5 low/u);
  assert.match(screen, /B · Claude Opus 5\.5/u);
  assert.doesNotMatch(screen, /Add a planner/u, "the planner screen always runs two");
  assert.doesNotMatch(screen, /Merger/u, "no merger model: your main agent merges");
  assert.equal(sessions.prompts.length, 2);
  assert.match(sessions.prompts[0]?.text ?? "", /add a cache/u);
  assert.match(sessions.prompts[1]?.text ?? "", /Another model is planning the same task/u);

  // Each plan landed in your main conversation, in full, without starting a turn.
  type Delivery = {
    content: string;
    details: {
      kind: string;
      id: string;
      revision?: number;
      "pi-plugins.transcript.v1": { version: number; checkpoint: { id: string; kind: string } };
    };
  };
  const deliveries = () =>
    mock.sentMessages
      .filter((sent) => (sent.message as { customType?: string }).customType === "plan-mode-plan")
      .map((sent) => sent.message as Delivery);
  assert.deepEqual(
    deliveries().map((delivery) => [delivery.details.id, delivery.details.revision]),
    [
      ["A", 1],
      ["B", 1],
    ],
  );
  assert.match(deliveries()[1]?.content ?? "", /<plan id="B" version="1">\n# Plan from claude-opus-5-5 #2/u);
  assert.match(deliveries()[1]?.content ?? "", /Planner A's plan is earlier in this conversation\./u);
  assert.deepEqual(mock.sentMessages[0]?.options, { triggerTurn: false });
  // Your main agent has its run tools while the run is active.
  const tools = () => mock.rawPi.getActiveTools();
  assert.ok(tools().includes("plan_ask_planner") && tools().includes("plan_submit_merged"));
  assert.doesNotMatch(app.render().join("\n"), /Merge into/u);

  // M, below the lanes, is your main agent: what you type there goes to your main session, and the
  // pane shows your agent's reply as it streams (fed by your main session's events).
  const mainEvent = async (type: string, payload: Record<string, unknown> = {}) => {
    for (const handler of mock.events.get(type) ?? []) await handler({ type, ...payload }, context.ctx);
  };
  screen = app.render().join("\n");
  assert.match(screen, /M · main agent · Claude Sonnet 5\.5/u, "M is there once both plans are in");
  assert.match(screen, /Plan B delivered to your agent\./u, "M's pane notes each delivery");
  assert.match(screen, /Both plans are in\. Talk them over with M here/u);
  app.handleInput("\t");
  app.handleInput("\t");
  for (const char of "which is safer?") app.handleInput(char);
  app.handleInput("\r");
  assert.equal(mock.sentUserMessages.at(-1)?.text, "which is safer?");
  // Your session's events, in the order Pi emits them.
  const user = { role: "user", content: "which is safer?" };
  const reply = { role: "assistant", content: [{ type: "text", text: "B's invalidation is safer." }] };
  await mainEvent("agent_start");
  await mainEvent("message_start", { message: user });
  await mainEvent("message_end", { message: user });
  await mainEvent("message_start", { message: { role: "assistant", content: [] } });
  await mainEvent("message_update", {
    message: reply,
    assistantMessageEvent: { type: "text_delta", delta: "B's invalidation is safer." },
  });
  screen = app.render().join("\n");
  assert.match(screen, /which is safer\?/u, "your message, as Pi shows it");
  assert.match(screen, /B's invalidation is safer\./u);
  assert.match(screen, /M main agent · Claude Sonnet 5\.5.*writing/u, "its stats row shows it working");
  assert.doesNotMatch(screen, /Write plan M/u, "not offered while M is working");
  await mainEvent("agent_end", { messages: [] });

  // With both plans in, Write plan M comes first; it asks M for the merged plan and moves to M.
  screen = app.render().join("\n");
  assert.match(screen, /Write plan M · Implement… · Export… · Discard/u);
  app.handleInput("\t");
  app.handleInput("\r");
  assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /^Write plan M: merge the planners' plans/u);
  assert.match(app.render().join("\n"), /Tab to the actions and choose Write plan M/u, "back on M's pane");

  // Your main agent asks planner A something; A answers (here it also resubmits), and v2 is delivered.
  const tool = (name: string) =>
    mock.tools.find((candidate) => (candidate as { name: string }).name === name) as unknown as {
      execute(...args: unknown[]): Promise<{ content: Array<{ text: string }> }>;
    };
  const asked = await tool("plan_ask_planner").execute(
    "t1",
    { planner: "a", message: "why this cache?" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.match(asked.content[0]?.text ?? "", /Planner A answered:[\s\S]*resubmitted its plan as v2/u);
  assert.match(sessions.prompts.at(-1)?.text ?? "", /^\[From the user's main agent[\s\S]*why this cache\?$/u);
  assert.match(app.render().join("\n"), /main agent › why this cache\?|A · Claude Sonnet 5\.5 low ─+ v2 ──/u);
  const checkpoints = deliveries().map((delivery) => delivery.details["pi-plugins.transcript.v1"].checkpoint.id);
  assert.equal(checkpoints.length, 3);
  assert.equal(new Set(checkpoints).size, 3, "each plan delivery has a distinct occurrence ID");
  for (const delivery of deliveries()) {
    const annotation = delivery.details["pi-plugins.transcript.v1"];
    assert.deepEqual(annotation, { version: 1, checkpoint: { id: annotation.checkpoint.id, kind: "plan" } });
    assert.match(annotation.checkpoint.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  }
  assert.deepEqual(deliveries().at(-1)?.details, {
    "pi-plugins.transcript.v1": { version: 1, checkpoint: { id: checkpoints[2], kind: "plan" } },
    kind: "plan",
    id: "A",
    model: "Claude Sonnet 5.5 low",
    revision: 2,
    lines: 1,
  });
  const busy = await tool("plan_ask_planner").execute(
    "t2",
    { planner: "C", message: "?" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.match(busy.content[0]?.text ?? "", /There is no planner C; this run has A and B\./u);

  // When you ask for it, your main agent records the merged plan: M, first among the plans.
  const recorded = await tool("plan_submit_merged").execute(
    "t3",
    { plan: "# Merged plan" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.match(recorded.content[0]?.text ?? "", /^Recorded as plan M\./u);
  screen = app.render().join("\n");
  assert.match(screen, /✓ M main agent · Claude Sonnet 5\.5.*plan ready/u, "M's row shows its merged plan");
  assert.match(screen, /# Merged plan|Merged plan/u, "and its pane shows it");
  assert.match(screen, /Implement… · Revise plan M · Export… · Discard/u, "M can revise its plan");
  assert.doesNotMatch(screen, /Save & close/u, "Esc hides the screen");

  // Export opens a page of its own: which plan (M first), and the path from the settings.
  app.handleInput("\t");
  app.handleInput("\u001b[C");
  app.handleInput("\u001b[C");
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /Export\s+plan M/u);
  assert.match(screen, /Plan\s+‹ M \(merged\) · Claude Sonnet 5\.5 ›/u);
  assert.match(screen, /Path\s+PLAN\.md/u);
  app.handleInput("\u001b");
  screen = app.render().join("\n");
  assert.match(screen, /Implement… · Revise plan M/u, "Esc goes back to the plans");
  assert.match(screen, /⏎ do it/u, "on the actions bar, where you came from");

  // Implement the merged plan: Implement… is first, with plan M first on its page.
  app.handleInput("\r");
  screen = app.render().join("\n");
  assert.match(screen, /● Implement/u);
  assert.match(screen, /M \(merged\) · Claude Sonnet 5\.5/u);
  await flush();
  app.handleInput("\r");
  await opened;
  await flush();
  assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Merged plan/u);
  assert.ok(!mock.entries.some((entry) => entry.customType === "plan-mode:exec"), "Here never starts exec mode");
  const brief = mock.sentUserMessages.at(-1)?.text ?? "";
  assert.doesNotMatch(brief, /finish_plan|ask_planner|handed it to you/u);
  assert.match(brief, /reply normally/u);
  const planFile = /The approved plan file is (.+)\./u.exec(brief)?.[1];
  assert.ok(planFile && existsSync(planFile), "the plan is written to a plan file");
  const stored = mock.entries.filter((entry) => entry.customType === "plan-run").at(-1)?.data as {
    state: string;
    merged?: { plan: string; revision: number };
    planners: Array<{ id: string; delivered?: { revision: number } }>;
  };
  assert.equal(stored.state, "implemented");
  assert.equal(stored.merged?.plan, "# Merged plan");
  assert.deepEqual(
    stored.planners.map((planner) => [planner.id, planner.delivered?.revision]),
    [
      ["A", 2],
      ["B", 1],
    ],
  );
  assert.ok(!tools().includes("plan_ask_planner"), "the run tools go away with the run");
});

test("a restored run keeps its deliveries and plan M, turns the tools back on, and delivers older runs' plans once", async () => {
  const { mock, context, harness } = setup();
  mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r1",
      createdAt: 1,
      task: "add a cache",
      state: "active",
      planners: [
        {
          id: "A",
          spec: "anthropic/claude-sonnet-5-5:low",
          name: "Claude Sonnet 5.5",
          sessionFile: "/a.jsonl",
          plan: "# A",
          revision: 1,
          delivered: { revision: 1, mark: 0 },
        },
        // Saved before deliveries existed: delivered now, once.
        {
          id: "B",
          spec: "anthropic/claude-opus-5-5:high",
          name: "Claude Opus 5.5",
          sessionFile: "/b.jsonl",
          plan: "# B",
          revision: 2,
        },
      ],
      merged: { plan: "# M", revision: 1, name: "Claude Opus 5.5", spec: "anthropic/claude-opus-5-5" },
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  await flush();
  const delivered = mock.sentMessages.map((sent) => (sent.message as { details?: { id: string } }).details?.id);
  assert.deepEqual(delivered, ["B"]);
  // Plans restored with the run are not announced again.
  assert.deepEqual(
    context.notifications.filter((note) => /is ready/u.test(note.message)),
    [],
  );
  assert.ok(mock.rawPi.getActiveTools().includes("plan_submit_merged"));

  const opened = mock.commands.get("planners")?.handler("", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  const screen = app.render().join("\n");
  assert.match(screen, /M · main agent · Claude Sonnet 5\.5/u, "M is your main agent, on its model");
  assert.match(screen, /✓ M main agent · Claude Sonnet 5\.5.*plan ready/u, "with plan M restored");
  assert.match(screen, /Implement…/u);
  app.handleInput("\u001b");
  app.handleInput("\r");
  await opened;
});

test("restoring a run marks the turns a reload cut off or that had failed, and resumes one only on request", async () => {
  const { mock, context, sessions, harness } = setup();
  mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r2",
      createdAt: 1,
      task: "add a cache",
      state: "active",
      planners: [
        {
          id: "A",
          spec: "anthropic/claude-sonnet-5-5:low",
          name: "Claude Sonnet 5.5",
          sessionFile: "/a.jsonl",
          turn: "interrupted",
        },
        {
          id: "B",
          spec: "anthropic/claude-opus-5-5:high",
          name: "Claude Opus 5.5",
          sessionFile: "/b.jsonl",
          turn: "failed",
        },
      ],
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  await flush();
  // Nothing starts a model call on its own: the planners are marked, and the status line says so.
  assert.equal(sessions.prompts.length, 0);
  assert.match(
    context.statuses.get("plan") ?? "",
    /A cut off \(resume in \/planners\) · B cut off \(resume in \/planners\)/u,
  );
  // The cut-off markers survive a save, so a later restore still offers to resume.
  const stored = () => {
    const entry = mock.entries.filter((entry) => entry.customType === "plan-run").at(-1);
    assert.ok(entry);
    return (entry.data as { planners: Array<{ id: string; turn?: string }> }).planners.map((planner) => [
      planner.id,
      planner.turn,
    ]);
  };
  assert.deepEqual(stored(), [
    ["A", "interrupted"],
    ["B", "failed"],
  ]);
  // /plan offers to resume each; Resume A sends the resume message to A only.
  const opened = mock.commands.get("planners")?.handler("", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  let screen = app.render().join("\n");
  assert.match(screen, /Cut off: the session restarted mid-turn/u);
  assert.match(screen, /Resume A/u);
  assert.match(screen, /Resume B/u);
  assert.doesNotMatch(screen, /M · main agent/u, "no plan yet, so no M");
  app.handleInput("\t");
  app.handleInput("\t");
  app.handleInput("\r");
  await flush();
  assert.deepEqual(
    sessions.prompts.map((prompt) => prompt.model),
    ["claude-sonnet-5-5"],
  );
  assert.match(
    sessions.prompts[0]?.text ?? "",
    /cut off because the user's pi session restarted.*Carry on from where you left off/su,
  );
  screen = app.render().join("\n");
  assert.doesNotMatch(screen, /Resume A/u, "resumed: no longer offered");
  assert.match(screen, /Resume B/u, "B is still waiting for you");
  assert.deepEqual(stored(), [
    ["A", undefined],
    ["B", "failed"],
  ]);
  // Saying something to B resumes it too (its turn then runs): no marker left.
  app.handleInput("\u001b");
  app.handleInput("\r");
  await opened;

  // A planner that was idle (done, or stopped by you) is not marked.
  const idle = setup();
  idle.mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r3",
      createdAt: 1,
      task: "t",
      state: "active",
      planners: [
        {
          id: "A",
          spec: "anthropic/claude-sonnet-5-5:low",
          name: "S",
          sessionFile: "/a.jsonl",
          plan: "# A",
          revision: 1,
        },
      ],
    },
  });
  for (const handler of idle.mock.events.get("session_start") ?? []) await handler({}, idle.context.ctx);
  await flush();
  assert.equal(idle.sessions.prompts.length, 0);
  assert.doesNotMatch(idle.context.statuses.get("plan") ?? "", /cut off/u);
});

test("a planner asking you something shows in herdr as blocked until it stops asking", async () => {
  const { mock, context, harness } = setup({ ask: true });
  const blocked: unknown[] = [];
  mock.eventBus.on("herdr:blocked", (data) => blocked.push(data));
  mock.entries.push({
    customType: "plan-run",
    data: {
      id: "r4",
      createdAt: 1,
      task: "add a cache",
      state: "active",
      planners: [
        { id: "A", spec: "anthropic/claude-sonnet-5-5:low", name: "S", sessionFile: "/a.jsonl", turn: "interrupted" },
      ],
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  await flush();
  // Restored, nothing runs, so nothing blocks; resuming A from /plan starts its turn, which asks.
  assert.deepEqual(blocked, []);
  const opened = mock.commands.get("planners")?.handler("", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  app.handleInput("\t");
  app.handleInput("\r");
  await flush();
  assert.deepEqual(blocked, [{ active: true, label: "Planner question" }]);
  app.handleInput("\u001b");
  app.handleInput("\r");
  await opened;
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, context.ctx);
  await flush();
  assert.deepEqual(blocked, [{ active: true, label: "Planner question" }, { active: false }]);
});

test("a planner refused for its login offers to log in again from /planners, then tries again", async () => {
  const logins: string[] = [];
  const { mock, context, sessions, harness } = setup({
    failFirst: { model: "claude-sonnet-5-5", error: "Encountered invalidated oauth token for user, failing request" },
    login: async (providerId) => {
      logins.push(providerId);
    },
  });
  const opened = mock.commands.get("planners")?.handler("add a cache", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  app.handleInput("\r");
  app.handleInput("\r");
  app.handleInput("\r");
  await flush();
  let screen = app.render().join("\n");
  assert.match(screen, /failed: Encountered invalidated oauth token/u);
  assert.match(screen, /Log in to anthropic…/u, "a login action for the planner's provider");
  // Tab past lane B and M to the actions; the login comes first.
  for (let i = 0; i < 3; i++) app.handleInput("\t");
  app.handleInput("\r");
  await flush();
  assert.deepEqual(logins, ["anthropic"]);
  assert.equal(sessions.prompts.length, 3, "the planner tried again");
  assert.match(sessions.prompts[2]?.text ?? "", /previous turn failed with an error/u);
  screen = app.render().join("\n");
  assert.doesNotMatch(screen, /Log in to anthropic/u, "gone once the planner recovered");
  assert.match(screen, /plan ready/u);
  assert.ok(
    context.notifications.some((note) => /Logged in to anthropic\. Planner A is trying again\./u.test(note.message)),
  );
  app.handleInput("\u001b");
  app.handleInput("\r");
  await opened;
});

test("slash commands in a lane act on that planner; in M they go to your own editor", async () => {
  const { mock, context, sessions, harness } = setup();
  const opened = mock.commands.get("planners")?.handler("add a cache", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  app.handleInput("\r");
  app.handleInput("\r");
  app.handleInput("\r");
  await flush();
  const type = (text: string) => {
    for (const char of text) app.handleInput(char);
  };
  // Lane A has focus: the hint lists the commands that match what you type.
  type("/mo");
  assert.match(app.render().join("\n"), /\/model \[query\]: switch its model/u);
  type("del opus");
  app.handleInput("\r");
  await flush();
  let screen = app.render().join("\n");
  assert.match(screen, /A · Claude Opus 5\.5 low/u, "the lane shows its new model, effort kept");
  assert.match(screen, /Model: Claude Opus 5\.5 low\./u);
  assert.ok(sessions.prompts.some((prompt) => prompt.text === "[setModel claude-opus-5-5]"));
  type("/thinking high");
  app.handleInput("\r");
  await flush();
  assert.match(app.render().join("\n"), /A · Claude Opus 5\.5 high/u);
  const stored = () =>
    mock.entries.filter((entry) => entry.customType === "plan-run").at(-1)?.data as {
      planners: Array<{ spec: string; name: string }>;
    };
  assert.deepEqual(stored().planners[0], {
    ...stored().planners[0],
    spec: "anthropic/claude-opus-5-5:high",
    name: "Claude Opus 5.5",
  });
  const before = sessions.prompts.length;
  type("//etc is fine");
  app.handleInput("\r");
  await flush();
  assert.equal(sessions.prompts.at(-1)?.text, "/etc is fine", "// sends a message that starts with a slash");
  assert.equal(sessions.prompts.length, before + 1);
  screen = app.render().join("\n");

  // M's pane sends a command to your own editor and leaves /planners.
  app.handleInput("\t");
  app.handleInput("\t");
  type("/model");
  assert.match(app.render().join("\n"), /puts this command in your session's editor/u);
  app.handleInput("\r");
  await opened;
  assert.equal(context.editorText, "/model");
});

test("another dialog waiting on you closes the planning screen, and /planners waits until it is answered", async () => {
  const { mock, context, harness } = setup();
  const opened = mock.commands.get("planners")?.handler("add a cache", context.ctx);
  await flush();
  assert.ok(harness(), "the planning screen is open");
  // Your main agent's ask_user_question (another extension) holds herdr:blocked.
  mock.rawPi.events.emit("herdr:blocked", { active: true, label: "Question" });
  await opened;
  assert.ok(context.notifications.some((note) => /asking you something/u.test(note.message)));
  await mock.commands.get("planners")?.handler("", context.ctx);
  assert.ok(context.notifications.some((note) => /Answer the open question first/u.test(note.message)));
  mock.rawPi.events.emit("herdr:blocked", { active: false });
  const reopened = mock.commands.get("planners")?.handler("", context.ctx);
  await flush();
  harness()?.handleInput("\u001b");
  harness()?.handleInput("\r");
  await reopened;
});
