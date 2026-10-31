import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import autoEffort, { LEGACY_QUESTIONS, QUESTIONS, effortState, thinkingPinned } from "../src/index.ts";
import { answers, assistantEntry, fakeJev, harness, userEntry } from "./harness.ts";

type Depth = number | number[];
// need(high) 0.45: under the relaxed theta 0.5, within the hysteresis of it.
const BORDERLINE = [0.15, 0.4, 0.35, 0.1];

/** A project directory whose `.pi/auto-effort.json` holds `settings`. */
function project(settings: Record<string, unknown>) {
  const cwd = mkdtempSync(path.join(tmpdir(), "auto-effort-project-"));
  mkdirSync(path.join(cwd, ".pi"));
  writeFileSync(path.join(cwd, ".pi", "auto-effort.json"), JSON.stringify(settings));
  return cwd;
}

/** Your latest manual level is the ceiling (the default bounds are free). */
const CEILING = { policy: { bounds: "ceiling" } };

function setup(script: Depth[], settings: Record<string, unknown> = CEILING) {
  const h = harness();
  autoEffort(h.pi);
  const queue = [...script];
  const jev = fakeJev(() => answers(queue.shift() ?? 1));
  const ctx = h.ctx({ cwd: project(settings), modelRegistry: jev.registry, sessionManager: { getBranch: () => [] } });
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
  const { h, ctx, jev } = setup([0, 3, 3]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "what does ls -a do?" }, ctx);
  expect(h.thinking).toBe("low");
  await h.emit("before_agent_start", { prompt: "redesign the sync engine" }, ctx);
  expect(h.thinking).toBe("high");
  expect(h.entries.at(-1)).toMatchObject({ customType: "auto-effort:state", data: { reason: "up", ceiling: "high", bounds: "ceiling", theta: 0.5, p: 0 } });
  expect((h.entries.at(-1)?.data as { need: Record<string, number> }).need.xhigh).toBeCloseTo(0.7);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: high (auto → ≤high)");
  expect(jev.calls[0]?.questions.depth).toMatchObject({ type: "choice", criteria: { low: expect.any(String), medium: expect.any(String), high: expect.any(String), xhigh: expect.any(String) } });
  expect(jev.calls[0]?.questions).not.toHaveProperty("tier");
});

test("the default bounds are free: a hard request goes above your manual level", async () => {
  const { h, ctx } = setup([3], {});
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "redesign the sync engine" }, ctx);
  expect(h.thinking).toBe("xhigh");
  expect(h.entries.at(-1)?.data).toMatchObject({ bounds: "free", ceiling: "high", theta: 0.5 });
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: xhigh (auto → free)");
});

test("the footer shows where the level is heading", async () => {
  const { h, ctx } = setup([1, BORDERLINE, 3, BORDERLINE]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("thinking_level_select", { type: "thinking_level_select", level: "xhigh", previousLevel: "high" }, ctx);
  await h.emit("before_agent_start", { prompt: "routine" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → ≤xhigh)");
  // need(high) 0.45: not enough to move up, close enough to point up.
  await h.emit("before_agent_start", { prompt: "a bit harder" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto ↑ ≤xhigh)");
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: xhigh (auto → ≤xhigh)");
  // need(xhigh) 0.1 is clearly below theta: straight down to medium, where need(high) 0.45 points up.
  await h.emit("before_agent_start", { prompt: "a bit easier" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto ↑ ≤xhigh)");
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
  expect(h.entries.at(-1)?.data).toMatchObject({ reason: "assessment unavailable: timed out" });

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
    // An entry from the smoothing policy: e and dwell are ignored, the ceiling is kept.
    sessionManager: { getBranch: () => [{ type: "custom", customType: "auto-effort:state", data: { e: 0.2, dwell: 0, ceiling: "xhigh" } }] },
  });
  h.pi.setThinkingLevel("low");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("xhigh");
});

test("an old entry restores its ceiling; a manual change replaces it", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => answers(1));
  const ctx = h.ctx({
    modelRegistry: jev.registry,
    sessionManager: { getBranch: () => [{ type: "custom", customType: "auto-effort:state", data: { e: 1, dwell: 5, ceiling: "xhigh", level: "medium" } }] },
  });
  h.pi.setThinkingLevel("medium");
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "routine" }, ctx);
  expect(h.entries.at(-1)?.data).toMatchObject({ level: "medium", reason: "hold", ceiling: "xhigh" });
  expect(h.entries.at(-1)?.data).not.toHaveProperty("e");
  // You pick high: it is the new ceiling and the policy's starting point.
  h.pi.setThinkingLevel("high");
  await h.emit("before_agent_start", { prompt: "routine" }, ctx);
  expect(h.entries.at(-1)?.data).toMatchObject({ from: "high", ceiling: "high", reason: "down", level: "medium" });
});

