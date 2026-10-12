import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type ActivitySection, stableKey } from "../src/activity.js";
import { PlannerAgent } from "../src/planner/agent.js";
import { PlannerActivity } from "../src/planner-activity.js";
import { SUBAGENT_PROGRESS_KIND } from "../src/subagent-progress.js";

initTheme("dark");
function planner() {
  return new PlannerAgent({
    id: "A",
    name: "Model A",
    spec: { provider: "test", modelId: "model" },
    cwd: "/fixture",
    sessionDir: "/fixture",
    seed: [],
    restored: true,
    timeoutMs: 0,
    access: { tools: [], extensions: [], skills: [], systemPrompt: [], policy: {} } as never,
    onChange() {},
    createSession: async () => ({
      file: undefined,
      session: { isStreaming: false, prompt: async () => {} } as never,
      subscribe: () => () => {},
      dispose() {},
    }),
  });
}

function fixture() {
  let id = "one";
  const agent = planner();
  let changed = 0;
  let stops = 0;
  let opens = 0;
  const producer = new PlannerActivity({
    agents: () => [agent],
    runId: () => id,
    task: () => "inspect\nmore",
    stop: async () => {
      stops++;
      throw new Error("stale runtime");
    },
    open: async () => {
      opens++;
    },
    changed: () => {
      changed++;
    },
  });
  producer.refresh();
  return {
    producer,
    agent,
    nextRun: () => {
      id = "two";
      producer.reset();
    },
    get changed() {
      return changed;
    },
    get stops() {
      return stops;
    },
    get opens() {
      return opens;
    },
  };
}

test("planner/scout producer has stable run-scoped ids, progress subscriptions and stale section guards", async () => {
  const f = fixture();
  try {
    const old = f.producer.section;
    const key = old.entries(10)[0]?.key;
    assert.equal(key, "one:planner:A");
    f.agent.stats.totalTokens = 100;
    const changes = f.changed;
    f.agent.note("progress");
    assert.ok(f.changed > changes);
    assert.match(old.entries(10)[0]?.stats ?? "", /100 tokens/u);
    f.agent.subagents.apply("call", {
      kind: SUBAGENT_PROGRESS_KIND,
      version: 1,
      scouts: [{ index: 0, label: "look", model: "model", task: "inspect", state: "running", startedAt: 1 }],
      events: [],
    });
    f.agent.note("scout started");
    const scoutKey = old.entries(10)[1]?.key;
    assert.equal(scoutKey, "one:scout:A1");
    f.agent.subagents.finish("call", false);
    f.agent.note("scout ended");
    assert.equal(old.entries(10)[1]?.key, scoutKey);
    assert.equal(old.pill?.(10)?.alert, "1 failed", "unseen scout failure uses the unified alert");
    f.producer.seen(Date.now() + 1);
    assert.equal(old.pill?.(10), undefined);
    old.setHosted?.(true);
    old.setHosted?.(false, "subagents");
    assert.equal(f.producer.hosted, false, "an unspecified legacy host is subagents");
    await old.dismiss?.(key ?? "");
    assert.equal(old.entries(10).length, 1);
    f.nextRun();
    assert.notEqual(f.producer.section.entries(10)[0]?.key, key);
    assert.deepEqual(old.entries(10), []);
    await old.stop?.(key ?? "");
    await old.dismiss?.(key ?? "");
    await old.openDialog?.({});
    old.setHosted?.(true);
    assert.equal(f.stops, 0);
    assert.equal(f.opens, 0);
    assert.equal(f.producer.hosted, false);
    f.producer.dispose();
    const finalChanges = f.changed;
    f.agent.stats.totalTokens++;
    f.agent.note("late");
    assert.equal(f.changed, finalChanges, "teardown releases activity subscriptions");
  } finally {
    f.producer.dispose();
    f.agent.dispose();
  }
});

test("actual /tasks stop confirmation cannot transfer to another turn behind the same planner row", async () => {
  const { TasksDialog } = await import(new URL("../../pi-bg/src/dialog.ts", import.meta.url).href);
  const f = fixture();
  await f.agent.say("first", {} as never);
  const first = f.producer.section.entries(10)[0];
  assert.ok(first?.stopToken);
  const dialog = new TasksDialog(
    { requestRender() {}, terminal: { rows: 30 } },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    { ownId: "bg", canFollow: false, sections: () => [f.producer.section] },
    () => {},
  );
  try {
    dialog.handleInput("x");
    await f.agent.stop();
    await f.agent.say("second", {} as never);
    const second = f.producer.section.entries(10)[0];
    assert.equal(second?.key, first.key);
    assert.notEqual(second?.stopToken, first.stopToken);
    dialog.handleInput("x");
    await Promise.resolve();
    assert.equal(f.stops, 0, "the old arming cannot stop the new turn");
    dialog.handleInput("x");
    await Promise.resolve();
    assert.equal(f.stops, 1);
  } finally {
    dialog.dispose();
    f.producer.dispose();
    f.agent.dispose();
  }
});

test("the actual sibling /tasks dialog consumes planner/scout rows and catches rejected async actions", async () => {
  const { TasksDialog } = await import(new URL("../../pi-bg/src/dialog.ts", import.meta.url).href);
  const f = fixture();
  f.agent.status = "working";
  f.agent.stats.endedAt = undefined;
  f.agent.note("working");
  let selected: { section: ActivitySection; key: string } | undefined;
  const key = f.producer.section.entries(10)[0]?.key;
  assert.ok(key);
  const dialog = new TasksDialog(
    { requestRender() {}, terminal: { rows: 30 } },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    { ownId: "bg", canFollow: false, sections: () => [f.producer.section], initialKey: stableKey("plan", key) },
    (result: typeof selected) => {
      selected = result;
    },
  );
  try {
    assert.match(dialog.render(120).join("\n"), /Planner A/u);
    dialog.handleInput("x");
    dialog.handleInput("x");
    await Promise.resolve();
    assert.equal(f.stops, 1);
    dialog.handleInput("\r");
    assert.equal(selected?.section, f.producer.section);
    await selected?.section.open(selected.key, {});
    assert.equal(f.opens, 1);
  } finally {
    dialog.dispose();
    f.producer.dispose();
    f.agent.dispose();
  }
});
