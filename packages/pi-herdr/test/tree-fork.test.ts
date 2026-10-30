import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BorderedLoader, initTheme, SessionManager, TreeSelectorComponent, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FORK_BOUNDARY } from "../src/fork-session.ts";
import { FORK_DESTINATIONS, FORK_TITLE, openForkPane, registerTreeFork } from "../src/tree-fork.ts";
import { fakeCall } from "./core/fake.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { Call } from "../src/core/herdr.ts";

type CustomFactory = (tui: unknown, theme: unknown, kb: unknown, done: (id: string | undefined) => void) => TreeSelectorComponent | BorderedLoader;
initTheme("dark", false);

const dirs: string[] = [];
let previousKeybindings: KeybindingsManager;
beforeEach(() => {
  vi.stubEnv("PI_HERDR_SUMMARY", "1");
  previousKeybindings = getKeybindings();
  // Interactive Pi installs application bindings in addition to pi-tui's defaults.
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit tree label" }, "app.tree.filter.all": { defaultKeys: "ctrl+a", description: "All" }, "app.tree.filter.cycleForward": { defaultKeys: "ctrl+f", description: "Cycle" } }));
});
afterEach(() => {
  setKeybindings(previousKeybindings);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const failure = (code: string) => ({ error: { code, message: `fixture ${code}` } });
function transport(handlers: Parameters<typeof fakeCall>[0] = {}) {
  return fakeCall({
    "pane.get": () => ({ result: { pane: { workspace_id: "source-workspace" } } }),
    "pane.layout": () => ({ result: { layout: { panes: [{ pane_id: "self", rect: { width: 200, height: 40 } }] } } }),
    "tab.create": () => ({ result: { root_pane: { pane_id: "new-pane" } } }),
    "pane.split": () => ({ result: { pane: { pane_id: "new-pane" } } }),
    "agent.start": () => ({ result: {} }),
    ...handlers,
  });
}
function paneOptions(fake: ReturnType<typeof transport>) {
  return { call: fake.call, selfPane: "self", isCurrent: () => true, where: "tab" as const, cwd: "/checkout", name: "available-fork", title: "Tree fork navigation", file: "/sessions/fork.jsonl" };
}
function fixture(handlers: Parameters<typeof fakeCall>[0] = {}, width = 120) {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-tree-fork-")); dirs.push(dir);
  const manager = SessionManager.create("/checkout", dir);
  const question = manager.appendMessage({ role: "user", content: "Searchable question", timestamp: 1 });
  const tool = manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Hidden tool request" }, { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "internal" } }],
    api: "anthropic-messages", provider: "anthropic", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 1,
  });
  const toolResult = manager.appendMessage({ role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "Hidden tool result" }], isError: false, timestamp: 1 });
  const tip = manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Current answer" }], api: "anthropic-messages", provider: "anthropic", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2,
  });
  const hiddenLeaf = manager.appendCustomEntry("hidden-tail", { text: "Hidden metadata" });
  const fake = transport(handlers);
  const registry = {
    find: vi.fn(() => ({ provider: "fixture", id: "small-model" })),
    hasConfiguredAuth: vi.fn(() => true),
    complete: vi.fn(async (_model: unknown, _context: unknown, _options?: { signal?: AbortSignal }) => ({ stopReason: "stop", content: [{ type: "text", text: "Tree fork navigation" }] })),
  };
  const screens = {
    picker: vi.fn((_: TreeSelectorComponent, done: (id: string | undefined) => void) => done(tip)),
    loader: vi.fn((_loader: BorderedLoader) => {}),
    resolved: vi.fn((_screen: "picker" | "loader", _value: string | undefined) => {}),
  };
  const custom = async (factory: unknown): Promise<string | undefined> => new Promise((done) => {
    const component = (factory as CustomFactory)({ terminal: { rows: 32, columns: width }, requestRender: () => {} }, theme, undefined, (value) => {
      screens.resolved(component instanceof TreeSelectorComponent ? "picker" : "loader", value);
      done(value);
    });
    if (component instanceof TreeSelectorComponent) screens.picker(component, done);
    else {
      expect(component).toBeInstanceOf(BorderedLoader);
      screens.loader(component as BorderedLoader);
    }
  });
  const forbidden = Object.fromEntries(["abort", "fork", "navigateTree", "sendMessage", "sendUserMessage", "appendEntry", "setEditorText", "setEditorComponent"].map((name) => [name, vi.fn(() => { throw new Error(`Forbidden source action: ${name}`); })]));
  const ui = {
    custom: vi.fn(custom),
    select: vi.fn(async (_title: string, _items: string[]): Promise<string | undefined> => FORK_DESTINATIONS[0]),
    notify: vi.fn(), ...forbidden,
  };
  const ctx = { mode: "tui", hasUI: true, isIdle: vi.fn(() => true), cwd: "/checkout", model: { provider: "anthropic", id: "current-model" }, sessionManager: manager, modelRegistry: registry, ui, ...forbidden };
  const pi = { registerCommand: vi.fn(), getThinkingLevel: vi.fn(() => "high"), events: { emit: vi.fn() }, ...forbidden };
  let generation = 1;
  const uniqueName = vi.fn(async (_wanted: string) => "available-fork");
  const deps = { call: fake.call, selfPane: "self", uniqueName, runtimeCurrent: () => { const captured = generation; return () => generation === captured; } };
  registerTreeFork(pi as unknown as ExtensionAPI, deps);
  const commands = new Map(pi.registerCommand.mock.calls as unknown as [string, { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<unknown> }][]);
  const command = ["tree-fork", commands.get("tree-fork")!] as const;
  const run = (args = "") => command[1].handler(args, ctx as unknown as ExtensionCommandContext);
  const runHere = (args = "") => commands.get("fork-here")!.handler(args, ctx as unknown as ExtensionCommandContext);
  const snapshot = () => ({ bytes: readFileSync(manager.getSessionFile()!), entries: structuredClone(manager.getEntries()), leaf: manager.getLeafId(), id: manager.getSessionId(), file: manager.getSessionFile() });
  const before = snapshot();
  const assertNoSourceActions = () => { for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled(); };
  const assertUntouched = () => { expect(snapshot()).toEqual(before); assertNoSourceActions(); };
  const holds = () => pi.events.emit.mock.calls.map((args) => args as unknown as [string, { active: boolean; id: string; label?: string }]);
  const assertReleased = () => {
    const events = holds(); expect(events.length % 2).toBe(0);
    const starts = events.filter(([, e]) => e.active);
    expect(new Set(starts.map(([, e]) => e.id)).size).toBe(starts.length);
    for (const [event, hold] of starts) {
      expect(event).toBe("herdr:blocked");
      const direct = hold.id.startsWith("fork-here:");
      expect(hold).toMatchObject({ label: direct ? "Fork current session" : "Fork session tree", id: expect.stringMatching(direct ? /^fork-here:/ : /^tree-fork:/) });
      expect(events.filter(([, e]) => !e.active && e.id === hold.id)).toHaveLength(1);
    }
  };
  return { dir, manager, question, tip, tool, toolResult, hiddenLeaf, registry, screens, custom, fake, ctx, ui, pi, deps, command, run, runHere, commands, uniqueName, snapshot, assertUntouched, assertNoSourceActions, holds, assertReleased, stale: () => { generation++; } };
}