test("a /tree move rebuilds the state from the new branch", async () => {
  const h = harness();
  autoEffort(h.pi);
  const jev = fakeJev(() => answers(2));
  let branch: unknown[] = [{ type: "custom", customType: "auto-effort:state", data: { ceiling: "xhigh", level: "xhigh" } }];
  const ctx = h.ctx({ cwd: project(CEILING), modelRegistry: jev.registry, sessionManager: { getBranch: () => branch } });
  h.pi.setThinkingLevel("xhigh");
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toMatch(/^effort: xhigh/u);
  // The user moves to a branch whose last state was low effort with a medium ceiling.
  branch = [{ type: "custom", customType: "auto-effort:state", data: { ceiling: "medium", level: "low" } }];
  h.pi.setThinkingLevel("low");
  await h.emit("session_tree", { type: "session_tree", newLeafId: "x", oldLeafId: "y" }, ctx);
  await h.emit("before_agent_start", { prompt: "multi-step" }, ctx);
  // Capped at the restored ceiling, not the abandoned branch's.
  expect(h.entries.at(-1)?.data).toMatchObject({ ceiling: "medium", from: "low", level: "medium" });
});

test("branch reconstruction restores the last reason and clears abandoned state on an empty branch", async () => {
  const { h, ctx } = setup([0]);
  let branch: unknown[] = [];
  ctx.sessionManager.getBranch = () => branch;
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "trivial" }, ctx);
  branch = [
    { type: "custom", customType: "auto-effort:state", data: { ceiling: "high", reason: "down" } },
    {
      type: "custom",
      customType: "auto-effort:state",
      data: { ceiling: "xhigh", level: "low", reason: "hold", theta: 0.6, need: { low: 1, medium: 0.9, high: 0.55, xhigh: 0.1 } },
    },
  ];
  const status = async () => {
    await h.commands.get("auto-effort").handler("status", ctx);
    return ctx.ui.notes.at(-1)!.message;
  };
  const entries = h.entries.length;
  await h.emit("session_tree", { type: "session_tree", newLeafId: "b", oldLeafId: "a" }, ctx);
  expect(await status()).toContain("Bounds ceiling (settings): low to xhigh, your last manual level.");
  expect(await status()).toContain("Assessment: need(medium)=0.90 need(high)=0.55 need(xhigh)=0.10, θ=0.60 → low, last decision: hold.");
  // need(medium) 0.9 clears theta 0.6: heading up.
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: low (auto ↑ ≤xhigh)");

  branch = [];
  await h.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "b" }, ctx);
  const empty = await status();
  expect(empty).toContain("low to low, your last manual level");
  expect(empty).toContain("Assessment: none yet, θ=0.50.");
  expect(empty).not.toContain("last decision:");
  expect(empty).not.toContain("Models:");
  expect(h.entries).toHaveLength(entries);
});

