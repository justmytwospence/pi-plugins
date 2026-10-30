import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager, TreeSelectorComponent, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FORK_BOUNDARY } from "../src/fork-session.ts";
import { FORK_DESTINATIONS, FORK_TITLE, openForkPane, registerTreeFork } from "../src/tree-fork.ts";
import { fakeCall } from "./core/fake.ts";
import type { Call } from "../src/core/herdr.ts";

initTheme("dark", false);
const dirs: string[] = [];
let previousKeybindings: KeybindingsManager;
beforeEach(() => {
  previousKeybindings = getKeybindings();
  // Interactive Pi installs application bindings in addition to pi-tui's defaults.
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit tree label" } }));
});
afterEach(() => {
  setKeybindings(previousKeybindings);
  vi.useRealTimers();
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
  return { call: fake.call, selfPane: "self", isCurrent: () => true, where: "tab" as const, cwd: "/checkout", name: "available-fork", file: "/sessions/fork.jsonl" };
}
function fixture(handlers: Parameters<typeof fakeCall>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-tree-fork-")); dirs.push(dir);
  const manager = SessionManager.create("/checkout", dir);
  const question = manager.appendMessage({ role: "user", content: "Searchable question", timestamp: 1 });
  const tip = manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Current answer" }], api: "anthropic-messages", provider: "anthropic", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2,
  });
  const fake = transport(handlers);
  const forbidden = Object.fromEntries(["abort", "fork", "navigateTree", "sendMessage", "sendUserMessage", "appendEntry", "setEditorText", "setEditorComponent"].map((name) => [name, vi.fn(() => { throw new Error(`Forbidden source action: ${name}`); })]));
  const ui = {
    custom: vi.fn(async (_factory: unknown): Promise<string | undefined> => tip),
    select: vi.fn(async (_title: string, _items: string[]): Promise<string | undefined> => FORK_DESTINATIONS[0]),
    notify: vi.fn(), ...forbidden,
  };
  const ctx = { mode: "tui", hasUI: true, cwd: "/checkout", model: { provider: "anthropic", id: "current-model" }, sessionManager: manager, ui, ...forbidden };
  const pi = { registerCommand: vi.fn(), getThinkingLevel: vi.fn(() => "high"), events: { emit: vi.fn() }, ...forbidden };
  let generation = 1;
  const uniqueName = vi.fn(async (_wanted: string) => "available-fork");
  const deps = { call: fake.call, selfPane: "self", uniqueName, runtimeCurrent: () => { const captured = generation; return () => generation === captured; } };
  registerTreeFork(pi as unknown as ExtensionAPI, deps);
  const command = pi.registerCommand.mock.calls[0] as unknown as [string, { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<unknown> }];
  const run = (args = "") => command[1].handler(args, ctx as unknown as ExtensionCommandContext);
  const snapshot = () => ({ bytes: readFileSync(manager.getSessionFile()!), entries: structuredClone(manager.getEntries()), leaf: manager.getLeafId(), id: manager.getSessionId(), file: manager.getSessionFile() });
  const before = snapshot();
  const assertUntouched = () => { expect(snapshot()).toEqual(before); for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled(); };
  const holds = () => pi.events.emit.mock.calls.map((args) => args as unknown as [string, { active: boolean; id: string; label?: string }]);
  const assertReleased = () => {
    const events = holds(); expect(events.length % 2).toBe(0);
    const starts = events.filter(([, e]) => e.active);
    expect(new Set(starts.map(([, e]) => e.id)).size).toBe(starts.length);
    for (const [event, hold] of starts) {
      expect(event).toBe("herdr:blocked"); expect(hold).toMatchObject({ label: "Fork session tree", id: expect.stringMatching(/^tree-fork:/) });
      expect(events.filter(([, e]) => !e.active && e.id === hold.id)).toHaveLength(1);
    }
  };
  return { dir, manager, question, tip, fake, ctx, ui, pi, deps, command, run, uniqueName, snapshot, assertUntouched, holds, assertReleased, stale: () => { generation++; } };
}

