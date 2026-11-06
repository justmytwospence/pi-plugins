import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ProviderUsage, ExtraUsage, AccountAccess } from "./provider-usage.ts";

type RecordValue = Record<string, unknown>;
export interface QuotaWindow { label: string; used: number; reset?: number; observedAt?: number }
export interface Quota {
  source: string; updated: number; windows: QuotaWindow[];
  extra?: ExtraUsage; access?: AccountAccess;
}
/** The small registry surface needed in TUI, print and RPC contexts alike. */
export interface AccountUsageContext {
  modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
}
export interface AccountUsageOptions { signal?: AbortSignal }

const CODEX_JWT_CLAIM = "https://api.openai.com/auth";
const invalidApplicable = Symbol("invalid applicable Claude quota");
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const clean = (value: string): string => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
const bool = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
function sanitizeExtra(value: unknown): ExtraUsage | undefined {
  const item = record(value);
  if (typeof item.enabled !== "boolean") return undefined;
  const currency = typeof item.currency === "string" && /^[A-Z]{3}$/.test(item.currency) ? item.currency : undefined;
  const out: ExtraUsage = { enabled: item.enabled };
  if (number(item.used) !== undefined) out.used = number(item.used);
  if (number(item.limit) !== undefined) out.limit = number(item.limit);
  if (currency) out.currency = currency;
  if (bool(item.capReached) !== undefined) out.capReached = bool(item.capReached);
  return out;
}
function sanitizeAccess(value: unknown): AccountAccess | undefined {
  const item = record(value), credits = record(item.credits);
  const out: AccountAccess = {};
  if (bool(item.allowed) !== undefined) out.allowed = bool(item.allowed);
  if (bool(item.limitReached) !== undefined) out.limitReached = bool(item.limitReached);
  if (number(credits.balance) !== undefined && typeof credits.unlimited === "boolean")
    out.credits = { balance: number(credits.balance)!, unlimited: credits.unlimited };
  return Object.keys(out).length ? out : undefined;
}
const timestamp = (value: unknown): number | undefined => {
  const result = typeof value === "string" ? Date.parse(value) : number(value);
  return result !== undefined && Number.isFinite(result) ? result : undefined;
};

