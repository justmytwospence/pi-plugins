import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { queryFooterActions } from "../src/footer-actions.ts";
import autoEffort from "../src/index.ts";
import * as jevModule from "../src/jev.ts";
import { SYSTEM1_CHANGED, resolveSystem1Target } from "../src/system1.js";
import { answers, harness } from "./harness.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "auto-effort-system1-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function setting(backend: string) {
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "system1.json"), JSON.stringify({ backend }));
}

const BORDERLINE = [0.15, 0.4, 0.35, 0.1];
const JEV_KEY = JSON.stringify(["jev", "typesafe", "jev-latest"]);
const DECISIONS_KEY = JSON.stringify(["openai-decisions", "system1-openai", "gpt-6-luna"]);
type Model = { provider: string; id: string; api: string; baseUrl: string };
type Context = { state: Record<string, unknown>; questions: Record<string, unknown> };
type Options = { signal?: AbortSignal };

function setup(depths: Array<number | number[]> = [1, BORDERLINE], settings: Record<string, unknown> = { policy: { bounds: "ceiling" } }) {
  const cwd = path.join(root, "project");
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const settingsPath = path.join(cwd, ".pi", "auto-effort.json");
  writeFileSync(settingsPath, JSON.stringify(settings));
  const queue = [...depths];
  const classify = vi.fn(async (model: Model, _context: Context, _options: Options): Promise<any> => ({
    model: model.id, stopReason: "stop", answers: answers(queue.shift() ?? 1),
  }));
  const findOfType = vi.fn((_type: string, provider: string, id: string): Model => ({
    provider, id, api: provider === "system1-openai" ? "openai-decisions" : "typesafe",
    baseUrl: "https://api.openai.com/v1",
  }));
  const h = harness();
  autoEffort(h.pi);
  const ctx = h.ctx({
    cwd,
    model: { provider: "anthropic", id: "managed", compat: { supportsMidConvoEffort: true } },
    modelRegistry: { findOfType, classify },
  });
  const prompt = (text = "routine work") => h.emit("before_agent_start", { prompt: text }, ctx);
  const turn = () => h.emit("turn_end", { turnIndex: 0, message: { stopReason: "toolUse" }, toolResults: [{ isError: true }] }, ctx);
  const status = async () => {
    await h.commands.get("auto-effort").handler("status", ctx);
    return ctx.ui.notes.at(-1)!.message;
  };
  const seedTrend = async () => {
    await h.emit("session_start", {}, ctx);
    await prompt();
    await prompt("a bit harder");
    expect(ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto ↑ ≤high)");
  };
  return { h, ctx, classify, findOfType, prompt, turn, status, seedTrend, settingsPath };
}

test("effective target keys preserve a current judgment across unchanged backend notifications", async () => {
  const s = setup();
  await s.seedTrend();
  const before = await s.status();
  // The setting's key is backend-only; it is not the cache's physical-target key.
  setting("jev");
  for (let i = 0; i < 3; i++) {
    s.h.pi.events.emit(SYSTEM1_CHANGED, {});
    expect(await s.status()).toBe(before);
    expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto ↑ ≤high)");
  }
  expect(s.classify).toHaveBeenCalledTimes(2);
  expect(s.h.entries.at(-1)?.data).toMatchObject({ selectionKey: JEV_KEY });
});

test("backend notifications still cancel pending judgments after the same factory restarts", async () => {
  const s = setup();
  await s.seedTrend();
  await s.h.emit("session_shutdown", {}, s.ctx);
  await s.h.emit("session_start", {}, s.ctx);
  let finish!: (value: any) => void;
  s.classify.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
  const pending = s.prompt("work after restart");
  await Promise.resolve();
  expect(s.classify).toHaveBeenCalledTimes(3);
  const signal = s.classify.mock.calls.at(-1)![2].signal!;
  expect(signal.aborted).toBe(false);
  setting("openai-decisions");
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  expect(signal.aborted).toBe(true);
  finish({ model: "jev-latest", stopReason: "stop", answers: answers(3) });
  await pending;
  expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → ≤medium)");
  expect(s.h.entries).toHaveLength(2);
});

