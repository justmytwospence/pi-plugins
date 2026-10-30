import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { directImplementationBrief, implementationBrief } from "../src/handoff.js";
import planMode from "../src/index.js";
import type { PlannerSessionFactory } from "../src/planner/session.js";
import type { PlanModeSettings } from "../src/settings.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");
const SONNET = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

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
  } = {},
) {
  const mock = createMockPi({ thinkingLevel: options.thinkingLevel ?? "high" });
  const sessions = fakeSessions(options.ask, options.failFirst);
  const ready = planMode(mock.pi, {
    ...(options.login ? { login: options.login } : {}),
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
  (context.ctx as { sendUserMessage?: unknown }).sendUserMessage = async (text: string) => sent.push(text);
  return { mock, context, sessions, sent, ready, harness: () => harness };
}

async function implementationScreen(options: Parameters<typeof setup>[0] = {}) {
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
          spec: "anthropic/claude-sonnet-5-5:low",
          name: SONNET.name,
          plan: "# Exact A\n\nDo A.",
          revision: 1,
        },
        { id: "B", spec: "anthropic/claude-opus-5-5:low", name: OPUS.name, plan: "# Exact B\n\nDo B.", revision: 1 },
      ],
      merged: { plan: "# Exact M\n\nDo M.", revision: 1, name: SONNET.name, spec: "anthropic/claude-sonnet-5-5" },
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
  const focus = (label: string) => {
    for (let index = 0; index < 10; index++) {
      if (new RegExp(`${label}\\s+‹`, "u").test(app.render().join("\n"))) return;
      app.handleInput("\u001b[B");
    }
    assert.fail(`Could not focus ${label}: ${app.render().join("\n")}`);
  };
  return { ...state, app, opened, focus };
}

