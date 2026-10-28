// A display-only footer. No model requests or prompt modifications; the editor
// is kept (whichever one other extensions installed) and only its two border
// lines are redrawn to carry the context gauge. Credentials are sent only to their own
// provider's usage endpoint: Pi's Codex OAuth token (from Pi's model registry,
// to ChatGPT's usage endpoint, as Codex CLI's /status) and Pi's Anthropic OAuth
// token (from Pi's model registry, to Anthropic's OAuth usage endpoint, as Claude
// Code's /status). When Pi has no Anthropic subscription login, Claude Code's
// OAuth token (Keychain or ~/.claude/.credentials.json) is used instead, and
// without that the usage JSON comes from $PI_STATUS_FOOTER_CLAUDE_USAGE_CMD when
// set. Changes take effect with /reload.
import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { builtinMcpOwnsCommand, connectedMcpServers, countMcp, McpConfigReader, MCP_STATUS_KEY, type McpCount } from "./mcp.ts";
import { SHOW_TIMER_AFTER_MS, WORKING_REFRESH_MS, WORKING_STATS_CHANNEL, workingMessage, WorkingStats, workingStatsService, type WorkingStatsRequest } from "./working.ts";
import { WORKING_MESSAGE_EVENT, type WorkingMessageClaim } from "./working-message.ts";
import { SESSION_CHROME_CHANNEL, type SessionChromeOverrides, type SessionChromeRequest } from "./session-chrome.ts";

export * from "./mcp.ts";
export * from "./working.ts";
export * from "./session-chrome.ts";

