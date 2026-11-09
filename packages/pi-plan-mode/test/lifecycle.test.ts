import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import {
  ACTIVITY_CHANGED,
  ACTIVITY_GONE,
  ACTIVITY_HOST,
  ACTIVITY_SECTION,
  type ActivitySection,
} from "../src/activity.js";
import { FAMILY_CHANNEL, type FamilyRequest, type FamilyService, type PreparedAgent } from "../src/family-contract.js";
import planMode from "../src/index.js";
import type { PlannerSessionFactory, PlannerSessionHandle, PlannerSessionOptions } from "../src/planner/session.js";
import { settingsCycles } from "../src/settings-cycle.js";
import { SUBAGENT_PROGRESS_KIND } from "../src/subagent-progress.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");
afterEach(() => vi.restoreAllMocks());
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settings = { thinkingLevel: "inherit" as const, toggleShortcut: "ctrl+alt+p" as const, jevToolSelection: false };

function record(id: string) {
  return {
    type: "custom",
    customType: "plan-run",
    data: {
      id,
      task: `Task ${id}`,
      state: "active",
      createdAt: 1,
      planners: [
        { id: "A", name: "Model A", spec: "test/model", sessionFile: "/fixture/planner.jsonl", turn: "interrupted" },
      ],
    },
  };
}

async function fixture(family?: FamilyService) {
  const mock = createMockPi();
  if (family)
    mock.eventBus.on(FAMILY_CHANNEL, (data) => {
      (data as FamilyRequest).service = family;
    });
  let branch = [record("one")];
  let app: ReturnType<typeof createCustomSelectorHarness> | undefined;
  const ctx = createMockContext({
    mode: "tui",
    hasUI: true,
    model: { provider: "test", id: "model", name: "Model A" },
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "model", name: "Model A" }],
      find: () => ({ provider: "test", id: "model", name: "Model A" }),
    },
    sessionManager: { getBranch: () => branch, getSessionFile: () => "/fixture/main.jsonl" },
    custom: (factory: unknown) => {
      app = createCustomSelectorHarness(factory, 120, undefined, 40);
      return app.resultPromise;
    },
  }).ctx as ExtensionCommandContext;
  let prompts = 0;
  let disposed = 0;
  const sinks: Array<(event: unknown) => void> = [];
  const created: PlannerSessionOptions[] = [];
  const createSession: PlannerSessionFactory = async (_host, options) => {
    created.push(options);
    let emit = (_event: unknown) => {};
    let streaming = false;
    return {
      file: "/fixture/planner.jsonl",
      session: {
        get isStreaming() {
          return streaming;
        },
        prompt: async () => {
          streaming = true;
          prompts++;
          emit({ type: "agent_start" });
        },
        abort: async () => {},
      } as never,
      subscribe: (listener) => {
        emit = listener as typeof emit;
        sinks.push(emit);
        return () => {};
      },
      dispose: () => {
        disposed++;
      },
    };
  };
  const sections: ActivitySection[] = [];
  let changed = 0;
  mock.eventBus.on(ACTIVITY_SECTION, (data) => sections.push((data as { section: ActivitySection }).section));
  mock.eventBus.on(ACTIVITY_CHANGED, () => changed++);
  await planMode(mock.pi, { readSettings: async () => settings, createSession });
  const event = async (name: string, payload: unknown = {}) => {
    for (const handler of mock.events.get(name) ?? []) await handler(payload, ctx);
  };
  await event("session_start", { reason: "startup" });
  return {
    mock,
    ctx,
    sections,
    sinks,
    created,
    event,
    branch: (id: string) => {
      branch = [record(id)];
    },
    emptyBranch: () => {
      branch = [];
    },
    app: () => {
      assert.ok(app);
      return app;
    },
    get prompts() {
      return prompts;
    },
    get disposed() {
      return disposed;
    },
    get changed() {
      return changed;
    },
  };
}

test("restored planner enrollment does not block later Sidebar session_start initialization", async () => {
  let initialize!: (value: PreparedAgent) => void;
  const pending = new Promise<PreparedAgent>((resolve) => {
    initialize = resolve;
  });
  const observation = {
    agentId: "restored-uuid",
    membership: { version: 1, familyId: "family", agentId: "restored-uuid" },
    observer: () => undefined,
    extensions: [],
    env: {},
    finish: () => {},
    dispose: () => {},
  } satisfies PreparedAgent;
  const f = await fixture({ prepare: () => pending } as unknown as FamilyService);
  assert.equal(f.created.length, 0, "plan-mode session_start returns before Sidebar binds");
  initialize(observation);
  await tick();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]?.observer, observation.observer);
  assert.equal(f.prompts, 0, "restored enrollment never resumes a paid turn");
  await f.event("session_shutdown");
});

