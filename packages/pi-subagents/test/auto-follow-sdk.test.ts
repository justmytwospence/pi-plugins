// SDK regression, not a synthetic lifecycle harness: prompt() drives the real 1.4 agent loop,
// extension runner, nested tools and codemode cancellation. Only provider/subprocess transports
// and terminal UI are local fakes. In particular, isIdle and lifecycle events are never mocked.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { initTheme as initProductionTheme } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession, createCodemodeExtension, createEventBus, DefaultResourceLoader,
  initTheme, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionEvent, type ExtensionContext, type ExtensionFactory, type ExtensionUIContext,
} from "pi-coding-agent-1-4";
import bg from "../../pi-bg/src/index.ts";
import { emptyUsage } from "../src/child.ts";
import subagents from "../src/index.ts";
import { fakeUI } from "./ui-helpers.ts";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

const model: Model<"openai-completions"> = {
  id: "gated", provider: "offline-auto-follow", name: "Offline gated response", api: "openai-completions",
  baseUrl: "http://offline.invalid", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096,
};
const childArgs = { agent: "general", model: `${model.provider}/${model.id}`, thinking: "low", task: "Inspect the offline fixture", label: "Offline worker" };
const toolCall = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const checkpoint = async () => { await nextTurn(); await nextTurn(); };
async function until(label: string, predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    // Real transport/worker-thread progress without advancing pi-bg's controlled 250ms poll.
    await delay(1);
  }
  await checkpoint();
}

class ResponseGate {
  readonly stream = createAssistantMessageEventStream();
  readonly message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(),
  };
  started = false;
  ended = false;
  start() {
    if (this.started) return;
    this.started = true;
    this.stream.push({ type: "start", partial: structuredClone(this.message) });
  }
  delta(kind: "text" | "thinking", text: string) {
    this.start();
    const contentIndex = this.message.content.length;
    this.message.content.push(kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text });
    this.stream.push({ type: `${kind}_start`, contentIndex, partial: structuredClone(this.message) });
    this.stream.push({ type: `${kind}_delta`, contentIndex, delta: text, partial: structuredClone(this.message) });
  }
  finish(calls: ToolCall[] = []) {
    if (this.ended) return;
    this.start();
    this.ended = true;
    this.message.content.push(...calls);
    this.message.stopReason = calls.length ? "toolUse" : "stop";
    this.stream.push({ type: "done", reason: this.message.stopReason, message: structuredClone(this.message) });
    this.stream.end();
  }
  abort() {
    if (this.ended) return;
    this.ended = true;
    this.stream.push({ type: "error", reason: "aborted", error: { ...this.message, stopReason: "aborted" } });
    this.stream.end();
  }
}

/** Real Child RPC parsing and lifecycle, but no process is launched. */
function rpcTransport() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    kill: () => { close(); return true; },
  });
  const commands: Array<Record<string, unknown>> = [];
  const send = (event: Record<string, unknown>) => proc.stdout.write(`${JSON.stringify(event)}\n`);
  function close() {
    if (proc.exitCode !== null) return;
    proc.exitCode = 0;
    proc.emit("close", 0);
  }
  proc.stdin.on("data", (data: Buffer) => {
    const command = JSON.parse(data.toString()) as Record<string, unknown>;
    commands.push(command);
    // Child installs the correlation id after spawn returns, as with an actual RPC peer.
    if (command.type === "get_state") queueMicrotask(() => send({ type: "response", command: "get_state", id: command.id, success: true, data: {} }));
    if (command.type === "abort") queueMicrotask(() => send({ type: "agent_settled" }));
  });
  proc.stdin.on("finish", close);
  return { proc, commands, finish: () => send({ type: "agent_settled" }) };
}

