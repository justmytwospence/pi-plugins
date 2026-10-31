// Unit fakes, not Pi's terminal pipeline: overlay ownership and listener dispatch only.
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { type ChildState, emptyUsage } from "../src/child.ts";
import { Conversation } from "../src/conversation.ts";
import type { Run } from "../src/run.ts";

export const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
let next = 0;

export function fakeRun(over: { state?: Partial<ChildState> } & Partial<Omit<Run, "state">> = {}): Run {
  const { state, ...rest } = over;
  return {
    id: `r${++next}`, agent: "scout", task: "Find where the config is loaded", model: "anthropic/claude-haiku-5", thinking: "low",
    byJev: { agent: false, model: false, thinking: false }, cwd: "/tmp", async: true, conversation: new Conversation(), outputPath: "/tmp/none/output.md", ...rest,
    state: { status: "running", output: "", usage: emptyUsage(), turns: 0, startedAt: 0, ...state },
  };
}

type Overlay = { component: any; options: any; close: () => void; hidden: boolean; previous: unknown };
export function fakeTui(rows = 40, columns = 100) {
  const overlays: Overlay[] = [];
  const tui = {
    renders: 0, focused: undefined as unknown, terminal: { rows, columns }, overlays,
    requestRender: () => void tui.renders++,
    getFocusedComponent: () => tui.focused,
    setFocus(component: any) {
      if (tui.focused && typeof tui.focused === "object") (tui.focused as any).focused = false;
      tui.focused = component;
      if (component && typeof component === "object") component.focused = true;
    },
    showOverlay(component: any, options?: any) {
      const entry: Overlay = { component, options, hidden: false, previous: tui.focused, close: () => {} };
      overlays.push(entry);
      if (!options?.nonCapturing) tui.setFocus(component);
      const restore = () => tui.setFocus([...overlays].reverse().find(item => !item.hidden && !item.options?.nonCapturing)?.component ?? entry.previous);
      const handle = {
        hide() {
          const index = overlays.indexOf(entry);
          if (index < 0) return;
          overlays.splice(index, 1);
          for (const other of overlays) if (other.previous === component) other.previous = entry.previous;
          if (tui.focused === component) restore();
          tui.requestRender();
        },
        setHidden(hidden: boolean) {
          if (!overlays.includes(entry) || entry.hidden === hidden) return;
          entry.hidden = hidden;
          if (hidden && tui.focused === component) restore();
          else if (!hidden && !options?.nonCapturing) tui.setFocus(component);
          tui.requestRender();
        },
        isHidden: () => entry.hidden,
        focus() { if (!entry.hidden) tui.setFocus(component); },
        unfocus() { if (tui.focused === component) tui.setFocus(entry.previous); },
      };
      entry.close = handle.hide;
      tui.requestRender();
      return handle;
    },
    hideOverlay() { overlays.at(-1)?.close(); },
  };
  return tui;
}

export type Factory = (tui: any, theme: any) => any;
export type CustomFactory = (tui: any, theme: any, keybindings: any, done: (v: any) => void) => any;

export function fakeUI(tui = fakeTui()) {
  const widgets = new Map<string, { factory: Factory; component: any; placement?: string }>();
  const mainEditor = {
    getText: (): string => ui.editorText,
    setText: (text: string) => { ui.editorText = text; },
    onExtensionShortcut: undefined,
    [Symbol.for("pi-plugins.editor-surface.v1")]: "main",
    handleInput: (data: string) => { ui.editorText += data; },
    render: () => [], invalidate() {}, focused: false,
  };
  const ui = {
    calls: [] as Array<[string, boolean]>, widgets, tui, mainEditor, editorText: "", notes: [] as string[],
    selects: [] as Array<{ title: string; options: string[] }>, selectAnswers: [] as Array<(options: string[]) => string | undefined>,
    inputHandlers: new Set<(data: string) => { consume?: boolean; data?: string } | undefined>(),
    overlays: tui.overlays,
    /** Legacy alias: this includes owned direct overlays, not only ui.custom calls. */
    customs: tui.overlays,
    theme: plain,
    setWidget(key: string, content: Factory | undefined, options?: { placement?: string }) {
      ui.calls.push([key, Boolean(content)]);
      if (!content) widgets.delete(key);
      else widgets.set(key, { factory: content, component: content(tui, plain), ...(options?.placement ? { placement: options.placement } : {}) });
    },
    onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
      ui.inputHandlers.add(handler);
      return () => ui.inputHandlers.delete(handler);
    },
    getEditorText: () => ui.editorText,
    select: async (title: string, options: string[]) => {
      ui.selects.push({ title, options });
      return ui.selectAnswers.shift()?.(options);
    },
    notify: (message: string) => void ui.notes.push(message),
    custom(factory: CustomFactory, options?: any): Promise<any> {
      return new Promise((resolve, reject) => {
        let handle: ReturnType<typeof tui.showOverlay> | undefined;
        let component: any;
        let closed = false;
        const close = (value?: unknown) => {
          if (closed) return;
          closed = true;
          handle?.hide();
          component?.dispose?.();
          resolve(value);
        };
        try {
          component = factory(tui, plain, undefined, close);
          if (closed) { component?.dispose?.(); return; }
          handle = tui.showOverlay(component, typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions);
          options?.onHandle?.(handle);
        } catch (error) { component?.dispose?.(); reject(error); }
      });
    },
    /** Listener interception only, deliberately does not forward or rewrite input. */
    press(data: string): boolean {
      for (const handler of ui.inputHandlers) if (handler(data)?.consume) return true;
      return false;
    },
    /** Fake end-to-end dispatch, preserving rewrites before forwarding to current focus. */
    dispatch(data: string): boolean {
      for (const handler of ui.inputHandlers) {
        const result = handler(data);
        if (result?.consume) return true;
        if (result?.data !== undefined) data = result.data;
      }
      (tui.getFocusedComponent() as { handleInput?(data: string): void } | undefined)?.handleInput?.(data);
      return false;
    },
    render(key: string, width = 100): string[] { return widgets.get(key)?.component.render(width) ?? []; },
  };
  if (tui.focused === undefined) tui.setFocus(mainEditor);
  return ui;
}

export function normalFocus(ui: ReturnType<typeof fakeUI>): void {
  Object.assign(ui.mainEditor, {
    [Symbol.for("pi-plugins.editor-mode.v1")]: () => ({ state: "normal", mode: "normal", pending: "", ex: null, autocomplete: false }),
  });
  ui.tui.setFocus(ui.mainEditor);
}

/** Exercise Pi's actual custom factory/install lifecycle on the fake overlay renderer. */
export function piCustom(ui: ReturnType<typeof fakeUI>): typeof ui.custom {
  const host = { ui: ui.tui, editor: ui.mainEditor };
  return (factory, options) => (InteractiveMode.prototype as any).showExtensionCustom.call(host, factory, options);
}

export const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", enter: "\r", escape: "\x1b", backspace: "\x7f" };
