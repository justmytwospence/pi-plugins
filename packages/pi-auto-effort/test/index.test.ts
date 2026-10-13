import { describe, expect, test } from "vitest";
import autoEffort, { effortState, thinkingPinned } from "../src/index.ts";
import { assistantEntry, fakeJev, harness, userEntry } from "./harness.ts";

const answers = (depth: number, ack = 0.05) => ({ depth: { type: "score", score: depth, confidence: 0.9 }, ack: { type: "bool", probability: ack } });

function setup(script: number[]) {
  const h = harness();
  autoEffort(h.pi);
  const queue = [...script];
  const jev = fakeJev(() => answers(queue.shift() ?? 1));
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => [] } });
  return { h, jev, ctx };
}

test("custom starts preserve effort without a prompt assessment", async () => {
  const { h, ctx, jev } = setup([0]);
  await h.emit("session_start", {}, ctx);
  await h.emit("before_agent_start", { messageType: "custom", message: { content: "Background job finished" } }, ctx);
  expect(jev.calls).toHaveLength(0);
  await h.emit("before_agent_start", { messageType: "user", prompt: "routine" }, ctx);
  expect(jev.calls).toHaveLength(1);
  expect(h.thinking).toBe("low");
});

test("effort follows the requests, capped at the manual level", async () => {
  const { h, ctx } = setup([0, 3, 3]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "what does ls -a do?" }, ctx);
  expect(h.thinking).toBe("low");
  await h.emit("before_agent_start", { prompt: "redesign the sync engine" }, ctx);
  expect(h.thinking).toBe("high");
  expect(h.entries.at(-1)).toMatchObject({ customType: "auto-effort:state", data: { reason: "jump", ceiling: "high" } });
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: high (auto →)");
});

test("the footer shows where the level is heading", async () => {
  const { h, ctx } = setup([1, 2, 3]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("thinking_level_select", { type: "thinking_level_select", level: "xhigh", previousLevel: "high" }, ctx);
  await h.emit("before_agent_start", { prompt: "routine" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto →)");
  // The average rises to 1.5: not enough to move, enough to point up.
  await h.emit("before_agent_start", { prompt: "a bit harder" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto ↑)");
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: xhigh (auto →)");
});

test("a manual change becomes the new ceiling; own changes do not", async () => {
  const { h, ctx } = setup([3, 3]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("thinking_level_select", { type: "thinking_level_select", level: "medium", previousLevel: "high" }, ctx);
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  // Above the new ceiling, the level comes down to it even for a hard request.
  expect(h.thinking).toBe("medium");
  expect(h.entries.at(-1)?.data).toMatchObject({ ceiling: "medium" });
});

test("Jev unavailable keeps the level; /auto-effort off restores the ceiling", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => ({ stopReason: "error", errorMessage: "timeout", answers: {} }));
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => [] } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  expect(h.thinkingChanges).toEqual([]);
  expect(h.entries.at(-1)?.data).toMatchObject({ reason: "unavailable: timed out" });

  const s = setup([0]);
  await s.h.emit("session_start", { type: "session_start" }, s.ctx);
  await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
  expect(s.h.thinking).toBe("low");
  await s.h.commands.get("auto-effort").handler("off", s.ctx);
  expect(s.h.thinking).toBe("high");
});

test("state is restored from the branch", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => answers(3));
  const ctx = h.ctx({
    modelRegistry: jev.registry,
    sessionManager: { getBranch: () => [{ type: "custom", customType: "auto-effort:state", data: { e: 0.2, dwell: 0, ceiling: "xhigh" } }] },
  });
  h.pi.setThinkingLevel("low");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("xhigh");
});

test("an entry from before the limits stage restores its level as the baseline; a manual change replaces it", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => answers(1.4));
  const ctx = h.ctx({
    modelRegistry: jev.registry,
    sessionManager: { getBranch: () => [{ type: "custom", customType: "auto-effort:state", data: { e: 1, dwell: 5, ceiling: "xhigh", level: "medium" } }] },
  });
  h.pi.setThinkingLevel("medium");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "routine" }, ctx);
  expect(h.entries.at(-1)?.data).toMatchObject({ baseline: "medium", level: "medium", reason: "hold" });
  // You pick high: it is the new ceiling and the policy's starting point.
  h.pi.setThinkingLevel("high");
  await h.emit("before_agent_start", { prompt: "routine" }, ctx);
  expect(h.entries.at(-1)?.data).toMatchObject({ from: "high", ceiling: "high", reason: "down", baseline: "medium" });
});

