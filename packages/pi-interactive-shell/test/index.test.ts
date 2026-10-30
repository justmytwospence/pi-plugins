import { afterEach, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { AgentSession, createEventBus, ExtensionRunner, InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Container } from "@earendil-works/pi-tui";
import interactiveShell from "../src/index.ts";
import * as handoffModule from "../src/handoff.ts";
import * as ptyModule from "../src/pty.ts";

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, original] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
    if (original) Object.defineProperty(stream, "isTTY", original);
    else delete (stream as any).isTTY;
  }
});

function harness(overrides: any = {}) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const handlers = new Map<string, any>();
  const events = new Map<string, any>();
  const commands = new Map<string, any>();
  const chat = new Container(), document = new Container(), root = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat); root.addChild(document);
  const tui = Object.assign(root, { requestRender: vi.fn() });
  const pi = { registerCommand: (key: string, value: any) => commands.set(key, value), sendMessage: vi.fn(), on: (key: string, fn: any) => handlers.set(key, fn), events: {
    on: (key: string, fn: any) => events.set(key, fn), emit: vi.fn(),
  } };
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true,
    ui: { setWidget: vi.fn((_key: string, factory: any) => factory?.(tui)), notify: vi.fn(),
      custom: vi.fn((factory: any) => new Promise(resolve => { factory(tui, {}, {}, resolve); })) }, ...overrides };
  interactiveShell(pi as any);
  handlers.get("session_start")({}, ctx);
  const bash = (command: string, excludeFromContext = false) => handlers.get("user_bash")({ command, cwd: "/session/cwd", excludeFromContext }, ctx);
  const accept = (text = "!i true") => events.get("interactive-shell:suggestion-accepted")({ text });
  return { ctx, handlers, events, pi, bash, accept, tui, commands };
}

test("ordinary bang commands pass through, including ones named id/install", async () => {
  const h = harness();
  expect(await h.bash("id")).toBeUndefined();
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
});

test.each([false, true])("explicit handoffs are inline and use event cwd; Pi owns exclusion=%s", async (exclude) => {
  const result = { output: "status only", exitCode: 0, cancelled: false, truncated: false as const };
  const spy = vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done, _autoClose, _inline, onStarted) => {
    onStarted?.();
    queueMicrotask(() => done(result));
    return {} as any;
  });
  const h = harness();
  expect(await h.bash("i sudo true", exclude)).toEqual({ result });
  expect(spy).toHaveBeenCalledWith(h.tui, {}, "sudo true", "/session/cwd", expect.any(Function), true, true, expect.any(Function));
  expect(h.ctx.ui.custom.mock.calls[0][1].overlay).toBe(false);
  expect(h.ctx.ui.custom).toHaveBeenCalledOnce();
  const reply = vi.fn(); h.events.get("interactive-shell:inspect")({ reply });
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ lastHandoff: "inline (document-root)" }));
  expect(h.pi.events.emit).toHaveBeenCalledWith("prompt:clear", {});
});

test.each([{ mode: "rpc" }, { mode: "print", hasUI: false }, { isIdle: () => false }])("rejects unsupported or busy contexts without executing (%j)", async (overrides) => {
  const h = harness(overrides);
  expect((await h.bash("i true")).result.exitCode).toBe(1);
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
});

test("rejects empty commands and missing terminals", async () => {
  const h = harness();
  expect((await h.bash("i")).result.output).toContain("usage");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  expect((await h.bash("i true")).result.output).toContain("interactive terminal");
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
});

test("agent starts wait for panel dismissal; reload stops the panel", async () => {
  const result = { output: "stopped", exitCode: 130, cancelled: true, truncated: false as const };
  let finish!: (value: typeof result) => void;
  const shutdown = vi.fn(async () => { finish(result); });
  vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done, _autoClose, _inline, onStarted) => {
    onStarted?.();
    finish = done; return { shutdown } as any;
  });
  const h = harness();
  const running = h.bash("i true");
  await Promise.resolve();
  expect((await h.bash("i another-command")).result.exitCode).toBe(1);
  let started = false;
  const start = h.handlers.get("before_agent_start")().then(() => { started = true; });
  await Promise.resolve();
  expect(started).toBe(false);
  await h.handlers.get("session_shutdown")();
  await Promise.all([running, start]);
  expect(shutdown).toHaveBeenCalledOnce();
  expect(started).toBe(true);
});

test("capability is session-scoped and absent outside TUI", async () => {
  const h = harness();
  const reply = vi.fn();
  h.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
  await h.handlers.get("session_shutdown")();
  h.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
  const rpc = harness({ mode: "rpc" });
  rpc.events.get("interactive-shell:probe")({ reply });
  expect(reply).toHaveBeenCalledOnce();
});