const STATE_KEY = "personal-status-footer";
const QUOTA_STALE_MS = 10 * 60_000;
const GIT_TTL_MS = 3_000;
const TICK_MS = 15_000;
// Built-in MCP exposes no status; its tools and mcp.json are polled instead.
const MCP_TICK_MS = 5_000;
// Codex CLI's own /status source. Hardcoded so the token never follows a custom
// provider baseUrl anywhere else.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_TTL_MS = 5 * 60_000;
const CODEX_ACTIVE_TTL_MS = 60_000;
const CODEX_JWT_CLAIM = "https://api.openai.com/auth";
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
export interface QuotaWindow { label: string; used: number; reset?: number }
export interface Quota {
  source: string; updated: number; windows: QuotaWindow[];
  extra?: { enabled: boolean; used?: number; limit?: number; currency?: string };
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
export interface Snapshot {
  cwd: string; model: string; provider: string; thinking?: string; oauth: boolean;
  sessionName?: string; phase?: string; queued: boolean;
  context: { tokens: number | null; contextWindow: number; percent: number | null };
  totals: Totals; cacheHit?: number; git: GitInfo;
  quotas: Quota[]; unavailableQuota?: string; statuses: string[]; now: number;
  /** Folded in from companion extensions' statuses when they are installed. */
  mode?: PermissionModeStatus;
  autoEffort?: boolean; autoEffortDetail?: string; lean?: string; cache?: string; extraBilled?: number;
  /** A prompt stashed by @saadjs/pi-stash; text is its content when readable. */
  stash?: { text?: string };
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

/** The permission mode (pi-tool-gate, or pi-plan-mode alone), as Claude Code labels it. */
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
export function parseModeStatus(text: string): PermissionModeStatus | undefined {
  const match = /^(⏸|⏵⏵) (chat mode|manual mode|accept edits|plan mode|auto mode|yolo mode|bypass permissions) on(?: \((.+) to cycle\))?$/u.exec(text);
  if (!match) return undefined;
  // ⏸ is one cell and ⏵⏵ two; the footer draws one same-width icon for either.
  const glyph = match[1] === "⏸" ? ICONS.paused : ICONS.running;
  return { kind: MODE_KINDS[match[2]], label: `${glyph} ${match[2]} on`, ...(match[3] ? { key: match[3] } : {}) };
}

export interface AbsorbedStatuses { mode?: PermissionModeStatus; autoEffort: boolean; autoEffortDetail?: string; lean?: string; cache?: string; extraBilled?: number; stashed?: boolean; marimo?: MarimoStatus[]; lens?: LensStatus; bg?: BgItem[]; pressure?: PressureItem[]; /** Another extension owns the `mcp` status. */ mcp?: boolean; rest: string[] }
// Statuses from our own companion extensions that read better inside the footer
// rows they describe. Each is optional: absent extensions publish nothing, and a
// status whose text no longer matches the expected shape falls through to the
// generic status row unchanged, so a format change never hides a notice.
//   auto-effort       (pi-auto-effort)          "effort: high (auto ↑)" -> "reasoning high · auto ↑"
//                                               (also the older "(auto)", and ", limited: 5h 84%")
//   lean-context      (pi-cache-guard's Jev)    "lean: −12k tok"       -> context row
//   cache-guard       (pi-cache-guard)          "cache 4:12"           -> context row
//   anthropic-billing (anthropic-billing-guard) "extra usage x3"       -> Claude limits row
//   prompt-stash      (@saadjs/pi-stash)        "prompt stashed"       -> its own row under the editor
//   marimo, marimo-N  (pi-marimo)               "marimo: nb.py · ..."  -> a row per notebook under the context row
//   marimo-lens       (pi-marimo)               "lens: nb.py · S1 ..." -> its own row under the marimo row
//   bg                (pi-bg)                   "bg: tests 2:14 · ..." -> its own row under that
//   pressure          (pi-pressure)             "pressure: cpu 97 ↑ hot · ..." -> its own row under that
//   permission-mode   (pi-tool-gate, pi-plan-mode) "⏵⏵ auto mode on (shift+tab to cycle)" -> the model row
// Everything else (plan, gate, mcp, ...) stays in the status row.
export function absorbStatuses(statuses: ReadonlyMap<string, string>, options: { claudeRow: boolean }): AbsorbedStatuses {
  const result: AbsorbedStatuses = { autoEffort: false, rest: [] };
  const notebooks: Array<[number, MarimoStatus]> = [];
  for (const [key, text] of [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const plainText = clean(text);
    const effort = key === "auto-effort" ? /^effort: \S+ \(auto(?: ([^()]+))?\)$/.exec(plainText) : null;
    if (effort) {
      result.autoEffort = true;
      if (effort[1]) result.autoEffortDetail = effort[1];
      continue;
    }
    const lean = key === "lean-context" ? /^lean: (.+)$/.exec(plainText) : null;
    if (lean) { result.lean = lean[1]; continue; }
    const cache = key === "cache-guard" ? /^cache (\d+:\d\d|\d+h\d\dm|cold(?: \(model\)|\?)?)$/.exec(plainText) : null;
    if (cache) { result.cache = cache[1]; continue; }
    const billed = key === "anthropic-billing" ? /^extra usage x(\d+)$/.exec(plainText) : null;
    if (billed && options.claudeRow) { result.extraBilled = +billed[1]; continue; }
    if (key === "prompt-stash" && plainText === "prompt stashed") { result.stashed = true; continue; }
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
    const mode = key === "permission-mode" ? parseModeStatus(plainText) : undefined;
    if (mode) { result.mode = mode; continue; }
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
const money = (n: number): string => `$${n.toFixed(n > 0 && n < 0.01 ? 3 : 2)}`;
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

export function parseClaudeQuota(raw: unknown, updated: number): Quota {
  const data = record(raw);
  const windows: QuotaWindow[] = [];
  const add = (label: string, used: unknown, reset: unknown) => {
    const pct = number(used);
    if (pct !== undefined) windows.push({ label: clean(label), used: pct, reset: timestamp(reset) });
  };
  const limits = Array.isArray(data.limits) ? data.limits.map(record) : [];
  for (const [key, kind, label] of [["five_hour", "session", "5h"], ["seven_day", "weekly_all", "week"]]) {
    const flat = record(data[key]);
    const limit = limits.find((item) => item.kind === kind);
    add(label, flat.utilization ?? limit?.percent, flat.resets_at ?? limit?.resets_at);
  }
  for (const limit of limits) {
    if (limit.kind !== "weekly_scoped") continue;
    const scope = record(record(limit.scope).model);
    if (typeof scope.display_name === "string") add(scope.display_name, limit.percent, limit.resets_at);
  }
  // These API fields are percentage points. 0.5 means 0.5%, never guess 50%.
  const extra = record(data.extra_usage);
  const spend = record(data.spend);
  const used = record(spend.used), cap = record(spend.limit);
  const exponent = number(used.exponent) ?? number(extra.decimal_places) ?? 2;
  const capExponent = number(cap.exponent) ?? exponent;
  const usedMinor = number(used.amount_minor) ?? number(extra.used_credits);
  const capMinor = number(cap.amount_minor) ?? number(extra.monthly_limit);
  const enabled = typeof spend.enabled === "boolean" ? spend.enabled : extra.is_enabled;
  const currency = used.currency ?? extra.currency;
  const quota: Quota = { source: "Claude acct", updated, windows };
  if (typeof enabled === "boolean") quota.extra = {
    enabled,
    used: usedMinor === undefined ? undefined : usedMinor / 10 ** exponent,
    limit: capMinor === undefined ? undefined : capMinor / 10 ** capExponent,
    currency: typeof currency === "string" ? clean(currency) : undefined,
  };
  return quota;
}

export function codexWindowLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds === 604_800) return "week";
  const mins = Math.round(seconds / 60);
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  return mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}

// ChatGPT-plan usage (`GET /backend-api/wham/usage`). used_percent is already
// percentage points; reset_at is epoch seconds. Additional limits (named pools
// such as a reserve model) keep their API names, not a hardcoded list.
export function parseCodexUsage(raw: unknown, now: number): Quota {
  const data = record(raw);
  const windows: QuotaWindow[] = [];
  const addLimit = (limit: unknown, name?: string) => {
    const rl = record(limit);
    const found = ["primary", "secondary"]
      .map((key) => [key, record(rl[`${key}_window`])] as const)
      .filter(([, w]) => number(w.used_percent) !== undefined);
    for (const [key, w] of found) {
      const label = codexWindowLabel(number(w.limit_window_seconds), key);
      const at = number(w.reset_at), after = number(w.reset_after_seconds);
      let reset: number | undefined;
      if (at !== undefined) reset = at * 1000;
      else if (after !== undefined) reset = now + after * 1000;
      let shown = label;
      if (name) shown = found.length > 1 ? `${name} ${label}` : name;
      windows.push({ label: clean(shown), used: number(w.used_percent) ?? 0, reset });
    }
  };
  addLimit(data.rate_limit);
  const extras = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.map(record) : [];
  for (const item of extras) if (typeof item.limit_name === "string") addLimit(item.rate_limit, item.limit_name);
  return { source: "Codex acct", updated: now, windows };
}

// Passive, tied to the actual Pi request: on Pi's default WebSocket transport the
// Codex backend streams a `codex.rate_limits` event before each response. Its
// windows are `primary`/`secondary` with `window_minutes`; this rewrites it in the
// usage endpoint's shape, which is also what the shared cache stores.
export function codexRateLimitsEvent(data: unknown): RecordValue | undefined {
  const event = record(data);
  if (event.type !== "codex.rate_limits") return undefined;
  const limit = (raw: unknown) => {
    const rl = record(raw), out: RecordValue = {};
    for (const key of ["primary", "secondary"]) {
      const w = record(rl[`${key}_window`] ?? rl[key]);
      if (number(w.used_percent) === undefined) continue;
      const minutes = number(w.window_minutes);
      out[`${key}_window`] = { ...w, limit_window_seconds: w.limit_window_seconds ?? (minutes === undefined ? undefined : minutes * 60) };
    }
    return out;
  };
  const extras = Array.isArray(event.additional_rate_limits) ? event.additional_rate_limits.map(record) : [];
  return {
    rate_limit: limit(event.rate_limits ?? event.rate_limit),
    additional_rate_limits: extras.map((item) => ({ ...item, rate_limit: limit(item.rate_limit ?? item.rate_limits) })),
  };
}

// The ChatGPT account id Pi itself sends with Codex requests lives in the token.
export function codexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const id = record(record(payload)[CODEX_JWT_CLAIM]).chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch { return undefined; }
}

// Header snapshots cover only the main limit; keep named pools from the last
// usage fetch rather than dropping them whenever a response arrives.
export function mergeQuota(base: Quota | undefined, update: Quota): Quota {
  if (!base) return update;
  const fresh = new Map(update.windows.map((w) => [w.label, w]));
  const windows = base.windows.map((w) => fresh.get(w.label) ?? w);
  for (const w of update.windows) if (!base.windows.some((old) => old.label === w.label)) windows.push(w);
  return { ...base, updated: Math.max(base.updated, update.updated), windows };
}

// Passive, tied to the actual Pi request. Only the SSE transport exposes these
// headers; Pi's default WebSocket transport does not, hence the usage fetch.
export function parseCodexHeaders(headers: Record<string, string>, now: number): Quota | undefined {
  const values = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const windows: QuotaWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const raw = values[`x-codex-${key}-used-percent`];
    if (raw === undefined || raw.trim() === "") continue;
    const used = number(Number(raw));
    if (used === undefined) continue;
    const minsRaw = values[`x-codex-${key}-window-minutes`];
    const mins = minsRaw ? number(Number(minsRaw)) : undefined;
    const label = codexWindowLabel(mins === undefined ? undefined : mins * 60, key);
    const resetRaw = values[`x-codex-${key}-reset-at`];
    const afterRaw = values[`x-codex-${key}-reset-after-seconds`];
    const at = resetRaw ? number(Number(resetRaw)) : undefined;
    const after = afterRaw ? number(Number(afterRaw)) : undefined;
    let reset: number | undefined;
    if (after !== undefined) reset = now + after * 1000;
    if (at !== undefined) reset = at * 1000;
    windows.push({ label, used, reset });
  }
  return windows.length ? { source: "Codex acct", updated: now, windows } : undefined;
}

// Passive, tied to the actual Pi request: Anthropic sends subscription limits on
// every response, as Claude Code itself reads them. Unlike the usage endpoint,
// utilization here is a fraction (0.94 means 94%); resets are epoch seconds.
export function parseClaudeHeaders(headers: Record<string, string>, now: number): Quota | undefined {
  const values = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const windows: QuotaWindow[] = [];
  for (const [key, label] of [["5h", "5h"], ["7d", "week"]]) {
    const raw = values[`anthropic-ratelimit-unified-${key}-utilization`];
    if (raw === undefined || raw.trim() === "") continue;
    const fraction = number(Number(raw));
    if (fraction === undefined) continue;
    const resetRaw = values[`anthropic-ratelimit-unified-${key}-reset`];
    const at = resetRaw ? number(Number(resetRaw)) : undefined;
    windows.push({ label, used: fraction * 100, reset: at === undefined ? undefined : at * 1000 });
  }
  return windows.length ? { source: "Claude acct", updated: now, windows } : undefined;
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

interface Segment { text: string; short?: string; priority: number; separatorAfter?: string }
// Drop secondary statistics before shrinking the important gauges. Ordering
// remains stable; every final line is cell-bounded.
export function fitSegments(segments: Segment[], width: number, theme: Paint): string {
  const items = segments.filter((s) => s.text).map((s) => ({ ...s }));
  const separator = theme.fg("dim", " · ");
  const join = () => items.map((s, i) => s.text + (i < items.length - 1 ? s.separatorAfter ?? separator : "")).join("");
  for (const item of [...items].sort((a, b) => a.priority - b.priority)) {
    if (visibleWidth(join()) <= width || item.priority >= 50) break;
    if (items.length > 1) items.splice(items.indexOf(item), 1);
  }
  for (const item of [...items].sort((a, b) => a.priority - b.priority)) {
    if (visibleWidth(join()) <= width) break;
    if (item.short !== undefined) item.text = item.short;
  }
  while (visibleWidth(join()) > width && items.length > 1) {
    const least = Math.min(...items.map((s) => s.priority));
    items.splice(items.findIndex((s) => s.priority === least), 1);
  }
  return truncateToWidth(join(), Math.max(0, width), "…");
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
  stash: "\uf187", // archive
  project: "\uf07b", // folder
  branch: "\ue725", // git branch
  model: "\u{f06a9}", // robot (Material Design; the Font Awesome robot draws wider than its neighbors)
  reasoning: "\uee9c", // brain
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
  if (width <= 0) return [];
  const s = snapshot, g = s.git;
  // Shared inset, but natural spacing rather than padded label columns.
  const inset = width >= 60 ? 1 : 0;
  width -= inset * 2;
  const accountLabel = (text: string) => clean(text).replace(/^(Claude|Codex) acct$/, "$1");
  const label = (text: string) => `${theme.fg("muted", accountLabel(text))} `;
  const rows: string[] = [];
  const sep = theme.fg("dim", " · ");
  const row = (icon: string, render: (width: number) => string) => iconRow(icon, width, theme, render);
  if (s.stash) rows.push(row(ICONS.stash, (w) => stashRow(s.stash?.text, w, theme)));
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
  const auto = s.autoEffort ? `${sep}${theme.fg("dim", `auto${s.autoEffortDetail ? ` ${clean(s.autoEffortDetail)}` : ""}`)}` : "";
  const reasoning = s.thinking
    ? `${theme.fg("dim", `${ICONS.reasoning} `)}${theme.fg("muted", "reasoning")} ${theme.bold(theme.fg(thinkingColor(s.thinking), clean(s.thinking)))}${auto}`
    : "";
  const identity = `${model}${reasoning ? `${sep}${reasoning}` : ""}`;
  const modeColor = s.mode ? MODE_COLORS[s.mode.kind] : "muted";
  const modeText = s.mode ? theme.fg(modeColor, clean(s.mode.label)) : "";
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
      { text: project, priority: 60 },
      { text: branch, short: branchShort, priority: 40 },
      { text: identity, short: model, priority: 100 },
      { text: ctx, priority: 90 },
      { text: phaseText, priority: 120 },
    ], w, theme));
    return [" ".repeat(inset) + truncateToWidth(compact, width)];
  }
  rows.push(row(ICONS.model, (w) => fitSegments([
    { text: identity, short: model, priority: 100 },
    { text: phaseText, priority: 120 },
    { text: s.queued ? theme.fg("warning", "queued") : "", priority: 115 },
  ], w, theme)));
  // The permission mode gets its own row, and the gate's tally (published only in the
  // modes where Jev judges) follows it there. The cycle-key hint is not shown.
  const gateStatus = s.mode ? s.statuses.find((status) => /^Gate /.test(stripVTControlCharacters(status))) : undefined;
  const statuses = gateStatus ? s.statuses.filter((status) => status !== gateStatus) : s.statuses;
  if (s.mode) rows.push(row(ICONS.gate, (w) => fitSegments([
    { text: modeText, priority: 100 },
    { text: gateStatus ? gateStatus.replace(/[\r\n\t]/g, " ") : "", priority: 50 },
  ], w, theme)));

  const context = s.context.percent;
  const ctxValue = context === null ? theme.fg("muted", "unknown") : theme.bold(theme.fg(context < 70 ? "muted" : heat(context), percent(context)));
  const cache = s.cache ? clean(s.cache) : "";
  const cacheNote = cache === "cold (model)" ? "model changed" : cache === "cold?" ? "unconfirmed" : "";
  const cacheValue = cache.startsWith("cold") ? "❄" : cache;
  const ctxShort = `${theme.fg("muted", "Context")} ${ctxValue}`;
  const ctxLong = `${label("Context")}${ctxValue}${context === null ? "" : theme.fg("dim", " used")}${context === null || s.borderGauge ? "" : ` ${gauge(theme, context)}`}`;
  // What fills the context besides the conversation: MCP servers (our chip, or the
  // status of an extension that publishes its own, which already carries the plug)
  // and loaded skills. Each keeps its icon inline.
  const inline = (icon: string, text: string) => `${theme.fg("dim", icon)} ${text.replace(/[\r\n\t]/g, " ")}`;
  const mcpStatus = statuses.find((status) => stripVTControlCharacters(status).startsWith(`${ICONS.mcp} `));
  const mcpText = mcpStatus ? inline(ICONS.mcp, mcpStatus.replace(`${ICONS.mcp} `, "")) : s.mcp ? inline(ICONS.mcp, mcpChip(s.mcp, theme)) : "";
  const skillsText = s.skills ? inline(ICONS.skills, `${theme.fg("muted", "Skills")} ${s.skills}`) : "";
  rows.push(row(ICONS.context, (w) => fitSegments([
    { text: ctxLong, short: ctxShort, priority: 100 },
    { text: s.lean ? theme.fg("muted", `Lean ${clean(s.lean)}`) : "", priority: 20 },
    // Green denotes a warm cache; ❄ (cold) means the next prompt re-caches the whole history.
    { text: cache ? `${theme.fg("muted", "Cache")} ${theme.fg(cache.startsWith("cold") ? "warning" : "success", cacheValue)}${cacheNote ? `${sep}${theme.fg("dim", cacheNote)}` : ""}` : "", priority: 30 },
    { text: mcpText, priority: 25 },
    { text: skillsText, priority: 15 },
  ], w, theme)));
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

  // Subscription limits go last: they are usually the longest rows.

  for (const quota of s.quotas) {
    const age = Math.max(0, s.now - quota.updated);
    const expired = quota.windows.some((w) => w.reset !== undefined && w.reset <= s.now);
    const stale = age >= QUOTA_STALE_MS || expired;
    const windows = quota.windows.map((w): Segment => {
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
        const amount = extra.currency === "USD" ? money(extra.used) : `${extra.used.toFixed(2)} ${extra.currency ?? "?"}`;
        extraText += ` ${amount}${extra.limit === undefined ? "" : `/${extra.limit.toFixed(0)}`}`;
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
  return rows.map((row) => " ".repeat(inset) + truncateToWidth(row, width));
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
  /** The footer's data from pi (branch, extension statuses), for the session-chrome service. */
  let footerSource: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> } | undefined;
  let git: GitInfo = { ...emptyGit(), unavailable: true }, gitBusy = false, gitChecked = 0;
  let quotaBusy = false, quotaChecked = 0;
  let borderGauge = false;
  let codexBusy = false, codexChecked = 0, codexAbort: AbortController | undefined;
  let codexTimeout: ReturnType<typeof setTimeout> | undefined, codexAccount: string | undefined;
  let claude: Quota | undefined, claudeHeaders: Quota | undefined, codex: Quota | undefined;
  let phase: string | undefined;
  /** Open `herdr:blocked` holds: dialogs waiting on the user. */
  let blockedHolds = 0;
  let totals = collectTotals([], Date.now()), cacheHit: number | undefined;
  const children = new Set<ChildProcess>();
  const home = homedir();
  const cacheDir = process.env.CLAUDE_STATUSLINE_CACHE_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "claude-statusline");
  // Claude Code's login, shared with its status line; Pi's login (one per machine) separately.
  const cacheFile = path.join(cacheDir, "oauth-usage.json");
  const piCacheFile = path.join(cacheDir, "pi-oauth-usage.json");
  const footerCacheDir = path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "pi-status-footer");

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
  // Refresh a Claude usage cache when stale. Claude Code's login uses the same
  // file and lock directory as its status line, so however many harnesses are
  // open, one fetches; Pi's login gets its own file and lock.
  const refreshClaudeCache = async (file: string, piToken?: string) => {
    try { if (Date.now() - (await stat(file)).mtimeMs < CLAUDE_TTL_MS) return; } catch { /* no cache yet */ }
    const lock = path.join(path.dirname(file), piToken ? ".pi-fetch.lock" : ".fetch.lock");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      try { if (Date.now() - (await stat(lock)).mtimeMs > CLAUDE_LOCK_STALE_MS) await rmdir(lock); } catch { /* no lock */ }
      await mkdir(lock);
    } catch { return; } // someone else is fetching
    try {
      const token = piToken ?? await claudeToken();
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
          "User-Agent": "claude-code/2.1.0",
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
    cacheHit = latestCacheHit(ctx.sessionManager.getBranch(), ctx.model?.provider ?? "", ctx.model?.id ?? "");
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
  const updateQuota = async (force = false) => {
    if (!active || !ctx || quotaBusy || (!force && Date.now() - quotaChecked < 60_000)) return;
    quotaBusy = true; quotaChecked = Date.now();
    const epoch = generation, context = ctx;
    try {
      if (context.model?.provider !== "anthropic" && !showAll) return;
      // Prefer Pi's own login: it is the account this session bills.
      const piToken = await piClaudeToken(context);
      if (!active || epoch !== generation) return;
      const file = piToken ? piCacheFile : cacheFile;
      await refreshClaudeCache(file, piToken);
      try {
        const [text, meta] = await Promise.all([readFile(file, "utf8"), stat(file)]);
        const parsed = parseClaudeQuota(JSON.parse(text), meta.mtimeMs);
        if (active && epoch === generation && parsed.windows.length) {
          // Response headers newer than the cache update its main windows.
          claude = piToken && claudeHeaders && claudeHeaders.updated > parsed.updated ? mergeQuota(parsed, claudeHeaders) : parsed;
        }
      } catch { /* Keep last good snapshot; its timestamp makes staleness visible. */ }
      if (active && epoch === generation) requestRender?.();
    } finally { if (epoch === generation) quotaBusy = false; }
  };
  // One reading per ChatGPT account, shared by every Pi session: whoever has the
  // freshest (a usage fetch or a streamed event) writes it, the rest read it.
  const codexFile = (account: string) => path.join(footerCacheDir, `codex-usage-${account.replace(/[^\w.-]/g, "_")}.json`);
  const readCodexCache = async (account: string): Promise<{ updated: number; usage: RecordValue } | undefined> => {
    try {
      const data = record(JSON.parse(await readFile(codexFile(account), "utf8")));
      const updated = number(data.updated);
      return updated === undefined ? undefined : { updated, usage: record(data.usage) };
    } catch { return undefined; }
  };
  const writeCodexCache = async (account: string, updated: number, usage: RecordValue) => {
    try {
      // A streamed event carries no named pools; keep those from the last fetch.
      const pools = Array.isArray(usage.additional_rate_limits) && usage.additional_rate_limits.length ? undefined
        : (await readCodexCache(account))?.usage.additional_rate_limits;
      const file = codexFile(account), temporary = `${file}.${process.pid}.tmp`;
      await mkdir(footerCacheDir, { recursive: true });
      await writeFile(temporary, JSON.stringify({ updated, usage: pools ? { ...usage, additional_rate_limits: pools } : usage }));
      await rename(temporary, file);
    } catch { /* Sharing is best-effort; this session keeps its reading. */ }
  };
  const applyCodex = (parsed: Quota) => {
    if (!parsed.windows.length || (codex && codex.updated >= parsed.updated)) return;
    codex = mergeQuota(codex, parsed); requestRender?.();
  };
  // Same OAuth token and account Pi sends with each Codex request; Pi's registry
  // refreshes it. A non-JWT key (no ChatGPT account) simply yields no reading.
  const updateCodex = async (maxAge = CODEX_TTL_MS) => {
    if (!active || !ctx || codexBusy || Date.now() - codexChecked < maxAge) return;
    if (ctx.model?.provider !== "openai-codex" && !showAll) return;
    codexBusy = true; codexChecked = Date.now();
    const epoch = generation, controller = new AbortController();
    codexAbort = controller;
    const timeout = setTimeout(() => {
      if (active && epoch === generation && codexAbort === controller) controller.abort();
    }, 5_000);
    codexTimeout = timeout;
    try {
      const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
      const account = token ? codexAccountId(token) : undefined;
      if (!token || !account || !active || epoch !== generation) return;
      codexAccount = account;
      const cached = await readCodexCache(account);
      if (!active || epoch !== generation) return;
      if (cached) applyCodex(parseCodexUsage(cached.usage, cached.updated));
      // Even a forced refresh (startup, /status) trusts a reading under a minute old.
      if (cached && Date.now() - cached.updated < Math.max(maxAge, CODEX_ACTIVE_TTL_MS)) return;
      const lock = path.join(footerCacheDir, `.codex-fetch-${account.replace(/[^\w.-]/g, "_")}.lock`);
      try {
        await mkdir(footerCacheDir, { recursive: true });
        try { if (Date.now() - (await stat(lock)).mtimeMs > CLAUDE_LOCK_STALE_MS) await rmdir(lock); } catch { /* no lock */ }
        await mkdir(lock);
      } catch { return; } // another session is fetching; its result lands in the cache
      try {
        const response = await fetch(CODEX_USAGE_URL, {
          headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": account, originator: "pi", accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const usage = record(await response.json()), updated = Date.now();
        const parsed = parseCodexUsage(usage, updated);
        if (!parsed.windows.length) return;
        await writeCodexCache(account, updated, usage);
        if (active && epoch === generation) { codex = parsed; requestRender?.(); }
      } finally { await rmdir(lock).catch(() => undefined); }
    } catch { /* Keep last good snapshot; its timestamp makes staleness visible. */ } finally {
      clearTimeout(timeout);
      if (codexTimeout === timeout) codexTimeout = undefined;
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
          return renderFooter(snapshot(footerSource?.getGitBranch() ?? null, footerSource?.getExtensionStatuses() ?? new Map(), session), width, liftAccent(theme));
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
  /** Main's snapshot, or (with `session`) another session's in main's surroundings (session-chrome.ts). */
  const snapshot = (branch: string | null, statuses: ReadonlyMap<string, string>, session?: SessionChromeOverrides): Snapshot => {
    if (!ctx) throw new Error("Footer rendered outside its session lifecycle");
    const current = ctx;
    const provider = session ? session.provider : current.model?.provider ?? "no provider";
    const quotas: Quota[] = [];
    let unavailableQuota: string | undefined;
    if (provider === "anthropic" || showAll) {
      if (claude) quotas.push(claude); else unavailableQuota = "Claude acct";
    }
    if (provider === "openai-codex") {
      if (codex) quotas.unshift(codex);
      else unavailableQuota = unavailableQuota ? `${unavailableQuota} / Codex acct` : "Codex acct";
    } else if (showAll && codex) quotas.push(codex);
    const absorbed = absorbStatuses(statuses, { claudeRow: quotas.some((q) => q.source === "Claude acct") });
    const main: Snapshot = {
      cwd: current.cwd, provider, model: current.model?.id ?? "no model",
      thinking: current.model?.reasoning ? pi.getThinkingLevel() : undefined,
      oauth: current.model ? current.modelRegistry.isUsingOAuth(current.model) : false,
      sessionName: ownName(pi.getSessionName(), recapName), phase, queued: current.hasPendingMessages(),
      context: current.getContextUsage() ?? { tokens: null, contextWindow: current.model?.contextWindow ?? 0, percent: null },
      totals, cacheHit, git: { ...git, branch: git.branch ?? branch ?? undefined },
      quotas, unavailableQuota,
      statuses: absorbed.rest, mode: absorbed.mode, autoEffort: absorbed.autoEffort, autoEffortDetail: absorbed.autoEffortDetail, lean: absorbed.lean, cache: absorbed.cache, extraBilled: absorbed.extraBilled,
      stash: absorbed.stashed ? { text: stashedPrompt() } : undefined,
      marimo: absorbed.marimo, lens: absorbed.lens, bg: absorbed.bg, pressure: absorbed.pressure, borderGauge, compact: blockedHolds > 0,
      // Yield to an extension that publishes its own mcp status (pi-mcp-adapter).
      mcp: showMcp && !absorbed.mcp ? mcp : undefined,
      skills: pi.getCommands().filter((command) => command.source === "skill").length,
      now: Date.now(),
    };
    if (!session) return main;
    const model = current.modelRegistry.find?.(session.provider, session.model);
    return {
      ...main,
      cwd: session.cwd, provider: session.provider, model: session.model, thinking: session.thinking,
      oauth: model ? current.modelRegistry.isUsingOAuth(model) : false,
      sessionName: session.sessionName, phase: session.phase, queued: session.queued === true,
      context: session.context, totals: session.totals, cacheHit: undefined,
      // Main's git status describes main's directory only.
      git: path.resolve(session.cwd) === path.resolve(current.cwd) ? main.git : { ...emptyGit(), unavailable: true },
      borderGauge: session.borderGauge === true,
    };
  };
  const attach = () => {
    if (!active || !ctx) return;
    if (!enabled) { ctx.ui.setFooter(undefined); return; }
    const epoch = generation;
    ctx.ui.setFooter((tui, theme, footerData) => {
      if (!active || epoch !== generation) return { render: () => [], invalidate() {} };
      let disposed = false;
      const current = () => !disposed && active && epoch === generation;
      const render = () => { if (current()) tui.requestRender(); };
      const unsubscribe = footerData.onBranchChange(() => { if (current()) { void updateGit(true); render(); } });
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (requestRender === render) requestRender = undefined;
        if (releaseFooter === dispose) releaseFooter = undefined;
        if (footerSource === footerData) footerSource = undefined;
        unsubscribe();
      };
      requestRender = render;
      releaseFooter = dispose;
      footerSource = footerData;
      return {
        render(width: number) { return current() ? renderFooter(snapshot(footerData.getGitBranch(), footerData.getExtensionStatuses()), width, liftAccent(theme)) : []; },
        invalidate() {}, // Colors are evaluated on every render, never cached.
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
    const context = ctx, interval = timer, timeout = codexTimeout, controller = codexAbort;
    const footer = releaseFooter, editor = releaseEditor, processes = [...children];
    const runInterval = workingTimer, mcpInterval = mcpTimer, shownWorking = workingShown;
    active = false; generation++;
    ctx = undefined; requestRender = undefined;
    timer = undefined; codexTimeout = undefined; codexAbort = undefined;
    workingTimer = undefined; mcpTimer = undefined; runStarted = 0; workingShown = undefined; working.reset();
    workingClaims.clear();
    mcp = undefined; mcpBusy = false;
    releaseFooter = undefined; releaseEditor = undefined;
    children.clear();

    const errors: unknown[] = [];
    const cleanup = (run: () => void) => { try { run(); } catch (error) { errors.push(error); } };
    if (interval !== undefined) cleanup(() => clearInterval(interval));
    if (runInterval !== undefined) cleanup(() => clearInterval(runInterval));
    if (mcpInterval !== undefined) cleanup(() => clearInterval(mcpInterval));
    if (timeout !== undefined) cleanup(() => clearTimeout(timeout));
    if (context && shownWorking !== undefined) cleanup(() => context.ui.setWorkingMessage());
    if (controller) cleanup(() => controller.abort());
    for (const child of processes) cleanup(() => { child.kill(); });
    // Own disposal too: setFooter may throw before Pi calls dispose().
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
    git = { ...emptyGit(), unavailable: true }; claude = undefined; claudeHeaders = undefined; codex = undefined; codexAccount = undefined;
    gitBusy = quotaBusy = codexBusy = false; gitChecked = quotaChecked = codexChecked = 0;
    phase = undefined;
    restorePreferences(context);
    account(); wrapEditor(context); attach();
    void updateGit(true); void updateQuota(true); void updateCodex(0); void updateMcp();
    const epoch = generation;
    mcpTimer = setInterval(() => { if (active && epoch === generation) void updateMcp(); }, MCP_TICK_MS);
    mcpTimer.unref();
    timer = setInterval(() => {
      if (!active || epoch !== generation) return;
      account(); void updateGit(); void updateQuota(); void updateCodex(); requestRender?.();
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
    account(); void updateQuota(true); void updateCodex(CODEX_ACTIVE_TTL_MS); requestRender?.();
  });
  pi.on("thinking_level_select", () => requestRender?.());
  pi.on("session_info_changed", () => requestRender?.());
  pi.on("session_tree", (_event, context) => {
    if (!active) return;
    ctx = context; phase = undefined;
    restorePreferences(context); account(); attach(); requestRender?.();
  });
  pi.on("message_end", (event, context) => {
    if (!active) return;
    ctx = context; account();
    if (event.message.role === "assistant") phase = event.message.stopReason === "error" ? "error" : undefined;
    requestRender?.();
  });
  pi.on("agent_settled", (_event, context) => {
    if (!active) return;
    ctx = context; account(); void updateGit(true); void updateQuota(); void updateCodex(CODEX_ACTIVE_TTL_MS); void updateMcp();
    requestRender?.();
  });
  pi.on("ui_prompt_start", () => { if (active) { phase = "waiting"; requestRender?.(); } });
  pi.on("ui_prompt_end", () => { if (active) { phase = undefined; requestRender?.(); } });
  pi.on("session_before_compact", () => { if (active) { phase = "compacting"; requestRender?.(); } });
  pi.on("session_compact", () => { if (active) { phase = undefined; account(); requestRender?.(); } });
  pi.on("session_compact_failed", () => { if (active) { phase = "compact failed"; requestRender?.(); } });
  pi.on("after_provider_response", (event, context) => {
    if (!active) return;
    if (context.model?.provider === "anthropic") {
      // Only subscription responses carry these, so they describe Pi's own login.
      const quota = parseClaudeHeaders(event.headers, Date.now());
      if (quota) { claudeHeaders = quota; claude = mergeQuota(claude, quota); requestRender?.(); }
      return;
    }
    if (context.model?.provider !== "openai-codex") return;
    const quota = parseCodexHeaders(event.headers, Date.now());
    if (quota) { codex = mergeQuota(codex, quota); requestRender?.(); }
  });
  // Runs for every streamed event, so it must stay cheap until the type matches.
  pi.on("provider_stream_event", (event) => {
    if (!active || event.provider !== "openai-codex") return;
    const usage = codexRateLimitsEvent(event.data);
    if (!usage) return;
    const updated = Date.now(), parsed = parseCodexUsage(usage, updated);
    if (!parsed.windows.length) return;
    codex = mergeQuota(codex, parsed); requestRender?.();
    if (codexAccount) void writeCodexCache(codexAccount, updated, usage);
  });
  pi.registerCommand("status", {
    description: "Personal footer: on, native, all (also show the other subscription account), details, working on|off, mcp on|off",
    getArgumentCompletions: (prefix) => ["on", "native", "all", "details", "working on", "working off", "mcp on", "mcp off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, context) => {
      if (context.mode !== "tui") return;
      const command = args.trim() || "details";
      if (command === "details") {
        const usage = context.getContextUsage();
        context.ui.notify([
          `Model: ${context.model?.provider ?? "unknown"}/${context.model?.id ?? "unknown"}; reasoning: ${pi.getThinkingLevel()}.`,
          `Context: ${usage?.tokens == null ? "unknown" : tokens(usage.tokens)} of ${tokens(usage?.contextWindow ?? context.model?.contextWindow ?? 0)} tokens; ${usage?.percent == null ? "usage unknown" : `${percent(usage.percent)} used`}. This is Pi's estimate.`,
          `Cache reuse: ${cacheHit === undefined ? "not measured" : percent(cacheHit)} of the latest measured prompt on this branch/model.`,
          `Estimated session cost: ${money(totals.cost)} across recorded assistant, tool, summary and warming usage on all branches. This is not an invoice.`,
          `Recorded tokens: ${tokens(totals.input)} input, ${tokens(totals.output)} output, ${tokens(totals.cacheRead)} cache reads, ${tokens(totals.cacheWrite)} cache writes.`,
          git.unavailable ? "Git status: git unavailable." : git.notRepository ? "Git status: outside a Git repository." : !git.branch ? "Git status: git unavailable." : `Git status: ${git.changed} changed paths; ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked, ${git.conflicts} conflicts (counts can overlap). ${git.branch.startsWith("detached:") ? "" : git.upstreamMissing ? "Upstream: upstream missing (" + git.upstream + "; cached ref unavailable, no fetch)." : `Upstream: ${git.upstream ?? "no upstream"}; ${git.ahead} ahead, ${git.behind} behind (cached, no fetch).`}`,
          `Tracked Git changes: ${git.added} lines added, ${git.removed} removed. Session age: ${duration(Date.now() - totals.started)}; compactions: ${totals.compactions}.`,
          "OAuth identifies the authentication method, not guaranteed subscription billing. Git diff covers all uncommitted tracked changes, not just this agent.",
          "Claude acct comes from Anthropic's usage endpoint (as Claude Code /status) using Pi's own Claude login, refreshed every 5m and by each response's limit headers; without a Pi subscription login, from Claude Code's account (which can differ). Values are percent used; stale means >10m old or reset due.",
          "Codex acct comes from ChatGPT's usage endpoint (as Codex CLI /status) using Pi's own Codex login, shared by all Pi sessions on the account; refreshed every 5m, or 1m around turns. Each request's streamed rate-limit event (or SSE headers) updates it in between.",
          `Working row: ${showWorking ? "on" : "off"} (streamed output tokens, estimated as chars/4 until the provider reports a count, and elapsed time after ${SHOW_TIMER_AFTER_MS / 1000}s). MCP chip: ${showMcp ? "on" : "off"} (built-in MCP servers with non-hidden tools over servers enabled in mcp.json; approximate, and absent when another extension publishes an mcp status).`,
          "/status on: active provider only; /status all: also show the other subscription account; /status native: restore Pi footer; /status working on|off, /status mcp on|off. Choices survive reload/resume in this session.",
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
      attach(); if (enabled) { void updateGit(true); void updateQuota(true); void updateCodex(0); }
      context.ui.notify(enabled ? "Custom footer enabled" : "Native footer restored", "info");
    },
  });
}

/** The session name to show: one you set, not pi-recap's automatic one. */
export function ownName(name: string | undefined, recapName: string | undefined): string | undefined {
  return name && name !== recapName ? name : undefined;
}