beforeAll(() => { initProductionTheme("dark"); initTheme("dark", false); });
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const dispose of disposers.splice(0).reverse()) await dispose(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

async function setup() {
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-auto-follow-sdk-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  vi.stubEnv("PI_BG_DIR", path.join(cwd, "bg"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  // Keep immediates real (auto-follow coalesces with them); only production timers are gated.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network is forbidden in the offline SDK fixture"); });
  const children: ReturnType<typeof rpcTransport>[] = [];
  const childDirectories: string[] = [];
  vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
    if (!args.includes("--mode") || !args.includes("rpc")) throw new Error(`Unexpected subprocess: ${_command}`);
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    if (prompt) childDirectories.push(path.dirname(prompt));
    const child = rpcTransport();
    children.push(child);
    return child.proc as unknown as ChildProcess;
  }) as typeof spawn);

  const ui = Object.assign(fakeUI(), { setStatus() {}, setWorkingMessage() {}, setWorkingVisible() {} });
  const events: AgentSessionEvent[] = [];
  const errors: unknown[] = [];
  const holds = new Set<string>();
  const requests: ResponseGate[] = [];
  const startSnapshots: Array<{ event: string; overlays: number }> = [];
  let savedContext!: ExtensionContext;
  const bus = createEventBus();
  bus.on("herdr:waiting", (data) => {
    const hold = data as { id: string; active: boolean };
    if (hold.active) holds.add(hold.id); else holds.delete(hold.id);
  });
  const observer: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => { savedContext = ctx; });
    // Registered after subagents: these snapshots are inside lifecycle dispatch, BEFORE its
    // deferred auto-view check. Main must already own focus on request resumption.
    const snapshot = (event: { type: string }) => { startSnapshots.push({ event: event.type, overlays: ui.overlays.length }); };
    pi.on("before_agent_start", snapshot);
    pi.on("agent_start", snapshot);
    pi.on("turn_start", snapshot);
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, eventBus: bus,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [subagents as unknown as ExtensionFactory, bg as unknown as ExtensionFactory,
      createCodemodeExtension({ models: false }), observer],
    systemPrompt: "Offline regression fixture. Use only the scripted tools.",
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const stream = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
    const response = new ResponseGate();
    requests.push(response);
    options?.signal?.addEventListener("abort", () => response.abort(), { once: true });
    return response.stream;
  };
  modelRuntime.registerNativeProvider({
    id: model.provider, name: "Offline transport", getModels: () => [model],
    auth: { apiKey: { name: "Keyless local fixture", resolve: async () => ({ auth: {}, source: "offline" }) } },
    stream, streamSimple: stream,
  });
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, model, modelRuntime, thinkingLevel: "low", settingsManager,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
    tools: ["subagent", "bg_wait", "codemode"],
  });
  session.subscribe((event) => events.push(event));
  await session.bindExtensions({ uiContext: ui as unknown as ExtensionUIContext, mode: "tui", onError: (error) => errors.push(error) });
  expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["subagent", "bg_wait", "codemode"]));
  expect(savedContext.isIdle()).toBe(true);
  expect(savedContext.isIdle()).toBe(session.isIdle);

  const prompts: Promise<void>[] = [];
  const prompt = (text: string) => { const work = session.prompt(text); prompts.push(work); return work; };
  const request = async (index: number) => {
    await until(`provider request ${index}`, () => requests.length > index);
    expect(savedContext.isIdle()).toBe(false);
    expect(savedContext.isIdle()).toBe(session.isIdle);
    expect(session.isStreaming).toBe(true);
    return requests[index]!;
  };
  const assertMain = () => {
    expect(savedContext.isIdle()).toBe(false);
    expect(savedContext.isIdle()).toBe(session.isIdle);
    expect(ui.overlays).toHaveLength(0);
    expect(ui.tui.getFocusedComponent()).toBe(ui.mainEditor);
  };
  disposers.push(async () => {
    try {
      const abort = session.abort();
      await vi.advanceTimersByTimeAsync(300);
      await abort;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await Promise.allSettled(prompts);
      await checkpoint();
      expect(errors).toEqual([]);
      expect(network).not.toHaveBeenCalled();
      expect(children.every((child) => child.proc.exitCode !== null)).toBe(true);
    } finally {
      session.dispose();
      for (const directory of [cwd, ...childDirectories]) rmSync(directory, { recursive: true, force: true });
    }
  });
  return { session, ui, events, holds, children, requests, startSnapshots, savedContext, prompt, request, assertMain };
}

function assistantStarts(events: AgentSessionEvent[]) {
  return events.filter((event) => event.type === "message_start" && event.message.role === "assistant").length;
}
function toolEnds(events: AgentSessionEvent[], name: string) {
  return events.filter((event) => event.type === "tool_execution_end" && event.toolName === name);
}
async function startBackground(x: Awaited<ReturnType<typeof setup>>) {
  const first = await x.request(0);
  first.finish([toolCall("start-worker", "subagent", { ...childArgs, async: true })]);
  await until("RPC worker prompted", () => x.children[0]?.commands.some((command) => command.type === "prompt") === true);
  // subagent's real async launch grace period, not an artificial tool implementation.
  await vi.advanceTimersByTimeAsync(50);
  return x.request(1);
}

test("an already-auto-open idle worker yields immediately on prompt startup, before latency or streamed thinking/text", async () => {
  const x = await setup();
  const firstPrompt = x.prompt("Delegate, then finish this request.");
  (await startBackground(x)).finish();
  await firstPrompt;
  await until("idle auto-follow", () => x.ui.overlays.length === 1);
  expect(x.savedContext.isIdle()).toBe(true);
  expect(x.savedContext.isIdle()).toBe(x.session.isIdle);
  const starts = assistantStarts(x.events);
  const snapshotOffset = x.startSnapshots.length;

  const resumed = x.prompt("Continue doing main work.");
  const response = await x.request(2);
  expect(response.started).toBe(false);
  expect(assistantStarts(x.events)).toBe(starts);
  expect(x.startSnapshots.slice(snapshotOffset)).toEqual([
    { event: "before_agent_start", overlays: 0 }, { event: "agent_start", overlays: 0 }, { event: "turn_start", overlays: 0 },
  ]);
  x.assertMain();
  for (const kind of ["thinking", "text"] as const) {
    response.delta(kind, `Main ${kind} is still streaming`);
    await until(`${kind} delta`, () => x.events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === `${kind}_delta`));
    await vi.advanceTimersByTimeAsync(1_000);
    await checkpoint();
    x.assertMain();
  }
  response.finish();
  await resumed;
  await until("idle follow reopens only after main finishes", () => x.ui.overlays.length === 1);
  expect(x.children).toHaveLength(1);
});