test("a /tree move rebuilds the state from the new branch", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => answers(1.4));
  let branch: unknown[] = [{ type: "custom", customType: "auto-effort:state", data: { e: 2.5, dwell: 5, ceiling: "xhigh", baseline: "xhigh", level: "xhigh" } }];
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => branch } });
  h.pi.setThinkingLevel("xhigh");
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toMatch(/^effort: xhigh/u);
  // The user moves to a branch whose last state was low effort with a medium ceiling.
  branch = [{ type: "custom", customType: "auto-effort:state", data: { e: 0.3, dwell: 5, ceiling: "medium", baseline: "low", level: "low" } }];
  h.pi.setThinkingLevel("low");
  await h.emit("session_tree", { type: "session_tree", newLeafId: "x", oldLeafId: "y" }, ctx);
  await h.emit("before_agent_start", { prompt: "routine" }, ctx);
  // Judged from the restored average and ceiling, not the abandoned branch's.
  expect(h.entries.at(-1)?.data).toMatchObject({ ceiling: "medium", from: "low" });
  expect((h.entries.at(-1)?.data as { e: number }).e).toBeLessThan(1);
});

test("branch reconstruction restores the last reason and clears abandoned state on an empty branch", async () => {
  const { h, ctx } = setup([0]);
  let branch: unknown[] = [];
  ctx.sessionManager.getBranch = () => branch;
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "trivial" }, ctx);
  branch = [
    { type: "custom", customType: "auto-effort:state", data: { e: 0, dwell: 0, ceiling: "high", reason: "down" } },
    { type: "custom", customType: "auto-effort:state", data: { e: 2, dwell: 4, ceiling: "xhigh", baseline: "high", level: "low", reason: "hold" } },
  ];
  const status = async () => {
    await h.commands.get("auto-effort").handler("status", ctx);
    return ctx.ui.notes.at(-1)!.message;
  };
  const entries = h.entries.length;
  await h.emit("session_tree", { type: "session_tree", newLeafId: "b", oldLeafId: "a" }, ctx);
  expect(await status()).toContain("Running average 2.00, 4 assessments at this level, last decision: hold.");
  expect(await status()).toContain("Without the limit: high.");
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: low (auto →)");

  branch = [];
  await h.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "b" }, ctx);
  const empty = await status();
  expect(empty).toContain("ceiling low");
  expect(empty).toContain("Running average -, 2 assessments at this level.");
  expect(empty).not.toContain("last decision:");
  expect(empty).not.toContain("Without the limit:");
  expect(h.entries).toHaveLength(entries);
});

test.each(["session_start", "session_tree"])("%s restores a manual level chosen after the last assessment", async (event) => {
  const { h, ctx } = setup([3]);
  ctx.sessionManager.getBranch = () => [
    // Our own change is before the assessment that records the original manual ceiling.
    { type: "thinking_level_change", thinkingLevel: "low" },
    { type: "custom", customType: "auto-effort:state", data: { e: 1, dwell: 5, ceiling: "xhigh", baseline: "low", level: "low", reason: "down" } },
    { type: "thinking_level_change", thinkingLevel: "medium" },
  ];
  await h.emit(event, { type: event }, ctx);
  await h.commands.get("auto-effort").handler("status", ctx);
  expect(ctx.ui.notes.at(-1)!.message).toContain("ceiling medium");
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("medium");
  expect(h.entries.at(-1)?.data).toMatchObject({ ceiling: "medium" });
});

