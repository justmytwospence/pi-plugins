// Sidebar's agent: an in-process Pi session inside main's process (as plan mode's planners
// run theirs), with no extensions of its own except Sidebar's policy, passed inline. On main's
// model every request it sends is main's last request plus Sidebar's part, so main's prompt cache
// serves it; on another model it reads main's session as a transcript, with a cache of its own.
import {
  buildSessionContext,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
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
import { GUARD_ENV, judgeCall, REFUSED_TOOLS, SUBAGENT_ENV_CHANNEL, type SubagentEnvRequest } from "./guard.ts";
import { inertPayload, isStatusBlock, placeSideBreakpoint, requestedCacheTtlMs, splicePayload, SUPPORTED_APIS } from "./splice.ts";
import { compactExchange, EXCHANGE_ENTRY } from "./thread.ts";
import { assembleContext, describeLive, foreignRoleMessage, mainDelta, roleMessage, statusMessage, trimOpenTurn, type MainDelta } from "./transcript.ts";
import { derivedSessionId, interleave, newPartAt, TRANSCRIPT_TAG, TranscriptParts } from "./foreign.ts";
import { modelKey, type ModelChoice, type ModelLike } from "./models.ts";

const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const COLD_MARGIN_MS = 20_000;
export const MISS_RATIO = 0.5;
export const MISS_MIN_TOKENS = 8_000;

export type Preflight =
  | { kind: "send" }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "refuse"; reason: string };

export type SidebarEvent = Record<string, unknown> & { type: string };

/** Sidebar on another model than main's: what its requests are built with. */
interface Foreign {
  model: ModelLike;
  label: string;
  thinking?: string;
}

/** A missed cache: main's (shared), or Sidebar's own on another model. */
export interface Missed {
  read: number;
  expected: number;
  own?: boolean;
}

/** What quiz mode adds to each request while it is on. */
export interface QuizContext {
  /** Extra standing instructions for the role note, or undefined when quiz mode is off. */
  role(): string | undefined;
  /** The quiz part of the live status ("" when off). */
  status(): string;
}

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
export function replayMessages(ctx: Pick<ExtensionContext, "sessionManager">, trim = true): MainDelta {
  const entries = ctx.sessionManager.getEntries();
  const messages = buildSessionContext(entries as never, ctx.sessionManager.getLeafId()).messages as AgentMessage[];
  return trim ? trimOpenTurn(messages) : { messages, pending: [] };
}

/** Main's model, as Sidebar names it. */
export function mainLabel(ctx: Pick<ExtensionContext, "model">): string {
  const model = ctx.model as ModelLike | undefined;
  return model ? model.name?.trim() || model.id : "another model";
}