test("factory awaits shortcut settings, and the plan-mode shortcut awaits session initialization", async () => {
  const mock = createMockPi();
  let resolve!: (value: typeof settings) => void;
  let next: Promise<typeof settings> = new Promise((done) => {
    resolve = done;
  });
  const factory = planMode(mock.pi, { readSettings: () => next });
  assert.equal(mock.shortcuts.size, 0);
  resolve(settings);
  await factory;
  const shortcut = mock.shortcuts.get("ctrl+alt+p");
  assert.ok(shortcut);
  const cycles = settingsCycles(mock.pi);
  const trigger = { kind: "keyboard", epoch: 1, serial: 1, modifiers: 6, event: "press" } as const;
  const captured = vi.spyOn(cycles, "captureTrigger").mockReturnValue(trigger);
  const staged = vi.spyOn(cycles, "stage");
  next = new Promise((done) => {
    resolve = done;
  });
  const context = createMockContext({ mode: "tui", hasUI: true });
  const ctx = context.ctx;
  let offers = 0;
  mock.eventBus.on(ACTIVITY_SECTION, () => {
    offers++;
  });
  const start = Promise.all(
    (mock.events.get("session_start") ?? []).map((handler) => handler({ reason: "startup" }, ctx)),
  );
  const pressed = shortcut.handler(ctx);
  assert.equal(captured.mock.calls.length, 1, "capture the originating key before initialization awaits");
  captured.mockReturnValue(undefined);
  await tick();
  mock.eventBus.emit(ACTIVITY_HOST, {});
  assert.equal(offers, 0, "an initializing branch cannot offer its disposed source");
  assert.equal(context.statuses.get("workflow-mode"), "workflow: work (ctrl+alt+p to cycle)");
  resolve(settings);
  await start;
  assert.equal(offers, 1);
  await tick();
  assert.equal(context.statuses.get("workflow-mode"), "workflow: work (ctrl+alt+p to cycle)");
  assert.equal(settingsCycles(mock.pi).snapshot()?.phase, "pending");
  assert.equal(staged.mock.calls.at(-1)?.[2], trigger, "retain the same key token across initialization awaits");
  assert.equal(await settingsCycles(mock.pi).flush(), true);
  await pressed;
  // Without pi-tool-gate, the shortcut toggles plan mode in this conversation.
  assert.equal(context.statuses.get("workflow-mode"), "workflow: plan (ctrl+alt+p to cycle)");
  assert.equal(mock.sentUserMessages.length, 0);
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
  await shortcut.handler(ctx);
  assert.equal(
    context.statuses.get("workflow-mode"),
    "workflow: plan (ctrl+alt+p to cycle)",
    "a stale runtime does nothing",
  );
});

for (const transition of ["tree", "resume", "fork", "startup"] as const) {
  test(`${transition} reconstructs only the active branch, closes old runs and never resumes them`, async () => {
    const f = await fixture();
    assert.equal(f.prompts, 0);
    const old = f.sections.at(-1);
    assert.ok(old);
    const oldKey = old.entries(10)[0]?.key;
    assert.ok(oldKey);
    const opened = f.mock.commands.get("planners")?.handler("", f.ctx);
    await tick();
    f.app().handleInput("\t");
    f.app().handleInput("\r"); // Explicit Resume A.
    await tick();
    assert.equal(f.prompts, 1);
    f.sinks[0]?.({
      type: "tool_execution_update",
      toolName: "plan_subagents",
      toolCallId: "scouts",
      partialResult: {
        details: {
          kind: SUBAGENT_PROGRESS_KIND,
          version: 1,
          scouts: [{ index: 0, label: "look", model: "model", task: "inspect", state: "running", startedAt: 1 }],
          events: [],
        },
      },
    });
    assert.equal(old.entries(10).length, 2, "the same producer includes planner and scout");
    const beforeProgress = f.changed;
    f.sinks[0]?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
    assert.ok(f.changed > beforeProgress, "progress changes notify hosts without a status transition");
    f.branch("two");
    if (transition === "tree") await f.event("session_tree");
    else {
      if (transition !== "startup") await f.event("session_shutdown", { reason: transition });
      await f.event("session_start", { reason: transition });
    }
    await opened;
    assert.equal(f.disposed, 1);
    assert.equal(f.prompts, 1, "reconstruction does not start a model call");
    assert.deepEqual(old.entries(10), [], "retained host references are invalidated");
    const current = f.sections.at(-1);
    assert.ok(current);
    assert.notEqual(current.entries(10)[0]?.key, oldKey, "A in another run has another identity");
    const saves = f.mock.entries.length;
    f.sinks[0]?.({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "late" },
    });
    f.sinks[0]?.({ type: "agent_settled" });
    await old.stop?.(oldKey);
    await old.dismiss?.(oldKey);
    await old.open(oldKey, f.ctx.ui);
    assert.equal(f.mock.entries.length, saves, "late callbacks cannot append to the newly active branch");
    assert.equal(f.prompts, 1);
    await f.event("session_shutdown");
  });
}

