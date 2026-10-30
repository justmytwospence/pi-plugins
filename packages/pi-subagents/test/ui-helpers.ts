// Fakes for the UI tests: runs, a plain theme, a TUI and a ctx.ui.
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { type ChildState, emptyUsage } from "../src/child.ts";
import { Conversation } from "../src/conversation.ts";
import type { Run } from "../src/run.ts";

export const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

let next = 0;

export function fakeRun(over: { state?: Partial<ChildState> } & Partial<Omit<Run, "state">> = {}): Run {
  const { state, ...rest } = over;
  return {
    id: `r${++next}`,
    agent: "scout",
    task: "Find where the config is loaded",
    model: "anthropic/claude-haiku-5",
    thinking: "low",
    byJev: { agent: false, model: false, thinking: false },
    cwd: "/tmp",
    async: true,
    conversation: new Conversation(),
    outputPath: "/tmp/none/output.md",
    ...rest,
    state: { status: "running", output: "", usage: emptyUsage(), turns: 0, startedAt: 0, ...state },
  };
}

export function fakeTui(rows = 40, columns = 100) {
  const tui = { renders: 0, focused: undefined as unknown, terminal: { rows, columns }, requestRender: () => void tui.renders++, showOverlay: (..._args: any[]) => ({ hide() {} }), getFocusedComponent: () => tui.focused };
  return tui;
}

export type Factory = (tui: any, theme: any) => any;
export type CustomFactory = (tui: any, theme: any, keybindings: any, done: (v: any) => void) => any;

export function fakeUI(tui = fakeTui()) {
  const widgets = new Map<string, { factory: Factory; component: any; placement?: string }>();
  const ui = {
    calls: [] as Array<[string, boolean]>,
    widgets,
    tui,
    editorText: "",
    notes: [] as string[],
    selects: [] as Array<{ title: string; options: string[] }>,
    selectAnswers: [] as Array<(options: string[]) => string | undefined>,
    inputHandlers: new Set<(data: string) => { consume?: boolean; data?: string } | undefined>(),
    customs: [] as Array<{ component: any; options: any; close: () => void }>,
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
    custom(factory: CustomFactory, options: any): Promise<any> {
      return new Promise((resolve) => {
        let removed = false;
        const close = (value?: unknown) => {
          if (removed) (tui as any).hideOverlay?.();
          else ui.customs.splice(ui.customs.indexOf(entry), 1);
          entry.component.dispose?.();
          resolve(value);
        };
        const entry = { component: undefined as any, options, close };
        ui.customs.push(entry);
        entry.component = factory(tui, plain, undefined, close);
        entry.options = { ...options, overlayOptions: typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions };
        options?.onHandle?.({ hide() {
          ui.customs.splice(ui.customs.indexOf(entry), 1);
          removed = true;
        } });
      });
    },
    /** Feed a key through the input listeners; true when one consumed it. */
    press(data: string): boolean {
      for (const handler of ui.inputHandlers) if (handler(data)?.consume) return true;
      return false;
    },
    render(key: string, width = 100): string[] {
      return widgets.get(key)?.component.render(width) ?? [];
    },
  };
  return ui;
}

export function normalFocus(ui: ReturnType<typeof fakeUI>): void {
  ui.tui.focused = {
    getText: () => ui.editorText,
    setText: (text: string) => { ui.editorText = text; },
    [Symbol.for("pi-plugins.editor-mode.v1")]: () => ({ state: "normal", mode: "normal", pending: "", ex: null, autocomplete: false }),
  };
}

/** Exercise Pi's real Promise.resolve(factory).then(install) and overlay close path. */
export function piCustom(ui: ReturnType<typeof fakeUI>): typeof ui.custom {
  const tui = Object.assign(ui.tui, {
    showOverlay(component: any, options: any) {
      const previous = tui.focused;
      const entry = { component, options, close: () => {} };
      ui.customs.push(entry);
      if (!options?.nonCapturing) tui.focused = component;
      return { hide() { ui.customs.splice(ui.customs.indexOf(entry), 1); }, previous };
    },
    hideOverlay() {
      ui.customs.pop();
    },
  });
  const host = { ui: tui, editor: { getText: () => ui.editorText } };
  return (factory, options) => (InteractiveMode.prototype as any).showExtensionCustom.call(host, factory, options);
}

export const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", enter: "\r", escape: "\x1b", backspace: "\x7f" };