export function parseClaudeQuota(raw: unknown, updated: number): Quota & { [invalidApplicable]?: true } {
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
  let malformedApplicable = Object.hasOwn(data, "limits") && !Array.isArray(data.limits);
  // A null field means the plan has no such window (or it has not started), not a malformed one.
  if (data.seven_day_opus !== undefined && data.seven_day_opus !== null) {
    const opus = record(data.seven_day_opus);
    if (number(opus.utilization) === undefined || number(opus.utilization)! > 100 || timestamp(opus.resets_at) === undefined)
      malformedApplicable = true;
    else add("Opus", opus.utilization, opus.resets_at);
  }
  for (const limit of limits) {
    if (limit.kind !== "weekly_scoped") continue;
    const name = record(record(limit.scope).model).display_name;
    if (typeof name !== "string" || !clean(name) || name !== clean(name) || number(limit.percent) === undefined || number(limit.percent)! > 100 || timestamp(limit.resets_at) === undefined)
      malformedApplicable = true;
    else add(name, limit.percent, limit.resets_at);
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
    ...(typeof extra.spend_limit_reached === "boolean" ? { capReached: extra.spend_limit_reached } : {}),
  };
  if (malformedApplicable) {
    quota.windows = [];
    return Object.assign(quota, { [invalidApplicable]: true as const });
  }
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
  const rl = record(data.rate_limit), credits = record(data.credits);
  const balance = typeof credits.balance === "string" && /^\d+(?:\.\d+)?$/.test(credits.balance) ? Number(credits.balance) : number(credits.balance);
  const access = sanitizeAccess({ allowed: rl.allowed, limitReached: rl.limit_reached,
    credits: credits.has_credits === true ? { balance, unlimited: credits.unlimited === true } : undefined });
  return { source: "Codex acct", updated: now, windows, ...(access ? { access } : {}) };
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
    if (typeof token !== "string" || token.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return undefined;
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = record(record(payload)[CODEX_JWT_CLAIM]).chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch { return undefined; }
}

// Header snapshots cover only the main limit; keep named pools from the last
// usage fetch rather than dropping them whenever a response arrives.
export function mergeQuota(base: Quota | undefined, update: Quota): Quota {
  const updates = update.windows.map(window => ({ ...window, observedAt: window.observedAt ?? update.updated }));
  if (!base || base.source !== update.source) return { ...update, windows: updates };
  const windows = base.windows.map(window => ({ ...window, observedAt: window.observedAt ?? base.updated }));
  for (const window of updates) {
    const index = windows.findIndex(old => old.label === window.label);
    if (index < 0) windows.push(window);
    else if (window.observedAt >= windows[index].observedAt!) windows[index] = window;
  }
  return { ...base, ...update, extra: update.extra ?? base.extra, access: update.access ?? base.access, updated: Math.max(base.updated, update.updated), windows };
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


const REFRESH_MS = 5 * 60_000;
const MAX_AGE_MS = 10 * 60_000;
const TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 2 * 60_000;
const MAX_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 32;
type Provider = "anthropic" | "openai-codex";
type Identity = { provider: Provider; token: string; digest: string };
type Flight = { promise: Promise<ProviderUsage>; controller: AbortController; subscribers: number };
const flights = new Map<string, Flight>();
const memory = new Map<string, ProviderUsage>();
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const source = (provider: Provider): string => provider === "anthropic" ? "Pi Anthropic subscription" : "Codex account (diagnostic only)";
const unavailable = (provider: Provider, reason: string): ProviderUsage =>
  ({ provider, source: source(provider), state: "unavailable", windows: [], reason });
const check = (signal: AbortSignal): void => { if (signal.aborted) throw new Error("Usage read cancelled"); };

/** Race even registry/transport implementations which do not honor cancellation. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Usage read cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(new Error("Usage read failed")); });
    if (signal.aborted) abort();
  });
}

async function identity(context: AccountUsageContext, provider: Provider, signal: AbortSignal): Promise<Identity | undefined> {
  check(signal);
  const token = await bounded(Promise.resolve().then(() => context.modelRegistry.getApiKeyForProvider(provider)), signal);
  check(signal);
  if (typeof token !== "string" || token.length > 32_768 || /[\s\x00-\x1f\x7f]/.test(token)) return undefined;
  if (provider === "anthropic") {
    // Never consult Claude Code, a shell command, an environment API key or a model baseUrl.
    return /^sk-ant-oat[A-Za-z0-9_-]+$/.test(token) ? { provider, token, digest: digest(token) } : undefined;
  }
  const account = codexAccountId(token);
  // Account IDs are also sent as HTTP headers. Reject malformed/injected values.
  return account && /^[A-Za-z0-9_.:-]{1,256}$/.test(account) ? { provider, token, digest: digest(account) } : undefined;
}

/** Persist only validated quota fields, never credentials or raw response bodies. */
function reading(quota: Quota, id: Identity): ProviderUsage | undefined {
  if (!quota.windows.length || quota.windows.length > 128) return undefined;
  const safeLabel = (label: string) => label.length > 0 && label.length <= 160 && label === clean(label) &&
    !label.includes(id.token) && !/(?:sk-ant-|sk-[A-Za-z0-9_-]{8}|Bearer\s|eyJ[A-Za-z0-9_-]*\.)/i.test(label);
  if (quota.windows.some(window => !safeLabel(window.label) || number(window.used) === undefined || window.used > 100)) return undefined;
  const extra = id.provider === "anthropic" ? sanitizeExtra(quota.extra) : undefined;
  const access = id.provider === "openai-codex" ? sanitizeAccess(quota.access) : undefined;
  return {
    provider: id.provider, source: source(id.provider), state: "ready", observedAt: quota.updated,
    ...(extra ? { extra } : {}), ...(access ? { access } : {}),
    windows: quota.windows.map(window => ({ label: window.label, used: window.used, reset: window.reset, observedAt: window.observedAt ?? quota.updated })),
    ...(id.provider === "openai-codex" ? { reason: "Diagnostic Codex quota only; applicability to modern OpenAI models is unverified." } : {}),
  };
}

function fresh(value: ProviderUsage | undefined, maxAge: number, now = Date.now()): boolean {
  if (!value || value.state !== "ready" || number(value.observedAt) === undefined ||
      value.observedAt! > now || now - value.observedAt! >= maxAge || !value.windows.length) return false;
  return value.windows.every(window => number(window.used) !== undefined && window.used! <= 100 &&
    number(window.observedAt) !== undefined && window.observedAt! <= now && now - window.observedAt! < maxAge &&
    number(window.reset) !== undefined && window.reset! > now);
}

const owner = (uid: number): boolean => typeof process.getuid !== "function" || uid === process.getuid();
async function cacheDirectory(signal: AbortSignal): Promise<string> {
  const configured = process.env.XDG_CACHE_HOME;
  const base = configured && path.isAbsolute(configured) ? configured : path.join(homedir(), ".cache");
  check(signal);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = path.join(await realpath(base), "pi-subscription-usage");
  check(signal);
  await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const meta = await lstat(root);
  if (!meta.isDirectory() || !owner(meta.uid) || (meta.mode & 0o077) !== 0) throw new Error("Unsafe usage cache");
  return root;
}

/** O_NOFOLLOW rejects symlinks; O_NONBLOCK prevents a substituted FIFO from hanging. */
async function readCache(file: string, id: Identity, signal: AbortSignal): Promise<ProviderUsage | undefined> {
  let handle;
  try {
    check(signal);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || !owner(before.uid) || (before.mode & 0o022) || before.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      check(signal);
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;
    const data = record(JSON.parse(buffer.subarray(0, length).toString("utf8")));
    if (data.version !== 1 || data.account !== id.digest || data.provider !== id.provider) return undefined;
    const windows = data.windows;
    if (!Array.isArray(windows) || windows.length > 128 || windows.some(window => {
      const item = record(window);
      return typeof item.label !== "string" || number(item.used) === undefined ||
        number(item.reset) === undefined || number(item.observedAt) === undefined;
    })) return undefined;
    const quota: Quota = { source: source(id.provider), updated: number(data.updated) ?? NaN,
      windows: windows.map(window => {
        const item = record(window);
        return { label: item.label as string, used: item.used as number, reset: item.reset as number, observedAt: item.observedAt as number };
      }), extra: sanitizeExtra(data.extra), access: sanitizeAccess(data.access) };
    return reading(quota, id);
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

async function writeCache(file: string, id: Identity, value: ProviderUsage, signal: AbortSignal): Promise<void> {
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    check(signal);
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, account: id.digest, provider: id.provider, updated: value.observedAt, windows: value.windows,
      ...(value.extra ? { extra: value.extra } : {}), ...(value.access ? { access: value.access } : {}) }));
    await handle.close(); handle = undefined;
    check(signal);
    await rename(temporary, file);
  } catch { /* Persistence is optional; a verified in-memory observation remains useful. */ }
  finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function pause(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Usage read cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 100);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A process-wide lease shared by all readers of this account's disk cache. */
async function lock(file: string, signal: AbortSignal): Promise<(() => Promise<void>) | undefined> {
  const directory = file + ".lock";
  try {
    check(signal);
    await mkdir(directory, { mode: 0o700 });
    const held = await lstat(directory);
    return async () => {
      try {
        const current = await lstat(directory);
        if (current.ino === held.ino && current.dev === held.dev && current.mtimeMs === held.mtimeMs) await rmdir(directory);
      } catch { /* Do not remove a replaced lease. */ }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const meta = await lstat(directory);
    if (!meta.isDirectory() || !owner(meta.uid) || (meta.mode & 0o077) !== 0) throw new Error("Unsafe usage lock");
    if (Date.now() - meta.mtimeMs > LOCK_STALE_MS) {
      const current = await lstat(directory);
      if (current.ino === meta.ino && current.mtimeMs === meta.mtimeMs) await rmdir(directory).catch(() => undefined);
    }
    return undefined;
  }
}

/**
 * The usage endpoint rejects or heavily throttles clients reporting an old Claude Code
 * release. Follow pi-anthropic-auth's override, else a recent release.
 */
export function claudeCodeUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION?.trim();
  return `claude-code/${configured && /^\d+\.\d+\.\d+$/.test(configured) ? configured : "2.1.284"}`;
}

/** Why the last fetch failed: status and Anthropic's error code only, never a body or credential. */
const failures = new Map<string, string>();
async function describeFailure(response: Response): Promise<string> {
  let code = "";
  try {
    const text = await response.clone().text();
    if (text.length <= MAX_BYTES) {
      const error = record(record(JSON.parse(text)).error);
      const detail = record(error.details).error_code ?? error.type;
      if (typeof detail === "string" && /^[a-z0-9_]{1,64}$/.test(detail)) code = ` (${detail})`;
    }
  } catch { /* Status alone. */ }
  return `The usage endpoint answered HTTP ${response.status}${code}.`;
}

async function fetchQuota(id: Identity, signal: AbortSignal): Promise<ProviderUsage | typeof invalidApplicable | undefined> {
  const anthropic = id.provider === "anthropic";
  failures.delete(id.digest);
  const response = await bounded(fetch(anthropic ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage", {
    method: "GET", redirect: "error", credentials: "omit", signal,
    headers: anthropic
      ? { Authorization: "Bearer " + id.token, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json", "User-Agent": claudeCodeUserAgent() }
      : { Authorization: "Bearer " + id.token, "chatgpt-account-id": codexAccountId(id.token)!, originator: "pi", accept: "application/json" },
  }), signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!response.ok || !response.body) {
      failures.set(id.digest, response.ok ? "The usage endpoint returned no body." : await bounded(describeFailure(response), signal));
      return undefined;
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BYTES)) return undefined;
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) return undefined;
      chunks.push(Buffer.from(part.value));
    }
    check(signal);
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
    catch { return anthropic ? invalidApplicable : undefined; }
    const now = Date.now();
    const quota = anthropic ? parseClaudeQuota(raw, now) : parseCodexUsage(raw, now);
    if (anthropic && invalidApplicable in quota) return invalidApplicable;
    const parsed = reading(quota, id);
    return anthropic && !parsed ? invalidApplicable : parsed;
  } finally {
    // Do not await an uncooperative transport's cancellation.
    if (reader) void reader.cancel().catch(() => undefined);
    else if (response.body) void response.body.cancel().catch(() => undefined);
  }
}