test("backend events clear judgments and trends, not effort, manual ceiling, counts or policy", async () => {
  const s = setup([0, 3], { policy: { bounds: "ceiling", max: "high", threshold: { relaxed: 0.65, tight: 0.95 } } });
  await s.h.emit("session_start", {}, s.ctx);
  await s.h.commands.get("auto-effort").handler("bounds free", s.ctx);
  await s.prompt("trivial work");
  expect(s.h.thinking).toBe("low");
  const previous = await s.status();
  const entries = [...s.h.entries];
  setting("openai-decisions");
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  expect(s.h.thinking).toBe("low");
  expect(s.h.entries).toEqual(entries);
  expect(s.classify).toHaveBeenCalledTimes(1);
  expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: low (auto → free)");
  const current = await s.status();
  expect(current).toContain("Bounds free (this session): low to high; your last manual level, high, is not a cap.");
  expect(current).toContain("Assessment: none yet, θ=0.65.");
  expect(current).not.toContain("last decision:");
  expect(current.split("\n")[3]).toBe(previous.split("\n")[3]);
  await s.prompt("hard work");
  expect(s.h.thinking).toBe("high");
  expect(s.h.entries.at(-1)?.data).toMatchObject({ ceiling: "high", bounds: "free", theta: 0.65, selectionKey: DECISIONS_KEY });
  expect(await s.status()).toContain("Assessment: need(");
  expect(await s.status()).not.toMatch(/Jev|typesafe/u);
  await s.h.commands.get("auto-effort").handler("off", s.ctx);
  expect(s.h.thinking).toBe("high");
});

test.each([
  "input", "status", "limits", "bounds", "on", "footer", "go-ahead", "empty turn", "model_select",
  "agent_settled", "thinking_level_select", "before_provider_request", "after_provider_response",
])("%s detects a backend change without a watcher and removes the old trend", async (interaction) => {
  const s = setup();
  await s.seedTrend();
  const action = queryFooterActions(s.h.pi.events)["effort.toggle"]!;
  setting("openai-decisions");
  if (interaction === "footer") await action.run();
  else if (interaction === "go-ahead") await s.prompt("go ahead");
  else if (interaction === "empty turn") await s.h.emit("turn_end", {}, s.ctx);
  else if (["status", "limits", "on", "bounds"].includes(interaction)) {
    await s.h.commands.get("auto-effort").handler(interaction === "bounds" ? "bounds ceiling" : interaction, s.ctx);
  } else if (interaction === "thinking_level_select") s.h.pi.setThinkingLevel("medium");
  else await s.h.emit(interaction, {}, s.ctx);
  // Check before the status command itself gets a chance to refresh the target.
  const ceiling = interaction === "thinking_level_select" ? "medium" : "high";
  expect(s.ctx.ui.status.get("auto-effort")).toBe(`effort: medium (auto → ≤${ceiling})`);
  expect(s.classify).toHaveBeenCalledTimes(2);
  expect(await s.status()).toContain("Assessment: none yet, θ=0.50");
  expect(await s.status()).not.toContain("need(");
});

