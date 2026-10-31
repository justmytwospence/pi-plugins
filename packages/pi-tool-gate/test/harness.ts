import { realpathSync } from "node:fs";

// A minimal fake of Pi's extension API: records handlers, commands, entries and UI calls.
type Handler = (event: any, ctx: any) => unknown;

export interface FakeJev {
  calls: Array<{ state: Record<string, unknown>; questions: Record<string, any>; options: any }>;
  answer: (questions: Record<string, any>, state: Record<string, unknown>) => any;
}

export function fakeJev(answer: FakeJev["answer"]): FakeJev & { registry: unknown } {
  const calls: FakeJev["calls"] = [];
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
    classify: async (_model: unknown, context: any, options: any) => {
      calls.push({ state: context.state, questions: context.questions, options });
      const result = answer(context.questions, context.state);
      if (result && typeof result === "object" && "stopReason" in result) return result;
      return { model: "jev-latest", stopReason: "stop", answers: result, usage: usage(300) };
    },
  };
  return { calls, answer, registry };
}

export function usage(input: number) {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function harness(options: { tools?: any[]; exec?: (cmd: string, args: string[]) => any; nonGitCwd?: string } = {}) {
  // Opt in only for an existing isolated non-Git fixture. resolveProject still
  // performs its real filesystem ancestor checks; custom executors always win.
  if (options.nonGitCwd !== undefined) realpathSync(options.nonGitCwd);
  const discovery = options.nonGitCwd === undefined ? [] : [
    "LC_ALL=C", "git", "-C", options.nonGitCwd, "rev-parse", "--show-toplevel",
  ];
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const messageRenderers = new Map<string, (message: any, options: any, theme: any) => any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: any[] = [];
  /** Everything emitted on pi's event bus, in order. */
  const events: Array<{ channel: string; data: any }> = [];
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  let thinking = "high";
  const thinkingChanges: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerShortcut: (key: string, options: any) => shortcuts.set(key, options),
    registerTool: () => undefined,
    registerFlag: () => undefined,
    registerMessageRenderer: (customType: string, renderer: (message: any, options: any, theme: any) => any) => messageRenderers.set(customType, renderer),
    registerEntryRenderer: () => undefined,
    getFlag: () => undefined,
    getAllTools: () => options.tools ?? [],
    exec: async (cmd: string, args: string[]) => {
      if (options.exec) return options.exec(cmd, args) ?? { code: 1, stdout: "", stderr: "", killed: false };
      if (options.nonGitCwd !== undefined && cmd === "env" && args.length === discovery.length &&
          args.every((arg, index) => arg === discovery[index])) {
        return { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n", killed: false };
      }
      return { code: 1, stdout: "", stderr: "", killed: false };
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendMessage: (message: any, opts: any) => messages.push({ message, opts }),
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: string) => {
      thinking = level;
      thinkingChanges.push(level);
      void emit("thinking_level_select", { type: "thinking_level_select", level, previousLevel: "?" });
    },
    events: {
      emit: (channel: string, data: unknown) => {
        events.push({ channel, data });
        for (const listener of listeners.get(channel) ?? []) listener(data);
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        return () => undefined;
      },
    },
  };
  async function emit(event: string, payload: any, ctx?: any) {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx ?? lastCtx)) ?? result;
    return result;
  }
  let lastCtx: any;
  function ctx(overrides: Record<string, unknown> = {}) {
    const ui = {
      selects: [] as Array<{ title: string; options: string[] }>,
      selectAnswers: [] as Array<string | undefined>,
      inputAnswers: [] as Array<string | undefined>,
      inputs: [] as Array<{ title: string; placeholder?: string }>,
      editors: [] as Array<{ title: string; prefill?: string }>,
      editorAnswers: [] as Array<string | undefined>,
      notes: [] as Array<{ message: string; type?: string }>,
      status: new Map<string, string | undefined>(),
      select: async (title: string, opts: string[]) => {
        ui.selects.push({ title, options: opts });
        return ui.selectAnswers.shift();
      },
      input: async (title: string, placeholder?: string) => {
        ui.inputs.push({ title, placeholder });
        return ui.inputAnswers.shift();
      },
      editor: async (title: string, prefill?: string) => {
        ui.editors.push({ title, prefill });
        return ui.editorAnswers.shift();
      },
      confirm: async () => true,
      notify: (message: string, type?: string) => ui.notes.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => ui.status.set(key, text),
      custom: async () => undefined,
    };
    lastCtx = {
      cwd: "/Users/me/Projects/app",
      hasUI: true,
      mode: "tui",
      ui,
      signal: undefined,
      sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
      modelRegistry: undefined,
      ...overrides,
    };
    return lastCtx;
  }
  return { pi: pi as any, handlers, commands, shortcuts, messageRenderers, entries, messages, events, emit, ctx, thinkingChanges, get thinking() { return thinking; } };
}

export function userEntry(text: string) {
  return { type: "message", id: `u${Math.random()}`, message: { role: "user", content: text } };
}

export function assistantEntry(text: string, blocks: unknown[] = []) {
  return { type: "message", id: `a${Math.random()}`, message: { role: "assistant", content: [{ type: "text", text }, ...blocks] } };
}