test("registers both independent fork commands and tolerates registration-less hosts", () => {
  const f = fixture();
  expect(f.pi.registerCommand).toHaveBeenCalledTimes(2);
  expect([...f.commands.keys()]).toEqual(["tree-fork", "fork-here"]);
  expect(f.command[0]).toBe("tree-fork");
  expect(f.command[1].description).toBe("Fork a session-tree point into a new Herdr tab or split");
  expect(() => registerTreeFork({} as ExtensionAPI, f.deps)).not.toThrow();
});

test.each(["rpc", "print", "no-ui", "args", "unsaved", "empty"])("guards %s before opening either screen or creating files", async (guard) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (guard === "rpc" || guard === "print") f.ctx.mode = guard;
  if (guard === "no-ui") f.ctx.hasUI = false;
  if (guard === "unsaved") vi.spyOn(f.manager, "getSessionFile").mockReturnValue(undefined);
  if (guard === "empty") vi.spyOn(f.manager, "getTree").mockReturnValue([]);
  await f.run(guard === "args" ? " unexpected " : "");
  const expected = guard === "args" ? "Usage: /tree-fork" : guard === "unsaved" ? "Save this session before using /tree-fork." : guard === "empty" ? "No user prompts or completed answers to fork from." : "/tree-fork requires interactive Pi in Herdr.";
  expect(f.ui.notify).toHaveBeenCalledWith(expected, "warning");
  expect(f.ui.custom).not.toHaveBeenCalled(); expect(f.ui.select).not.toHaveBeenCalled();
  expect(f.fake.log).toEqual([]); expect(f.uniqueName).not.toHaveBeenCalled(); expect(readdirSync(f.dir)).toEqual(files);
  expect(f.holds()).toEqual([]);
  vi.restoreAllMocks(); f.assertUntouched();
  f.ctx.mode = "tui"; f.ctx.hasUI = true;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(1); f.assertReleased();
});

test.each(["missing", "empty"])("rejects a %s persisted file before showing UI", async (state) => {
  const f = fixture(); const file = join(f.dir, `${state}.jsonl`);
  if (state === "empty") writeFileSync(file, "");
  vi.spyOn(f.manager, "getSessionFile").mockReturnValue(file);
  const files = readdirSync(f.dir);
  await f.run();
  expect(f.ui.notify).toHaveBeenCalledWith("Save this session before using /tree-fork.", "warning");
  expect(f.ui.custom).not.toHaveBeenCalled(); expect(f.fake.log).toEqual([]); expect(f.holds()).toEqual([]);
  expect(readdirSync(f.dir)).toEqual(files);
  vi.restoreAllMocks(); f.assertUntouched();
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(1); f.assertReleased();
});

test.each(["tree", "destination"])("cancelling %s has no file/pane effects and releases holds and concurrency", async (screen) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (screen === "tree") f.ui.custom.mockResolvedValue(undefined); else f.ui.select.mockResolvedValue(undefined);
  await f.run(); await f.run();
  expect(f.ui.custom).toHaveBeenCalledTimes(2);
  expect(f.ui.select).toHaveBeenCalledTimes(screen === "tree" ? 0 : 2);
  expect(f.fake.log).toEqual([]); expect(f.uniqueName).not.toHaveBeenCalled(); expect(readdirSync(f.dir)).toEqual(files);
  f.assertReleased(); f.assertUntouched();
});

test.each(FORK_DESTINATIONS)("opens %s at the inclusive current tip, idle, with captured model/thinking and released hold", async (destination) => {
  const f = fixture(); f.ui.select.mockResolvedValue(destination);
  const start = vi.fn(f.fake.call);
  f.deps.call = start as Call;
  // Registration captures the dependency object, so the wrapper also observes the RPC timeout.
  start.mockImplementation(async (method, params, timeout) => {
    if (method === "agent.start") expect(f.holds().map(([, h]) => h.active)).toEqual([true, false]);
    return f.fake.call(method, params, timeout);
  });
  await f.run("  ");
  expect(f.ui.select).toHaveBeenCalledWith(FORK_TITLE, ["New tab", "Split beside this pane"]);
  expect(f.uniqueName).toHaveBeenCalledWith("tree-fork-navigation");
  const call = f.fake.of("agent.start")[0]; const file = call.params.args.at(-1) as string;
  expect(call.params).toEqual({ name: "available-fork", kind: "pi", pane_id: "new-pane", timeout_ms: 90_000, args: ["--name", "Tree fork navigation", "--model", "anthropic/current-model", "--thinking", "high", "--session", file] });
  expect(start).toHaveBeenCalledWith("agent.start", call.params, 95_000);
  const fork = SessionManager.open(file);
  expect(fork.getBranch().slice(0, -1)).toEqual(f.manager.getBranch(f.tip));
  expect(fork.getBranch().at(-1)).toMatchObject({ customType: FORK_BOUNDARY, parentId: f.tip });
  expect(f.fake.log.map((c) => c.method)).toEqual(destination === FORK_DESTINATIONS[0] ? ["pane.get", "tab.create", "agent.start"] : ["pane.get", "pane.layout", "pane.split", "agent.start"]);
  expect(f.ui.notify).toHaveBeenCalledWith("Fork opened: Tree fork navigation (available-fork, new-pane). Original session unchanged.", "info");
  f.assertReleased(); f.assertUntouched();
  const customCalls = f.ui.custom.mock.calls.length;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(customCalls + 1);
});

test("tab launcher resolves the source workspace, supplies cwd/focus, and omits absent model/thinking", async () => {
  const fake = transport(); await expect(openForkPane(paneOptions(fake))).resolves.toBe("new-pane");
  expect(fake.log).toEqual([
    { method: "pane.get", params: { pane_id: "self" } },
    { method: "tab.create", params: { workspace_id: "source-workspace", cwd: "/checkout", label: "Tree fork navigation", focus: false } },
    { method: "agent.start", params: { name: "available-fork", kind: "pi", pane_id: "new-pane", timeout_ms: 90_000, args: ["--name", "Tree fork navigation", "--session", "/sessions/fork.jsonl"] } },
  ]);
});

test.each([
  { rect: { width: 200, height: 40 }, direction: "right" },
  { rect: { width: 120, height: 30 }, direction: "down" },
  { rect: { width: 200, height: 100 }, direction: "down" },
  { rect: undefined, direction: "right" },
])("split uses the source pane geometry: $direction ($rect)", async ({ rect, direction }) => {
  const fake = transport({ "pane.layout": () => ({ result: { layout: { panes: [{ pane_id: "other", rect: { width: 400, height: 20 } }, { pane_id: "self", rect }] } } }) });
  await openForkPane({ ...paneOptions(fake), where: "split" });
  expect(fake.of("pane.layout")[0].params).toEqual({ pane_id: "self" });
  expect(fake.of("pane.split")[0].params).toEqual({ target_pane_id: "self", direction, cwd: "/checkout", focus: false });
  expect(fake.of("tab.create")).toEqual([]);
});

test.each(["pane.get", "pane.layout", "tab.create", "pane.split"])("requires valid replies/IDs from %s without starting or closing the source", async (method) => {
  const fake = transport({ [method]: () => failure("invalid_request") });
  await expect(openForkPane({ ...paneOptions(fake), where: method === "pane.layout" || method === "pane.split" ? "split" : "tab" })).rejects.toThrow(/Session file retained: \/sessions\/fork.jsonl/);
  expect(fake.of("agent.start")).toEqual([]); expect(fake.of("pane.close")).toEqual([]);
});