function remember(key: string, value: ProviderUsage): void {
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MAX_ACCOUNTS) memory.delete(memory.keys().next().value!);
}

async function collect(id: Identity, key: string, signal: AbortSignal): Promise<ProviderUsage> {
  let cached = memory.get(key);
  let file: string | undefined;
  try { file = path.join(await cacheDirectory(signal), id.provider + "-" + id.digest + ".json"); }
  catch { return unavailable(id.provider, "A secure account quota cache is unavailable."); }
  const disk = await readCache(file, id, signal);
  if (disk && (!cached || disk.observedAt! > cached.observedAt!)) cached = disk;
  if (cached && fresh(cached, REFRESH_MS)) return cached;
  let release: (() => Promise<void>) | undefined;
  try {
    // A contending process may have completed since our first read.
    while (!release) {
      check(signal);
      release = await lock(file, signal);
      const shared = await readCache(file, id, signal);
      if (shared && (!cached || shared.observedAt! > cached.observedAt!)) cached = shared;
      if (cached && fresh(cached, REFRESH_MS)) return cached;
      if (!release) await pause(signal);
    }
    const fetched = await fetchQuota(id, signal);
    if (fetched === invalidApplicable) {
      // This account's new applicable window is unknown. Neither an older ready
      // observation nor its persisted copy may attest that the quota is safe.
      const invalid = unavailable(id.provider, "An applicable account quota is invalid or unavailable.");
      remember(key, invalid);
      await unlink(file).catch(() => undefined);
      return invalid;
    }
    if (fetched && fresh(fetched, MAX_AGE_MS)) {
      remember(key, fetched);
      await writeCache(file, id, fetched, signal);
      return fetched;
    }
  } catch { /* Errors, HTTP bodies, account IDs and credential values never escape. */ }
  finally { await release?.(); }
  return cached && fresh(cached, MAX_AGE_MS) ? cached
    : unavailable(id.provider, failures.get(id.digest) ?? "Account quota is unknown, expired or unavailable.");
}