test("registers only the independent tree-fork command and tolerates registration-less hosts", () => {
  const f = fixture();
  expect(f.pi.registerCommand).toHaveBeenCalledTimes(1);
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
  const expected = guard === "args" ? "Usage: /tree-fork" : guard === "unsaved" ? "Save this session before using /tree-fork." : guard === "empty" ? "This session tree is empty." : "/tree-fork requires interactive Pi in Herdr.";
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
  expect(f.uniqueName).toHaveBeenCalledWith(`fork-${f.tip}`);
  const call = f.fake.of("agent.start")[0]; const file = call.params.args.at(-1) as string;
  expect(call.params).toEqual({ name: "available-fork", kind: "pi", pane_id: "new-pane", timeout_ms: 90_000, args: ["--name", "available-fork", "--model", "anthropic/current-model", "--thinking", "high", "--session", file] });
  expect(start).toHaveBeenCalledWith("agent.start", call.params, 95_000);
  const fork = SessionManager.open(file);
  expect(fork.getBranch().slice(0, -1)).toEqual(f.manager.getBranch());
  expect(fork.getBranch().at(-1)).toMatchObject({ customType: FORK_BOUNDARY, parentId: f.tip });
  expect(f.fake.log.map((c) => c.method)).toEqual(destination === FORK_DESTINATIONS[0] ? ["pane.get", "tab.create", "agent.start"] : ["pane.get", "pane.layout", "pane.split", "agent.start"]);
  expect(f.ui.notify).toHaveBeenCalledWith("Fork opened in available-fork (new-pane). Original session unchanged.", "info");
  f.assertReleased(); f.assertUntouched();
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(2);
});

test("tab launcher resolves the source workspace, supplies cwd/focus, and omits absent model/thinking", async () => {
  const fake = transport(); await expect(openForkPane(paneOptions(fake))).resolves.toBe("new-pane");
  expect(fake.log).toEqual([
    { method: "pane.get", params: { pane_id: "self" } },
    { method: "tab.create", params: { workspace_id: "source-workspace", cwd: "/checkout", label: "available-fork", focus: false } },
    { method: "agent.start", params: { name: "available-fork", kind: "pi", pane_id: "new-pane", timeout_ms: 90_000, args: ["--name", "available-fork", "--session", "/sessions/fork.jsonl"] } },
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
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(2);
});

test.each(["tree", "destination", "name"])("runtime replacement during %s stops before file creation and releases holds", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (stage === "tree") f.ui.custom.mockImplementation(async () => { f.stale(); return f.tip; });
  if (stage === "destination") f.ui.select.mockImplementation(async () => { f.stale(); return FORK_DESTINATIONS[0]; });
  if (stage === "name") f.uniqueName.mockImplementation(async () => { f.stale(); return "available-fork"; });
  await f.run(); expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("switched or reloaded"), "error");
  f.assertReleased(); f.assertUntouched();
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(2);
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
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(2);
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
  await f.run(); expect(f.ui.notify).toHaveBeenCalledWith("/tree-fork is already open.", "warning"); expect(f.ui.custom).toHaveBeenCalledTimes(1);
  wait.resolve(stage === "tree" ? f.tip : FORK_DESTINATIONS[0]); await first;
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(2); f.assertReleased(); f.assertUntouched();
});