test("retries only explicit busy replies after 500ms, then starts once", async () => {
  vi.useFakeTimers(); let attempts = 0;
  const fake = transport({ "agent.start": () => ++attempts < 3 ? failure("agent_pane_busy") : { result: {} } });
  const result = openForkPane(paneOptions(fake));
  await vi.advanceTimersByTimeAsync(0); expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(499); expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1); expect(attempts).toBe(2);
  await vi.advanceTimersByTimeAsync(500); await expect(result).resolves.toBe("new-pane");
  expect(attempts).toBe(3); expect(fake.of("tab.create")).toHaveLength(1); expect(fake.of("pane.close")).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});

test("busy retry is bounded to 30 retries and closes only the new pane on exhaustion", async () => {
  vi.useFakeTimers(); const fake = transport({ "agent.start": () => failure("agent_pane_busy") });
  const result = expect(openForkPane(paneOptions(fake))).rejects.toThrow(/agent_pane_busy.*Session file retained/);
  await vi.runAllTimersAsync(); await result;
  expect(fake.of("agent.start")).toHaveLength(31); expect(fake.of("pane.close")).toEqual([{ method: "pane.close", params: { pane_id: "new-pane" } }]); expect(vi.getTimerCount()).toBe(0);
});

test.each(["agent_not_ready", "timeout", "socket", "closed", "parse", "invalid_request", "agent_start_failed"])("handles %s without retry, preserves recovery file and releases command guard", async (code) => {
  const f = fixture({ "agent.start": () => failure(code) }); await f.run();
  expect(f.fake.of("agent.start")).toHaveLength(1);
  const preserve = ["agent_not_ready", "timeout", "socket", "closed", "parse"].includes(code);
  expect(f.fake.of("pane.close")).toEqual(preserve ? [] : [{ method: "pane.close", params: { pane_id: "new-pane" } }]);
  const file = f.fake.of("agent.start")[0].params.args.at(-1) as string;
  expect(readFileSync(file, "utf8")).toContain(FORK_BOUNDARY);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`Session file retained: ${file}. Fork pane: new-pane`), "error");
  if (code === "agent_not_ready") expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("waiting on a startup dialog; answer it in that pane"), "error");
  f.assertReleased(); f.assertUntouched();
  const customCalls = f.ui.custom.mock.calls.length;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(customCalls + 1);
});

test.each(["tree", "destination", "name"])("runtime replacement during %s stops before file creation and releases holds", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (stage === "tree") f.ui.custom.mockImplementation(async () => { f.stale(); return f.tip; });
  if (stage === "destination") f.ui.select.mockImplementation(async () => { f.stale(); return FORK_DESTINATIONS[0]; });
  if (stage === "name") f.uniqueName.mockImplementation(async () => { f.stale(); return "available-fork"; });
  await f.run(); expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("switched or reloaded"), "error");
  f.assertReleased(); f.assertUntouched();
  const customCalls = f.ui.custom.mock.calls.length;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(customCalls + 1);
});

test.each(["getSessionId", "getSessionFile"] as const)("source identity change (%s) cancels even when runtime generation is unchanged", async (method) => {
  const f = fixture(); f.ui.select.mockImplementation(async () => { vi.spyOn(f.manager, method).mockReturnValue("replacement"); return FORK_DESTINATIONS[0]; });
  await f.run(); expect(f.fake.log).toEqual([]); f.assertReleased();
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("switched or reloaded"), "error");
  vi.restoreAllMocks(); f.assertUntouched();
});

test("append-only progress during selection is allowed without changing the captured selected point/model", async () => {
  const f = fixture();
  f.ui.select.mockImplementation(async () => {
    f.manager.appendMessage({ role: "user", content: "Later progress", timestamp: 3 });
    f.ctx.model.id = "later-model"; f.pi.getThinkingLevel.mockReturnValue("low");
    return FORK_DESTINATIONS[0];
  });
  await f.run();
  const args = f.fake.of("agent.start")[0].params.args as string[];
  expect(args).toContain("anthropic/current-model"); expect(args).toContain("high");
  const fork = SessionManager.open(args.at(-1)!);
  expect(fork.getBranch().at(-1)).toMatchObject({ parentId: f.tip });
  expect(fork.getBranch().some((e) => e.id === f.manager.getLeafId())).toBe(false); f.assertReleased();
});

test.each(["pane.get", "tab.create", "agent.start"])("stale runtime after %s never advances startup or closes a possibly started agent", async (method) => {
  let current = true; const fake = transport();
  const call = vi.fn(fake.call).mockImplementation(async (name, params, timeout) => { const reply = await fake.call(name, params, timeout); if (name === method) current = false; return reply; });
  await expect(openForkPane({ ...paneOptions(fake), call: call as Call, isCurrent: () => current })).rejects.toThrow(/switched or reloaded.*Session file retained/);
  expect(fake.of("agent.start")).toHaveLength(method === "agent.start" ? 1 : 0);
  expect(fake.of("pane.close")).toHaveLength(method === "tab.create" ? 1 : 0);
});

test("command runtime replacement during an in-flight start preserves the launched pane and recovery file", async () => {
  const f = fixture();
  f.deps.call = (async (method, params, timeout) => {
    const reply = await f.fake.call(method, params, timeout);
    if (method === "agent.start") f.stale();
    return reply;
  }) as Call;
  await f.run();
  expect(f.fake.of("agent.start")).toHaveLength(1); expect(f.fake.of("pane.close")).toEqual([]);
  const file = f.fake.of("agent.start")[0].params.args.at(-1) as string;
  expect(readFileSync(file, "utf8")).toContain(FORK_BOUNDARY);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`Session file retained: ${file}`), "error");
  expect(f.ui.notify.mock.calls.some(([message]) => String(message).startsWith("Fork opened"))).toBe(false);
  f.assertReleased(); f.assertUntouched();
  const customCalls = f.ui.custom.mock.calls.length;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(customCalls + 1);
});

test("a thrown transport failure preserves the possibly running pane without retries", async () => {
  const fake = transport({ "agent.start": () => { throw new Error("connection disappeared"); } });
  await expect(openForkPane(paneOptions(fake))).rejects.toThrow(/connection disappeared.*Session file retained.*Fork pane: new-pane/);
  expect(fake.of("agent.start")).toHaveLength(1); expect(fake.of("pane.close")).toEqual([]);
});

test("stale runtime during busy wait closes the unstarted pane and does not retry", async () => {
  vi.useFakeTimers(); let current = true;
  const fake = transport({ "agent.start": () => failure("agent_pane_busy") });
  const result = expect(openForkPane({ ...paneOptions(fake), isCurrent: () => current })).rejects.toThrow(/switched or reloaded/);
  await vi.advanceTimersByTimeAsync(0); current = false; await vi.runAllTimersAsync(); await result;
  expect(fake.of("agent.start")).toHaveLength(1); expect(fake.of("pane.close")[0].params).toEqual({ pane_id: "new-pane" });
});

