/**
 * SDK 1.1.0 integration tests, not a replacement for the engine/oracle tests.
 *
 * The extension is loaded from its .ts entry point by Pi's actual jiti loader.
 * AgentSession.bindExtensions, InteractiveMode's editor/UI wiring, CustomEditor,
 * both renderers, chat layout, focus, overlays and shutdown dispatch are real.
 * Only the terminal transport and process-exiting shutdown endpoint are fakes;
 * the host input callback records submissions instead of starting an agent run.
 *
 * We mount the interactive component tree explicitly instead of calling init():
 * init also installs process signal handlers, downloads managed tools, watches
 * git/theme files and queries provider availability. Those unrelated startup
 * services should not make keyboard tests depend on the machine or network.
 * Input enters through Terminal.start's callback, never private TUI handlers.
 * No harness.ts, false-returning keybindings, paid calls or clipboard processes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEventBus,
  CustomEditor,
  type ExtensionError,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  CURSOR_MARKER,
  getKeybindings,
  setKeybindings,
  type Component,
  type Focusable,
  type ProgramStatus,
  type ScrollView,
  type Terminal,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
// These SDK internals are intentionally imported from the package-local install.
// No installed files are patched; these are the same methods the Pi CLI uses.
import type { ExtensionMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js";
import { KeybindingsManager, type KeybindingsConfig } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { getEditorTheme, initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  EDITOR_FACTORY_CHANNEL,
  EDITOR_MODE,
  EDITOR_SNAPSHOT,
  EDITOR_SURFACE,
  type EditorFactoryOptions,
  type EditorFactoryRequest,
  INPUT_CONTEXT,
  type SuiteEditor,
} from "../src/contract.js";

const ESC = "\x1b";
const CTRL_D = "\x04";
const CTRL_U = "\x15";
const INSERT_SHAPE = "\x1b[5 q";
const BLOCK_SHAPE = "\x1b[1 q";
const RESET_SHAPE = "\x1b[0 q";
const HALF_PAGE_BINDINGS: KeybindingsConfig = {
  "tui.altScreen.halfPageUp": "ctrl+u",
  "tui.altScreen.halfPageDown": "ctrl+d",
};
const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Atomic key events, as already split by ProcessTerminal's StdinBuffer. */
class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  readonly writes: string[] = [];
  private input?: (data: string) => void;
  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.input = onInput;
  }
  stop(): void { this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(lines: number): void {
    if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
  }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J"); }
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
  send(...keys: string[]): void {
    assert.ok(this.input, "the actual TUI must have started the terminal");
    for (const key of keys) this.input(key);
  }
  cursorShapes(): string[] {
    return this.writes.flatMap((data) => data.match(/\x1b\[[015] q/g) ?? []);
  }
}

/** Only an adapter to private SDK methods; it does not implement their behavior. */
type InteractiveAccess = {
  renderer: TuiAltScreen | TuiMainScreen;
  ui: TuiAltScreen | TuiMainScreen;
  editor: CustomEditor & SuiteEditor;
  defaultEditor: CustomEditor;
  keybindings: KeybindingsManager;
  editorContainer: Container;
  documentContainer: Container;
  transcriptScrollView?: ScrollView;
  fullscreenLayoutRoot?: Component;
  setupKeyHandlers(): void;
  setupEditorSubmitHandler(): void;
  onInputCallback?: (text: string) => void;
  setupExtensionShortcuts(runner: AgentSessionRuntime["session"]["extensionRunner"]): void;
  createExtensionUIContext(): ExtensionUIContext;
  shutdown(): Promise<void>;
  toggleToolOutputExpansion(): void;
  switchTuiMode(mode: "regular" | "fullscreen", restoreProgress?: boolean, startRenderer?: boolean): boolean;
};

function isolateEnvironment(t: TestContext, values: Record<string, string>): void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function fixture(
  t: TestContext,
  options: {
    fullscreen?: boolean;
    bindings?: KeybindingsConfig;
    draft?: string;
    extensionMode?: ExtensionMode;
    duplicate?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "pi-vim-sdk-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  isolateEnvironment(t, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" });
  writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify(options.bindings ?? {}));
  // The jiti copy reads SettingsManager.create(cwd), not the injected manager.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    piVim: { clipboardMirror: false, modeChange: {} },
  }));
  const previousKeybindings = getKeybindings();
  t.after(() => setKeybindings(previousKeybindings));
  initTheme("dark", false);

  const bus = createEventBus();
  const extensionPaths = [extensionPath];
  if (options.duplicate) {
    const duplicatePath = join(directory, "duplicate-vim.ts");
    // A distinct jiti entry point imports a second extension instance, just as
    // a mistakenly installed suite/standalone copy would share Pi's EventBus.
    writeFileSync(duplicatePath, `export { default } from ${JSON.stringify(extensionPath)};\n`);
    extensionPaths.push(duplicatePath);
  }
  let shortcutCalls = 0;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const settingsManager = SettingsManager.inMemory({
    theme: "dark", quietStartup: true, showHardwareCursor: false,
    doubleEscapeAction: "none", terminal: { showTerminalProgress: false },
  });
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime, settingsManager,
    resourceLoaderOptions: {
      eventBus: bus, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: extensionPaths,
      extensionFactories: [(pi) => {
        pi.registerShortcut("ctrl+alt+x", { handler: () => { shortcutCalls++; } });
      }],
    },
  });
  const extensionsResult = services.resourceLoader.getExtensions();
  assert.deepEqual(extensionsResult.errors, [], "Pi's actual jiti loader must load src/index.ts");
  assert.ok(extensionsResult.extensions.some((extension) => extension.path === extensionPath));
  const result = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.inMemory(cwd), tools: [],
    // An explicit static catalog model prevents default model/auth discovery.
    model: modelRuntime.getModels()[0], thinkingLevel: "off",
  });
  const runtime = new AgentSessionRuntime(result.session, services, async () => {
    throw new Error("session replacement is outside this keyboard fixture");
  });
  const terminal = new MemoryTerminal();
  const mode = new InteractiveMode(runtime, {
    terminal, tuiMode: options.fullscreen ? "fullscreen" : "regular",
    initialThemeSetting: "dark",
  });
  const interactive = mode as unknown as InteractiveAccess;
  let shutdownCalls = 0;
  let toolToggleCalls = 0;
  // Keep SDK keybinding handlers real, but never call process.exit from a test.
  interactive.shutdown = async () => { shutdownCalls++; };
  interactive.toggleToolOutputExpansion = () => { toolToggleCalls++; };
  const submissions: string[] = [];
  interactive.onInputCallback = (text) => submissions.push(text);
  interactive.setupKeyHandlers();
  interactive.setupEditorSubmitHandler();
  interactive.defaultEditor.setText(options.draft ?? "");

  // Use the CLI's fixed input-dock layout, not a full-height dummy viewport.
  interactive.documentContainer.addChild(new class implements Component {
    render(): string[] { return Array.from({ length: 120 }, (_, i) => `transcript ${i}`); }
    invalidate(): void {}
  }());
  const viewport = createChatViewport({
    document: interactive.documentContainer, editor: interactive.editorContainer,
    pendingMessages: new Container(), status: new Container(), footer: new Container(),
  });
  interactive.transcriptScrollView = viewport.transcript;
  interactive.fullscreenLayoutRoot = viewport.root;
  // The CLI retains its component children in fullscreen too: switchTuiMode
  // copies them into the replacement renderer, while fullscreen renders root.
  interactive.renderer.addChild(interactive.documentContainer);
  interactive.renderer.addChild(interactive.editorContainer);
  if (interactive.renderer instanceof TuiAltScreen) interactive.renderer.setLayoutRoot(viewport.root);
  interactive.ui.setFocus(interactive.defaultEditor);
  interactive.ui.start();
  let stopped = false;
  let disposed = false;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    mode.stop();
    // init() was deliberately skipped, so mode.stop() does not stop its TUI.
    interactive.renderer.stop();
  }
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  }
  t.after(async () => { stop(); await dispose(); });
  const errors: ExtensionError[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const ui = interactive.createExtensionUIContext();
  const notify = ui.notify.bind(ui);
  ui.notify = (message, type) => { notifications.push({ message, type }); notify(message, type); };
  function requestFactory(): EditorFactoryRequest {
    const request: EditorFactoryRequest = { version: 1 };
    bus.emit(EDITOR_FACTORY_CHANNEL, request);
    return request;
  }
  assert.equal(requestFactory().factory, undefined, "loading must not activate session resources");
  const extensionMode = options.extensionMode ?? "tui";
  await runtime.session.bindExtensions({
    uiContext: extensionMode === "tui" || extensionMode === "rpc" ? ui : undefined,
    mode: extensionMode, onError: (error) => errors.push(error),
    shutdownHandler: () => { shutdownCalls++; },
  });
  interactive.setupExtensionShortcuts(runtime.session.extensionRunner);
  assert.deepEqual(errors, [], "session_start must succeed through the real ExtensionRunner");
  interactive.renderer.renderNow();
  const main = interactive.editor;
  if (extensionMode === "tui") assert.equal(main[EDITOR_SURFACE], "main");
  const frame = () => interactive.renderer.renderNow();
  const send = (...keys: string[]) => { terminal.send(...keys); frame(); };
  return {
    terminal, runtime, mode, interactive, ui, main, viewport: viewport.transcript,
    errors, notifications, submissions, requestFactory, frame, send, stop, dispose,
    get shutdownCalls() { return shutdownCalls; },
    get toolToggleCalls() { return toolToggleCalls; },
    get shortcutCalls() { return shortcutCalls; },
  };
}

