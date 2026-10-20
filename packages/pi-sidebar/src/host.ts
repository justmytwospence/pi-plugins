// The main session's half of Sidebar: publish what Sidebar needs (main's last provider request
// exactly as sent, which entries it covered, and what main is doing right now), and open, park or
// close the Sidebar pane. It writes nothing until a Sidebar is attached, apart from keeping the
// last request in memory.
import { existsSync, rmSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Herdr, inHerdr, sidebarLabel, type PaneInfo } from "./herdr.ts";
import {
  FILES,
  HOST_ENV,
  KEYS_ENV,
  LABEL_ENV,
  MAIN_PANE_ENV,
  PROTOCOL_VERSION,
  RATIO_ENV,
  LatestWriter,
  ensureDir,
  parseRatio,
  runtimeDir,
  sanitizeId,
  sideAlive,
  writeJsonSync,
  type FinishedTool,
  type HostInfo,
  type LiveState,
  type LiveTool,
  type PayloadSnapshot,
} from "./protocol.ts";
import { summarizeArgs } from "./transcript.ts";

const LIVE_THROTTLE_MS = 250;
const STREAM_TAIL_CHARS = 600;
const TOGGLE_DEBOUNCE_MS = 700;

type Json = Record<string, unknown>;

/** The system prompt text a provider request carries, for telling main's own requests apart. */
export function payloadSystemText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Json;
  const parts: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === "object") {
      const v = value as Json;
      if (typeof v.text === "string") parts.push(v.text);
      else if (v.content !== undefined) collect(v.content);
    }
  };
  collect(p.system);
  collect(p.instructions);
  const list = Array.isArray(p.messages) ? p.messages : Array.isArray(p.input) ? p.input : [];
  const first = list[0] as Json | undefined;
  if (first && (first.role === "system" || first.role === "developer")) collect(first.content);
  return parts.join("\n");
}

/**
 * Main's extension-loading flags, so Sidebar loads the same extensions, including this one when main
 * loaded it with `-e` rather than from settings. Relative paths are resolved against main's cwd.
 */
export function forwardedArgs(argv: string[], cwd: string): string[] {
  const out: string[] = [];
  const BARE = new Set(["-ne", "--no-extensions", "--no-mcp", "-ns", "--no-skills"]);
  const path = (value: string) => (/^(?:builtin:|npm:|git:|https?:)/.test(value) || isAbsolute(value) ? value : resolve(cwd, value));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (BARE.has(arg)) out.push(arg);
    else if ((arg === "-e" || arg === "--extension") && argv[i + 1] !== undefined) out.push("-e", path(argv[++i]!));
    else if (arg.startsWith("--extension=")) out.push("-e", path(arg.slice("--extension=".length)));
  }
  return out;
}

const PREVIEW_CHARS = 1500;