test.each(["tree", "destination", "name", "unpersisted"])("errors in %s release holds/concurrency without pane effects", async (stage) => {
  const f = fixture(); const files = readdirSync(f.dir);
  if (stage === "tree") f.ui.custom.mockRejectedValueOnce(new Error("picker failed"));
  if (stage === "destination") f.ui.select.mockRejectedValueOnce(new Error("select failed"));
  if (stage === "name") f.uniqueName.mockRejectedValueOnce(new Error("name failed"));
  if (stage === "unpersisted") f.ui.custom.mockResolvedValueOnce("not-persisted");
  await f.run(); expect(f.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  expect(readdirSync(f.dir)).toEqual(files); expect(f.fake.log).toEqual([]); f.assertReleased(); f.assertUntouched();
  f.ui.custom.mockResolvedValue(undefined); await f.run(); expect(f.ui.custom).toHaveBeenCalledTimes(2);
});

test.each([46, 120])("native picker at %i columns starts focused at tip, searches/selects and disables label editing", async (width) => {
  const f = fixture();
  f.ui.custom.mockImplementation(async (factory) => new Promise<string | undefined>((done) => {
    const picker = (factory as (tui: unknown, theme: unknown, kb: unknown, done: (id: string | undefined) => void) => TreeSelectorComponent)({ terminal: { rows: 32, columns: width } }, undefined, undefined, done);
    expect(picker).toBeInstanceOf(TreeSelectorComponent);
    picker.focused = true; expect(picker.focused).toBe(true);
    expect(picker.getTreeList().getSelectedNode()?.entry.id).toBe(f.tip);
    const render = () => { const lines = picker.render(width); expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true); return lines.join("\n"); };
    expect(render()).toContain("Session Tree"); expect(render()).toContain("Current answer");
    expect(picker.getTreeList().onLabelEdit).toBeUndefined();
    const control = new TreeSelectorComponent(f.manager.getTree(), f.tip, 32, () => {}, () => {});
    const editLabel = vi.fn(); control.getTreeList().onLabelEdit = editLabel;
    control.handleInput("\u001b[108;2u"); expect(editLabel).toHaveBeenCalledTimes(1);
    picker.handleInput("\u001b[108;2u"); // Kitty protocol shift+l: Pi's native edit-label binding.
    expect(render()).not.toContain("Label (empty to remove)");
    picker.handleInput("Searchable"); expect(picker.getTreeList().getSearchQuery()).toBe("Searchable");
    expect(picker.getTreeList().getSelectedNode()?.entry.id).toBe(f.question); expect(render()).toContain("Searchable");
    picker.handleInput("\r");
  }));
  await f.run(); expect(f.ui.notify.mock.calls.filter(([, level]) => level === "error")).toEqual([]); expect(f.uniqueName).toHaveBeenCalledWith(`fork-${f.question}`); f.assertReleased(); f.assertUntouched();
});

test.each([46, 120])("native picker at %i columns clears search before escape cancels; snapshot is deep-cloned", async (width) => {
  const f = fixture(); const files = readdirSync(f.dir);
  f.ui.custom.mockImplementation(async (factory) => new Promise<string | undefined>((done) => {
    const picker = (factory as (tui: unknown, theme: unknown, kb: unknown, done: (id: string | undefined) => void) => TreeSelectorComponent)({ terminal: { rows: 24, columns: width } }, undefined, undefined, done);
    picker.focused = true;
    const selected = picker.getTreeList().getSelectedNode()!;
    expect(selected.entry).not.toBe(f.manager.getEntry(f.tip));
    if (selected.entry.type === "message" && selected.entry.message.role === "assistant") {
      const content = selected.entry.message.content[0]; if (content.type === "text") content.text = "Snapshot only";
    }
    picker.getTreeList().updateNodeLabel(f.tip, "Snapshot label");
    picker.handleInput("Searchable"); picker.handleInput("\u001b");
    expect(picker.getTreeList().getSearchQuery()).toBe(""); expect(f.ui.select).not.toHaveBeenCalled();
    expect(picker.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    picker.focused = false; expect(picker.focused).toBe(false); picker.handleInput("\u001b");
  }));
  await f.run(); expect(f.ui.notify.mock.calls.filter(([, level]) => level === "error")).toEqual([]);
  expect(f.ui.select).not.toHaveBeenCalled(); expect(f.fake.log).toEqual([]); expect(readdirSync(f.dir)).toEqual(files); f.assertReleased(); f.assertUntouched();
});
