// A footer with optional owner-provided controls. No model requests or prompt
// modifications; the installed editor is retained, its native actions reused,
// and its two border lines redrawn to carry the context gauge. Credentials are sent only to their own
// provider's usage endpoint: Pi's Codex OAuth token (from Pi's model registry,
// to ChatGPT's usage endpoint, as Codex CLI's /status) and Pi's Anthropic OAuth
// token (from Pi's model registry, to Anthropic's OAuth usage endpoint, as Claude
// Code's /status). When Pi has no Anthropic subscription login, Claude Code's
// OAuth token (Keychain or ~/.claude/.credentials.json) is used instead, and
// without that the usage JSON comes from $PI_STATUS_FOOTER_CLAUDE_USAGE_CMD when
// set. Changes take effect with /reload.
import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { builtinMcpOwnsCommand, connectedMcpServers, countMcp, McpConfigReader, MCP_STATUS_KEY, type McpCount } from "./mcp.ts";
import { SHOW_TIMER_AFTER_MS, WORKING_REFRESH_MS, WORKING_STATS_CHANNEL, workingMessage, WorkingStats, workingStatsService, type WorkingStatsRequest } from "./working.ts";
import { WORKING_MESSAGE_EVENT, type WorkingMessageClaim } from "./working-message.ts";
import { SESSION_CHROME_CHANNEL, type SessionChromeOverrides, type SessionChromeRequest } from "./session-chrome.ts";
import { WORKFLOW_EXPLANATIONS, workflowBadge } from "./workflow-ui.ts";
import { queryFooterActions, type FooterAction, type FooterActionId } from "./footer-actions.ts";
import { querySystem1State, type System1Status } from "./system1-contract.ts";
import { settingsCycles, SETTINGS_REASONING_COMMITTED, type SettingCycleSnapshot, type SettingKey } from "./settings-cycle.ts";
import { createFooterActionController, createFooterComponent, type FooterEditor, type FooterTui, type FooterHit, type FooterLayout } from "./interactions.ts";
import { ARGON_MODEL, argonQuotaVariant, createProviderUsageCollector, dispatchProviderUsage, isUsageStale, selectGooglePool, type ArgonQuotaVariant, type ProviderUsage, type UsageSource } from "./provider-usage.ts";
import { isVirtual, routedModel } from "./routed-model.ts";
import { queryWaterfall } from "./waterfall-contract.ts";
import { parseClaudeQuota, codexRateLimitsEvent, mergeQuota, parseClaudeHeaders, readCodexUsage, readPiAnthropicUsage, claudeCodeUserAgent, type Quota } from "@justmytwospence/pi-subscription-usage";
export { parseClaudeQuota, parseCodexUsage, codexRateLimitsEvent, codexAccountId, mergeQuota, parseCodexHeaders, parseClaudeHeaders, codexWindowLabel } from "@justmytwospence/pi-subscription-usage";
export type { Quota, QuotaWindow } from "@justmytwospence/pi-subscription-usage";

export * from "./mcp.ts";
export * from "./working.ts";
export * from "./session-chrome.ts";

/** Account-display aliases do not change inference providers or routing eligibility. */
export function accountUsageProvider(provider: string): string {
  return provider === "openai" ? "openai-codex" : provider;
}

const STATE_KEY = "personal-status-footer";
const QUOTA_STALE_MS = 10 * 60_000;
const GIT_TTL_MS = 3_000;
const TICK_MS = 15_000;
// Built-in MCP exposes no status; its tools and mcp.json are polled instead.
const MCP_TICK_MS = 5_000;
// Claude Code's own /status source. Readings for Claude Code's login are cached
// where Claude's status line keeps them; readings for Pi's login get their own file.
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TTL_MS = 5 * 60_000;
const CLAUDE_LOCK_STALE_MS = 2 * 60_000;

type RecordValue = Record<string, unknown>;
export type Paint = Pick<Theme, "fg" | "bold">;
export interface Totals {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; compactions: number; started: number;
}
export interface GitInfo {
  branch?: string; project?: string; worktree?: boolean; upstream?: string;
  upstreamMissing?: boolean;
  operation?: boolean;
  /** Unique uncommitted paths; staged/unstaged can overlap and conflicts are included. */
  changed: number; staged: number; unstaged: number; untracked: number; conflicts: number;
  ahead: number; behind: number; added: number; removed: number;
  unavailable?: boolean;
  notRepository?: boolean;
}
export type FooterControlId = FooterActionId | "model.open" | "reasoning.cycle";
/** Detached presentation metadata, never provider callbacks. */
export type FooterControlState = Partial<Record<FooterControlId, Pick<FooterAction, "key" | "active">>>;
export interface Snapshot {
  system1?: System1Status;
  actions?: FooterControlState;
  settingsCycle?: SettingCycleSnapshot;
  primaryKeys?: { model?: string; reasoning?: string; workflow?: string; approvals?: string };
  /** Other-session chrome is string-only: no inherited controls or primary hints. */
  readOnly?: boolean;
  cwd: string; model: string; /** The physical model behind a virtual selection (a plan model pair), once it has answered. */ routedTo?: string; provider: string; thinking?: string; oauth: boolean;
  sessionName?: string; phase?: string; queued: boolean;
  context: { tokens: number | null; contextWindow: number; percent: number | null };
  totals: Totals; cacheHit?: number; git: GitInfo;
  quotas: Quota[]; unavailableQuota?: string; providerUsage?: ProviderUsage[]; providerUsageMore?: number; statuses: string[]; now: number;
  /** Folded in from companion extensions' statuses when they are installed. */
  mode?: PermissionModeStatus;
  permissionPrompts?: "on" | "off";
  workflow?: WorkflowStatus;
  lean?: string; cache?: string; extraBilled?: number;
  /** pi-reload-all's pending reload; reason is why it is waiting (typing, a question, ...), empty when none is given. */
  reload?: { reason: string };
  /** A prompt stashed by @saadjs/pi-stash; text is its content when readable. */
  stash?: { text?: string };
  /** pi-sidebar's latest waiting heads-up note (Sidebar closed); more counts the earlier ones. */
  headsUp?: { kind: string; text: string; more: number };
  /** pi-marimo's notebooks, one row each (keys `marimo`, `marimo-2`, ...). */
  marimo?: MarimoStatus[];
  /** pi-marimo's open marimo-lens selections, shown on their own row under the marimo row. */
  lens?: LensStatus;
  bg?: BgItem[];
  /** pi-pressure's signals while the machine is constrained, on their own row under the bg row. */
  pressure?: PressureItem[];
  /** Built-in MCP servers, connected/configured, unless another extension publishes an `mcp` status. */
  mcp?: McpCount;
  /** Skills loaded in this session. */
  skills?: number;
  /** The editor's border lines draw the context gauge, so the context row leaves it out. */
  borderGauge?: boolean;
  /**
   * A dialog is waiting on the user (some extension holds `herdr:blocked`): draw one row. herdr-web-ui reads a pi dialog off the screen only when its key hint
   * is followed by no more than two footer lines.
   */
  compact?: boolean;
}

/** One item of pi-bg's status: a running job, a service, a task that just ended, or a count of more. */
export type BgItem =
  | { kind: "job"; name: string; elapsed: string }
  | { kind: "service"; name: string; state: "ready" | "starting" | "up"; kept: boolean }
  | { kind: "ended"; name: string; mark: "✓" | "✗" | "■" }
  | { kind: "more"; count: number };

/** pi-bg's status, `bg: tests 2:14 · vite ready · lint ✗ · +2`, or undefined when any item is unfamiliar. */
export function parseBgStatus(text: string): BgItem[] | undefined {
  const match = /^bg: (.+)$/.exec(text);
  if (!match) return undefined;
  const items: BgItem[] = [];
  for (const part of match[1].split(" · ")) {
    const job = /^(.+) (\d+:\d\d|\d+h\d\dm)$/.exec(part);
    const service = /^(.+) (ready|starting|up)( \(kept\))?$/.exec(part);
    const ended = /^(.+) ([✓✗■])$/.exec(part);
    const more = /^\+(\d+)$/.exec(part);
    if (job) items.push({ kind: "job", name: job[1], elapsed: job[2] });
    else if (service) items.push({ kind: "service", name: service[1], state: service[2] as "ready" | "starting" | "up", kept: Boolean(service[3]) });
    else if (ended) items.push({ kind: "ended", name: ended[1], mark: ended[2] as "✓" | "✗" | "■" });
    else if (more) items.push({ kind: "more", count: +more[1] });
    else return undefined;
  }
  return items;
}

/** One item of pi-pressure's status: a signal with its level (and an arrow while it moves significantly), or the busiest process. */
export type PressureItem =
  | { kind: "signal"; name: "cpu" | "load" | "mem" | "thermal" | "swap-in"; value?: string; trend?: "up" | "down"; level: "ok" | "warn" | "hot" }
  | { kind: "top"; name: string };

/** pi-pressure's status, `pressure: cpu 97 \u2191 hot \u00b7 mem 83% used warn \u00b7 swap-in 40MB/s \u2193 warn \u00b7 top vitest`, or undefined when any item is unfamiliar. */
export function parsePressureStatus(text: string): PressureItem[] | undefined {
  const match = /^pressure: (.+)$/.exec(text);
  if (!match) return undefined;
  const items: PressureItem[] = [];
  for (const part of match[1].split(" \u00b7 ")) {
    // The value may span words (macOS mem: `83% used`); the level is always last.
    const signal = /^(cpu|load|mem|thermal|swap-in)(?: ([^\u2191\u2193]+?))?(?: ([\u2191\u2193]))? (ok|warn|hot)$/.exec(part);
    const top = /^top (.+)$/.exec(part);
    if (signal) {
      const item: PressureItem = { kind: "signal", name: signal[1] as "cpu", level: signal[4] as "ok" };
      if (signal[2]) item.value = signal[2];
      if (signal[3]) item.trend = signal[3] === "\u2191" ? "up" : "down";
      items.push(item);
    } else if (top) items.push({ kind: "top", name: top[1] });
    else return undefined;
  }
  return items;
}

/** pi-marimo's `marimo-lens` status, parsed: `lens: fit.py · S1 "note" · S2 · +3 · also prep.py 2`. */
export interface LensStatus {
  notebook: string;
  selections: Array<{ label: string; note?: string }>;
  more?: number;
  others?: string[];
}

export function parseLensStatus(text: string): LensStatus | undefined {
  const match = /^lens: (.+)$/.exec(text);
  if (!match) return undefined;
  const [notebook, ...parts] = match[1].split(" · ");
  const status: LensStatus = { notebook, selections: [] };
  for (const part of parts) {
    const selection = /^(S\d+)(?: "(.*)")?$/.exec(part);
    const more = /^\+(\d+)$/.exec(part);
    const also = /^also (.+)$/.exec(part);
    if (selection) status.selections.push({ label: selection[1], note: selection[2] });
    else if (more) status.more = +more[1];
    else if (also) status.others = also[1].split(", ");
    else return undefined;
  }
  return status.selections.length ? status : undefined;
}

/** pi-marimo's status, parsed: the notebook and the ` · ` separated parts after it. */
export interface MarimoStatus {
  notebook: string;
  running?: { section: string; elapsed?: string };
  queued?: number; errors?: number;
  /** The first error, e.g. `Model fit (KeyError) +1` (newer pi-marimo only). */
  errorDetail?: string;
  /** The other notebooks pi-marimo follows, most recently used first (older versions sent only a count). */
  others?: string[] | number;
  /** The server: `:2718` when local, else `host[:port][/path]`. */
  where?: string;
  /** Anything else ("disconnected", "not open", "/marimo to pick one"). */
  notes: string[];
  /** Where the notebook opens, when pi-marimo linked its name (OSC 8): the row keeps the link, so a click opens it. */
  url?: string;
}

/** The target of the first OSC 8 hyperlink in a status text (http and https only). */
export function osc8Url(text: string): string | undefined {
  const url = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(text)?.[1];
  return url && /^https?:\/\/[^\s\x00-\x1f\x7f]+$/.test(url) ? url : undefined;
}

export function parseMarimoStatus(text: string): MarimoStatus | undefined {
  const match = /^marimo: (.+)$/.exec(text);
  if (!match) return undefined;
  const [notebook, ...parts] = match[1].split(" · ");
  const status: MarimoStatus = { notebook, notes: [] };
  for (const part of parts) {
    const running = /^running (.+?)(?: \((\S+)\))?$/.exec(part);
    const queued = /^(\d+) queued$/.exec(part);
    const errors = /^(\d+) errors?(?:: (.+))?$/.exec(part);
    const others = /^\+(\d+) open$/.exec(part);
    const also = /^also (.+)$/.exec(part);
    if (/^:\d+(\/\S*)?$/.test(part) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(part)) status.where = part;
    else if (running) status.running = { section: running[1], elapsed: running[2] };
    else if (queued) status.queued = +queued[1];
    else if (errors) { status.errors = +errors[1]; if (errors[2]) status.errorDetail = errors[2]; }
    else if (others) status.others = +others[1];
    else if (also) status.others = also[1].split(", ");
    else status.notes.push(part);
  }
  return status;
}

export interface WorkflowStatus {
  kind: "work" | "chat" | "plan";
  key?: string;
}
export function parseWorkflowStatus(text: string): WorkflowStatus | undefined {
  const match = /^workflow: (work|chat|plan)(?: \((.+) to cycle\))?$/u.exec(text);
  return match ? { kind: match[1] as WorkflowStatus["kind"], ...(match[2] ? { key: match[2] } : {}) } : undefined;
}

/** Approval status, including legacy combined workflow labels for migration. */
export interface PermissionModeStatus {
  kind: "chat" | "manual" | "acceptEdits" | "plan" | "auto" | "bypass";
  /** `⏵⏵ auto mode on` */
  label: string;
  /** The key that cycles modes, e.g. `shift+tab`. */
  key?: string;
}
const MODE_KINDS: Record<string, PermissionModeStatus["kind"]> = {
  "chat mode": "chat", "manual mode": "manual", "accept edits": "acceptEdits", "plan mode": "plan", "auto mode": "auto", "yolo mode": "bypass", "bypass permissions": "bypass",
};
const MODE_NAMES: Record<PermissionModeStatus["kind"], string> = {
  chat: "chat", manual: "manual", acceptEdits: "accept edits", plan: "plan", auto: "auto", bypass: "yolo",
};
export function parseModeStatus(text: string): PermissionModeStatus | undefined {
  const match = /^(⏸|⏵⏵) (chat mode|manual mode|accept edits|plan mode|auto mode|yolo mode|bypass permissions) on(?: \((.+) to cycle\))?$/u.exec(text.replace(/ \(legacy\)(?= mode on| on)/u, ""));
  if (!match) return undefined;
  // ⏸ is one cell and ⏵⏵ two; the footer draws one same-width icon for either.
  const glyph = match[1] === "⏸" ? ICONS.paused : ICONS.running;
  return { kind: MODE_KINDS[match[2]], label: `${glyph} ${match[2]} on`, ...(match[3] ? { key: match[3] } : {}) };
}