/** A real focusable consumer, with the IME propagation required by SDK docs. */
class EmbeddedPanel implements Component, Focusable {
  constructor(readonly editor: SuiteEditor) {}
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  [INPUT_CONTEXT](): "editor" { return "editor"; }
  [EDITOR_SURFACE] = "embedded" as const;
  [EDITOR_MODE]() { return this.editor[EDITOR_MODE](); }
  handleInput(data: string): void { this.editor.handleInput(data); }
  render(width: number): string[] { return this.editor.render(width); }
  invalidate(): void { this.editor.invalidate(); }
  dispose(): void { this.editor.dispose(); }
}

async function openEmbedded(
  f: Awaited<ReturnType<typeof fixture>>,
  options: Partial<EditorFactoryOptions> = {},
  overlay = false,
) {
  let panel!: EmbeddedPanel;
  let close!: (value: string) => void;
  const result = f.ui.custom<string>((tui, _theme, keybindings, done) => {
    close = done;
    const request = f.requestFactory();
    assert.equal(request.provider, "pi-vim");
    assert.ok(request.factory, "real EventBus request must be answered synchronously");
    panel = new EmbeddedPanel(request.factory({
      ...options, surface: "embedded", tui, theme: getEditorTheme(), keybindings,
    }));
    return panel;
  }, overlay ? { overlay: true, overlayOptions: { width: 60 } } : undefined);
  // showExtensionCustom awaits the factory before mounting and assigning focus.
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.frame();
  assert.equal(f.interactive.ui.getFocusedComponent(), panel);
  assert.equal(panel.focused, true);
  assert.equal(f.main.focused, false);
  return { panel, editor: panel.editor, result, close };
}