test.each(["tree", "destination", "startup"])("rejects concurrent commands during %s and releases the guard afterwards", async (stage) => {
  const wait = deferred<string | undefined>(); const started = deferred<void>();
  const f = fixture(stage === "startup" ? { "agent.start": async () => { started.resolve(); await wait.promise; return { result: {} }; } } : {});
  if (stage === "tree") f.ui.custom.mockImplementationOnce(() => wait.promise);
  if (stage === "destination") f.ui.select.mockImplementationOnce(() => wait.promise);
  const first = f.run();
  if (stage === "startup") await started.promise; else await Promise.resolve();
  await f.run(); expect(f.ui.notify).toHaveBeenCalledWith("/tree-fork is already open.", "warning"); expect(f.ui.custom).toHaveBeenCalledTimes(stage === "startup" ? 2 : 1);
  wait.resolve(stage === "tree" ? f.tip : FORK_DESTINATIONS[0]); await first;
  const customCalls = f.ui.custom.mock.calls.length;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(customCalls + 1); f.assertReleased(); f.assertUntouched();
});

test.each(["tree", "destination", "name", "unpersisted"])("errors in %s release holds/concurrency without pane effects", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (stage === "tree") f.ui.custom.mockRejectedValueOnce(new Error("picker failed"));
  if (stage === "destination") f.ui.select.mockRejectedValueOnce(new Error("select failed"));
  if (stage === "name") f.uniqueName.mockRejectedValueOnce(new Error("name failed"));
  if (stage === "unpersisted") f.ui.custom.mockResolvedValueOnce("not-persisted");
  await f.run(); expect(f.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  expect(readdirSync(f.dir)).toEqual(files); expect(f.fake.log).toEqual([]); f.assertReleased(); f.assertUntouched();
  const customCalls = f.ui.custom.mock.calls.length;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(customCalls + 1);
});

test.each([46, 120])("native projected picker at %i columns maps hidden tip, filters/searches without revealing internals and disables labels", async (width) => {
  const f = fixture({}, width);
  f.screens.picker.mockImplementation((picker) => {
    expect(picker).toBeInstanceOf(TreeSelectorComponent);
    picker.focused = true; expect(picker.focused).toBe(true);
    expect(picker.getTreeList().getSelectedNode()?.entry.id).toBe(f.tip);
    const render = () => { const lines = picker.render(width); expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true); return lines.join("\n"); };
    expect(render()).toContain("Session Tree"); expect(render()).toContain("Current answer");
    expect(picker.getTreeList().onLabelEdit).toBeUndefined();
    const control = new TreeSelectorComponent(f.manager.getTree(), f.tip, 32, () => {}, () => {});
    const editLabel = vi.fn(); control.getTreeList().onLabelEdit = editLabel;
    control.handleInput("\u001b[108;2u"); expect(editLabel).toHaveBeenCalledTimes(1);
    picker.handleInput("\u001b[108;2u");
    expect(render()).not.toContain("Label (empty to remove)");
    picker.handleInput("\u0001"); // Native All filter must only see projected records.
    for (let i = 0; i < 6; i++) {
      expect(render()).not.toMatch(/Hidden tool|Hidden metadata/);
      picker.handleInput("\u0006");
    }
    picker.handleInput("\u0001");
    picker.handleInput("Searchable");
    expect(picker.getTreeList().getSearchQuery()).toBe("Searchable");
    expect(picker.getTreeList().getSelectedNode()?.entry.id).toBe(f.question);
    expect(render()).toContain("Searchable");
    picker.handleInput("\r");
  });
  await f.run();
  expect(f.ui.notify.mock.calls.filter(([, level]) => level === "error")).toEqual([]);
  expect(f.uniqueName).toHaveBeenCalledWith("tree-fork-navigation");
  expect(f.screens.loader).toHaveBeenCalledTimes(1); f.assertReleased(); f.assertUntouched();
});

