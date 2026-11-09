import { stripVTControlCharacters } from "node:util";
import {
  createEventBus, createExtensionRuntime, createMcpExtension, CustomEditor, ExtensionRunner,
  InteractiveMode, SessionManager, initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { McpManagerView } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/ui.js";
import { getEditorTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { config } from "../src/config/config.ts";
import { CONTEXT_METADATA_CHANNEL, queryContextMetadata } from "../src/context-metadata.ts";
import { FOOTER_ACTIONS_CHANNEL, queryFooterActions } from "../src/footer-actions.ts";
import installNativeControls from "../src/feature/shell/native-controls.ts";
import { clearStartupHeader, getInteractiveModeForManager, installEarlyStartupHeader } from "../src/feature/shell/startup-header.ts";
import { createSplashActionController } from "../src/feature/shell/startup-interactions.ts";
import { attachStartupHost, disposeStartupHost, getStartupHostForManager } from "../src/feature/shell/startup-state.ts";
import { EARLY_STARTUP_HEADER_PATCH, patchRegistry } from "../src/utils/patch-keys.ts";

const prototype = InteractiveMode.prototype as any;
let savedInit: any;
let savedPatch: any;
let savedVisibility: boolean;
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  savedInit = prototype.init;
  savedPatch = patchRegistry.get(EARLY_STARTUP_HEADER_PATCH);
  savedVisibility = config.showStartupHeader;
  config.showStartupHeader = false;
  // Run the real capture wrapper without starting a process terminal or loading user resources.
  prototype.init = async function () {};
  patchRegistry.delete(EARLY_STARTUP_HEADER_PATCH);
  installEarlyStartupHeader();
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  prototype.init = savedInit;
  patchRegistry.delete(EARLY_STARTUP_HEADER_PATCH);
  if (savedPatch) patchRegistry.install(EARLY_STARTUP_HEADER_PATCH, savedPatch);
  config.showStartupHeader = savedVisibility;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function fixture(start = true, capture = true) {
  let sessionId = "same-id";
  const events = createEventBus();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {
    events,
    on(name: string, handler: (...args: any[]) => any) {
      const callbacks = handlers.get(name) ?? [];
      callbacks.push(handler); handlers.set(name, callbacks);
      return () => { callbacks.splice(callbacks.indexOf(handler), 1); };
    },
  };
  let branch = [{ id: "anchor" }];
  const manager = {
    getSessionId: () => sessionId,
    getLeafId: () => branch.at(-1)?.id ?? null,
    getBranch: () => branch,
  };
  const editor = { text: "unsent\n界 draft", setText: vi.fn(), render: () => ["draft"], invalidate() {} };
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const ui = {
    notify: vi.fn(), setEditorText: vi.fn(), pasteToEditor: vi.fn(),
    getEditorText: vi.fn(() => editor.text), setHeader: vi.fn(),
  };
  const ctx = { mode: "tui", hasUI: true, sessionManager: manager, ui, isIdle: vi.fn(() => true) };
  const command = { sourceInfo: { path: "builtin:mcp" }, handler: vi.fn(async (_args: string, _ctx: any) => {}) };
  const getSystemPromptOptions = vi.fn((): any => ({ cwd: "/project", selectedTools: ["read"] }));
  const waitForIdle = vi.fn(async () => {});
  const newSession = vi.fn(async (_options?: unknown) => ({ cancelled: false }));
  const runner = {
    getCommand: vi.fn((_name: string): any => command),
    createCommandContext: vi.fn((): any => ({ ...ctx, getSystemPromptOptions, waitForIdle, newSession })),
    createContext: vi.fn(() => ({ ...ctx })), uiPromptDepth: 0,
  };
  const mode: any = {
    session: { sessionManager: manager, extensionRunner: runner },
    get sessionManager() { return this.session.sessionManager; },
    headerContainer: new Container(), editorContainer, editor,
    ui: { getFocusedComponent: vi.fn((): any => editor), hasOverlay: vi.fn(() => false), requestRender: vi.fn() },
  };
  if (capture) await prototype.init.call(mode);
  installNativeControls(pi as any);
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
  };
  cleanup.push(() => emit("session_shutdown"));
  if (start) await emit("session_start");
  const query = () => queryFooterActions(events);
  const queryMetadata = () => queryContextMetadata(events, manager);
  return {
    pi, mode, manager, ctx, ui, editor, runner, command, emit, query, queryMetadata, getSystemPromptOptions,
    waitForIdle, newSession,
    setId: (id: string) => { sessionId = id; },
    setBranch: (ids: string[]) => { branch = ids.map(id => ({ id })); },
  };
}

function noDraftWrites(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.editor.text).toBe("unsent\n界 draft");
  expect(f.editor.setText).not.toHaveBeenCalled();
  expect(f.ui.setEditorText).not.toHaveBeenCalled();
  expect(f.ui.pasteToEditor).not.toHaveBeenCalled();
  expect(f.ui.getEditorText).not.toHaveBeenCalled();
}