test("inspect and status report safe live metadata without starting a process", async () => {
  const spy = vi.spyOn(handoffModule, "handoff");
  const h = harness();
  const reply = vi.fn();
  h.events.get("interactive-shell:inspect")({ reply });
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ available: true, layout: "inline", source: "document-root", lastHandoff: "none" }));
  await h.commands.get("interactive-shell").handler("status", h.ctx);
  expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('"layout":"inline"'), "info");
  await h.commands.get("interactive-shell").handler("", h.ctx);
  expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /interactive-shell status", "warning");
  h.tui.clear();
  h.events.get("interactive-shell:inspect")({ reply });
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ available: false, layout: "unsupported", reason: expect.any(String), shape: expect.any(Object) }));
  const probe = vi.fn(); h.events.get("interactive-shell:probe")({ reply: probe });
  expect(probe).not.toHaveBeenCalled();
  expect(spy).not.toHaveBeenCalled();
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
});

test("before-first-frame capability uses nested mounted primary and follows renderer changes", () => {
  const h = harness();
  const document = h.tui.children[0];
  Object.assign(h.tui, { mode: "fullscreen", getPrimaryScrollView: () => ({ child: { render: () => [], invalidate() {} } }),
    layoutRoot: { entries: [{ component: { children: [{ primary: true, child: document, scrollTo() {} }] } }] } });
  h.tui.clear();
  const reply = vi.fn(); h.events.get("interactive-shell:inspect")({ reply });
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ available: true, source: "primary-scroll-view", rendererMode: "fullscreen" }));
  const probe = vi.fn(); h.events.get("interactive-shell:probe")({ reply: probe }); expect(probe).toHaveBeenCalledOnce();
  Object.assign(h.tui, { layoutRoot: undefined });
  h.events.get("interactive-shell:probe")({ reply: probe }); expect(probe).toHaveBeenCalledOnce();
});

const completed = { output: "status only", exitCode: 0, cancelled: false, truncated: false as const };
const nextImmediate = () => new Promise<void>(resolve => setImmediate(resolve));
function completeHandoffs(result = completed) {
  return vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done, _autoClose, _inline, onStarted) => {
    onStarted?.();
    queueMicrotask(() => done(result));
    return {} as any;
  });
}

test.each([
  ["!i true", "i true", false, true],
  ["!i true", "i true ", false, false],
  ["!i true", "i false", false, false],
  ["!i  true", "i true", false, false],
  ["!i true", "i true", true, false],
  ["!!i true", "i true", false, false],
])("accepted draft %j matches submitted %j (excluded=%s) only exactly", async (draft, command, excluded, matched) => {
  const spy = completeHandoffs();
  const h = harness();
  h.accept(draft as string);
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  await h.bash(command as string, excluded as boolean);
  expect(spy.mock.calls[0].slice(5)).toEqual([true, true, expect.any(Function)]);
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  await nextImmediate();
  expect(h.pi.sendMessage).toHaveBeenCalledTimes(matched ? 1 : 0);
});

test.each([completed, { ...completed, exitCode: 7 }, { ...completed, exitCode: 130, cancelled: true }])("matched completion schedules exactly one hidden status-only turn: %j", async result => {
  completeHandoffs(result);
  const h = harness();
  h.accept();
  await h.bash("i true");
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  await nextImmediate();
  expect(h.pi.sendMessage).toHaveBeenCalledExactlyOnceWith({
    customType: "interactive-shell-continuation",
    content: expect.stringMatching(/exit status.*output was not captured/), display: false,
  }, { triggerTurn: true });
  await nextImmediate();
  expect(h.pi.sendMessage).toHaveBeenCalledOnce();
  await h.bash("i true");
  await nextImmediate();
  expect(h.pi.sendMessage).toHaveBeenCalledOnce();
});