/** The text of a tool result, shortened, for the live note. */
export function resultPreview(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  const text = Array.isArray(content)
    ? content.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("\n")
    : typeof result === "string" ? result : "";
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}\n… (${trimmed.length - PREVIEW_CHARS} more characters)` : trimmed;
}

/** Whether a request is one of main's conversation requests (not a summary or a side call). */
export function isConversationRequest(payload: unknown, modelId: string | undefined, systemPrompt: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Json;
  if (modelId && typeof p.model === "string" && p.model !== modelId) return false;
  const probe = systemPrompt.trim().slice(0, 200);
  return !probe || payloadSystemText(payload).includes(probe);
}

export function registerHost(pi: ExtensionAPI, herdr = new Herdr()) {
  let dir: string | undefined;
  let sessionId: string | undefined;
  let lastPayload: { snapshot: Omit<PayloadSnapshot, "payload">; payload: Json } | undefined;
  let pendingFlush = false;
  let watcher: FSWatcher | undefined;
  let attachedCache: { at: number; value: boolean } | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCtx: ExtensionContext | undefined;
  let toggling = false;
  let lastToggle = 0;
  let payloadWriter: LatestWriter | undefined;
  let liveWriter: LatestWriter | undefined;
  const live: LiveState = { version: PROTOCOL_VERSION, state: "idle", since: Date.now(), tools: [], leafId: null, updatedAt: Date.now() };

  const attached = (): boolean => {
    if (!dir) return false;
    const now = Date.now();
    if (attachedCache && now - attachedCache.at < 2000) return attachedCache.value;
    const value = existsSync(dir) && sideAlive(dir);
    attachedCache = { at: now, value };
    return value;
  };

  const hostInfo = (ctx: ExtensionContext): HostInfo => ({
    version: PROTOCOL_VERSION,
    pid: process.pid,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
    mainPaneId: process.env.HERDR_PANE_ID,
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
    thinkingLevel: pi.getThinkingLevel(),
    updatedAt: Date.now(),
  });

  const writeHost = (ctx: ExtensionContext) => {
    if (!dir || !existsSync(dir)) return;
    try { writeJsonSync(join(dir, FILES.host), hostInfo(ctx)); } catch { /* best effort */ }
  };

  const flushPayload = (sync = false) => {
    if (!dir || !lastPayload || !existsSync(dir)) return;
    pendingFlush = false;
    const snapshot: PayloadSnapshot = { ...lastPayload.snapshot, payload: lastPayload.payload };
    if (sync) {
      try { payloadWriter!.writeSync(snapshot); } catch { /* best effort */ }
    } else {
      payloadWriter!.write(snapshot);
    }
  };

  const writeLive = () => {
    liveTimer = undefined;
    if (!dir || !attached()) return;
    live.updatedAt = Date.now();
    liveWriter!.write(live);
  };
  const scheduleLive = (now = false) => {
    if (now) {
      if (liveTimer) clearTimeout(liveTimer);
      writeLive();
      return;
    }
    if (!liveTimer) liveTimer = setTimeout(writeLive, LIVE_THROTTLE_MS);
  };

  const stopWatching = () => {
    watcher?.close();
    watcher = undefined;
  };
  const startWatching = () => {
    stopWatching();
    if (!dir || !existsSync(dir)) return;
    try {
      watcher = watch(dir, (_event, file) => {
        if (file === FILES.wantPayload && dir && existsSync(join(dir, FILES.wantPayload))) {
          try { rmSync(join(dir, FILES.wantPayload), { force: true }); } catch { /* raced */ }
          attachedCache = undefined;
          if (lastCtx) writeHost(lastCtx);
          flushPayload(true);
          scheduleLive(true);
        } else if (file === FILES.side) {
          attachedCache = undefined;
        }
      });
      watcher.unref?.();
    } catch {
      watcher = undefined;
    }
  };

  const bind = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    const id = ctx.sessionManager.getSessionId();
    if (id !== sessionId) {
      sessionId = id;
      dir = runtimeDir(id);
      payloadWriter = new LatestWriter(join(dir, FILES.payload));
      liveWriter = new LatestWriter(join(dir, FILES.live));
      lastPayload = undefined;
      attachedCache = undefined;
    }
    live.leafId = ctx.sessionManager.getLeafId();
    if (existsSync(dir!)) {
      writeHost(ctx);
      startWatching();
      scheduleLive(true);
    } else {
      stopWatching();
    }
  };

  // A new, resumed or forked main session gets its own Sidebar: the old one was closed when the
  // previous session shut down, and its thread comes back when that session is resumed.
  pi.on("session_start", async (_event, ctx) => { bind(ctx); });

  // Quitting or leaving this session ends its Sidebar and removes the shared files (they hold a
  // copy of main's conversation). A reload keeps both: the reloaded host picks them up again.
  pi.on("session_shutdown", async (event) => {
    stopWatching();
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = undefined;
    if (event.reason === "reload" || !dir || !existsSync(dir)) return;
    if (inHerdr() && process.env.HERDR_PANE_ID) {
      try { await closeSidebar(process.env.HERDR_PANE_ID); } catch { /* best effort */ }
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  pi.on("model_select", async (_event, ctx) => { lastCtx = ctx; writeHost(ctx); });
  pi.on("thinking_level_select", async (_event, ctx) => { if (ctx) { lastCtx = ctx; writeHost(ctx); } });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!model || !isConversationRequest(event.payload, model.id, ctx.getSystemPrompt())) return undefined;
    lastCtx = ctx;
    // Keep a reference: handlers that run later may still edit this object in place, so it is
    // serialized only once the provider has answered.
    lastPayload = {
      snapshot: {
        version: PROTOCOL_VERSION,
        api: model.api,
        provider: model.provider,
        model: model.id,
        leafId: ctx.sessionManager.getLeafId(),
        sentAt: Date.now(),
      },
      payload: event.payload as Json,
    };
    pendingFlush = true;
    return undefined;
  });

  pi.on("after_provider_response", () => {
    if (pendingFlush && attached()) flushPayload();
  });

  pi.on("agent_start", () => {
    live.state = "working";
    live.since = Date.now();
    live.tools = [];
    live.finished = [];
    live.streaming = undefined;
    scheduleLive(true);
  });

  pi.on("agent_end", (_event, ctx) => {
    live.state = "idle";
    live.since = Date.now();
    live.tools = [];
    live.finished = [];
    live.streaming = undefined;
    live.leafId = ctx.sessionManager.getLeafId();
    scheduleLive(true);
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
    const text = (event.message.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (!text) return;
    live.streaming = text.slice(-STREAM_TAIL_CHARS);
    scheduleLive();
  });

  pi.on("message_end", (event, ctx) => {
    live.leafId = ctx.sessionManager.getLeafId();
    const message = event.message as { role: string; toolCallId?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
    if (message.role === "toolResult" && live.finished?.length) {
      // Committed: the session file has it now.
      live.finished = live.finished.filter((t) => t.id !== message.toolCallId);
    }
    if (message.role === "assistant") {
      live.streaming = undefined;
      if (message.usage) {
        live.lastUsage = {
          input: message.usage.input ?? 0,
          output: message.usage.output ?? 0,
          cacheRead: message.usage.cacheRead ?? 0,
          cacheWrite: message.usage.cacheWrite ?? 0,
        };
      }
    }
    scheduleLive();
  });

  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId) return;
    const tool: LiveTool = { id: event.toolCallId, name: event.toolName, summary: summarizeArgs(event.args), startedAt: Date.now() };
    live.tools = [...live.tools.filter((t) => t.id !== tool.id), tool];
    scheduleLive(true);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.parentToolCallId) return;
    const started = live.tools.find((t) => t.id === event.toolCallId);
    live.tools = live.tools.filter((t) => t.id !== event.toolCallId);
    if (started) {
      const finished: FinishedTool = {
        ...started,
        isError: !!event.isError,
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        preview: resultPreview(event.result),
      };
      live.finished = [...(live.finished ?? []).filter((t) => t.id !== started.id), finished];
    }
    live.leafId = ctx.sessionManager.getLeafId();
    scheduleLive(true);
  });

  // ------------------------------------------------------------------ pane control

  async function myPane(): Promise<PaneInfo> {
    const id = process.env.HERDR_PANE_ID!;
    const pane = await herdr.pane(id);
    if (!pane) throw new Error(`Herdr does not know this pane (${id})`);
    return pane;
  }

  async function closeSidebar(mainPaneId: string): Promise<void> {
    const pane = await herdr.findByLabel(sidebarLabel(mainPaneId));
    if (pane) await herdr.close(pane.pane_id);
  }

  async function create(ctx: ExtensionContext, me: PaneInfo, fresh: boolean): Promise<void> {
    if (!ctx.model) throw new Error("main has no model selected");
    bind(ctx);
    ensureDir(dir!);
    writeHost(ctx);
    flushPayload(true);
    startWatching();
    const label = sidebarLabel(me.pane_id);
    const sessionDir = join(getAgentDir(), "sidebar-sessions", sanitizeId(sessionId!));
    const args = [
      ...forwardedArgs(process.argv.slice(2), process.cwd()),
      "--session-dir", sessionDir, ...(fresh ? [] : ["--continue"]),
      "--model", `${ctx.model.provider}/${ctx.model.id}`, "--thinking", pi.getThinkingLevel(),
    ];
    const env: Record<string, string> = { [HOST_ENV]: dir!, [MAIN_PANE_ENV]: me.pane_id, [LABEL_ENV]: label };
    for (const key of ["PI_CACHE_RETENTION", KEYS_ENV, RATIO_ENV]) if (process.env[key]) env[key] = process.env[key]!;
    const pane = await herdr.split(me.pane_id, { ratio: parseRatio(process.env[RATIO_ENV]), cwd: ctx.cwd, env, focus: true });
    try {
      await herdr.rename(pane, label);
      await herdr.startPi(`sidebar-${sanitizeId(sessionId!).slice(-8)}`, pane, args);
    } catch (error) {
      await herdr.close(pane).catch(() => {});
      throw error;
    }
  }

  async function toggle(ctx: ExtensionContext, mode: "toggle" | "new" = "toggle"): Promise<void> {
    if (!inHerdr()) {
      ctx.ui.notify("Sidebar opens in a Herdr pane beside this one; run Pi inside Herdr to use it.", "warning");
      return;
    }
    const now = Date.now();
    if (toggling || (mode === "toggle" && now - lastToggle < TOGGLE_DEBOUNCE_MS)) return;
    toggling = true;
    lastToggle = now;
    try {
      const me = await myPane();
      const label = sidebarLabel(me.pane_id);
      let existing = await herdr.findByLabel(label);
      if (existing && mode === "new") {
        await herdr.close(existing.pane_id);
        existing = undefined;
      }
      if (!existing) {
        await create(ctx, me, mode === "new");
        return;
      }
      if (existing.tab_id === me.tab_id) {
        const id = await herdr.park(existing.pane_id, me.workspace_id);
        if (id !== existing.pane_id) await herdr.rename(id, label).catch(() => {});
      } else {
        bind(ctx);
        flushPayload(true);
        const id = await herdr.show(existing.pane_id, me, parseRatio(process.env[RATIO_ENV]), true);
        if (id !== existing.pane_id) await herdr.rename(id, label).catch(() => {});
      }
    } catch (error) {
      ctx.ui.notify(`Sidebar: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      toggling = false;
    }
  }

  return { toggle };
}
