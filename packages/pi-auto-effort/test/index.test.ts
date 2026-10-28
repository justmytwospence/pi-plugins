import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import autoEffort, { effortState, modelPinnedByArgv, thinkingPinned } from "../src/index.ts";
import { answers, assistantEntry, fakeJev, harness, tierAnswer, userEntry } from "./harness.ts";

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
  expect(empty).toContain("Models: auto (settings): no tiers for this provider.");
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
    last_outcome: "Done; one test fails.",
    signals: { last_run_errors: 1, files_edited: 1, tool_calls: 1 },
  });
});

test("thinkingPinned", () => {
  expect(thinkingPinned(["node", "pi", "--thinking", "high"])).toBe(true);
  expect(thinkingPinned(["node", "pi", "--model", "x"])).toBe(false);
});

test("the command completes and lists bounds and models", () => {
  const { h } = setup([]);
  const complete = (prefix: string) => h.commands.get("auto-effort").getArgumentCompletions(prefix).map((o: { value: string }) => o.value);
  expect(complete("")).toEqual(["status", "limits", "on", "off", "bounds ceiling", "bounds free", "models off", "models auto"]);
  expect(complete("b")).toEqual(["bounds ceiling", "bounds free"]);
  expect(complete("models ")).toEqual(["models off", "models auto"]);
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

describe("model choice", () => {
  const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" };
  const SONNET = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" };
  const OPUS = { provider: "anthropic", id: "claude-opus-4-5", name: "Opus" };
  const SONNET_55 = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
  const OPUS_55 = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" };
  const ALL = [HAIKU, SONNET, OPUS, SONNET_55, OPUS_55];
  const THREE = { anthropic: { fast: "anthropic/claude-haiku-4-5", balanced: "anthropic/claude-sonnet-4-5", strong: "anthropic/claude-opus-4-5" } };
  const EASY = { fast: 0.8, balanced: 0.15, strong: 0.05 };
  const HARD = { fast: 0.02, balanced: 0.08, strong: 0.9 };
  // For the preset's two tiers.
  const ROUTINE = { balanced: 0.8, strong: 0.2 };
  const TOUGH = { balanced: 0.1, strong: 0.9 };

  interface Options {
    mode?: string;
    model?: typeof OPUS;
    /** `models.tiers`; omitted for the built-in preset. */
    tiers?: Record<string, unknown>;
    bounds?: string;
    tokens?: number;
    ack?: number;
  }

  function setupModels(options: Options = {}) {
    let clock = Date.UTC(2026, 0, 1);
    const h = harness();
    autoEffort(h.pi, { now: () => clock, env: {} });
    const tier: Array<Record<string, number>> = [];
    const jev = fakeJev((questions) => answers(1, options.ack ?? 0.05, questions.tier ? { tier: tierAnswer(tier.shift() ?? EASY) } : {}));
    const registry = Object.assign(jev.registry as object, {
      find: (provider: string, id: string) => ALL.find((m) => m.provider === provider && m.id === id),
      getAvailable: () => ALL,
    });
    const branch: unknown[] = [];
    let tokens = options.tokens ?? 100_000;
    const ctx = h.ctx({
      cwd: project({
        models: { mode: options.mode ?? "auto", ...(options.tiers ? { tiers: options.tiers } : {}) },
        ...(options.bounds ? { policy: { bounds: options.bounds } } : {}),
      }),
      model: options.model ?? OPUS,
      modelRegistry: registry,
      sessionManager: { getBranch: () => branch },
      getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 0 }),
    });
    /** A finished exchange: the branch has an answer and the clock starts the cache TTL. */
    const answered = async () => {
      branch.push(userEntry("q"), assistantEntry("a"));
      await h.emit("message_end", { type: "message_end", message: { role: "assistant" } }, ctx);
    };
    /** pi-cache-guard's cold-cache dialog: collects the offers for `text`. */
    const offers = async (text: string) => {
      const payload = { text, tokens: 150_000, offers: [] as Array<Promise<unknown>> };
      h.pi.events.emit("cache:model-offers", payload);
      return { pushed: payload.offers.length, offers: await Promise.all(payload.offers) };
    };
    return {
      h,
      ctx,
      jev,
      tier,
      branch,
      answered,
      offers,
      now: () => clock,
      advance: (ms: number) => (clock += ms),
      setTokens: (n: number) => (tokens = n),
      model: () => `${ctx.model.provider}/${ctx.model.id}`,
      state: () => h.entries.filter((e) => e.customType === "auto-effort:state").at(-1)?.data as Record<string, any>,
    };
  }

  test("down only while switching is cheap, up whenever the work needs it", async () => {
    const s = setupModels({ tiers: THREE, bounds: "ceiling" });
    await s.h.emit("session_start", { type: "session_start" }, s.ctx);
    s.tier.push(EASY);
    await s.h.emit("before_agent_start", { prompt: "what does ls -a do?" }, s.ctx);
    expect(Object.keys(s.jev.calls[0]!.questions.tier.criteria)).toEqual(["fast", "balanced", "strong"]);
    expect(s.model()).toBe("anthropic/claude-haiku-4-5");
    expect(s.ctx.ui.notes.at(-1)!.message).toBe("auto-effort: Haiku for this request; first message");
    expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → ≤high ≈haiku-4-5)");
    expect(s.state()).toMatchObject({ manualModel: "anthropic/claude-opus-4-5", autoModel: "anthropic/claude-haiku-4-5", model: { tier: "fast", action: "switched", why: "first message" } });

    // Warm cache and a large context: Jev is asked (a stronger tier is in bounds); easy work stays.
    await s.answered();
    s.advance(60_000);
    s.tier.push(EASY);
    await s.h.emit("before_agent_start", { prompt: "rename tmp to buffer" }, s.ctx);
    expect(s.jev.calls[1]!.questions).toHaveProperty("tier");
    expect(s.model()).toBe("anthropic/claude-haiku-4-5");

    // Still warm, hard work: back to your model, accepting one cache rewrite.
    await s.answered();
    s.advance(60_000);
    s.tier.push(HARD);
    await s.h.emit("before_agent_start", { prompt: "now the hard part" }, s.ctx);
    expect(s.model()).toBe("anthropic/claude-opus-4-5");
    expect(s.ctx.ui.notes.at(-1)!.message).toBe("auto-effort: back to Opus; harder request, one cache rewrite");
    expect(s.state()).toMatchObject({ manualModel: "anthropic/claude-opus-4-5", model: { tier: "strong", action: "switched", why: "harder request" } });
    expect(s.state()).not.toHaveProperty("autoModel");

    // Warm, on the strongest model in bounds: Jev is not asked about tiers, and easy work does not drop.
    await s.answered();
    s.advance(60_000);
    s.tier.push(EASY);
    await s.h.emit("before_agent_start", { prompt: "and a typo" }, s.ctx);
    expect(s.jev.calls[3]!.questions).not.toHaveProperty("tier");
    expect(s.model()).toBe("anthropic/claude-opus-4-5");

    // Past the 5-minute TTL the cache is cold: easy work steps down again.
    s.advance(301_000);
    s.tier.push(EASY);
    await s.h.emit("before_agent_start", { prompt: "another lookup" }, s.ctx);
    expect(s.model()).toBe("anthropic/claude-haiku-4-5");
    expect(s.state()).toMatchObject({ model: { why: "cache is cold", action: "switched" } });
    expect(s.h.modelChanges.map((m) => m.id)).toEqual(["claude-haiku-4-5", "claude-opus-4-5", "claude-haiku-4-5"]);
  });

  test("the preset: Sonnet and Opus; warm and hard on an auto-picked Sonnet returns to Opus; warm and easy on Opus stays", async () => {
    const s = setupModels({ model: OPUS_55 });
    await s.h.emit("session_start", { type: "session_start" }, s.ctx);
    s.tier.push(ROUTINE);
    await s.h.emit("before_agent_start", { prompt: "rename tmp to buffer" }, s.ctx);
    expect(Object.keys(s.jev.calls[0]!.questions.tier.criteria)).toEqual(["balanced", "strong"]);
    expect(s.model()).toBe("anthropic/claude-sonnet-5-5");
    expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → free ≈sonnet-5-5)");

    await s.answered();
    s.advance(60_000);
    s.tier.push(TOUGH);
    await s.h.emit("before_agent_start", { prompt: "redesign the sync engine" }, s.ctx);
    expect(s.model()).toBe("anthropic/claude-opus-5-5");
    expect(s.ctx.ui.notes.at(-1)!.message).toBe("auto-effort: back to Claude Opus 5.5; harder request, one cache rewrite");

    await s.answered();
    s.advance(60_000);
    s.tier.push(ROUTINE);
    await s.h.emit("before_agent_start", { prompt: "fix the typo" }, s.ctx);
    expect(s.jev.calls[2]!.questions).not.toHaveProperty("tier");
    expect(s.model()).toBe("anthropic/claude-opus-5-5");
    await s.h.commands.get("auto-effort").handler("status", s.ctx);
    expect(s.ctx.ui.notes.at(-1)!.message).toContain(
      "Models: auto (settings): balanced claude-sonnet-5-5, strong claude-opus-5-5 (preset); your model anthropic/claude-opus-5-5.",
    );
  });

  test("a small context counts as cheap to switch; pi-cache-guard's cache:state overrides the time estimate", async () => {
    const s = setupModels({ tiers: THREE, tokens: 10_000 });
    await s.h.emit("session_start", { type: "session_start" }, s.ctx);
    await s.answered();
    await s.h.emit("before_agent_start", { prompt: "rename tmp to buffer" }, s.ctx);
    expect(s.state()).toMatchObject({ model: { why: "small context", action: "switched" } });
    expect(s.model()).toBe("anthropic/claude-haiku-4-5");

    s.setTokens(100_000);
    // Warm by the clock, but pi-cache-guard says the cache is cold.
    await s.answered();
    s.h.pi.events.emit("cache:state", { cold: true, tokens: 100_000 });
    s.tier.push(HARD);
    await s.h.emit("before_agent_start", { prompt: "hard" }, s.ctx);
    expect(s.state()).toMatchObject({ model: { why: "cache is cold", tier: "strong" } });
    expect(s.model()).toBe("anthropic/claude-opus-4-5");

    // Cold by the clock, but pi-cache-guard says it is warm (it kept the cache alive).
    await s.answered();
    s.h.pi.events.emit("cache:state", { cold: false, tokens: 100_000 });
    s.advance(3_600_000);
    const calls = s.jev.calls.length;
    await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
    expect(s.jev.calls[calls]!.questions).not.toHaveProperty("tier");
    expect(s.model()).toBe("anthropic/claude-opus-4-5");

    // A warm cache of another model is no use to this one.
    s.h.pi.events.emit("cache:state", { cold: false, tokens: 100_000, model: "anthropic/claude-haiku-4-5" });
    await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
    expect(s.jev.calls.at(-1)!.questions).toHaveProperty("tier");
    expect(s.state()).toMatchObject({ model: { why: "cache is cold" } });
  });

  test("without pi-cache-guard, Pi's cache-warming refreshes keep the cache warm", async () => {
    const s = setupModels({ tiers: THREE });
    await s.h.emit("session_start", { type: "session_start" }, s.ctx);
    await s.answered();
    // Pi refreshed the cache four minutes after the answer; six minutes in, it is still warm.
    s.branch.push({ type: "usage", kind: "cache_warm", timestamp: new Date(s.now() + 240_000).toISOString() });
    s.advance(360_000);
    await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
    expect(s.jev.calls[0]!.questions).not.toHaveProperty("tier");
    expect(s.model()).toBe("anthropic/claude-opus-4-5");
    // Past the refresh's TTL too: cold.
    s.advance(300_000);
    await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
    expect(s.state()).toMatchObject({ model: { why: "cache is cold", action: "switched" } });
  });

  test("no automatic pick goes above your model, whatever the effort bounds", async () => {
    const s = setupModels({ tiers: THREE, model: SONNET, bounds: "ceiling" });
    await s.h.emit("session_start", { type: "session_start" }, s.ctx);
    s.tier.push(HARD);
    await s.h.emit("before_agent_start", { prompt: "hard" }, s.ctx);
    expect(s.model()).toBe("anthropic/claude-sonnet-4-5");
    expect(s.state()).toMatchObject({ model: { tier: "balanced", action: "keep" } });
    expect(s.h.modelChanges).toEqual([]);

    const f = setupModels({ tiers: THREE, model: SONNET });
    await f.h.emit("session_start", { type: "session_start" }, f.ctx);
    f.tier.push(HARD);
    await f.h.emit("before_agent_start", { prompt: "hard" }, f.ctx);
    expect(f.model()).toBe("anthropic/claude-sonnet-4-5");
    expect(f.h.modelChanges).toEqual([]);
  });

  test("model choice is off when Pi was started with --model", () => {
    expect(modelPinnedByArgv(["node", "pi", "--model", "anthropic/claude-sonnet-4-5"])).toBe(true);
    expect(modelPinnedByArgv(["node", "pi", "--model=anthropic/claude-sonnet-4-5"])).toBe(true);
    expect(modelPinnedByArgv(["node", "pi", "--thinking", "high"])).toBe(false);
  });

  test("an unmapped manual model stands in for strong, and the provider is kept", async () => {
    const mine = { provider: "anthropic", id: "claude-custom", name: "Custom" };
    ALL.push(mine);
    try {
      const s = setupModels({
        model: mine,
        tiers: { anthropic: { fast: "anthropic/claude-haiku-4-5", balanced: "openai/gpt-5" }, openai: { fast: "openai/gpt-mini" } },
      });
      await s.h.emit("session_start", { type: "session_start" }, s.ctx);
      await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
      // balanced names another provider: skipped. Your model is the strong tier.
      expect(Object.keys(s.jev.calls[0]!.questions.tier.criteria)).toEqual(["fast", "strong"]);
      expect(s.model()).toBe("anthropic/claude-haiku-4-5");
      await s.answered();
      s.advance(400_000);
      s.tier.push({ fast: 0.1, strong: 0.9 });
      await s.h.emit("before_agent_start", { prompt: "hard" }, s.ctx);
      expect(s.model()).toBe("anthropic/claude-custom");
    } finally {
      ALL.pop();
    }
  });

  test("models off|auto; the retired suggest mode is not a choice; a manual pick becomes your model", async () => {
    const s = setupModels({ tiers: THREE, mode: "off", bounds: "ceiling" });
    await s.h.emit("session_start", { type: "session_start" }, s.ctx);
    await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
    expect(s.jev.calls[0]!.questions).not.toHaveProperty("tier");
    await s.h.commands.get("auto-effort").handler("models suggest", s.ctx);
    expect(s.ctx.ui.notes.at(-1)!.message).toBe("auto-effort models: off. Use /auto-effort models off or auto.");
    expect(s.h.modelChanges).toEqual([]);

    // You switch to Sonnet yourself: it is your model now, and the ceiling for tiers.
    s.ctx.model = SONNET;
    await s.h.emit("model_select", { type: "model_select", model: SONNET, previousModel: OPUS, source: "set" }, s.ctx);
    await s.h.commands.get("auto-effort").handler("models auto", s.ctx);
    expect(s.ctx.ui.notes.at(-1)!.message).toBe("auto-effort models auto for this session");
    s.tier.push(HARD);
    await s.h.emit("before_agent_start", { prompt: "hard" }, s.ctx);
    expect(s.state()).toMatchObject({ manualModel: "anthropic/claude-sonnet-4-5", model: { tier: "balanced", action: "keep" } });
    await s.h.commands.get("auto-effort").handler("status", s.ctx);
    expect(s.ctx.ui.notes.at(-1)!.message).toContain(
      "Models: auto (this session): fast claude-haiku-4-5, balanced claude-sonnet-4-5, strong claude-opus-4-5; your model anthropic/claude-sonnet-4-5.",
    );
  });

  test("a go-ahead keeps the model; /auto-effort off goes back to yours", async () => {
    const s = setupModels({ tiers: THREE });
    await s.h.emit("session_start", { type: "session_start" }, s.ctx);
    await s.h.emit("before_agent_start", { prompt: "trivial" }, s.ctx);
    expect(s.model()).toBe("anthropic/claude-haiku-4-5");
    await s.h.commands.get("auto-effort").handler("off", s.ctx);
    expect(s.model()).toBe("anthropic/claude-opus-4-5");
    expect(s.ctx.ui.status.get("auto-effort")).toBeUndefined();

    const a = setupModels({ tiers: THREE, ack: 0.95 });
    await a.h.emit("session_start", { type: "session_start" }, a.ctx);
    await a.h.emit("before_agent_start", { prompt: "yes" }, a.ctx);
    expect(a.model()).toBe("anthropic/claude-opus-4-5");
  });

  describe("pi-cache-guard's cold-cache dialog", () => {
    async function cold(options: Options = {}) {
      const s = setupModels({ model: OPUS_55, ...options });
      await s.h.emit("session_start", { type: "session_start" }, s.ctx);
      await s.answered();
      s.advance(3_600_000);
      return s;
    }

    test("offers the other tiers' models with Jev's pick recommended, and the prompt reuses the assessment", async () => {
      const s = await cold();
      s.tier.push(ROUTINE);
      const { pushed, offers } = await s.offers("rename tmp to buffer");
      expect(pushed).toBe(1);
      expect(offers).toEqual([[{ model: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", recommended: true, note: "routine work" }]]);
      expect(s.jev.calls).toHaveLength(1);
      expect(Object.keys(s.jev.calls[0]!.questions)).toEqual(["depth", "ack", "tier"]);
      expect(s.jev.calls[0]!.state.request).toBe("rename tmp to buffer");
      // No choice came back (the dialog timed out, say): the prompt still uses the same assessment.
      await s.h.emit("before_agent_start", { prompt: "rename tmp to buffer" }, s.ctx);
      expect(s.jev.calls).toHaveLength(1);
      expect(s.model()).toBe("anthropic/claude-sonnet-5-5");
      expect(s.state()).toMatchObject({ level: "medium", model: { why: "cache is cold", action: "switched" } });
    });

    test("no recommendation when Jev picks the current model; the dialog offers models above yours too", async () => {
      const s = await cold();
      s.tier.push(TOUGH);
      expect((await s.offers("redesign it")).offers).toEqual([[{ model: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" }]]);

      const c = await cold({ model: SONNET_55, bounds: "ceiling" });
      c.tier.push(TOUGH);
      expect((await c.offers("redesign it")).offers).toMatchObject([[{ model: "anthropic/claude-opus-5-5", recommended: true }]]);

      const off = await cold({ mode: "off" });
      expect((await off.offers("redesign it")).pushed).toBe(0);
      expect(off.jev.calls).toHaveLength(0);
    });

    test("a chosen model is applied to the prompt with the same text as an auto pick; your model stays yours", async () => {
      const s = await cold();
      s.tier.push(TOUGH);
      await s.offers("rename tmp to buffer");
      s.h.pi.events.emit("cache:model-choice", { text: "rename tmp to buffer", model: "anthropic/claude-sonnet-5-5" });
      await s.h.emit("before_agent_start", { prompt: "rename tmp to buffer" }, s.ctx);
      expect(s.jev.calls).toHaveLength(1);
      expect(s.model()).toBe("anthropic/claude-sonnet-5-5");
      expect(s.state()).toMatchObject({
        level: "medium",
        manualModel: "anthropic/claude-opus-5-5",
        autoModel: "anthropic/claude-sonnet-5-5",
        model: { to: "anthropic/claude-sonnet-5-5", why: "your choice", action: "chosen" },
      });
      expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → free ≈sonnet-5-5)");
    });

    test("a null choice keeps the current model and skips auto's own choice for that prompt", async () => {
      const s = await cold();
      s.tier.push(ROUTINE);
      await s.offers("rename tmp to buffer");
      s.h.pi.events.emit("cache:model-choice", { text: "rename tmp to buffer", model: null });
      await s.h.emit("before_agent_start", { prompt: "rename tmp to buffer" }, s.ctx);
      expect(s.jev.calls).toHaveLength(1);
      expect(s.h.modelChanges).toEqual([]);
      expect(s.state()).toMatchObject({ level: "medium", model: { to: "anthropic/claude-opus-5-5", why: "your choice", action: "keep" } });
    });

    test("a choice and an assessment for another text are discarded", async () => {
      const s = await cold();
      s.tier.push(TOUGH);
      await s.offers("first draft");
      s.h.pi.events.emit("cache:model-choice", { text: "first draft", model: "anthropic/claude-sonnet-5-5" });
      s.tier.push(TOUGH);
      await s.h.emit("before_agent_start", { prompt: "something else" }, s.ctx);
      expect(s.jev.calls).toHaveLength(2);
      expect(s.h.modelChanges).toEqual([]);
      expect(s.state()).toMatchObject({ model: { tier: "strong", action: "keep" } });
      // Consumed: the next prompt with the old text does not apply it either.
      s.tier.push(TOUGH);
      await s.h.emit("before_agent_start", { prompt: "first draft" }, s.ctx);
      expect(s.jev.calls).toHaveLength(3);
      expect(s.h.modelChanges).toEqual([]);
    });
  });
});
