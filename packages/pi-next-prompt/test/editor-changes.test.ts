/** Real editor/stash composition. Only the extension API transport is the shared fake. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, SessionManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, TuiMainScreen, type Component, type ProgramStatus, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import nextPrompt from "../src/index.ts";
import { fakeJev, harness } from "./harness.ts";

// Test-only sibling imports keep next-prompt independently installable.
const { MainEditor } = await import(new URL("../../pi-vim/src/main-editor.ts", import.meta.url).href);
const { default: promptStash, STASH_KEY, LEASE } = await import(new URL("../../pi-stash/src/index.ts", import.meta.url).href);
const { createEventBus } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js", import.meta.url).href);
const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
const themeModule = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url).href);
const { initTheme, getEditorTheme } = themeModule;

const SNAPSHOT = Symbol.for("pi-plugins.editor-snapshot.v1");
const DRAFT = "original α draft\n  keep  whitespace";
const PROMPT = "/review one  two";
const COMMAND = "sh -c 'printf \"one  two\"'";
const globals = globalThis as Record<symbol, unknown>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});

/** Atomic events enter through Terminal.start, not editor.handleInput or private TUI methods. */
class MemoryTerminal implements Terminal {
  columns = 110;
  rows = 32;
  kittyProtocolActive = false;
  readonly writes: string[] = [];
  private input?: (data: string) => void;
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(lines: number): void { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
  send(...keys: string[]): void {
    expect(this.input, "the real TUI must own the terminal input callback").toBeTypeOf("function");
    for (const key of keys) this.input!(key);
  }
}

// Do not advance the post-key timers: these assertions require the onChange observer.
const changes = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
type Options = { vim?: boolean; nextFirst?: boolean; fallback?: boolean; stash?: boolean };
async function fixture(options: Options = {}) {
  vi.useFakeTimers();
  const cwd = mkdtempSync(join(tmpdir(), "next-editor-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "next-prompt.json"), JSON.stringify({ jev: { enabled: false } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  vi.stubEnv("XDG_CONFIG_HOME", cwd);
  const priorStash = globals[STASH_KEY], priorLease = globals[LEASE];
  delete globals[STASH_KEY]; delete globals[LEASE];
  const h = harness();
  h.pi.events = createEventBus();
  const jev = fakeJev(() => { throw new Error("editor integration must not call a model"); });
  const ctx = h.ctx({ cwd, modelRegistry: jev.registry, sessionManager: SessionManager.inMemory(cwd), isIdle: () => true });
  h.pi.appendEntry = (customType: string, data: unknown) => {
    h.entries.push({ customType, data });
    ctx.sessionManager.appendCustomEntry(customType, data);
  };
  h.pi.events.on("interactive-shell:inspect", ({ reply }: any) => reply({ available: true, layout: "inline" }));
  initTheme("dark", false);
  const theme = themeModule.theme;
  const terminal = new MemoryTerminal();
  const tui = new TuiMainScreen(terminal, false);
  const keybindings = new KeybindingsManager();
  const editors: any[] = [];
  const widgets = new Map<string, Component>();
  const callbacks: Array<{ receiver: unknown; text: string }> = [];
  const submissions: string[] = [];
  const writes: string[] = [];
  let main: any;
  let defaultEditor: any;
  let factory: any;
  let lines: string[] = [];
  const base = () => {
    const editor = options.vim
      ? new MainEditor(tui, getEditorTheme(), keybindings)
      : new CustomEditor(tui, getEditorTheme(), keybindings);
    if (options.vim) editor.setClipboardMirrorPolicy("never");
    // Exercise fallback with real editor output, just without its optional cursor signal.
    if (options.fallback) {
      const render = editor.render;
      editor.render = function (width: number) {
        return render.call(this, width).map((line: string) => line.replaceAll(CURSOR_MARKER, "").replaceAll("\x1b[7m \x1b[0m", " "));
      };
    }
    editors.push(editor);
    return editor;
  };
  const ui = ctx.ui;
  Object.assign(ui, {
    theme,
    getEditorComponent: () => factory,
    // Like Pi, wire callbacks AFTER the factory returns, preserve text and move focus.
    setEditorComponent: (next: any) => {
      const text = main?.getText() ?? "";
      factory = next;
      main = next ? next(tui, getEditorTheme(), keybindings) : base();
      if (!defaultEditor) {
        defaultEditor = main;
        defaultEditor.onSubmit = (text: string) => { submissions.push(text); };
        defaultEditor.onChange = function (this: unknown, text: string) { callbacks.push({ receiver: this, text }); };
      } else {
        main.onSubmit = defaultEditor.onSubmit;
        main.onChange = defaultEditor.onChange;
      }
      main.setText(text);
      tui.setFocus(main);
    },
    getEditorText: () => main.getText(),
    setEditorText: (text: string) => { writes.push(text); main.setText(text); },
    onTerminalInput: (handler: any) => tui.addInputListener(handler),
    setWidget: (key: string, content: any) => {
      if (typeof content === "function") widgets.set(key, content(tui, theme));
      else if (content === undefined) widgets.delete(key);
      else throw new Error("unexpected non-factory widget");
    },
  });
  ui.setEditorComponent(base);
  const root: Component = {
    render: (width) => { lines = [...main.render(width), ...[...widgets.values()].flatMap(widget => widget.render(width))]; return lines; },
    invalidate: () => { main.invalidate(); for (const widget of widgets.values()) widget.invalidate(); },
  };
  tui.addChild(root);
  tui.start();
  const diagnostics = options.nextFirst === false
    ? (() => { if (options.stash !== false) promptStash(h.pi); return nextPrompt(h.pi); })()
    : (() => { const info = nextPrompt(h.pi); if (options.stash !== false) promptStash(h.pi); return info; })();
  let shutDown = false;
  const shutdown = async () => { if (!shutDown) { shutDown = true; await h.emit("session_shutdown", {}, ctx); } };
  cleanups.push(async () => {
    try { await shutdown(); }
    finally {
      tui.stop();
      for (const editor of editors) editor.dispose?.();
      if (priorStash === undefined) delete globals[STASH_KEY]; else globals[STASH_KEY] = priorStash;
      if (priorLease === undefined) delete globals[LEASE]; else globals[LEASE] = priorLease;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  await h.emit("session_start", {}, ctx);
  await changes();
  callbacks.length = 0;
  const frame = () => { tui.renderNow(true); return lines.join("\n"); };
  const execute = (kind: "prompt" | "terminal" = "prompt", text = kind === "prompt" ? PROMPT : COMMAND) =>
    h.tools.get(`offer_${kind}`).execute("offer", kind === "prompt" ? { text } : { command: text }, undefined, undefined, ctx);
  const take = () => { const request: { text?: string } = {}; h.pi.events.emit("prompt:take-next", request); return request.text; };
  return { h, ctx, ui, terminal, tui, writes, callbacks, submissions, widgets, jev, diagnostics, frame, execute, take, shutdown,
    get main(): any { return main; }, get stash(): any { return globals[STASH_KEY]; } };
}

const compositions = [false, true].flatMap(vim => [false, true].flatMap(nextFirst => [false, true].map(fallback => ({ vim, nextFirst, fallback }))));
for (const options of compositions) {
  const label = `${options.vim ? "Vim" : "native"}, ${options.nextFirst ? "next first" : "stash first"}, ${options.fallback ? "fallback" : "ghost"}`;
  for (const kind of ["prompt", "terminal"] as const) test(`${kind} queues exact text and only actual output enables busy acceptance (${label})`, async () => {
    const f = await fixture(options);
    await f.h.emit("agent_start", {}, f.ctx);
    f.main.setText(DRAFT);
    await changes();
    const text = kind === "prompt" ? PROMPT : `!i ${COMMAND}`;
    const result = await f.execute(kind);
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ status: "queued", kind, text, reason: "editor contains a draft" });
    expect(f.frame()).not.toContain(text);
    expect(f.widgets.size).toBe(0);
    f.terminal.send("\t", "\x1b[C");
    expect(f.take()).toBeUndefined();
    expect(f.ui.getEditorText()).toBe(DRAFT);
    expect(f.writes).toEqual([]);
    expect(f.jev.calls).toEqual([]);
    expect(f.h.messages).toEqual([]);
    f.ui.setEditorText("");
    await changes(); // No key or post-key timer makes the offer visible.
    expect(f.take()).toBeUndefined();
    expect(f.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(0);
    expect(f.frame()).toContain(text);
    await changes();
    expect(f.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
    // Rendering, not agent settlement, is the current copy-to-draft acceptance gate.
    f.terminal.send("\t");
    expect(f.ui.getEditorText()).toBe(text);
    expect(f.writes).toEqual(["", text]);
    expect(f.submissions).toEqual([]);
    expect(f.h.messages).toEqual([]);
  });

  test(`real Ctrl+S restores snapshots, swaps drafts and reveals the retained offer (${label})`, async () => {
    const f = await fixture(options);
    await f.h.emit("agent_start", {}, f.ctx);
    f.main.setText(DRAFT);
    const originalSnapshot = f.main[SNAPSHOT]?.capture();
    expect((await f.execute()).details.status).toBe("queued");
    f.terminal.send("\x13");
    expect(f.ui.getEditorText()).toBe("");
    expect(f.stash.entry.text).toBe(DRAFT);
    expect(f.ctx.ui.status.get("prompt-stash")).toBeTruthy();
    await changes();
    expect(f.frame()).toContain(PROMPT);
    await changes();
    f.terminal.send("\x13");
    expect(f.ui.getEditorText()).toBe(DRAFT);
    if (originalSnapshot) expect(f.main[SNAPSHOT].capture()).toEqual(originalSnapshot);
    // Suppression is synchronous even before the onChange reconciliation microtask.
    expect(f.frame()).not.toContain(PROMPT);
    expect(f.take()).toBeUndefined();
    await changes();
    expect(f.widgets.size).toBe(0);
    f.terminal.send("\x13");
    await changes();
    expect(f.frame()).toContain(PROMPT);
    const other = "second β draft  with spaces";
    f.ui.setEditorText(other);
    expect(f.frame()).not.toContain(PROMPT);
    f.terminal.send("\x13");
    expect(f.ui.getEditorText()).toBe(DRAFT);
    expect(f.stash.entry.text).toBe(other);
    f.terminal.send("\x13");
    expect(f.ui.getEditorText()).toBe(other);
    expect(f.stash.entry.text).toBe(DRAFT);
    f.ui.setEditorText("");
    await changes();
    expect(f.frame()).toContain(PROMPT);
    await changes();
    expect(f.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
    f.terminal.send("\t");
    expect(f.ui.getEditorText()).toBe(PROMPT);
    expect(f.stash.entry.text).toBe(DRAFT);
    expect(f.submissions).toEqual([]);
  });
}

for (const vim of [false, true]) for (const fallback of [false, true]) {
  for (const kind of ["prompt", "terminal"] as const) test(`displayed ${kind} survives programmatic drafts and repeated clears (${vim ? "Vim" : "native"}, fallback=${fallback})`, async () => {
    const f = await fixture({ vim, fallback });
    await f.h.emit("agent_start", {}, f.ctx);
    const text = kind === "prompt" ? PROMPT : `!i ${COMMAND}`;
    const result = f.execute(kind);
    expect(f.frame()).toContain(text);
    expect((await result).details).toEqual({ status: "displayed", kind, text, surface: fallback ? "widget" : "ghost", acceptAfterTurn: false });
    for (const draft of [DRAFT, "another  exact draft"]) {
      f.ui.setEditorText(draft);
      expect(f.frame()).not.toContain(text);
      expect(f.take()).toBeUndefined();
      await changes();
      expect(f.ui.getEditorText()).toBe(draft);
      expect(f.widgets.size).toBe(0);
      f.ui.setEditorText("");
      await changes();
      expect(f.frame()).toContain(text);
      await changes();
    }
    expect(f.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
    f.terminal.send("\t");
    expect(f.ui.getEditorText()).toBe(text);
    expect(f.writes).toEqual([DRAFT, "", "another  exact draft", "", text]);
    expect(f.submissions).toEqual([]);
  });

  test(`native deletion and later typing conceal rather than destroy (${vim ? "Vim" : "native"}, fallback=${fallback})`, async () => {
    const f = await fixture({ vim, fallback });
    await f.h.emit("agent_start", {}, f.ctx);
    f.main.setText("x");
    expect((await f.execute()).details.status).toBe("queued");
    f.terminal.send("\x7f");
    expect(f.ui.getEditorText()).toBe("");
    await changes();
    expect(f.frame()).toContain(PROMPT);
    await changes();
    f.terminal.send("z");
    expect(f.ui.getEditorText()).toBe("z");
    expect(f.frame()).not.toContain(PROMPT);
    await changes();
    f.terminal.send("\x7f");
    await changes();
    expect(f.frame()).toContain(PROMPT);
    await changes();
    expect(f.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
    f.terminal.send("\x1b[C");
    expect(f.ui.getEditorText()).toBe(PROMPT);
    expect(f.writes).toEqual([PROMPT]);
    expect(f.submissions).toEqual([]);
  });

  test(`callback replacement, nested cleanup and stale reset work (${vim ? "Vim" : "native"}, fallback=${fallback})`, async () => {
    const f = await fixture({ vim, fallback, stash: false });
    await f.h.emit("agent_start", {}, f.ctx);
    f.main.setText(DRAFT);
    expect((await f.execute()).details.status).toBe("queued");
    const owner = f.main.onChange;
    const receiver = {};
    const count = f.callbacks.length;
    owner.call(receiver, "intermediate wrapped row");
    expect(f.callbacks.slice(count)).toEqual([{ receiver, text: "intermediate wrapped row" }]);
    owner("unbound wrapped row");
    expect(f.callbacks.slice(count + 1)).toEqual([{ receiver: undefined, text: "unbound wrapped row" }]);
    await changes();
    expect(f.frame()).not.toContain(PROMPT); // Live text, not callback argument, controls visibility.
    const replacement = vi.fn();
    f.main.onChange = replacement;
    f.terminal.send("\x1b[C"); // onKey must notice a directly replaced callback.
    f.main.setText("");
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledWith("");
    f.h.pi.events.emit("prompt:clear", {}); // Discard its queued microtask, not the next token.
    f.main.setText(DRAFT);
    const next = f.execute("prompt", "/replacement exact  text");
    f.main.setText("");
    await changes();
    expect((await next).details.status).toBe("queued");
    expect(f.frame()).toContain("/replacement exact  text");
    await changes();
    const owned = f.main.onChange;
    const nested = function (this: unknown, text: string) { owned.call(this, text); };
    f.main.onChange = nested;
    f.main.setText(DRAFT);
    f.main.setText(""); // Shutdown must cancel this still-pending reconciliation.
    await f.shutdown();
    expect(f.main.onChange).toBe(nested); // Cleanup never removes someone else's wrapper.
    const writes = [...f.writes];
    owner.call(receiver, "");
    owned.call(receiver, "");
    await changes();
    expect(f.frame()).not.toContain("/replacement exact  text");
    expect(f.take()).toBeUndefined();
    expect(f.writes).toEqual(writes);
    expect(f.widgets.size).toBe(0);
  });

  test(`replacement editor and reattach preserve the live callback exactly once (${vim ? "Vim" : "native"}, fallback=${fallback})`, async () => {
    const f = await fixture({ vim, fallback, stash: false });
    f.main.setText(DRAFT);
    expect((await f.execute()).details.status).toBe("queued");
    const previous = f.main;
    const previousObserver = previous.onChange;
    f.ui.setEditorComponent(f.ui.getEditorComponent());
    expect(f.main).not.toBe(previous);
    f.terminal.send("\x1b[C");
    f.main.setText("");
    await changes();
    expect(f.frame()).toContain(PROMPT);
    await changes();
    await f.h.emit("session_start", {}, f.ctx);
    await changes();
    const current = f.main;
    const before = f.callbacks.length;
    current.setText("fresh draft");
    expect(f.callbacks.slice(before).map(call => call.text)).toEqual(["fresh draft"]);
    // Vim may call its inherited handler unbound while restoring synthetic rows.
    if (!vim) expect(f.callbacks.at(-1)!.receiver).toBe(current);
    expect((await f.execute("prompt", "/fresh offer")).details.status).toBe("queued");
    previousObserver.call(previous, "");
    current.setText("");
    await changes();
    expect(f.frame()).toContain("/fresh offer");
    await changes();
    f.terminal.send("\t");
    expect(f.ui.getEditorText()).toBe("/fresh offer");
    const observer = current.onChange;
    await f.shutdown();
    expect(current.onChange).not.toBe(observer); // Directly owned callbacks are restored.
    current.setText("");
    await changes();
    expect(f.frame()).not.toContain("/fresh offer");
    expect(f.submissions).toEqual([]);
  });
}