describe("optional native MCP footer bridge", () => {
  test("publishes only mcp.open after start, with the splash hidden or ccstyle header cleared", async () => {
    const f = await fixture(false);
    expect(f.query()).toEqual({});
    await f.emit("session_start");
    expect(getInteractiveModeForManager(f.manager)).toBe(f.mode);
    expect(getStartupHostForManager(f.manager)).toBeUndefined();
    const actions = f.query();
    expect(Object.keys(actions)).toEqual(["mcp.open"]);
    expect(actions["mcp.open"]).toMatchObject({ label: "MCP controls", key: "/mcp" });
    expect(f.runner.createCommandContext).not.toHaveBeenCalled();
    clearStartupHeader(f.ctx);
    await actions["mcp.open"]!.run();
    expect(f.command.handler).toHaveBeenCalledWith("", f.runner.createCommandContext.mock.results[0]!.value);
    expect(f.ui.notify).not.toHaveBeenCalled(); // No fabricated success before the native manager opens.
    noDraftWrites(f);
  });

  test("uses manager identity, not matching session IDs or the most recently captured host", async () => {
    const first = await fixture();
    const second = await fixture();
    expect(first.manager.getSessionId()).toBe(second.manager.getSessionId());
    await first.query()["mcp.open"]!.run();
    expect(first.command.handler).toHaveBeenCalledTimes(1);
    expect(second.command.handler).not.toHaveBeenCalled();
    expect(getInteractiveModeForManager({ getSessionId: () => "same-id" })).toBeUndefined();
    noDraftWrites(first); noDraftWrites(second);
  });

  test("absent, ambiguous, non-TUI and unsupported hosts expose no action", async () => {
    const f = await fixture(true, false);
    expect(f.query()).toEqual({});
    await prototype.init.call(f.mode);
    expect(f.query()["mcp.open"]).toBeDefined();
    const other = { ...f.mode, headerContainer: new Container() };
    await prototype.init.call(other);
    expect(f.query()).toEqual({});
    other.session = { ...other.session, sessionManager: {} };
    f.runner.createCommandContext = undefined as any;
    expect(f.query()).toEqual({});
    f.ctx.mode = "rpc";
    await f.emit("session_start");
    expect(f.query()).toEqual({});
    f.ctx.mode = "tui"; f.ctx.hasUI = false;
    await f.emit("session_start");
    expect(f.query()).toEqual({});
    noDraftWrites(f);
  });

  test.each([undefined, "extension:mcp", "/path/builtin:mcp", "builtin:mcp-other", "builtin:MCP"])(
    "requires the exact built-in source path, not %s", async (path) => {
      const f = await fixture();
      f.command.sourceInfo.path = path as any;
      expect(f.query()).toEqual({});
      expect(f.command.handler).not.toHaveBeenCalled();
      noDraftWrites(f);
    },
  );

  test("missing command, handler or invalid request never advertises another provider", async () => {
    const f = await fixture();
    f.runner.getCommand.mockReturnValue(undefined);
    expect(f.query()).toEqual({});
    f.runner.getCommand.mockReturnValue({ sourceInfo: { path: "builtin:mcp" }, handler: false });
    expect(f.query()).toEqual({});
    for (const request of [null, {}, { version: 2, actions: {} }, { version: 1, actions: null }, { version: 1, actions: [] }]) {
      expect(() => f.pi.events.emit(FOOTER_ACTIONS_CHANNEL, request)).not.toThrow();
    }
    noDraftWrites(f);
  });

  test("revalidates the command at activation, with a fresh command context each time", async () => {
    const f = await fixture();
    const action = f.query()["mcp.open"]!;
    await action.run(); await action.run();
    expect(f.runner.createCommandContext).toHaveBeenCalledTimes(2);
    expect(f.command.handler.mock.calls[0]![1]).not.toBe(f.command.handler.mock.calls[1]![1]);
    f.command.sourceInfo.path = "extension:replacement";
    await action.run();
    expect(f.command.handler).toHaveBeenCalledTimes(2);
    expect(f.ui.notify).toHaveBeenLastCalledWith("MCP controls unavailable; use /mcp.", "warning");
    expect(f.query()).toEqual({});
    noDraftWrites(f);
  });

  test("requires idle, actual main-editor focus, no overlay, mounted editor and no pending prompt", async () => {
    const f = await fixture();
    const action = f.query()["mcp.open"]!;
    f.ctx.isIdle.mockReturnValue(false);
    await action.run();
    expect(f.ui.notify).toHaveBeenLastCalledWith("Wait for the current turn before opening MCP controls.", "warning");
    f.ctx.isIdle.mockReturnValue(true);
    f.mode.ui.getFocusedComponent.mockReturnValue({ name: "native model selector / Sidebar" });
    await action.run();
    f.mode.ui.getFocusedComponent.mockReturnValue(f.editor);
    f.mode.ui.hasOverlay.mockReturnValue(true);
    await action.run();
    f.mode.ui.hasOverlay.mockReturnValue(false);
    f.mode.editorContainer.clear();
    await action.run();
    f.mode.editorContainer.addChild(f.editor);
    f.runner.uiPromptDepth = 2;
    await action.run();
    f.runner.uiPromptDepth = 0;
    f.pi.events.emit("herdr:blocked", { active: true });
    f.pi.events.emit("herdr:blocked", { active: true });
    f.pi.events.emit("herdr:blocked", { active: false });
    await action.run();
    expect(f.command.handler).not.toHaveBeenCalled();
    f.pi.events.emit("herdr:blocked", { active: false });
    await action.run();
    expect(f.command.handler).toHaveBeenCalledTimes(1);
    noDraftWrites(f);
  });

  test("unsupported focus/prompt interfaces and stale or non-TUI command contexts fail closed", async () => {
    const f = await fixture();
    const action = f.query()["mcp.open"]!;
    const focus = f.mode.ui.getFocusedComponent;
    f.mode.ui.getFocusedComponent = undefined;
    await action.run();
    f.mode.ui.getFocusedComponent = focus;
    f.runner.uiPromptDepth = undefined as any;
    await action.run();
    f.runner.uiPromptDepth = 0;
    for (const ctx of [undefined, { ...f.ctx, mode: "rpc" }, { ...f.ctx, hasUI: false }, { ...f.ctx, sessionManager: {} }]) {
      f.runner.createCommandContext.mockReturnValueOnce(ctx);
      await action.run();
    }
    expect(f.command.handler).not.toHaveBeenCalled();
    noDraftWrites(f);
  });

  test("serializes distinct descriptors, nested activation, and the whole manager lifetime", async () => {
    const f = await fixture();
    const action = f.query()["mcp.open"]!;
    const pending = deferred();
    f.command.handler.mockImplementationOnce(async () => { await f.query()["mcp.open"]!.run(); await pending.promise; });
    const opened = action.run();
    await f.query()["mcp.open"]!.run();
    expect(f.command.handler).toHaveBeenCalledTimes(1);
    expect(f.runner.createCommandContext).toHaveBeenCalledTimes(1);
    pending.resolve(); await opened;
    await action.run();
    expect(f.command.handler).toHaveBeenCalledTimes(2);
    noDraftWrites(f);
  });

  test("acquires the reentrancy guard before context creation and reports thrown errors without draft writes", async () => {
    const f = await fixture();
    const action = f.query()["mcp.open"]!;
    f.runner.createCommandContext.mockImplementationOnce(() => { void action.run(); throw new Error("unavailable"); });
    await action.run();
    expect(f.runner.createCommandContext).toHaveBeenCalledTimes(1);
    expect(f.command.handler).not.toHaveBeenCalled();
    expect(f.ui.notify).toHaveBeenLastCalledWith("MCP controls unavailable; use /mcp.", "error");
    f.command.handler.mockRejectedValueOnce(new Error("manager failed"));
    await expect(action.run()).resolves.toBeUndefined();
    expect(f.ui.notify).toHaveBeenCalledTimes(2);
    await action.run();
    expect(f.command.handler).toHaveBeenCalledTimes(2);
    noDraftWrites(f);
  });

  test.each(["id", "manager", "runner", "mode", "tree", "restart", "shutdown"])(
    "a cached descriptor cannot open after %s replacement", async (replacement) => {
      const f = await fixture();
      const action = f.query()["mcp.open"]!;
      if (replacement === "id") f.setId("other");
      else if (replacement === "manager") f.mode.session.sessionManager = { getSessionId: () => "same-id" };
      else if (replacement === "runner") f.mode.session.extensionRunner = { ...f.runner };
      else if (replacement === "mode") {
        const next = { ...f.mode, headerContainer: new Container() };
        f.mode.session = { ...f.mode.session, sessionManager: {} };
        await prototype.init.call(next);
      } else await f.emit(replacement === "tree" ? "session_tree" : replacement === "restart" ? "session_start" : "session_shutdown");
      await action.run();
      expect(f.command.handler).not.toHaveBeenCalled();
      expect(f.ui.notify).not.toHaveBeenCalled();
      if (replacement === "shutdown") expect(f.query()).toEqual({});
      if (replacement === "tree" || replacement === "restart") {
        await f.query()["mcp.open"]!.run();
        expect(f.command.handler).toHaveBeenCalledTimes(1);
      }
      noDraftWrites(f);
    },
  );

  test("shutdown disposes subscriptions and late failures cannot notify or release a replacement's busy lock", async () => {
    const f = await fixture();
    const first = deferred(), second = deferred();
    f.command.handler.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const old = f.query()["mcp.open"]!.run();
    await f.emit("session_shutdown");
    f.pi.events.emit("herdr:blocked", { active: true });
    await f.emit("session_start");
    const current = f.query()["mcp.open"]!;
    const opened = current.run();
    first.reject(new Error("old manager failed")); await old;
    await current.run();
    expect(f.command.handler).toHaveBeenCalledTimes(2);
    expect(f.ui.notify).not.toHaveBeenCalled();
    second.resolve(); await opened;
    await current.run();
    expect(f.command.handler).toHaveBeenCalledTimes(3);
    noDraftWrites(f);
  });

  test("session/focus changes during context creation are checked again before dispatch", async () => {
    const f = await fixture();
    const action = f.query()["mcp.open"]!;
    f.runner.createCommandContext.mockImplementationOnce(() => {
      f.mode.ui.getFocusedComponent.mockReturnValue({});
      return { ...f.ctx };
    });
    await action.run();
    f.mode.ui.getFocusedComponent.mockReturnValue(f.editor);
    f.runner.createCommandContext.mockImplementationOnce(() => { f.setId("next"); return { ...f.ctx }; });
    await action.run();
    expect(f.command.handler).not.toHaveBeenCalled();
    noDraftWrites(f);
  });
});

