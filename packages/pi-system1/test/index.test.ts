import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import system1Extension from "../src/index.ts";
import { queryFooterActions } from "../src/footer-actions.ts";
import { querySystem1State } from "../src/system1-contract.ts";
import { SYSTEM1_CHANGED, readSystem1Setting, type ClassifierQuestion, type ClassifierUsage } from "../src/system1.ts";
import { BILLING_CONFIRMATION, openSystem1Picker } from "../src/ui.ts";

const observedWatches = vi.hoisted(() => ({ entries: [] as { listener(event: string, filename: string | null): void; close: ReturnType<typeof vi.fn> }[] }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
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
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
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
  const pi = {
    events, registerProvider,
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    registerTool: (value: any) => { tool = value; },
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, fn); return () => handlers.delete(name); },
  } as unknown as ExtensionAPI;
  await system1Extension(pi);
  const fire = async (event: string, data: unknown = {}) => { await handlers.get(event)?.(data, ctx); };
  const command = async (args: string) => { await commands.get("system1")!.handler(args, ctx); };
  const close = async () => { await fire("session_shutdown"); };
  cleanup.push(close);
  return {
    pi, ctx, registry, events, commands, tool, registerProvider, fire, command, close,
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
    expect(querySystem1State(h.events)).toMatchObject({ backend: "jev", availability: "configured" });
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain("typesafe/jev-latest");
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("reports target, global path and unverified billing without inference or request auth", async () => {
    write("openai-decisions");
    const h = await harness(); await h.start(); await h.command("status");
    const text = h.notify.mock.calls.at(-1)?.[0];
    expect(text).toContain("openai-decisions");
    expect(text).toContain("system1-openai/gpt-6-luna");
    expect(text).toContain(file());
    expect(text).toContain("Local capability/auth: configured");
    expect(text).toContain("Pro API credits: billing source not verified by Pi");
    expect(h.registry.classify).not.toHaveBeenCalled();
    expect(h.registry.getApiKeyForProvider).not.toHaveBeenCalled();
    h.registry.findOfType.mockClear(); h.registry.getProviderAuthStatus.mockClear();
    expect(querySystem1State(h.events)).toMatchObject({ label: "Decisions", availability: "configured" });
    expect(h.registry.findOfType).not.toHaveBeenCalled();
    expect(h.registry.getProviderAuthStatus).not.toHaveBeenCalled();
  });

  it("reports malformed configuration as unavailable instead of another selected backend", async () => {
    writeFileSync(file(), "{broken");
    const h = await harness(); await h.start(); await h.command("status");
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain("System 1 backend: unavailable");
    expect(querySystem1State(h.events)).toMatchObject({ availability: "unavailable" });
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("accepts only the exact supported subcommands", async () => {
    const h = await harness(); await h.start();
    for (const arg of ["unknown", "openai extra", "jev extra", "status extra"]) await h.command(arg);
    expect(h.notify).toHaveBeenCalledTimes(4);
    for (const [text] of h.notify.mock.calls) expect(text).toBe("Use /system1, /system1 status, /system1 jev, or /system1 openai.");
    expect(h.commands.get("system1")!.getArgumentCompletions("o")).toEqual([{ value: "openai", label: "openai" }]);
  });
});

describe("picker and explicit activation", () => {
  it.each([true, false])("handles its own real SDK prompt lifecycle before delayed end events (credentials=%s)", async (credentials) => {
    const { ExtensionRunner } = await import(new URL("./core/extensions/runner.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    const h = await harness({ credentials });
    await h.start();
    let releaseEnds!: () => void;
    const endBarrier = new Promise<void>(resolve => { releaseEnds = resolve; });
    const selections: { title: string; resolve(value: string | undefined): void }[] = [];
    // Use Pi's actual select wrapper. Earlier extensions can delay delivery of the
    // queued ui_prompt_end event beyond the select promise's resolution.
    const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
      uiPromptDepth: 0,
      emit: async (event: { type: string }) => {
        if (event.type === "ui_prompt_end") await endBarrier;
        else await Promise.resolve();
        await h.fire(event.type, event);
      },
    });
    const select = vi.fn((title: string) => new Promise<string | undefined>(resolve => { selections.push({ title, resolve }); }));
    Object.assign(h.ctx.ui, runner.wrapUIPromptContext({ ...h.ctx.ui, select }));
    const command = h.command("");
    try {
      await flush();
      expect(selections).toHaveLength(1);
      selections[0]!.resolve("OpenAI Decisions (Pro credits)");
      await flush();
      if (credentials) {
        expect(selections).toHaveLength(2);
        expect(selections[1]!.title).toBe(BILLING_CONFIRMATION);
        selections[1]!.resolve("Use included credits");
      } else {
        expect(h.notify.mock.calls.at(-1)?.[0]).toContain("OpenAI Decisions unavailable");
      }
      await command;
      expect(readSystem1Setting()).toMatchObject({ backend: credentials ? "openai-decisions" : "jev" });
      expect(querySystem1State(h.events)).toMatchObject({ backend: credentials ? "openai-decisions" : "jev" });
      expect(h.registry.classify).not.toHaveBeenCalled();
    } finally {
      releaseEnds();
      for (const selection of selections) selection.resolve(undefined);
      await command;
      await flush();
    }
  });
  it.each([{ credentials: false, backend: "jev" }, { credentials: true, backend: "openai-decisions" }])("keeps picker headings visible at phone width: %j", async ({ credentials, backend }) => {
    write(backend);
    const h = await harness({ credentials });
    await h.start();
    await h.command("");
    const title = h.select.mock.calls[0]?.[0] ?? "";
    expect(title).toMatch(/^System 1\n/);
    expect(title).toContain(`Decisions: ${credentials ? "configured" : "unavailable"}`);
    expect(title).toContain("Details/setup: /system1 status.");
    const wrappedLines = title.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 42)), 0);
    expect(wrappedLines).toBeLessThanOrEqual(7);
    expect(h.registry.classify).not.toHaveBeenCalled();
  });
  it("holds blocked for the full picker/confirmation lifetime and emits a change after saving", async () => {
    const h = await harness(); await h.start();
    h.select.mockImplementation(async (question, options) => {
      expect(h.events.emitted.filter((event) => event.channel === "herdr:blocked").map((event) => event.data)).toEqual([{ active: true, label: "System 1" }]);
      if (question === BILLING_CONFIRMATION) { expect(options).toEqual(["Use included credits", "Keep current backend"]); return "Use included credits"; }
      expect(question).toContain("typesafe/jev-latest");
      expect(question).toContain("Feature-off settings still apply.");
      expect(question).toContain("configured");
      expect(options).toEqual(["Jev", "OpenAI Decisions (Pro credits)"]);
      return "OpenAI Decisions (Pro credits)";
    });
    await h.command("");
    expect(readSystem1Setting()).toMatchObject({ ok: true, backend: "openai-decisions" });
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(1);
    expect(h.events.emitted.filter((event) => event.channel === "herdr:blocked").map((event) => event.data)).toEqual([{ active: true, label: "System 1" }, { active: false }]);
    expect(h.registry.classify).not.toHaveBeenCalled();
    expect(h.registry.getApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("uses exactly the same confirmation for the direct openai command", async () => {
    const h = await harness(); await h.start();
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command("openai");
    expect(h.select).toHaveBeenCalledExactlyOnceWith(BILLING_CONFIRMATION, ["Use included credits", "Keep current backend"]);
    expect(readSystem1Setting()).toMatchObject({ backend: "openai-decisions" });
  });

  it.each([undefined, "Keep current backend"])("cancelling confirmation (%s) leaves Jev unchanged", async (answer) => {
    const h = await harness(); await h.start(); h.select.mockResolvedValueOnce(answer);
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ backend: "jev" });
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
  });

  it("cancels the picker without writes and releases its blocked hold on UI errors", async () => {
    const h = await harness(); await h.start();
    await h.command("");
    expect(readSystem1Setting()).toMatchObject({ backend: "jev" });
    h.select.mockRejectedValueOnce(new Error("dialog failed"));
    await expect(h.command("")).rejects.toThrow("dialog failed");
    expect(h.events.emitted.filter((event) => event.channel === "herdr:blocked").at(-1)?.data).toEqual({ active: false });
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ backend: "openai-decisions" });
  });

  it.each([{ decisions: false }, { credentials: false }])("does not activate an unavailable target: %j", async (options) => {
    const h = await harness(options); await h.start();
    h.select.mockResolvedValueOnce("OpenAI Decisions (Pro credits)"); await h.command("");
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain("OpenAI Decisions unavailable");
    expect(readSystem1Setting()).toMatchObject({ backend: "jev" });
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("refuses headless Decisions activation but allows direct /system1 jev", async () => {
    const h = await harness({ ui: false }); await h.start();
    await h.command("openai");
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain("interactive billing confirmation");
    expect(h.select).not.toHaveBeenCalled();
    expect(readSystem1Setting()).toMatchObject({ backend: "jev" });
    write("openai-decisions"); await h.command("jev");
    expect(readSystem1Setting()).toMatchObject({ backend: "jev" });
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(1);
    await h.command(""); expect(h.notify.mock.calls.at(-1)?.[0]).toContain("picker requires UI");
  });

  it("rejects a confirmation that lost credentials or changed session/selection", async () => {
    for (const change of ["credentials", "session", "selection"] as const) {
      write("jev");
      const h = await harness(); await h.start();
      h.select.mockImplementationOnce(async () => {
        if (change === "credentials") h.setCredentials(false);
        if (change === "session") h.setSession("other");
        if (change === "selection") writeFileSync(file(), "{broken");
        return "Use included credits";
      });
      await h.command("openai");
      expect(readSystem1Setting()).not.toMatchObject({ backend: "openai-decisions" });
      expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
      await h.close();
    }
  });

  it.each(["blocked", "prompt"])("does not save after another dialog takes ownership (%s)", async (ownership) => {
    const h = await harness(); await h.start();
    h.select.mockImplementationOnce(async () => {
      if (ownership === "blocked") h.events.emit("herdr:blocked", { active: true });
      else await h.fire("ui_prompt_start");
      return "Use included credits";
    });
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ backend: "jev" });
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
    if (ownership === "blocked") h.events.emit("herdr:blocked", { active: false });
    else await h.fire("ui_prompt_end");
    h.select.mockResolvedValueOnce("Use included credits");
    await h.command("openai");
    expect(readSystem1Setting()).toMatchObject({ backend: "openai-decisions" });
  });

  it("does not repair a malformed setting or emit success after a failed write", async () => {
    writeFileSync(file(), "{broken");
    const h = await harness(); await h.start(); await h.command("jev");
    expect(readFileSync(file(), "utf8")).toBe("{broken");
    expect(h.notify.mock.calls.at(-1)?.[1]).toBe("error");
    expect(h.events.emitted.filter((event) => event.channel === SYSTEM1_CHANGED)).toHaveLength(0);
  });
});

