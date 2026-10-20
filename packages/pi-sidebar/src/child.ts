// Sidebar's agent: an in-process Pi session inside main's process (as plan mode's planners and
// pi-btw run theirs), with no extensions of its own except Sidebar's policy, passed inline. Every
// request it sends is main's last request plus Sidebar's part, so main's prompt cache serves it.
import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MainState } from "./main-state.ts";
import { judgeToolCall, READ_ONLY_TOOLS } from "./read-only.ts";
import { inertPayload, requestedCacheTtlMs, splicePayload, SUPPORTED_APIS } from "./splice.ts";
import { compactExchange, EXCHANGE_ENTRY } from "./thread.ts";
import { assembleContext, describeLive, mainDelta, roleMessage, statusMessage } from "./transcript.ts";

const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const COLD_MARGIN_MS = 20_000;
const MISS_RATIO = 0.5;
const MISS_MIN_TOKENS = 8_000;

export type Preflight =
  | { kind: "send" }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "refuse"; reason: string };

export type SidebarEvent = Record<string, unknown> & { type: string };

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The session reaches models the way main does: the providers main registered. */
export function inheritProviders(host: ExtensionContext, runtime: ModelRuntime): void {
  const registry = host.modelRegistry as unknown as {
    getRegisteredProviderIds?(): readonly string[];
    getRegisteredNativeProvider?(id: string): unknown;
    getRegisteredProviderConfig?(id: string): unknown;
  };
  for (const id of new Set(registry.getRegisteredProviderIds?.() ?? [])) {
    try {
      const native = registry.getRegisteredNativeProvider?.(id);
      if (native) {
        runtime.registerNativeProvider(native as never);
        continue;
      }
      const config = registry.getRegisteredProviderConfig?.(id);
      if (config) runtime.registerProvider(id, config as never);
    } catch {
      // A provider that cannot be copied stays as Pi configures it by default.
    }
  }
}

/** Main's whole conversation as its model sees it, for a request when main has none in memory. */
export function replayMessages(ctx: ExtensionContext): AgentMessage[] {
  const entries = ctx.sessionManager.getEntries();
  const messages = buildSessionContext(entries as never, ctx.sessionManager.getLeafId()).messages as AgentMessage[];
  // Cut a trailing turn whose tool calls are still running (a provider rejects a call without a result).
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role: string; content?: Array<{ type: string; id?: string }> };
    if (message.role !== "assistant") continue;
    const calls = (message.content ?? []).filter((b) => b.type === "toolCall").map((b) => b.id ?? "");
    const answered = new Set<string>(messages.slice(i + 1).flatMap((m) => (m.role === "toolResult" ? [(m as { toolCallId: string }).toolCallId] : [])));
    return calls.some((id) => !answered.has(id)) ? messages.slice(0, i) : messages;
  }
  return messages;
}

