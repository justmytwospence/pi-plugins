import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import autoEffort, { DEFAULT_CONFIG } from "../src/index.ts";
import { BUILT_IN_PHRASES, DEFAULT_PREFILTER, isGoAhead, prefilterConfig, words } from "../src/prefilter.ts";
import { answers, fakeJev, harness } from "./harness.ts";

describe("isGoAhead", () => {
  test.each(BUILT_IN_PHRASES)("the built-in phrase %j", (phrase) => {
    expect(isGoAhead(phrase)).toBe(true);
    expect(isGoAhead(phrase.toUpperCase())).toBe(true);
  });

  test("trimming, case, trailing punctuation and spacing do not matter", () => {
    for (const prompt of ["  Yes  ", "Go ahead.", "LGTM!", "thanks!!", "ok?", "Thank   you.", "sounds good...", "yes\n", "ok,", "Perfect!\n\n"]) {
      expect(isGoAhead(prompt)).toBe(true);
    }
  });

  test("several phrases together, up to four words", () => {
    expect(isGoAhead("yes, go ahead")).toBe(true);
    expect(isGoAhead("ok thanks")).toBe(true);
    expect(isGoAhead("Looks good, ship it!")).toBe(true);
    expect(isGoAhead("yes do it now")).toBe(false);
    expect(isGoAhead("yes yes yes yes")).toBe(true);
    // Five words, even if every one is a phrase.
    expect(isGoAhead("yes yes yes yes yes")).toBe(false);
    expect(isGoAhead("thank you so much")).toBe(false);
  });

  test("anything beyond the phrases is a real message", () => {
    for (const prompt of [
      "yes but also rename it",
      "go ahead and refactor the sync engine",
      "continue with the migration",
      "do it differently",
      "ok, what about tests?",
      "thanks, now add retries",
      "",
      "   ",
      "!!!",
      "no",
      "yes please",
    ]) {
      expect(isGoAhead(prompt)).toBe(false);
    }
  });

  test("a phrase must match whole words", () => {
    expect(isGoAhead("yesterday")).toBe(false);
    expect(isGoAhead("go ahead-ish")).toBe(false);
    expect(isGoAhead("goahead")).toBe(false);
  });

  test("configured phrases extend the list, normalized the same way", () => {
    const config = { phrases: ["Yes please!", "ship", "Looks right to me"] };
    expect(isGoAhead("yes please", config)).toBe(true);
    expect(isGoAhead("ship", config)).toBe(true);
    expect(isGoAhead("looks right to me", config)).toBe(true);
    expect(isGoAhead("ok, ship", config)).toBe(true);
    expect(isGoAhead("ship the whole thing", config)).toBe(false);
    // The built-ins stay; a phrase longer than four words can never match.
    expect(isGoAhead("lgtm", config)).toBe(true);
    expect(isGoAhead("one two three four five", { phrases: ["one two three four five"] })).toBe(false);
    expect(isGoAhead("yes please")).toBe(false);
  });

  test("words", () => {
    expect(words("  Yes, GO ahead!! ")).toEqual(["yes", "go", "ahead"]);
    expect(words("don’t")).toEqual(["don't"]);
    expect(words("...")).toEqual([]);
  });
});

test("prefilterConfig keeps the defaults for invalid values", () => {
  expect(prefilterConfig(undefined)).toEqual(DEFAULT_PREFILTER);
  expect(prefilterConfig({ enabled: "no", phrases: "yes" })).toEqual(DEFAULT_PREFILTER);
  expect(prefilterConfig({ enabled: false, phrases: ["a", 3, "b"] })).toEqual({ enabled: false, phrases: ["a", "b"] });
  expect(DEFAULT_CONFIG.prefilter).toEqual({ enabled: true, phrases: [] });
});