test.each([46, 120])("native picker at %i columns clears search before escape cancels; snapshot is deep-cloned", async (width) => {
  const f = fixture({}, width); const files = readdirSync(f.dir);
  f.screens.picker.mockImplementation((picker) => {
    picker.focused = true;
    const selected = picker.getTreeList().getSelectedNode()!;
    expect(selected.entry).not.toBe(f.manager.getEntry(f.tip));
    expect(selected.entry.parentId).toBe(f.question); // Hidden original tool ancestry is display-only.
    expect(f.manager.getEntry(f.tip)?.parentId).toBe(f.toolResult);
    if (selected.entry.type === "message" && selected.entry.message.role === "assistant") {
      const content = selected.entry.message.content[0]; if (content.type === "text") content.text = "Snapshot only";
    }
    picker.getTreeList().updateNodeLabel(f.tip, "Snapshot label");
    picker.handleInput("Searchable"); picker.handleInput("\u001b");
    expect(picker.getTreeList().getSearchQuery()).toBe(""); expect(f.ui.select).not.toHaveBeenCalled();
    expect(picker.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    picker.focused = false; expect(picker.focused).toBe(false); picker.handleInput("\u001b");
  });
  await f.run(); expect(f.ui.notify.mock.calls.filter(([, level]) => level === "error")).toEqual([]);
  expect(f.ui.select).not.toHaveBeenCalled(); expect(f.registry.complete).not.toHaveBeenCalled();
  expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
});

test.each([46, 120])("actual loader at %i columns completes once and disposes with hold released before startup", async (width) => {
  vi.useFakeTimers();
  const f = fixture({}, width);
  const result = deferred<{ stopReason: string; content: { type: string; text: string }[] }>();
  f.registry.complete.mockReturnValue(result.promise);
  const dispose = vi.spyOn(BorderedLoader.prototype, "dispose");
  f.screens.loader.mockImplementation((loader) => {
    const lines = loader.render(width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).toContain("Naming fork…");
    expect(lines.join("\n")).toContain("cancel");
    expect(f.holds().map(([, hold]) => hold.active)).toEqual([true]);
    expect(f.fake.log).toEqual([]);
  });
  f.deps.call = (async (method, params, timeout) => {
    expect(f.holds().map(([, hold]) => hold.active)).toEqual([true, false]);
    return f.fake.call(method, params, timeout);
  }) as Call;
  const run = f.run(); await vi.advanceTimersByTimeAsync(0);
  expect(f.registry.complete).toHaveBeenCalledTimes(1);
  result.resolve({ stopReason: "stop", content: [{ type: "text", text: "Tree fork navigation" }] });
  await run;
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(f.screens.resolved.mock.calls.filter(([screen]) => screen === "loader")).toEqual([["loader", "Tree fork navigation"]]);
  expect(vi.getTimerCount()).toBe(0); f.assertReleased(); f.assertUntouched();
});

test.each([46, 120])("actual loader at %i columns cancels once, cleans up and ignores late results", async (width) => {
  vi.useFakeTimers();
  const f = fixture({}, width); const files = readdirSync(f.dir);
  const result = deferred<{ stopReason: string; content: { type: string; text: string }[] }>();
  f.registry.complete.mockReturnValue(result.promise);
  const dispose = vi.spyOn(BorderedLoader.prototype, "dispose");
  f.screens.loader.mockImplementation((loader) => {
    expect(loader.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(f.holds().map(([, hold]) => hold.active)).toEqual([true]);
    loader.handleInput("\u001b"); loader.handleInput("\u001b");
    expect(loader.signal.aborted).toBe(true);
  });
  await f.run();
  expect(f.registry.complete.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(f.screens.resolved.mock.calls.filter(([screen]) => screen === "loader")).toEqual([["loader", undefined]]);
  expect(vi.getTimerCount()).toBe(0);
  const notifications = f.ui.notify.mock.calls.slice();
  result.resolve({ stopReason: "stop", content: [{ type: "text", text: "Late title must not spawn" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.ui.notify.mock.calls).toEqual(notifications);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(f.uniqueName).not.toHaveBeenCalled(); expect(f.fake.log).toEqual([]);
  expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
  f.screens.picker.mockImplementation((_picker, done) => done(undefined));
  await f.run(); expect(f.screens.picker).toHaveBeenCalledTimes(2);
});

test.each(["pending", "completed"])("runtime replacement during naming (%s) prevents files and panes", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  const dispose = vi.spyOn(BorderedLoader.prototype, "dispose");
  if (stage === "pending") {
    f.registry.complete.mockImplementation(async () => {
      f.stale();
      return { stopReason: "stop", content: [{ type: "text", text: "Tree fork navigation" }] };
    });
  } else {
    f.ui.custom.mockImplementation((factory) => {
      const value = f.custom(factory);
      return f.ui.custom.mock.calls.length === 2 ? value.then((title) => { f.stale(); return title; }) : value;
    });
  }
  await f.run();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("switched or reloaded"), "error");
  expect(f.uniqueName).not.toHaveBeenCalled(); expect(f.fake.log).toEqual([]);
  expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
});

test.each(["unavailable", "disabled"])("no-model fallback (%s) preserves natural source title", async (kind) => {
  const f = fixture(); f.manager.appendSessionInfo("OAuth callback retries");
  if (kind === "disabled") vi.stubEnv("PI_HERDR_SUMMARY", "0");
  else f.registry.hasConfiguredAuth.mockReturnValue(false);
  const before = f.snapshot(); await f.run();
  expect(f.registry.complete).not.toHaveBeenCalled();
  expect(f.uniqueName).toHaveBeenCalledWith("oauth-callback-retries");
  expect(f.fake.of("tab.create")[0].params.label).toBe("OAuth callback retries");
  expect(f.fake.of("agent.start")[0].params.args.slice(0, 2)).toEqual(["--name", "OAuth callback retries"]);
  expect(f.snapshot()).toEqual(before); f.assertReleased();
});

test.each(FORK_DESTINATIONS)("natural title stays separate from unique collision slug in %s", async (destination) => {
  const f = fixture(); f.ui.select.mockResolvedValue(destination);
  f.uniqueName.mockResolvedValue("tree-fork-navigation-2"); await f.run();
  expect(f.uniqueName).toHaveBeenCalledWith("tree-fork-navigation");
  const start = f.fake.of("agent.start")[0].params;
  expect(start.name).toBe("tree-fork-navigation-2");
  expect(start.args.slice(0, 2)).toEqual(["--name", "Tree fork navigation"]);
  if (destination === FORK_DESTINATIONS[0]) expect(f.fake.of("tab.create")[0].params.label).toBe("Tree fork navigation");
  else expect(f.fake.of("tab.create")).toEqual([]);
  expect(f.ui.notify).toHaveBeenCalledWith("Fork opened: Tree fork navigation (tree-fork-navigation-2, new-pane). Original session unchanged.", "info");
  f.assertReleased(); f.assertUntouched();
});

test("context snapshots selected ancestry before destination despite source progress and metadata changes", async () => {
  const f = fixture(); const original = structuredClone(f.manager.getBranch(f.tip));
  f.ui.select.mockImplementation(async () => {
    expect(f.registry.complete).not.toHaveBeenCalled();
    f.manager.appendLabelChange(f.tip, "Future label must not win");
    f.manager.appendSessionInfo("Future title");
    f.manager.appendMessage({ role: "user", content: "Unrelated later prompt", timestamp: 3 });
    return FORK_DESTINATIONS[0];
  });
  await f.run();
  const payload = JSON.parse((f.registry.complete.mock.calls[0][1] as { messages: { content: { text: string }[] }[] }).messages[0].content[0].text);
  expect(payload).toEqual({ dialogue: [{ role: "user", text: "Searchable question" }, { role: "assistant", text: "Current answer" }] });
  expect(JSON.stringify(payload)).not.toMatch(/Hidden|Future|Unrelated/);
  const args = f.fake.of("agent.start")[0].params.args as string[];
  const fork = SessionManager.open(args.at(-1)!);
  expect(fork.getBranch().filter((entry) => entry.type !== "label").slice(0, -1)).toEqual(original);
  expect(fork.getBranch().find((entry) => entry.type === "label")).toMatchObject({ targetId: f.tip, label: "Future label must not win" });
  expect(fork.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual([f.question, f.tool, f.toolResult, f.tip]);
  f.assertReleased();
});

test.each(["tool", "toolResult", "hiddenLeaf", "missing"] as const)("rejects picker IDs absent from projected snapshot: %s", async (selected) => {
  const f = fixture(); const files = readdirSync(f.dir);
  f.screens.picker.mockImplementation((_picker, done) => done(selected === "missing" ? "not-persisted" : f[selected]));
  await f.run();
  expect(f.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  expect(f.ui.select).not.toHaveBeenCalled(); expect(f.screens.loader).not.toHaveBeenCalled();
  expect(f.registry.complete).not.toHaveBeenCalled(); expect(f.fake.log).toEqual([]);
  expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
});

test("newly appended visible IDs cannot be returned from the older picker snapshot", async () => {
  const f = fixture();
  f.screens.picker.mockImplementation((_picker, done) => done(f.manager.appendMessage({ role: "user", content: "New point", timestamp: 3 })));
  await f.run();
  expect(f.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  expect(f.ui.select).not.toHaveBeenCalled(); expect(f.registry.complete).not.toHaveBeenCalled();
  expect(f.fake.log).toEqual([]); f.assertReleased();
});

test("internal-only persisted history warns before opening UI", async () => {
  const f = fixture(); const manager = SessionManager.create("/checkout", f.dir);
  manager.appendMessage({ role: "user", content: [], timestamp: 1 });
  manager.appendCustomEntry("internal", {}); f.ctx.sessionManager = manager;
  const files = readdirSync(f.dir); await f.run();
  expect(f.ui.notify).toHaveBeenCalledWith("No user prompts or completed answers to fork from.", "warning");
  expect(f.ui.custom).not.toHaveBeenCalled(); expect(f.holds()).toEqual([]);
  expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files);
});

test("concurrent commands while naming is pending do not open another picker and guard releases after cancel", async () => {
  const f = fixture(); const entered = deferred<void>();
  const result = deferred<{ stopReason: string; content: { type: string; text: string }[] }>();
  f.registry.complete.mockReturnValue(result.promise);
  let loader!: BorderedLoader;
  f.screens.loader.mockImplementation((component) => { loader = component; entered.resolve(); });
  const run = f.run(); await entered.promise;
  await f.run();
  expect(f.ui.notify).toHaveBeenCalledWith("/tree-fork is already open.", "warning");
  expect(f.ui.custom).toHaveBeenCalledTimes(2);
  expect(f.holds().map(([, hold]) => hold.active)).toEqual([true]);
  loader.handleInput("\u001b"); await run;
  expect(f.fake.log).toEqual([]); f.assertReleased(); f.assertUntouched();
  f.screens.picker.mockImplementation((_picker, done) => done(undefined));
  await f.run(); expect(f.screens.picker).toHaveBeenCalledTimes(2);
  result.resolve({ stopReason: "stop", content: [{ type: "text", text: "Ignored late name" }] });
});

test("explicit selected label bypasses model and preserves its natural title", async () => {
  const f = fixture(); f.manager.appendLabelChange(f.tip, "OAuth callback retries");
  const before = f.snapshot(); await f.run();
  expect(f.registry.complete).not.toHaveBeenCalled();
  expect(f.uniqueName).toHaveBeenCalledWith("oauth-callback-retries");
  expect(f.fake.of("tab.create")[0].params.label).toBe("OAuth callback retries");
  expect(f.fake.of("agent.start")[0].params.args.slice(0, 2)).toEqual(["--name", "OAuth callback retries"]);
  expect(f.snapshot()).toEqual(before); f.assertReleased();
});

test("current completed final tip remains selectable without trailing hidden metadata", async () => {
  const f = fixture(); f.manager.branch(f.tip); const before = f.snapshot();
  f.screens.picker.mockImplementation((picker) => {
    expect(picker.getTreeList().getSelectedNode()?.entry.id).toBe(f.tip);
    picker.handleInput("\r");
  });
  await f.run();
  expect(f.fake.of("agent.start")).toHaveLength(1);
  const file = f.fake.of("agent.start")[0].params.args.at(-1) as string;
  expect(SessionManager.open(file).getBranch().at(-1)).toMatchObject({ parentId: f.tip });
  expect(f.snapshot()).toEqual(before); f.assertReleased();
});

test.each(FORK_DESTINATIONS)("fork-here opens %s at exact hidden compaction/custom ancestry without a picker or prompt", async (destination) => {
  const f = fixture();
  const compaction = f.manager.appendCompaction("Hidden summary", f.question, 100, { preserved: true }, true);
  const leaf = f.manager.appendCustomEntry("hidden-context", { keep: "exact current context" });
  const before = f.snapshot(); const branch = structuredClone(f.manager.getBranch());
  const tree = vi.spyOn(f.manager, "getTree").mockImplementation(() => { throw new Error("Direct fork must not project a picker"); });
  f.ui.select.mockResolvedValue(destination);
  f.uniqueName.mockImplementation(async () => {
    expect(f.holds().map(([, hold]) => hold.active)).toEqual([true, false]);
    return "available-fork";
  });
  await f.runHere();
  expect(tree).not.toHaveBeenCalled(); expect(f.screens.picker).not.toHaveBeenCalled();
  expect(f.ui.select).toHaveBeenCalledWith(FORK_TITLE, FORK_DESTINATIONS);
  expect(f.screens.loader).toHaveBeenCalledTimes(1); expect(f.registry.complete).toHaveBeenCalledTimes(1);
  expect(f.uniqueName).toHaveBeenCalledWith("tree-fork-navigation");
  const start = f.fake.of("agent.start")[0].params; const file = start.args.at(-1) as string;
  expect(start).toEqual({ name: "available-fork", kind: "pi", pane_id: "new-pane", timeout_ms: 90_000, args: ["--name", "Tree fork navigation", "--model", "anthropic/current-model", "--thinking", "high", "--session", file] });
  const fork = SessionManager.open(file);
  expect(fork.getSessionId()).not.toBe(f.manager.getSessionId());
  expect(fork.getHeader()).toMatchObject({ parentSession: before.file, cwd: "/checkout" });
  expect(fork.getBranch().slice(0, -1)).toEqual(branch);
  expect(fork.getEntry(compaction)).toMatchObject({ summary: "Hidden summary", firstKeptEntryId: f.question, details: { preserved: true } });
  expect(fork.getBranch().at(-1)).toMatchObject({ customType: FORK_BOUNDARY, parentId: leaf, data: { entryId: leaf, sourceSessionId: before.id } });
  expect(f.fake.log.map(({ method }) => method)).toEqual(destination === FORK_DESTINATIONS[0] ? ["pane.get", "tab.create", "agent.start"] : ["pane.get", "pane.layout", "pane.split", "agent.start"]);
  expect(f.fake.of(destination === FORK_DESTINATIONS[0] ? "tab.create" : "pane.split")[0].params).toMatchObject({ cwd: "/checkout", focus: false });
  expect(f.snapshot()).toEqual(before); f.assertReleased();
  f.assertNoSourceActions();
});

test("fork-here preserves an idle interrupted assistant leaf without silently rewinding", async () => {
  const f = fixture();
  const leaf = f.manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Interrupted partial answer" }],
    api: "anthropic-messages", provider: "anthropic", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted", timestamp: 3,
  });
  const before = f.snapshot(); const branch = structuredClone(f.manager.getBranch());
  await f.runHere("Interrupted context");
  expect(f.ctx.isIdle).toHaveReturnedWith(true); expect(f.screens.picker).not.toHaveBeenCalled();
  const file = f.fake.of("agent.start")[0].params.args.at(-1) as string;
  const fork = SessionManager.open(file);
  expect(fork.getBranch().slice(0, -1)).toEqual(branch);
  expect(fork.getEntry(leaf)).toMatchObject({ message: { stopReason: "aborted", content: [{ type: "text", text: "Interrupted partial answer" }] } });
  expect(fork.getBranch().at(-1)).toMatchObject({ parentId: leaf, customType: FORK_BOUNDARY, data: { entryId: leaf } });
  expect(f.snapshot()).toEqual(before); f.assertNoSourceActions(); f.assertReleased();
});

test("fork-here rejects an unpersisted current leaf without creating a file/pane and resets guard", async () => {
  const f = fixture(); const files = readdirSync(f.dir);
  vi.spyOn(f.manager, "getLeafId").mockReturnValue("not-persisted");
  await f.runHere("Unpersisted context");
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("selected entry not-persisted was not persisted yet"), "error");
  expect(f.ui.select).toHaveBeenCalledTimes(1); expect(f.screens.picker).not.toHaveBeenCalled();
  expect(f.uniqueName).toHaveBeenCalledTimes(1); expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files); f.assertReleased();
  vi.restoreAllMocks(); f.assertUntouched(); f.ui.select.mockResolvedValue(undefined);
  await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(2); f.assertReleased();
});

test.each(FORK_DESTINATIONS)("fork-here explicit multiword title preserves case/spaces and collision slug in %s", async (destination) => {
  const f = fixture(); f.ui.select.mockResolvedValue(destination); f.uniqueName.mockResolvedValue("oauth-callback-retries-2");
  await f.runHere("  OAuth  Callback Retries  ");
  expect(f.ui.custom).not.toHaveBeenCalled(); expect(f.registry.complete).not.toHaveBeenCalled(); expect(f.registry.find).not.toHaveBeenCalled();
  expect(f.uniqueName).toHaveBeenCalledWith("oauth-callback-retries");
  const start = f.fake.of("agent.start")[0].params;
  expect(start.name).toBe("oauth-callback-retries-2"); expect(start.args.slice(0, 2)).toEqual(["--name", "OAuth  Callback Retries"]);
  if (destination === FORK_DESTINATIONS[0]) expect(f.fake.of("tab.create")[0].params.label).toBe("OAuth  Callback Retries");
  expect(f.ui.notify).toHaveBeenCalledWith("Fork opened: OAuth  Callback Retries (oauth-callback-retries-2, new-pane). Original session unchanged.", "info");
  f.assertReleased(); f.assertUntouched();
});

test.each(["rpc", "print", "no-ui", "unsaved", "missing", "empty-file", "no-leaf", "active"])("fork-here guards %s before any dialog or side effects and resets", async (guard) => {
  const f = fixture();
  if (guard === "rpc" || guard === "print") f.ctx.mode = guard;
  if (guard === "no-ui") f.ctx.hasUI = false;
  if (guard === "unsaved") vi.spyOn(f.manager, "getSessionFile").mockReturnValue(undefined);
  if (guard === "missing" || guard === "empty-file") {
    const file = join(f.dir, "unusable.jsonl");
    if (guard === "empty-file") writeFileSync(file, "");
    vi.spyOn(f.manager, "getSessionFile").mockReturnValue(file);
  }
  if (guard === "no-leaf") vi.spyOn(f.manager, "getLeafId").mockReturnValue(null);
  if (guard === "active") f.ctx.isIdle.mockReturnValue(false);
  const files = readdirSync(f.dir); await f.runHere();
  const warning = guard === "active" ? "Wait for the current turn to finish before using /fork-here." : guard === "no-leaf" ? "This session has no current point to fork." : ["unsaved", "missing", "empty-file"].includes(guard) ? "Save this session before using /fork-here." : "/fork-here requires interactive Pi in Herdr.";
  expect(f.ui.notify).toHaveBeenCalledWith(warning, "warning");
  expect(f.ui.custom).not.toHaveBeenCalled(); expect(f.ui.select).not.toHaveBeenCalled(); expect(f.holds()).toEqual([]);
  expect(f.fake.log).toEqual([]); expect(f.uniqueName).not.toHaveBeenCalled(); expect(readdirSync(f.dir)).toEqual(files);
  vi.restoreAllMocks(); f.ctx.mode = "tui"; f.ctx.hasUI = true; f.ctx.isIdle.mockReturnValue(true);
  f.assertUntouched(); f.ui.select.mockResolvedValue(undefined); await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(1); f.assertReleased();
});

test.each(["bad\u0000title", "bad\ttitle", "bad\u001btitle", "bad\u007ftitle", "bad\u0085title", "two\nlines", "two\rlines", "\nTrimmed newline", "Trimmed tab\t", "two\u2028lines", "two\u2029lines", "x".repeat(61)])("fork-here rejects invalid title %j without effects and resets", async (title) => {
  const f = fixture(); const files = readdirSync(f.dir); await f.runHere(title);
  expect(f.ui.notify).toHaveBeenCalledWith("Usage: /fork-here [name] (one line, at most 60 characters).", "warning");
  expect(f.ui.select).not.toHaveBeenCalled(); expect(f.ui.custom).not.toHaveBeenCalled(); expect(f.holds()).toEqual([]);
  expect(f.registry.complete).not.toHaveBeenCalled(); expect(f.uniqueName).not.toHaveBeenCalled(); expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files);
  f.assertUntouched(); f.ui.select.mockResolvedValue(undefined); await f.runHere("Valid title"); expect(f.ui.select).toHaveBeenCalledTimes(1); f.assertReleased();
});

test("fork-here accepts a 60-character title and whitespace-only arguments use automatic naming", async () => {
  const f = fixture(); await f.runHere("x".repeat(60));
  expect(f.fake.of("agent.start")[0].params.args.slice(0, 2)).toEqual(["--name", "x".repeat(60)]);
  expect(f.ui.custom).not.toHaveBeenCalled(); await f.runHere("   ");
  expect(f.registry.complete).toHaveBeenCalledTimes(1); expect(f.screens.picker).not.toHaveBeenCalled(); f.assertReleased(); f.assertUntouched();
});

test.each(["destination", "naming", "uniqueName"])("fork-here rechecks idle after %s before creating files", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (stage === "destination") f.ui.select.mockImplementation(async () => { f.ctx.isIdle.mockReturnValue(false); return FORK_DESTINATIONS[0]; });
  if (stage === "naming") f.registry.complete.mockImplementation(async () => { f.ctx.isIdle.mockReturnValue(false); return { stopReason: "stop", content: [{ type: "text", text: "Topic title" }] }; });
  if (stage === "uniqueName") f.uniqueName.mockImplementation(async () => { f.ctx.isIdle.mockReturnValue(false); return "available-fork"; });
  await f.runHere();
  expect(f.ui.notify).toHaveBeenCalledWith("Wait for the current turn to finish before using /fork-here.", "warning");
  expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
  f.ctx.isIdle.mockReturnValue(true); f.ui.select.mockResolvedValue(undefined); const calls = f.ui.select.mock.calls.length;
  await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(calls + 1); f.assertReleased();
});