test("tree navigation to a branch without a plan clears the run and its tools", async () => {
  const f = await fixture();
  f.emptyBranch();
  await f.event("session_tree");
  assert.deepEqual(f.sections.at(-1)?.entries(100), []);
  assert.equal(f.mock.rawPi.getActiveTools().includes("plan_ask_planner"), false);
  assert.equal(f.mock.rawPi.getActiveTools().includes("plan_submit_merged"), false);
  assert.equal(f.prompts, 0);
  await f.event("session_shutdown");
});

test("teardown invalidates the source before a surviving host synchronously announces itself", async () => {
  const f = await fixture();
  const count = f.sections.length;
  f.mock.eventBus.on(ACTIVITY_GONE, () => f.mock.eventBus.emit(ACTIVITY_HOST, {}));
  await f.event("session_shutdown");
  assert.equal(f.sections.length, count);
  const section = f.sections.at(-1);
  assert.ok(section);
  assert.deepEqual(section.entries(100), []);
  await section.openDialog?.(f.ctx.ui);
});

test("shutdown during planner creation disposes the late handle without prompting it", async () => {
  const f = await fixture();
  // A separate factory whose awaited creation spans a branch change.
  const mock = createMockPi();
  let resolve!: (handle: PlannerSessionHandle) => void;
  const pending = new Promise<PlannerSessionHandle>((done) => {
    resolve = done;
  });
  await planMode(mock.pi, { readSettings: async () => settings, createSession: () => pending });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, f.ctx);
  const opened = mock.commands.get("planners")?.handler("", f.ctx);
  await tick();
  f.app().handleInput("\t");
  f.app().handleInput("\r");
  await tick();
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, f.ctx);
  let disposed = false;
  let prompted = false;
  resolve({
    session: {
      prompt: async () => {
        prompted = true;
      },
    } as never,
    file: undefined,
    subscribe: () => () => {},
    dispose: () => {
      disposed = true;
    },
  });
  await opened;
  await tick();
  assert.equal(disposed, true);
  assert.equal(prompted, false);
  await f.event("session_shutdown");
});

async function legacyExecRuntime(entries: Array<{ customType: string; data: unknown }>, hasUI = true) {
  const mock = createMockPi();
  const context = createMockContext({
    mode: "tui",
    hasUI,
    sessionManager: {
      getSessionId: () => "legacy-session",
      getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })),
    },
  });
  await planMode(mock.pi, { readSettings: async () => settings });
  const event = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
  };
  return { mock, context, event };
}

const warnings = (f: { context: { notifications: Array<{ message: string; level?: string }> } }) =>
  f.context.notifications.filter(({ message }) => /Exec mode was removed/u.test(message));

test("a session with an unfinished legacy exec notes its removal once and continues as plain work", async () => {
  const entries = [
    { customType: "plan-mode:exec", data: { active: true, planFile: "/fixture/approved.md" } },
    { customType: "plan-implementation-runtime", data: { model: "test/implementer:high" } },
  ];
  const f = await legacyExecRuntime(entries);
  await f.event("session_start");
  await f.event("session_tree");
  const notes = warnings(f);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.level, "warning");
  assert.match(notes[0]?.message ?? "", /plan is \/fixture\/approved\.md/u);
  assert.match(f.context.statuses.get("workflow-mode") ?? "", /^workflow: work/u);
  const tools = f.mock.rawPi.getActiveTools();
  assert.ok(!tools.includes("finish_plan") && !tools.includes("continue_plan"));
  assert.deepEqual(f.mock.setModels, [], "the model is never switched on restore");
  assert.equal(f.mock.sentUserMessages.length, 0);
  assert.equal(entries.length, 2, "restore writes nothing");
});

test("no removal notice for finished legacy exec, a missing exec entry, or without a UI", async () => {
  for (const [entries, hasUI] of [
    [[{ customType: "plan-mode:exec", data: { active: false, planFile: "/fixture/approved.md" } }], true],
    [[], true],
    [[{ customType: "plan-mode:exec", data: { active: true, planFile: "/fixture/approved.md" } }], false],
  ] as const) {
    const f = await legacyExecRuntime([...entries], hasUI);
    await f.event("session_start");
    assert.equal(warnings(f).length, 0);
  }
});