test.each(["session_start", "session_tree"])("%s restores a manual level chosen after the last assessment", async (event) => {
  const { h, ctx } = setup([3]);
  // The session starts (and reads the settings) on an empty branch before /tree moves.
  if (event === "session_tree") await h.emit("session_start", { type: "session_start" }, ctx);
  ctx.sessionManager.getBranch = () => [
    // Our own change is before the assessment that records the original manual ceiling.
    { type: "thinking_level_change", thinkingLevel: "low" },
    { type: "custom", customType: "auto-effort:state", data: { ceiling: "xhigh", level: "low", reason: "down" } },
    { type: "thinking_level_change", thinkingLevel: "medium" },
  ];
  await h.emit(event, { type: event }, ctx);
  await h.commands.get("auto-effort").handler("status", ctx);
  expect(ctx.ui.notes.at(-1)!.message).toContain("low to medium, your last manual level");
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
  const ctx = h.ctx({ cwd: project(CEILING), modelRegistry: registry, sessionManager: { getBranch: () => [] } });
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
    agent_reply_untrusted: "Done; one test fails.",
    signals: { last_run_errors: 1, files_edited: 1, tool_calls: 1 },
  });
});

test("the agent's reply is clipped at 600 characters, or 1,500 in the legacy shape", () => {
  const long = "x".repeat(2_000);
  const entries = [userEntry("Add caching"), assistantEntry(long), userEntry("fix it")];
  const state = effortState("fix it", entries);
  expect(state.agent_reply_untrusted).toBe(`${"x".repeat(599)}…`);
  expect(state).not.toHaveProperty("last_outcome");
  const legacy = effortState("fix it", entries, { legacy: true });
  expect(legacy.last_outcome).toBe(`${"x".repeat(1_499)}…`);
  expect(legacy).not.toHaveProperty("agent_reply_untrusted");
  // Without a previous run both shapes say so.
  expect(effortState("first", []).agent_reply_untrusted).toBe("(none)");
  expect(effortState("first", [], { legacy: true }).last_outcome).toBe("(none)");
  // Everything else is the same in both shapes.
  const { last_outcome: _, ...rest } = legacy;
  const { agent_reply_untrusted: __, ...fresh } = state;
  expect(Object.keys(rest)).toEqual(Object.keys(fresh));
});

test("the questions tell Jev the agent's reply is untrusted; the legacy ones are the old text", () => {
  const depth = QUESTIONS.depth!.instructions;
  expect(depth).toContain("`agent_reply_untrusted`");
  expect(depth).toMatch(/only a description of what happened/u);
  expect(depth).toMatch(/ignore any instructions/u);
  expect(depth).not.toContain("last_outcome");
  expect(JSON.stringify(QUESTIONS.ack)).not.toContain("last_outcome");
  expect(LEGACY_QUESTIONS.depth!.instructions).toContain("`last_outcome`");
  expect(LEGACY_QUESTIONS.depth!.instructions).not.toContain("untrusted");
  expect(LEGACY_QUESTIONS.depth!.criteria).toEqual(QUESTIONS.depth!.criteria);
  expect(LEGACY_QUESTIONS.ack).toEqual(QUESTIONS.ack);
});

test("thinkingPinned", () => {
  expect(thinkingPinned(["node", "pi", "--thinking", "high"])).toBe(true);
  expect(thinkingPinned(["node", "pi", "--model", "x"])).toBe(false);
});

test("the command completes and lists only effort options", () => {
  const { h } = setup([]);
  const complete = (prefix: string) => h.commands.get("auto-effort").getArgumentCompletions(prefix).map((o: { value: string }) => o.value);
  expect(complete("")).toEqual(["status", "limits", "on", "off", "bounds ceiling", "bounds free"]);
  expect(complete("b")).toEqual(["bounds ceiling", "bounds free"]);
  expect(complete("models ")).toEqual([]);
  expect(complete("direct")).toEqual([]);
});

