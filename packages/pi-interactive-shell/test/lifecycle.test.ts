import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { createFocusProxy, hideDuplicateStatus, resolveTranscript, TranscriptPanels } from "../src/transcript.ts";
import { TerminalPanel } from "../src/panel.ts";

// The emulator and panel are real; no child process or process-tree signalling.
vi.mock("../src/pty.ts", () => ({ spawnPty: vi.fn(), stopPty: vi.fn(async () => {}) }));

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
const { initTheme, theme } = await runtimeImport("dist/modes/interactive/theme/theme.js");
const { BashExecutionComponent } = await runtimeImport("dist/modes/interactive/components/bash-execution.js");
const { AssistantMessageComponent } = await runtimeImport("dist/modes/interactive/components/assistant-message.js");
const { Container, VStack } = await runtimeImport("node_modules/@earendil-works/pi-tui/dist/index.js");
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

interface Fixture { populated?: boolean; primaryRoot?: boolean; nested?: boolean }

function harness(tuiMode: "regular" | "fullscreen", fixture: Fixture = {}) {
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
  const resumed = { render: () => ["resumed user message", "resumed assistant response"], invalidate() {} };
  if (fixture.populated) chat.addChild(resumed);
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
  const layoutRoot = fixture.nested
    ? new VStack([{ component: new VStack([{ component: viewport.root, grow: 1 }]), grow: 1 }])
    : viewport.root;
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
    fullscreenLayoutRoot: layoutRoot,
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
  // A mounted fullscreen layout need not expose the document as children[0].
  // This real primary ScrollView is deliberately inaccessible to the old lookup.
  mode.mountInteractiveTui(mode.renderer, fixture.primaryRoot
    ? [layoutRoot]
    : [document, pendingMessages, status, widgetsAbove, editorContainer, widgetsBelow, footer]);
  mode.ui.setFocus(editor);
  mode.ui.start();
  return { mode, terminal, editor, editorContainer, chat, document, viewport, resumed };
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
    const resolved = resolveTranscript(tui);
    if (!("chat" in resolved)) throw new Error(`Transcript resolution failed: ${resolved.reason}`);
    expect(resolved.source).toBe(h.mode.renderer.mode === "fullscreen" ? "primary-scroll-view" : "document-root");
    resolved.chat.addChild(panel);
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
  for (const nested of renderer === "fullscreen" ? [false, true] : [false]) {
    runtimeTest(`${renderer}: populated${nested ? " nested" : ""} transcript retains head/tail without a duplicate bash card before the assistant reply`, async () => {
      const h = harness(renderer, { populated: true, primaryRoot: renderer === "fullscreen", nested });
      const panels = new TranscriptPanels();
      let data!: (text: string) => void;
      let exit!: (event: { exitCode: number; signal: number }) => void;
      const dispose = vi.fn();
      const pty = {
        pid: 12345, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
        onData: (callback: typeof data) => { data = callback; return { dispose }; },
        onExit: (callback: typeof exit) => { exit = callback; return { dispose }; },
      };
      let panel!: TerminalPanel;
      let snapshot: unknown;
      let start!: Promise<void>;
      const promise = h.mode.showExtensionCustom((tui: any, _theme: unknown, _keys: unknown, done: any) => {
        const resolved = resolveTranscript(tui);
        if (!("chat" in resolved)) throw new Error(`Transcript resolution failed: ${resolved.reason}`);
        expect(resolved.chat).toBe(h.chat);
        expect(resolved.source).toBe(renderer === "fullscreen" ? "primary-scroll-view" : "document-root");
        if (renderer === "fullscreen") {
          expect(tui.children[0]).not.toBe(h.document);
          // The former first-root-document guard rejects this mounted layout.
          const oldDocument = tui.children[0];
          expect(Array.isArray(oldDocument.children) && oldDocument.children.length === 3 &&
            oldDocument.children.every((child: any) => Array.isArray(child.children) &&
              typeof child.addChild === "function" && typeof child.removeChild === "function")).toBe(false);
        }
        panel = new TerminalPanel(tui, theme, "retained-output-fixture", "/tmp", (result, frozen) => {
          expect(frozen).toBeDefined();
          snapshot = frozen;
          panels.replace(resolved.chat, panel, frozen!);
          hideDuplicateStatus(resolved.chat, frozen!, "i retained-output-fixture", result, () => tui.requestRender());
          done(result);
        }, async () => pty, true, true);
        panels.insert(resolved.chat, panel);
        start = panel.start();
        return createFocusProxy(panel);
      }, { overlay: false });
      try {
        await mounted();
        await start;
        expect(h.chat.children).toEqual([h.resumed, panel]);
        expect(h.editorContainer.render(80)).toEqual([]);
        expect(h.editorContainer.children).not.toContain(h.editor);
        expect(h.mode.renderer.hasOverlayEntries).toBe(false);
        h.mode.ui.renderNow();
        if (renderer === "fullscreen") expect(h.mode.ui.getPrimaryScrollView()?.child).toBe(h.document);
        data(Array.from({ length: 60 }, (_, i) => `retained-row-${String(i + 1).padStart(2, "0")}\r\n`).join(""));
        exit({ exitCode: 0, signal: 0 });
        const result = await promise;
        expect(result).toEqual({ output: "(interactive command exited with code 0)", exitCode: 0, cancelled: false, truncated: false });
        expect(JSON.stringify(result)).not.toContain("retained-row-");
        expect(h.editorContainer.children).toEqual([h.editor]);
        expect(h.editor.getText()).toBe("saved editor draft");
        expect(h.mode.ui.getFocusedComponent()).toBe(h.editor);
        expect(h.chat.children).toEqual([h.resumed, snapshot]);

        // Pi still records/appends its normal status-only result. Only its
        // redundant display is removed while the richer snapshot remains.
        const card = new BashExecutionComponent("i retained-output-fixture", h.mode.ui);
        card.appendOutput(result.output);
        card.setComplete(result.exitCode, result.cancelled);
        h.chat.addChild(card);
        const assistant = new AssistantMessageComponent({
          role: "assistant", content: [{ type: "text", text: "Subsequent assistant response" }],
          api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        });
        h.chat.addChild(assistant);
        await mounted();
        expect(h.chat.children).toEqual([h.resumed, snapshot, assistant]);
        const transcript = h.document.render(80).join("\n");
        for (const marker of ["resumed user message", "retained-row-01", "rows omitted", "retained-row-60", "Subsequent assistant response"]) {
          expect(transcript).toContain(marker);
        }
        expect(transcript).not.toContain(result.output);
        expect(transcript).not.toContain("$ i retained-output-fixture");
        expect(transcript.indexOf("retained-row-60")).toBeLessThan(transcript.indexOf("Subsequent assistant response"));
        h.terminal.setSize(80, 60);
        h.terminal.writes.length = 0;
        h.mode.ui.renderNow();
        const screen = h.terminal.writes.join("");
        expect(screen).toContain("retained-row-01");
        expect(screen).toContain("retained-row-60");
        expect(screen).toContain("Subsequent assistant response");
        expect(h.mode.renderer.hasOverlayEntries).toBe(false);
        expect(h.mode.extensionDialogs).toEqual([]);
        expect(dispose).toHaveBeenCalledTimes(2);
        panels.clear();
        expect(h.chat.children).toEqual([h.resumed, assistant]);
        // A history rebuild has no memory-only snapshot; its native status card
        // must remain visible, with no persistent/global renderer suppression.
        h.chat.addChild(card);
        await mounted();
        expect(h.document.render(80).join("\n")).toContain(result.output);
      } finally {
        if (panel) await panel.shutdown();
        await promise;
        panels.clear();
        h.mode.ui.stop();
      }
    });
  }
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