describe("before a prompt", () => {
  function project(settings: Record<string, unknown>) {
    const cwd = mkdtempSync(path.join(tmpdir(), "auto-effort-prefilter-"));
    mkdirSync(path.join(cwd, ".pi"));
    writeFileSync(path.join(cwd, ".pi", "auto-effort.json"), JSON.stringify(settings));
    return cwd;
  }

  function setup(settings: Record<string, unknown> = {}, depth: number = 3) {
    const h = harness();
    autoEffort(h.pi);
    const jev = fakeJev(() => answers(depth));
    const ctx = h.ctx({ cwd: project(settings), modelRegistry: jev.registry, sessionManager: { getBranch: () => [] } });
    return { h, jev, ctx, state: () => h.entries.filter((e) => e.customType === "auto-effort:state").at(-1)?.data as Record<string, any> };
  }

  test("a go-ahead keeps the level with no Jev call and records reason go-ahead", async () => {
    const { h, jev, ctx, state } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    h.pi.setThinkingLevel("medium");
    h.thinkingChanges.length = 0;
    await h.emit("before_agent_start", { prompt: "Yes, go ahead!" }, ctx);
    expect(jev.calls).toHaveLength(0);
    expect(h.thinkingChanges).toEqual([]);
    expect(h.thinking).toBe("medium");
    expect(state()).toMatchObject({ phase: "prompt", reason: "go-ahead", from: "medium", level: "medium", theta: 0.5, p: 0, bounds: "free" });
    expect(state()).not.toHaveProperty("need");
    expect(state()).not.toHaveProperty("latencyMs");
    expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → free)");
    // The next real request is assessed as usual.
    await h.emit("before_agent_start", { prompt: "redesign the sync engine" }, ctx);
    expect(jev.calls).toHaveLength(1);
    expect(h.thinking).toBe("xhigh");
  });

  test("it announces the pressure like any other decision", async () => {
    const { h, jev, ctx } = setup();
    ctx.model = { provider: "anthropic", id: "claude-opus-4-5" };
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.emit("before_agent_start", { prompt: "thanks" }, ctx);
    expect(jev.calls).toHaveLength(0);
    expect(h.events.filter((e) => e.channel === "quota:pressure")).toEqual([{ channel: "quota:pressure", data: { provider: "anthropic", tier: "none", p: 0 } }]);
  });

  test("a message with more than a go-ahead is assessed", async () => {
    const { h, jev, ctx, state } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.emit("before_agent_start", { prompt: "go ahead and rewrite the scheduler" }, ctx);
    expect(jev.calls).toHaveLength(1);
    expect(state()).toMatchObject({ reason: "up" });
  });

  test("prefilter.enabled false sends every prompt to Jev", async () => {
    const { h, jev, ctx, state } = setup({ prefilter: { enabled: false } }, 0);
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.emit("before_agent_start", { prompt: "yes" }, ctx);
    expect(jev.calls).toHaveLength(1);
    // Jev rated it trivial and not a go-ahead (the fake says ack 0.05): the level moves.
    expect(state()).toMatchObject({ reason: "down", level: "low" });
  });

  test("prefilter.phrases extends the list", async () => {
    const { h, jev, ctx, state } = setup({ prefilter: { phrases: ["Ship it, please"] } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.emit("before_agent_start", { prompt: "ship it please" }, ctx);
    expect(jev.calls).toHaveLength(0);
    expect(state()).toMatchObject({ reason: "go-ahead" });
  });

  test("it holds when auto-effort is off for the session, and Jev is not asked", async () => {
    const { h, jev, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.commands.get("auto-effort").handler("off", ctx);
    await h.emit("before_agent_start", { prompt: "yes" }, ctx);
    expect(jev.calls).toHaveLength(0);
    expect(h.entries).toEqual([]);
  });

  test("the pre-filter result shows in /auto-effort status as the last decision", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", { type: "session_start" }, ctx);
    await h.emit("before_agent_start", { prompt: "lgtm" }, ctx);
    await h.commands.get("auto-effort").handler("status", ctx);
    expect(ctx.ui.notes.at(-1)!.message).toContain("last decision: go-ahead");
  });
});
