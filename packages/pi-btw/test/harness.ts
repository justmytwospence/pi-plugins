import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { SessionModel } from "../src/thread.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush() { for (let i = 0; i < 60; ++i) await Promise.resolve(); }
export const model = {
  provider: "unit", id: "model", api: "openai-responses", baseUrl: "http://unused.invalid",
  name: "Unit", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as SessionModel;
export function assistant(text = "answer", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], provider: model.provider, model: model.id, api: model.api,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: 1 };
}
export class FakeSession {
  state: { messages: AgentSession["messages"] } = { messages: [] };
  model = model;
  thinkingLevel = "off" as const;
  isStreaming = false;
  readonly callbacks = new Set<(event: AgentSessionEvent) => void>();
  respond: (question: string) => Promise<AssistantMessage | null> = async () => assistant();
  prompt = vi.fn(async (question: string) => {
    this.isStreaming = true;
    const user = { role: "user" as const, content: [{ type: "text" as const, text: question }], timestamp: 1 };
    this.state.messages.push(user);
    this.emit({ type: "message_start", message: user });
    const response = await this.respond(question);
    if (response) {
      this.state.messages.push(response);
      this.emit({ type: "message_end", message: response });
      this.emit({ type: "turn_end", message: response, toolResults: [] });
    }
    this.isStreaming = false;
  });
  abort = vi.fn(async () => { this.isStreaming = false; });
  dispose = vi.fn(() => {});
  subscribe = vi.fn((callback: (event: AgentSessionEvent) => void) => {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  });
  emit(event: AgentSessionEvent) { for (const callback of this.callbacks) callback(event); }
  asSession(): AgentSession { return this as unknown as AgentSession; }
}
export const theme = {
  fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as ExtensionContext["ui"]["theme"];
export const keybindings = new TuiKeybindingsManager({ ...TUI_KEYBINDINGS, "app.clear": { defaultKeys: "ctrl+c", description: "Clear" } }) as KeybindingsManager;
export function fakeTui(mode = "fullscreen", rows = 30) {
  return { mode, terminal: { rows, write: vi.fn() }, requestRender: vi.fn() } as unknown as TUI;
}

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];
type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type Options = Parameters<ExtensionContext["ui"]["custom"]>[1];
type Mount = { factory: Factory; options: Options; mount: () => Promise<Component & { dispose?(): void }>; done: ReturnType<typeof vi.fn<(value?: unknown) => void>>; component?: Component & { dispose?(): void }; handle: OverlayHandle };
export function harness() {
  const commands = new Map<string, Command>();
  const shortcuts = new Map<string, Shortcut>();
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const renderers = new Map<string, Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>();
  const entries: unknown[] = [];
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerShortcut: (name: string, shortcut: Shortcut) => shortcuts.set(name, shortcut),
    registerMessageRenderer: (name: string, renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1]) => renderers.set(name, renderer),
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    getCommands: () => [...commands.keys()].map((name) => ({ name, source: "extension" })),
    getThinkingLevel: () => "off",
    appendEntry: vi.fn((customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); }),
    sendMessage: vi.fn(), sendUserMessage: vi.fn(),
    events: { emit: vi.fn() },
  };
  const mounts: Mount[] = [];
  let autoMount = true;
  let idle = true;
  let branch: unknown[] = [];
  const ctx = {
    mode: "rpc", hasUI: true, cwd: "/tmp/btw-parent-workspace", model,
    isIdle: () => idle, getSystemPrompt: () => "Parent instructions\nCurrent working directory: /old",
    sessionManager: { getEntries: () => branch, getBranch: () => branch, getLeafId: () => null },
    modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "unit-placeholder" })), hasConfiguredAuth: () => true, find: vi.fn(() => model) },
    ui: {
      theme, notify: vi.fn(), setWidget: vi.fn(),
      custom: vi.fn((factory: Factory, options: Options) => {
        const result = deferred<unknown>();
        let focused = false;
        const handle = { focus: vi.fn(() => { focused = true; }), unfocus: vi.fn(() => { focused = false; }), isFocused: () => focused, setHidden: vi.fn() } as unknown as OverlayHandle;
        const mount: Mount = { factory, options, handle, done: vi.fn((value?: unknown) => { result.resolve(value); mount.component?.dispose?.(); }),
          mount: async () => {
            const component = await factory(fakeTui(), theme, keybindings, mount.done);
            mount.component = component;
            options?.onHandle?.(handle);
            return component;
          },
        };
        mounts.push(mount);
        if (autoMount) void mount.mount();
        return result.promise;
      }),
    },
  };
  return {
    pi, ctx, commands, shortcuts, handlers, renderers, entries, mounts,
    api: pi as unknown as ExtensionAPI, context: ctx as unknown as ExtensionCommandContext,
    setIdle: (value: boolean) => { idle = value; }, setBranch: (value: unknown[]) => { branch = value; },
    setAutoMount: (value: boolean) => { autoMount = value; },
    setMode: (mode: ExtensionContext["mode"]) => { ctx.mode = mode; ctx.hasUI = mode === "tui" || mode === "rpc"; },
    command: async (name: string, args = "") => { await commands.get(name)!.handler(args, ctx as unknown as ExtensionCommandContext); },
    event: async (name: string, event: unknown = {}) => { return await handlers.get(name)?.(event as never, ctx as unknown as ExtensionContext); },
  };
}