describe.each(["prompt", "run"])("stale %s assessment", (phase) => {
  function pending() {
    const h = harness();
    autoEffort(h.pi);
    let resolve!: (result: unknown) => void;
    const ctx = h.ctx({
      model: { provider: "anthropic", id: "managed", compat: { supportsMidConvoEffort: true } },
      modelRegistry: {
        findOfType: () => ({}),
        classify: () => new Promise((done) => { resolve = done; }),
      },
    });
    const start = () => phase === "prompt"
      ? h.emit("before_agent_start", { prompt: "trivial" }, ctx)
      : h.emit("turn_end", { turnIndex: 0, message: { stopReason: "toolUse" }, toolResults: [{ isError: true }] }, ctx);
    const finish = () => resolve({ model: "jev", stopReason: "stop", answers: answers(0) });
    return { h, ctx, start, finish };
  }

  test.each(["session_start", "session_tree", "session_shutdown", "model_select", "thinking_level_select", "off/on", "new prompt"])("drops the callback after %s", async (change) => {
    const { h, ctx, start, finish } = pending();
    await h.emit("session_start", { type: "session_start" }, ctx);
    const assessment = start();
    if (change === "off/on") {
      await h.commands.get("auto-effort").handler("off", ctx);
      await h.commands.get("auto-effort").handler("on", ctx);
    } else if (change === "new prompt") {
      // Even a blank prompt supersedes an assessment of the previous run.
      await h.emit("before_agent_start", { prompt: " " }, ctx);
    } else if (change === "thinking_level_select") {
      h.pi.setThinkingLevel("medium");
    } else {
      await h.emit(change, { type: change }, ctx);
    }
    const before = [...h.thinkingChanges];
    finish();
    await assessment;
    expect(h.thinkingChanges).toEqual(before);
    expect(h.entries).toEqual([]);
  });

  test("uses the captured operation signal even if the context's signal changes", async () => {
    const { h, ctx, start, finish } = pending();
    const controller = new AbortController();
    let signal: AbortSignal | undefined = controller.signal;
    Object.defineProperty(ctx, "signal", { get: () => signal });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const assessment = start();
    controller.abort();
    signal = undefined;
    finish();
    await assessment;
    expect(h.thinkingChanges).toEqual([]);
    expect(h.entries).toEqual([]);
  });
});

test("a Jev answer that arrives late is dropped", async () => {
  const h = harness();
  autoEffort(h.pi);
  const pending: Array<(r: unknown) => void> = [];
  const registry = {
    findOfType: () => ({}),
    classify: () => new Promise((resolve) => pending.push(resolve)),
  };
  const ctx = h.ctx({ modelRegistry: registry, sessionManager: { getBranch: () => [] } });
  await h.emit("session_start", { type: "session_start" }, ctx);

  // A new session start while the first prompt's assessment is in flight.
  const first = h.emit("before_agent_start", { prompt: "trivial" }, ctx);
  await h.emit("session_start", { type: "session_start" }, ctx);
  pending.shift()!({ model: "jev", stopReason: "stop", answers: answers(0) });
  await first;
  expect(h.thinkingChanges).toEqual([]);
  expect(h.entries).toEqual([]);

  // Another prompt while the previous one's assessment is in flight: only the newest applies.
  const second = h.emit("before_agent_start", { prompt: "trivial" }, ctx);
  const third = h.emit("before_agent_start", { prompt: "redesign everything" }, ctx);
  pending.shift()!({ model: "jev", stopReason: "stop", answers: answers(0) });
  await second;
  expect(h.thinkingChanges).toEqual([]);
  pending.shift()!({ model: "jev", stopReason: "stop", answers: answers(3) });
  await third;
  expect(h.thinking).toBe("high");
  expect(h.entries).toHaveLength(1);

  // An aborted run, and the gate going off, drop the answer too.
  const controller = new AbortController();
  const aborted = h.emit("before_agent_start", { prompt: "trivial" }, { ...ctx, signal: controller.signal });
  controller.abort();
  pending.shift()!({ model: "jev", stopReason: "stop", answers: answers(0) });
  await aborted;
  expect(h.thinking).toBe("high");
  const off = h.emit("before_agent_start", { prompt: "trivial" }, ctx);
  await h.commands.get("auto-effort").handler("off", ctx);
  pending.shift()!({ model: "jev", stopReason: "stop", answers: answers(0) });
  await off;
  expect(h.thinking).toBe("high");
  expect(h.entries).toHaveLength(1);
});

test("effortState describes the request and the previous run", () => {
  const entries = [
    userEntry("Add caching"),
    assistantEntry("Plan: add an LRU."),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit" }] } },
    { type: "message", message: { role: "toolResult", toolName: "edit", isError: false, content: [] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [] } },
    assistantEntry("Done; one test fails."),
    userEntry("fix it"),
  ];
  expect(effortState("fix it", entries)).toEqual({
    request: "fix it",
    previous_requests: ["Add caching"],
    last_outcome: "Done; one test fails.",
    signals: { last_run_errors: 1, files_edited: 1, tool_calls: 1 },
  });
});

test("thinkingPinned", () => {
  expect(thinkingPinned(["node", "pi", "--thinking", "high"])).toBe(true);
  expect(thinkingPinned(["node", "pi", "--model", "x"])).toBe(false);
});
