import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import system1Extension from "../src/index.ts";
import { queryFooterActions } from "../src/footer-actions.ts";
import { querySystem1State } from "../src/system1-contract.ts";
import {
  SYSTEM1_CHANGED, addClassifierUsage, askSystem1, getSystem1RuntimeSnapshot, installSystem1Notifications,
  readSystem1Setting, resolveSystem1Target, subscribeSystem1Events, system1TargetKey,
  type ClassifierQuestion, type ClassifierUsage, type System1Backend, type System1Event,
} from "../src/system1.ts";
import { BILLING_CONFIRMATION, DEFAULT_CLASSIFIER, openSystem1Picker } from "../src/ui.ts";

const observedWatches = vi.hoisted(() => ({ entries: [] as { listener(event: string, filename: string | null): void; close: ReturnType<typeof vi.fn> }[] }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: vi.fn(fs.readFileSync),
    writeFileSync: vi.fn(fs.writeFileSync),
    renameSync: vi.fn(fs.renameSync),
    watch: (path: string, listener: (event: string, filename: string | null) => void) => {
      const watcher = fs.watch(path, listener);
      observedWatches.entries.push({ listener, close: vi.spyOn(watcher, "close") });
      return watcher;
    },
  };
});
const providerFactory = vi.hoisted(() => vi.fn(async () => ({ id: "system1-openai" })));
vi.mock("../src/provider.ts", async (original) => ({
  ...await original<typeof import("../src/provider.ts")>(), createDecisionsProvider: providerFactory,
}));

function bus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: { channel: string; data: unknown }[] = [];
  return {
    emitted,
    on(channel: string, fn: (data: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(fn); listeners.set(channel, set);
      return () => { set.delete(fn); };
    },
    emit(channel: string, data: unknown) { emitted.push({ channel, data }); for (const fn of listeners.get(channel) ?? []) fn(data); },
  };
}
const reportedUsage: ClassifierUsage = {
  input: 12, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 19,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};
const questions: Record<string, ClassifierQuestion> = {
  safe: { type: "bool", instructions: "Is the supplied evidence safe?", criteria: { true: "Safe", false: "Unsafe" } },
  action: { type: "choice", instructions: "Choose an action", criteria: { keep: "Keep", stop: "Stop" } },
  effort: { type: "score", instructions: "Rate effort", criteria: ["Low", "Medium", "High"] },
};
const answers = {
  safe: { type: "bool", probability: 0.8 },
  action: { type: "choice", choice: "keep", probabilities: { keep: 0.7, stop: 0.3 }, confidence: 0.7 },
  effort: { type: "score", score: 1.25, confidence: 0.9 },
};

async function harness(options: { ui?: boolean; decisions?: boolean; credentials?: boolean; idle?: boolean } = {}) {
  const events = bus();
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void>; getArgumentCompletions(prefix: string): unknown }>();
  let tool: any;
  let session = "one";
  let idle = options.idle ?? true;
  let credentials = options.credentials ?? true;
  const native = { type: "classifier", provider: "system1-openai", id: "gpt-6-luna", api: "openai-decisions", baseUrl: "https://api.openai.com/v1" };
  const jev = { type: "classifier", provider: "typesafe", id: "jev-latest" };
  const registry = {
    findOfType: vi.fn((_type: string, provider: string) => provider === "typesafe" ? jev : options.decisions === false ? undefined : native),
    hasConfiguredAuth: vi.fn(() => credentials),
    getProviderAuthStatus: vi.fn(() => ({ configured: credentials })),
    getApiKeyForProvider: vi.fn(() => { throw new Error("must never resolve credentials for status"); }),
    classify: vi.fn(async (model: { id: string }, _context: unknown, _options: unknown) => ({ stopReason: "stop", model: model.id, answers, usage: reportedUsage })),
  };
  const ctx = {
    hasUI: options.ui ?? true, mode: options.ui === false ? "print" : "tui", cwd: "/unused-project",
    modelRegistry: registry, sessionManager: { getSessionId: () => session }, isIdle: () => idle,
    ui: { notify: vi.fn(), select: vi.fn(async (_question: string, _options: string[]): Promise<string | undefined> => undefined) },
  } as unknown as ExtensionContext;
  const registerProvider = vi.fn();
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    events, registerProvider, appendEntry, sendMessage,
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    registerTool: (value: any) => { tool = value; },
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(fn); handlers.set(name, registered);
      return () => { const index = registered.indexOf(fn); if (index >= 0) registered.splice(index, 1); };
    },
  } as unknown as ExtensionAPI;
  await system1Extension(pi);
  // Pi awaits all handlers in registration order, including the runtime binder
  // registered before the core's own start/tree/shutdown handler.
  const fire = async (event: string, data: unknown = {}) => {
    for (const handler of [...(handlers.get(event) ?? [])]) await handler(data, ctx);
  };
  const command = async (args: string) => { await commands.get("system1")!.handler(args, ctx); };
  const close = async () => { await fire("session_shutdown"); };
  cleanup.push(close);
  return {
    pi, ctx, registry, events, commands, tool, registerProvider, appendEntry, sendMessage, handlers, fire, command, close,
    start: () => fire("session_start"), setSession: (value: string) => { session = value; }, setIdle: (value: boolean) => { idle = value; },
    setCredentials: (value: boolean) => { credentials = value; },
    select: vi.mocked(ctx.ui.select), notify: vi.mocked(ctx.ui.notify),
  };
}
let directory: string;
let oldAgentDir: string | undefined;
let cleanup: (() => Promise<void>)[] = [];
const file = () => join(directory, "system1.json");
const write = (backend: string) => writeFileSync(file(), JSON.stringify({ backend }));
const writeOrder = (waterfall: System1Backend[]) => writeFileSync(file(), JSON.stringify({ waterfall, backend: waterfall[0] }));
const PRESETS = ["Jev → OpenAI", "OpenAI → Jev", "Jev only", "OpenAI only"];
const CONFIRM_OPTIONS = ["Use included credits", "Keep current order"];
const BILLING_TEXT = "This waterfall can use OpenAI Decisions API billing, funded by your claimed Pro credits. Confirm the linked API organization has active included credits, no purchased balance, no auto-recharge and no paid continuation. Pi cannot verify the funding source. Continue?";
const changes = (h: Awaited<ReturnType<typeof harness>>) => h.events.emitted.filter(event => event.channel === SYSTEM1_CHANGED);
const judge = (h: Awaited<ReturnType<typeof harness>>, id = "one") => h.tool.execute(id, { state: {}, questions }, undefined, undefined, h.ctx);
const quotaFailure = () => ({ stopReason: "error", model: "configured-model", answers: {}, usage: reportedUsage, errorMessage: "insufficient_quota" } as const);
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

