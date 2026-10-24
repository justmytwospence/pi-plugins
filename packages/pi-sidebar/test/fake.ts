// A minimal ExtensionAPI and context for driving the extension's handlers directly.
type Handler = (event: any, ctx: any) => any;

export class FakePi {
  handlers = new Map<string, Handler[]>();
  shortcuts = new Map<string, { handler: (ctx: any) => any }>();
  commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  entries: Array<{ customType: string; data: unknown }> = [];
  busListeners = new Map<string, Array<(data: unknown) => void>>();
  thinking = "high";
  settings: Record<string, unknown> = {};
  tools: Array<{ name: string; sourceInfo: { path: string } }> = [];
  events = {
    emit: (channel: string, data: unknown) => {
      for (const listener of this.busListeners.get(channel) ?? []) listener(data);
    },
    on: (channel: string, listener: (data: unknown) => void) => {
      const list = this.busListeners.get(channel) ?? [];
      list.push(listener);
      this.busListeners.set(channel, list);
      return () => {};
    },
  };
  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {};
  }
  registerShortcut(key: string, options: { handler: (ctx: any) => any }) { this.shortcuts.set(key, options); }
  registerCommand(name: string, options: { handler: (args: string, ctx: any) => any }) { this.commands.set(name, options); }
  getThinkingLevel() { return this.thinking; }
  getSettings() { return this.settings; }
  getAllTools() { return this.tools; }
  appendEntry(customType: string, data: unknown) { this.entries.push({ customType, data }); }
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
  leafId?: string | null;
  entries?: unknown[];
  model?: { provider: string; id: string; api: string };
  systemPrompt?: string;
  contextTokens?: number;
  /** Models with a login, for Sidebar's model choice (main's own model is always among them). */
  models?: Array<{ provider: string; id: string; api: string; name?: string; contextWindow?: number }>;
}

export function fakeCtx(opts: FakeCtxOptions = {}) {
  const notes: Array<{ message: string; level?: string }> = [];
  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    model: opts.model ?? { provider: "anthropic", id: "claude-x", api: "anthropic-messages" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, api: "anthropic-messages" }),
      getAvailable: () => opts.models ?? [opts.model ?? { provider: "anthropic", id: "claude-x", api: "anthropic-messages" }],
    },
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "main-session",
      getLeafId: () => opts.leafId ?? null,
      getEntries: () => opts.entries ?? [],
      getBranch: () => opts.entries ?? [],
    },
    getSystemPrompt: () => opts.systemPrompt ?? "",
    getContextUsage: () => ({ tokens: opts.contextTokens ?? 0 }),
    ui: {
      theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => `[bg]${t}`, bold: (t: string) => t },
      notify: (message: string, level?: string) => notes.push({ message, level }),
      setWidget: () => {},
    },
  };
  return { ctx, notes };
}