test.each(["destination", "loader"])("fork-here cancellation at %s releases holds/guard and creates nothing", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  const result = deferred<{ stopReason: string; content: { type: string; text: string }[] }>();
  if (stage === "destination") f.ui.select.mockResolvedValue(undefined);
  else {
    f.registry.complete.mockReturnValue(result.promise);
    f.screens.loader.mockImplementation((loader) => { loader.handleInput("\u001b"); expect(loader.signal.aborted).toBe(true); });
  }
  await f.runHere(); await f.runHere();
  expect(f.ui.select).toHaveBeenCalledTimes(2); expect(f.screens.picker).not.toHaveBeenCalled();
  expect(f.uniqueName).not.toHaveBeenCalled(); expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files);
  result.resolve({ stopReason: "stop", content: [{ type: "text", text: "Late title" }] }); await Promise.resolve();
  expect(f.fake.log).toEqual([]); f.assertReleased(); f.assertUntouched();
});

test("fork-here snapshots leaf, name context, cwd, model and thinking before destination awaits", async () => {
  const f = fixture(); const original = structuredClone(f.manager.getBranch());
  f.ui.select.mockImplementation(async () => {
    f.manager.appendSessionInfo("Future title"); f.manager.appendCustomEntry("future-hidden", {});
    f.manager.appendMessage({ role: "user", content: "Unrelated later prompt", timestamp: 3 });
    f.ctx.cwd = "/later"; f.ctx.model.id = "later-model"; f.pi.getThinkingLevel.mockReturnValue("low");
    return FORK_DESTINATIONS[0];
  });
  await f.runHere();
  const payload = JSON.parse((f.registry.complete.mock.calls[0][1] as { messages: { content: { text: string }[] }[] }).messages[0].content[0].text);
  expect(payload).toEqual({ dialogue: [{ role: "user", text: "Searchable question" }, { role: "assistant", text: "Current answer" }] });
  const args = f.fake.of("agent.start")[0].params.args as string[];
  expect(args).toContain("anthropic/current-model"); expect(args).toContain("high");
  const fork = SessionManager.open(args.at(-1)!);
  expect(fork.getBranch().slice(0, -1)).toEqual(original); expect(fork.getBranch().at(-1)).toMatchObject({ parentId: f.hiddenLeaf });
  expect(f.fake.of("tab.create")[0].params.cwd).toBe("/checkout"); f.assertReleased();
});