beforeEach(() => {
  observedWatches.entries = [];
  oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  directory = mkdtempSync(join(tmpdir(), "pi-system1-index-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  providerFactory.mockReset().mockResolvedValue({ id: "system1-openai" });
});
afterEach(async () => {
  for (const close of cleanup) await close();
  cleanup = [];
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
});

describe("tool presentation", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const render = (component: { render(width: number): string[] }) => component.render(500).join("\n");

  it("shows types and typed answers without changing or exposing the payload", async () => {
    const h = await harness();
    expect(h.tool.ccstyleOwnCall).toBe(true);
    expect(h.tool.ccstyleOwnResult).toBe(true);
    const input = { state: { secret: "hidden evidence" }, questions };
    const before = structuredClone(input);
    const call = render(h.tool.renderCall(input, theme));
    expect(call).toContain("3 questions (bool: 1, choice: 1, score: 1)");
    expect(call).not.toContain("hidden evidence");
    expect(input).toEqual(before);
    const result = await judge(h);
    const snapshot = structuredClone(result);
    const compact = render(h.tool.renderResult(result, { expanded: false }, theme));
    expect(compact).toContain("jev · typesafe/jev-latest · primary");
    expect(compact).toContain("safe: bool probability 0.8");
    expect(compact).toContain("action: choice keep · confidence 0.7");
    expect(compact).toContain("effort: score 1.25 · confidence 0.9");
    expect(compact).not.toContain("Attempts:");
    const expanded = render(h.tool.renderResult(result, { expanded: true }, theme));
    expect(expanded).toContain("Attempts: 1");
    expect(expanded).toContain("Usage: tokens: 19");
    expect(expanded).not.toContain(result.details.selectionKey);
    expect(expanded).not.toContain(result.details.targetKey);
    expect(result).toEqual(snapshot);
  });

  it("preserves completed execution errors and expands every answer in a large batch", async () => {
    const h = await harness();
    const failure = { content: [{ type: "text", text: "Tool blocked: approval was denied" }], details: {} };
    expect(render(h.tool.renderResult(failure, { expanded: true, isPartial: false }, theme))).toContain("Tool blocked: approval was denied");
    expect(render(h.tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: false }, theme))).toContain("Judgment unavailable");
    expect(render(h.tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: true }, theme))).toContain("Judgment pending");
    const result = await judge(h);
    result.details = { ...result.details, answers: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`question-${i}`, { type: "bool", probability: 0.8 }])) };
    expect(render(h.tool.renderResult(result, { expanded: false }, theme))).toContain("1 more answer (expand to view)");
    expect(render(h.tool.renderResult(result, { expanded: true }, theme))).toContain("question-40: bool probability 0.8");
  });

  it("distinguishes fallback, refusal, exhaustion and cancellation", async () => {
    const h = await harness();
    writeOrder(["jev", "openai-decisions"]);
    h.registry.classify.mockResolvedValueOnce(quotaFailure() as never);
    const fallback = await judge(h);
    expect(render(h.tool.renderResult(fallback, { expanded: false }, theme))).toContain("openai-decisions · system1-openai/gpt-6-luna · fallback");
    for (const [code, label] of [["refused", "Refused"], ["exhausted", "Error"], ["cancelled", "Cancelled"]]) {
      const details = { ok: false, code, reason: "reason", attempts: [], latencyMs: 1 };
      expect(render(h.tool.renderResult({ details }, { expanded: true }, theme))).toContain(`${label} (${code}): reason`);
    }
  });
});