test.each(["input", "session_tree", "session_start", "session_shutdown", "user_bash"])("accepted marker is consumed on %s", async event => {
  const spy = completeHandoffs();
  const h = harness();
  h.accept();
  if (event === "user_bash") await h.bash("id");
  else await h.handlers.get(event)({}, h.ctx);
  if (event === "session_shutdown") await h.handlers.get("session_start")({}, h.ctx);
  await h.bash("i true");
  expect(spy.mock.calls[0].slice(5)).toEqual([true, true, expect.any(Function)]);
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

test("prompt clearing resets the suggestion offer without erasing the captured match", async () => {
  const spy = completeHandoffs();
  const h = harness();
  let offer: string | undefined = "!i true";
  h.pi.events.emit.mockImplementation((event: string) => {
    if (event === "prompt:clear") offer = undefined;
  });
  h.accept(offer);
  await h.bash("i true");
  expect(offer).toBeUndefined();
  expect(spy.mock.calls[0].slice(5)).toEqual([true, true, expect.any(Function)]);
  await nextImmediate();
  expect(h.pi.sendMessage).toHaveBeenCalledOnce();
});

test.each([
  { mode: "rpc" }, { mode: "print", hasUI: false }, { isIdle: () => false },
])("accepted commands cannot resume in unavailable or busy contexts: %j", async overrides => {
  completeHandoffs();
  const h = harness(overrides);
  h.accept();
  await h.bash("i true");
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
  Object.assign(h.ctx, { mode: "tui", hasUI: true, isIdle: () => true });
  await h.bash("i true");
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

test.each([undefined, null, {}, { text: 42 }, { text: "!!i true" }, { text: "!true" }])("invalid acceptance payload %j cannot opt a manual command in", async payload => {
  const spy = completeHandoffs();
  const h = harness();
  h.events.get("interactive-shell:suggestion-accepted")(payload);
  await h.bash("i true");
  expect(spy.mock.calls[0].slice(5)).toEqual([true, true, expect.any(Function)]);
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

test("accepted draft is consumed when a terminal is unavailable", async () => {
  const spy = completeHandoffs();
  const h = harness();
  h.accept();
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  await h.bash("i true");
  expect(spy).not.toHaveBeenCalled();
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  await h.bash("i true");
  expect(spy.mock.calls[0].slice(5)).toEqual([true, true, expect.any(Function)]);
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

test("rejected concurrent handoff consumes its marker and invalidates pending continuation", async () => {
  let finish!: (result: typeof completed) => void;
  const spy = vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done, _autoClose, _inline, onStarted) => {
    onStarted?.();
    finish = done; return {} as any;
  });
  const h = harness();
  h.accept();
  const running = h.bash("i true");
  await Promise.resolve();
  h.accept("!i second");
  expect((await h.bash("i second")).result.exitCode).toBe(1);
  expect(spy).toHaveBeenCalledOnce();
  finish(completed);
  await running;
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  const manual = h.bash("i second");
  await Promise.resolve();
  expect(spy.mock.calls[1].slice(5)).toEqual([true, true, expect.any(Function)]);
  finish(completed);
  await manual;
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

test.each(["shutdown", "agent_start", "busy", "session_start", "session_tree"])("deferred continuation is invalidated by %s", async event => {
  completeHandoffs();
  const h = harness();
  h.accept();
  await h.bash("i true");
  if (event === "shutdown") await h.handlers.get("session_shutdown")({}, h.ctx);
  else if (event === "busy") h.ctx.isIdle = () => false;
  else await h.handlers.get(event)({}, h.ctx);
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

test("agent_start during the handoff suppresses continuation even if idle at dismissal", async () => {
  let finish!: (result: typeof completed) => void;
  vi.spyOn(handoffModule, "handoff").mockImplementation((_tui, _theme, _cmd, _cwd, done, _autoClose, _inline, onStarted) => {
    onStarted?.();
    finish = done; return {} as any;
  });
  const h = harness();
  h.accept();
  const running = h.bash("i true");
  await Promise.resolve();
  await h.handlers.get("agent_start")({}, h.ctx);
  finish(completed);
  await running;
  await nextImmediate();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

// Keep Pi's actual trimming/prefix parsing rather than calling user_bash directly.
function submitEditor(h: ReturnType<typeof harness>, text: string) {
  const editor = { onSubmit: undefined as any, setText: vi.fn(), addToHistory: vi.fn() };
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    runtimeHost: { session: { isBashRunning: false } }, defaultEditor: editor, editor,
    handleBashCommand: (command: string, excluded: boolean) => h.bash(command, excluded),
    updateEditorBorderColor: vi.fn(),
  });
  mode.setupEditorSubmitHandler();
  return editor.onSubmit(text);
}

const quotedCommand = "printf '%s' 'keep  these   spaces'";

test.each(["reject", "exit-127"])("actual editor submission preserves quoted spaces with %s spawn", async outcome => {
  const stop = vi.spyOn(ptyModule, "stopPty").mockResolvedValue();
  const dispose = vi.fn();
  const pty = {
    pid: 12345, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: vi.fn(() => ({ dispose })),
    onExit: vi.fn((callback: any) => {
      callback({ exitCode: 127, signal: 0 }); // Exit while startImpl is still attaching listeners.
      return { dispose };
    }),
  };
  const spawn = vi.spyOn(ptyModule, "spawnPty").mockImplementation(async () => {
    if (outcome === "reject") throw new Error("fixture spawn rejected");
    return pty as any;
  });
  const h = harness();
  h.ctx.ui.custom.mockImplementation((factory: any) => new Promise(resolve => {
    factory(h.tui, { fg: (_color: string, text: string) => text }, {}, resolve);
  }));
  h.accept(`!i ${quotedCommand}`);
  await submitEditor(h, `!i ${quotedCommand}`);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(quotedCommand, "/session/cwd", expect.any(Number), expect.any(Number));
  expect(h.ctx.ui.custom).toHaveBeenCalledOnce();
  expect(h.ctx.ui.custom.mock.calls[0][1]).toEqual({ overlay: false });
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  const inspect = vi.fn(); h.events.get("interactive-shell:inspect")({ reply: inspect });
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ lastHandoff: outcome === "reject" ? "none" : "inline (document-root)" }));
  await nextImmediate();
  expect(h.pi.sendMessage).toHaveBeenCalledTimes(outcome === "reject" ? 0 : 1);
  expect(stop).toHaveBeenCalledTimes(outcome === "reject" ? 0 : 1);
  expect(dispose).toHaveBeenCalledTimes(outcome === "reject" ? 0 : 2);
  await nextImmediate();
  expect(h.pi.sendMessage).toHaveBeenCalledTimes(outcome === "reject" ? 0 : 1);
  await h.handlers.get("session_shutdown")();
});

test("shutdown before the real handoff's deferred startup does not spawn or continue", async () => {
  const spawn = vi.spyOn(ptyModule, "spawnPty");
  const h = harness();
  h.ctx.ui.custom.mockImplementation((factory: any) => new Promise(resolve => {
    const proxy = factory(h.tui, { fg: (_color: string, text: string) => text }, {}, resolve);
    proxy.dispose(); // Pi reset disposes the editor-slot proxy before its start microtask.
  }));
  h.accept();
  const submitted = submitEditor(h, "!i true");
  await h.handlers.get("session_shutdown")();
  await submitted;
  await nextImmediate();
  expect(spawn).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  const inspect = vi.fn(); h.events.get("interactive-shell:inspect")({ reply: inspect });
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ lastHandoff: "none", available: false }));
});

test("real Pi loader and interactive bash path record the result before continuation", async () => {
  // No handoff callback mock: jiti loads the extension and its real PTY panel.
  harness(); // Set TTY descriptors (restored by afterEach).
  initTheme("dark", false);
  const cwd = process.cwd();
  const events = createEventBus();
  const loaded = await loadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], cwd, events);
  expect(loaded.errors).toEqual([]);
  const manager = SessionManager.inMemory(cwd);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, {} as any);
  const errors: unknown[] = [];
  runner.onError(error => errors.push(error));
  const command = "printf '%s' 'PRIVATE_DISPLAY  quoted   spaces'; exit 7";
  const sendMessage = vi.fn(() => {
    const messages = manager.getEntries().filter(entry => entry.type === "message");
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).message).toMatchObject({ role: "bashExecution", command: `i ${command}`, exitCode: 7 });
  });
  runner.bindCore({ sendMessage } as any, { isIdle: () => true } as any);
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container()); document.addChild(new Container()); document.addChild(chat);
  const root = new Container(); root.addChild(document);
  const tui = Object.assign(root, { terminal: { columns: 80, rows: 24 }, requestRender() {} });
  let panel: any;
  runner.setUIContext({ setWidget: (_key: string, factory: any) => factory?.(tui), custom: (factory: any) => new Promise(resolve => {
    panel = factory(tui, { fg: (_color: string, text: string) => text }, {}, resolve);
  }) } as any, "tui");
  // Use Pi's actual result recorder and persistent session entries, without an LLM.
  const session = {
    extensionRunner: runner, isStreaming: false, sessionManager: manager,
    recordBashResult: AgentSession.prototype.recordBashResult,
    _refreshFinalizedContext() {},
  };
  const editor = { onSubmit: undefined as any, setText: vi.fn(), addToHistory: vi.fn() };
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    runtimeHost: { session }, ui: tui, outputPad: 0,
    chatContainer: chat, editor, defaultEditor: editor, updateEditorBorderColor: vi.fn(),
  });
  mode.setupEditorSubmitHandler();
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    events.emit("interactive-shell:suggestion-accepted", { text: `!i ${command}` });
    await editor.onSubmit(`!i ${command}`);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(1);
    expect(chat.children).toHaveLength(2); // Frozen terminal precedes Pi's normal status recorder.
    expect(chat.children[0].render(80).join("\n")).toContain("output retained");
    expect(chat.children[0].render(80).join("\n")).toContain("PRIVATE_DISPLAY  quoted   spaces");
    const recorded = manager.getEntries().filter(entry => entry.type === "message").map(entry => (entry as any).message);
    expect(recorded[0].output).not.toContain("PRIVATE_DISPLAY");
    expect(JSON.stringify(manager.getEntries())).not.toContain("output retained");
    await nextImmediate();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      customType: "interactive-shell-continuation", display: false,
    }), { triggerTurn: true });
    expect(errors).toEqual([]);
  } finally {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    await panel?.shutdown?.();
  }
}, 10_000);