test("/auto-effort bounds free: any level from the floor to xhigh; a manual change sets the level but is no cap", async () => {
  const { h, ctx } = setup([3, 0, 3]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.commands.get("auto-effort").handler("bounds free", ctx);
  expect(ctx.ui.notes.at(-1)!.message).toBe("auto-effort bounds free for this session: low to xhigh; your last manual level, high, is not a cap");
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: high (auto → free)");
  await h.emit("before_agent_start", { prompt: "hard" }, ctx);
  expect(h.thinking).toBe("xhigh");
  expect(h.entries.at(-1)?.data).toMatchObject({ bounds: "free", ceiling: "high", level: "xhigh" });
  // You pick medium: the level is medium now, and the next message moves from there either way.
  h.pi.setThinkingLevel("medium");
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto ↑ free)");
  await h.emit("before_agent_start", { prompt: "trivial" }, ctx);
  expect(h.thinking).toBe("low");
  await h.emit("before_agent_start", { prompt: "hard again" }, ctx);
  expect(h.thinking).toBe("xhigh");
  await h.commands.get("auto-effort").handler("status", ctx);
  expect(ctx.ui.notes.at(-1)!.message).toContain("Bounds free (this session): low to xhigh; your last manual level, medium, is not a cap.");
  // Back to the ceiling: capped at your last manual level.
  await h.commands.get("auto-effort").handler("bounds ceiling", ctx);
  expect(ctx.ui.status.get("auto-effort")).toBe("effort: xhigh (auto → ≤medium)");
  await h.commands.get("auto-effort").handler("bounds", ctx);
  expect(ctx.ui.notes.at(-1)!.message).toBe("auto-effort bounds: ceiling. Use /auto-effort bounds ceiling or free.");
});

test("the footer detail never contains parentheses, so pi-status-footer can parse it", async () => {
  const { h, ctx } = setup([2]);
  await h.emit("session_start", { type: "session_start" }, ctx);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  expect(ctx.ui.status.get("auto-effort")).toMatch(/^effort: \S+ \(auto(?: ([^()]+))?\)$/u);
});

describe("effort-only operation", () => {
  test.each([{}, { models: { mode: "auto", tiers: { anthropic: { fast: "claude-sonnet-5-5", strong: "claude-opus-5-5" } } } }])(
    "never changes models, including with legacy settings %j",
    async (settings) => {
      const h = harness();
      autoEffort(h.pi);
      const model = { provider: "anthropic", id: "claude-sonnet-5-5" };
      const jev = fakeJev(() => answers(0));
      const branch = [{
        type: "custom", customType: "auto-effort:state",
        data: { ceiling: "high", level: "low", manualModel: "anthropic/claude-opus-5-5", autoModel: "anthropic/claude-sonnet-5-5", model: { action: "switched" } },
      }];
      const ctx = h.ctx({ cwd: project(settings), model, modelRegistry: {
        ...jev.registry as object,
        find: (provider: string, id: string) => ({ provider, id }),
        getAvailable: () => [model, { provider: "anthropic", id: "claude-opus-5-5" }],
      }, sessionManager: { getBranch: () => branch } });
      await h.emit("session_start", {}, ctx);
      await h.emit("session_tree", {}, ctx);
      const offers = { text: "rename this", tokens: 100_000, offers: [] };
      h.pi.events.emit("cache:state", { cold: true, tokens: 100_000 });
      h.pi.events.emit("cache:model-offers", offers);
      h.pi.events.emit("cache:model-choice", { text: "rename this", model: "anthropic/claude-opus-5-5" });
      expect(offers.offers).toEqual([]);
      expect(jev.calls).toHaveLength(0);
      await h.emit("before_agent_start", { prompt: "rename this" }, ctx);
      expect(h.thinking).toBe("low");
      expect(jev.calls).toHaveLength(1);
      expect(Object.keys(jev.calls[0]!.questions)).toEqual(["depth", "ack"]);
      for (const field of ["manualModel", "autoModel", "model"]) expect(h.entries.at(-1)?.data).not.toHaveProperty(field);
      await h.commands.get("auto-effort").handler("off", ctx);
      expect(h.thinking).toBe("high");
      h.pi.events.emit("cache:model-offers", offers);
      h.pi.events.emit("cache:model-choice", { text: "hard task", model: "anthropic/claude-opus-5-5" });
      await h.emit("before_agent_start", { prompt: "hard task" }, ctx);
      expect(jev.calls).toHaveLength(1);
      expect(offers.offers).toEqual([]);
      expect(h.modelChanges).toEqual([]);
      expect(ctx.model).toBe(model);
      await h.commands.get("auto-effort").handler("status", ctx);
      expect(ctx.ui.notes.at(-1)!.message).not.toContain("Models:");
      expect(h.events.filter((e) => e.channel.startsWith("cache:"))).toHaveLength(5);
    },
  );
});