describe.each(["prompt", "run"])("pending %s judgment", (phase) => {
  test.each(["event", "event and switch back", "interaction", "completion"])("cancels/discards after a backend change via %s", async (change) => {
    const s = setup();
    await s.h.emit("session_start", {}, s.ctx);
    let finish!: (result: unknown) => void;
    s.classify.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = phase === "prompt" ? s.prompt() : s.turn();
    expect(s.classify).toHaveBeenCalledTimes(1);
    const signal = s.classify.mock.calls[0]![2].signal!;
    setting("openai-decisions");
    if (change.startsWith("event")) {
      s.h.pi.events.emit(SYSTEM1_CHANGED, {});
      expect(signal.aborted).toBe(true);
      if (change === "event and switch back") {
        setting("jev");
        s.h.pi.events.emit(SYSTEM1_CHANGED, {});
      }
    } else if (change === "interaction") {
      await s.h.commands.get("auto-effort").handler("status", s.ctx);
      expect(signal.aborted).toBe(true);
    }
    if (change !== "completion") await pending; // Cancellation must not wait for an uncooperative host.
    finish({ model: "jev-latest", stopReason: "stop", answers: answers(0) });
    await pending;
    expect(s.h.entries).toEqual([]);
    expect(s.h.thinkingChanges).toEqual([]);
    expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: high (auto → ≤high)");
    expect(await s.status()).not.toContain("last decision:");
  });

  test("guards successful delayed adapter output separately from the transport", async () => {
    const s = setup();
    await s.h.emit("session_start", {}, s.ctx);
    let finish!: (outcome: jevModule.JevOutcome) => void;
    vi.spyOn(jevModule, "askJev").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = phase === "prompt" ? s.prompt() : s.turn();
    setting("openai-decisions");
    finish({ ok: true, answers: answers(0) as any, backend: "jev", provider: "typesafe", model: "jev-latest", selectionKey: JEV_KEY, latencyMs: 1 });
    await pending;
    expect(s.h.entries).toEqual([]);
    expect(s.h.thinkingChanges).toEqual([]);
  });

  test("rechecks after the async assessment returns, immediately before applying effort", async () => {
    const s = setup();
    await s.h.emit("session_start", {}, s.ctx);
    vi.spyOn(jevModule, "askJev").mockResolvedValueOnce({
      ok: true, answers: answers(0) as any, backend: "jev", provider: "typesafe", model: "jev-latest", selectionKey: JEV_KEY, latencyMs: 1,
    });
    const pending = phase === "prompt" ? s.prompt() : s.turn();
    // The adapter continuation runs first; the setting changes before the outer handler resumes.
    queueMicrotask(() => setting("openai-decisions"));
    await pending;
    expect(s.h.entries).toEqual([]);
    expect(s.h.thinkingChanges).toEqual([]);
  });

  test("rejects adapter success with another target's selection key", async () => {
    const s = setup();
    await s.h.emit("session_start", {}, s.ctx);
    vi.spyOn(jevModule, "askJev").mockResolvedValueOnce({
      ok: true, answers: answers(0) as any, backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna", selectionKey: DECISIONS_KEY, latencyMs: 1,
    });
    await (phase === "prompt" ? s.prompt() : s.turn());
    expect(s.h.entries).toEqual([]);
    expect(s.h.thinkingChanges).toEqual([]);
  });

  test("uses the native target instead of dormant Jev overrides", async () => {
    setting("openai-decisions");
    const s = setup([0], { jev: { provider: "legacy-provider", model: "legacy-model" } });
    await s.h.emit("session_start", {}, s.ctx);
    await (phase === "prompt" ? s.prompt() : s.turn());
    expect(s.findOfType).toHaveBeenCalledExactlyOnceWith("classifier", "system1-openai", "gpt-6-luna");
    expect(s.classify.mock.calls[0]![0]).toMatchObject({ provider: "system1-openai", id: "gpt-6-luna", api: "openai-decisions", baseUrl: "https://api.openai.com/v1" });
    expect(Object.keys(s.classify.mock.calls[0]![1].questions)).toEqual(phase === "prompt" ? ["depth", "ack"] : ["depth"]);
    expect(s.h.thinking).toBe("low");
    expect(s.h.entries.at(-1)?.data).toMatchObject({ selectionKey: DECISIONS_KEY, phase });
    expect(await s.status()).toContain("Assessment: need(");
  });
});

test("a change to the configured Jev target clears metadata when the next prompt reloads settings", async () => {
  const s = setup();
  await s.seedTrend();
  writeFileSync(s.settingsPath, JSON.stringify({ policy: { bounds: "ceiling" }, jev: { provider: "custom", model: "another-jev" } }));
  await s.prompt("go ahead");
  expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → ≤high)");
  expect(await s.status()).not.toContain("need(");
  expect(s.classify).toHaveBeenCalledTimes(2);
  await s.prompt("routine work");
  expect(s.findOfType).toHaveBeenLastCalledWith("classifier", "custom", "another-jev");
  expect(s.h.entries.at(-1)?.data).toMatchObject({ selectionKey: JSON.stringify(["jev", "custom", "another-jev"]) });
});

test("dormant Jev overrides cannot invalidate a Decisions judgment", async () => {
  setting("openai-decisions");
  const s = setup();
  await s.seedTrend();
  writeFileSync(s.settingsPath, JSON.stringify({ policy: { bounds: "ceiling" }, jev: { provider: "dormant", model: "unused" } }));
  await s.prompt("go ahead");
  expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto ↑ ≤high)");
  expect(await s.status()).toContain("need(high)=0.45");
  expect(s.h.entries.at(-1)?.data).toMatchObject({ selectionKey: DECISIONS_KEY });
  expect(s.classify).toHaveBeenCalledTimes(2);
});