function noMetadataSideEffects(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.runner.getCommand).not.toHaveBeenCalled();
  expect(f.runner.createContext).not.toHaveBeenCalled();
  expect(f.command.handler).not.toHaveBeenCalled();
  expect(f.ctx.isIdle).not.toHaveBeenCalled();
  expect(f.ui.notify).not.toHaveBeenCalled();
  noDraftWrites(f);
}

function invalidateMetadata(f: Awaited<ReturnType<typeof fixture>>, replacement: string) {
  if (replacement === "id") f.setId("other");
  else if (replacement === "manager") f.mode.session.sessionManager = { getSessionId: () => "same-id" };
  else if (replacement === "session") f.mode.session = { ...f.mode.session };
  else if (replacement === "runner") f.mode.session.extensionRunner = { ...f.runner };
  else if (replacement === "mode") {
    const next = { ...f.mode, session: { ...f.mode.session }, headerContainer: new Container() };
    f.mode.session.sessionManager = {};
    // Capture runs synchronously before the stubbed native init awaits.
    void prototype.init.call(next);
  } else if (replacement === "rpc") f.ctx.mode = "rpc";
  else if (replacement === "no UI") f.ctx.hasUI = false;
  else if (replacement === "context manager") f.ctx.sessionManager = { ...f.manager, getSessionId: () => "same-id" };
  else if (replacement === "disposed") f.manager.getSessionId = () => { throw new Error("Disposed"); };
  // The registered lifecycle handlers execute synchronously before emit's first await.
  else void f.emit(replacement === "tree" ? "session_tree" : replacement === "restart" ? "session_start" : "session_shutdown");
}