test.each(["destination", "naming", "uniqueName"])("fork-here runtime replacement during %s cancels and resets", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (stage === "destination") f.ui.select.mockImplementation(async () => { f.stale(); return FORK_DESTINATIONS[0]; });
  if (stage === "naming") f.registry.complete.mockImplementation(async () => { f.stale(); return { stopReason: "stop", content: [{ type: "text", text: "Topic title" }] }; });
  if (stage === "uniqueName") f.uniqueName.mockImplementation(async () => { f.stale(); return "available-fork"; });
  await f.runHere();
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("switched or reloaded"), "error");
  expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
  f.ui.select.mockResolvedValue(undefined); const calls = f.ui.select.mock.calls.length; await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(calls + 1); f.assertReleased();
});

test.each([
  ["getSessionId", "destination"], ["getSessionFile", "destination"],
  ["getSessionId", "naming"], ["getSessionFile", "naming"],
  ["getSessionId", "uniqueName"], ["getSessionFile", "uniqueName"],
] as const)("fork-here rejects source identity replacement %s during %s", async (method, stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  const replace = () => { vi.spyOn(f.manager, method).mockReturnValue("replacement"); };
  if (stage === "destination") f.ui.select.mockImplementation(async () => { replace(); return FORK_DESTINATIONS[0]; });
  if (stage === "naming") f.registry.complete.mockImplementation(async () => { replace(); return { stopReason: "stop", content: [{ type: "text", text: "Topic title" }] }; });
  if (stage === "uniqueName") f.uniqueName.mockImplementation(async () => { replace(); return "available-fork"; });
  await f.runHere();
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("switched or reloaded"), "error");
  expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files); f.assertReleased();
  vi.restoreAllMocks(); f.assertUntouched(); f.ui.select.mockResolvedValue(undefined); await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(2); f.assertReleased();
});

