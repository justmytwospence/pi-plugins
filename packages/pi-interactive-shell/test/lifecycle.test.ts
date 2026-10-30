import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { createFocusProxy } from "../src/transcript.ts";

// Deliberately exercise the installed 1.4.0 implementation, not this package's
// older development dependency. These private APIs are the workaround's contract.
function installedRuntime(): string | undefined {
  if (process.env.PI_INTERACTIVE_SHELL_RUNTIME) return process.env.PI_INTERACTIVE_SHELL_RUNTIME;
  try {
    // npm prepends the package's older dev CLI to PATH; inspect all candidates.
    for (const executable of execFileSync("which", ["-a", "pi"], { encoding: "utf8" }).trim().split("\n")) {
      const prefix = dirname(dirname(realpathSync(executable)));
      for (const candidate of [prefix, join(prefix, "libexec/lib/node_modules/@earendil-works/pi-coding-agent")]) {
        try {
          const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
          if (pkg.name === "@earendil-works/pi-coding-agent" && pkg.version === "1.4.0") return candidate;
        } catch { /* Try the next installation layout. */ }
      }
    }
    return undefined;
  } catch { return undefined; }
}
const runtime = installedRuntime();
let compatible = false;
try { compatible = !!runtime && JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).version === "1.4.0"; } catch { /* No matching installed runtime. */ }
const runtimeTest = test.skipIf(!compatible);
const runtimeImport = (relative: string): Promise<any> => compatible
  ? import(/* @vite-ignore */ pathToFileURL(join(runtime!, relative)).href)
  : Promise.resolve({});
const { InteractiveMode } = await runtimeImport("dist/modes/interactive/interactive-mode.js");
const { createInteractiveTui, createInteractiveTuiReference } = await runtimeImport("dist/modes/interactive/tui-renderer.js");
const { createChatViewport } = await runtimeImport("dist/modes/interactive/chat-viewport.js");
const { initTheme } = await runtimeImport("dist/modes/interactive/theme/theme.js");
const { Container } = await runtimeImport("node_modules/@earendil-works/pi-tui/dist/index.js");
if (compatible) initTheme("dark", false);

class FakeTerminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  private input?: (data: string) => void;
  private resize?: () => void;
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.input = undefined; this.resize = undefined; }
  send(data: string) {
    if (!this.input) throw new Error("Renderer has not started the terminal");
    this.input(data);
  }
  setSize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.resize?.();
  }
  write(data: string) { this.writes.push(data); }
  async drainInput() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

function harness(tuiMode: "regular" | "fullscreen") {
  const terminal = new FakeTerminal();
  let text = "saved editor draft";
  const editor = {
    focused: false,
    getText: () => text,
    setText: (value: string) => { text = value; },
    handleInput: vi.fn((data: string) => { text += data; }),
    render: () => [text],
    invalidate() {},
  };
  const document = new Container();
  const chat = new Container();
  document.addChild(new Container()); // header
  document.addChild(new Container()); // resources
  document.addChild(chat);
  const pendingMessages = new Container();
  const status = new Container();
  const widgetsAbove = new Container();
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const widgetsBelow = new Container();
  const footer = new Container();
  const viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove, editor: editorContainer, widgetsBelow, footer });
  // Structural mode avoids constructing an agent/session or accessing a real TTY.
  // Dialog mounting, completion, reset, renderer switching and input routing below
  // are Pi's actual methods; only unrelated session/UI services are stubs.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    renderer: createInteractiveTui({ tuiMode, terminal, showHardwareCursor: false }),
    options: { tuiMode },
    editor,
    defaultEditor: editor,
    editorContainer,
    chatContainer: chat,
    fullscreenLayoutRoot: viewport.root,
    extensionDialogs: [],
    keybindings: {},
    programStatus: { setBlocked: vi.fn() },
    runtimeHost: { session: { settingsManager: {
      getFullscreenCopyOnSelect: () => false,
      getFullscreenWheelScrollLines: () => "auto",
      getShowTerminalProgress: () => false,
    } } },
    themeController: { rebindTui: vi.fn() },
    rebindExtensionTerminalInputListeners: vi.fn(),
    // resetExtensionUI's non-dialog housekeeping is outside this test fixture.
    clearExtensionTerminalInputListeners: vi.fn(),
    setExtensionFooter: vi.fn(),
    setExtensionHeader: vi.fn(),
    clearExtensionWidgets: vi.fn(),
    footerDataProvider: { clearExtensionStatuses: vi.fn() },
    footer: { invalidate: vi.fn() },
    setCustomEditorComponent: vi.fn(),
    setupAutocompleteProvider: vi.fn(),
    updateTerminalTitle: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
  });
  mode.ui = createInteractiveTuiReference(() => mode.renderer);
  mode.mountInteractiveTui(mode.renderer, [document, pendingMessages, status, widgetsAbove, editorContainer, widgetsBelow, footer]);
  mode.ui.setFocus(editor);
  mode.ui.start();
  return { mode, terminal, editor, editorContainer, chat };
}

