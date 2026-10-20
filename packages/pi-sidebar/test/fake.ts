// A minimal ExtensionAPI and context for driving the extension's handlers directly.
type Handler = (event: any, ctx: any) => any;

export class FakePi {
  handlers = new Map<string, Handler[]>();
  shortcuts = new Map<string, { handler: (ctx: any) => any }>();
  commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  thinking = "high";
  models: string[] = [];
  emitted: Array<[string, unknown]> = [];
  events = { emit: (channel: string, data: unknown) => { this.emitted.push([channel, data]); }, on: () => () => {} };
  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {};
  }
  registerShortcut(key: string, options: { handler: (ctx: any) => any }) { this.shortcuts.set(key, options); }
  registerCommand(name: string, options: { handler: (args: string, ctx: any) => any }) { this.commands.set(name, options); }
  getThinkingLevel() { return this.thinking; }
  setThinkingLevel(level: string) { this.thinking = level; }
  async setModel(model: { provider: string; id: string }) { this.models.push(`${model.provider}/${model.id}`); return true; }
  async emit(event: string, payload: any, ctx: any) {
    let result: any;
    for (const handler of this.handlers.get(event) ?? []) {
      const r = await handler(payload, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
}

export interface FakeCtxOptions {
  sessionId?: string;
  sessionFile?: string;
  leafId?: string | null;
  model?: { provider: string; id: string; api: string };
  systemPrompt?: string;
  hasUI?: boolean;
  confirm?: boolean;
  cwd?: string;
}

export function fakeCtx(opts: FakeCtxOptions = {}) {
  const notes: Array<{ message: string; level?: string }> = [];
  const confirms: string[] = [];
  let editor = "";
  let aborted = 0;
  const widgets = new Map<string, string[] | undefined>();
  const ctx = {
    cwd: opts.cwd ?? "/repo",
    hasUI: opts.hasUI ?? true,
    model: opts.model ?? { provider: "anthropic", id: "claude-x", api: "anthropic-messages" },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id, api: "anthropic-messages" }) },
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "side-session",
      getSessionFile: () => opts.sessionFile,
      getLeafId: () => opts.leafId ?? null,
    },
    getSystemPrompt: () => opts.systemPrompt ?? "",
    abort: () => { aborted++; },
    ui: {
      theme: { fg: (_c: string, t: string) => t },
      notify: (message: string, level?: string) => notes.push({ message, level }),
      confirm: async (title: string) => { confirms.push(title); return opts.confirm ?? true; },
      setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
      setEditorText: (text: string) => { editor = text; },
      getEditorText: () => editor,
    },
  };
  return { ctx, notes, confirms, widgets, get editor() { return editor; }, get aborted() { return aborted; } };
}