test.each(["tree-first", "direct-first"])("fork commands share concurrency while destination is pending: %s", async (order) => {
  const f = fixture(); const entered = deferred<void>(); const wait = deferred<string | undefined>();
  f.ui.select.mockImplementationOnce(() => { entered.resolve(); return wait.promise; });
  const first = order === "tree-first" ? f.run : f.runHere; const second = order === "tree-first" ? f.runHere : f.run;
  const pending = first(); await entered.promise; const calls = f.ui.custom.mock.calls.length;
  await second();
  expect(f.ui.notify).toHaveBeenCalledWith(order === "tree-first" ? "/fork-here is already open." : "/tree-fork is already open.", "warning");
  expect(f.ui.select).toHaveBeenCalledTimes(1); expect(f.ui.custom).toHaveBeenCalledTimes(calls);
  wait.resolve(undefined); await pending; f.assertReleased(); f.assertUntouched();
  f.ui.select.mockResolvedValue(undefined); f.screens.picker.mockImplementation((_picker, done) => done(undefined));
  await second(); expect(f.ui.notify.mock.calls.filter(([message]) => String(message).includes("already open"))).toHaveLength(1); f.assertReleased();
});

test.each(["destination", "uniqueName"])("fork-here errors in %s release holds/guard without creating files", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (stage === "destination") f.ui.select.mockRejectedValueOnce(new Error("destination failed"));
  else f.uniqueName.mockRejectedValueOnce(new Error("unique name failed"));
  await f.runHere(); expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("failed"), "error");
  expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
  f.ui.select.mockResolvedValue(undefined); const calls = f.ui.select.mock.calls.length; await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(calls + 1); f.assertReleased();
});

test.each([
  ["tree-first", "naming"], ["direct-first", "naming"],
  ["tree-first", "startup"], ["direct-first", "startup"],
] as const)("fork commands share concurrency %s during %s, even after interaction hold releases", async (order, stage) => {
  const entered = deferred<void>(); const wait = deferred<void>();
  const f = fixture(stage === "startup" ? { "agent.start": async () => { entered.resolve(); await wait.promise; return { result: {} }; } } : {});
  if (stage === "naming") f.registry.complete.mockImplementation(async () => { entered.resolve(); await wait.promise; return { stopReason: "stop", content: [{ type: "text", text: "Topic title" }] }; });
  const first = order === "tree-first" ? f.run : f.runHere; const second = order === "tree-first" ? f.runHere : f.run;
  const pending = first(); await entered.promise;
  const customCalls = f.ui.custom.mock.calls.length;
  expect(f.holds().map(([, hold]) => hold.active)).toEqual(stage === "naming" ? [true] : [true, false]);
  await second();
  expect(f.ui.notify).toHaveBeenCalledWith(order === "tree-first" ? "/fork-here is already open." : "/tree-fork is already open.", "warning");
  expect(f.ui.select).toHaveBeenCalledTimes(1); expect(f.ui.custom).toHaveBeenCalledTimes(customCalls);
  wait.resolve(); await pending; expect(f.fake.of("agent.start")).toHaveLength(1); f.assertReleased(); f.assertUntouched();
  f.ui.select.mockResolvedValue(undefined); f.screens.picker.mockImplementation((_picker, done) => done(undefined));
  await second(); expect(f.ui.notify.mock.calls.filter(([message]) => String(message).includes("already open"))).toHaveLength(1); f.assertReleased();
});

test.each(["pane.get", "tab.create", "agent.start"])("fork-here runtime replacement during %s preserves safe startup recovery and resets", async (stage) => {
  const f = fixture();
  f.deps.call = (async (method, params, timeout) => {
    const reply = await f.fake.call(method, params, timeout);
    if (method === stage) f.stale();
    return reply;
  }) as Call;
  await f.runHere("Recovery title");
  expect(f.fake.of("agent.start")).toHaveLength(stage === "agent.start" ? 1 : 0);
  expect(f.fake.of("pane.close")).toEqual(stage === "tab.create" ? [{ method: "pane.close", params: { pane_id: "new-pane" } }] : []);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/switched or reloaded.*Session file retained/), "error");
  expect(f.ui.notify.mock.calls.some(([message]) => String(message).startsWith("Fork opened"))).toBe(false);
  expect(readdirSync(f.dir)).toHaveLength(2); f.assertReleased(); f.assertUntouched();
  f.ui.select.mockResolvedValue(undefined); await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(2); f.assertReleased();
});

test("fork-here thrown transport failure retains possibly running pane/file and releases guard", async () => {
  const f = fixture({ "agent.start": () => { throw new Error("connection disappeared"); } });
  await f.runHere("Recovery title");
  const file = f.fake.of("agent.start")[0].params.args.at(-1) as string;
  expect(f.fake.of("agent.start")).toHaveLength(1); expect(f.fake.of("pane.close")).toEqual([]);
  expect(readFileSync(file, "utf8")).toContain(FORK_BOUNDARY);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`connection disappeared. Session file retained: ${file}. Fork pane: new-pane`), "error");
  f.assertReleased(); f.assertUntouched(); f.ui.select.mockResolvedValue(undefined); await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(2); f.assertReleased();
});

test.each(["agent_not_ready", "timeout", "socket", "closed", "parse", "invalid_request", "agent_start_failed"])("fork-here startup %s preserves recovery and resets guard", async (code) => {
  const f = fixture({ "agent.start": () => failure(code) }); await f.runHere("Recovery title");
  expect(f.fake.of("agent.start")).toHaveLength(1);
  const preserve = ["agent_not_ready", "timeout", "socket", "closed", "parse"].includes(code);
  expect(f.fake.of("pane.close")).toEqual(preserve ? [] : [{ method: "pane.close", params: { pane_id: "new-pane" } }]);
  const file = f.fake.of("agent.start")[0].params.args.at(-1) as string;
  expect(readFileSync(file, "utf8")).toContain(FORK_BOUNDARY);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`Session file retained: ${file}. Fork pane: new-pane`), "error");
  if (code === "agent_not_ready") expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("waiting on a startup dialog; answer it in that pane"), "error");
  f.assertReleased(); f.assertUntouched(); f.ui.select.mockResolvedValue(undefined); await f.runHere(); expect(f.ui.select).toHaveBeenCalledTimes(2); f.assertReleased();
});