const metadataReplacements = ["id", "manager", "session", "runner", "mode", "tree", "restart", "shutdown"];

describe("optional read-only context metadata bridge", () => {
  test("discovers without I/O only after startup and host capture, even with no MCP or splash", async () => {
    expect(queryContextMetadata(createEventBus(), {})).toBeUndefined();
    const f = await fixture(false, false);
    expect(f.queryMetadata()).toBeUndefined();
    await f.emit("session_start");
    expect(f.queryMetadata()).toBeUndefined();
    await prototype.init.call(f.mode);
    f.runner.getCommand.mockImplementation(() => { throw new Error("Metadata must not look up commands"); });
    expect(config.showStartupHeader).toBe(false);
    expect(getStartupHostForManager(f.manager)).toBeUndefined();
    const read = f.queryMetadata()!;
    expect(read).toBeTypeOf("function");
    expect(f.runner.createCommandContext).not.toHaveBeenCalled();
    expect(f.getSystemPromptOptions).not.toHaveBeenCalled();
    clearStartupHeader(f.ctx); // /ccstyle off must not withdraw metadata.
    expect(read()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    expect(f.queryMetadata()!()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    noMetadataSideEffects(f);
  });

  test("requires exact manager identity, not matching IDs or the latest captured mode", async () => {
    const first = await fixture(), second = await fixture();
    expect(first.manager.getSessionId()).toBe(second.manager.getSessionId());
    expect(queryContextMetadata(first.pi.events, second.manager)).toBeUndefined();
    expect(queryContextMetadata(first.pi.events, { getSessionId: () => "same-id" })).toBeUndefined();
    expect(first.queryMetadata()!()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    expect(first.getSystemPromptOptions).toHaveBeenCalledTimes(1);
    expect(second.getSystemPromptOptions).not.toHaveBeenCalled();
    noMetadataSideEffects(first); noMetadataSideEffects(second);
  });

  test.each([["rpc", true], ["print", false], ["json", false], ["tui", false]] as const)(
    "does not subscribe in %s mode with hasUI=%s", async (mode, hasUI) => {
      const f = await fixture(false);
      f.ctx.mode = mode; f.ctx.hasUI = hasUI;
      await f.emit("session_start");
      expect(f.queryMetadata()).toBeUndefined();
      expect(f.runner.createCommandContext).not.toHaveBeenCalled();
      noMetadataSideEffects(f);
    },
  );

  test("absent, ambiguous and unsupported live hosts expose no metadata", async () => {
    const f = await fixture();
    const other = { ...f.mode, headerContainer: new Container() };
    await prototype.init.call(other);
    expect(f.queryMetadata()).toBeUndefined();
    other.session = { ...other.session, sessionManager: {} };
    const session = f.mode.session;
    f.mode.session = undefined; // A fallback mode.sessionManager alone is not an actual session.
    Object.defineProperty(f.mode, "sessionManager", { value: f.manager });
    expect(f.queryMetadata()).toBeUndefined();
    f.mode.session = session;
    session.extensionRunner = undefined;
    expect(f.queryMetadata()).toBeUndefined();
    session.extensionRunner = f.runner;
    f.runner.createCommandContext = undefined as any;
    expect(f.queryMetadata()).toBeUndefined();
    noMetadataSideEffects(f);
  });

  test("rejects invalid requests without creating a context or advertising a dispatcher", async () => {
    const f = await fixture();
    for (const request of [null, undefined, {}, [], { version: 2, sessionManager: f.manager },
      { version: 1 }, { version: 1, sessionManager: {} }, Object.freeze({ version: 1, sessionManager: f.manager })]) {
      expect(() => f.pi.events.emit(CONTEXT_METADATA_CHANNEL, request)).not.toThrow();
      expect((request as any)?.read).toBeUndefined();
    }
    const request = { version: 1, sessionManager: f.manager };
    f.pi.events.emit(CONTEXT_METADATA_CHANNEL, request);
    expect(Object.keys(request)).toEqual(["version", "sessionManager", "read"]);
    expect(f.runner.createCommandContext).not.toHaveBeenCalled();
    expect(f.getSystemPromptOptions).not.toHaveBeenCalled();
    noMetadataSideEffects(f);
  });

  test("returns direct fresh SDK options with a new command context on every read", async () => {
    const f = await fixture();
    const first = Object.freeze({ cwd: "/first", selectedTools: Object.freeze(["read"]) });
    const second = Object.freeze({ cwd: "/second", sections: Object.freeze({ note: "changed" }) });
    f.getSystemPromptOptions.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const read = f.queryMetadata()!;
    expect(read()).toBe(first);
    expect(read()).toBe(second);
    expect(f.runner.createCommandContext).toHaveBeenCalledTimes(2);
    const [a, b] = f.runner.createCommandContext.mock.results.map(result => result.value);
    expect(a).not.toBe(b);
    expect(f.getSystemPromptOptions.mock.contexts).toEqual([a, b]);
    noMetadataSideEffects(f);
  });

  test("observational reads do not require idle, editor focus, mounted editor or unblocked UI", async () => {
    const f = await fixture();
    f.ctx.isIdle.mockReturnValue(false);
    f.mode.ui.getFocusedComponent.mockReturnValue({ name: "Sidebar / native selector" });
    f.mode.ui.hasOverlay.mockReturnValue(true);
    f.mode.editorContainer.clear();
    f.runner.uiPromptDepth = 2;
    f.pi.events.emit("herdr:blocked", { active: true });
    expect(f.queryMetadata()!()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    expect(f.mode.ui.getFocusedComponent).not.toHaveBeenCalled();
    expect(f.mode.ui.hasOverlay).not.toHaveBeenCalled();
    noMetadataSideEffects(f);
  });

  test("metadata remains available while the MCP action owns its busy lock", async () => {
    const f = await fixture();
    const pending = deferred();
    f.command.handler.mockReturnValueOnce(pending.promise);
    const opened = f.query()["mcp.open"]!.run();
    expect(f.queryMetadata()!()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    expect(f.command.handler).toHaveBeenCalledTimes(1);
    pending.resolve(); await opened;
    noDraftWrites(f);
  });

  test.each([undefined, null, {}, [], "prompt", 0, false, { cwd: null }, { cwd: 1 }, { selectedTools: [] }])(
    "rejects malformed or empty metadata %j", async (options) => {
      const f = await fixture();
      f.getSystemPromptOptions.mockReturnValue(options);
      expect(f.queryMetadata()!()).toBeUndefined();
      noMetadataSideEffects(f);
    },
  );

  test("missing or invalid command contexts fail closed without falling back to event context data", async () => {
    const f = await fixture();
    const read = f.queryMetadata()!;
    const fallback = vi.fn(() => ({ cwd: "/must-not-use" }));
    Object.assign(f.ctx, { getSystemPromptOptions: fallback });
    for (const context of [undefined, null, {}, { ...f.ctx, mode: "rpc", getSystemPromptOptions: f.getSystemPromptOptions },
      { ...f.ctx, hasUI: false, getSystemPromptOptions: f.getSystemPromptOptions },
      { ...f.ctx, sessionManager: {}, getSystemPromptOptions: f.getSystemPromptOptions },
      { ...f.ctx, getSystemPromptOptions: undefined }, { ...f.ctx, getSystemPromptOptions: "not a function" }]) {
      f.runner.createCommandContext.mockReturnValueOnce(context);
      expect(read()).toBeUndefined();
    }
    f.runner.createCommandContext = undefined as any;
    expect(read()).toBeUndefined();
    expect(f.getSystemPromptOptions).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    noMetadataSideEffects(f);
  });

  test("creation, guarded context properties, and metadata errors return undefined silently", async () => {
    const f = await fixture();
    const read = f.queryMetadata()!;
    f.runner.createCommandContext.mockImplementationOnce(() => { throw new Error("Stale runner"); });
    expect(read()).toBeUndefined();
    for (const key of ["mode", "hasUI", "sessionManager", "getSystemPromptOptions"]) {
      const context = { ...f.ctx, getSystemPromptOptions: f.getSystemPromptOptions };
      Object.defineProperty(context, key, { get() { throw new Error("Stale context"); } });
      f.runner.createCommandContext.mockReturnValueOnce(context);
      expect(read()).toBeUndefined();
    }
    f.getSystemPromptOptions.mockImplementationOnce(() => { throw new Error("Metadata unavailable"); });
    expect(read()).toBeUndefined();
    f.getSystemPromptOptions.mockReturnValueOnce({ get cwd() { throw new Error("Invalid metadata"); } });
    expect(read()).toBeUndefined();
    expect(read()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    noMetadataSideEffects(f);
  });

  test.each([...metadataReplacements, "rpc", "no UI", "context manager", "disposed"])(
    "cached readers fail before context creation after %s replacement", async (replacement) => {
      const f = await fixture();
      const read = f.queryMetadata()!;
      invalidateMetadata(f, replacement);
      expect(read()).toBeUndefined();
      expect(f.runner.createCommandContext).not.toHaveBeenCalled();
      expect(f.getSystemPromptOptions).not.toHaveBeenCalled();
      if (["id", "manager", "shutdown", "rpc", "no UI", "context manager", "disposed"].includes(replacement)) {
        expect(f.queryMetadata()).toBeUndefined();
      } else {
        expect(f.queryMetadata()!()).toEqual({ cwd: "/project", selectedTools: ["read"] });
      }
      noMetadataSideEffects(f);
    },
  );

  test.each(metadataReplacements.flatMap(replacement =>
    ["creation", "method getter", "metadata read", "cwd getter"].map(stage => [replacement, stage])))(
    "discards metadata when %s replacement occurs during synchronous %s", async (replacement, stage) => {
      const f = await fixture();
      const read = f.queryMetadata()!;
      const invalidate = () => invalidateMetadata(f, replacement!);
      if (stage === "creation") f.runner.createCommandContext.mockImplementationOnce(() => {
        invalidate(); return { ...f.ctx, getSystemPromptOptions: f.getSystemPromptOptions };
      });
      else if (stage === "method getter") f.runner.createCommandContext.mockReturnValueOnce({
        ...f.ctx, get getSystemPromptOptions() { invalidate(); return f.getSystemPromptOptions; },
      });
      else if (stage === "metadata read") f.getSystemPromptOptions.mockImplementationOnce(() => {
        invalidate(); return { cwd: "/stale" };
      });
      else f.getSystemPromptOptions.mockReturnValueOnce({ get cwd() { invalidate(); return "/stale"; } });
      expect(read()).toBeUndefined();
      expect(f.getSystemPromptOptions).toHaveBeenCalledTimes(stage === "creation" || stage === "method getter" ? 0 : 1);
      noMetadataSideEffects(f);
    },
  );

  test("shutdown unsubscribes metadata, startup replaces readers, and repeated stop is safe", async () => {
    const f = await fixture();
    const old = f.queryMetadata()!;
    await f.emit("session_shutdown");
    await f.emit("session_shutdown");
    expect(old()).toBeUndefined();
    expect(f.queryMetadata()).toBeUndefined();
    await f.emit("session_start");
    const current = f.queryMetadata()!;
    expect(old()).toBeUndefined();
    expect(current()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    expect(f.getSystemPromptOptions).toHaveBeenCalledTimes(1);
    await f.emit("session_tree");
    expect(current()).toBeUndefined();
    expect(f.queryMetadata()!()).toEqual({ cwd: "/project", selectedTools: ["read"] });
    noMetadataSideEffects(f);
  });
});

describe("native runtime integration", () => {
  test("real loader/runner bridges command-only metadata without exposing or executing commands", async () => {
    const events = createEventBus();
    const runtime = createExtensionRuntime();
    const cwd = process.cwd();
    const manager = SessionManager.inMemory(cwd);
    const handler = vi.fn(async () => { throw new Error("No command may execute"); });
    const contexts: unknown[] = [];
    const earlyReaders: unknown[] = [];
    const consumer = await loadExtensionFromFactory(pi => {
      pi.registerCommand("never-dispatch", { handler });
      pi.on("session_start", (_event, ctx) => {
        contexts.push(ctx);
        earlyReaders.push(queryContextMetadata(pi.events, ctx.sessionManager));
      });
    }, cwd, events, runtime, "inline:metadata-consumer");
    const bridge = await loadExtensionFromFactory(installNativeControls, cwd, events, runtime, "inline:cc-native-controls");
    // No MCP extension: metadata availability cannot depend on its command.
    const runner = new ExtensionRunner([consumer, bridge], runtime, cwd, manager, {} as any);
    const errors: unknown[] = [];
    runner.onError(error => errors.push(error));
    const mutation = vi.fn(() => { throw new Error("Metadata is read-only"); });
    let options = Object.freeze({ cwd, selectedTools: ["read"], sections: { note: "first" } });
    const getSystemPromptOptions = vi.fn(() => options);
    const isIdle = vi.fn(() => false);
    runner.bindCore({ getThinkingLevel: () => "off" } as any, {
      getModel: () => undefined, getScopedModels: () => [], isIdle, isProjectTrusted: () => true,
      getSignal: () => undefined, abort: mutation, hasPendingMessages: () => false, shutdown: mutation,
      getContextUsage: () => undefined, compact: mutation, getSystemPrompt: mutation, getSystemPromptOptions,
      executeTool: mutation,
    });
    runner.bindCommandContext({
      waitForIdle: mutation, newSession: mutation, fork: mutation, navigateTree: mutation,
      switchSession: mutation, reload: mutation,
    });
    const notify = vi.fn(), setEditorText = vi.fn(), pasteToEditor = vi.fn();
    runner.setUIContext({ ...runner.getUIContext(), notify, setEditorText, pasteToEditor }, "tui");
    const mode = { session: { sessionManager: manager, extensionRunner: runner }, headerContainer: new Container() };
    await prototype.init.call(mode);
    await runner.emit({ type: "session_start", reason: "startup" });
    cleanup.push(async () => { await runner.emit({ type: "session_shutdown", reason: "quit" }); });
    expect(earlyReaders).toEqual([undefined]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).not.toHaveProperty("getSystemPromptOptions");
    expect(runner.createContext()).not.toHaveProperty("getSystemPromptOptions");
    expect(getStartupHostForManager(manager)).toBeUndefined();
    const createCommandContext = vi.spyOn(runner, "createCommandContext");
    const lookup = vi.spyOn(runner, "getCommand").mockImplementation(() => { throw new Error("No command lookup"); });
    const read = queryContextMetadata(events, manager)!;
    expect(createCommandContext).not.toHaveBeenCalled();
    expect(getSystemPromptOptions).not.toHaveBeenCalled();
    expect(read()).toBe(options);
    options = Object.freeze({ cwd: "/new-workspace", selectedTools: ["bash"], sections: { note: "fresh" } });
    expect(read()).toBe(options);
    expect(createCommandContext).toHaveBeenCalledTimes(2);
    expect(createCommandContext.mock.results[0]!.value).not.toBe(createCommandContext.mock.results[1]!.value);
    expect(createCommandContext.mock.results[0]!.value.getSystemPromptOptions).toBeTypeOf("function");
    expect(getSystemPromptOptions).toHaveBeenCalledTimes(2);
    // Live SDK context guards must also close discovery/invocation when UI mode or runtime changes.
    runner.setUIContext(runner.getUIContext(), "rpc");
    expect(read()).toBeUndefined();
    expect(queryContextMetadata(events, manager)).toBeUndefined();
    runner.setUIContext(runner.getUIContext(), "tui");
    runner.invalidate();
    expect(read()).toBeUndefined();
    expect(queryContextMetadata(events, manager)).toBeUndefined();
    expect(createCommandContext).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled(); expect(isIdle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled(); expect(setEditorText).not.toHaveBeenCalled(); expect(pasteToEditor).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  test.each([46, 120, 180])("real loader/runner and native MCP manager preserve draft and focus at %i columns", async (width) => {
    initTheme("dark");
    const events = createEventBus();
    const runtime = createExtensionRuntime();
    const cwd = process.cwd();
    const updateConfig = vi.fn(() => { throw new Error("Must not save MCP config"); });
    const createTransport = vi.fn(() => { throw new Error("Must not connect a server"); });
    const builtin = await loadExtensionFromFactory(createMcpExtension({
      loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }), updateConfig, createTransport,
    }), cwd, events, runtime, "builtin:mcp");
    const bridge = await loadExtensionFromFactory(installNativeControls, cwd, events, runtime, "inline:cc-native-controls");
    const manager = SessionManager.inMemory(cwd);
    const runner = new ExtensionRunner([builtin, bridge], runtime, cwd, manager, {} as any);
    const errors: unknown[] = [];
    runner.onError(error => errors.push(error));
    const terminal = {
      columns: width, rows: 24, kittyProtocolActive: false,
      start() { throw new Error("No process terminal in tests"); }, stop() {}, async drainInput() {},
      write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    } as Terminal;
    const tui = new TuiAltScreen(terminal);
    vi.spyOn(tui, "requestRender").mockImplementation(() => {});
    const keybindings = new KeybindingsManager();
    const editor = new CustomEditor(tui, getEditorTheme(), keybindings);
    editor.setText("unsent\n界 draft");
    const setText = vi.spyOn(editor, "setText");
    const container = new Container(); container.addChild(editor);
    const mode: any = {
      session: { sessionManager: manager, extensionRunner: runner }, editor, editorContainer: container,
      headerContainer: new Container(), ui: tui, keybindings, disposeActiveSelector() {},
    };
    await prototype.init.call(mode);
    const setEditorText = vi.fn(), pasteToEditor = vi.fn(), notify = vi.fn();
    runner.setUIContext({
      ...runner.getUIContext(), setEditorText, pasteToEditor, notify,
      custom: (factory: any, options: any) => prototype.showExtensionCustom.call(mode, factory, options),
    }, "tui");
    tui.setFocus(editor);
    await runner.emit({ type: "session_start", reason: "startup" });
    cleanup.push(async () => { await runner.emit({ type: "session_shutdown", reason: "quit" }); });
    expect(errors).toEqual([]);
    expect(runner.getCommand("mcp")?.sourceInfo.path).toBe("builtin:mcp");
    expect(getStartupHostForManager(manager)).toBeUndefined();
    const action = queryFooterActions(events)["mcp.open"]!;
    const opened = action.run();
    await Promise.resolve();
    expect(tui.getFocusedComponent()).toBeInstanceOf(McpManagerView);
    expect(container.children).not.toContain(editor);
    const lines = container.render(width);
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    expect(stripVTControlCharacters(lines.join("\n"))).toContain("MCP servers");
    expect(setText).not.toHaveBeenCalled(); // No bridge writes on open.
    await queryFooterActions(events)["mcp.open"]!.run();
    // Exercise the real TUI input dispatcher, not the manager's handleInput directly.
    (tui as any).handleTerminalInput("\x1b");
    await opened;
    expect(tui.getFocusedComponent()).toBe(editor);
    expect(container.children).toEqual([editor]);
    expect(editor.getExpandedText()).toBe("unsent\n界 draft");
    // SDK custom UI restores the original text once on close; the bridge never replaces it.
    expect(setText.mock.calls).toEqual([["unsent\n界 draft"]]);
    expect(setEditorText).not.toHaveBeenCalled(); expect(pasteToEditor).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });

  test("physical splash selections report a rejected model switch without a fake success", async () => {
    const f = await fixture();
    const message = "The model switch was rejected.";
    const pi = { setModel: vi.fn(async () => { throw new Error(message); }), setThinkingLevel: vi.fn(), getThinkingLevel: () => "medium" };
    const host = attachStartupHost(f.mode);
    cleanup.push(() => disposeStartupHost(f.mode));
    Object.assign(f.ctx, { model: { provider: "test", id: "old" }, modelRegistry: { find: () => ({ provider: "test", id: "new" }) } });
    Object.assign(f.mode, { showStatus: vi.fn(), updateEditorBorderColor: vi.fn(), updateAvailableProviderCount: vi.fn() });
    const controller = createSplashActionController(pi as any, f.mode, host);
    await controller.activate({ kind: "model", provider: "test", id: "new", thinkingLevel: "high" });
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(f.ui.notify).toHaveBeenCalledWith(`Unable to switch model test/new: ${message}`, "error");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(f.mode.showStatus).not.toHaveBeenCalled();
    expect(f.mode.updateEditorBorderColor).not.toHaveBeenCalled();
    expect(f.mode.updateAvailableProviderCount).not.toHaveBeenCalled();
    expect(host.actionBusy).toBe(false);
    noDraftWrites(f);
  });
});
