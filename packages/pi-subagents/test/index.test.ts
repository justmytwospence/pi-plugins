import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, expect, test, vi } from "vitest";
import subagents, { DEFAULT_CONFIG, jevMark, promptGuidelines, truncateOutput } from "../src/index.ts";
import { fakeJev, harness } from "./harness.ts";
const pressureReader = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ state: "unavailable", tier: "none", p: 0 })));
vi.mock("@justmytwospence/pi-subscription-usage", async (importOriginal) => ({
  ...await importOriginal<object>(),
  readSelectionPressure: pressureReader,
}));
import { fakeUI, normalFocus, plain } from "./ui-helpers.ts";
import { readTranscriptCheckpoint } from "../src/transcript-contract.ts";

beforeAll(() => initTheme("dark"));

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "subagents-agent-"));

test("truncateOutput keeps the start and points at the full output", () => {
  expect(truncateOutput("short", "/f")).toBe("short");
  const long = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join("\n");
  const out = truncateOutput(long, "/full.md");
  expect(out.split("\n").length).toBeLessThan(2_010);
  expect(out).toMatch(/Full output: \/full\.md\]$/u);
});

test("the UI binds in the TUI only; /subagents lists recorded runs and opens one", async () => {
  const h = harness();
  subagents(h.pi);
  const rpc = fakeUI();
  await h.emit("session_start", { type: "session_start" }, h.ctx({ ui: rpc, mode: "rpc" }));
  expect(rpc.inputHandlers.size).toBe(0);

  const ui = fakeUI();
  const entries: unknown[] = [];
  const ctx = h.ctx({ ui, sessionManager: { getBranch: () => entries, getSessionId: () => "s" } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(ui.inputHandlers.size).toBe(1);
  const command = h.commands.get("subagents");
  await command.handler("", ctx);
  expect(ui.notes).toEqual(["No subagent runs in this session."]);

  const record = { id: "abc123", agent: "scout", task: "look around", model: "m/x", thinking: "low", byJev: { agent: true, model: false, thinking: false }, status: "done", turns: 1, tokens: 10, cost: 0, seconds: 4, outputPath: "/nonexistent/abc123/output.md", async: true };
  entries.push({ type: "custom", customType: "subagents:run", data: { ...record, status: "running" } }, { type: "custom", customType: "subagents:run", data: record });
  ui.selectAnswers.push((options) => options[0]);
  const done = command.handler("", ctx);
  await new Promise((r) => setTimeout(r, 0));
  expect(ui.selects[0]?.options).toEqual(["1. abc123  done    look around · scout · m/x · low"]);
  expect(ui.customs).toHaveLength(1);
  ui.customs[0]?.component.handleInput("\x1b");
  await done;
  expect(ui.selects).toHaveLength(2);

  await command.handler("zzz", ctx);
  expect(ui.notes.at(-1)).toMatch(/No single run matches "zzz"/u);
  void command.handler("abc", ctx);
  await new Promise((r) => setTimeout(r, 0));
  expect(ui.customs).toHaveLength(1);
  ui.customs[0]?.component.handleInput("q");

  await command.handler("stop", ctx);
  expect(ui.notes.at(-1)).toBe("No subagents are running.");

  await command.handler("stats", ctx);
  expect(ui.notes.at(-1)).toMatch(/1 runs, \$0\.0000 total, in this session[\s\S]*unknown\s+1\s+100%[\s\S]*scout\s+1/u);

  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  expect(ui.inputHandlers.size).toBe(0);
});

test("at the deepest allowed level a subagent gets no subagent tool", () => {
  const registered = (depth: string | undefined) => {
    const h = harness();
    const tools: string[] = [];
    h.pi.registerTool = (tool: { name: string }) => void tools.push(tool.name);
    if (depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = depth;
    try {
      subagents(h.pi);
    } finally {
      delete process.env.PI_SUBAGENT_DEPTH;
    }
    return tools;
  };
  expect(registered(undefined)).toEqual(["subagent"]);
  expect(registered("1")).toEqual(["subagent"]);
  expect(registered("2")).toEqual([]);
});

test("b in FleetView moves a foreground call to the background; its result arrives as a message", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ui = fakeUI();
    const cwd = mkdtempSync(path.join(tmpdir(), "subagents-cwd-"));
    const ctx = h.ctx({ ui, cwd, model: { provider: "p", id: "m" } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    normalFocus(ui);
    const call = tool.execute("t1", { task: "loop forever" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 100));
    // Foreground waits now open their conversation. Esc returns to main and suppresses reopening.
    expect(ui.customs).toHaveLength(1);
    ui.customs[0]!.component.handleInput("\x1b");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ui.press("\x1b[B")).toBe(true);
    expect(ui.render("subagents-fleet")[0]).toContain("b background");
    expect(ui.widgets.has("subagents")).toBe(false);
    expect(ui.press("b")).toBe(true);
    const result = await call;
    expect(readTranscriptCheckpoint(result.details)).toBeUndefined();
    expect(result.content[0].text).toMatch(/^The user moved this single to the background: \w+ \(loop forever · general, p\/m \(parent\), medium\): parent fallback: no usable role or tier mapping for p/u);
    // Now a background run: still listed below the prompt (no widget above it by default), and b is no longer offered.
    expect(ui.widgets.has("subagents")).toBe(false);
    expect(ui.render("subagents-fleet")[0]).not.toContain("b background");
    expect(h.messages).toHaveLength(0);
    await h.commands.get("subagents").handler("stop all", ctx);
    await new Promise((r) => setTimeout(r, 200));
    expect(readTranscriptCheckpoint(h.messages[0]?.message.details)).toEqual({ id: expect.any(String), kind: "report" });
    expect(h.messages[0]?.message.content).toMatch(/^Subagent "loop forever" stopped after \d+s:\n\n\[loop forever · general · p\/m \(parent\) · medium · stopped\][\s\S]*parent fallback: no usable role or tier mapping for p/u);
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally {
    setPiInvocation(undefined);
  }
});

test.each([["fast", "luna"], ["balanced", "terra"], ["strong", "sol"], ["premium", "astra"]])("a Sol parent routes Jev's %s tier within OpenAI (%s) despite legacy Anthropic defaults", async (tier, name) => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const cwd = mkdtempSync(path.join(tmpdir(), "subagents-routing-"));
    mkdirSync(path.join(cwd, ".pi"));
    writeFileSync(path.join(cwd, ".pi", "pi-subagents.json"), JSON.stringify({
      tiers: { fast: "anthropic/claude-haiku-5", balanced: "anthropic/claude-fable-5-1", strong: "anthropic/claude-opus-5-5", premium: "anthropic/claude-fable-5-1" },
    }));
    const jev = fakeJev(() => ({
      role: { type: "choice", choice: "general", confidence: 1, probabilities: { general: 1 } },
      tier: { type: "choice", choice: tier, confidence: 1, probabilities: {} },
      effort: { type: "choice", choice: "medium", confidence: 1, probabilities: { medium: 1 } },
    }));
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ctx = h.ctx({ cwd, ui: fakeUI(), model: { provider: "openai-codex", id: "gpt-6.1-sol" },
      modelRegistry: { ...jev.registry as object, getAll: () => [
        { provider: "openai-codex", id: "gpt-6.1-sol" }, { provider: "openai-codex", id: "gpt-6.1-luna" }, { provider: "openai-codex", id: "gpt-6.1-terra" }, { provider: "openai-codex", id: "gpt-6.1-astra" },
      ] },
    });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const result = await tool.execute("t1", { task: "route me", async: true }, undefined, undefined, ctx);
    expect(Object.keys(jev.calls[0]?.questions.tier.criteria ?? {})).toEqual(["fast", "balanced", "strong", "premium"]);
    expect(result.content[0].text).toContain(`openai-codex/gpt-6.1-${name}`);
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally {
    setPiInvocation(undefined);
  }
});

test.each([["fast", "claude-haiku-5"], ["balanced", "claude-sonnet-5-5"], ["strong", "claude-opus-5-5"]])("an unconfigured Opus parent routes Jev's %s tier to the newest registered %s", async (tier, id) => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const jev = fakeJev(() => ({
      role: { type: "choice", choice: "general", confidence: 1, probabilities: { general: 1 } },
      tier: { type: "choice", choice: tier, confidence: 1, probabilities: {} },
      effort: { type: "choice", choice: "medium", confidence: 1, probabilities: { medium: 1 } },
    }));
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ctx = h.ctx({ cwd: mkdtempSync(path.join(tmpdir(), "subagents-presets-")), ui: fakeUI(), model: { provider: "anthropic", id: "claude-opus-5-5" },
      modelRegistry: { ...jev.registry as object, getAll: () => [
        "claude-haiku-4-5", "claude-haiku-5", "claude-sonnet-5-5-20260301", "claude-sonnet-5-5", "claude-opus-4-1", "claude-opus-5-5",
      ].map((model) => ({ provider: "anthropic", id: model })) },
    });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const result = await tool.execute("t1", { task: "route me", async: true }, undefined, undefined, ctx);
    expect(jev.calls[0]?.questions).toHaveProperty("tier");
    expect(result.details.runs[0]).toMatchObject({ model: `anthropic/${id}`, byJev: { model: true } });
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally {
    setPiInvocation(undefined);
  }
});

test("one registered tier selects deterministically without a tier question or model classifier provenance", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const jev = fakeJev(() => ({ effort: { type: "choice", choice: "high", confidence: 1, probabilities: { high: 1 } } }));
    const h = harness();
    let tool: any;
    h.pi.registerTool = (value: unknown) => void (tool = value);
    subagents(h.pi);
    const ctx = h.ctx({ ui: fakeUI(), cwd: mkdtempSync(path.join(tmpdir(), "subagents-one-candidate-")), model: { provider: "openai", id: "gpt-6-astra" },
      modelRegistry: { ...jev.registry as object, getAll: () => [{ provider: "openai", id: "gpt-6-luna" }] } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const run = await tool.execute("t", { task: "simple", agent: "general", async: true }, undefined, undefined, ctx);
    expect(jev.calls).toHaveLength(1);
    expect(Object.keys(jev.calls[0]!.questions)).toEqual(["effort"]);
    expect(run.details.runs[0]).toMatchObject({ model: "openai/gpt-6-luna", thinking: "high", source: { model: "tier", thinking: "jev" }, byJev: { model: false, thinking: true } });
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally { setPiInvocation(undefined); }
});

test("custom model fixed plus classified effort, explicit effort plus classified model, and fully fixed calls", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const cwd = mkdtempSync(path.join(tmpdir(), "subagents-fixed-dimensions-"));
    mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi", "agents", "fixed.md"), "---\nname: fixed\ndescription: fixed\nmodel: openai/gpt-6.1-terra\n---\nA custom agent");
    const jev = fakeJev(() => ({ tier: { type: "choice", choice: "premium", confidence: 1, probabilities: { premium: 1 } }, effort: { type: "choice", choice: "high", confidence: 1, probabilities: { high: 1 } } }));
    const h = harness();
    let tool: any;
    h.pi.registerTool = (value: unknown) => void (tool = value);
    subagents(h.pi);
    const ctx = h.ctx({ cwd, ui: fakeUI(), model: { provider: "openai", id: "gpt-6-astra" }, modelRegistry: { ...jev.registry as object,
      getAll: () => ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"].map((id) => ({ provider: "openai", id })) } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const custom = await tool.execute("t1", { task: "fixed model", agent: "fixed", async: true }, undefined, undefined, ctx);
    expect(Object.keys(jev.calls[0]!.questions)).toEqual(["effort"]);
    expect(custom.details.runs[0]).toMatchObject({ model: "openai/gpt-6.1-terra", thinking: "high", source: { model: "profile", thinking: "jev" } });
    const effort = await tool.execute("t2", { task: "fixed effort", agent: "worker", thinking: "low", async: true }, undefined, undefined, ctx);
    expect(Object.keys(jev.calls[1]!.questions)).toEqual(["tier"]);
    expect(effort.details.runs[0]).toMatchObject({ model: "openai/gpt-6-astra", thinking: "low", source: { model: "tier", thinking: "explicit" } });
    const count = jev.calls.length;
    const both = await tool.execute("t3", { task: "both fixed", agent: "fixed", thinking: "medium", async: true }, undefined, undefined, ctx);
    expect(jev.calls).toHaveLength(count);
    expect(both.details.runs[0]).toMatchObject({ model: "openai/gpt-6.1-terra", thinking: "medium", source: { model: "profile", thinking: "explicit" } });
    const explicit = await tool.execute("t4", { task: "both explicit", agent: "worker", model: "openai/gpt-6-luna", thinking: "low", async: true }, undefined, undefined, ctx);
    expect(jev.calls).toHaveLength(count);
    expect(explicit.details.runs[0]).toMatchObject({ model: "openai/gpt-6-luna", thinking: "low", source: { model: "explicit", thinking: "explicit" } });
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally { setPiInvocation(undefined); }
});

test("a duplicate classifier ID cannot supply thinking metadata for the physical chat choice", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const jev = fakeJev(() => ({ tier: { type: "choice", choice: "fast", confidence: 1, probabilities: { fast: 1 } }, effort: { type: "choice", choice: "high", confidence: 1, probabilities: { high: 1 } } }));
    const h = harness();
    let tool: any;
    h.pi.registerTool = (value: unknown) => void (tool = value);
    subagents(h.pi);
    const ctx = h.ctx({ ui: fakeUI(), cwd: mkdtempSync(path.join(tmpdir(), "subagents-duplicate-chat-")), model: { provider: "openai", id: "gpt-6-astra" }, modelRegistry: { ...jev.registry as object,
      getAll: () => [
        { provider: "openai", id: "gpt-6-luna", type: "classifier", reasoning: false },
        { provider: "openai", id: "gpt-6-luna", type: "chat", reasoning: true },
        { provider: "openai", id: "gpt-6.1-terra", type: "chat", reasoning: true },
      ] } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const result = await tool.execute("t", { task: "look up a symbol", agent: "worker", async: true }, undefined, undefined, ctx);
    expect(result.details.runs[0]).toMatchObject({ model: "openai/gpt-6-luna", thinking: "high", source: { model: "tier", thinking: "jev" } });
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally { setPiInvocation(undefined); }
});

test("a foreground call returns the child's answer and usage, and offers no detach after", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi.mjs")] });
  try {
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ui = fakeUI();
    const ctx = h.ctx({ ui, cwd: mkdtempSync(path.join(tmpdir(), "subagents-cwd-")), model: { provider: "p", id: "m" } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const result = await tool.execute("t1", { task: "count" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("failed: Headless worker requires user interaction");
    expect(result.content[0].text).toContain("task=count answer=cancelled");
    expect(result.usage.cost.total).toBeCloseTo(0.03);
    expect(ui.selects).toEqual([]);
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally {
    setPiInvocation(undefined);
  }
});

test("a run that ends after its session is gone calls no pi API (a stale runtime throws, which would take pi down)", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ctx = h.ctx({ ui: fakeUI(), cwd: mkdtempSync(path.join(tmpdir(), "subagents-cwd-")), model: { provider: "p", id: "m" } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    await tool.execute("t1", { task: "loop forever", async: true }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 100));
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    // pi marks the runtime stale: every call throws from now on.
    const stale = () => {
      throw new Error("This extension ctx is stale");
    };
    h.pi.appendEntry = stale as never;
    h.pi.sendMessage = stale as never;
    h.pi.events.emit = stale as never;
    // The stopped child ends now; nothing may throw (an unhandled rejection fails this test).
    await new Promise((r) => setTimeout(r, 300));
    expect(h.messages).toHaveLength(0);
  } finally {
    setPiInvocation(undefined);
  }
});

test("delegation picks the first prompt guideline (economical by default); a project's setting re-registers the tool at session start", async () => {
  expect(DEFAULT_CONFIG.delegation).toBe("economical");
  expect(DEFAULT_CONFIG.jev.threshold).toEqual({ relaxed: 0.5, tight: 0.85 });
  const economical = promptGuidelines("economical");
  expect(promptGuidelines(undefined)[0]).toBe(economical[0]);
  expect(promptGuidelines("nonsense")[0]).toBe(economical[0]);
  expect(economical[0]).toMatch(/^Delegate work that can run in parallel/u);
  expect(economical[0]).toContain("task-calibrated");
  expect(economical[0]).not.toContain("role's cheaper model is picked");
  expect(promptGuidelines("conservative")[0]).toMatch(/^Prefer direct work for routine investigation/u);
  expect(economical.slice(1)).toEqual(promptGuidelines("conservative").slice(1));

  const h = harness();
  const registered: string[][] = [];
  h.pi.registerTool = (t: { promptGuidelines: string[] }) => void registered.push(t.promptGuidelines);
  subagents(h.pi);
  expect(registered).toHaveLength(1);
  expect(registered[0]![0]).toMatch(/^Delegate work that can run in parallel/u);
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-delegation-"));
  mkdirSync(path.join(cwd, ".pi"));
  writeFileSync(path.join(cwd, ".pi", "pi-subagents.json"), JSON.stringify({ delegation: "conservative" }));
  const ctx = h.ctx({ cwd, ui: fakeUI() });
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(registered).toHaveLength(2);
  expect(registered[1]![0]).toMatch(/^Prefer direct work/u);
  // The same setting again registers nothing new (the system prompt stays as it is).
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(registered).toHaveLength(2);
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
});

test("cancellation while quota is pending prevents a late spawn", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  let release!: (value: any) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  pressureReader.mockReset().mockImplementation(() => {
    entered();
    return new Promise((resolve) => { release = resolve; });
  });
  try {
    const cwd = mkdtempSync(path.join(tmpdir(), "subagents-abort-pressure-"));
    const jev = fakeJev(() => ({
      effort: { type: "choice", choice: "high", confidence: 1, probabilities: { high: 1 } },
    }));
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ctx = h.ctx({ cwd, ui: fakeUI(), model: { provider: "p", id: "parent" }, modelRegistry: { ...jev.registry as object, getAll: () => [] } });
    await h.emit("session_start", {}, ctx);
    const abort = new AbortController();
    const work = tool.execute("cancel", { task: "cancel", agent: "general", model: "p/parent" }, abort.signal, undefined, ctx);
    const rejected = expect(work).rejects.toThrow(/Cancelled/);
    await waiting;
    abort.abort();
    release({ state: "ready", tier: "critical", p: 1 });
    await rejected;
    expect(h.entries.filter((entry) => entry.customType === "subagents:run")).toHaveLength(0);
    await h.emit("session_shutdown", {}, ctx);
  } finally {
    setPiInvocation(undefined);
    pressureReader.mockReset().mockResolvedValue({ state: "unavailable", tier: "none", p: 0 });
  }
});

test("boundary snapshots are shared within a batch, target explicit providers, and skip pinned choices", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  pressureReader.mockReset().mockResolvedValue({ state: "ready", tier: "critical", p: 1 });
  try {
    const cwd = mkdtempSync(path.join(tmpdir(), "subagents-scopes-"));
    mkdirSync(path.join(cwd, ".pi"));
    writeFileSync(path.join(cwd, ".pi", "pi-subagents.json"), JSON.stringify({
      providerTiers: { p: { fast: "p/small", balanced: "p/mid" } },
    }));
    const jev = fakeJev(() => ({
      role: { type: "choice", choice: "general", confidence: 1, probabilities: { general: 1 } },
      tier: { type: "choice", choice: "balanced", confidence: 1, probabilities: { balanced: 1 } },
      effort: { type: "choice", choice: "high", confidence: 1, probabilities: { high: 1 } },
    }));
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ctx = h.ctx({ cwd, ui: fakeUI(), model: { provider: "p", id: "parent" }, modelRegistry: { ...jev.registry as object, getAll: () => [] } });
    await h.emit("session_start", {}, ctx);
    const tasks = [
      { task: "one", model: "other/model" },
      { task: "two", model: "other/model" },
      { task: "three" },
      { task: "pinned", model: "other/model", thinking: "low" },
    ];
    const result = await tool.execute("batch", { tasks, async: true }, undefined, undefined, ctx);
    expect(result.details.runs).toHaveLength(4);
    expect(pressureReader).toHaveBeenCalledTimes(2);
    expect(pressureReader.mock.calls.map((call) => [call[1], call[2].scope])).toEqual(expect.arrayContaining([
      [{ provider: "other", id: "model" }, "target"],
      [{ provider: "p", id: "parent" }, "shared"],
    ]));
    const pinned = result.details.runs.find((run: any) => run.task === "pinned");
    expect(pinned).not.toHaveProperty("pressure");
    await h.emit("session_shutdown", {}, ctx);
  } finally {
    setPiInvocation(undefined);
    pressureReader.mockReset().mockResolvedValue({ state: "unavailable", tier: "none", p: 0 });
  }
});

test("the automatic mark shows pressure", () => {
  expect(jevMark(false, 0.5)).toBe("");
  expect(jevMark(true)).toBe(" (auto)");
  expect(jevMark(true, 0)).toBe(" (auto)");
  expect(jevMark(true, 0.46)).toBe(" (auto, p=0.5)");
});

test("boundary pressure tightens Jev picks, and the row and record show it", async () => {
  pressureReader.mockReset().mockResolvedValue({ state: "unavailable", tier: "none", p: 0 });
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const cwd = mkdtempSync(path.join(tmpdir(), "subagents-pressure-"));
    mkdirSync(path.join(cwd, ".pi"));
    writeFileSync(path.join(cwd, ".pi", "pi-subagents.json"), JSON.stringify({
      providerTiers: { p: { fast: "p/small", balanced: "p/mid", strong: "p/big" } },
    }));
    const jev = fakeJev(() => ({
      role: { type: "choice", choice: "general", confidence: 1, probabilities: { general: 1 } },
      tier: { type: "choice", choice: "strong", confidence: 0.5, probabilities: { fast: 0.1, balanced: 0.4, strong: 0.5 } },
      effort: { type: "choice", choice: "high", confidence: 0.5, probabilities: { low: 0.05, medium: 0.25, high: 0.5, xhigh: 0.2 } },
    }));
    const h = harness();
    let tool: any;
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    h.pi.events.on = (channel: string, fn: (data: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
      return () => undefined;
    };
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ctx = h.ctx({ cwd, ui: fakeUI(), model: { provider: "p", id: "m" }, modelRegistry: { ...jev.registry as object, getAll: () => [] } });
    await h.emit("session_start", { type: "session_start" }, ctx);

    // No pressure known: p = 0, the relaxed bar.
    const calm = await tool.execute("t1", { task: "calm", async: true }, undefined, undefined, ctx);
    expect(calm.details.runs[0]).toMatchObject({ model: "p/big", thinking: "high", byJev: { model: true, thinking: true } });
    expect(calm.details.runs[0]).not.toHaveProperty("pressure");
    expect(tool.renderResult(calm, { expanded: false }, plain).render(200).join("\n")).toContain("big (auto) · high (auto)");

    pressureReader.mockResolvedValue({ state: "ready", tier: "critical", p: 1 });
    const tight = await tool.execute("t2", { task: "tight", async: true }, undefined, undefined, ctx);
    expect(tight.details.runs[0]).toMatchObject({ model: "p/mid", thinking: "medium", pressure: 1 });
    expect(tool.renderResult(tight, { expanded: false }, plain).render(200).join("\n")).toContain("mid (auto, p=1.0) · medium (auto, p=1.0)");
    const record = h.entries.filter((e) => e.customType === "subagents:run").map((e) => e.data as any).find((d) => d.id === tight.details.runs[0].id);
    expect(record).toMatchObject({ pressure: 1, byJev: { model: true, thinking: true }, source: { model: "tier", thinking: "jev" } });
    expect(pressureReader).toHaveBeenCalledTimes(2);
    expect(pressureReader.mock.calls[1]![1]).toEqual({ provider: "p", id: "m" });
    expect(pressureReader.mock.calls[1]![2]).toMatchObject({ scope: "shared", cwd });
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally {
    setPiInvocation(undefined);
  }
});