test("invalid global settings invalidate old judgments without calling either backend", async () => {
  const s = setup();
  await s.seedTrend();
  setting("unknown-backend");
  await s.prompt("routine work");
  expect(s.classify).toHaveBeenCalledTimes(2);
  expect(s.h.thinking).toBe("medium");
  expect(s.ctx.ui.status.get("auto-effort")).toBe("effort: medium (auto → ≤high)");
  expect(await s.status()).toContain("Assessment: none yet");
  expect(await s.status()).not.toContain("need(");
  expect(s.h.entries.at(-1)?.data).toMatchObject({ reason: "assessment unavailable: System 1 configuration has an unsupported backend" });
});

test("backend switching respects a disabled local classifier and the session off gate", async () => {
  setting("openai-decisions");
  const s = setup([], { jev: { enabled: false }, policy: { bounds: "ceiling" } });
  await s.h.emit("session_start", {}, s.ctx);
  await s.prompt();
  expect(s.findOfType).not.toHaveBeenCalled();
  expect(s.classify).not.toHaveBeenCalled();
  expect(s.h.entries.at(-1)?.data).toMatchObject({ reason: "assessment unavailable: the classifier is off in settings" });
  await s.h.commands.get("auto-effort").handler("off", s.ctx);
  setting("jev");
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  await s.prompt();
  expect(s.h.entries).toHaveLength(1);
  expect(s.ctx.ui.status.get("auto-effort")).toBeUndefined();
  expect(queryFooterActions(s.h.pi.events)["effort.toggle"]?.active).toBe(false);
});

test.each(["session_start", "session_tree"])("%s restores only matching backend metadata, preserving the saved manual ceiling", async (event) => {
  const s = setup();
  await s.h.emit("session_start", {}, s.ctx);
  s.ctx.sessionManager.getBranch = () => [{
    type: "custom", customType: "auto-effort:state",
    data: { ceiling: "xhigh", level: "medium", reason: "hold", theta: 0.6, need: { low: 1, medium: 0.9, high: 0.55, xhigh: 0.1 }, selectionKey: JEV_KEY },
  }];
  setting("openai-decisions");
  await s.h.emit(event, {}, s.ctx);
  expect(await s.status()).toContain("Bounds ceiling (settings): low to xhigh, your last manual level.");
  expect(await s.status()).toContain("Assessment: none yet, θ=0.50.");
  expect(await s.status()).not.toContain("last decision:");
  setting("jev");
  await s.h.emit(event, {}, s.ctx);
  expect(await s.status()).toContain("need(high)=0.55");
  expect(await s.status()).toContain("θ=0.60 → medium, last decision: hold");
});

test("legacy Jev entries do not become native Decisions judgments after reload", async () => {
  setting("openai-decisions");
  const s = setup();
  s.ctx.sessionManager.getBranch = () => [{
    type: "custom", customType: "auto-effort:state",
    data: { ceiling: "xhigh", level: "low", reason: "down", theta: 0.7, need: { low: 1, medium: 0.1 } },
  }];
  await s.h.emit("session_start", {}, s.ctx);
  expect(await s.status()).toContain("low to xhigh, your last manual level");
  expect(await s.status()).toContain("Assessment: none yet, θ=0.50.");
});

test("native judgments can be restored on the same target", async () => {
  setting("openai-decisions");
  const s = setup([0]);
  await s.h.emit("session_start", {}, s.ctx);
  await s.prompt();
  const data = s.h.entries.at(-1)!.data;
  s.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "auto-effort:state", data }];
  await s.h.emit("session_tree", {}, s.ctx);
  expect(await s.status()).toContain("need(medium)=0.15");
  expect(resolveSystem1Target({ provider: "ignored", model: "ignored" })).toMatchObject({ ok: true, key: DECISIONS_KEY });
});

test("a footer action captured before a change event cannot toggle the session", async () => {
  const s = setup();
  await s.h.emit("session_start", {}, s.ctx);
  const old = queryFooterActions(s.h.pi.events)["effort.toggle"]!;
  setting("openai-decisions");
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  await old.run();
  expect(s.ctx.ui.notes).toEqual([]);
  expect(queryFooterActions(s.h.pi.events)["effort.toggle"]?.active).toBe(true);
  await queryFooterActions(s.h.pi.events)["effort.toggle"]!.run();
  expect(queryFooterActions(s.h.pi.events)["effort.toggle"]?.active).toBe(false);
});