describe("Pi SDK 1.1.0 loader and terminal input lifecycle", { concurrency: false }, () => {
  it("uses the package-local 1.1.0 SDKs, not a test reimplementation", () => {
    for (const name of ["pi-coding-agent", "pi-tui"]) {
      const path = new URL(`../node_modules/@earendil-works/${name}/package.json`, import.meta.url);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).version, "1.1.0");
    }
  });

  it("CustomEditor gives default Ctrl+D to app.exit only on an empty buffer", (t) => {
    initTheme("dark", false);
    const previous = getKeybindings();
    const keybindings = new KeybindingsManager();
    setKeybindings(keybindings);
    t.after(() => setKeybindings(previous));
    const terminal = new MemoryTerminal();
    const tui = new TuiMainScreen(terminal);
    t.after(() => tui.stop());
    const editor = new CustomEditor(tui, getEditorTheme(), keybindings);
    let exits = 0;
    editor.onCtrlD = () => { exits++; };
    tui.addChild(editor);
    tui.setFocus(editor);
    tui.start();
    terminal.send(CTRL_D);
    assert.equal(exits, 1);
    editor.setText("abc");
    terminal.send("\x1b[H", CTRL_D);
    assert.equal(editor.getText(), "bc");
    assert.equal(exits, 1);
  });

  it("SDK fullscreen bindings run before later listeners and before the focused editor", (t) => {
    initTheme("dark", false);
    const previous = getKeybindings();
    const keybindings = new KeybindingsManager(HALF_PAGE_BINDINGS);
    setKeybindings(keybindings);
    t.after(() => setKeybindings(previous));
    const terminal = new MemoryTerminal();
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
    t.after(() => tui.stop());
    const editor = new CustomEditor(tui, getEditorTheme(), keybindings);
    const dock = new Container();
    dock.addChild(editor);
    const document = new Container();
    document.addChild({ render: () => Array.from({ length: 100 }, (_, i) => `line ${i}`), invalidate() {} });
    const { root, transcript } = createChatViewport({
      document, editor: dock, pendingMessages: new Container(), status: new Container(), footer: new Container(),
    });
    tui.setLayoutRoot(root);
    tui.setFocus(editor);
    const laterInputs: string[] = [];
    tui.addInputListener((data) => { laterInputs.push(data); return undefined; });
    tui.start();
    tui.renderNow();
    const start = tui.viewportTop;
    const halfPage = Math.max(1, Math.floor(transcript.viewportHeight / 2));
    terminal.send(CTRL_U);
    assert.equal(tui.viewportTop, start - halfPage);
    assert.deepEqual(laterInputs, [], "even a later consuming extension listener is too late");
    assert.equal(editor.getText(), "");
    const afterUp = tui.viewportTop;
    terminal.send("\x1b[100;5:3u"); // Kitty Ctrl+D release
    assert.equal(tui.viewportTop, afterUp, "release events are consumed but must not scroll");
    terminal.send(CTRL_D);
    assert.equal(tui.viewportTop, start);
    assert.deepEqual(laterInputs, []);
  });

  it("jiti installs the main editor with real callback and app-action inheritance", async (t) => {
    const f = await fixture(t, { draft: "carried draft" });
    assert.equal(f.main.getText(), "carried draft");
    assert.ok(f.ui.getEditorComponent());
    assert.ok(f.main.actionHandlers instanceof Map, "SDK uses duck typing across jiti boundaries");
    assert.ok(f.main.actionHandlers.has("app.clear"));
    assert.equal(typeof f.main.onCtrlD, "function");
    assert.equal(typeof f.main.onSubmit, "function");
    assert.equal(f.main.onSubmit, f.interactive.defaultEditor.onSubmit);
    assert.equal(f.main[INPUT_CONTEXT](), "editor");
    assert.equal(f.main[EDITOR_MODE]().state, "insert");
    assert.equal(f.main.focused, true);
    f.send("\x0f"); // app.tools.expand
    assert.equal(f.toolToggleCalls, 1);
    f.send("\x1b[120;7u"); // ctrl+alt+x, registered through actual ExtensionAPI
    assert.equal(f.shortcutCalls, 1);
    assert.equal(f.main.getText(), "carried draft");
  });

  for (const fullscreen of [false, true]) {
    it(`main Ctrl+D preserves default Insert app.exit, not idle Normal exit (${fullscreen ? "fullscreen" : "regular"})`, async (t) => {
      const f = await fixture(t, { fullscreen });
      f.send(CTRL_D);
      assert.equal(f.shutdownCalls, 1, "empty Insert must retain the SDK's default exit");
      f.send(ESC);
      const text = f.main.getText();
      f.send(CTRL_U, CTRL_D);
      assert.equal(f.shutdownCalls, 1, "idle Normal half-page keys must never reach app.exit");
      assert.equal(f.main.getText(), text);
      assert.equal(f.main[EDITOR_MODE]().state, "normal");
    });
  }

  it("main default fullscreen half-page motion matches the SDK's transcript viewport, not total terminal height", async (t) => {
    const f = await fixture(t, { fullscreen: true, draft: "draft" });
    f.send(ESC);
    const renderer = f.interactive.renderer;
    assert.ok(renderer instanceof TuiAltScreen);
    const halfPage = Math.max(1, Math.floor(f.viewport.viewportHeight / 2));
    assert.ok(f.viewport.viewportHeight < f.terminal.rows, "fixed editor dock must reduce transcript height");
    const start = renderer.viewportTop;
    f.send(CTRL_U);
    assert.equal(renderer.viewportTop, start - halfPage);
    f.send(CTRL_D);
    assert.equal(renderer.viewportTop, start);
    assert.equal(f.main.getText(), "draft");
    assert.equal(f.shutdownCalls, 0);
  });

  it("default fullscreen half-page keys leave Insert, Visual, EX and pending input with the editor", async (t) => {
    const f = await fixture(t, { fullscreen: true, draft: "alpha" });
    const renderer = f.interactive.renderer;
    assert.ok(renderer instanceof TuiAltScreen);
    const start = renderer.viewportTop;
    f.send(CTRL_U);
    assert.equal(f.main.getText(), "", "Insert Ctrl+U must keep native delete-to-line-start");
    assert.equal(renderer.viewportTop, start);
    for (const prefix of [[ESC, "v"], [ESC, ":"], [ESC, "d"], [ESC, "2"]]) {
      f.main[EDITOR_SNAPSHOT].restore({ version: 1, text: "alpha", cursor: { line: 0, col: 0 }, mode: "insert" });
      f.send(...prefix);
      assert.notEqual(f.main[EDITOR_MODE]().state, "normal");
      f.send(CTRL_U);
      assert.equal(renderer.viewportTop, start, "non-idle modal states must not scroll the transcript");
    }
    assert.equal(f.shutdownCalls, 0);
  });

  for (const fullscreen of [false, true]) {
    it(`embedded custom UI owns local input and restores focus/disposes (${fullscreen ? "fullscreen overlay" : "regular"})`, async (t) => {
      const f = await fixture(t, { fullscreen, draft: "main draft" });
      f.send(ESC);
      const mainSnapshot = f.main[EDITOR_SNAPSHOT].capture();
      const directions: number[] = [];
      let cancels = 0;
      const local = await openEmbedded(f, {
        initialText: "local draft", scrollViewport: (direction) => directions.push(direction),
        onCancel: () => { cancels++; },
      }, fullscreen);
      assert.equal(local.editor[EDITOR_SURFACE], "embedded");
      assert.ok(local.editor.render(60).some((line) => line.includes(CURSOR_MARKER)));
      const terminalShapes = f.terminal.cursorShapes();
      assert.equal(terminalShapes.at(-1), INSERT_SHAPE);
      f.send(ESC, CTRL_U, CTRL_D);
      assert.deepEqual(directions, [-1, 1]);
      assert.equal(f.terminal.cursorShapes().at(-1), BLOCK_SHAPE);
      f.send("d", ESC); // first Escape drops a pending operator, does not cancel
      assert.equal(cancels, 0);
      f.send("v", ESC); // first Escape leaves Visual, does not cancel
      assert.equal(cancels, 0);
      f.send(":", "q", "!", "\r");
      assert.equal(cancels, 1);
      assert.equal(f.shutdownCalls, 0);
      assert.deepEqual(f.main[EDITOR_SNAPSHOT].capture(), mainSnapshot);
      local.close("closed");
      assert.equal(await local.result, "closed");
      assert.equal(f.main.focused, true);
      assert.equal(local.editor.focused, false);
      assert.equal(f.interactive.ui.getFocusedComponent(), f.main);
      f.frame();
      assert.ok(f.terminal.cursorShapes().includes(RESET_SHAPE), "ctx.ui.custom must call component.dispose");
      assert.equal(f.terminal.cursorShapes().at(-1), BLOCK_SHAPE, "focused main editor must regain cursor shape");
      const writes = f.terminal.writes.length;
      local.editor.dispose();
      assert.equal(f.terminal.writes.length, writes, "embedded cleanup must be idempotent");
    });
  }

  it("configured fullscreen half-page bindings defer to a focused SDK overlay's local editor", async (t) => {
    const f = await fixture(t, { fullscreen: true, bindings: HALF_PAGE_BINDINGS });
    const directions: number[] = [];
    const local = await openEmbedded(f, {
      initialMode: "normal", scrollViewport: (direction) => directions.push(direction),
    }, true);
    const renderer = f.interactive.renderer;
    assert.ok(renderer instanceof TuiAltScreen);
    const start = renderer.viewportTop;
    f.send(CTRL_U, CTRL_D);
    assert.deepEqual(directions, [-1, 1]);
    assert.equal(renderer.viewportTop, start);
    assert.equal(f.shutdownCalls, 0);
    local.close("closed");
    await local.result;
  });

  it("an embedded editor without a viewport consumes half-page input locally and never borrows main app handlers", async (t) => {
    const f = await fixture(t, { draft: "main draft" });
    const local = await openEmbedded(f, { initialMode: "normal" });
    f.send(CTRL_U, CTRL_D, "\x0f", "\x1b[120;7u");
    assert.equal(f.shutdownCalls, 0);
    assert.equal(f.toolToggleCalls, 0);
    assert.equal(f.shortcutCalls, 0);
    assert.equal(f.main.getText(), "main draft");
    assert.equal(local.editor.getText(), "");
    local.close("closed");
    await local.result;
  });

  it("unfocused embedded rendering cannot shape or claim the hardware cursor", async (t) => {
    const f = await fixture(t);
    f.send(ESC);
    const request = f.requestFactory();
    assert.ok(request.factory);
    const unused = request.factory({
      surface: "embedded", tui: f.interactive.ui, theme: getEditorTheme(), keybindings: f.interactive.keybindings,
    });
    const before = f.terminal.cursorShapes();
    unused.render(60);
    assert.deepEqual(f.terminal.cursorShapes(), before);
    assert.equal(unused.focused, false);
    unused.dispose();
    assert.deepEqual(f.terminal.cursorShapes(), before, "never-focused editors must not reset another editor's cursor");
  });

  it("configured fullscreen CtrlU/D reach Insert, edit EX and cancel pending without native viewport scrolling", async (t) => {
    const f = await fixture(t, { fullscreen: true, bindings: HALF_PAGE_BINDINGS, draft: "alpha" });
    const renderer = f.interactive.renderer;
    assert.ok(renderer instanceof TuiAltScreen);
    const start = renderer.viewportTop;
    f.send(CTRL_U);
    assert.equal(f.main.getText(), "", "configured native binding must not steal Insert delete-to-line-start");
    assert.equal(renderer.viewportTop, start);
    f.main[EDITOR_SNAPSHOT].restore({ version: 1, text: "alpha", cursor: { line: 0, col: 0 }, mode: "insert" });
    f.send(CTRL_D);
    assert.equal(f.main.getText(), "lpha", "configured native binding must not steal Insert delete-char-forward");
    assert.equal(renderer.viewportTop, start);
    for (const key of [CTRL_U, CTRL_D]) {
      for (const prefix of [["2"], ["d"], ["g"], ["r"], ["f"], [":", "w"]]) {
        f.main[EDITOR_SNAPSHOT].restore({ version: 1, text: "", cursor: { line: 0, col: 0 }, mode: "normal" });
        f.send(...prefix);
        assert.ok(["pending", "ex"].includes(f.main[EDITOR_MODE]().state));
        f.send(key);
        const ex = prefix[0] === ":";
        assert.equal(f.main[EDITOR_MODE]().state, ex ? "ex" : "normal", "EX stays open; pending commands cancel locally");
        if (ex) assert.equal(f.main[EDITOR_MODE]().ex, key === CTRL_U ? "" : "w");
        assert.equal(f.main[EDITOR_MODE]().pending, "");
        assert.equal(renderer.viewportTop, start, "SDK viewport listener must defer before it can scroll");
        assert.equal(f.shutdownCalls, 0, "an empty count or EX draft must not redispatch Ctrl+D to app.exit");
      }
    }
  });

  it("configured fullscreen CtrlU/D stay local in a non-overlay embedded editor", async (t) => {
    const f = await fixture(t, { fullscreen: true, bindings: HALF_PAGE_BINDINGS });
    const directions: number[] = [];
    const local = await openEmbedded(f, {
      initialText: "alpha", scrollViewport: (direction) => directions.push(direction),
    });
    const renderer = f.interactive.renderer;
    assert.ok(renderer instanceof TuiAltScreen);
    const start = renderer.viewportTop;
    f.send(CTRL_U);
    assert.equal(local.editor.getText(), "");
    assert.equal(renderer.viewportTop, start);
    f.send(ESC, CTRL_U, CTRL_D);
    assert.deepEqual(directions, [-1, 1], "non-overlay focus must be recognized through its input-context marker");
    assert.equal(renderer.viewportTop, start);
    f.send("2", CTRL_D);
    assert.equal(local.editor[EDITOR_MODE]().state, "normal");
    assert.deepEqual(directions, [-1, 1]);
    assert.equal(f.shutdownCalls, 0);
    local.close("closed");
    await local.result;
  });

  it("the fullscreen guard preserves native viewport keys for unknown/list/filter/viewer focus", async (t) => {
    const f = await fixture(t, { fullscreen: true, bindings: HALF_PAGE_BINDINGS });
    const renderer = f.interactive.renderer;
    assert.ok(renderer instanceof TuiAltScreen);
    for (const context of [undefined, "list", "filter", "viewer"] as const) {
      let close!: (value: void) => void;
      const inputs: string[] = [];
      const component = {
        focused: false,
        ...(context === undefined ? {} : { [INPUT_CONTEXT]: () => context }),
        render: () => ["local view", "", ""],
        invalidate() {},
        handleInput: (data: string) => { inputs.push(data); },
      };
      const result = f.ui.custom<void>((_tui, _theme, _keys, done) => {
        close = done;
        return component;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.frame();
      assert.equal(renderer.getFocusedComponent(), component);
      const start: number = renderer.viewportTop;
      const halfPage = Math.max(1, Math.floor(f.viewport.viewportHeight / 2));
      f.send(CTRL_U);
      assert.equal(renderer.viewportTop, start - halfPage, `${context ?? "unknown"} focus must retain SDK half-page handling`);
      f.send(CTRL_D);
      assert.equal(renderer.viewportTop, start);
      assert.deepEqual(inputs, [], "native viewport handler must still consume these keys");
      close();
      await result;
      f.frame();
    }
  });

  it("embedded app bindings are filtered even if callbacks are installed, while native history/editing survives", async (t) => {
    const f = await fixture(t, { bindings: { "tui.editor.historyPrevious": "ctrl+p" } });
    let cancels = 0;
    const local = await openEmbedded(f, { initialText: "abc", onCancel: () => { cancels++; } });
    const custom = local.editor as SuiteEditor & CustomEditor;
    let appCalls = 0;
    custom.onCtrlD = custom.onPasteImage = custom.onEscape = () => { appCalls++; };
    custom.onAction("app.tools.expand", () => { appCalls++; });
    local.editor[EDITOR_SNAPSHOT].restore({ version: 1, text: "abc", cursor: { line: 0, col: 0 }, mode: "insert" });
    f.send(CTRL_D);
    assert.equal(local.editor.getText(), "bc");
    f.send("\x16", "\x0f");
    assert.equal(appCalls, 0);
    local.editor.setText("");
    f.send(CTRL_D);
    assert.equal(appCalls, 0, "empty embedded Insert Ctrl+D must not match app.exit");
    local.editor.addToHistory("earlier local draft");
    f.send("\x10");
    assert.equal(local.editor.getText(), "earlier local draft", "configured tui.editor.historyPrevious must remain active");
    f.send(ESC, ESC);
    assert.equal(cancels, 1);
    assert.equal(appCalls, 0, "embedded Escape must never reach app.interrupt");
    assert.equal(f.shutdownCalls, 0);
    assert.equal(f.toolToggleCalls, 0);
    local.close("closed");
    await local.result;
  });

  it("SDK custom-dialog draft restoration preserves the main cursor, undo and repeat state", async (t) => {
    const f = await fixture(t, { draft: "draft" });
    f.send(ESC, "0", "x");
    assert.equal(f.main.getText(), "raft");
    const before = f.main[EDITOR_SNAPSHOT].capture();
    const local = await openEmbedded(f, { initialText: "independent local edit" });
    f.send("!", ESC);
    local.close("closed");
    await local.result;
    assert.deepEqual(f.main[EDITOR_SNAPSHOT].capture(), before, "SDK's unchanged setText(savedText) must not reset history or cursor");
    f.send("u");
    assert.equal(f.main.getText(), "draft", "undo must still reach the pre-dialog edit");
    f.send("\x12", ".");
    assert.equal(f.main.getText(), "aft", "redo and dot-repeat must also survive the dialog");
  });

  it("actual main submission and EX quit retain their SDK host endpoints", async (t) => {
    const f = await fixture(t, { draft: "a normal prompt" });
    f.send("\r");
    assert.deepEqual(f.submissions, ["a normal prompt"]);
    f.send(ESC, ":", "q", "\r");
    assert.equal(f.shutdownCalls, 1, "main EX quit must use ctx.shutdown, not a local cancel hook");
  });

  it("real factory requests support both surfaces and reject a captured factory after session restart", async (t) => {
    const f = await fixture(t);
    const request = f.requestFactory();
    assert.ok(request.factory);
    const options: EditorFactoryOptions = {
      surface: "main", tui: f.interactive.ui, theme: getEditorTheme(), keybindings: f.interactive.keybindings,
      initialText: "factory draft", initialMode: "normal",
    };
    const extra = request.factory(options);
    assert.equal(extra[EDITOR_SURFACE], "main");
    assert.equal(extra[EDITOR_MODE]().state, "normal");
    assert.equal(extra.getText(), "factory draft");
    extra.dispose();
    await f.runtime.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual(f.errors, []);
    assert.throws(() => request.factory!(options), /session is no longer active/);
    const fresh = f.requestFactory();
    assert.ok(fresh.factory);
    const embedded = fresh.factory({ ...options, surface: "embedded" });
    assert.equal(embedded[EDITOR_SURFACE], "embedded");
    embedded.dispose();
  });

  for (const extensionMode of ["rpc", "json", "print"] as const) {
    it(`does not install a terminal editor or answer factory discovery in ${extensionMode} mode`, async (t) => {
      const f = await fixture(t, { extensionMode });
      assert.equal(f.runtime.session.extensionRunner.createContext().hasUI, extensionMode === "rpc");
      assert.equal(f.requestFactory().factory, undefined);
      assert.equal(f.ui.getEditorComponent(), undefined);
      assert.equal(f.interactive.editor, f.interactive.defaultEditor);
      assert.equal(f.interactive.renderer.getShowHardwareCursor(), false);
      assert.deepEqual(f.terminal.cursorShapes(), []);
    });
  }

  it("a second jiti-loaded provider warns once and leaves the first SDK editor/factory in place", async (t) => {
    const f = await fixture(t, { duplicate: true, draft: "first owner draft" });
    const warnings = f.notifications.filter(({ message }) => message.includes("another pi-vim editor"));
    assert.equal(warnings.length, 1);
    const main = f.main;
    const firstFactory = f.ui.getEditorComponent();
    const request = f.requestFactory();
    assert.equal(request.provider, "pi-vim");
    assert.ok(request.factory);
    assert.equal(f.interactive.editor, main);
    assert.equal(f.main.getText(), "first owner draft");
    assert.equal(f.ui.getEditorComponent(), firstFactory);
    assert.equal(f.terminal.cursorShapes().filter((shape) => shape === INSERT_SHAPE).length, 1);
    const embedded = request.factory({
      surface: "embedded", tui: f.interactive.ui, theme: getEditorTheme(), keybindings: f.interactive.keybindings,
    });
    embedded.dispose();
    assert.deepEqual(f.errors, []);
  });

  it("renderer replacement rebinds shared cursor/input ownership behind the SDK's stable TUI Proxy", async (t) => {
    const f = await fixture(t, { fullscreen: true, bindings: HALF_PAGE_BINDINGS, draft: "alpha" });
    f.send(ESC);
    const main = f.main;
    for (const mode of ["regular", "fullscreen"] as const) {
      const previous = f.interactive.renderer;
      assert.equal(f.interactive.switchTuiMode(mode, false), true);
      f.frame();
      assert.equal(f.interactive.editor, main, "mode switching must retain the editor and draft");
      assert.equal(main.getText(), "alpha");
      assert.equal(Object.hasOwn(previous, "handleViewportInput"), false, "stopped renderer's guard must be released");
      assert.equal(f.interactive.renderer.getShowHardwareCursor(), true);
      assert.equal(f.terminal.cursorShapes().at(-1), BLOCK_SHAPE);
      f.send(":", "w", CTRL_U, CTRL_D);
      assert.equal(main[EDITOR_MODE]().state, "ex");
      assert.equal(main[EDITOR_MODE]().ex, "");
      f.send(ESC);
    }
    await f.runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    assert.deepEqual(f.errors, []);
    assert.equal(f.interactive.renderer.getShowHardwareCursor(), false,
      "replacement must inherit the original setting, not the previous renderer's Vim-owned true flag");
    assert.equal(Object.hasOwn(f.interactive.renderer, "handleViewportInput"), false);
    assert.equal(f.shutdownCalls, 0);
  });

  it("fullscreen viewport guarding is removed when the last editor is disposed", async (t) => {
    const f = await fixture(t, { fullscreen: true, bindings: HALF_PAGE_BINDINGS });
    const renderer = f.interactive.renderer;
    assert.ok(renderer instanceof TuiAltScreen);
    // Keep a mounted non-modal editor with editor context after the plugin's
    // leases end: native half-page scrolling must work again, even for it.
    const editor = new CustomEditor(f.interactive.ui, getEditorTheme(), f.interactive.keybindings);
    const component: CustomEditor & { [INPUT_CONTEXT]?: () => string } = editor;
    component[INPUT_CONTEXT] = () => "editor";
    f.interactive.editorContainer.clear();
    f.interactive.editorContainer.addChild(editor);
    renderer.setFocus(editor);
    f.frame();
    await f.runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    assert.deepEqual(f.errors, []);
    assert.equal(renderer.getShowHardwareCursor(), false, "reload must restore the last owner's previous hardware setting");
    assert.equal(Object.hasOwn(renderer, "handleViewportInput"), false,
      "the actual renderer's original prototype method must be restored; an empty guard left installed is not cleanup");
    const start = renderer.viewportTop;
    const halfPage = Math.max(1, Math.floor(f.viewport.viewportHeight / 2));
    f.send(CTRL_U);
    assert.equal(renderer.viewportTop, start - halfPage, "native handler must be restored, not left bypassing editor focus");
    assert.equal(f.requestFactory().factory, undefined);
  });

  it("session shutdown disposes outstanding embedded editors and stops answering factory requests", async (t) => {
    const f = await fixture(t);
    const local = await openEmbedded(f);
    assert.equal(f.terminal.cursorShapes().at(-1), INSERT_SHAPE);
    // Normal CLI quit stops rendering before dispatching session_shutdown.
    f.stop();
    await f.dispose();
    assert.equal(f.requestFactory().factory, undefined);
    assert.equal(f.terminal.cursorShapes().at(-1), RESET_SHAPE);
    assert.ok(f.terminal.writes.includes("\x1b[?25h"), "quit must leave the shell's cursor visible");
    const writes = f.terminal.writes.length;
    local.editor.dispose();
    assert.equal(f.terminal.writes.length, writes, "session shutdown must already have disposed it");
    local.close("closed");
    await local.result;
    assert.deepEqual(f.errors, []);
  });
});
