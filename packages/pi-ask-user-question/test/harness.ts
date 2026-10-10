// A minimal fake of pi's extension API and terminal UI: records handlers, the registered tool,
// bus events and dialog calls, and drives the question dialog with keys.
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { QuestionDialog } from "../src/dialog.ts";
import type { DialogResult } from "../src/result.ts";
import type { Question } from "../src/schema.ts";

initTheme("dark");

type Handler = (event: any, ctx: any) => unknown;

/** A theme that leaves text unstyled, so rendered lines can be compared as plain text. */
export const plainTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
};

export const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  shiftEnter: "\x1b[13;2u",
  space: " ",
};

export function harness(options: { active?: string[] } = {}) {
  const handlers = new Map<string, Handler[]>();
  const events: Array<{ channel: string; data: any }> = [];
  let tool: any;
  let active = [...(options.active ?? ["read", "bash"])];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerTool: (definition: any) => {
      tool = definition;
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    events: {
      emit: (channel: string, data: unknown) => {
        events.push({ channel, data });
      },
      on: () => () => undefined,
    },
  };
  async function emit(event: string, payload: any, ctx: any) {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  }
  return {
    pi: pi as any,
    events,
    emit,
    get tool() {
      return tool;
    },
    get active() {
      return active;
    },
  };
}

/** A context whose `ui.custom` runs the dialog through `keys`, recording plain-text frames. */
export function tuiContext(keys: string[], options: { columns?: number; frames?: string[][]; events?: Array<{ channel: string; data: any }> } = {}) {
  const frames = options.frames ?? [];
  const ui = {
    selects: [] as Array<{ title: string; options: string[] }>,
    custom: (factory: any) =>
      new Promise((resolve) => {
        options.events?.push({ channel: "ui.custom", data: undefined });
        const dialog = factory(fakeTui(options.columns), plainTheme, getKeybindings(), resolve);
        dialog.focused = true;
        drive(dialog, keys, frames, options.columns);
      }),
    select: async (title: string, opts: string[]) => {
      ui.selects.push({ title, options: opts });
      return undefined;
    },
    input: async () => undefined,
  };
  return { mode: "tui", hasUI: true, ui, frames };
}

export function fakeTui(columns = 100) {
  return { requestRender: () => undefined, terminal: { columns, rows: 40 } } as any;
}

export function drive(dialog: QuestionDialog, keys: string[], frames: string[][] = [], columns = 100) {
  frames.push(plain(dialog.render(columns)));
  for (const key of keys) {
    dialog.handleInput(key);
    frames.push(plain(dialog.render(columns)));
  }
  return frames;
}

export function plain(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line).replace(/\x1b_pi:c\x07/gu, ""));
}

/** Open a dialog directly and press `keys`; resolves with the result (or undefined if still open). */
export function dialog(questions: Question[], keys: string[], options: { columns?: number; signal?: AbortSignal } = {}) {
  let result: DialogResult | undefined;
  const d = new QuestionDialog(fakeTui(options.columns), plainTheme, getKeybindings() as any, questions, (r) => (result = r), options.signal);
  d.focused = true;
  const frames = drive(d, keys, [], options.columns);
  return { dialog: d, frames, get result() {
    return result;
  } };
}

export function q(question: string, header: string, labels: string[], extra: Partial<Question> = {}): Question {
  return {
    question,
    header,
    options: labels.map((label) => ({ label, description: `${label} description` })),
    multiSelect: false,
    ...extra,
  };
}