describe("registration and status", () => {
  it("registers the isolated provider, command, typed read-only tool, but no startup resources/state", async () => {
    const h = await harness();
    expect(h.registerProvider).toHaveBeenCalledWith({ id: "system1-openai" });
    expect(h.commands.size).toBe(1);
    expect(h.tool.name).toBe("system1_judge");
    expect(h.tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(h.tool.outputSchema).toBeDefined();
    expect(querySystem1State(h.events)).toBeUndefined();
    expect(h.registry.findOfType).not.toHaveBeenCalled();
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("stays usable in Jev mode on hosts without the Decisions provider", async () => {
    providerFactory.mockResolvedValueOnce(undefined as never);
    const h = await harness({ decisions: false });
    await h.start(); await h.command("status");
    expect(h.registerProvider).not.toHaveBeenCalled();
    expect(querySystem1State(h.events)).toMatchObject({ waterfall: ["jev"], candidates: [{ backend: "jev", local: "configured" }], status: "ready" });
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain("typesafe/jev-latest");
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("reports target, global path and unverified billing without inference or request auth", async () => {
    write("openai-decisions");
    const h = await harness(); await h.start(); await h.command("status");
    const text = h.notify.mock.calls.at(-1)?.[0];
    expect(text).toContain("System 1 order: OpenAI");
    expect(text).toContain("system1-openai/gpt-6-luna");
    expect(text).toContain(file());
    expect(text).toContain("local: configured");
    expect(text).toContain("Last main-registry route: unknown");
    expect(text).toContain("Retry scope: this Pi process and its in-process views only; no background probes.");
    expect(text).toContain("Pro API credits: billing source not verified by Pi");
    expect(h.registry.classify).not.toHaveBeenCalled();
    expect(h.registry.getApiKeyForProvider).not.toHaveBeenCalled();
    h.registry.findOfType.mockClear(); h.registry.getProviderAuthStatus.mockClear(); h.registry.hasConfiguredAuth.mockClear();
    const reads = vi.mocked(readFileSync).mock.calls.length;
    const snapshot = querySystem1State(h.events)!;
    expect(snapshot).toEqual({
      waterfall: ["openai-decisions"], status: "ready",
      candidates: [{ backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna", local: "configured" }],
    });
    snapshot.waterfall.length = 0; snapshot.candidates[0]!.local = "missing";
    expect(querySystem1State(h.events)).not.toEqual(snapshot);
    expect(vi.mocked(readFileSync).mock.calls).toHaveLength(reads);
    expect(h.registry.findOfType).not.toHaveBeenCalled();
    expect(h.registry.getProviderAuthStatus).not.toHaveBeenCalled();
    expect(h.registry.hasConfiguredAuth).not.toHaveBeenCalled();
  });

  it("reports malformed configuration as unavailable instead of another selected backend", async () => {
    writeFileSync(file(), "{broken");
    const h = await harness(); await h.start(); await h.command("status");
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain("System 1 order: unavailable");
    expect(querySystem1State(h.events)).toEqual({ waterfall: [], candidates: [], status: "unavailable" });
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("accepts only the exact supported subcommands", async () => {
    const h = await harness(); await h.start();
    const invalid = ["unknown", "openai extra", "jev extra", "status extra", "retry extra", "order", "order   ", "order jev jev", "order openai openai-decisions", "order jev unknown", "order jev openai jev"];
    for (const arg of invalid) await h.command(arg);
    expect(h.notify).toHaveBeenCalledTimes(invalid.length);
    for (const [text] of h.notify.mock.calls) expect(text).toBe("Use /system1, /system1 status, /system1 jev, /system1 openai, /system1 order jev openai, or /system1 retry.");
    expect(h.commands.get("system1")!.getArgumentCompletions("o")).toEqual([{ value: "openai", label: "openai" }, { value: "order", label: "order" }]);
    expect(h.commands.get("system1")!.getArgumentCompletions("r")).toEqual([{ value: "retry", label: "retry" }]);
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    expect(changes(h)).toHaveLength(0);
    expect(h.registry.classify).not.toHaveBeenCalled();
  });
});

describe("picker and explicit activation", () => {
  it.each([true, false])("handles its real SDK prompt lifecycle before delayed end events (credentials=%s)", async (credentials) => {
    const { ExtensionRunner } = await import(new URL("./core/extensions/runner.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    const h = await harness({ credentials });
    await h.start();
    let releaseEnds!: () => void;
    const endBarrier = new Promise<void>(resolve => { releaseEnds = resolve; });
    const selections: { title: string; options: string[]; resolve(value: string | undefined): void }[] = [];
    const delivered: string[] = [];
    // Exercise Pi's real wrapper: an earlier extension may delay queued prompt-end
    // delivery until after both select promises and the entire command resolve.
    const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
      uiPromptDepth: 0,
      emit: async (event: { type: string }) => {
        if (event.type === "ui_prompt_end") await endBarrier;
        else await Promise.resolve();
        await h.fire(event.type, event);
        delivered.push(event.type);
      },
    });
    const select = vi.fn((title: string, options: string[]) => new Promise<string | undefined>(resolve => { selections.push({ title, options, resolve }); }));
    Object.assign(h.ctx.ui, runner.wrapUIPromptContext({ ...h.ctx.ui, select }));
    const command = h.command("");
    try {
      await flush();
      expect(selections).toHaveLength(1);
      expect(selections[0]!.options).toEqual(PRESETS);
      selections[0]!.resolve("Jev → OpenAI");
      await flush();
      // Local unavailability never replaces consent or rejects an explicit order.
      expect(selections).toHaveLength(2);
      expect(selections[1]!.title).toBe(BILLING_TEXT);
      expect(selections[1]!.options).toEqual(CONFIRM_OPTIONS);
      selections[1]!.resolve("Use included credits");
      await command;
      expect(delivered).toContain("ui_prompt_start");
      expect(delivered).not.toContain("ui_prompt_end");
      expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev", "openai-decisions"] });
      expect(querySystem1State(h.events)).toMatchObject({ waterfall: ["jev", "openai-decisions"] });
      expect(changes(h)).toHaveLength(1);
      expect(h.registry.classify).not.toHaveBeenCalled();
    } finally {
      releaseEnds();
      for (const selection of selections) selection.resolve(undefined);
      await command;
      await flush();
    }
    expect(delivered).toContain("ui_prompt_end");
    // Late owned ends must neither strand the picker nor consume a foreign hold.
    await h.fire("ui_prompt_start", { kind: "select", title: "Foreign dialog" });
    expect(queryFooterActions(h.events)["system1.open"]).toBeUndefined();
    await h.fire("ui_prompt_end", { kind: "select", title: "Foreign dialog" });
    expect(queryFooterActions(h.events)["system1.open"]).toBeDefined();
  });

  it.each([
    { credentials: false, waterfall: ["jev"] },
    { credentials: true, waterfall: ["openai-decisions", "jev"] },
  ] as const)("keeps exactly seven wrapped 42-column lines: %j", async ({ credentials, waterfall }) => {
    writeOrder([...waterfall]);
    const h = await harness({ credentials }); await h.start(); await h.command("");
    const title = h.select.mock.calls[0]?.[0] ?? "";
    const lines = title.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("System 1");
    expect(lines[1]).toBe(`Current: ${waterfall[0] === "jev" ? "Jev" : "OpenAI → Jev"}`);
    expect(lines[2]).toBe(`Jev: ${credentials ? "configured" : "missing"}; OpenAI: ${credentials ? "configured" : "missing"}`);
    expect(lines[3]).toBe("Recent: unknown");
    expect(lines[4]).toBe("Details/setup: /system1 status.");
    expect(lines[5]).toBe("Feature-off settings still apply.");
    expect(lines[6]).toBe("API credits: funding unknown to Pi.");
    expect(lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 42)), 0)).toBe(7);
    expect(title).not.toMatch(/typesafe|jev-latest|gpt-6|cooldown/u);
    expect(h.select.mock.calls[0]![1]).toEqual(PRESETS);
    for (const option of PRESETS) expect(option.length).toBeLessThanOrEqual(42);
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it.each([
    ["Jev → OpenAI", ["jev", "openai-decisions"]],
    ["OpenAI → Jev", ["openai-decisions", "jev"]],
    ["Jev only", ["jev"]],
    ["OpenAI only", ["openai-decisions"]],
  ] as const)("activates the complete %s preset", async (label, waterfall) => {
    const h = await harness(); await h.start();
    h.select.mockResolvedValueOnce(label).mockResolvedValueOnce("Use included credits");
    await h.command("");
    expect(h.select.mock.calls[0]![1]).toEqual(PRESETS);
    expect(readSystem1Setting()).toMatchObject({ ok: true, waterfall: [...waterfall] });
    expect(h.select).toHaveBeenCalledTimes(waterfall.some(backend => backend === "openai-decisions") ? 2 : 1);
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("holds blocked throughout picker and confirmation and changes the freshness key on save", async () => {
    const h = await harness(); await h.start();
    const before = resolveSystem1Target(DEFAULT_CLASSIFIER).key;
    expect(BILLING_CONFIRMATION).toBe(BILLING_TEXT);
    h.select.mockImplementation(async (question, options) => {
      expect(h.events.emitted.filter(event => event.channel === "herdr:blocked").map(event => event.data)).toEqual([{ active: true, label: "System 1" }]);
      if (question === BILLING_TEXT) { expect(options).toEqual(CONFIRM_OPTIONS); return "Use included credits"; }
      expect(question).toContain("Feature-off settings still apply.");
      expect(options).toEqual(PRESETS);
      return "Jev → OpenAI";
    });
    await h.command("");
    expect(readSystem1Setting()).toMatchObject({ ok: true, waterfall: ["jev", "openai-decisions"] });
    expect(resolveSystem1Target(DEFAULT_CLASSIFIER).key).not.toBe(before);
    expect(changes(h)).toHaveLength(1);
    expect(h.events.emitted.filter(event => event.channel === "herdr:blocked").map(event => event.data)).toEqual([{ active: true, label: "System 1" }, { active: false }]);
    expect(h.registry.classify).not.toHaveBeenCalled();
    expect(h.registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["jev", ["jev"]], ["openai", ["openai-decisions"]],
    ["order jev openai", ["jev", "openai-decisions"]],
    ["order openai jev", ["openai-decisions", "jev"]],
    ["order jev openai-decisions", ["jev", "openai-decisions"]],
    ["order openai-decisions jev", ["openai-decisions", "jev"]],
    ["order jev", ["jev"]], ["order openai", ["openai-decisions"]],
    ["order openai-decisions", ["openai-decisions"]],
  ] as const)("accepts shortcut/order %s with the same new-inclusion consent", async (command, waterfall) => {
    const h = await harness(); await h.start();
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command(command);
    expect(readSystem1Setting()).toMatchObject({ waterfall: [...waterfall] });
    if (waterfall.some(backend => backend === "openai-decisions")) expect(h.select).toHaveBeenCalledExactlyOnceWith(BILLING_TEXT, CONFIRM_OPTIONS);
    else expect(h.select).not.toHaveBeenCalled();
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("reorders an included OpenAI rung without consent, then reprompts after removal", async () => {
    writeOrder(["jev", "openai-decisions"]);
    const h = await harness(); await h.start();
    await h.command("order openai jev");
    await h.command("openai");
    expect(h.select).not.toHaveBeenCalled();
    await h.command("jev");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    h.select.mockResolvedValueOnce("Keep current order");
    await h.command("order jev openai");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command("order jev openai");
    expect(h.select).toHaveBeenCalledTimes(2);
    for (const call of h.select.mock.calls) expect(call).toEqual([BILLING_TEXT, CONFIRM_OPTIONS]);
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev", "openai-decisions"] });
    expect(changes(h)).toHaveLength(4);
  });

  it.each([undefined, "Keep current order"])("cancelled confirmation (%s) leaves Jev unchanged", async answer => {
    const h = await harness(); await h.start(); h.select.mockResolvedValueOnce(answer);
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    expect(changes(h)).toHaveLength(0);
  });

  it("cancels the picker without writes and releases its blocked hold on UI errors", async () => {
    const h = await harness(); await h.start();
    await h.command("");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    expect(changes(h)).toHaveLength(0);
    h.select.mockRejectedValueOnce(new Error("dialog failed"));
    await expect(h.command("")).rejects.toThrow("dialog failed");
    expect(h.events.emitted.filter(event => event.channel === "herdr:blocked").at(-1)?.data).toEqual({ active: false });
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["openai-decisions"] });
  });

  it.each([{ decisions: false }, { credentials: false }])("allows unavailable targets with explicit consent: %j", async options => {
    const h = await harness(options); await h.start();
    h.select.mockResolvedValueOnce("Jev → OpenAI").mockResolvedValueOnce("Use included credits");
    await h.command("");
    expect(h.select).toHaveBeenCalledTimes(2);
    expect(h.select.mock.calls[1]).toEqual([BILLING_TEXT, CONFIRM_OPTIONS]);
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev", "openai-decisions"] });
    expect(h.registry.classify).not.toHaveBeenCalled();
    expect(h.registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("refuses headless new inclusion but allows reorder/removal of included OpenAI", async () => {
    const h = await harness({ ui: false }); await h.start();
    await h.command("order jev openai");
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain("interactive billing confirmation");
    expect(h.select).not.toHaveBeenCalled();
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    writeOrder(["jev", "openai-decisions"]);
    await h.command("order openai jev");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["openai-decisions", "jev"] });
    await h.command("jev");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    expect(changes(h)).toHaveLength(2);
    await h.command(""); expect(h.notify.mock.calls.at(-1)?.[0]).toContain("picker requires UI");
  });

  it.each(["session", "selection", "idle", "tree", "shutdown"])("rejects a stale confirmation after %s changes", async change => {
    const h = await harness(); await h.start();
    h.select.mockImplementationOnce(async () => {
      if (change === "session") h.setSession("other");
      if (change === "selection") writeFileSync(file(), "{broken");
      if (change === "idle") h.setIdle(false);
      if (change === "tree") await h.fire("session_tree");
      if (change === "shutdown") await h.close();
      return "Use included credits";
    });
    await h.command("openai");
    expect(readSystem1Setting()).not.toMatchObject({ waterfall: ["openai-decisions"] });
    expect(changes(h)).toHaveLength(0);
  });

  it("does not revoke explicit consent solely because local credentials become missing", async () => {
    const h = await harness(); await h.start();
    h.select.mockImplementationOnce(async () => { h.setCredentials(false); return "Use included credits"; });
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["openai-decisions"] });
    expect(querySystem1State(h.events)).toMatchObject({ candidates: [{ local: "missing" }], status: "unavailable" });
  });

  it.each(["blocked", "prompt"])("does not save after a foreign dialog takes ownership (%s)", async ownership => {
    const h = await harness(); await h.start();
    h.select.mockImplementationOnce(async () => {
      if (ownership === "blocked") h.events.emit("herdr:blocked", { active: true });
      else await h.fire("ui_prompt_start", { kind: "select", title: "Foreign confirmation" });
      return "Use included credits";
    });
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev"] });
    expect(changes(h)).toHaveLength(0);
    if (ownership === "blocked") h.events.emit("herdr:blocked", { active: false });
    else await h.fire("ui_prompt_end", { kind: "select", title: "Foreign confirmation" });
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["openai-decisions"] });
  });

  it("does not repair malformed settings or emit success after a failed write", async () => {
    writeFileSync(file(), "{broken");
    const h = await harness(); await h.start(); await h.command("jev");
    expect(readFileSync(file(), "utf8")).toBe("{broken");
    expect(h.notify.mock.calls.at(-1)?.[1]).toBe("error");
    expect(changes(h)).toHaveLength(0);
  });
});

describe("footer ownership and watcher", () => {
  it("opens the native picker through the same action without prompts/editor replacement", async () => {
    const h = await harness(); await h.start();
    const action = queryFooterActions(h.events)["system1.open"]!;
    expect(action.key).toBe("/system1");
    await action.run();
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select.mock.calls[0][1]).toEqual(PRESETS);
  });

  it("guards stale generation/session, busy runtime, dialog ownership and shutdown", async () => {
    const h = await harness(); await h.start();
    let action = queryFooterActions(h.events)["system1.open"]!;
    h.setIdle(false); await action.run(); expect(h.select).not.toHaveBeenCalled();
    expect(queryFooterActions(h.events)["system1.open"]).toBeUndefined();
    h.setIdle(true);
    h.events.emit("herdr:blocked", { active: true }); await action.run(); expect(h.select).not.toHaveBeenCalled();
    h.events.emit("herdr:blocked", { active: false });
    await h.fire("ui_prompt_start"); await action.run(); expect(h.select).not.toHaveBeenCalled();
    await h.fire("ui_prompt_end");
    await h.fire("session_tree"); await action.run(); expect(h.select).not.toHaveBeenCalled();
    action = queryFooterActions(h.events)["system1.open"]!;
    h.setSession("other"); await action.run(); expect(h.select).not.toHaveBeenCalled();
    h.setSession("one");
    await h.close(); await action.run(); expect(h.select).not.toHaveBeenCalled();
    expect(querySystem1State(h.events)).toBeUndefined();
  });

  it("does not publish controls outside a main TUI or during its own picker", async () => {
    const headless = await harness({ ui: false }); await headless.start();
    expect(queryFooterActions(headless.events)["system1.open"]).toBeUndefined();
    const h = await harness(); await h.start();
    h.select.mockImplementation(async () => {
      expect(queryFooterActions(h.events)["system1.open"]).toBeUndefined();
      await h.command("");
      return undefined;
    });
    await queryFooterActions(h.events)["system1.open"]!.run();
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it("observes atomic external writes after tree navigation and disposes on shutdown", async () => {
    const h = await harness(); await h.start(); await h.fire("session_tree");
    const temporary = join(directory, "external.tmp");
    writeFileSync(temporary, JSON.stringify({ backend: "openai-decisions" })); renameSync(temporary, file());
    await vi.waitFor(() => expect(querySystem1State(h.events)).toMatchObject({ waterfall: ["openai-decisions"], candidates: [{ local: "configured" }], status: "ready" }));
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(1);
    expect(h.registry.classify).not.toHaveBeenCalled();
    await h.close(); write("jev");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(1);
  });

  it("debounces directory events for 50ms and ignores a disposed same-session callback", async () => {
    const h = await harness(); await h.start();
    const old = observedWatches.entries[0];
    await h.close(); await h.start();
    expect(old.close).toHaveBeenCalled();
    const live = observedWatches.entries[1];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    write("openai-decisions");
    old.listener("rename", "system1.json");
    vi.advanceTimersByTime(100);
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
    live.listener("rename", "system1.json");
    vi.advanceTimersByTime(49);
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
    live.listener("change", "system1.json");
    vi.advanceTimersByTime(49);
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(1);
    await h.close();
    expect(live.close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("retains read-per-request correctness when the directory watcher cannot start", async () => {
    rmSync(directory, { recursive: true });
    const h = await harness(); await h.start();
    const jev = await h.tool.execute("one", { state: {}, questions }, undefined, undefined, h.ctx);
    expect(jev.structuredContent).toMatchObject({ ok: true, backend: "jev" });
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command("openai");
    const native = await h.tool.execute("two", { state: {}, questions }, undefined, undefined, h.ctx);
    expect(native.structuredContent).toMatchObject({ ok: true, backend: "openai-decisions" });
    expect(h.registry.classify).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated directory changes", async () => {
    const h = await harness(); await h.start();
    writeFileSync(join(directory, "unrelated.json"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
  });

  it("does not reread the file on synchronous state queries", async () => {
    const h = await harness(); await h.start();
    write("openai-decisions");
    expect(querySystem1State(h.events)).toMatchObject({ waterfall: ["jev"] });
    h.events.emit(SYSTEM1_CHANGED, {}); await flush();
    expect(querySystem1State(h.events)).toMatchObject({ waterfall: ["openai-decisions"] });
  });
});

describe("retry, cached runtime state and notification ownership", () => {
  it("retry resets cooldowns and freshness, emits one change and performs no writes/auth/probes", async () => {
    writeOrder(["jev", "openai-decisions"]);
    const h = await harness(); await h.start();
    h.registry.classify.mockResolvedValueOnce(quotaFailure() as never);
    await judge(h); await flush();
    const before = getSystem1RuntimeSnapshot(h.registry, DEFAULT_CLASSIFIER);
    expect(before.candidates[0]).toMatchObject({ cooldownUntil: expect.any(Number), lastFailure: { code: "quota_exhausted" } });
    const key = resolveSystem1Target(DEFAULT_CLASSIFIER).key;
    const content = readFileSync(file(), "utf8");
    const writes = vi.mocked(writeFileSync).mock.calls.length;
    const renames = vi.mocked(renameSync).mock.calls.length;
    h.registry.classify.mockClear(); h.registry.getApiKeyForProvider.mockClear(); h.notify.mockClear();
    await h.command("retry");
    expect(readFileSync(file(), "utf8")).toBe(content);
    expect(vi.mocked(writeFileSync).mock.calls).toHaveLength(writes);
    expect(vi.mocked(renameSync).mock.calls).toHaveLength(renames);
    expect(h.registry.classify).not.toHaveBeenCalled();
    expect(h.registry.getApiKeyForProvider).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    const after = getSystem1RuntimeSnapshot(h.registry, DEFAULT_CLASSIFIER);
    expect(after.resetGeneration).toBe(before.resetGeneration + 1);
    expect(after.lastResetAt).toBeGreaterThanOrEqual(before.lastResetAt);
    expect(after.candidates.every(candidate => !candidate.cooldownUntil && !candidate.lastFailure && !candidate.probing)).toBe(true);
    expect(after.lastOutcome).toBeUndefined();
    expect(after.lastUsed).toBeUndefined();
    expect(after.nextRetryAt).toBeUndefined();
    expect(resolveSystem1Target(DEFAULT_CLASSIFIER).key).not.toBe(key);
    expect(changes(h).map(event => event.data)).toEqual([{ reset: true }]);
    expect(h.notify).toHaveBeenCalledExactlyOnceWith("System 1 cooldowns reset; the next judgment retries the configured order.", "info");
    expect(querySystem1State(h.events)).toMatchObject({ waterfall: ["jev", "openai-decisions"], status: "ready" });
  });

  it.each(["retry", "jev", "order jev openai"])("busy %s reports wait without changing policy or freshness", async command => {
    writeOrder(["openai-decisions", "jev"]);
    const h = await harness({ idle: false }); await h.start();
    const key = resolveSystem1Target(DEFAULT_CLASSIFIER).key;
    const content = readFileSync(file(), "utf8");
    await h.command(command);
    expect(h.notify).toHaveBeenCalledExactlyOnceWith("Wait for the current turn to finish before changing System 1 or resetting cooldowns.", "warning");
    expect(resolveSystem1Target(DEFAULT_CLASSIFIER).key).toBe(key);
    expect(readFileSync(file(), "utf8")).toBe(content);
    expect(changes(h)).toHaveLength(0);
    expect(h.registry.classify).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });

  it.each(["blocked", "prompt", "session", "shutdown", "own-picker"])("retry respects %s ownership", async ownership => {
    const h = await harness(); await h.start();
    const key = resolveSystem1Target(DEFAULT_CLASSIFIER).key;
    if (ownership === "blocked") h.events.emit("herdr:blocked", { active: true });
    if (ownership === "prompt") await h.fire("ui_prompt_start", { kind: "select", title: "Foreign" });
    if (ownership === "session") h.setSession("other");
    if (ownership === "shutdown") await h.close();
    if (ownership === "own-picker") {
      h.select.mockImplementationOnce(async () => { await h.command("retry"); return undefined; });
      await h.command("");
    } else await h.command("retry");
    expect(resolveSystem1Target(DEFAULT_CLASSIFIER).key).toBe(key);
    expect(changes(h)).toHaveLength(0);
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("publishes cached main fallback/cooldown status and details, not synchronous I/O", async () => {
    writeOrder(["jev", "openai-decisions"]);
    const h = await harness(); await h.start();
    h.registry.classify.mockResolvedValueOnce(quotaFailure() as never);
    const result = await judge(h); await flush();
    expect(getSystem1RuntimeSnapshot(h.registry, DEFAULT_CLASSIFIER).lastOutcome).toEqual(result.structuredContent);
    const expected = {
      waterfall: ["jev", "openai-decisions"], status: "fallback",
      candidates: [
        { backend: "jev", provider: "typesafe", model: "jev-latest", local: "configured", cooldownUntil: expect.any(Number), lastFailure: { code: "quota_exhausted", at: expect.any(Number) } },
        { backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna", local: "configured" },
      ],
      lastUsed: { backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna", at: expect.any(Number), fallback: true },
      nextRetryAt: expect.any(Number),
    };
    expect(querySystem1State(h.events)).toEqual(expected);
    await h.command("status");
    const text = h.notify.mock.calls.at(-1)![0];
    expect(text).toContain("System 1 order: Jev → OpenAI");
    expect(text).toContain("cooldown:");
    expect(text).toContain("last failure: quota_exhausted");
    expect(text).toContain("Last main-registry route: OpenAI* (fallback)");
    expect(text).toContain("Attempt Jev: failed; quota_exhausted");
    expect(text).toContain("Next retry eligible:");
    expect(text).toContain("Pro API credits: billing source not verified by Pi");
    await h.command("");
    expect(h.select.mock.calls[0]![0]).toContain("Recent: OpenAI*");
    h.registry.findOfType.mockClear(); h.registry.hasConfiguredAuth.mockClear(); h.registry.getProviderAuthStatus.mockClear();
    const reads = vi.mocked(readFileSync).mock.calls.length;
    expect(querySystem1State(h.events)).toEqual(expected);
    expect(vi.mocked(readFileSync).mock.calls).toHaveLength(reads);
    expect(h.registry.findOfType).not.toHaveBeenCalled();
    expect(h.registry.hasConfiguredAuth).not.toHaveBeenCalled();
    expect(h.registry.getProviderAuthStatus).not.toHaveBeenCalled();
    expect(h.registry.getApiKeyForProvider).not.toHaveBeenCalled();
    expect(changes(h)).toHaveLength(0);
  });

  it("reports whole-chain unavailability without fabricating lastUsed", async () => {
    writeOrder(["jev", "openai-decisions"]);
    const h = await harness(); await h.start();
    h.registry.classify.mockResolvedValue(quotaFailure() as never);
    await judge(h); await flush();
    expect(querySystem1State(h.events)).toMatchObject({
      status: "unavailable", waterfall: ["jev", "openai-decisions"],
      candidates: [
        { cooldownUntil: expect.any(Number), lastFailure: { code: "quota_exhausted" } },
        { cooldownUntil: expect.any(Number), lastFailure: { code: "quota_exhausted" } },
      ],
    });
    expect(querySystem1State(h.events)!.lastUsed).toBeUndefined();
    await h.command("status");
    expect(h.notify.mock.calls.at(-1)![1]).toBe("warning");
    expect(h.notify.mock.calls.at(-1)![0]).toContain("Last main-registry route: unknown");
  });

  it("observes child outcomes globally but isolates main route, state and registry observers", async () => {
    writeOrder(["jev", "openai-decisions"]);
    const h = await harness(); await h.start();
    const mainResult = await judge(h); await flush();
    const main = querySystem1State(h.events);
    expect(main).toMatchObject({ status: "ready", lastUsed: { backend: "jev", fallback: false } });
    const child = {
      ...h.registry,
      findOfType: vi.fn(h.registry.findOfType.getMockImplementation()!),
      hasConfiguredAuth: vi.fn(h.registry.hasConfiguredAuth.getMockImplementation()!),
      getProviderAuthStatus: vi.fn(h.registry.getProviderAuthStatus.getMockImplementation()!),
      classify: vi.fn(h.registry.classify.getMockImplementation()!),
    };
    h.registry.findOfType.mockClear(); h.registry.hasConfiguredAuth.mockClear(); h.registry.getProviderAuthStatus.mockClear();
    child.classify.mockResolvedValueOnce(quotaFailure() as never);
    const global: System1Event[] = [];
    const mainOnly: System1Event[] = [];
    const offGlobal = subscribeSystem1Events(event => global.push(event));
    const offMain = subscribeSystem1Events(event => mainOnly.push(event), h.registry);
    try {
      const childOutcome = await askSystem1(child, DEFAULT_CLASSIFIER, { child: "evidence" }, questions);
      await flush();
      expect(childOutcome).toMatchObject({ ok: true, backend: "openai-decisions", fallback: true });
      expect(global.some(event => event.type === "notice" && event.registry === child)).toBe(true);
      expect(global.some(event => event.type === "outcome" && event.registry === child)).toBe(true);
      expect(mainOnly).toHaveLength(0);
      expect(h.notify).toHaveBeenCalled(); // The visible sink still reports child failure.
      expect(querySystem1State(h.events)).toEqual(main);
      const mainRuntime = getSystem1RuntimeSnapshot(h.registry, DEFAULT_CLASSIFIER);
      expect(mainRuntime.lastUsed).toMatchObject({ backend: "jev", fallback: false });
      expect(mainRuntime.lastOutcome).toEqual(mainResult.structuredContent);
      expect(getSystem1RuntimeSnapshot(child, DEFAULT_CLASSIFIER).lastUsed).toMatchObject({ backend: "openai-decisions", fallback: true });
      expect(h.registry.findOfType).not.toHaveBeenCalled();
      expect(h.registry.hasConfiguredAuth).not.toHaveBeenCalled();
      expect(h.registry.getProviderAuthStatus).not.toHaveBeenCalled();
    } finally { offGlobal(); offMain(); }
    expect(changes(h)).toHaveLength(0);
  });

  it("prioritizes the core's 100 sink and releases/rebinds across shutdown/tree/restart", async () => {
    const h = await harness();
    const handlers = new Map<string, ((event: unknown, ctx: any) => unknown)[]>();
    const siblingEntry = vi.fn(); const siblingNotify = vi.fn(); const siblingOutcome = vi.fn();
    installSystem1Notifications({
      appendEntry: siblingEntry,
      on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    }, { priority: 0, onOutcome: siblingOutcome });
    const siblingCtx = { ...h.ctx, ui: { notify: siblingNotify } };
    const fireSibling = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({}, siblingCtx); };
    cleanup.push(() => fireSibling("session_shutdown"));
    await h.start();
    await fireSibling("session_start");
    expect(h.handlers.get("session_start")!.length).toBeGreaterThanOrEqual(2);
    await judge(h);
    expect(h.appendEntry).toHaveBeenCalledTimes(1);
    expect(siblingEntry).not.toHaveBeenCalled();
    expect(siblingOutcome).not.toHaveBeenCalled();
    await h.close();
    h.registry.classify.mockResolvedValueOnce(quotaFailure() as never);
    await judge(h, "after-shutdown");
    expect(siblingEntry).toHaveBeenCalledTimes(1);
    expect(siblingOutcome).toHaveBeenCalledTimes(1);
    expect(siblingNotify).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
    expect(querySystem1State(h.events)).toBeUndefined();
    await h.start(); await h.fire("session_tree");
    await judge(h, "after-rebind"); await flush();
    expect(h.appendEntry).toHaveBeenCalledTimes(2);
    expect(siblingEntry).toHaveBeenCalledTimes(1);
    expect(querySystem1State(h.events)).toMatchObject({ lastUsed: { backend: "jev" }, status: "ready" });
    expect(h.sendMessage).not.toHaveBeenCalled();
    const metadata = JSON.stringify(h.appendEntry.mock.calls);
    expect(metadata).not.toContain('"answers"');
    expect(metadata).not.toContain('"state"');
    expect(metadata).not.toContain('"questions"');
  });
});

describe("manual typed judgment", () => {
  it.each(["jev", "openai-decisions"] as const)("reports real %s winner, typed data, attempts and actual tool usage", async backend => {
    write(backend);
    const h = await harness(); await h.start();
    const signal = new AbortController().signal;
    const result = await h.tool.execute("one", { state: { evidence: "do not execute actions" }, questions }, signal, undefined, h.ctx);
    const target = backend === "jev"
      ? { backend, provider: "typesafe", model: "jev-latest" }
      : { backend, provider: "system1-openai", model: "gpt-6-luna" };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true, ...target, answers, waterfall: [backend], fallback: false,
      usage: reportedUsage, latencyMs: expect.any(Number), selectionKey: resolveSystem1Target(DEFAULT_CLASSIFIER).key,
      targetKey: system1TargetKey(target),
      attempts: [{ ...target, targetKey: system1TargetKey(target), status: "succeeded", latencyMs: expect.any(Number), sdkCalls: 1, usage: reportedUsage }],
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.details).toEqual(result.structuredContent);
    expect(Value.Check(h.tool.outputSchema, result.structuredContent)).toBe(true);
    expect(Value.Check(h.tool.outputSchema, { ...result.structuredContent, fallback: "not boolean" })).toBe(false);
    expect(Value.Check(h.tool.outputSchema, { ...result.structuredContent, attempts: [{ ...result.structuredContent.attempts[0], sdkCalls: "one" }] })).toBe(false);
    expect(result.usage).toEqual(reportedUsage);
    expect(h.registry.classify).toHaveBeenCalledTimes(1);
    expect(h.registry.classify.mock.calls[0]![2]).toMatchObject({ timeoutMs: expect.any(Number), retries: 0, signal: expect.any(AbortSignal) });
    expect((h.registry.classify.mock.calls[0]![2] as any).timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it("returns the fallback winner and aggregates failed and successful usage exactly once", async () => {
    writeOrder(["jev", "openai-decisions"]);
    const h = await harness(); await h.start();
    h.registry.classify.mockResolvedValueOnce(quotaFailure() as never);
    const result = await judge(h);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true, waterfall: ["jev", "openai-decisions"], backend: "openai-decisions",
      provider: "system1-openai", model: "gpt-6-luna", fallback: true,
      targetKey: JSON.stringify(["openai-decisions", "system1-openai", "gpt-6-luna"]),
      attempts: [
        { backend: "jev", status: "failed", code: "quota_exhausted", reason: expect.any(String), sdkCalls: 1, usage: reportedUsage },
        { backend: "openai-decisions", status: "succeeded", sdkCalls: 1, usage: reportedUsage },
      ],
      usage: addClassifierUsage(reportedUsage, reportedUsage),
    });
    expect(result.usage).toEqual(addClassifierUsage(reportedUsage, reportedUsage));
    expect(result.details).toEqual(result.structuredContent);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(Value.Check(h.tool.outputSchema, result.structuredContent)).toBe(true);
    expect(h.registry.classify).toHaveBeenCalledTimes(2);
    expect(changes(h)).toHaveLength(0);
    expect(readSystem1Setting()).toMatchObject({ waterfall: ["jev", "openai-decisions"] });
  });

  it("marks exhausted chains as errors with typed attempts and all reported usage", async () => {
    writeOrder(["openai-decisions", "jev"]);
    const h = await harness(); await h.start();
    h.registry.classify.mockResolvedValue(quotaFailure() as never);
    const result = await judge(h);
    expect(result.isError).toBe(true);
    expect(Value.Check(h.tool.outputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false, code: "exhausted", reason: expect.stringMatching(/quota|credit/u), latencyMs: expect.any(Number),
      attempts: [
        { backend: "openai-decisions", targetKey: expect.any(String), status: "failed", code: "quota_exhausted", sdkCalls: 1 },
        { backend: "jev", targetKey: expect.any(String), status: "failed", code: "quota_exhausted", sdkCalls: 1 },
      ],
      usage: addClassifierUsage(reportedUsage, reportedUsage),
    });
    expect(result.details).toEqual(result.structuredContent);
    expect(result.usage).toEqual(addClassifierUsage(reportedUsage, reportedUsage));
    expect(Value.Check(h.tool.outputSchema, { ...result.structuredContent, code: "unknown-code" })).toBe(false);
    expect(h.registry.classify).toHaveBeenCalledTimes(2);
  });

  it("retains structured singleton failures and usage without out-of-chain fallback", async () => {
    write("openai-decisions"); const h = await harness(); await h.start();
    h.registry.classify.mockResolvedValueOnce(quotaFailure() as never);
    const result = await judge(h);
    expect(result.isError).toBe(true);
    expect(Value.Check(h.tool.outputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "exhausted", reason: expect.stringMatching(/quota|credit/u), usage: reportedUsage });
    expect(result.usage).toEqual(reportedUsage);
    expect(h.registry.classify).toHaveBeenCalledTimes(1);
    expect(h.registry.findOfType.mock.calls.every(call => call[1] === "system1-openai")).toBe(true);
  });

  it("does not infer on empty questions, cancellation or unavailable targets", async () => {
    write("openai-decisions"); const h = await harness({ decisions: false }); await h.start();
    const empty = await h.tool.execute("empty", { state: {}, questions: {} }, undefined, undefined, h.ctx);
    expect(empty.isError).toBe(true);
    expect(empty.structuredContent).toMatchObject({ code: "invalid_input", reason: "invalid classifier input", attempts: [] });
    expect(Value.Check(h.tool.outputSchema, empty.structuredContent)).toBe(true);
    const controller = new AbortController(); controller.abort();
    const cancelled = await h.tool.execute("cancelled", { state: {}, questions }, controller.signal, undefined, h.ctx);
    expect(cancelled.structuredContent).toMatchObject({ ok: false, code: "cancelled", attempts: [] });
    expect(Value.Check(h.tool.outputSchema, cancelled.structuredContent)).toBe(true);
    const missing = await judge(h);
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ ok: false, code: "exhausted", attempts: [{ code: "unavailable_model", sdkCalls: 0 }] });
    expect(Value.Check(h.tool.outputSchema, missing.structuredContent)).toBe(true);
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("can use the exported picker directly without a lifecycle context", async () => {
    const h = await harness();
    await openSystem1Picker(h.pi, h.ctx);
    expect(h.select).toHaveBeenCalledTimes(1);
  });
});