export class SidebarAgent {
  private session: AgentSession | undefined;
  private sessionModel: string | undefined;
  private creating: Promise<AgentSession> | undefined;
  private thread: AgentMessage[] = [];
  private turnStart = 0;
  private mode: "splice" | "replay" | "foreign" | undefined;
  /** Main's transcript as Sidebar reads it on another model, in parts that keep its own cache. */
  private readonly parts = new TranscriptParts();
  /** Sidebar's last request on another model: when, on which model, and the cache TTL it asked for. */
  private foreignSent: { at: number; model: string; ttl: number } | undefined;
  /** Whether that model's own cache should have served the request in flight. */
  private foreignWarm = false;
  /** The model Sidebar answers on: main's (`same`), or another, chosen by the controller. */
  modelChoice: () => ModelChoice = () => ({ kind: "same" });
  private readonly listeners = new Set<(event: SidebarEvent) => void>();
  private readonly turnListeners = new Set<(added: readonly AgentMessage[]) => void>();
  private generation = 0;
  /** Quiz mode's part of each request, when the controller has one. */
  quiz: QuizContext | undefined;
  missed: Missed | undefined;
  lastAnswer: string | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly main: MainState,
    private readonly now = () => Date.now(),
  ) {}

  get busy(): boolean {
    return !!this.session?.isStreaming;
  }

  /** Not answering and not starting a session for a question. */
  get idle(): boolean {
    return !this.busy && !(this.creating && !this.session);
  }

  get messages(): readonly AgentMessage[] {
    return this.thread;
  }

  onEvent(listener: (event: SidebarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every finished turn's new messages, in full (quiz mode reads its grades from them). */
  onTurn(listener: (added: readonly AgentMessage[]) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
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
    this.parts.rebase();
    await this.dispose();
  }

  /**
   * Messages added to the thread from outside a turn (a heads-up note), stored like an exchange.
   * Only while idle; the session is rebuilt from the thread on the next question.
   */
  async appendMessages(messages: AgentMessage[]): Promise<void> {
    if (!this.idle) throw new Error("Sidebar is answering");
    this.thread = [...this.thread, ...messages];
    try {
      this.pi.appendEntry(EXCHANGE_ENTRY, { version: 1, messages, timestamp: this.now() });
    } catch { /* main's session went away */ }
    await this.dispose();
  }

  /** Whether a question may go now, needs a confirmation first, or cannot go at all. */
  preflight(): Preflight {
    const choice = this.modelChoice();
    if (choice.kind === "unavailable") return { kind: "refuse", reason: `Sidebar's model ${choice.pattern} matches no model you are logged in to. /model picks another.` };
    if (choice.kind === "other") return this.foreignPreflight({ model: choice.model, label: choice.label });
    const cache = cachePreflight(this.main, this.now());
    if (cache.kind !== "send") return cache;
    if (this.missed) {
      return {
        kind: "confirm",
        title: "The last answer missed main's cache",
        message: `Only ${formatTokens(this.missed.read)} of about ${formatTokens(this.missed.expected)} tokens came from the cache. Another question may re-read main's context uncached.`,
      };
    }
    return { kind: "send" };
  }

  /** Whether the chosen model's own cache is probably warm for main's transcript. */
  private foreignCacheWarm(model: ModelLike, now: number): boolean {
    const sent = this.foreignSent;
    return !!sent && sent.model === modelKey(model) && now - sent.at < sent.ttl - COLD_MARGIN_MS;
  }

  private foreignPreflight(foreign: Foreign): Preflight {
    const ctx = this.main.ctx;
    if (!ctx) return { kind: "refuse", reason: "main's session is not ready yet." };
    const now = this.now();
    if (!this.foreignCacheWarm(foreign.model, now)) {
      const view = this.parts.peek(replayMessages(ctx, false).messages, foreign.model.contextWindow, now);
      if (view.tokens >= MISS_MIN_TOKENS) {
        return {
          kind: "confirm",
          title: `${foreign.label} has no warm cache of main's session`,
          message: `Sending reads main's transcript, about ${formatTokens(view.tokens)} tokens, uncached on ${foreign.label}. Later questions read it from ${foreign.label}'s own cache.`,
        };
      }
    }
    if (this.missed) {
      return {
        kind: "confirm",
        title: `The last answer missed ${foreign.label}'s cache`,
        message: `Only ${formatTokens(this.missed.read)} of about ${formatTokens(this.missed.expected)} tokens came from the cache. Another question may re-read main's transcript uncached.`,
      };
    }
    return { kind: "send" };
  }

  /** Ask a question (after preflight, and confirmation where it asked for one). */
  async ask(text: string, confirmed = false): Promise<void> {
    const ctx = this.main.ctx;
    if (!ctx) throw new Error("main's session is not ready yet");
    if (confirmed) this.missed = undefined;
    const session = await this.ensureSession(ctx);
    if (session.isStreaming) {
      await session.followUp(text);
      return;
    }
    this.turnStart = session.messages.length;
    await session.prompt(text);
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
    const choice = this.modelChoice();
    if (choice.kind === "unavailable") throw new Error(`Sidebar's model ${choice.pattern} matches no model you are logged in to.`);
    const foreign: Foreign | undefined = choice.kind === "other" ? { model: choice.model, label: choice.label, ...(choice.thinking ? { thinking: choice.thinking } : {}) } : undefined;
    const request = this.main.request;
    const model = foreign ? (foreign.model as NonNullable<ExtensionContext["model"]>) : request ? ctx.modelRegistry.find(request.provider, request.model) : ctx.model;
    if (!model) throw new Error("no model");
    const key = `${foreign ? `other:${foreign.thinking ?? ""}:` : ""}${model.provider}/${model.id}`;
    if (this.session && this.sessionModel === key) return this.session;
    if (this.creating && this.sessionModel === key) return this.creating;
    await this.dispose();
    const generation = this.generation;
    this.sessionModel = key;
    this.creating = this.create(ctx, model, foreign).then((session) => {
      if (generation !== this.generation) {
        session.dispose();
        throw new Error("Sidebar was reset while starting");
      }
      this.session = session;
      return session;
    });
    return this.creating;
  }

  private async create(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>, foreign?: Foreign): Promise<AgentSession> {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
    const sources = toolSources(this.pi);
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      // Main's tool-providing extensions only, so their other hooks (footers, cache questions,
      // effort judgments) do not run twice. Skills and prompt templates load as in main.
      noExtensions: true,
      noThemes: true,
      // On main's model the request carries main's system prompt (with its context files); on
      // another model Sidebar's own prompt stands, so it loads the project's context files itself.
      noContextFiles: !foreign,
      additionalExtensionPaths: sources.paths,
      extensionFactories: [this.policy(foreign), ...sources.builtins] as never,
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create();
    inheritProviders(ctx, modelRuntime);
    await modelRuntime.refresh({ allowNetwork: false });
    // On another model, a session id derived from main's keeps OpenAI's cache routing
    // (prompt_cache_key, Codex's session) the same when Sidebar's session is rebuilt.
    const mainId = this.main.sessionId ?? ctx.sessionManager.getSessionId();
    const sessionManager = SessionManager.inMemory(ctx.cwd, foreign && mainId ? { id: derivedSessionId(mainId, "sidebar") } : undefined);
    for (const message of this.thread) {
      try { sessionManager.appendMessage(message as never); } catch { /* a message Pi will not store is left out */ }
    }
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: (foreign?.thinking ?? this.pi.getThinkingLevel()) as never,
      tools: sources.names,
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
        for (const listener of this.turnListeners) {
          try { listener(added); } catch { /* a listener must not break the agent */ }
        }
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
    if (this.mode === "foreign") {
      // Only a request the model's own cache should have served can miss it.
      this.missed = this.foreignWarm && total >= MISS_MIN_TOKENS && read < total * MISS_RATIO ? { read, expected: total, own: true } : undefined;
    } else {
      const expected = this.main.promptTokens();
      this.missed = this.mode !== undefined && expected >= MISS_MIN_TOKENS && read < expected * MISS_RATIO ? { read, expected } : undefined;
    }
    this.lastAnswer = `${Math.round((read / total) * 100)}% cached · ${formatTokens(total - read)} new`;
  }

  /** Sidebar's policy, loaded into its session as an inline extension. */
  private policy(foreign?: Foreign): ExtensionFactory {
    return (cpi: ExtensionAPI) => {
      cpi.on("cache_warming_decision", () => ({ action: "stop" as const }));

      // Sidebar's subagents run under the same guard (pi-subagents asks this channel for their env).
      cpi.events.on(SUBAGENT_ENV_CHANNEL, (data: unknown) => {
        const request = data as Partial<SubagentEnvRequest> | undefined;
        if (request?.version === 1 && !request.probe && request.env) request.env[GUARD_ENV] = "1";
      });

      cpi.on("tool_call", async (event, cctx) => {
        const verdict = await judgeCall(event.toolName, event.input, {
          cwd: cctx.cwd,
          registry: this.main.ctx?.modelRegistry ?? cctx.modelRegistry,
          tool: (name) => cpi.getAllTools().find((tool) => tool.name === name),
          subagentsGuarded: () => subagentsGuarded(cpi.events),
          ...(cctx.signal ? { signal: cctx.signal } : {}),
        });
        return verdict.allowed ? undefined : { block: true, reason: verdict.reason };
      });

      cpi.on("context_with_system", (event) => {
        const ctx = this.main.ctx;
        if (!ctx) return undefined;
        const now = this.now();
        const request = this.main.request;
        const entries = ctx.sessionManager.getEntries() as never;
        const leaf = ctx.sessionManager.getLeafId();
        if (foreign) {
          // Another model: its role, then main's session as a transcript of someone else's work in
          // parts, interleaved with Sidebar's own exchanges as they happened, then the live status.
          // Each request extends the previous one, so the model's own cache serves all but the end.
          this.mode = "foreign";
          const leading = event.messages[0]?.role === "system" ? [event.messages[0]] : [];
          const thread = event.messages.slice(leading.length);
          const view = this.parts.build(replayMessages(ctx, false).messages, foreign.model.contextWindow, now, newPartAt(thread));
          this.foreignWarm = view.continued && this.foreignCacheWarm(foreign.model, now);
          const status = statusMessage(describeLive(this.main.live, { messages: [], pending: view.pending }, now), now, this.quiz?.status());
          const role = foreignRoleMessage({ sidebar: foreign.label, main: mainLabel(ctx) }, now, this.quiz?.role());
          return { messages: [...leading, role, ...interleave(view.messages, view.threadAt, thread), status] };
        }
        if (request) {
          this.mode = "splice";
          const delta = mainDelta(entries, request.leafId, leaf);
          const status = statusMessage(describeLive(this.main.live, delta, now), now, this.quiz?.status());
          return { messages: assembleContext(event.messages, delta.messages, roleMessage(now, this.quiz?.role()), status) };
        }
        this.mode = "replay";
        const rebuilt = replayMessages(ctx);
        const replay = rebuilt.messages;
        const status = statusMessage(describeLive(this.main.live, { messages: [], pending: rebuilt.pending }, now), now, this.quiz?.status());
        const role = roleMessage(now, this.quiz?.role());
        // Main's transcript starts with its prompt and tools once it has sent anything; before that,
        // Sidebar's own leading system message stands in.
        if (replay[0]?.role === "system") {
          const own = event.messages[0]?.role === "system" ? event.messages.slice(1) : event.messages;
          return { messages: [...replay, ...assembleContext(own, [], role, status)] };
        }
        return { messages: assembleContext(event.messages, replay, role, status) };
      });

      cpi.on("before_provider_request", (event, cctx) => {
        const api = cctx.model?.api ?? "";
        const fail = (reason: string) => {
          this.emit({ type: "sidebar_error", message: `Sidebar did not send: ${reason}. Nothing was spent.` });
          cctx.abort();
          return inertPayload(api, event.payload);
        };
        if (foreign) {
          // Its own cache: a breakpoint at the end of everything before the live status.
          const payload = anchorForeign(api, event.payload);
          this.foreignSent = { at: this.now(), model: modelKey(foreign.model), ttl: requestedCacheTtlMs(api, payload) };
          return payload;
        }
        if (this.mode === "replay") return replayPayload(api, event.payload, cctx.sessionManager.getSessionId(), this.main.sessionId);
        const request = this.main.request;
        if (this.mode !== "splice" || !request) return fail("there is no copy of main's last request");
        if (request.api !== api) return fail(`main is on the ${request.api} API and Sidebar on ${api}`);
        const result = splicePayload(api, request.payload, event.payload);
        return result.ok ? result.payload : fail(result.reason);
      });

      // Routing headers carry the session id (OpenRouter affinity, Codex): main's id keeps Sidebar's
      // requests on the machine that holds main's cache.
      cpi.on("before_provider_headers", (event, cctx) => {
        // On another model Sidebar has its own cache, routed by its own (derived) session id.
        if (foreign) return;
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

/**
 * Whether main's prompt cache can serve a request built on main's last one now: refused when the
 * API or model cannot share it, a confirmation when it has probably expired.
 */
export function cachePreflight(main: MainState, now: number): Preflight {
  const ctx = main.ctx;
  if (!ctx) return { kind: "refuse", reason: "main's session is not ready yet." };
  const request = main.request;
  // Without a request in memory (after a restart, /reload, /tree or a compaction), Sidebar rebuilds
  // main's request from its session; main's last answer says how warm its cache still is.
  const last = request ? undefined : main.lastAnswer();
  if (!request && !last) return { kind: "send" }; // no conversation yet: only the prompt and tools
  const api = request?.api ?? ctx.model?.api ?? "";
  if (!SUPPORTED_APIS.has(api)) return { kind: "refuse", reason: `main uses the ${api} API, which Sidebar cannot share a cache with.` };
  if (request && !ctx.modelRegistry.find(request.provider, request.model)) return { kind: "refuse", reason: `main's model ${request.provider}/${request.model} is not available.` };
  const age = now - (request?.sentAt ?? last!.at);
  const ttl = request ? requestedCacheTtlMs(request.api, request.payload) : configuredCacheTtlMs();
  if (age > ttl - COLD_MARGIN_MS) {
    return {
      kind: "confirm",
      title: "Main's prompt cache has probably expired",
      message: `Main's last request was ${ago(age)} ago and its cache lasts ${ago(ttl)}. Sending re-reads about ${formatTokens(main.promptTokens())} tokens uncached.`,
    };
  }
  return { kind: "send" };
}

/** Whether pi-subagents in this session asks for subagent environment (so subagents get the guard). */
export function subagentsGuarded(events: { emit(channel: string, data: unknown): void }): boolean {
  const probe: SubagentEnvRequest = { version: 1, env: {}, probe: true };
  try { events.emit(SUBAGENT_ENV_CHANNEL, probe); } catch { return false; }
  return probe.supported === true;
}

type ToolSourceApi = Pick<ExtensionAPI, "getAllTools">;

/**
 * Main's tools, for Sidebar's session: the extensions that provide them (by source path; Pi's
 * built-in codemode, tool search and MCP by their factories) and the names to allow. Every tool
 * main has is allowed, switched on or not (a session's tool list is its allowlist, so a tool main
 * switches on later, such as web_enable's, must be on it). What the model sees still comes from
 * main's request. Tools the guard always refuses, and pi-sidebar itself, are left out.
 */
export function toolSources(pi: ToolSourceApi): { names: string[]; paths: string[]; builtins: ExtensionFactory[] } {
  const names = new Set<string>(BUILTIN_TOOLS);
  const paths = new Set<string>();
  const builtins = new Map<string, ExtensionFactory>();
  let tools: ReturnType<ExtensionAPI["getAllTools"]> = [];
  try { tools = pi.getAllTools(); } catch { /* no tool information: built-ins only */ }
  for (const tool of tools) {
    if (REFUSED_TOOLS.has(tool.name)) continue;
    const path = (tool.sourceInfo as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string") continue;
    if (path === "builtin:codemode") builtins.set(path, createCodemodeExtension() as ExtensionFactory);
    else if (path === "builtin:tool_search") builtins.set(path, createToolSearchExtension() as ExtensionFactory);
    else if (path === "builtin:mcp") builtins.set(path, createMcpExtension() as ExtensionFactory);
    else if (path.startsWith("builtin:")) {
      // Pi's core tools are built into every session.
    } else if (/[\\/]pi-sidebar[\\/]/.test(path)) continue;
    else paths.add(path);
    names.add(tool.name);
  }
  return { names: [...names], paths: [...paths], builtins: [...builtins.values()] };
}

/** The cache TTL main's requests ask for when none is in memory: Pi's retention setting. */
export function configuredCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.PI_CACHE_RETENTION === "long" ? 60 * 60_000 : 5 * 60_000;
}

type Block = Record<string, unknown> & { type?: string; text?: string; cache_control?: unknown };
type Msg = { role?: string; content?: unknown };

const ANTHROPIC_MAX_BREAKPOINTS = 4;

/**
 * On Anthropic, the cache breakpoints of a request on another model, which only ever grows at the
 * end: one on its last block before the live status (the next request extends everything up to
 * there), and one on the newest transcript part when a slot is free. Each takes the style of the
 * system prompt's (so a 1-hour retention keeps the model's cache between questions). Other APIs
 * cache prefixes on their own.
 */
export function anchorForeign(api: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const out = structuredClone(payload) as Record<string, unknown>;
  if (api !== "anthropic-messages" || !Array.isArray(out.messages)) return out;
  const blocks: Block[] = [];
  for (const message of out.messages as Msg[]) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Block[]) if (block && typeof block === "object") blocks.push(block);
  }
  for (const block of blocks) delete block.cache_control;
  const fixedBlocks = [...((Array.isArray(out.system) ? out.system : []) as Block[]), ...((Array.isArray(out.tools) ? out.tools : []) as Block[])];
  const marked = fixedBlocks.filter((b) => b && typeof b === "object" && b.cache_control !== undefined);
  const marker = marked.map((b) => b.cache_control).find((c) => c && typeof c === "object") ?? { type: "ephemeral" };
  let free = ANTHROPIC_MAX_BREAKPOINTS - marked.length;
  const system = (Array.isArray(out.system) ? (out.system as Block[]) : []).filter((b) => b && b.cache_control !== undefined);
  if (free < 2 && system.length >= 2) {
    // Two marks on the system prompt (a Claude subscription login): the first is redundant, since
    // the second covers more of the same prefix.
    delete system[0]!.cache_control;
    free++;
  }
  if (free < 1) return out;
  const end = blocks.findLastIndex((b, i) => i < blocks.length && !isStatusBlock(b) && b.type !== "thinking" && b.type !== "redacted_thinking");
  if (end === -1) return out;
  blocks[end]!.cache_control = structuredClone(marker);
  if (free >= 2) {
    const part = blocks.findLastIndex((b, i) => i < end && b.type === "text" && typeof b.text === "string" && b.text.startsWith(`<${TRANSCRIPT_TAG} `));
    if (part !== -1) blocks[part]!.cache_control = structuredClone(marker);
  }
  return out;
}

/** Where Sidebar's part starts in a request: its role note. */
export const ROLE_SEAM = (text: string): boolean => text.startsWith("<sidebar>\n");

/**
 * A request Sidebar rebuilt from main's session. Its prefix is main's conversation; on Anthropic the
 * cache breakpoint goes where main's own last request ended (the last user-role block before
 * Sidebar's part), so the lookup lands on the entry main wrote. Fields carrying Sidebar's session
 * id (OpenAI's prompt_cache_key) get main's, which routes to main's cache.
 */
export function replayPayload(api: string, payload: unknown, ownSessionId: string | undefined, mainSessionId: string | undefined): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const out = structuredClone(payload) as Record<string, unknown>;
  if (ownSessionId && mainSessionId && ownSessionId !== mainSessionId) {
    for (const [key, value] of Object.entries(out)) {
      if (value === ownSessionId) out[key] = mainSessionId;
    }
  }
  return anchorPayload(api, out, ROLE_SEAM);
}

/**
 * On Anthropic, the request's cache breakpoints for a prefix Sidebar built itself: one on the last
 * user-role block before the seam (the first block `seam` matches), so the next request finds this
 * one's entry, and (with `sideBreakpoint`) one on Sidebar's part after the seam. Other APIs cache
 * prefixes on their own, so their requests pass unchanged (as a copy).
 */
export function anchorPayload(api: string, payload: unknown, seam: (text: string) => boolean, sideBreakpoint = true): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const out = structuredClone(payload) as Record<string, unknown>;
  if (api !== "anthropic-messages" || !Array.isArray(out.messages)) return out;
  const messages = out.messages as Msg[];
  const flat: Array<{ role: string; block: Block }> = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Block[]) if (block && typeof block === "object") flat.push({ role: message.role ?? "", block });
  }
  const roleAt = flat.findIndex(({ block }) => block.type === "text" && typeof block.text === "string" && seam(block.text));
  if (roleAt <= 0) return out;
  let boundary = -1;
  for (let i = roleAt - 1; i >= 0; i--) {
    const { role, block } = flat[i]!;
    if (role === "user" && block.type !== "thinking" && block.type !== "redacted_thinking") {
      boundary = i;
      break;
    }
  }
  if (boundary === -1) return out;
  const count = (value: unknown): number =>
    Array.isArray(value) ? value.reduce<number>((n, item) => n + (item && typeof item === "object" && (item as Block).cache_control !== undefined ? 1 : 0), 0) : 0;
  const fixed = count(out.system) + count(out.tools);
  if (fixed >= ANTHROPIC_MAX_BREAKPOINTS) return out;
  const marker = [...((Array.isArray(out.system) ? out.system : []) as Block[]), ...((Array.isArray(out.tools) ? out.tools : []) as Block[])]
    .map((b) => b?.cache_control)
    .find((c) => c && typeof c === "object") ?? { type: "ephemeral" };
  for (const { block } of flat) delete block.cache_control;
  flat[boundary]!.block.cache_control = structuredClone(marker);
  if (sideBreakpoint) placeSideBreakpoint(out, flat.slice(roleAt).map(({ block }) => block), fixed + 1);
  return out;
}