function openPanel(h: ReturnType<typeof harness>) {
  let complete!: (result: string) => void;
  let stopped = false;
  const panel = {
    focused: false,
    handleInput: vi.fn(),
    render: vi.fn(() => ["live terminal panel"]),
    invalidate: vi.fn(),
    shutdown: vi.fn(async () => {
      if (stopped) return;
      stopped = true;
      // Model the panel's asynchronous, idempotent shutdown completing the
      // dialog. Pi reset itself does NOT invoke the custom completion callback.
      await Promise.resolve();
      complete("stopped");
    }),
    dispose: vi.fn(() => { void panel.shutdown(); }),
  };
  const proxy = createFocusProxy(panel);
  const promise = h.mode.showExtensionCustom((tui: unknown, _theme: unknown, _keys: unknown, done: typeof complete) => {
    expect(tui).toBe(h.mode.ui);
    complete = done;
    h.chat.addChild(panel);
    return proxy;
  }, { overlay: false });
  return { panel, proxy, promise, complete: (result = "exited") => complete(result) };
}

// Wait for showExtensionCustom's Promise.resolve(factory()).then(mount).
const mounted = () => new Promise<void>(resolve => setImmediate(resolve));

runtimeTest("the lifecycle contract requires an installed Pi 1.4.0 (or PI_INTERACTIVE_SHELL_RUNTIME)", () => {
  expect(JSON.parse(readFileSync(join(runtime!, "package.json"), "utf8")).version).toBe("1.4.0");
});