export interface AbsorbedStatuses { reload?: { reason: string }; workflow?: WorkflowStatus; mode?: PermissionModeStatus; permissionPrompts?: "on" | "off"; lean?: string; cache?: string; extraBilled?: number; stashed?: boolean; headsUp?: { kind: string; text: string; more: number }; marimo?: MarimoStatus[]; lens?: LensStatus; bg?: BgItem[]; pressure?: PressureItem[]; /** Another extension owns the `mcp` status. */ mcp?: boolean; rest: string[] }
// Statuses from our own companion extensions that read better inside the footer
// rows they describe. Each is optional: absent extensions publish nothing, and a
// status whose text no longer matches the expected shape falls through to the
// generic status row unchanged, so a format change never hides a notice.
//                                               (also the older "(auto)", and ", limited: 5h 84%")
//   lean-context      (pi-cache-guard's Jev)    "lean: −12k tok"       -> context row
//   cache-guard       (pi-cache-guard)          "cache 4:12"           -> context row
//   anthropic-billing (anthropic-billing-guard) "extra usage x3"       -> Claude limits row
//   reload-all        (pi-reload-all)           "reload pending: typing" -> the top row, just under the editor
//   prompt-stash      (@saadjs/pi-stash)        "prompt stashed"       -> its own row under the editor
//   sidebar-headsup   (pi-sidebar)              "✦ heads up (2) · tradeoff: text" -> its own row under the editor
//   marimo, marimo-N  (pi-marimo)               "marimo: nb.py · ..."  -> a row per notebook under the context row
//   marimo-lens       (pi-marimo)               "lens: nb.py · S1 ..." -> its own row under the marimo row
//   bg                (pi-bg)                   "bg: tests 2:14 · ..." -> its own row under that
//   pressure          (pi-pressure)             "pressure: cpu 97 ↑ hot · ..." -> its own row under that
//   workflow-mode    (pi-tool-gate, pi-plan-mode) "workflow: plan (shift+tab to cycle)" -> Workflow
//   permission-mode  (pi-tool-gate) "⏵⏵ auto mode on (alt+a to cycle)" -> Approvals
// Everything else (plan, gate, mcp, ...) stays in the status row.
export function absorbStatuses(statuses: ReadonlyMap<string, string>, options: { claudeRow: boolean }): AbsorbedStatuses {
  const result: AbsorbedStatuses = { rest: [] };
  const notebooks: Array<[number, MarimoStatus]> = [];
  for (const [key, text] of [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const plainText = clean(text);
    const lean = key === "lean-context" ? /^lean: (.+)$/.exec(plainText) : null;
    if (lean) { result.lean = lean[1]; continue; }
    const cache = key === "cache-guard" ? /^cache (~?(?:\d+:\d\d|\d+h\d\dm)|cold(?: \(model\)|\?)?)$/.exec(plainText) : null;
    if (cache) { result.cache = cache[1]; continue; }
    const billed = key === "anthropic-billing" ? /^extra usage x(\d+)$/.exec(plainText) : null;
    if (billed && options.claudeRow) { result.extraBilled = +billed[1]; continue; }
    const reload = key === "reload-all" ? /^reload pending(?:: (\S.*))?$/u.exec(plainText) : null;
    if (reload) { result.reload = { reason: reload[1] ?? "" }; continue; }
    if (key === "prompt-stash" && plainText === "prompt stashed") { result.stashed = true; continue; }
    const headsUp = key === "sidebar-headsup" ? /^✦ heads up(?: \((\d+)\))? · ([a-z][a-z ]*): (.+)$/u.exec(plainText) : null;
    if (headsUp) { result.headsUp = { kind: headsUp[2], text: headsUp[3], more: headsUp[1] ? +headsUp[1] - 1 : 0 }; continue; }
    // One status per notebook: `marimo`, then `marimo-2`, `marimo-3`, ... in that order.
    const slot = key === "marimo" ? 1 : /^marimo-(\d+)$/.exec(key)?.[1];
    const marimo = slot !== undefined ? parseMarimoStatus(plainText) : undefined;
    if (marimo) {
      const url = osc8Url(text);
      if (url) marimo.url = url;
      notebooks.push([+slot!, marimo]);
      continue;
    }
    const lens = key === "marimo-lens" ? parseLensStatus(plainText) : undefined;
    if (lens) { result.lens = lens; continue; }
    const bg = key === "bg" ? parseBgStatus(plainText) : undefined;
    if (bg) { result.bg = bg; continue; }
    const pressure = key === "pressure" ? parsePressureStatus(plainText) : undefined;
    if (pressure) { result.pressure = pressure; continue; }
    const workflow = key === "workflow-mode" ? parseWorkflowStatus(plainText) : undefined;
    if (workflow) { result.workflow = workflow; continue; }
    if (key === "permission-prompting" && (plainText === "permission prompts: on" || plainText === "permission prompts: off")) {
      result.permissionPrompts = plainText === "permission prompts: on" ? "on" : "off";
      continue;
    }
    const mode = key === "permission-mode" ? parseModeStatus(plainText) : undefined;
    if (mode) {
      if (mode.kind === "chat" || mode.kind === "plan") result.workflow ??= { kind: mode.kind, ...(mode.key ? { key: mode.key } : {}) };
      else result.mode = mode;
      continue;
    }
    const plan = key === "plan" ? /^plan: (.+) \((\/plan(?:ners)?)\)$/.exec(plainText) : null;
    if (plan) {
      result.rest.push(`Plan ${plan[1].replace(/cut off \(resume in (\/plan(?:ners)?)\)/g, "cut off · resume in $1")} · ${plan[2]}`);
      continue;
    }
    // Normalize our companion's label without rewriting arbitrary publishers.
    if (key === "tool-gate" && /^gate: (?:off|\d+ auto · \d+ pushed back · \d+ asked)$/.test(plainText)) {
      result.rest.push(plainText.replace(/^gate: /, "Gate "));
      continue;
    }
    // Use the flat Nerd Font plug for MCP; preserve its theme color and text.
    if (key === MCP_STATUS_KEY) result.mcp = true;
    result.rest.push(key === MCP_STATUS_KEY ? text.replace(/\u{1f50c}[\ufe0e\ufe0f]?/u, "\uf1e6") : text);
  }
  if (notebooks.length) result.marimo = notebooks.sort(([a], [b]) => a - b).map(([, m]) => m);
  return result;
}

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
export const clean = (value: string): string => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
const timestamp = (value: unknown): number | undefined => {
  const result = typeof value === "string" ? Date.parse(value) : number(value);
  return result !== undefined && Number.isFinite(result) ? result : undefined;
};
export function tokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
export const duration = (ms: number): string => {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${Math.floor(mins % 1440 / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h${mins % 60}m`;
  return `${mins}m`;
};
// Fable is selective: show high usage, or an over-trajectory pool near reset.
/**
 * The System 1 backend in use, without the configured order or a fallback marker: the
 * last backend that answered, unless it is cooling down, else the first configured rung
 * that is not. Rendering these detached fields never probes a provider.
 */
export function system1Current(state: System1Status, now: number): string {
  const name = (backend: "jev" | "openai-decisions") => backend === "jev" ? "Jev" : "OpenAI";
  // A retry becoming eligible is not evidence of recovery, but it is no longer unavailable.
  if (state.status === "unavailable" && !(state.nextRetryAt !== undefined && state.nextRetryAt <= now)) return "unavailable";
  const cooling = (backend: string) => state.candidates.some((c) => c.backend === backend && c.cooldownUntil !== undefined && c.cooldownUntil > now);
  if (state.lastUsed && state.waterfall.includes(state.lastUsed.backend) && !cooling(state.lastUsed.backend)) return name(state.lastUsed.backend);
  if (state.sessionStart && state.waterfall.includes(state.sessionStart) && !cooling(state.sessionStart)) return name(state.sessionStart);
  const ready = state.waterfall.find((backend) => !cooling(backend) && state.candidates.find((c) => c.backend === backend)?.local !== "missing");
  const first = ready ?? state.waterfall[0];
  return first ? name(first) : "unavailable";
}

function showQuotaWindow(window: { label: string; used?: number; reset?: number }, now: number): boolean {
  if (!/^fable$/i.test(window.label)) return true;
  if (window.used === undefined || !Number.isFinite(window.used) || window.reset === undefined || !Number.isFinite(window.reset) || window.reset <= now) return false;
  const left = window.reset - now;
  return window.used > 70 || (left < 48 * 3600_000 && window.used > (1 - left / (7 * 86400_000)) * 100);
}
const money = (n: number): string => `$${n.toFixed(n > 0 && n < 0.01 ? 3 : 2)}`;
const extraAmount = (extra: { used?: number; limit?: number; currency?: string }): string => {
  if (extra.used === undefined) return "";
  const usd = extra.currency === "USD";
  const limit = extra.limit === undefined ? "" : `/${usd ? "$" : ""}${extra.limit.toFixed(0)}`;
  return usd ? `${money(extra.used)}${limit}` : `${extra.used.toFixed(2)}${limit} ${extra.currency ?? "?"}`;
};
// Pi's system theme puts accent at the same contrast as muted gray, so the
// footer's accents (project, model, gauges) read no stronger than its secondary
// text. Lift accent halfway from its own OKLab lightness to the theme's body
// text (the terminal's foreground under the system theme), keeping its hue and
// chroma: still the terminal's color, one step more prominent. Needs Pi's
// theme.colors and theme.style (pi >= 1.1); otherwise accent stays as is.
const ACCENT_LIFT = 0.5;
type ColorValue = { kind: string; r?: number; g?: number; b?: number; l?: number; c?: number; h?: number };
interface StyledTheme {
  colors?: Readonly<Record<string, ColorValue>>;
  style?(text: string, options: { fg: ColorValue }): string;
}
function oklch(color: ColorValue | undefined): { l: number; c: number; h: number } | undefined {
  if (!color) return undefined;
  if (color.kind === "oklch") return { l: color.l!, c: color.c!, h: color.h! };
  if (color.kind !== "rgb") return undefined;
  const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [lin(color.r!), lin(color.g!), lin(color.b!)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, c: Math.hypot(A, B), h: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 };
}
export function liftAccent(theme: Paint): Paint {
  const styled = theme as Paint & StyledTheme;
  if (typeof styled.style !== "function") return theme;
  let colors: StyledTheme["colors"];
  try { colors = styled.colors; } catch { return theme; }
  const accent = oklch(colors?.accent), text = oklch(colors?.text);
  if (!accent || !text) return theme;
  const lifted = { kind: "oklch", l: accent.l + (text.l - accent.l) * ACCENT_LIFT, c: accent.c, h: accent.h };
  return {
    fg: (color, value) => color === "accent" ? styled.style!(value, { fg: lifted }) : theme.fg(color, value),
    bold: (value) => theme.bold(value),
  };
}

function heat(pct: number): "accent" | "warning" | "error" {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warning";
  return "accent";
}
const emptyGit = (): GitInfo => ({ staged: 0, unstaged: 0, changed: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, added: 0, removed: 0 });

// Match Pi's whole-session accounting, including abandoned branches and usage
// that never becomes a message (warming), plus tool and summary usage.
export function collectTotals(entries: readonly unknown[], now: number): Totals {
  const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, compactions: 0, started: now };
  for (const raw of entries) {
    const entry = record(raw);
    const message = record(entry.message);
    const at = timestamp(entry.timestamp) ?? timestamp(message.timestamp);
    if (at !== undefined) totals.started = Math.min(totals.started, at);
    if (entry.type === "compaction") totals.compactions++;
    let rawUsage: unknown;
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") rawUsage = entry.usage;
    else if (message.role === "assistant" || message.role === "toolResult") rawUsage = message.usage;
    const usage = record(rawUsage);
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) totals[key] += number(usage[key]) ?? 0;
    totals.cost += number(record(usage.cost).total) ?? 0;
  }
  return totals;
}

export function latestCacheHit(entries: readonly unknown[], provider: string, model: string): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = record(record(entries[i]).message);
    if (message.role !== "assistant") continue;
    // Never carry a cache reading across a model/provider change.
    if (message.provider !== provider || message.model !== model) return undefined;
    const usage = record(message.usage);
    const read = number(usage.cacheRead) ?? 0;
    const prompt = (number(usage.input) ?? 0) + read + (number(usage.cacheWrite) ?? 0);
    if (prompt > 0) return 100 * read / prompt;
  }
  return undefined;
}

// Operation state belongs to the actual per-worktree admin directory, not common-dir.
export async function detectGitOperation(gitDir: string): Promise<boolean> {
  const markers = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_LOG"];
  const found = await Promise.all(markers.map(async (marker) => {
    try { await stat(path.join(gitDir, marker)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }));
  return found.some(Boolean);
}

export function parseGitStatus(output: string | Buffer): GitInfo {
  // Latin-1 maps each path byte one-to-one; UTF-8 would merge invalid filenames.
  // Only human-readable headers are decoded as UTF-8 in raw production output.
  const raw = Buffer.isBuffer(output);
  const header = (text: string): string => raw ? Buffer.from(text, "latin1").toString("utf8") : text;
  output = Buffer.isBuffer(output) ? output.toString("latin1") : output;
  const git = emptyGit();
  const unavailable = (): GitInfo => ({ ...emptyGit(), unavailable: true });
  // NUL records preserve spaces/newlines in paths. Rename sources are separate
  // records, not another changed path (even when they look like status records).
  if (!output.endsWith("\0")) return unavailable();
  const fields = output.slice(0, -1).split("\0");
  const paths = new Set<string>();
  let oid: string | undefined;
  let hasDivergence = false;
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (line.startsWith("# branch.head ")) git.branch = header(line.slice(14));
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13);
    else if (line.startsWith("# branch.upstream ")) git.upstream = header(line.slice(18));
    else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (!match) return unavailable();
      git.ahead = +match[1]; git.behind = +match[2];
      hasDivergence = true;
    } else if (line.startsWith("# ")) continue; // Future porcelain headers.
    else if (line.startsWith("? ") && line.length > 2) {
      git.untracked++; paths.add(line.slice(2));
    } else {
      const count = line[0] === "1" ? 6 : line[0] === "2" ? 7 : line[0] === "u" ? 8 : 0;
      const match = count && new RegExp(`^[12u] ([.MADRCUT]{2}) (?:[^ \\0]+ ){${count}}([\\s\\S]+)$`).exec(line);
      if (!match) return unavailable();
      const [, xy, file] = match;
      paths.add(file);
      if (line[0] === "u") git.conflicts++;
      else { if (xy[0] !== ".") git.staged++; if (xy[1] !== ".") git.unstaged++; }
      if (line[0] === "2" && !fields[++i]) return unavailable();
    }
  }
  if (!git.branch || !oid || (oid !== "(initial)" && !/^[0-9a-f]{7,64}$/.test(oid))) return unavailable();
  if (git.branch === "(detached)") {
    if (oid === "(initial)") return unavailable();
    git.branch = `detached:${oid.slice(0, 7)}`;
  }
  if (!git.upstream && (git.ahead || git.behind)) return unavailable();
  if (git.upstream && !hasDivergence && oid !== "(initial)" && !git.branch.startsWith("detached:")) git.upstreamMissing = true;
  git.changed = paths.size;
  return git;
}

type SegmentHit = Omit<FooterHit, "row">;
interface Segment { text: string; short?: string; priority: number; separatorAfter?: string; hits?: SegmentHit[]; shortHits?: SegmentHit[]; atomic?: boolean }
interface Part { text: string; action?: string }
function partsSegment(parts: Part[], priority: number, short?: Part[]): Segment {
  const compose = (parts: Part[]) => {
    let col = 0;
    const hits: SegmentHit[] = [];
    for (const part of parts) {
      const endCol = col + visibleWidth(part.text);
      if (part.action && endCol > col) hits.push({ startCol: col, endCol, action: part.action });
      col = endCol;
    }
    return { text: parts.map((part) => part.text).join(""), hits };
  };
  const full = compose(parts), shortened = short && compose(short);
  return { ...full, priority, ...(shortened ? { short: shortened.text, shortHits: shortened.hits } : {}) };
}
// Drop secondary statistics before shrinking the important gauges. The same
// fitting decisions produce both the text and its final ANSI/cell-aware hits.
export function fitSegmentLayout(segments: Segment[], width: number, theme: Paint): { text: string; hits: SegmentHit[] } {
  const items = segments.filter((s) => s.text).map((s) => ({ ...s }));
  const separator = theme.fg("dim", " · ");
  const join = () => items.map((s, i) => s.text + (i < items.length - 1 ? s.separatorAfter ?? separator : "")).join("");
  for (const item of [...items].sort((a, b) => a.priority - b.priority)) {
    if (visibleWidth(join()) <= width || item.priority >= 50) break;
    if (items.length > 1) items.splice(items.indexOf(item), 1);
  }
  for (const item of [...items].sort((a, b) => a.priority - b.priority)) {
    if (visibleWidth(join()) <= width) break;
    if (item.short !== undefined) { item.text = item.short; item.hits = item.shortHits; }
  }
  while (visibleWidth(join()) > width && items.length > 1) {
    const least = Math.min(...items.map((s) => s.priority));
    items.splice(items.findIndex((s) => s.priority === least), 1);
  }
  const text = join(), limit = Math.max(0, width);
  // Truncation can only remain once a single segment survives. A partial label
  // is not a control (nor is the ellipsis); no stale range extends past it.
  if (visibleWidth(text) > limit) return { text: items[0]?.atomic ? "" : truncateToWidth(text, limit, "…"), hits: [] };
  let col = 0;
  const hits: SegmentHit[] = [];
  items.forEach((item, i) => {
    for (const hit of item.hits ?? []) hits.push({ ...hit, startCol: col + hit.startCol, endCol: col + hit.endCol });
    col += visibleWidth(item.text) + (i < items.length - 1 ? visibleWidth(item.separatorAfter ?? separator) : 0);
  });
  return { text, hits };
}
export function fitSegments(segments: Segment[], width: number, theme: Paint): string {
  return fitSegmentLayout(segments, width, theme).text;
}

function thinkingColor(level: string): Parameters<Paint["fg"]>[0] {
  switch (level) {
    case "off": return "thinkingOff";
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    case "max": return "thinkingMax";
    default: return "muted";
  }
}

function gauge(theme: Paint, used: number, cells = 8, healthy: "accent" | "success" = "accent"): string {
  const filled = Math.round(Math.min(100, Math.max(0, used)) * cells / 100);
  return theme.fg(used < 70 ? healthy : heat(used), "━".repeat(filled)) + theme.fg("dim", "─".repeat(cells - filled));
}
const percent = (value: number): string => `${+value.toFixed(1)}%`;

/**
 * An editor border line with the context gauge drawn in: the used share of the
 * width in heavy rule in the heat color, the rest as the editor's own border
 * (`border` keeps pi-vim's mode colors). A scroll label (" ↑ 3 more ") stays
 * centered over it, as in pi's own border.
 */
export function gaugeBorder(width: number, used: number, theme: Paint, border: (text: string) => string, label = ""): string {
  if (width <= 0) return "";
  const pct = Math.min(100, Math.max(0, used));
  const filled = Math.round(pct * width / 100);
  const span = (from: number, to: number) => {
    const heavy = Math.max(0, Math.min(to, filled) - from), light = to - from - heavy;
    return (heavy ? theme.fg(heat(pct), "━".repeat(heavy)) : "") + (light ? border("─".repeat(light)) : "");
  };
  const labelWidth = visibleWidth(label);
  if (!label || labelWidth + 2 > width) return span(0, width);
  const start = Math.floor((width - labelWidth) / 2);
  return span(0, start) + border(label) + span(start + labelWidth, width);
}

interface BorderedEditor {
  borderColor?: (text: string) => string;
  renderTopBorder?(width: number, hidden: number): string;
  renderBottomBorder?(width: number, hidden: number): string;
  [ORIGINAL_BORDERS]?: { top: BorderRenderer; bottom: BorderRenderer };
}
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type BorderRenderer = (this: BorderedEditor, width: number, hidden: number) => string;
const ORIGINAL_BORDERS = Symbol.for("pi-status-footer/original-borders");
/**
 * Redraw a pi Editor's (or subclass's) border lines as the context gauge while
 * `used()` returns a percentage; otherwise they render as before. Returns false
 * for an editor without pi's border hooks, which is left alone.
 */
export function drawGaugeOnBorders(editor: unknown, used: () => number | null, theme: () => Paint | undefined): boolean {
  const e = editor as BorderedEditor;
  if (typeof e.renderTopBorder !== "function" || typeof e.renderBottomBorder !== "function") return false;
  const original = e[ORIGINAL_BORDERS] ??= { top: e.renderTopBorder, bottom: e.renderBottomBorder };
  const draw = (fallback: BorderRenderer, arrow: string): BorderRenderer => function (width, hidden) {
    const pct = used(), paint = theme();
    if (pct === null || !paint || typeof this.borderColor !== "function") return fallback.call(this, width, hidden);
    return gaugeBorder(width, pct, paint, this.borderColor, hidden > 0 ? ` ${arrow} ${hidden} more ` : "");
  };
  e.renderTopBorder = draw(original.top, "↑");
  e.renderBottomBorder = draw(original.bottom, "↓");
  return true;
}
export function shortModel(value: string): string {
  return clean(value).replace(/^claude-/, "").replace(/-20\d{6}$/, "").replace(/(\d)-(\d)/g, "$1.$2");
}

// Like Claude Code's "› Stashed (auto-restores after submit)" hint under its
// prompt, plus a first-line preview as in opencode's stash list. pi-stash
// restores after a /command, !shell or model/thinking change, not after an
// ordinary prompt, so the hint names the key rather than promising a restore.
function stashRow(text: string | undefined, width: number, theme: Paint): string {
  const lines = text?.split("\n").map(clean).filter(Boolean) ?? [];
  const more = lines.length > 1 ? ` +${lines.length - 1} line${lines.length === 2 ? "" : "s"}` : "";
  const label = theme.fg("muted", "Stashed");
  const hint = "ctrl+s to restore";
  // The preview gets whatever the label, line count and hint leave.
  const room = width - visibleWidth(`${label} · ""${more} · ${hint}`);
  // Truncate the already-plain line ourselves: truncateToWidth's reset before
  // the ellipsis would end the dim color early.
  const first = lines[0] ?? "";
  const shown = visibleWidth(first) > room ? `${stripVTControlCharacters(truncateToWidth(first, room - 1, ""))}\u2026` : first;
  const preview = first && room >= 8 ? `"${shown}"${more}` : "";
  return fitSegments([
    { text: label, priority: 100 },
    { text: preview ? theme.fg("dim", preview) : "", priority: 30 },
    { text: theme.fg("dim", hint), short: theme.fg("dim", "ctrl+s"), priority: 60 },
  ], width, theme);
}

// pi-sidebar's waiting heads-up note: label, kind, then the note's text filling the row.
function headsUpSegments(h: { kind: string; text: string; more: number }, width: number, theme: Paint, action?: string): Segment[] {
  const labelText = theme.fg("accent", "Heads up") + (h.more ? theme.fg("dim", ` +${h.more}`) : "");
  const kind = theme.fg("muted", h.kind);
  const text = clean(h.text);
  const room = width - visibleWidth(labelText) - visibleWidth(kind) - 2 * 3 - 2;
  const first = room >= 8 ? (visibleWidth(text) > room ? `${stripVTControlCharacters(truncateToWidth(text, room - 1, ""))}\u2026` : text) : "";
  return [
    partsSegment([{ text: labelText, action }], 100),
    { text: kind, priority: 50 },
    first ? partsSegment([{ text: `"${first}"`, action }], 30) : { text: "", priority: 30 },
  ];
}

// A notebook pi-marimo follows, one row each: its name and what its kernel is
// doing (the markdown section the running cell sits under, its deepest heading
// when narrow). An older pi-marimo sent one row naming the others after `also`.
// Open marimo-lens selections: what the user marked in the browser and has not had addressed.
function lensRow(l: LensStatus, width: number, theme: Paint): string {
  const count = l.selections.length + (l.more ?? 0);
  return fitSegments([
    { text: `${theme.fg("muted", "Lens")} ${theme.bold(theme.fg("accent", l.notebook))}`, short: theme.bold(theme.fg("accent", l.notebook)), priority: 90 },
    ...l.selections.map((s, i): Segment => ({
      text: `${theme.fg("warning", s.label)}${s.note ? ` ${theme.fg("muted", clean(s.note))}` : ""}`,
      short: theme.fg("warning", s.label),
      priority: 70 - i,
    })),
    { text: l.more ? theme.fg("dim", `+${l.more}`) : "", short: theme.fg("dim", `${count} open`), priority: 80 },
    { text: l.others?.length ? `${theme.fg("dim", "also")} ${theme.fg("muted", l.others.join(", "))}` : "", priority: 40 },
  ], width, theme);
}

function marimoRow(m: MarimoStatus, width: number, theme: Paint): string {
  const run = m.running;
  // A notebook nobody has open (pi-marimo's server waiting for the user) is dimmed. Its name keeps
  // pi-marimo's link, which Pi's fullscreen TUI opens on a click (and terminals do in regular mode).
  const waiting = m.notes.includes("not open");
  const name = (text: string) => {
    const styled = waiting ? theme.fg("muted", text) : theme.bold(theme.fg("accent", text));
    return m.url ? hyperlink(styled, m.url) : styled;
  };
  const time = run?.elapsed ? theme.fg("dim", ` ${run.elapsed}`) : "";
  const deepest = run?.section.split(" › ").pop() ?? "";
  const errorCount = theme.fg("error", `${m.errors} error${m.errors === 1 ? "" : "s"}`);
  return fitSegments([
    { text: `${theme.fg("muted", "Marimo")} ${name(m.notebook)}`, short: name(m.notebook), separatorAfter: m.where ? (m.where.startsWith(":") ? "" : " ") : undefined, priority: 90 },
    { text: m.where ? theme.fg("dim", m.where) : "", priority: 75 },
    { text: run ? `${theme.fg("warning", "running")} ${run.section}${time}` : "",
      short: run ? `${theme.fg("warning", "running")} ${truncateToWidth(deepest, 30)}${time}` : "", priority: 100 },
    { text: m.queued ? theme.fg("muted", `${m.queued} queued`) : "", priority: 30 },
    { text: m.errors ? `${errorCount}${m.errorDetail ? `${theme.fg("dim", ":")} ${theme.fg("muted", m.errorDetail)}` : ""}` : "",
      short: m.errors ? errorCount : "", priority: 95 },
    ...(typeof m.others === "number"
      ? [{ text: m.others ? theme.fg("dim", `+${m.others} open`) : "", priority: 20 }]
      : [{ text: m.others?.length ? `${theme.fg("dim", "also")} ${theme.fg("muted", m.others.join(", "))}` : "",
        short: m.others?.length ? theme.fg("dim", `+${m.others.length} more`) : "", priority: 85 }]),
    ...m.notes.map((note): Segment => ({ text: theme.fg(note === "not open" ? "dim" : "warning", note), priority: 80 })),
  ], width, theme);
}

// pi-bg's tasks: running jobs with their time, services with their state, then
// what ended in the last minute. Running and failed work wins when narrow.
function bgRow(items: BgItem[], width: number, theme: Paint): string {
  const segments: Segment[] = [{ text: theme.fg("muted", "Background"), short: theme.fg("muted", "Bg"), separatorAfter: " ", priority: 110 }];
  for (const item of items) {
    if (item.kind === "job") segments.push({ text: `${theme.fg("accent", item.name)} ${theme.fg("dim", item.elapsed)}`, short: theme.fg("accent", item.name), priority: 100 });
    else if (item.kind === "service") {
      const state = theme.fg(item.state === "starting" ? "warning" : "success", item.state);
      segments.push({ text: `${item.name} ${state}${item.kept ? theme.fg("dim", " kept") : ""}`, short: `${item.name} ${state}`, priority: 70 });
    } else if (item.kind === "ended") {
      const mark = item.mark === "✓" ? theme.fg("success", "✓") : item.mark === "✗" ? theme.fg("error", "✗") : theme.fg("muted", "■");
      segments.push({ text: `${theme.fg("dim", item.name)} ${mark}`, priority: item.mark === "✗" ? 105 : 40 });
    } else segments.push({ text: theme.fg("dim", `+${item.count}`), priority: 20 });
  }
  return fitSegments(segments, width, theme);
}

// pi-pressure's signals: label and value (or the level, for memory and thermal)
// in the level's color, with an arrow while it is moving significantly; hot signals
// stay longest when narrow, then warn, then eased ones, and the busiest
// process goes first. Each signal's value and arrow take a fixed width, so the
// items hold still as the numbers change and arrows come and go.
const PRESSURE_WIDTH: Record<Extract<PressureItem, { kind: "signal" }>["name"], number> = { cpu: 3, load: 3, mem: 4, thermal: 4, "swap-in": 7 };
function pressureRow(items: PressureItem[], width: number, theme: Paint): string {
  const color = { ok: "muted", warn: "warning", hot: "error" } as const;
  const segments: Segment[] = [{ text: theme.fg("muted", "Pressure"), separatorAfter: " ", priority: 110 }];
  for (const item of items) {
    if (item.kind === "top") { segments.push({ text: `${theme.fg("dim", "top")} ${theme.fg("muted", item.name)}`, priority: 20 }); continue; }
    // Numbers align right, the level words of mem and thermal left.
    const text = item.value ?? item.level;
    const gap = " ".repeat(Math.max(0, PRESSURE_WIDTH[item.name] - visibleWidth(text)));
    const painted = theme.bold(theme.fg(color[item.level], text));
    const value = item.value === undefined ? `${painted}${gap}` : `${gap}${painted}`;
    const arrow = item.trend ? ` ${theme.fg(color[item.level], item.trend === "up" ? "\u2191" : "\u2193")}` : "  ";
    // The label takes the level's color too, so the row reads at a glance.
    segments.push({ text: `${theme.fg(color[item.level], item.name)} ${value}${arrow}`, priority: item.level === "hot" ? 100 : item.level === "warn" ? 90 : 55 });
  }
  // The last item's padding holds nothing in place.
  return fitSegments(segments, width, theme).replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
}

// Nerd Font (Font Awesome / Devicons / Material Design, all private-use,
// one cell wide) icons that lead each footer row. Without a Nerd Font they draw as
// placeholders; the row text stays readable.
export const ICONS = {
  reload: "\uf021", // refresh
  stash: "\uf187", // archive
  headsUp: "\u2726", // ✦, pi-sidebar's heads-up mark
  project: "\uf07b", // folder
  branch: "\ue725", // git branch
  model: "\u{f06a9}", // robot (Material Design; the Font Awesome robot draws wider than its neighbors)
  reasoning: "\uee9c", // brain
  workflow: "\uf0e8", // sitemap (workflow)
  gate: "\uf510", // shield with check (pi-tool-gate)
  paused: "\u{f03e4}", // pause (Material Design): chat and plan mode, sent as ⏸
  running: "\u{f0211}", // fast forward (Material Design): the other modes, sent as ⏵⏵
  context: "\uf0e4", // tachometer
  marimo: "\uf02d", // book
  lens: "\uf06e", // eye (marimo-lens selections)
  bg: "\uf085", // cogs
  pressure: "\uf2db", // microchip
  mcp: "\uf1e6", // plug
  skills: "\uf0d0", // magic wand
  notices: "\uf0f3", // bell
  limits: "\uf252", // hourglass half
} as const;

/** Prefix a row with its icon; `render` gets the width left after it. */
/** Space between a row's leading icon and its text: two cells, so the icon column reads apart. */
const ICON_GAP = "  ";

function iconRow(icon: string, width: number, theme: Paint, render: (width: number) => string): string {
  return `${theme.fg("dim", icon)}${ICON_GAP}${render(Math.max(0, width - 1 - ICON_GAP.length))}`;
}

function mcpChip(count: McpCount, theme: Paint): string {
  const value = `${count.connected}/${count.total}`;
  return `${theme.fg("muted", "MCP")} ${count.connected < count.total ? theme.fg("warning", value) : value}`;
}

/** Claude Code's mode colors, in theme roles: plan teal, accept edits purple, bypass red (chat, the gate's own, green). */
const MODE_COLORS: Record<PermissionModeStatus["kind"], Parameters<Paint["fg"]>[0]> = {
  chat: "success", manual: "muted", acceptEdits: "customMessageLabel", plan: "mdLink", auto: "warning", bypass: "error",
};

/** Extensions hold this on pi's event bus while a dialog waits on the user (herdr counts the pairs).
 * While one is held the footer is one row, for herdr-web-ui (see docs/clients.md, "herdr-web-ui compatibility"). */
const HERDR_BLOCKED_EVENT = "herdr:blocked";

export function renderFooter(snapshot: Snapshot, width: number, theme: Paint): string[] {
  return layoutFooter(snapshot, width, theme).lines;
}

export function layoutFooter(snapshot: Snapshot, width: number, theme: Paint): FooterLayout {
  if (width <= 0) return { lines: [], hits: [] };
  const s = snapshot, g = s.git;
  // Shared inset, but natural spacing rather than padded label columns.
  const inset = width >= 60 ? 1 : 0;
  width -= inset * 2;
  const accountLabel = (text: string) => clean(text).replace(/^(Claude|Codex) acct$/, "$1");
  const label = (text: string) => `${theme.fg("muted", accountLabel(text))} `;
  const rows: string[] = [], hits: FooterHit[] = [];
  const sep = theme.fg("dim", " · ");
  const action = (id: FooterControlId) => !s.readOnly && s.actions?.[id] ? id : undefined;
  const row = (icon: string, render: (width: number) => string) => iconRow(icon, width, theme, render);
  const controlRow = (icon: string, segments: Segment[] | ((width: number) => Segment[]), key?: string, control?: string) => {
    const prefix = `${theme.fg("dim", icon)}${ICON_GAP}`, prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(0, width - prefixWidth);
    const hint = !s.readOnly && key ? clean(key) : "";
    // Keep the primary hint adjacent to content, yielding before state at narrow widths.
    const suffixWidth = visibleWidth(` · ${hint}`);
    const reserve = hint && contentWidth - suffixWidth >= 18 ? suffixWidth : 0;
    const fitted = fitSegmentLayout(typeof segments === "function" ? segments(contentWidth - reserve) : segments, contentWidth - reserve, theme);
    const offset = inset + prefixWidth;
    const rowIndex = rows.length;
    for (const hit of fitted.hits) hits.push({ ...hit, row: rowIndex, startCol: offset + hit.startCol, endCol: offset + hit.endCol });
    let text = prefix + fitted.text;
    if (reserve) {
      const startCol = visibleWidth(text) + visibleWidth(" · ");
      text += theme.fg("dim", ` · ${hint}`);
      if (control) hits.push({ row: rowIndex, startCol: inset + startCol, endCol: inset + startCol + visibleWidth(hint), action: control });
    }
    rows.push(text);
  };
  // A pending reload leads the footer: it is waiting on the user (or an open
  // dialog) and changes everything below it once it runs.
  if (s.reload) {
    const reason = clean(s.reload.reason);
    rows.push(row(ICONS.reload, (w) => fitSegments([
      { text: theme.fg("warning", "Reload pending"), priority: 100 },
      { text: reason ? theme.fg("muted", reason) : "", priority: 50 },
    ], w, theme)));
  }
  if (s.stash) rows.push(row(ICONS.stash, (w) => stashRow(s.stash?.text, w, theme)));
  if (s.headsUp) {
    const h = s.headsUp, act = action("headsup.open");
    const key = act ? s.actions?.["headsup.open"]?.key : undefined;
    controlRow(ICONS.headsUp, (w) => headsUpSegments(h, w, theme, act), key ? `${key} to read` : undefined, act);
  }
  // Minimal suffix; path, staging and tracking details stay in /status.
  const outsideGit = g.notRepository && !g.unavailable;
  const available = !g.unavailable && !outsideGit && Boolean(g.branch);
  const dirty = [g.changed, g.staged, g.unstaged, g.untracked, g.conflicts].some((n) => n > 0);
  const marks = [
    dirty ? theme.fg("warning", "*") : "",
    available && g.ahead ? theme.fg("success", `↑${g.ahead}`) : "",
    available && g.behind ? theme.fg("error", `↓${g.behind}`) : "",
    g.conflicts || g.operation || !available ? theme.fg("error", "!") : "",
  ].filter(Boolean).join(" ");
  const project = theme.bold(theme.fg("accent", clean(g.project ?? (path.basename(s.cwd) || s.cwd))));
  const suffix = marks ? `${g.branch ? " " : ""}${marks}` : "";
  const branchIcon = g.branch ? theme.fg("dim", `${ICONS.branch} `) : "";
  const branch = outsideGit ? "" : `${branchIcon}${theme.fg("muted", clean(g.branch ?? ""))}${suffix}`;
  const branchShort = outsideGit ? "" : `${branchIcon}${theme.fg("muted", truncateToWidth(clean(g.branch ?? ""), 14))}${suffix}`;
  const phaseText = s.phase ? theme.fg(s.phase === "error" ? "error" : "warning", s.phase) : "";
  const model = theme.bold(theme.fg("accent", shortModel(s.model)));
  // Main-only target previews are detached from effective state; the chat line owns phase.
  const draft = !s.readOnly && !s.compact && ["pending", "applying"].includes(s.settingsCycle?.phase ?? "") ? s.settingsCycle : undefined;
  const pending = (key: SettingKey) => draft?.settings.find(setting => setting.key === key);
  const thinking = typeof pending("reasoning")?.target === "string" ? pending("reasoning")!.target as string : s.thinking;
  const reasoningParts: Part[] = thinking ? [
    { text: `${theme.fg("dim", `${ICONS.reasoning} `)}${theme.fg("muted", "reasoning")} ` },
    { text: theme.bold(theme.fg(thinkingColor(thinking), clean(thinking))), action: action("reasoning.cycle") },
  ] : [];
  const reasoning = reasoningParts.map((part) => part.text).join("");
  const identity = `${model}${reasoning ? `${sep}${reasoning}` : ""}`;
  const rawApprovalTarget = pending("approvals")?.target;
  const approvalTarget = rawApprovalTarget === "bypassPermissions" ? "bypass" : rawApprovalTarget;
  const shownMode = s.mode && typeof approvalTarget === "string" && Object.hasOwn(MODE_NAMES, approvalTarget)
    ? { ...s.mode, kind: approvalTarget as PermissionModeStatus["kind"] } : s.mode;
  const modeColor = shownMode ? MODE_COLORS[shownMode.kind] : "muted";
  const approval = shownMode && shownMode.kind !== "chat" && shownMode.kind !== "plan" ? shownMode : undefined;
  const legacyWorkflow = s.mode?.kind === "chat" || s.mode?.kind === "plan" ? { kind: s.mode.kind, key: s.mode.key } : undefined;
  const effectiveWorkflow: WorkflowStatus | undefined = s.workflow ?? legacyWorkflow;
  const workflowTarget = pending("workflow")?.target;
  const workflow: WorkflowStatus | undefined = effectiveWorkflow && (workflowTarget === "work" || workflowTarget === "chat" || workflowTarget === "plan")
    ? { ...effectiveWorkflow, kind: workflowTarget } : effectiveWorkflow;
  rows.push(row(ICONS.project, (w) => fitSegments([
    { text: project, priority: 60 },
    { text: branch, short: branchShort, priority: g.conflicts ? 110 : 70 },
    { text: s.sessionName ? theme.fg("dim", clean(s.sessionName)) : "", priority: 10 },
  ], w, theme)));
  if (s.compact) {
    // One row: room is left for an activity row (pi-bg's tasks, subagents) under the dialog,
    // within the two lines herdr-web-ui allows after a dialog's key hint.
    const used = s.context.percent;
    const ctx = used === null ? "" : `${theme.fg("muted", "Context")} ${theme.bold(theme.fg(used < 70 ? "muted" : heat(used), percent(used)))}${theme.fg("dim", " used")}`;
    const compact = row(ICONS.project, (w) => fitSegments([
      { text: workflow ? workflowBadge(theme, workflow.kind) : "", priority: 130 },
      { text: project, priority: 60 },
      { text: branch, short: branchShort, priority: 40 },
      { text: identity, short: model, priority: 100 },
      { text: ctx, priority: 90 },
      { text: phaseText, priority: 120 },
    ], w, theme));
    return { lines: [" ".repeat(inset) + truncateToWidth(compact, width)], hits: [] };
  }
  // Each provider owns its axis. Legacy chat/plan labels never invent approvals.
  // Gate judgments (including plan+yolo) attach only to the approvals row.
  const gateStatus = approval ? s.statuses.find((status) => /^Gate /.test(stripVTControlCharacters(status))) : undefined;
  const statuses = gateStatus ? s.statuses.filter((status) => status !== gateStatus) : s.statuses;
  const workflowAction = action("workflow.cycle");
  const identitySegments = [
    s.routedTo
      ? partsSegment(
          [{ text: model, action: action("model.open") }, { text: theme.fg("dim", ` → ${shortModel(s.routedTo)}`) }],
          100,
          [{ text: model, action: action("model.open") }],
        )
      : partsSegment([{ text: model, action: action("model.open") }], 100),
    { ...partsSegment(reasoningParts, 65), atomic: !!pending("reasoning") },
    { text: phaseText, priority: 120 },
    { text: s.queued ? theme.fg("warning", "queued") : "", priority: 115 },
  ];
  // The model row's hint: the model picker's key, or else, for a reasoning model, the effort-cycle key.
  const reasoningKey = s.thinking ? s.primaryKeys?.reasoning : undefined;
  const modelKey = s.primaryKeys?.model || reasoningKey;
  const modelKeyAction = s.primaryKeys?.model ? action("model.open") : reasoningKey ? action("reasoning.cycle") : undefined;
  controlRow(ICONS.model, identitySegments, modelKey, modelKeyAction);
  if (workflow) controlRow(ICONS.workflow, [
    { ...partsSegment([{ text: workflowBadge(theme, workflow.kind), action: workflowAction }], 130), atomic: !!pending("workflow") },
    { text: theme.fg("muted", WORKFLOW_EXPLANATIONS[workflow.kind]), priority: 70 },
  ], s.primaryKeys?.workflow ?? workflow.key, workflowAction);
  if (approval) controlRow(ICONS.gate, [
    { ...partsSegment([
      { text: theme.bold(theme.fg(modeColor, MODE_NAMES[approval.kind])) + (approval.kind === "manual" || approval.kind === "acceptEdits" ? theme.fg("muted", " (legacy)") : ""), action: action("approvals.open") },
    ], 120), atomic: !!pending("approvals") },
    partsSegment(s.permissionPrompts ? [{ text: theme.fg(s.permissionPrompts === "off" ? "warning" : "muted", `prompts ${s.permissionPrompts}`), action: action("approvals.open") }] : [], 125),
    { text: gateStatus ? clean(gateStatus) : "", short: gateStatus?.replace(/^Gate (\d+) auto · (\d+) pushed back · (\d+) asked$/u, "Gate $1/$2/$3"), priority: 60 },
  ], s.primaryKeys?.approvals ?? approval.key, action("approvals.open"));

  const context = s.context.percent;
  const ctxValue = context === null ? theme.fg("muted", "unknown") : theme.bold(theme.fg(context < 70 ? "muted" : heat(context), percent(context)));
  const cache = s.cache ? clean(s.cache) : s.actions?.["cache.status"] ? "unknown" : "";
  const cacheNote = cache === "cold (model)" ? "model changed" : "";
  const cacheValue = cache === "cold?" || cache === "unknown" ? "unknown" : cache.startsWith("cold") ? "cold" : cache;
  const ctxParts: Part[] = [{ text: label("Context") }, { text: ctxValue, action: action("context.open") }];
  // What fills the context besides the conversation: MCP servers (our chip, or the
  // status of an extension that publishes its own, which already carries the plug)
  // and loaded skills. Each keeps its icon inline.
  const inline = (icon: string, text: string) => `${theme.fg("dim", icon)} ${text.replace(/[\r\n\t]/g, " ")}`;
  const mcpStatus = statuses.find((status) => stripVTControlCharacters(status).startsWith(`${ICONS.mcp} `));
  const mcpText = mcpStatus ? inline(ICONS.mcp, mcpStatus.replace(`${ICONS.mcp} `, "")) : s.mcp ? inline(ICONS.mcp, mcpChip(s.mcp, theme)) : "";
  const skillsText = s.skills ? inline(ICONS.skills, `${theme.fg("muted", "Skills")} ${s.skills}`) : "";
  const system1 = s.system1;
  const system1Value = system1 ? system1Current(system1, s.now) : "";
  controlRow(ICONS.context, [
    partsSegment([...ctxParts, { text: `${context === null ? "" : theme.fg("dim", " used")}${context === null || s.borderGauge ? "" : ` ${gauge(theme, context)}`}` }], 100, ctxParts),
    partsSegment(system1 ? [
      { text: theme.fg(system1Value === "unavailable" ? "warning" : "muted", `S1 ${system1Value}`), action: action("system1.open") },
    ] : [], 35),
    { text: s.lean ? theme.fg("muted", `Lean ${clean(s.lean)}`) : "", priority: 20 },
    partsSegment([{ text: cache ? `${theme.fg("muted", "Cache")} ${theme.fg(cacheValue === "unknown" ? "muted" : cacheValue === "cold" ? "warning" : "success", cacheValue)}` : "", action: action("cache.status") }], 30),
    { text: cacheNote ? theme.fg("dim", cacheNote) : "", priority: 10 },
    // Inline icons and their gaps are not controls; only the visible chip is.
    partsSegment(mcpText ? [{ text: `${theme.fg("dim", ICONS.mcp)} ` }, { text: mcpStatus ? mcpStatus.replace(`${ICONS.mcp} `, "").replace(/[\r\n\t]/g, " ") : mcpChip(s.mcp!, theme), action: action("mcp.open") }] : [], 25),
    partsSegment(skillsText ? [{ text: `${theme.fg("dim", ICONS.skills)} ` }, { text: `${theme.fg("muted", "Skills")} ${s.skills}`, action: action("context.skills") }] : [], 15),
  ]);
  for (const m of s.marimo ?? []) rows.push(row(ICONS.marimo, (w) => marimoRow(m, w, theme)));
  if (s.lens) { const l = s.lens; rows.push(row(ICONS.lens, (w) => lensRow(l, w, theme))); }
  if (s.bg?.length) { const bg = s.bg; rows.push(row(ICONS.bg, (w) => bgRow(bg, w, theme))); }
  if (s.pressure?.length) { const p = s.pressure; rows.push(row(ICONS.pressure, (w) => pressureRow(p, w, theme))); }
  // Statuses remain owned by their publishers. Wrap instead of silently dropping
  // plan mode, background failures, or other extension notices at the right edge.
  // MCP sits on the context row (above). Notices with an icon of their own (the
  // tool gate's shield) keep it inline; the first notice's icon becomes the row's,
  // a bell otherwise. Wrapped lines are indented under the first.
  const notices: { icon?: string; text: string }[] = [];
  for (const status of statuses) {
    if (status === mcpStatus) continue;
    if (/^Gate /.test(stripVTControlCharacters(status))) notices.push({ icon: ICONS.gate, text: status });
    else notices.push({ text: status });
  }
  if (notices.length) {
    const text = notices.map((n, i) => `${i && n.icon ? `${theme.fg("dim", n.icon)} ` : ""}${n.text.replace(/[\r\n\t]/g, " ")}`).join(sep);
    const lines = wrapTextWithAnsi(text, Math.max(1, width - 1 - ICON_GAP.length));
    rows.push(...lines.map((line, i) => i ? ` ${ICON_GAP}${line}` : `${theme.fg("dim", notices[0].icon ?? ICONS.notices)}${ICON_GAP}${line}`));
  }

  // Subscription limits go last: they are usually the longest rows. The
  // provider-neutral state is populated outside render; old string consumers
  // retain the legacy quota fallback below.
  if (s.providerUsage) {
    for (const [index, usage] of s.providerUsage.entries()) {
      const antigravity = usage.provider === "google" && usage.source === "Google Antigravity subscription";
      const account = antigravity ? "Antigravity" : usage.source === "Claude Code account" ? "Claude Code" : ({
        anthropic: "Claude", "openai-codex": "Codex", openai: "OpenAI", google: "Google", "muse-sdk": "Muse", "muse-code": "Muse",
      } as Record<string, string>)[usage.provider] ?? (usage.state === "not-applicable" ? "Local" : clean(usage.provider));
      const more = index === 1 && s.providerUsageMore ? `+${s.providerUsageMore} more` : "";
      if (usage.state !== "ready") {
        const status = usage.state === "not-applicable" ? "no account quota" : "limits unavailable";
        const text = `${theme.fg("muted", account)}${sep}${theme.fg("dim", status)}${more ? `${sep}${theme.fg("dim", more)}` : ""}`;
        rows.push(row(ICONS.limits, (w) => truncateToWidth(text, w)));
        continue;
      }
      const age = Math.max(0, s.now - (usage.observedAt ?? s.now));
      const expired = usage.windows.some((window) => window.reset !== undefined && window.reset <= s.now);
      const stale = isUsageStale(usage, s.now);
      const shown = usage.windows.filter((window) => showQuotaWindow(window, s.now));
      const windows = shown.map((window): Segment => {
        const value = window.used;
        const color = stale || value === undefined || value < 70 ? "muted" : heat(value);
        const val = `${theme.fg("muted", clean(window.label))} ${theme.bold(theme.fg(color, value === undefined ? "unknown" : percent(value)))}${value === undefined ? "" : theme.fg("dim", " used")}`;
        const reset = window.reset !== undefined && window.reset > s.now ? `${sep}${theme.fg("dim", `resets in ${duration(window.reset - s.now)}`)}` : "";
        const short = antigravity ? `${theme.fg("muted", clean(window.label))} ${theme.bold(theme.fg(color, value === undefined ? "unknown" : percent(value)))}` : val;
        // Scope is data, not a match against labels. Equal usage favors the
        // model-specific limit; a binding limit outlasts healthy detail.
        const priority = 50 + Math.min(100, value ?? 0) + (antigravity && window.scope && window.scope !== "shared" ? 0.5 : 0);
        return { text: `${val}${reset}`, short, priority };
      });
      const extra = usage.extra;
      let extraText = "";
      if (extra?.enabled) {
        extraText = "extra usage on";
        if (extra.used !== undefined) extraText += ` ${extraAmount(extra)}`;
      }
      const full = shown.some((window) => window.used !== undefined && window.used >= 100 && !(window.reset !== undefined && window.reset <= s.now));
      let over: Segment | undefined;
      if (usage.provider === "anthropic" && full) {
        if (extra?.enabled && extra.capReached) over = { text: theme.fg("error", "extra usage cap reached"), short: theme.fg("error", "extra capped"), priority: 230 };
        else if (extra?.enabled) {
          const amount = extraAmount(extra);
          over = { text: theme.fg("error", amount ? `${amount} extra usage` : "on extra usage"),
            short: theme.fg("error", extra.used !== undefined && extra.currency === "USD" ? `${money(extra.used)} extra` : "on extra"), priority: 230 };
        } else if (extra) over = { text: theme.fg("error", "limit reached"), short: theme.fg("error", "limit reached"), priority: 230 };
        // Unknown extra usage state: the red 100% window says enough without guessing.
      }
      const access = usage.provider === "openai-codex" ? usage.access : undefined;
      if (usage.provider === "openai-codex" && (full || access?.limitReached === true || access?.allowed === false)) {
        const blocked = access?.limitReached === true || access?.allowed === false;
        const credits = access?.credits ? ` · ${access.credits.unlimited ? "unlimited" : +access.credits.balance.toFixed(2)} credits` : "";
        over = blocked
          ? { text: theme.fg("error", `limit reached${credits}`), short: theme.fg("error", "limit reached"), priority: 230 }
          : { text: theme.fg("warning", `still allowed${credits}`), short: theme.fg("warning", "still allowed"), priority: 230 };
      }
      const billed = usage.provider === "anthropic" && usage.source !== "Claude Code account" ? s.extraBilled : undefined;
      const segments: Segment[] = [
        { text: label(account), separatorAfter: "", priority: 200 },
        { text: stale ? theme.fg("warning", `stale ${duration(age)}${expired ? " · reset due" : ""}`) : "", short: stale ? theme.fg("warning", expired ? (antigravity ? "reset due" : "stale · reset due") : "stale") : "", priority: 210 },
        ...windows,
        over ?? { text: "", priority: 0 },
        { text: extraText && !over ? theme.fg("warning", extraText) : "", short: extra?.enabled && !over ? "extra on" : "", priority: extra?.enabled ? 75 : 5 },
        { text: billed ? theme.fg("error", `${billed} request${billed === 1 ? "" : "s"} billed to extra usage`) : "", short: billed ? theme.fg("error", `extra x${billed}`) : "", priority: 220 },
        { text: more ? theme.fg("dim", more) : "", priority: 30 },
      ];
      rows.push(row(ICONS.limits, (w) => fitSegments(segments, w, theme)));
    }
  } else {
  for (const quota of s.quotas) {
    const age = Math.max(0, s.now - quota.updated);
    const expired = quota.windows.some((w) => w.reset !== undefined && w.reset <= s.now);
    const stale = age >= QUOTA_STALE_MS || expired;
    const shown = quota.windows.filter((window) => showQuotaWindow(window, s.now));
    const windows = shown.map((w): Segment => {
      let reset = "";
      // Expired windows share the row's reset-due alert; do not repeat it.
      if (w.reset !== undefined && w.reset > s.now) reset = `${sep}${theme.fg("dim", `resets in ${duration(w.reset - s.now)}`)}`;
      const color = stale || w.used < 70 ? "muted" : heat(w.used);
      const val = `${theme.fg("muted", clean(w.label))} ${theme.bold(theme.fg(color, percent(w.used)))}${theme.fg("dim", " used")}`;
      // Text-only quota windows keep account rows quiet at every width.
      return { text: `${val}${reset}`, short: val,
        priority: 50 + Math.min(100, w.used) };
    });
    const extra = quota.extra;
    // An exhausted historical extra-usage pool is not an alert if extra is off.
    let extraText = "";
    if (extra?.enabled) {
      extraText = "extra usage on";
      if (extra.enabled && extra.used !== undefined) {
        extraText += ` ${extraAmount(extra)}`;
      }
    }
    const extraColor = extra?.enabled ? "warning" : "dim";
    const staleText = `stale ${duration(age)}${expired ? " · reset due" : ""}`;
    const billed = quota.source === "Claude acct" ? s.extraBilled : undefined;
    const segments: Segment[] = [
      { text: label(quota.source), short: label(quota.source), separatorAfter: "", priority: 200 },
      { text: stale ? theme.fg("warning", staleText) : "", short: stale ? theme.fg("warning", expired ? "stale · reset due" : "stale") : "", priority: 210 },
      ...windows,
      { text: extraText ? theme.fg(extraColor, extraText) : "", short: extra?.enabled ? "extra on" : "", priority: extra?.enabled ? 75 : 5 },
      { text: billed ? theme.fg("error", `${billed} request${billed === 1 ? "" : "s"} billed to extra usage`) : "",
        short: billed ? theme.fg("error", `extra x${billed}`) : "", priority: 220 },
    ];
    rows.push(row(ICONS.limits, (w) => fitSegments(segments, w, theme)));
  }
  if (s.unavailableQuota) {
    const text = `${label(s.unavailableQuota)}${theme.fg("dim", "limits unavailable")}`;
    rows.push(row(ICONS.limits, (w) => truncateToWidth(text, w)));
  }
  }
  return { lines: rows.map((row) => " ".repeat(inset) + truncateToWidth(row, width)), hits };
}

// pi-stash keeps its prompt in a process-global PromptStash under this symbol.
// Reading it is optional: any other shape just drops the preview.
const STASH_KEY = Symbol.for("@saadjs/pi-stash/prompt");
function stashedPrompt(): string | undefined {
  const value = (globalThis as Record<symbol, unknown>)[STASH_KEY];
  const text = value !== null && typeof value === "object" ? (value as { value?: unknown }).value : undefined;
  return typeof text === "string" ? text : undefined;
}

export default function statusFooter(pi: ExtensionAPI): void {
  const cycles = settingsCycles(pi);
  const reasoningOwner = {};
  let ctx: ExtensionContext | undefined;
  let active = false, enabled = true, showAll = false, generation = 0;
  let showWorking = true, showMcp = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Working-row statistics: pi's indicator message is replaced only while a run
  // is in progress, and restored (undefined) the moment it ends.
  const working = new WorkingStats();
  let workingTimer: ReturnType<typeof setInterval> | undefined, runStarted = 0, workingShown: string | undefined;
  const workingClaims = new Map<string, string>();
  // Built-in MCP chip: tools are in memory, mcp.json is read on its own slow poll.
  const mcpConfig = new McpConfigReader();
  let mcpTimer: ReturnType<typeof setInterval> | undefined, mcp: McpCount | undefined, mcpBusy = false;
  let requestRender: (() => void) | undefined;
  let releaseFooter: (() => void) | undefined;
  let footerControls: ReturnType<typeof createFooterComponent> | undefined;
  let git: GitInfo = { ...emptyGit(), unavailable: true }, gitBusy = false, gitChecked = 0;
  let quotaBusy = false, quotaChecked = 0;
  let quotaFlight: Promise<void> | undefined;
  let borderGauge = false;
  let mainEditor: FooterEditor | undefined, mainTui: FooterTui | undefined;
  let mainKeys: { getKeys?(action: "app.model.select" | "app.thinking.cycle"): readonly string[] } | undefined;
  let releaseInput: (() => void) | undefined;
  let releaseCycleGuard: (() => void) | undefined;
  let promptDepth = 0, interactionGeneration = 0;
  let discoveredActions: ReturnType<typeof queryFooterActions> = {};
  let discoveredSystem1: System1Status | undefined;
  let prepared: Snapshot | undefined;
  let liveStatuses: (() => ReadonlyMap<string, string>) | undefined;
  let refreshSnapshot: (() => void) | undefined;
  const stageReasoning = () => {
    const context = ctx;
    if (!active || !enabled || !context) return;
    if (!context.model?.reasoning) { context.ui.notify("Current model does not support thinking", "warning"); return; }
    const epoch = interactionGeneration, sessionId = context.sessionManager.getSessionId();
    void cycles.stage(context, {
      key: "reasoning", owner: reasoningOwner,
      read: () => pi.getThinkingLevel(),
      next: value => {
        const levels = getSupportedThinkingLevels(context.model!);
        return levels[(levels.indexOf(value) + 1) % levels.length] as ThinkingLevel;
      },
      format: value => value,
      current: () => active && epoch === interactionGeneration && ctx?.sessionManager.getSessionId() === sessionId,
      validate: () => ctx?.model?.reasoning ? undefined : "Current model does not support thinking",
      apply: value => {
        pi.setThinkingLevel(value);
        pi.events.emit(SETTINGS_REASONING_COMMITTED, { level: pi.getThinkingLevel() });
        return true;
      },
    }).catch(error => context.ui.notify(`Settings change failed: ${String(error)}`, "error"));
  };
  const bindCycleGuard = () => {
    releaseCycleGuard?.();
    const editor = mainEditor, tui = mainTui, epoch = interactionGeneration;
    releaseCycleGuard = cycles.addGuard(() => {
      if (!active || !enabled) return undefined;
      if (epoch !== interactionGeneration || editor !== mainEditor || tui !== mainTui) return "main editor changed";
      return editor && tui?.getFocusedComponent?.() === editor && tui?.hasOverlay?.() === false && !promptDepth && !blockedHolds
        ? undefined : "main editor is not available";
    });
  };
  const interactions = createFooterActionController({
    getEditor: () => mainEditor, getTui: () => mainTui, getGeneration: () => interactionGeneration,
    isCurrent: () => active && enabled && !!ctx,
    getBlocked: () => blockedHolds, getPromptDepth: () => promptDepth,
    isIdle: () => ctx?.isIdle() === true,
    getActions: () => discoveredActions,
    cycleReasoning: stageReasoning,
    captureCycleTrigger: () => cycles.captureTrigger(),
    withCycleTrigger: (trigger, run) => cycles.withTrigger(trigger, run),
    cancelSettings: reason => cycles.cancel(reason),
    notify: (message, type) => ctx?.ui.notify(message, type),
    refresh: () => requestRender?.(),
  });
  let codexBusy = false, codexAbort: AbortController | undefined;
  let claude: Quota | undefined, claudeHeaders: Quota | undefined;
  let codex: ProviderUsage | undefined;
  let claudePiAccount = false;
  /** Why the last Pi-account read failed, for /status details. */
  let claudeReason: string | undefined;
  let claudeCredentialHash: string | undefined;
  let usageCollector = createProviderUsageCollector();
  const providerReadings = new Map<string, ProviderUsage>();
  const providerModels = new Map<string, { id: string; baseUrl?: string }>();
  const providerIdentities = new Map<string, string>();
  const providerVariants = new Map<string, string | undefined>();
  const googleVariantMaps = new Map<string, Partial<Record<ThinkingLevel, ArgonQuotaVariant>>>();
  let providerSelectionEpoch = 0;
  const rememberGoogleVariants = (model: Model<any>) => {
    if (model.provider !== "google" || model.id !== ARGON_MODEL) return;
    const variants: Partial<Record<ThinkingLevel, ArgonQuotaVariant>> = {};
    if (model.reasoning) for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]) {
      const variant = argonQuotaVariant(clampThinkingLevel(model, level), model.thinkingLevelMap);
      if (variant) variants[level] = variant;
    }
    googleVariantMaps.set(model.id, variants);
  };
  const expectedGoogleVariant = (modelId: string | undefined, thinking: string | undefined) =>
    modelId === ARGON_MODEL && thinking ? googleVariantMaps.get(modelId)?.[thinking as ThinkingLevel] : undefined;
  const invalidateGoogleUsage = () => {
    providerSelectionEpoch++;
    providerReadings.delete("google"); providerVariants.delete("google"); providerIdentities.delete("google");
  };
  let phase: string | undefined;
  /** Open `herdr:blocked` holds: dialogs waiting on the user. */
  let blockedHolds = 0;
  let totals = collectTotals([], Date.now()), cacheHit: number | undefined;
  const children = new Set<ChildProcess>();
  const home = homedir();
  const cacheDir = process.env.CLAUDE_STATUSLINE_CACHE_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "claude-statusline");
  // This is only Claude Code's account. Pi's OAuth allowance is read from
  // the shared account-bound subscription reader, never this fallback cache.
  const cacheFile = path.join(cacheDir, "oauth-usage.json");

  const exec = (file: string, args: string[], cwd?: string): Promise<string | undefined> => new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout: 4_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      children.delete(child);
      resolve(error ? undefined : stdout);
    });
    children.add(child);
  });
  // Keep Git status errors structured without changing other exec callers.
  type GitRead = { kind: "ok"; stdout: Buffer } | { kind: "not-repository" | "unavailable" };
  const readGitStatus = (cwd: string): Promise<GitRead> => new Promise((resolve) => {
    const child = execFile("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--ahead-behind", "--untracked-files=all", "-z"],
      { cwd, encoding: "buffer", timeout: 4_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (error, stdout, stderr) => {
        children.delete(child);
        if (!error) resolve({ kind: "ok", stdout });
        else resolve({ kind: error.code === 128 && !error.killed && /^fatal: not a git repository \(or any (?:of the parent directories\):[^\r\n]*|parent up to mount point [^\r\n]+\)(?::[^\r\n]*)?)(?:\r?\n|$)/.test(stderr.toString("utf8"))
          ? "not-repository" : "unavailable" });
      });
    children.add(child);
  });
  // Claude Code's OAuth token: Keychain on macOS, else its credentials file.
  const claudeToken = async () => {
    const raw = process.platform === "darwin"
      ? await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])
      : undefined;
    const text = raw ?? await readFile(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), ".credentials.json"), "utf8").catch(() => undefined);
    try {
      const token = record(record(JSON.parse(text ?? "")).claudeAiOauth).accessToken;
      return typeof token === "string" && token ? token : undefined;
    } catch { return undefined; }
  };
  // Pi's own Anthropic subscription login; Pi's registry refreshes it. API keys
  // (no subscription) yield nothing.
  const piClaudeToken = async (context: ExtensionContext) => {
    try {
      const token = await context.modelRegistry.getApiKeyForProvider("anthropic");
      return token?.startsWith("sk-ant-oat") ? token : undefined;
    } catch { return undefined; }
  };
  // Claude Code's login and status line share one account cache and lock.
  const refreshClaudeCache = async (file: string) => {
    try { if (Date.now() - (await stat(file)).mtimeMs < CLAUDE_TTL_MS) return; } catch { /* no cache yet */ }
    const lock = path.join(path.dirname(file), ".fetch.lock");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      try { if (Date.now() - (await stat(lock)).mtimeMs > CLAUDE_LOCK_STALE_MS) await rmdir(lock); } catch { /* no lock */ }
      await mkdir(lock);
    } catch { return; } // someone else is fetching
    try {
      const token = await claudeToken();
      if (!active) return;
      if (!token) {
        // No Claude Code login here (a herdr-machine0 spoke): ask a command that
        // prints the usage JSON instead, e.g. `spoke usage claude`.
        const command = process.env.PI_STATUS_FOOTER_CLAUDE_USAGE_CMD?.trim().split(/\s+/).filter(Boolean);
        if (!command?.length) return;
        const body = await exec(command[0], command.slice(1));
        if (!body || !active) return;
        JSON.parse(body);
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, body);
        await rename(temporary, file);
        return;
      }
      const response = await fetch(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json",
          // Without a claude-code User-Agent this endpoint is heavily rate limited.
          "User-Agent": claudeCodeUserAgent(),
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return;
      const body = await response.text();
      JSON.parse(body);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, file);
    } catch { /* keep the last good cache */ } finally { await rmdir(lock).catch(() => undefined); }
  };
  const account = () => {
    if (!active || !ctx) return;
    totals = collectTotals(ctx.sessionManager.getEntries(), Date.now());
    const cached = routedModel(ctx) ?? ctx.model;
    cacheHit = latestCacheHit(ctx.sessionManager.getBranch(), cached?.provider ?? "", cached?.id ?? "");
  };
  const updateGit = async (force = false) => {
    if (!active || !ctx || gitBusy || (!force && Date.now() - gitChecked < GIT_TTL_MS)) return;
    gitBusy = true; gitChecked = Date.now();
    const epoch = generation, cwd = ctx.cwd;
    try {
      const [status, roots, diff] = await Promise.all([
        readGitStatus(cwd),
        exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], cwd),
        exec("git", ["diff", "--shortstat", "HEAD", "--"], cwd),
      ]);
      const gitDir = roots?.trim().split("\n")[1];
      let operation = false, operationUnreadable = false;
      if (gitDir) {
        try { operation = await detectGitOperation(path.resolve(cwd, gitDir)); }
        catch { operationUnreadable = true; }
      }
      if (!active || epoch !== generation) return;
      git = status.kind === "ok" ? parseGitStatus(status.stdout)
        : status.kind === "not-repository" ? { ...emptyGit(), notRepository: true }
        : { ...emptyGit(), unavailable: true };
      git.operation = operation;
      if (operationUnreadable) git.unavailable = true;
      if (roots) {
        const [root, gitDir, commonDir] = roots.trim().split("\n");
        git.worktree = path.resolve(cwd, commonDir) !== path.resolve(cwd, gitDir);
        git.project = git.worktree ? path.basename(path.dirname(path.resolve(cwd, commonDir))) : path.basename(root);
        const sub = path.relative(root, cwd);
        if (sub) git.project += `/${sub}`;
      }
      git.added = +(diff?.match(/(\d+) insertion/)?.[1] ?? 0);
      git.removed = +(diff?.match(/(\d+) deletion/)?.[1] ?? 0);
      requestRender?.();
    } catch {
      if (active && epoch === generation) { git = { ...emptyGit(), unavailable: true }; requestRender?.(); }
    } finally { if (epoch === generation) gitBusy = false; }
  };
  const updateQuota = (force = false): Promise<void> => {
    if (quotaFlight) return quotaFlight;
    if (!active || !ctx || (!force && Date.now() - quotaChecked < 60_000)) return Promise.resolve();
    const read = async () => {
    quotaBusy = true; quotaChecked = Date.now();
    const epoch = generation, context = ctx!;
    try {
      const routed = context.model?.provider === "waterfall" ? queryWaterfall(pi.events)?.physical : undefined;
      if (context.model?.provider !== "anthropic" && routed?.provider !== "anthropic" && !showAll) return;
      // Prefer Pi's own login: it is the account this session bills.
      const piToken = await piClaudeToken(context);
      if (!active || epoch !== generation) return;
      const credentialHash = piToken ? createHash("sha256").update(piToken).digest("hex") : undefined;
      if (claudeCredentialHash !== credentialHash) {
        claude = undefined; claudeHeaders = undefined; claudePiAccount = false; claudeReason = undefined;
        claudeCredentialHash = credentialHash;
      }
      if (piToken) {
        // The router and footer share the same account-bound reader. No Claude
        // Code fallback can supply Pi's OAuth allowance for a different account.
        const reading = await readPiAnthropicUsage(context);
        if (active && epoch === generation) claudeReason = reading.state === "ready" ? undefined : reading.reason;
        if (active && epoch === generation && reading.state === "ready" && reading.observedAt !== undefined) {
          const parsed: Quota = { source: "Claude acct", updated: reading.observedAt,
            windows: reading.windows.map((window) => ({ label: window.label, used: window.used!, reset: window.reset, observedAt: window.observedAt })),
            extra: reading.extra };
          claudePiAccount = true;
          claude = claudeHeaders && claudeHeaders.updated > parsed.updated ? mergeQuota(parsed, claudeHeaders) : parsed;
        }
      } else {
        await refreshClaudeCache(cacheFile);
        try {
          const [text, meta] = await Promise.all([readFile(cacheFile, "utf8"), stat(cacheFile)]);
          const parsed = parseClaudeQuota(JSON.parse(text), meta.mtimeMs);
          if (active && epoch === generation && parsed.windows.length) { claudePiAccount = false; claude = parsed; }
        } catch { /* Keep last good snapshot; its timestamp makes staleness visible. */ }
      }
      if (active && epoch === generation) requestRender?.();
    } finally { if (epoch === generation) quotaBusy = false; }
    };
    const pending = read();
    quotaFlight = pending.finally(() => { if (quotaFlight === completed) quotaFlight = undefined; });
    const completed = quotaFlight;
    return completed;
  };
  // The shared reader owns identity checks, bounded I/O and account-isolated
  // caching. Resolve identity on every refresh, even while a reading is fresh.
  const updateCodex = async () => {
    if (!active || !ctx || codexBusy) return;
    const routed = ctx.model?.provider === "waterfall" ? queryWaterfall(pi.events)?.physical : undefined;
    if (accountUsageProvider(ctx.model?.provider ?? "") !== "openai-codex" && routed?.provider !== "openai-codex" && !showAll) return;
    codexBusy = true;
    const epoch = generation, context = ctx, controller = new AbortController();
    codexAbort = controller;
    try {
      const reading = await readCodexUsage(context, { signal: controller.signal });
      if (!active || epoch !== generation || ctx?.modelRegistry !== context.modelRegistry || codexAbort !== controller || controller.signal.aborted) return;
      // Presentation names the signed-in account, not its applicability to inference.
      // Unavailable or changed credentials must never retain the previous allowance.
      codex = { ...reading, source: "Codex account", reason: reading.state === "ready" ? undefined : reading.reason };
      requestRender?.();
    } finally {
      if (codexAbort === controller) codexAbort = undefined;
      if (epoch === generation) codexBusy = false;
    }
  };
  // pi's setWorkingMessage persists until cleared, so every path out of a run
  // (turn end, agent end, shutdown, /status working off) restores the default.
  const setWorking = (message: string | undefined) => {
    message = [...workingClaims.values()].at(-1) ?? message;
    if (!ctx || message === workingShown) return;
    workingShown = message;
    try { ctx.ui.setWorkingMessage(message); } catch { /* UI gone; nothing to restore */ }
  };
  const syncWorking = () => {
    if (!active || !runStarted || !showWorking) return;
    setWorking(workingMessage(working.tokens(), Date.now() - runStarted));
  };
  // Other plugins' working rows (pi-sidebar's) read like main's while main shows working stats.
  // pi-recap names the session after its recap for the /resume list; that name stays off the footer.
  let recapName: string | undefined;
  pi.events?.on("recap:session-name", (data) => {
    const name = (data as { name?: unknown } | undefined)?.name;
    recapName = typeof name === "string" ? name : undefined;
  });
  pi.events?.on(WORKING_STATS_CHANNEL, (data) => {
    const request = data as WorkingStatsRequest | undefined;
    if (!active || !showWorking || !request || request.version !== 1 || request.service) return;
    request.service = workingStatsService;
    request.provider = "pi-status-footer";
  });
  // Other plugins' views of another session (pi-subagents') draw this footer and gauge for it.
  pi.events?.on(SESSION_CHROME_CHANNEL, (data) => {
    const request = data as SessionChromeRequest | undefined;
    if (!active || !enabled || !ctx || !request || request.version !== 1 || request.service) return;
    const epoch = generation;
    const current = () => active && enabled && epoch === generation && ctx !== undefined;
    request.service = {
      footer(session, width, theme) {
        if (!current()) return [];
        try {
          return prepared ? renderFooter(childSnapshot(prepared, session), width, liftAccent(theme)) : [];
        } catch {
          return [];
        }
      },
      gauge(editor, used, theme) {
        return drawGaugeOnBorders(editor, () => (current() ? used() : null), () => {
          const paint = current() ? theme() : undefined;
          return paint ? liftAccent(paint) : undefined;
        });
      },
    };
    request.provider = "pi-status-footer";
  });
  // herdr's pi integration counts these pairs; so do we, to shrink the footer while a dialog waits.
  pi.events?.on(HERDR_BLOCKED_EVENT, (data) => {
    const hold = data as { active?: unknown } | undefined;
    blockedHolds = hold?.active === true ? blockedHolds + 1 : Math.max(0, blockedHolds - 1);
    requestRender?.();
  });
  pi.events?.on(WORKING_MESSAGE_EVENT, (data) => {
    const claim = data as Partial<WorkingMessageClaim> | undefined;
    if (!active || typeof claim?.owner !== "string") return;
    if (typeof claim.message === "string") workingClaims.set(claim.owner, claim.message);
    else if (!workingClaims.delete(claim.owner)) return;
    if (runStarted && showWorking) syncWorking();
    else setWorking(undefined);
  });
  // A turn's end keeps the run's clock for the next turn; the run's end drops it.
  const endTurn = () => {
    if (workingTimer !== undefined) clearInterval(workingTimer);
    workingTimer = undefined; working.reset();
    setWorking(undefined);
  };
  const endRun = () => { endTurn(); runStarted = 0; };
  const startRun = () => {
    if (!active || !showWorking) return;
    if (!runStarted) runStarted = Date.now();
    if (workingTimer !== undefined) return;
    const epoch = generation;
    workingTimer = setInterval(() => {
      if (!active || epoch !== generation) return;
      // A throwing timer callback would take pi down; a decorative row just stops.
      try { syncWorking(); } catch { endRun(); }
    }, WORKING_REFRESH_MS);
    workingTimer.unref();
  };
  const updateMcp = async () => {
    if (!active || !ctx || !showMcp || mcpBusy) return;
    mcpBusy = true;
    const epoch = generation, context = ctx;
    try {
      let next: McpCount | undefined;
      // The tool and command lists live on the API; the context gives cwd and trust.
      if (builtinMcpOwnsCommand(pi.getCommands())) {
        const connected = connectedMcpServers(pi.getAllTools());
        const configured = await mcpConfig.configured({ agentDir: getAgentDir(), cwd: context.cwd, projectTrusted: context.isProjectTrusted() });
        next = countMcp(connected, configured);
      }
      if (!active || epoch !== generation) return;
      if (next?.connected !== mcp?.connected || next?.total !== mcp?.total) { mcp = next; requestRender?.(); }
    } catch { /* The footer must not fail over a tool list or config read. */ } finally { if (epoch === generation) mcpBusy = false; }
  };
  // Discovery is explicitly outside render, including other-session chrome. The
  // provider descriptor excludes virtual-only models, which are not accounts.
  const discoverProviders = (context: ExtensionContext) => {
    const activeModel = context.model;
    let available: readonly typeof activeModel[] = [];
    try { available = typeof context.modelRegistry.getAvailable === "function" ? context.modelRegistry.getAvailable() : []; }
    catch { /* Keep the active physical model when optional discovery fails. */ }
    const found = new Map<string, { id: string; baseUrl?: string }>();
    googleVariantMaps.clear();
    for (const model of available) {
      if (!model || model.api === "pi-virtual") continue;
      rememberGoogleVariants(model);
      try {
        const physical = context.modelRegistry.getProvider?.(model.provider);
        if (!physical?.getModels().some((entry) => entry.id === model.id)) continue;
        if (!found.has(model.provider)) found.set(model.provider, { id: model.id, baseUrl: model.baseUrl });
      } catch { /* An unavailable optional provider must not take down the footer. */ }
    }
    if (activeModel && activeModel.api !== "pi-virtual") {
      rememberGoogleVariants(activeModel);
      found.set(activeModel.provider, { id: activeModel.id, baseUrl: activeModel.baseUrl });
    }
    providerModels.clear();
    for (const [id, model] of found) providerModels.set(id, model);
    for (const id of providerReadings.keys()) if (!found.has(id)) { providerReadings.delete(id); providerIdentities.delete(id); providerVariants.delete(id); }
  };
  const usageOrder = (id: string): number => {
    const order = ["anthropic", "openai-codex", "google", "muse-sdk", "muse-code"];
    const index = order.indexOf(id);
    return index < 0 ? order.length : index;
  };
  const orderedProviders = () => [...new Set([...providerModels.keys()].map(accountUsageProvider))].sort((a, b) => usageOrder(a) - usageOrder(b) || a.localeCompare(b));
  const cachedUsage = (provider: string, modelId?: string, expectedVariant?: ArgonQuotaVariant): ProviderUsage => {
    if (provider === "anthropic") return claude ? {
      provider, source: claudePiAccount ? "Claude subscription" : "Claude Code account", state: "ready", observedAt: claude.updated,
      windows: claude.windows.map((window) => ({ ...window })), ...(claude.extra ? { extra: claude.extra } : {}),
    } : { provider, source: "Claude", state: "unavailable", windows: [], reason: claudeReason ?? "Anthropic subscription usage has not been observed." };
    if (provider === "openai-codex") return codex ??
      { provider, source: "Codex account", state: "unavailable", windows: [], reason: "Codex subscription usage has not been observed." };
    const cached = providerReadings.get(provider);
    if (provider === "google" && modelId === ARGON_MODEL) {
      if (!expectedVariant || providerVariants.get(provider) !== expectedVariant) return { provider, source: "Google Antigravity subscription", state: "unavailable", windows: [], reason: "The exact Argon reasoning-variant quota has not been observed." };
    }
    if (cached) return cached;
    if (provider === "google") return { provider, source: "Google Antigravity subscription", state: "unavailable", windows: [], reason: "Google quota has not been observed for the selected model." };
    if (provider === "waterfall") return { provider, source: "Waterfall", state: "unavailable", windows: [], reason: "No physical subscription route has been verified." };
    const model = providerModels.get(provider);
    return dispatchProviderUsage({ provider, sourceId: provider, model: modelId ?? model?.id,
      baseUrl: model?.baseUrl, auth: provider === "google" ? { kind: "vault" } : { kind: "api-key" } }, Date.now()) ??
      { provider, source: provider, state: "unavailable", windows: [], reason: "Subscription usage has not been observed." };
  };
  const selectedUsage = (provider: string, modelId?: string, thinking?: string) => {
    provider = accountUsageProvider(provider);
    const forRow = (id: string, selected?: string, level?: string): ProviderUsage => {
      selected ??= providerModels.get(id)?.id;
      const reading = cachedUsage(id, selected, expectedGoogleVariant(selected, level));
      if (id !== "google" || reading.state !== "ready") return reading;
      const windows = selectGooglePool(reading, selected ?? providerModels.get(id)?.id ?? "");
      return windows.length ? { ...reading, windows } : { ...reading, state: "unavailable", windows: [], reason: reading.windows.some((window) => window.model) ? "No quota has been observed for the selected Google model." : "No quota window matches the selected Google model pool." };
    };
    const active = forRow(provider, modelId, thinking);
    if (!showAll) return { rows: [active], more: 0 };
    const others = orderedProviders().filter((id) => id !== provider).map((id) => forRow(id, undefined, pi.getThinkingLevel()))
      .filter((usage) => usage.state !== "not-applicable");
    return { rows: others.length ? [active, others[0]] : [active], more: Math.max(0, others.length - 1) };
  };
  const updateProviderUsage = async () => {
    if (!active || !ctx) return;
    const context = ctx, epoch = generation, selectionEpoch = providerSelectionEpoch;
    discoverProviders(context);
    const routed = context.model?.provider === "waterfall" ? queryWaterfall(pi.events)?.physical : undefined;
    const ids = showAll ? orderedProviders() : [routed?.provider ?? context.model?.provider].filter((id): id is string => !!id).map(accountUsageProvider);
    await Promise.all(ids.filter((id) => id !== "anthropic" && id !== "openai-codex").map(async (id) => {
      let model;
      try { model = routed?.provider === id ? context.modelRegistry.find(id, routed.id) : providerModels.get(id); }
      catch { return; }
      if (!model) return;
      let variant: ArgonQuotaVariant | undefined;
      if (id === "google" && model.id === ARGON_MODEL) {
        // Resolve physical models outside render. Never assume medium when the
        // exact physical model's reasoning mapping is unavailable.
        let physical;
        try { physical = context.modelRegistry.find(id, model.id); } catch { /* Unknown. */ }
        if (physical) rememberGoogleVariants(physical);
        variant = expectedGoogleVariant(model.id, routed?.thinkingLevel ?? pi.getThinkingLevel());
        if (routed?.provider === id && routed.quotaVariant !== variant) variant = undefined;
        if (!variant) {
          providerReadings.delete(id); providerVariants.delete(id); providerIdentities.delete(id);
          providerReadings.set(id, { provider: id, source: "Google Antigravity subscription", state: "unavailable", windows: [], reason: "The exact Argon reasoning variant is unknown." });
          requestRender?.();
          return;
        }
      }
      // The Muse SDK bridge and pi-muse-bridge (muse-code, marked by its
      // "muse-code-local" key) both run on the Muse CLI's signed-in subscription.
      let auth: UsageSource["auth"] = id === "muse-sdk" ? { kind: "local-oauth" } : { kind: "api-key" };
      if (id === "muse-code") {
        let key: string | undefined;
        try { key = await context.modelRegistry.getApiKeyForProvider(id); } catch { /* Not the bridge's marker. */ }
        if (key === "muse-code-local") auth = { kind: "local-oauth", token: key };
      }
      if (id === "google") {
        let selected = routed?.provider === id ? context.modelRegistry.find(id, routed.id) : context.model?.provider === id ? context.model : undefined;
        let localOAuth = false;
        try {
          selected = context.modelRegistry.find?.(id, model.id) ?? selected;
          localOAuth = !!selected && context.modelRegistry.isUsingOAuth(selected);
        } catch { /* Treat uncertain auth as vault/unavailable; never send its key. */ }
        if (localOAuth) {
          try { auth = { kind: "local-oauth", token: await context.modelRegistry.getApiKeyForProvider(id) }; }
          catch { auth = { kind: "local-oauth" }; }
        } else auth = { kind: "vault" };
      }
      if (!active || epoch !== generation || selectionEpoch !== providerSelectionEpoch) return;
      const source: UsageSource = { provider: id, sourceId: model.id, model: model.id, ...(variant ? { variant } : {}), baseUrl: model.baseUrl, auth };
      const identity = createHash("sha256").update(JSON.stringify(source)).digest("hex");
      if (providerIdentities.get(id) !== identity) {
        providerReadings.delete(id);
        providerIdentities.set(id, identity);
      }
      providerVariants.set(id, variant);
      const previous = cachedUsage(id, model.id, variant);
      const reading = await usageCollector.refresh(source);
      if (!active || epoch !== generation || selectionEpoch !== providerSelectionEpoch || providerIdentities.get(id) !== identity) return;
      providerReadings.set(id, reading);
      if (JSON.stringify(previous) !== JSON.stringify(reading)) requestRender?.();
    }));
  };
  /** Main's detached presentation snapshot, prepared only outside rendering. */
  const snapshot = (branch: string | null, statuses: ReadonlyMap<string, string>): Snapshot => {
    if (!ctx) throw new Error("Footer rendered outside its session lifecycle");
    const current = ctx;
    const routed = current.model?.provider === "waterfall" ? queryWaterfall(pi.events)?.physical : undefined;
    const provider = routed?.provider ?? current.model?.provider ?? "no provider";
    let physicalModel = isVirtual(current.model) ? (routedModel(current) ?? current.model) : current.model;
    if (routed) {
      try { physicalModel = current.modelRegistry.find(routed.provider, routed.id); }
      catch { physicalModel = undefined; }
    }
    const quotas: Quota[] = [];
    let unavailableQuota: string | undefined;
    if (provider === "anthropic" || showAll) {
      if (claude) quotas.push(claude); else unavailableQuota = "Claude acct";
    }
    const usage = routed && !physicalModel
      ? { rows: [{ provider, source: "Waterfall", state: "unavailable" as const, windows: [], reason: "The verified physical model is no longer available." }], more: 0 }
      : selectedUsage(provider, physicalModel?.id, routed?.thinkingLevel ?? pi.getThinkingLevel());
    const absorbed = absorbStatuses(statuses, { claudeRow: quotas.some((q) => q.source === "Claude acct") });
    const controls: FooterControlState = {};
    for (const [id, descriptor] of Object.entries(discoveredActions)) {
      if (descriptor) controls[id as FooterActionId] = { key: descriptor.key, active: descriptor.active };
    }
    // Native capability/focus interfaces are required; an unsupported editor
    // never advertises a button that would have to rewrite a draft to work.
    const nativeControls = typeof mainTui?.getFocusedComponent === "function" && typeof mainTui?.hasOverlay === "function" &&
      typeof mainEditor?.actionHandlers?.get === "function";
    if (nativeControls && mainEditor?.actionHandlers?.get("app.model.select")) controls["model.open"] = {};
    if (nativeControls && mainEditor?.actionHandlers?.get("app.thinking.cycle")) controls["reasoning.cycle"] = {};
    const main: Snapshot = {
      system1: discoveredSystem1, actions: controls, settingsCycle: cycles.snapshot(),
      primaryKeys: {
        model: controls["model.open"] ? mainKeys?.getKeys?.("app.model.select")?.[0] : undefined,
        reasoning: controls["reasoning.cycle"] ? mainKeys?.getKeys?.("app.thinking.cycle")?.[0] : undefined,
        workflow: discoveredActions["workflow.cycle"] ? discoveredActions["workflow.cycle"].key ?? "" : absorbed.workflow?.key,
        approvals: discoveredActions["approvals.open"] ? discoveredActions["approvals.open"].key ?? "" : absorbed.mode?.key,
      },
      cwd: current.cwd, provider, model: routed && physicalModel ? `auto → ${routed.id}` : current.model?.id ?? "no model",
      ...(isVirtual(current.model) && physicalModel && physicalModel !== current.model ? { routedTo: physicalModel.id } : {}),
      thinking: current.model?.reasoning ? pi.getThinkingLevel() : undefined,
      oauth: physicalModel ? current.modelRegistry.isUsingOAuth(physicalModel) : false,
      sessionName: ownName(pi.getSessionName(), recapName), phase, queued: current.hasPendingMessages(),
      context: current.getContextUsage() ?? { tokens: null, contextWindow: physicalModel?.contextWindow ?? 0, percent: null },
      totals, cacheHit, git: { ...git, branch: git.branch ?? branch ?? undefined },
      quotas, unavailableQuota, providerUsage: usage.rows, providerUsageMore: usage.more,
      statuses: absorbed.rest, workflow: absorbed.workflow, mode: absorbed.mode, permissionPrompts: absorbed.permissionPrompts, lean: absorbed.lean, cache: absorbed.cache, extraBilled: absorbed.extraBilled,
      reload: absorbed.reload,
      stash: absorbed.stashed ? { text: stashedPrompt() } : undefined,
      headsUp: absorbed.headsUp,
      marimo: absorbed.marimo, lens: absorbed.lens, bg: absorbed.bg, pressure: absorbed.pressure, borderGauge, compact: blockedHolds > 0,
      // Yield to an extension that publishes its own mcp status (pi-mcp-adapter).
      mcp: showMcp && !absorbed.mcp ? mcp : undefined,
      skills: pi.getCommands().filter((command) => command.source === "skill").length,
      now: Date.now(),
    };
    return main;
  };
  const childSnapshot = (main: Snapshot, session: SessionChromeOverrides): Snapshot => {
    // Shared account readings are already cached; select the child's provider
    // without registry/command discovery on the caller's rendering stack.
    const quotas: Quota[] = [];
    let unavailableQuota: string | undefined;
    if (session.provider === "anthropic" || showAll) {
      if (claude) quotas.push(claude); else unavailableQuota = "Claude acct";
    }
    const usage = selectedUsage(session.provider, session.model, session.thinking);
    return {
      ...main,
      // Main's mutable controls and policy are not the viewed agent's state.
      system1: undefined, actions: undefined, settingsCycle: undefined, primaryKeys: undefined, readOnly: true,
      workflow: undefined, mode: undefined, permissionPrompts: undefined,
      cache: undefined, lean: undefined,
      cwd: session.cwd, provider: session.provider, model: session.model, thinking: session.thinking,
      oauth: false, quotas, unavailableQuota, providerUsage: usage.rows, providerUsageMore: usage.more,
      sessionName: session.sessionName, phase: session.phase, queued: session.queued === true,
      context: session.context, totals: session.totals, cacheHit: undefined,
      // Main's git status describes main's directory only.
      git: path.resolve(session.cwd) === path.resolve(main.cwd) ? main.git : { ...emptyGit(), unavailable: true },
      borderGauge: session.borderGauge === true,
    };
  };
  const attach = () => {
    if (!active || !ctx) return;
    if (!enabled) { ctx.ui.setFooter(undefined); return; }
    const epoch = generation;
    ctx.ui.setFooter((tui, theme, footerData) => {
      if (!active || epoch !== generation) return { render: () => [], invalidate() {} };
      let disposed = false, scheduled = false;
      const current = () => !disposed && active && epoch === generation;
      // getGitBranch can initialize SDK disk-backed state. Read it here and on
      // its subscription, never from render (including child chrome).
      let branch = footerData.getGitBranch();
      const getStatuses = () => footerData.getExtensionStatuses();
      liveStatuses = getStatuses;
      const refresh = (clock = true) => {
        if (!current()) return;
        discoveredSystem1 = querySystem1State(pi.events);
        discoveredActions = queryFooterActions(pi.events);
        const next = snapshot(branch, footerData.getExtensionStatuses());
        if (!clock && prepared) next.now = prepared.now;
        if (JSON.stringify(next) === JSON.stringify(prepared)) return;
        component.invalidate();
        prepared = next;
        tui.requestRender();
      };
      const render = () => { if (current()) { refresh(); tui.requestRender(); } };
      // SDK status updates request a render but have no public change event.
      // Coalesce discovery after that frame, then repaint only on an actual
      // snapshot change. Provider callbacks, command lookup and usage getters
      // are therefore always outside the renderer's call stack.
      const schedule = () => {
        if (scheduled || !current()) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (!current()) return;
          try { refresh(false); }
          catch {
            // A failed optional publisher must not become an unhandled async
            // exception. Retain the last frame but retire its callable actions.
            discoveredActions = {};
            component.invalidate();
          }
        });
      };
      const component = createFooterComponent((width) => {
        schedule();
        return current() && prepared ? layoutFooter(prepared, width, liftAccent(theme)) : { lines: [], hits: [] };
      }, () => `${interactionGeneration}:${tui.terminal?.columns}:${tui.terminal?.rows}`,
      (action) => interactions.available(action), (action) => interactions.activate(action, "pointer"));
      footerControls = component;
      const unsubscribe = footerData.onBranchChange(() => { if (current()) { branch = footerData.getGitBranch(); void updateGit(true); render(); } });
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (requestRender === render) requestRender = undefined;
        if (releaseFooter === dispose) releaseFooter = undefined;
        if (refreshSnapshot === render) refreshSnapshot = undefined;
        if (liveStatuses === getStatuses) liveStatuses = undefined;
        component.dispose();
        if (footerControls === component) footerControls = undefined;
        unsubscribe();
      };
      requestRender = render;
      releaseFooter = dispose;
      refreshSnapshot = render;
      refresh();
      return {
        ...component,
        invalidate() { component.invalidate(); schedule(); },
        dispose,
      };
    });
  };
  // Wrap whatever editor is installed (pi-vim's, pi-stash's wrapper, or pi's
  // own) instead of replacing it. Extensions that install an editor without
  // chaining must load before this one. Our own earlier wrapper is unwrapped so
  // repeated sessions do not stack.
  let releaseEditor: (() => void) | undefined;
  const restorePreferences = (context: ExtensionContext) => {
    enabled = true; showAll = false; showWorking = true; showMcp = true;
    for (const raw of context.sessionManager.getBranch()) {
      const entry = record(raw);
      if (entry.type === "custom" && entry.customType === STATE_KEY) {
        const data = record(entry.data);
        enabled = data.enabled !== false; showAll = data.showAll === true;
        showWorking = data.working !== false; showMcp = data.mcp !== false;
      }
    }
  };
  const wrapEditor = (context: ExtensionContext) => {
    const current = context.ui.getEditorComponent() as (EditorFactory & { [ORIGINAL_BORDERS]?: EditorFactory | null }) | undefined;
    const previous = current && ORIGINAL_BORDERS in current ? current[ORIGINAL_BORDERS] ?? undefined : current;
    const epoch = generation;
    const currentSession = () => active && epoch === generation;
    const factory: EditorFactory & { [ORIGINAL_BORDERS]?: EditorFactory | null } = (tui, theme, keybindings) => {
      // A foreign factory may itself capture the outgoing context.
      if (!currentSession()) return new CustomEditor(tui, theme, keybindings);
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      releaseInput?.();
      mainEditor = editor as FooterEditor; mainTui = tui; mainKeys = keybindings;
      bindCycleGuard();
      releaseInput = typeof editor.handleInput === "function" ? interactions.wrapEditor(mainEditor, tui) : undefined;
      // Pi installs native action-map entries just after this factory returns.
      queueMicrotask(() => {
        if (!currentSession()) return;
        try { refreshSnapshot?.(); } catch { discoveredActions = {}; }
      });
      borderGauge = drawGaugeOnBorders(editor,
        () => currentSession() && enabled && ctx ? ctx.getContextUsage()?.percent ?? null : null,
        () => currentSession() && ctx ? liftAccent(ctx.ui.theme) : undefined);
      return editor;
    };
    factory[ORIGINAL_BORDERS] = previous ?? null;
    releaseEditor = () => {
      if (context.ui.getEditorComponent() === factory) context.ui.setEditorComponent(previous);
    };
    context.ui.setEditorComponent(factory);
  };
  // `restoreEditor` is false on session_shutdown: Pi resets the editor itself
  // once the session ends, and putting back the previous factory would make Pi
  // build an editor from it at once, after its owners (pi-vim, pi-stash) have
  // already shut down. The next start unwraps our stale wrapper anyway.
  const stop = (restoreEditor = true) => {
    // Invalidate and detach everything locally before any cleanup can throw or
    // re-enter us. Saved callbacks must stay inert even after another start.
    const context = ctx, interval = timer, controller = codexAbort;
    const footer = releaseFooter, editor = releaseEditor, input = releaseInput, processes = [...children];
    const runInterval = workingTimer, mcpInterval = mcpTimer, shownWorking = workingShown;
    cycles.cancel("footer closed");
    releaseCycleGuard?.(); releaseCycleGuard = undefined;
    active = false; generation++; interactionGeneration++;
    ctx = undefined; requestRender = undefined;
    mainEditor = undefined; mainTui = undefined; mainKeys = undefined; releaseInput = undefined;
    refreshSnapshot = undefined; prepared = undefined; discoveredActions = {}; discoveredSystem1 = undefined;
    promptDepth = 0; blockedHolds = 0;
    timer = undefined; codexAbort = undefined; quotaFlight = undefined;
    workingTimer = undefined; mcpTimer = undefined; runStarted = 0; workingShown = undefined; working.reset();
    workingClaims.clear();
    mcp = undefined; mcpBusy = false;
    usageCollector.dispose(); usageCollector = createProviderUsageCollector();
    providerReadings.clear(); providerModels.clear(); providerIdentities.clear(); providerVariants.clear(); googleVariantMaps.clear(); providerSelectionEpoch++;

    releaseFooter = undefined; releaseEditor = undefined; footerControls = undefined;
    children.clear();

    const errors: unknown[] = [];
    const cleanup = (run: () => void) => { try { run(); } catch (error) { errors.push(error); } };
    if (interval !== undefined) cleanup(() => clearInterval(interval));
    if (runInterval !== undefined) cleanup(() => clearInterval(runInterval));
    if (mcpInterval !== undefined) cleanup(() => clearInterval(mcpInterval));
    if (context && shownWorking !== undefined) cleanup(() => context.ui.setWorkingMessage());
    if (controller) cleanup(() => controller.abort());
    for (const child of processes) cleanup(() => { child.kill(); });
    // Own disposal too: setFooter may throw before Pi calls dispose().
    if (input) cleanup(input);
    if (footer) cleanup(footer);
    if (context) cleanup(() => context.ui.setFooter(undefined));
    if (editor && restoreEditor) cleanup(editor);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Status footer cleanup failed");
  };
  pi.on("session_start", (_event, context) => {
    // Retiring UI can already be invalidated on replacement. stop() completes
    // local cleanup before reporting errors; those must not block a fresh start.
    try { stop(); } catch { /* Shutdown still reports teardown errors. */ }
    if (context.mode !== "tui") return;
    ctx = context; active = true;
    git = { ...emptyGit(), unavailable: true }; claude = undefined; claudeHeaders = undefined; codex = undefined; claudePiAccount = false; claudeCredentialHash = undefined; claudeReason = undefined;
    gitBusy = quotaBusy = codexBusy = false; gitChecked = quotaChecked = 0;
    phase = undefined;
    restorePreferences(context);
    account(); wrapEditor(context); attach();
    void updateGit(true); void updateQuota(true); void updateCodex(); void updateMcp(); void updateProviderUsage();
    const epoch = generation;
    mcpTimer = setInterval(() => { if (active && epoch === generation) void updateMcp(); }, MCP_TICK_MS);
    mcpTimer.unref();
    timer = setInterval(() => {
      if (!active || epoch !== generation) return;
      account(); void updateGit(); void updateQuota(); void updateCodex(); void updateProviderUsage(); requestRender?.();
    }, TICK_MS);
    timer.unref();
  });
  pi.on("mcp_servers_change", () => { void updateMcp(); });
  pi.on("before_agent_start", () => { if (active && showWorking && !runStarted) runStarted = Date.now(); });
  pi.on("turn_start", (_event, context) => {
    if (!active) return;
    ctx = context; phase = undefined; working.reset(); startRun(); syncWorking();
  });
  pi.on("message_update", (event, context) => {
    if (!active || !runStarted || !showWorking) return;
    ctx = context;
    const update = event.assistantMessageEvent;
    if (!update) return;
    working.apply(update); startRun(); syncWorking();
  });
  // Back to pi's idle text at once: no completion message lingers between turns.
  pi.on("turn_end", () => { if (active) endTurn(); });
  pi.on("agent_end", () => { if (active) endRun(); });
  pi.on("session_shutdown", () => stop(false));
  pi.on("model_select", (_event, context) => {
    if (!active) return;
    // Codex limits are per account, not per model; keep them across switches.
    ctx = context; phase = undefined;
    invalidateGoogleUsage();
    account(); void updateQuota(true); void updateCodex(); void updateProviderUsage(); requestRender?.();
  });
  pi.on("thinking_level_select", (_event, context) => {
    if (!active) return;
    if (context) ctx = context;
    invalidateGoogleUsage();
    void updateProviderUsage(); requestRender?.();
  });
  pi.on("session_info_changed", () => requestRender?.());
  pi.on("session_tree", (_event, context) => {
    if (!active) return;
    // Branch navigation keeps the editor but retires pending action ownership.
    // Do not invalidate the session's gauge/factory closures by bumping their epoch.
    interactionGeneration++;
    releaseInput?.();
    bindCycleGuard();
    releaseInput = mainEditor && mainTui && typeof mainEditor.handleInput === "function"
      ? interactions.wrapEditor(mainEditor, mainTui) : undefined;
    ctx = context; phase = undefined;
    invalidateGoogleUsage();
    restorePreferences(context); account(); attach(); void updateProviderUsage(); requestRender?.();
  });
  pi.on("message_end", (event, context) => {
    if (!active) return;
    ctx = context; account();
    if (event.message.role === "assistant") phase = event.message.stopReason === "error" ? "error" : undefined;
    requestRender?.();
  });
  pi.on("agent_settled", (_event, context) => {
    if (!active) return;
    ctx = context; account(); void updateGit(true); void updateQuota(); void updateCodex(); void updateMcp(); void updateProviderUsage();
    requestRender?.();
  });
  pi.on("ui_prompt_start", () => { if (active) { promptDepth++; phase = "waiting"; requestRender?.(); } });
  pi.on("ui_prompt_end", () => { if (active) { promptDepth = Math.max(0, promptDepth - 1); phase = promptDepth ? "waiting" : undefined; requestRender?.(); } });
  pi.on("session_before_compact", () => { if (active) { phase = "compacting"; requestRender?.(); } });
  pi.on("session_compact", () => { if (active) { phase = undefined; account(); requestRender?.(); } });
  pi.on("session_compact_failed", () => { if (active) { phase = "compact failed"; requestRender?.(); } });
  pi.on("after_provider_response", (event, context) => {
    if (!active) return;
    // This event carries headers but no authenticated physical identity. For
    // virtual routing, only an account-bound read can assign a quota window.
    const respondingProvider = context.model?.provider === "waterfall" ? undefined : context.model?.provider;
    if (respondingProvider === "anthropic") {
      // Only subscription responses carry these, so they describe Pi's own login.
      const quota = parseClaudeHeaders(event.headers, Date.now());
      if (quota) { claudePiAccount = true; claudeHeaders = quota; claude = mergeQuota(claude, quota); requestRender?.(); }
      return;
    }
    // Passive responses and stream events lack an authenticated account
    // identity. Revalidate through the shared reader instead of ingesting a
    // late event into a different account's row.
    if (respondingProvider === "openai-codex") void updateCodex();
  });
  pi.on("provider_stream_event", (event) => {
    if (!active || event.provider !== "openai-codex" || !codexRateLimitsEvent(event.data)) return;
    void updateCodex();
  });
  pi.registerCommand("status", {
    description: "Personal footer: on, native, all (show configured providers), details, working on|off, mcp on|off",
    getArgumentCompletions: (prefix) => ["on", "native", "all", "details", "working on", "working off", "mcp on", "mcp off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, context) => {
      if (context.mode !== "tui") return;
      const command = args.trim() || "details";
      if (command === "details") {
        const usage = context.getContextUsage();
        const providerIds = new Set(orderedProviders());
        const selectedRoute = context.model?.provider === "waterfall" ? queryWaterfall(pi.events)?.physical : undefined;
        const selectedPhysical = context.model?.provider === "waterfall" ? selectedRoute : context.model;
        const selectedThinking = selectedRoute?.thinkingLevel ?? pi.getThinkingLevel();
        if (selectedPhysical?.provider) providerIds.add(accountUsageProvider(selectedPhysical.provider));
        const accountDetails = [...providerIds].sort((a, b) => usageOrder(a) - usageOrder(b) || a.localeCompare(b)).flatMap((id) => {
          const selected = selectedPhysical && accountUsageProvider(selectedPhysical.provider) === id ? selectedPhysical.id : providerModels.get(id)?.id;
          const cached = cachedUsage(id, selected, expectedGoogleVariant(selected, selectedThinking));
          const reading = id === "google" && cached.state === "ready" && cached.windows.some((window) => window.model) && !selectGooglePool(cached, selected ?? "").length
            ? { ...cached, state: "unavailable" as const, windows: [], reason: "No quota has been observed for the selected Google model." } : cached;
          const prefix = `${id} (${reading.source}): `;
          const status = reading.state === "ready" ? reading.windows.map((window) =>
            `${window.pool && !window.label.startsWith(window.pool) ? `${window.pool} ` : ""}${window.model && window.scope === undefined ? `${window.model} ` : ""}${window.label}${window.scope ? ` [${window.scope}${window.variant ? `; ${window.variant}` : ""}]` : ""} ${window.used === undefined ? "unknown" : `${percent(window.used)} used`}${window.reset === undefined ? "" : `; reset ${new Date(window.reset).toISOString()}`}`).join("; ") || "windows unknown" :
            reading.state === "not-applicable" ? "no account quota" : `limits unavailable${reading.reason ? `: ${clean(reading.reason)}` : ""}`;
          return [`${prefix}${status}${reading.observedAt === undefined ? "" : `; observed ${new Date(reading.observedAt).toISOString()}`}${reading.detailsUrl ? `; ${reading.detailsUrl}` : ""}`];
        });
        context.ui.notify([
          `Model: ${context.model?.provider ?? "unknown"}/${context.model?.id ?? "unknown"}${context.model?.provider === "waterfall" && selectedPhysical ? ` → ${selectedPhysical.provider}/${selectedPhysical.id}` : ""}; reasoning: ${pi.getThinkingLevel()}.`,
          `Context: ${usage?.tokens == null ? "unknown" : tokens(usage.tokens)} of ${tokens(usage?.contextWindow ?? context.model?.contextWindow ?? 0)} tokens; ${usage?.percent == null ? "usage unknown" : `${percent(usage.percent)} used`}. This is Pi's estimate.`,
          `Cache reuse: ${cacheHit === undefined ? "not measured" : percent(cacheHit)} of the latest measured prompt on this branch/model.`,
          `Permission prompts: ${absorbStatuses(liveStatuses?.() ?? new Map(), { claudeRow: false }).permissionPrompts ?? "unknown"}.`,
          `Estimated session cost: ${money(totals.cost)} across recorded assistant, tool, summary and warming usage on all branches. This is not an invoice.`,
          `Recorded tokens: ${tokens(totals.input)} input, ${tokens(totals.output)} output, ${tokens(totals.cacheRead)} cache reads, ${tokens(totals.cacheWrite)} cache writes.`,
          git.unavailable ? "Git status: git unavailable." : git.notRepository ? "Git status: outside a Git repository." : !git.branch ? "Git status: git unavailable." : `Git status: ${git.changed} changed paths; ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked, ${git.conflicts} conflicts (counts can overlap). ${git.branch.startsWith("detached:") ? "" : git.upstreamMissing ? "Upstream: upstream missing (" + git.upstream + "; cached ref unavailable, no fetch)." : `Upstream: ${git.upstream ?? "no upstream"}; ${git.ahead} ahead, ${git.behind} behind (cached, no fetch).`}`,
          `Tracked Git changes: ${git.added} lines added, ${git.removed} removed. Session age: ${duration(Date.now() - totals.started)}; compactions: ${totals.compactions}.`,
          "OAuth identifies the authentication method, not guaranteed subscription billing. Git diff covers all uncommitted tracked changes, not just this agent.",
          "Claude acct comes from Anthropic's usage endpoint (as Claude Code /status) using Pi's own Claude login, refreshed every 5m and by each response's limit headers; without a Pi subscription login, from Claude Code's account (which can differ). Values are percent used; stale means >10m old or reset due.",
          "Codex account comes from ChatGPT's usage endpoint using Pi's separate openai-codex login; shared account readings refresh every 5m. OpenAI sessions use this account row without changing the selected inference provider.",
          "Provider limits: subscription allowance is distinct from API throttles, balances and cost. Google local OAuth reads separate shared Gemini 5h/weekly, Argon weekly and exact reasoning-variant quotas; all bind Argon, the only automatic Google waterfall candidate. Vault custody has no quota capability. Muse CLI usage --json supplies signed-in subscription windows when the validated allowance schema is present.",
          ...accountDetails,
          `Working row: ${showWorking ? "on" : "off"} (streamed output tokens, estimated as chars/4 until the provider reports a count, and elapsed time after ${SHOW_TIMER_AFTER_MS / 1000}s). MCP chip: ${showMcp ? "on" : "off"} (built-in MCP servers with non-hidden tools over servers enabled in mcp.json; approximate, and absent when another extension publishes an mcp status).`,
          `Controls: ${JSON.stringify({ ...interactions.describe(), ...footerControls?.describe(), settingsCycle: cycles.snapshot() ? { phase: cycles.snapshot()!.phase, keys: cycles.snapshot()!.settings.map(setting => setting.key), input: cycles.inputStatus() } : undefined })}. This in-memory diagnostic records only the last pointer event, not text or account data.`,
          "/status on: active provider only; /status all: also show configured remote providers (at most two rows, remaining sources in details); /status native: restore Pi footer; /status working on|off, /status mcp on|off. Choices survive reload/resume in this session.",
        ].join("\n"), "info");
        return;
      }
      const toggle = /^(working|mcp) (on|off)$/.exec(command);
      if (toggle) {
        ctx = context;
        const on = toggle[2] === "on";
        if (toggle[1] === "working") { showWorking = on; if (!on) endRun(); }
        else { showMcp = on; if (on) void updateMcp(); }
        pi.appendEntry(STATE_KEY, { enabled, showAll, working: showWorking, mcp: showMcp });
        requestRender?.();
        context.ui.notify(`${toggle[1] === "working" ? "Working row" : "MCP chip"} ${on ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (!["on", "native", "all"].includes(command)) { context.ui.notify("Usage: /status on|native|all|details|working on|off|mcp on|off", "warning"); return; }
      ctx = context; enabled = command !== "native"; showAll = command === "all";
      pi.appendEntry(STATE_KEY, { enabled, showAll, working: showWorking, mcp: showMcp });
      attach(); if (enabled) { void updateGit(true); void updateQuota(true); void updateCodex(); void updateProviderUsage(); }
      context.ui.notify(enabled ? "Custom footer enabled" : "Native footer restored", "info");
    },
  });
}

/** The session name to show: one you set, not pi-recap's automatic one. */
export function ownName(name: string | undefined, recapName: string | undefined): string | undefined {
  return name && name !== recapName ? name : undefined;
}