for (const author of ["A", "B", "M"]) {
  for (const clear of [false, true]) {
    test(`/planners Here implements ${author} with ${clear ? "same-session compaction" : "conversation kept"}`, async () => {
      const state = await implementationScreen();
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
      assert.match(app.render().join("\n"), /Model\s+Claude Sonnet 5\.5/u, "Here always uses the main model");
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
        const before = mock.events.get("session_before_compact")?.[0];
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
      assert.match(brief, /reply normally/u);
      assert.doesNotMatch(brief, /finish_plan|ask_planner|handed it to you/u);
      assert.equal(mock.sentUserMessages.length, 1);
      assert.equal(mock.thinkingLevel, "medium");
      assert.equal(mock.setModels.length, 0);
      assert.equal(children, 0);
      assert.equal(sessions.prompts.length, 0, "no consultant prompt");
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
    const before = state.mock.events.get("session_before_compact")?.[0];
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
    const lean = leanContext(state.mock.pi);
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
    assert.equal(handlers.length, 2, "compose the real plan-mode and cache-guard handlers");
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
    const cacheHandler = state.mock.events.get("session_before_compact")?.[1];
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
    state.mock.events.get("session_before_compact")?.push(() => ({
      compaction: {
        summary: "Third-party summary",
        firstKeptEntryId: "retained-entry",
        tokensBefore: 1234,
        details: { planMode: { direct: "another-plan.md" } },
      },
    }));
    state.focus("Context");
    state.app.handleInput("\u001b[C");
    state.app.handleInput("\r");
    await state.opened;
    await flush();
    assert.ok(compact);
    const handlers = state.mock.events.get("session_before_compact") ?? [];
    const event = {
      customInstructions: compact.customInstructions,
      signal: new AbortController().signal,
      preparation: { tokensBefore: 1234 },
    };
    const planHandler = handlers[0];
    const thirdPartyHandler = handlers[1];
    assert.ok(planHandler);
    assert.ok(thirdPartyHandler);
    const intended = ((await planHandler(event, state.context.ctx)) as { compaction: DirectCompactionResult })
      .compaction;
    const override = ((await thirdPartyHandler(event, state.context.ctx)) as { compaction: DirectCompactionResult })
      .compaction;
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
    assert.equal(await handlers[0]?.(event, state.context.ctx), undefined);
  });
}

const implementationMap = {
  "anthropic/claude-sonnet-5-5": [{ provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "low" as const }],
};

test("/planners Here retains off effort and hides handoffs to the current session model", async () => {
  const state = await implementationScreen({
    thinkingLevel: "off",
    settings: {
      implementationModelMap: {
        "anthropic/claude-sonnet-5-5": [],
        "anthropic/claude-opus-5-5": [{ provider: "anthropic", modelId: "claude-sonnet-5-5" }],
      },
    },
  });
  assert.match(state.app.render().join("\n"), /Effort\s+off/u);
  assert.doesNotMatch(state.app.render().join("\n"), /Mode\s+/u);
  state.focus("Plan");
  state.app.handleInput("\u001b[C");
  state.app.handleInput("\u001b[C");
  assert.doesNotMatch(state.app.render().join("\n"), /Mode\s+/u);
  state.app.handleInput("\r");
  await state.opened;
  await flush();
  assert.equal(state.mock.thinkingLevel, "off");
  assert.equal(state.mock.setModels.length, 0);
  assert.match(state.mock.sentUserMessages.at(-1)?.text ?? "", /reply normally/u);
});

test("/planners mode uses configured distinct targets and preserves effort across mode changes", async () => {
  const state = await implementationScreen({ settings: { implementationModelMap: implementationMap } });
  state.focus("Mode");
  assert.match(state.app.render().join("\n"), /Mode\s+‹ Here ›/u);
  state.app.handleInput("\u001b[C");
  assert.match(state.app.render().join("\n"), /Model\s+Claude Opus 5\.5/u);
  assert.match(state.app.render().join("\n"), /Effort\s+low/u);
  state.focus("Effort");
  state.app.handleInput("\u001b[C");
  state.focus("Mode");
  state.app.handleInput("\u001b[C");
  assert.match(state.app.render().join("\n"), /Model\s+Claude Sonnet 5\.5/u);
  assert.match(state.app.render().join("\n"), /Effort\s+high/u);
  state.app.handleInput("\u001b[C");
  assert.match(state.app.render().join("\n"), /Effort\s+medium/u);
  state.app.handleInput("\r");
  await state.opened;
  await flush();
  assert.equal(state.mock.setModels.length, 1);
  assert.equal(state.mock.thinkingLevel, "medium");
  assert.ok(state.mock.entries.some((entry) => entry.customType === "plan-mode:exec"));
  assert.match(state.mock.sentUserMessages.at(-1)?.text ?? "", /finish_plan/u);
});

test("/planners genuine handoff retains the fresh-child path", async () => {
  const state = await implementationScreen({ settings: { implementationModelMap: implementationMap } });
  let child:
    | { parentSession?: string; setup(manager: unknown): Promise<void>; withSession(ctx: unknown): Promise<void> }
    | undefined;
  Object.assign(state.context.ctx, {
    waitForIdle: async () => {},
    newSession: async (options: typeof child) => {
      child = options;
      return { cancelled: false };
    },
  });
  state.focus("Mode");
  state.app.handleInput("\u001b[C");
  state.focus("Context");
  state.app.handleInput("\u001b[C");
  assert.match(state.app.render().join("\n"), /fresh session with only the plan/u);
  state.app.handleInput("\r");
  await state.opened;
  await flush();
  assert.ok(child);
  assert.equal(child.parentSession, "/main.jsonl");
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  await child.setup({
    appendCustomEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  });
  assert.equal(entries[0]?.customType, "plan-implementation-runtime");
  assert.ok(!entries.some((entry) => entry.customType === "plan-mode:exec"), "exec waits for the model switch");
  const fresh = createMockContext({ model: OPUS, sessionManager: { getBranch: () => entries } });
  for (const handler of state.mock.events.get("session_start") ?? []) await handler({}, fresh.ctx);
  assert.ok(state.mock.entries.some((entry) => entry.customType === "plan-mode:exec"));
  let prompt = "";
  await child.withSession({
    ...(fresh.ctx as ExtensionContext),
    sendUserMessage: async (text: string) => {
      prompt = text;
    },
  });
  assert.match(prompt, /finish_plan/u);
  assert.match(prompt, /# Exact M/u);
});

for (const failure of ["false", "throw", "reject"] as const) {
  test(`/planners ${failure} child model activation does not seed a consultant or start implementation`, async () => {
    const state = await implementationScreen({ settings: { implementationModelMap: implementationMap } });
    let child: { setup(manager: unknown): Promise<void>; withSession(ctx: unknown): Promise<void> } | undefined;
    Object.assign(state.context.ctx, {
      waitForIdle: async () => {},
      newSession: async (options: typeof child) => {
        child = options;
        return { cancelled: false };
      },
    });
    state.focus("Mode");
    state.app.handleInput("\u001b[C");
    state.focus("Context");
    state.app.handleInput("\u001b[C");
    state.app.handleInput("\r");
    await state.opened;
    await flush();
    assert.ok(child);
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    await child.setup({
      appendCustomEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    });
    state.mock.rawPi.setModel = () => {
      if (failure === "throw") throw new Error("Switch failed");
      return failure === "reject" ? Promise.reject(new Error("Switch failed")) : Promise.resolve(false);
    };
    const fresh = createMockContext({
      model: SONNET,
      modelRegistry: (state.context.ctx as ExtensionContext).modelRegistry,
      sessionManager: { getBranch: () => entries },
    });
    for (const handler of state.mock.events.get("session_start") ?? []) await handler({}, fresh.ctx);
    let prompts = 0;
    await child.withSession({
      ...(fresh.ctx as ExtensionContext),
      sendUserMessage: async () => {
        prompts++;
      },
    });
    assert.equal(prompts, 0);
    assert.ok(!state.mock.entries.some((entry) => entry.customType === "plan-mode:exec"));
    const runtime = entries[0];
    assert.ok(runtime);
    assert.equal((runtime.data as { exec: { planner?: unknown } }).exec.planner, undefined);
    assert.equal(state.mock.thinkingLevel, "high");
    assert.ok(fresh.notifications.some((note) => /Implementation did not start/u.test(note.message)));
  });
}

test("/planners a failed model switch never starts execution or seeds a consultant", async () => {
  const state = await implementationScreen({ settings: { implementationModelMap: implementationMap } });
  state.mock.rawPi.setModel = async () => false;
  state.focus("Mode");
  state.app.handleInput("\u001b[C");
  state.app.handleInput("\r");
  await state.opened;
  await flush();
  assert.equal(state.mock.sentUserMessages.length, 0);
  assert.equal(state.sessions.prompts.length, 0);
  assert.ok(!state.mock.entries.some((entry) => entry.customType === "plan-mode:exec"));
  assert.ok(
    state.context.notifications.some((note) =>
      /Implementation did not start; approve the plan again/u.test(note.message),
    ),
  );
});

for (const stale of ["none", "tree", "shutdown", "abort"] as const) {
  test(`/planners rejected model switch fails closed after ${stale}`, async () => {
    const state = await implementationScreen({ settings: { implementationModelMap: implementationMap } });
    const controller = new AbortController();
    Object.assign(state.context.ctx, { signal: controller.signal });
    let rejectSwitch: ((error: Error) => void) | undefined;
    state.mock.rawPi.setModel = () =>
      new Promise<boolean>((_resolve, reject) => {
        rejectSwitch = reject;
      });
    let compacted = false;
    Object.assign(state.context.ctx, {
      compact: () => {
        compacted = true;
      },
    });
    state.focus("Mode");
    state.app.handleInput("\u001b[C");
    state.app.handleInput("\r");
    await flush();
    assert.ok(rejectSwitch);
    if (stale === "abort") controller.abort();
    else if (stale !== "none")
      for (const handler of state.mock.events.get(stale === "tree" ? "session_tree" : "session_shutdown") ?? [])
        await handler({}, state.context.ctx);
    const notificationsBefore = state.context.notifications.length;
    rejectSwitch(new Error("Switch rejected"));
    await state.opened;
    await flush();
    assert.equal(state.mock.sentUserMessages.length, 0);
    assert.equal(state.sessions.prompts.length, 0);
    assert.equal(state.mock.thinkingLevel, "high");
    assert.equal(compacted, false);
    assert.ok(!state.mock.entries.some((entry) => entry.customType === "plan-mode:exec"));
    const notifications = state.context.notifications.slice(notificationsBefore);
    if (stale === "none")
      assert.ok(
        notifications.some((note) => /Implementation did not start; approve the plan again/u.test(note.message)),
      );
    else assert.equal(notifications.length, 0, "stale rejection must not notify the new context");
  });
}

test("inline handoff returns to the planning leaf before the model-change entry", async () => {
  const state = setup();
  await state.ready;
  let leaf = "planning-leaf";
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: OPUS,
    modelRegistry: (state.context.ctx as ExtensionContext).modelRegistry,
    select: async (title: string, choices: string[]) =>
      title === "Implementation effort" ? "high" : choices.find((choice) => choice.startsWith("Yes, hand off")),
    sessionManager: {
      getBranch: () => state.mock.entries.map((entry) => ({ type: "custom", ...entry })),
      getLeafId: () => leaf,
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "plan it" }] }),
    },
  });
  state.mock.rawPi.setModel = async () => {
    // Real model switches append a model-change entry, advancing the branch leaf.
    leaf = "model-change-leaf";
    return true;
  };
  for (const handler of state.mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  await state.mock.commands.get("plan")?.handler("", context.ctx);
  const inline = [...state.mock.entries].reverse().find((entry) => entry.customType === "plan-mode:inline");
  assert.ok(inline);
  writeFileSync((inline.data as { planFile: string }).planFile, "# Approved return plan");
  const tool = state.mock.tools.find((candidate) => candidate.name === "exit_plan_mode");
  assert.ok(tool);
  await (tool.execute as (...args: unknown[]) => Promise<unknown>)("approval", {}, undefined, undefined, context.ctx);
  let settled: unknown;
  for (const handler of state.mock.events.get("agent_before_settle") ?? [])
    settled = (await handler({ outcome: "completed" }, context.ctx)) ?? settled;
  const result = settled as { entries: Array<{ customType?: string; data?: { returnTo?: string } }> };
  assert.equal(leaf, "model-change-leaf");
  assert.equal(result.entries[0]?.customType, "plan-mode:exec");
  assert.equal(result.entries[0]?.data?.returnTo, "planning-leaf");
});