for (const renderer of ["regular", "fullscreen"] as const) {
  runtimeTest(`${renderer}: real custom lifecycle focuses a zero-row inline proxy and restores editor input`, async () => {
    const h = harness(renderer);
    const p = openPanel(h);
    try {
      await mounted();
      expect(h.mode.ui.getFocusedComponent()).toBe(p.proxy);
      expect(p.proxy.focused).toBe(true);
      expect(p.panel.focused).toBe(true);
      expect(h.editor.focused).toBe(false);
      expect((p.proxy as any)[Symbol.for("pi-plugins.input-context.v1")]()).toBe("terminal");
      expect(p.proxy.render(80)).toEqual([]);
      expect(h.editorContainer.render(80)).toEqual([]);
      expect(h.mode.renderer.hasOverlayEntries).toBe(false);
      expect(h.mode.extensionDialogs.map((dialog: any) => dialog.component)).toEqual([p.proxy]);
      p.proxy.invalidate();
      expect(p.panel.invalidate).not.toHaveBeenCalled();
      h.mode.ui.renderNow();
      expect(h.terminal.writes.join("")).toContain("live terminal panel");
      h.terminal.send("x");
      h.terminal.send("\r");
      expect(p.panel.handleInput.mock.calls).toEqual([["x"], ["\r"]]);
      expect(h.editor.handleInput).not.toHaveBeenCalled();
      // Mutating the hidden editor proves close restores its saved text, not
      // merely focus. No terminal input should have reached that editor.
      h.editor.setText("changed while hidden");
      p.complete();
      await expect(p.promise).resolves.toBe("exited");
      expect(h.editor.getText()).toBe("saved editor draft");
      expect(h.editorContainer.children).toEqual([h.editor]);
      expect(h.mode.ui.getFocusedComponent()).toBe(h.editor);
      expect(h.editor.focused).toBe(true);
      expect(p.panel.focused).toBe(false);
      expect(p.panel.dispose).toHaveBeenCalledOnce();
      expect(h.chat.children).toEqual([p.panel]); // Proxy disposal does not remove chat content.
      h.terminal.send("!");
      expect(h.editor.getText()).toBe("saved editor draft!");
      expect(p.panel.handleInput).toHaveBeenCalledTimes(2);
      p.complete("late duplicate");
      expect(p.panel.dispose).toHaveBeenCalledOnce();
    } finally {
      p.complete();
      await p.promise;
      h.mode.ui.stop();
    }
  });

  runtimeTest(`${renderer}: real reset disposes the proxy and panel shutdown resolves pending custom`, async () => {
    const h = harness(renderer);
    const p = openPanel(h);
    const settled = vi.fn();
    void p.promise.then(settled);
    try {
      await mounted();
      expect(settled).not.toHaveBeenCalled();
      h.mode.resetExtensionUI();
      expect(p.panel.dispose).toHaveBeenCalledOnce();
      expect(p.panel.shutdown).toHaveBeenCalledOnce();
      await expect(p.promise).resolves.toBe("stopped");
      expect(settled).toHaveBeenCalledExactlyOnceWith("stopped");
      expect(h.mode.extensionDialogs).toEqual([]);
      expect(h.mode.ui.getFocusedComponent()).toBe(h.editor);
      expect(p.panel.focused).toBe(false);
      expect(h.editor.getText()).toBe("saved editor draft");
      h.terminal.send("r");
      expect(h.editor.getText()).toBe("saved editor draftr");
      expect(p.panel.handleInput).not.toHaveBeenCalled();
      h.mode.resetExtensionUI();
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      p.complete();
      await p.promise;
      h.mode.ui.stop();
    }
  });

  runtimeTest(`${renderer}: real renderer replacement preserves active inline focus and completion`, async () => {
    const h = harness(renderer);
    const p = openPanel(h);
    try {
      await mounted();
      const previous = h.mode.renderer;
      const stableUi = h.mode.ui;
      const requestRender = stableUi.requestRender;
      const next = renderer === "regular" ? "fullscreen" : "regular";
      expect(h.mode.switchTuiMode(next)).toBe(true);
      expect(h.mode.renderer).not.toBe(previous);
      expect(h.mode.renderer.mode).toBe(next);
      expect(h.mode.ui).toBe(stableUi);
      expect(h.mode.ui.getFocusedComponent()).toBe(p.proxy);
      expect(p.proxy.focused).toBe(true);
      expect(p.panel.focused).toBe(true);
      expect(h.mode.renderer.hasOverlayEntries).toBe(false);
      expect(h.editorContainer.render(80)).toEqual([]);
      expect(h.chat.children).toEqual([p.panel]);
      expect(p.panel.dispose).not.toHaveBeenCalled();
      requestRender(); // Cached proxy methods must target the new renderer too.
      h.terminal.setSize(60, 18);
      h.mode.ui.renderNow();
      h.terminal.send("after switch");
      expect(p.panel.handleInput).toHaveBeenCalledExactlyOnceWith("after switch");
      expect(h.editor.handleInput).not.toHaveBeenCalled();
      p.complete();
      await expect(p.promise).resolves.toBe("exited");
      expect(h.mode.ui.getFocusedComponent()).toBe(h.editor);
      h.terminal.send("e");
      expect(h.editor.getText()).toBe("saved editor drafte");
      expect(p.panel.dispose).toHaveBeenCalledOnce();
    } finally {
      p.complete();
      await p.promise;
      h.mode.ui.stop();
    }
  });
}
