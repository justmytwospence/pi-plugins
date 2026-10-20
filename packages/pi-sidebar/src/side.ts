// Sidebar's own half, running in the side pane's Pi. Every request it sends is main's last request
// plus Sidebar's part (main's newer entries, a live status note, Sidebar's conversation), so main's
// prompt cache serves almost all of it. Anything that would break that prefix, or a cache that has
// probably expired, stops the request before it is sent instead of spending on it.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSessionEntries,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Herdr, type PaneInfo } from "./herdr.ts";
import {
  CachedJson,
  FILES,
  LABEL_ENV,
  MAIN_PANE_ENV,
  PROTOCOL_VERSION,
  processAlive,
  readJson,
  writeJsonSync,
  type HostInfo,
  type LiveState,
  type PayloadSnapshot,
} from "./protocol.ts";
import { judgeToolCall } from "./read-only.ts";
import { SUPPORTED_APIS, inertPayload, requestedCacheTtlMs, splicePayload } from "./splice.ts";
import { assembleContext, describeLive, mainDelta, roleMessage, statusMessage } from "./transcript.ts";

const WIDGET = "sidebar";
const HERDR_BLOCKED = "herdr:blocked";
const COLD_MARGIN_MS = 20_000;
const MISS_RATIO = 0.5;
const MISS_MIN_TOKENS = 8_000;

export interface StatusPart {
  text: string;
  /** Dropped when the line does not fit; higher numbers go first. */
  optional?: number;
}