test("direct brief authorizes ordinary verification and a plain final response", () => {
  const brief = directImplementationBrief({ plan: "# Approved", planFile: "/approved.md", edited: true });
  assert.match(brief, /Implement it now in this conversation/u);
  assert.match(brief, /reply normally/u);
  assert.match(brief, /edited by the user/u);
  assert.doesNotMatch(brief, /exec mode|finish_plan|ask_planner|consult|handoff/iu);
});

test("the implementation brief requires honest structured completion fields in every context", () => {
  for (const context of ["here", "fresh"] as const) {
    const brief = implementationBrief({ plan: "# Plan", context });
    assert.match(brief, /finish_plan with three required nonempty fields: report/u);
    assert.match(brief, /verification \(checks and their results, including anything not run\)/u);
    assert.match(brief, /concerns \(.*failures, and remaining work; use None only when accurate\)/u);
    assert.match(brief, /informational, not user approval/u);
  }
});

test("the Completion review settings row defaults on and toggles both ways", async () => {
  const { mock, context, ready, harness } = setup();
  await ready;
  const opened = mock.commands.get("planners")?.handler("", context.ctx);
  await flush();
  const app = harness();
  assert.ok(app);
  assert.match(app.render().join("\n"), /Completion review\s+on/u);
  for (let row = 0; row < 30 && !/Completion review\s+‹ on ›/u.test(app.render().join("\n")); row++) {
    app.handleInput("\u001b[B");
  }
  assert.match(app.render().join("\n"), /Completion review\s+‹ on ›/u);
  app.handleInput("\u001b[C");
  assert.match(app.render().join("\n"), /Completion review\s+‹ off ›/u);
  app.handleInput("\u001b[D");
  assert.match(app.render().join("\n"), /Completion review\s+‹ on ›/u);
  app.handleInput("\u001b");
  await opened;
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
  type Delivery = { content: string; details: { kind: string; id: string; revision?: number } };
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
  assert.deepEqual(deliveries().at(-1)?.details, {
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