export class SidebarAgent {
  private session: AgentSession | undefined;
  private sessionModel: string | undefined;
  private creating: Promise<AgentSession> | undefined;
  private thread: AgentMessage[] = [];
  private turnStart = 0;
  private allowReplay = false;
  private mode: "splice" | "replay" | undefined;
  private readonly listeners = new Set<(event: SidebarEvent) => void>();
  private generation = 0;
  missed: { read: number; expected: number } | undefined;
  lastAnswer: string | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly main: MainState,
    private readonly now = () => Date.now(),
  ) {}

  get busy(): boolean {
    return !!this.session?.isStreaming;
  }

  get messages(): readonly AgentMessage[] {
    return this.thread;
  }

  onEvent(listener: (event: SidebarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SidebarEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* the panel must not break the agent */ }
    }
  }

  /** Replace the thread (restored from main's branch, or cleared); the session is rebuilt on demand. */
  async setThread(messages: AgentMessage[]): Promise<void> {
    this.thread = messages;
    this.missed = undefined;
    this.lastAnswer = undefined;
    await this.dispose();
  }

  /** Whether a question may go now, needs a confirmation first, or cannot go at all. */
  preflight(): Preflight {
    const ctx = this.main.ctx;
    if (!ctx) return { kind: "refuse", reason: "main's session is not ready yet." };
    const request = this.main.request;
    if (!request) {
      const tokens = ctx.getContextUsage()?.tokens ?? 0;
      return {
        kind: "confirm",
        title: "Main has not sent a request since Pi started",
        message: tokens > 0
          ? `So its cache cannot be shared for sure. Sending reads about ${formatTokens(tokens)} tokens of main's conversation, probably uncached.`
          : "Main has no conversation yet, so Sidebar's request carries only the prompt and tools, uncached.",
      };
    }
    if (!SUPPORTED_APIS.has(request.api)) return { kind: "refuse", reason: `main uses the ${request.api} API, which Sidebar cannot share a cache with.` };
    if (!ctx.modelRegistry.find(request.provider, request.model)) return { kind: "refuse", reason: `main's model ${request.provider}/${request.model} is not available.` };
    const age = this.now() - request.sentAt;
    const ttl = requestedCacheTtlMs(request.api, request.payload);
    if (age > ttl - COLD_MARGIN_MS) {
      return {
        kind: "confirm",
        title: "Main's prompt cache has probably expired",
        message: `Main's last request was ${ago(age)} ago and its cache lasts ${ago(ttl)}. Sending re-reads about ${formatTokens(this.main.promptTokens())} tokens uncached.`,
      };
    }
    if (this.missed) {
      return {
        kind: "confirm",
        title: "The last answer missed main's cache",
        message: `Only ${formatTokens(this.missed.read)} of about ${formatTokens(this.missed.expected)} tokens came from the cache. Another question may re-read main's context uncached.`,
      };
    }
    return { kind: "send" };
  }

  /** Ask a question (after preflight, and confirmation where it asked for one). */
  async ask(text: string, confirmed = false): Promise<void> {
    const ctx = this.main.ctx;
    if (!ctx) throw new Error("main's session is not ready yet");
    if (confirmed) this.missed = undefined;
    this.allowReplay = confirmed && !this.main.request;
    const session = await this.ensureSession(ctx);
    if (session.isStreaming) {
      await session.followUp(text);
      return;
    }
    this.turnStart = session.messages.length;
    try {
      await session.prompt(text);
    } finally {
      this.allowReplay = false;
    }
  }

  async abort(): Promise<void> {
    await this.session?.abort().catch(() => {});
  }

  async dispose(): Promise<void> {
    this.generation++;
    const session = this.session ?? (await this.creating?.catch(() => undefined));
    this.session = undefined;
    this.creating = undefined;
    this.sessionModel = undefined;
    if (!session) return;
    try { await session.abort(); } catch { /* already idle */ }
    try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as never); } catch { /* ignore */ }
    session.dispose();
  }

  private async ensureSession(ctx: ExtensionContext): Promise<AgentSession> {
    const request = this.main.request;
    const model = request ? ctx.modelRegistry.find(request.provider, request.model) : ctx.model;
    if (!model) throw new Error("no model");
    const key = `${model.provider}/${model.id}`;
    if (this.session && this.sessionModel === key) return this.session;
    if (this.creating && this.sessionModel === key) return this.creating;
    await this.dispose();
    const generation = this.generation;
    this.sessionModel = key;
    this.creating = this.create(ctx, model).then((session) => {
      if (generation !== this.generation) {
        session.dispose();
        throw new Error("Sidebar was reset while starting");
      }
      this.session = session;
      return session;
    });
    return this.creating;
  }

  private async create(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>): Promise<AgentSession> {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
    const web = webToolSources(this.pi);
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noSkills: true,
      noContextFiles: true,
      additionalExtensionPaths: web.paths,
      extensionFactories: [this.policy()] as never,
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create();
    inheritProviders(ctx, modelRuntime);
    await modelRuntime.refresh({ allowNetwork: false });
    const sessionManager = SessionManager.inMemory(ctx.cwd);
    for (const message of this.thread) {
      try { sessionManager.appendMessage(message as never); } catch { /* a message Pi will not store is left out */ }
    }
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: this.pi.getThinkingLevel(),
      tools: [...BUILTIN_TOOLS, ...web.names],
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    await session.bindExtensions({ mode: "print" } as never);
    session.subscribe((event) => this.handle(session, event as unknown as SidebarEvent));
    return session;
  }

  private handle(session: AgentSession, event: SidebarEvent): void {
    if (session !== this.session) return;
    if (event.type === "message_end") this.recordUsage(event.message as { role: string; usage?: Record<string, number> });
    if (event.type === "agent_end") {
      const added = session.messages.slice(this.turnStart) as AgentMessage[];
      this.turnStart = session.messages.length;
      if (added.length > 0) {
        const compact = compactExchange(added);
        this.thread = [...this.thread, ...compact];
        try {
          this.pi.appendEntry(EXCHANGE_ENTRY, { version: 1, messages: compact, timestamp: this.now() });
        } catch { /* main's session went away */ }
      }
    }
    this.emit(event);
  }

  private recordUsage(message: { role: string; usage?: Record<string, number> }): void {
    if (message.role !== "assistant" || !message.usage) return;
    const read = message.usage.cacheRead ?? 0;
    const total = read + (message.usage.input ?? 0) + (message.usage.cacheWrite ?? 0);
    if (total === 0) return;
    const expected = this.main.promptTokens();
    this.missed = this.mode === "splice" && expected >= MISS_MIN_TOKENS && read < expected * MISS_RATIO ? { read, expected } : undefined;
    this.lastAnswer = `${Math.round((read / total) * 100)}% cached · ${formatTokens(total - read)} new`;
  }

  /** Sidebar's policy, loaded into its session as an inline extension. */
  private policy(): ExtensionFactory {
    return (cpi: ExtensionAPI) => {
      cpi.on("cache_warming_decision", () => ({ action: "stop" as const }));

      cpi.on("tool_call", (event, cctx) => {
        const verdict = judgeToolCall(event.toolName, event.input, cctx.cwd);
        return verdict.allowed ? undefined : { block: true, reason: verdict.reason };
      });

      cpi.on("context_with_system", (event) => {
        const ctx = this.main.ctx;
        if (!ctx) return undefined;
        const now = this.now();
        const request = this.main.request;
        const entries = ctx.sessionManager.getEntries() as never;
        const leaf = ctx.sessionManager.getLeafId();
        if (request) {
          this.mode = "splice";
          const delta = mainDelta(entries, request.leafId, leaf);
          const status = statusMessage(describeLive(this.main.live, delta, now), now);
          return { messages: assembleContext(event.messages, delta.messages, roleMessage(now), status) };
        }
        if (!this.allowReplay) {
          this.mode = undefined;
          return undefined;
        }
        this.mode = "replay";
        const status = statusMessage(describeLive(this.main.live, { messages: [], pending: [] }, now), now);
        const replay = replayMessages(ctx);
        // Main's transcript starts with its prompt and tools once it has sent anything; before that,
        // Sidebar's own leading system message stands in.
        if (replay[0]?.role === "system") {
          const own = event.messages[0]?.role === "system" ? event.messages.slice(1) : event.messages;
          return { messages: [...replay, ...assembleContext(own, [], roleMessage(now), status)] };
        }
        return { messages: assembleContext(event.messages, replay, roleMessage(now), status) };
      });

      cpi.on("before_provider_request", (event, cctx) => {
        const api = cctx.model?.api ?? "";
        const fail = (reason: string) => {
          this.emit({ type: "sidebar_error", message: `Sidebar did not send: ${reason}. Nothing was spent.` });
          cctx.abort();
          return inertPayload(api, event.payload);
        };
        if (this.mode === "replay") return undefined;
        const request = this.main.request;
        if (this.mode !== "splice" || !request) return fail("there is no copy of main's last request");
        if (request.api !== api) return fail(`main is on the ${request.api} API and Sidebar on ${api}`);
        const result = splicePayload(api, request.payload, event.payload);
        return result.ok ? result.payload : fail(result.reason);
      });

      // Routing headers carry the session id (OpenRouter affinity, Codex): main's id keeps Sidebar's
      // requests on the machine that holds main's cache.
      cpi.on("before_provider_headers", (event, cctx) => {
        const main = this.main.sessionId;
        const own = cctx.sessionManager.getSessionId();
        if (!main || !own || main === own) return;
        for (const [key, value] of Object.entries(event.headers)) {
          if (typeof value === "string" && value.includes(own)) event.headers[key] = value.split(own).join(main);
        }
      });
    };
  }
}

/** Main's read-only web tools and the extensions that provide them, to load into Sidebar too. */
export function webToolSources(pi: Pick<ExtensionAPI, "getAllTools">): { names: string[]; paths: string[] } {
  const names: string[] = [];
  const paths = new Set<string>();
  try {
    for (const tool of pi.getAllTools()) {
      if (!READ_ONLY_TOOLS.has(tool.name) || BUILTIN_TOOLS.includes(tool.name)) continue;
      const path = (tool.sourceInfo as { path?: unknown } | undefined)?.path;
      if (typeof path !== "string" || path.startsWith("builtin:")) continue;
      names.push(tool.name);
      paths.add(path);
    }
  } catch {
    // No tool information: Sidebar keeps the built-in reading tools.
  }
  return { names, paths: [...paths] };
}
