import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  ACTIVITY_CHANGED,
  ACTIVITY_GONE,
  ACTIVITY_HOST,
  ACTIVITY_SECTION,
  type ActivitySection,
} from "../src/activity.js";
import { EXEC_ENTRY } from "../src/exec.js";
import planMode from "../src/index.js";
import { INLINE_ENTRY } from "../src/inline-plan.js";
import type { PlannerSessionFactory, PlannerSessionHandle } from "../src/planner/session.js";
import { SUBAGENT_PROGRESS_KIND } from "../src/subagent-progress.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");
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

async function fixture() {
  const mock = createMockPi();
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
  const createSession: PlannerSessionFactory = async () => {
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
  next = new Promise((done) => {
    resolve = done;
  });
  const context = createMockContext({ mode: "tui", hasUI: true });
  const ctx = context.ctx;
  let offers = 0;
  mock.eventBus.on(ACTIVITY_SECTION, () => {
    offers++;
  });
  const start = mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
  const pressed = shortcut.handler(ctx);
  await tick();
  mock.eventBus.emit(ACTIVITY_HOST, {});
  assert.equal(offers, 0, "an initializing branch cannot offer its disposed source");
  assert.equal(context.statuses.get("workflow-mode"), undefined);
  resolve(settings);
  await start;
  assert.equal(offers, 1);
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

function bootstrapRecord(model: unknown = "test/implementer:high") {
  return {
    customType: "plan-implementation-runtime",
    data: {
      model,
      exec: {
        active: true,
        planFile: "/fixture/approved.md",
        implementerModel: "test/implementer",
        implementer: "Implementer",
        asks: 0,
        costUsd: 0,
      },
    },
  };
}

async function bootstrapRuntime(entries: ReturnType<typeof createMockPi>["entries"]) {
  const mock = createMockPi();
  mock.rawPi.appendEntry = (customType, data) => {
    entries.push({ customType, data });
  };
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    model: { provider: "test", id: "planner", name: "Planner" },
    modelRegistry: { find: () => ({ provider: "test", id: "implementer", name: "Implementer" }) },
    sessionManager: { getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })) },
  });
  await planMode(mock.pi, { readSettings: async () => settings });
  const event = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
  };
  return { mock, context, event };
}

for (const superseded of ["branch", "shutdown", "workflow"] as const) {
  test(`fresh bootstrap deferred activation cannot mutate after ${superseded}`, async () => {
    const entries: ReturnType<typeof createMockPi>["entries"] = [bootstrapRecord()];
    const f = await bootstrapRuntime(entries);
    let resolve!: (result: boolean) => void;
    const activation = new Promise<boolean>((done) => {
      resolve = done;
    });
    let switches = 0;
    f.mock.rawPi.setModel = () => {
      switches++;
      return activation;
    };
    const publications: unknown[] = [];
    f.mock.eventBus.on("workflow-mode:exec", (data) => publications.push(data));
    // Suspend the bootstrap handler, as runtime replacement can interrupt lifecycle dispatch.
    const starting = f.mock.events.get("session_start")?.[0]?.({}, f.context.ctx);
    await tick();
    assert.equal(switches, 1);
    assert.equal(entries.filter((entry) => entry.customType === "plan-implementation-runtime-consumed").length, 1);
    if (superseded === "branch") {
      entries.splice(0, entries.length);
      await f.event("session_tree");
    } else if (superseded === "workflow") {
      f.mock.eventBus.emit("workflow-mode:changed", { mode: "chat", source: "transition" });
    } else await f.event("session_shutdown");
    const saved = structuredClone(entries);
    const notices = structuredClone(f.context.notifications);
    resolve(false);
    await starting;
    assert.deepEqual(entries, saved);
    assert.deepEqual(f.context.notifications, notices);
    assert.ok(!entries.some((entry) => entry.customType === EXEC_ENTRY || entry.customType === INLINE_ENTRY));
    assert.ok(!publications.some((data) => (data as { source: string }).source === "transition"));
  });
}

test("a consumed fresh bootstrap restores exec in a new runtime without activating or beginning again", async () => {
  const entries: ReturnType<typeof createMockPi>["entries"] = [bootstrapRecord()];
  const first = await bootstrapRuntime(entries);
  await first.event("session_start");
  const snapshots = entries.filter((entry) => entry.customType === EXEC_ENTRY);
  assert.ok(snapshots.length >= 1);
  const latest = snapshots.at(-1)?.data as { negotiation: { executionId: string } };
  assert.ok(latest.negotiation.executionId);
  await first.event("session_shutdown");
  const saved = structuredClone(entries);
  const reloaded = await bootstrapRuntime(entries);
  reloaded.mock.rawPi.setModel = () => {
    assert.fail("consumed bootstrap must not activate again");
  };
  const publications: unknown[] = [];
  reloaded.mock.eventBus.on("workflow-mode:exec", (data) => publications.push(data));
  await reloaded.event("session_start");
  assert.deepEqual(entries.slice(0, saved.length), saved);
  const restored = entries.filter((entry) => entry.customType === EXEC_ENTRY).at(-1)?.data as typeof latest;
  assert.deepEqual(restored, latest);
  assert.equal(restored.negotiation.executionId, latest.negotiation.executionId);
  assert.equal(entries.filter((entry) => entry.customType === "plan-implementation-runtime-consumed").length, 1);
  assert.ok(
    publications.some((data) => {
      const event = data as { active: boolean; source: string };
      return event.active && event.source === "restore";
    }),
  );
  assert.ok(!publications.some((data) => (data as { source: string }).source === "transition"));
});