describe("footer ownership and watcher", () => {
  it("opens the native picker through the same action without prompts/editor replacement", async () => {
    const h = await harness(); await h.start();
    const action = queryFooterActions(h.events)["system1.open"]!;
    expect(action.key).toBe("/system1");
    await action.run();
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select.mock.calls[0][1]).toEqual(["Jev", "OpenAI Decisions (Pro credits)"]);
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
    await vi.waitFor(() => expect(querySystem1State(h.events)).toMatchObject({ backend: "openai-decisions", availability: "configured" }));
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
    expect(querySystem1State(h.events)).toMatchObject({ backend: "jev" });
    h.events.emit(SYSTEM1_CHANGED, {}); await flush();
    expect(querySystem1State(h.events)).toMatchObject({ backend: "openai-decisions" });
  });
});

describe("manual typed judgment", () => {
  it.each(["jev", "openai-decisions"])("reports real %s provenance, typed data, latency and actual tool usage", async (backend) => {
    write(backend);
    const h = await harness(); await h.start();
    const signal = new AbortController().signal;
    const result = await h.tool.execute("one", { state: { evidence: "do not execute actions" }, questions }, signal, undefined, h.ctx);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, backend, answers, usage: reportedUsage, latencyMs: expect.any(Number), selectionKey: expect.any(String) });
    expect(result.structuredContent).toMatchObject(backend === "jev" ? { provider: "typesafe", model: "jev-latest" } : { provider: "system1-openai", model: "gpt-6-luna" });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(Value.Check(h.tool.outputSchema, result.structuredContent)).toBe(true);
    expect(result.usage).toEqual(reportedUsage);
    expect(h.registry.classify).toHaveBeenCalledTimes(1);
    expect(h.registry.classify.mock.calls[0][2]).toMatchObject({ timeoutMs: expect.any(Number), retries: 0, signal: expect.any(AbortSignal) });
    expect((h.registry.classify.mock.calls[0][2] as any).timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it("marks failures as errors while retaining structured data and reported usage, without fallback", async () => {
    write("openai-decisions"); const h = await harness(); await h.start();
    h.registry.classify.mockResolvedValueOnce({ stopReason: "error", model: "gpt-6-luna", answers: {}, usage: reportedUsage, errorMessage: "insufficient_quota" } as never);
    const result = await h.tool.execute("one", { state: {}, questions }, undefined, undefined, h.ctx);
    expect(result.isError).toBe(true);
    expect(Value.Check(h.tool.outputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, reason: expect.stringMatching(/quota|credit/u), usage: reportedUsage });
    expect(result.usage).toEqual(reportedUsage);
    expect(h.registry.classify).toHaveBeenCalledTimes(1);
    expect(h.registry.findOfType.mock.calls.every((call) => call[1] === "system1-openai")).toBe(true);
  });

  it("does not infer on an empty question set or unavailable target", async () => {
    write("openai-decisions"); const h = await harness({ decisions: false }); await h.start();
    const empty = await h.tool.execute("one", { state: {}, questions: {} }, undefined, undefined, h.ctx);
    expect(empty.isError).toBe(true); expect(empty.structuredContent.reason).toBe("no questions to judge");
    const missing = await h.tool.execute("two", { state: {}, questions }, undefined, undefined, h.ctx);
    expect(missing.isError).toBe(true); expect(missing.structuredContent.reason).toContain("enable pi-system1");
    expect(h.registry.classify).not.toHaveBeenCalled();
  });

  it("can use the exported picker directly without a lifecycle context", async () => {
    const h = await harness();
    await openSystem1Picker(h.pi, h.ctx);
    expect(h.select).toHaveBeenCalledTimes(1);
  });
});
