// A minimal fake of Pi's extension API and interactive editor plumbing for pi-stash.
import { EDITOR_SNAPSHOT, EDITOR_SURFACE, type EditorSnapshot } from "../src/contract.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

export const CTRL_S = "\x13";
export const ENTER = "\r";

/** The native editor shape pi-stash wraps; `/commands` are cleared by the fake Pi submit. */
export class FakeEditor {
  text = "";
  onSubmit?: (text: string) => unknown;
  onChange?: (text: string) => void;
  readonly keys: string[] = [];
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
    this.onChange?.(text);
  }
  handleInput(data: string): void {
    this.keys.push(data);
    if (data === ENTER) {
      const text = this.text;
      void this.onSubmit?.(text);
      return;
    }
    if (data.length === 1 && data >= " ") this.setText(this.text + data);
  }
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

/** An editor implementing the suite snapshot protocol (what pi-vim provides). */
export class SnapshotEditor extends FakeEditor {
  mode: "insert" | "normal" = "insert";
  cursor = { line: 0, col: 0 };
  restoreResult = true;
  restored: EditorSnapshot[] = [];
  readonly [EDITOR_SNAPSHOT] = {
    capture: (): EditorSnapshot => ({ version: 1, text: this.text, cursor: { ...this.cursor }, mode: this.mode }),
    restore: (snapshot: EditorSnapshot): boolean => {
      this.restored.push(snapshot);
      if (!this.restoreResult) return false;
      this.text = snapshot.text;
      this.cursor = { ...snapshot.cursor };
      this.mode = snapshot.mode as "insert" | "normal";
      return true;
    },
  };
}

export function markEmbedded<T extends object>(editor: T): T {
  Object.defineProperty(editor, EDITOR_SURFACE, { value: "embedded", enumerable: false });
  return editor;
}

export function harness() {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const events = {
    on: (channel: string, listener: (data: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => undefined;
    },
    emit: (channel: string, data: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
  };
  const pi = {
    events,
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
  };
  async function emit(event: string, payload: unknown, ctx: unknown) {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  }

  /** One interactive session: Pi's main editor, focus, and the editor-factory slot. */
  function session(options: { mode?: string; hasUI?: boolean; base?: () => FakeEditor } = {}) {
    const notes: Array<{ message: string; type?: string }> = [];
    const status = new Map<string, string | undefined>();
    const submitted: string[] = [];
    let factory: ((tui: unknown, theme: unknown, keybindings: unknown) => FakeEditor) | undefined;
    const shell = { resolve: undefined as undefined | (() => void) };
    /** Pi's submit callback: slash commands clear the editor at once; shell commands await completion. */
    const mainSubmit = async (text: string) => {
      submitted.push(text);
      if (text.startsWith("/")) {
        state.main.setText("");
        return;
      }
      if (text.startsWith("!")) {
        await new Promise<void>((resolve) => {
          shell.resolve = resolve;
        });
        return;
      }
      state.main.setText("");
    };
    const tui = {
      mode: "fullscreen",
      getFocusedComponent: () => state.focused,
      requestRender() {},
      terminal: { columns: 80, rows: 40 },
    };
    const keybindings = { matches: (data: string, action: string) => action === "tui.input.submit" && data === ENTER };
    const state = { main: new FakeEditor(), focused: undefined as unknown };
    state.focused = state.main;
    const ui = {
      notify: (message: string, type?: string) => notes.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => status.set(key, text),
      theme: { fg: (_color: string, text: string) => text },
      getEditorComponent: () => factory,
      /** Pi's setCustomEditorComponent: create, wire the main submit callback, keep the text, focus. */
      setEditorComponent: (next: typeof factory) => {
        factory = next;
        const text = state.main.getText();
        const editor = next ? next(tui, {}, keybindings) : (options.base?.() ?? new FakeEditor());
        editor.onSubmit = mainSubmit;
        editor.setText(text);
        state.main = editor;
        state.focused = editor;
      },
      getEditorText: () => state.main.getText(),
      setEditorText: (text: string) => state.main.setText(text),
    };
    const ctx = { mode: options.mode ?? "tui", hasUI: options.hasUI ?? true, ui };
    // An editor-replacing extension (pi-vim) loaded before pi-stash: the factory pi-stash wraps.
    const baseFactory = () => options.base?.() ?? new FakeEditor();
    ui.setEditorComponent(baseFactory);
    /** Create an editor through the installed factory outside Pi's main slot (an embedder). */
    const embed = () => factory!(tui, {}, keybindings);
    return { ctx, ui, notes, status, submitted, state, tui, keybindings, shell, embed, baseFactory, factory: () => factory };
  }

  return { pi: pi as never, events, emit, session };
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