test("genuine foreground subagent waiting opens while the SDK session is busy and yields on the next request", async () => {
  const x = await setup();
  const work = x.prompt("Wait for a foreground worker.");
  (await x.request(0)).finish([toolCall("foreground", "subagent", childArgs)]);
  await until("foreground auto-follow", () => x.ui.overlays.length === 1);
  expect(x.session.isIdle).toBe(false);
  expect(x.savedContext.isIdle()).toBe(x.session.isIdle);
  expect(x.children).toHaveLength(1);
  x.children[0]!.finish();
  const next = await x.request(1);
  expect(next.started).toBe(false);
  x.assertMain();
  expect(toolEnds(x.events, "subagent")).toHaveLength(1);
  next.finish();
  await work;
});

test("codemode's abandoned real bg_wait cannot steal main during the next provider request, but an awaited wait can", async () => {
  const x = await setup();
  const work = x.prompt("Start a worker, abandon a nested wait, then continue working.");
  const codeResponse = await startBackground(x);
  const started = x.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "start-worker");
  if (started?.role !== "toolResult") throw new Error("Missing real subagent result");
  const id = (started.details as { runs: Array<{ id: string }> }).runs[0]!.id;
  codeResponse.finish([toolCall("abandon-wait", "codemode", { code: `
    tools.bg_wait({ id: ${JSON.stringify(`subagent:${id}`)}, timeout: 60 });
    await tools.subagent(${JSON.stringify({ ...childArgs, task: "Short foreground checkpoint", async: false })});
    tools.bg_wait({ id: ${JSON.stringify(`subagent:${id}`)}, timeout: 60 });
    // A completed tool round trip ensures both waits were dispatched, without awaiting cleanup.
    text(await tools.subagent({ action: "status" }));
  ` })]);
  await until("foreground checkpoint with first nested wait live", () => x.holds.size === 1
    && x.children[1]?.commands.some((command) => command.type === "prompt") === true);
  // Separate the two real pi-bg polling deadlines. Completing the foreground RPC child leaves
  // exactly one active worker by the next request, and one wait will clean up before the other.
  await vi.advanceTimersByTimeAsync(50);
  x.children[1]!.finish();
  const next = await x.request(2);
  expect(x.children.filter((child) => child.proc.exitCode === null)).toHaveLength(1);
  expect(toolEnds(x.events, "codemode")).toHaveLength(1);
  expect(x.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "tool_execution_start", toolName: "bg_wait", parentToolCallId: "abandon-wait" }),
  ]));
  expect(x.holds.size).toBe(2);
  expect(toolEnds(x.events, "bg_wait")).toHaveLength(0);
  expect(next.started).toBe(false);
  expect(assistantStarts(x.events)).toBe(2);
  x.assertMain(); // The old waitingHolds predicate opens here despite the real isIdle() === false.

  for (const kind of ["thinking", "text"] as const) {
    next.delta(kind, `Main ${kind}, while the cancelled nested wait still owns its hold`);
    await until(`${kind} streamed during lingering wait`, () => x.events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === `${kind}_delta`));
    expect(x.holds.size).toBe(2);
    x.assertMain();
  }
  await vi.advanceTimersByTimeAsync(199);
  await checkpoint();
  expect(x.holds.size).toBe(2);
  x.assertMain();
  await vi.advanceTimersByTimeAsync(1);
  await until("first nested bg_wait cancellation cleanup", () => toolEnds(x.events, "bg_wait").length === 1);
  expect(toolEnds(x.events, "bg_wait")[0]).toMatchObject({ parentToolCallId: "abandon-wait" });
  expect(x.holds.size).toBe(1);
  x.assertMain(); // A tool-end must NOT clear the request veto: the other hold is still live.
  await vi.advanceTimersByTimeAsync(50);
  await until("second nested bg_wait cancellation cleanup", () => toolEnds(x.events, "bg_wait").length === 2);
  expect(x.holds.size).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await checkpoint();
  x.assertMain(); // Tool completion is not permission to follow while main is still generating.

  // The same real bg_wait is now awaited by the main tool loop. message_end, not a tool event,
  // ends provider generation, so this legitimate busy-but-waiting state must still auto-open.
  next.finish([toolCall("await-worker", "bg_wait", { id: `subagent:${id}`, timeout: 60 })]);
  await until("genuine bg_wait auto-follow", () => x.ui.overlays.length === 1);
  expect(x.holds.size).toBe(1);
  expect(x.session.isIdle).toBe(false);
  expect(x.savedContext.isIdle()).toBe(x.session.isIdle);
  x.children[0]!.finish();
  const final = await x.request(3);
  expect(final.started).toBe(false);
  expect(x.startSnapshots.at(-1)).toEqual({ event: "turn_start", overlays: 0 });
  x.assertMain();
  final.finish();
  await work;
  expect(x.requests).toHaveLength(4);
});