/** One status line that fits `width`: optional parts drop out first, then the line is cut. */
export function fitStatus(parts: StatusPart[], width: number, separator: string): string {
  let kept = parts;
  const line = () => kept.map((p) => p.text).join(separator);
  const droppable = parts.filter((p) => p.optional).sort((a, b) => b.optional! - a.optional!);
  for (const part of droppable) {
    if (visibleWidth(line()) <= width) break;
    kept = kept.filter((p) => p !== part);
  }
  return truncateToWidth(line(), Math.max(1, width));
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Prompt tokens main's last request covered, or a rough estimate from its size. */
export function mainPromptTokens(live: LiveState | undefined, snapshot: PayloadSnapshot | undefined): number {
  const u = live?.lastUsage;
  if (u && u.input + u.cacheRead + u.cacheWrite > 0) return u.input + u.cacheRead + u.cacheWrite;
  return snapshot ? Math.round(JSON.stringify(snapshot.payload).length / 4) : 0;
}

class EntryCache {
  private key = "";
  private entries: SessionEntry[] = [];
  read(path: string | undefined): SessionEntry[] {
    if (!path || !existsSync(path)) return [];
    const s = statSync(path);
    const key = `${path}:${s.mtimeMs}:${s.size}`;
    if (key !== this.key) {
      // Read-only: never SessionManager.open on main's file, which may migrate and rewrite it.
      this.entries = parseSessionEntries(readFileSync(path, "utf8")).filter(
        (e): e is SessionEntry => (e as { type?: string }).type !== "session",
      );
      this.key = key;
    }
    return this.entries;
  }
}

export function registerSide(pi: ExtensionAPI, dir: string, herdr = new Herdr()) {
  const host = new CachedJson<HostInfo>(join(dir, FILES.host));
  const payload = new CachedJson<PayloadSnapshot>(join(dir, FILES.payload));
  const liveFile = new CachedJson<LiveState>(join(dir, FILES.live));
  const entries = new EntryCache();
  let pending: PayloadSnapshot | undefined;
  let missed: { read: number; expected: number } | undefined;
  let lastAnswer: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const requestPayload = () => {
    try { writeFileSync(join(dir, FILES.wantPayload), String(Date.now())); } catch { /* host gone */ }
  };

  type Theme = ExtensionContext["ui"]["theme"];
  const statusParts = (theme: Theme): StatusPart[] => {
    const h = host.read();
    const live = liveFile.read();
    const parts: StatusPart[] = [{ text: theme.fg("accent", "◧ Sidebar") }, { text: theme.fg("dim", "read-only"), optional: 1 }];
    if (!h || !processAlive(h.pid)) parts.push({ text: theme.fg("warning", "main has exited") });
    else if (!live) parts.push({ text: theme.fg("dim", "waiting for main") });
    else if (live.state === "working") {
      const tool = live.tools[live.tools.length - 1];
      parts.push({ text: tool ? `main: ${tool.name} ${ago(Date.now() - tool.startedAt)}` : `main working ${ago(Date.now() - live.since)}` });
    } else parts.push({ text: theme.fg("dim", `main idle ${ago(Date.now() - live.since)}`) });
    if (missed) parts.push({ text: theme.fg("warning", `missed main's cache (${formatTokens(missed.read)}/${formatTokens(missed.expected)})`) });
    else if (lastAnswer) parts.push({ text: theme.fg("dim", lastAnswer), optional: 2 });
    return parts;
  };
  let widgetTui: { requestRender(): void } | undefined;
  const status = (_ctx?: ExtensionContext) => widgetTui?.requestRender();

  pi.on("session_start", async (_event, ctx) => {
    try {
      writeJsonSync(join(dir, FILES.side), { version: PROTOCOL_VERSION, pid: process.pid, startedAt: Date.now() });
    } catch { /* host dir missing: preflight reports it */ }
    requestPayload();
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET, (tui, theme) => {
      widgetTui = tui;
      return { render: (width: number) => [fitStatus(statusParts(theme), width, theme.fg("dim", " · "))], invalidate: () => {} };
    });
    timer = setInterval(() => status(), 1000);
    timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  // Sidebar's own requests are never worth keeping warm: main keeps the prefix warm.
  pi.on("cache_warming_decision", () => ({ action: "stop" as const }));

  // While a question is open, hold `herdr:blocked` so Herdr shows the pane as waiting (sidebar,
  // sound, phone card) and pi-status-footer shrinks to the one row herdr-web-ui's parser expects.
  async function confirm(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
    const emit = (data: unknown) => {
      try { pi.events?.emit(HERDR_BLOCKED, data); } catch { /* a failing listener must not break the dialog */ }
    };
    emit({ active: true, label: "Sidebar" });
    try {
      return await ctx.ui.confirm(title, message);
    } finally {
      emit({ active: false });
    }
  }

  async function waitForPayload(ms: number): Promise<PayloadSnapshot | undefined> {
    const deadline = Date.now() + ms;
    for (;;) {
      const snap = payload.read();
      if (snap || Date.now() >= deadline) return snap;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Checks before a prompt starts a request. Returns why not, or undefined to go ahead. */
  async function preflight(ctx: ExtensionContext): Promise<string | undefined> {
    const h = host.read();
    if (!h) return "this Sidebar has lost its main session (no host file).";
    let snap = payload.read();
    if (!snap) {
      requestPayload();
      snap = await waitForPayload(1500);
    }
    if (!snap) {
      return processAlive(h.pid)
        ? "main has not sent a request since it started, so there is no cached context to share yet. Ask again once main has taken a step."
        : "main has exited without a request to share.";
    }
    if (!SUPPORTED_APIS.has(snap.api)) return `main uses the ${snap.api} API, which Sidebar cannot share a cache with.`;
    if (ctx.model?.provider !== snap.provider || ctx.model?.id !== snap.model) {
      const model = ctx.modelRegistry.find(snap.provider, snap.model);
      if (!model) return `main's model ${snap.provider}/${snap.model} is not available here.`;
      if (!(await pi.setModel(model))) return `no credentials for main's model ${snap.provider}/${snap.model}.`;
    }
    if (h.thinkingLevel && pi.getThinkingLevel() !== h.thinkingLevel) pi.setThinkingLevel(h.thinkingLevel as never);

    const live = liveFile.read();
    const tokens = mainPromptTokens(live, snap);
    const age = Date.now() - snap.sentAt;
    const ttl = requestedCacheTtlMs(snap.api, snap.payload);
    if (age > ttl - COLD_MARGIN_MS) {
      if (!ctx.hasUI) return "main's prompt cache has probably expired, and there is no UI to confirm re-caching.";
      const ok = await confirm(ctx,
        "Main's prompt cache has probably expired",
        `Main's last request was ${ago(age)} ago and its cache lasts ${ago(ttl)}. Sending re-reads about ${formatTokens(tokens)} tokens of main's context uncached. Send anyway?`,
      );
      if (!ok) return "";
    }
    if (missed) {
      if (!ctx.hasUI) return "Sidebar's last answer missed main's cache.";
      const ok = await confirm(ctx,
        "Sidebar's last answer missed main's cache",
        `Only ${formatTokens(missed.read)} of about ${formatTokens(missed.expected)} tokens came from the cache. Another question may re-read main's context uncached. Send anyway?`,
      );
      if (!ok) return "";
      missed = undefined;
    }
    return undefined;
  }

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" as const };
    const refusal = await preflight(ctx);
    if (refusal === undefined) return { action: "continue" as const };
    if (refusal) ctx.ui.notify(`Sidebar did not send: ${refusal}`, "warning");
    if (ctx.hasUI && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(event.text);
    return { action: "handled" as const };
  });

  pi.on("context_with_system", (event) => {
    const snap = payload.read();
    const h = host.read();
    pending = snap;
    if (!snap || !h) return undefined;
    const all = entries.read(h.sessionFile);
    const live = liveFile.read();
    const ids = new Set(all.map((e) => e.id));
    const leaf = live?.leafId && ids.has(live.leafId) ? live.leafId : (all[all.length - 1]?.id ?? null);
    const delta = mainDelta(all, snap.leafId, leaf);
    const now = Date.now();
    const status = statusMessage(describeLive(live, delta, now, processAlive(h.pid)), now);
    return { messages: assembleContext(event.messages, delta.messages, roleMessage(now), status) };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const api = ctx.model?.api ?? "";
    const fail = (reason: string) => {
      ctx.ui.notify(`Sidebar did not send: ${reason}. Nothing was spent.`, "error");
      ctx.abort();
      return inertPayload(api, event.payload);
    };
    if (!pending) return fail("there is no copy of main's last request");
    if (pending.api !== api) return fail(`main is on the ${pending.api} API and Sidebar on ${api}`);
    const result = splicePayload(api, pending.payload, event.payload);
    if (!result.ok) return fail(result.reason);
    return result.payload;
  });

  // Requests carry the session id in routing headers (OpenRouter affinity, Codex); main's id keeps
  // Sidebar's requests on the machine that holds main's cache.
  pi.on("before_provider_headers", (event, ctx) => {
    const main = host.read()?.sessionId;
    const own = ctx.sessionManager.getSessionId();
    if (!main || !own || main === own) return;
    for (const [key, value] of Object.entries(event.headers)) {
      if (typeof value === "string" && value.includes(own)) event.headers[key] = value.split(own).join(main);
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } };
    if (message.role !== "assistant" || !message.usage) return;
    const read = message.usage.cacheRead ?? 0;
    const total = read + (message.usage.input ?? 0) + (message.usage.cacheWrite ?? 0);
    if (total === 0) return;
    const expected = mainPromptTokens(liveFile.read(), pending);
    if (expected >= MISS_MIN_TOKENS && read < expected * MISS_RATIO) {
      missed = { read, expected };
      ctx.ui.notify(`Sidebar's answer missed main's cache: ${formatTokens(read)} of ~${formatTokens(expected)} tokens cached. The next question will ask first.`, "warning");
    } else {
      missed = undefined;
    }
    lastAnswer = `last answer ${Math.round((read / total) * 100)}% cached · ${formatTokens(total - read)} new`;
    status(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    const verdict = judgeToolCall(event.toolName, event.input, ctx.cwd);
    return verdict.allowed ? undefined : { block: true, reason: verdict.reason };
  });

  async function hide(ctx: ExtensionContext): Promise<void> {
    const label = process.env[LABEL_ENV];
    if (!label) return;
    try {
      const pane = await herdr.findByLabel(label);
      if (!pane) return;
      const mainPane: PaneInfo | undefined = process.env[MAIN_PANE_ENV] ? await herdr.pane(process.env[MAIN_PANE_ENV]!) : undefined;
      const id = await herdr.park(pane.pane_id, pane.workspace_id);
      if (id !== pane.pane_id) await herdr.rename(id, label).catch(() => {});
      if (mainPane) await herdr.focusTab(mainPane.tab_id).catch(() => {});
    } catch (error) {
      ctx.ui.notify(`Sidebar: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  return { hide, hostInfo: () => readJson<HostInfo>(join(dir, FILES.host)) };
}