async function readUsage(context: AccountUsageContext, provider: Provider, options: AccountUsageOptions): Promise<ProviderUsage> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(abort, TIMEOUT_MS);
  let flight: Flight | undefined;
  let key: string | undefined;
  try {
    const id = await identity(context, provider, controller.signal);
    if (!id) return unavailable(provider, "Pi's subscription OAuth credential is unavailable.");
    // Include the cache root: tests/embedded hosts and distinct cache homes must not share observations.
    key = path.resolve(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache")) + ":" + provider + ":" + id.digest;
    flight = flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      if (flights.size >= MAX_ACCOUNTS) return unavailable(provider, "Account quota reader is busy.");
      const sharedController = new AbortController();
      const sharedTimeout = setTimeout(() => sharedController.abort(), TIMEOUT_MS);
      const created: Flight = { controller: sharedController, subscribers: 0, promise: Promise.resolve(unavailable(provider, "Account quota is unavailable.")) };
      created.promise = bounded(collect(id, key, sharedController.signal), sharedController.signal)
        .catch(() => unavailable(provider, "Account quota is unavailable."))
        .finally(() => { clearTimeout(sharedTimeout); if (flights.get(key!) === created) flights.delete(key!); });
      flights.set(key, created);
      flight = created;
    }
    flight.subscribers++;
    const result = await bounded(flight.promise, controller.signal);
    // A login changed while I/O was pending: never return the previous account's allowance.
    const current = await identity(context, provider, controller.signal);
    if (!current || current.digest !== id.digest) return unavailable(provider, "The subscription account changed during the quota read.");
    check(controller.signal);
    return fresh(result, MAX_AGE_MS) ? structuredClone(result)
      : result.state === "unavailable" && result.reason ? structuredClone(result)
      : unavailable(provider, "Account quota is unknown, expired or unavailable.");
  } catch {
    return unavailable(provider, options.signal?.aborted ? "Account quota read was cancelled." : "Account quota is unavailable.");
  } finally {
    if (flight && --flight.subscribers === 0) flight.controller.abort();
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Read only Pi's sk-ant-oat OAuth account. Cold reads work without footer/TUI
 * activation. Refresh after five minutes; never return a window ten minutes old,
 * future-dated, without a reset, or reset-due. No Claude Code/API-key fallback.
 */
export function readPiAnthropicUsage(context: AccountUsageContext, options: AccountUsageOptions = {}): Promise<ProviderUsage> {
  return readUsage(context, "anthropic", options);
}

/** Read-only Codex account diagnostics, never an attestation for modern OpenAI. */
export function readCodexUsage(context: AccountUsageContext, options: AccountUsageOptions = {}): Promise<ProviderUsage> {
  return readUsage(context, "openai-codex", options);
}
