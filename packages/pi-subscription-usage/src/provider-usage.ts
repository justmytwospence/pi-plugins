import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

export type UsageState = "ready" | "unavailable" | "not-applicable";
export type UsageWindow = { label: string; used?: number; reset?: number; pool?: string; model?: string; observedAt?: number; scope?: "shared" | "model" | "variant"; quotaId?: string; variant?: string };
/** Claude extra usage (billed past plan limits). Amounts in major currency units. */
export type ExtraUsage = { enabled: boolean; used?: number; limit?: number; currency?: string; capReached?: boolean };
/** Codex plan access at the limit: whether requests are still served, and prepaid credits. */
export type AccountAccess = { allowed?: boolean; limitReached?: boolean; credits?: { balance: number; unlimited: boolean } };
export type ProviderUsage = { provider: string; source: string; state: UsageState; observedAt?: number; windows: UsageWindow[]; reason?: string; detailsUrl?: string; extra?: ExtraUsage; access?: AccountAccess };

export type UsageSource = {
  provider: string;
  sourceId: string;
  model?: string;
  /** Actual Antigravity model variant used by a logical Gemini 4 Argon model. */
  variant?: string;
  baseUrl?: string;
  auth?: { kind: "local-oauth" | "api-key" | "vault"; token?: string };
};

/** The Muse CLI answers this before the first use in a window; it is not an outage. */
export const MUSE_NO_USAGE_REASON = "Muse reported no usage yet in this window.";
const GOOGLE_SOURCE = "Google Antigravity subscription";
const MUSE_SOURCE = "Muse subscription";
const FIVE_MINUTES = 300_000;
const TEN_MINUTES = 600_000;
const MAX_RESPONSE = 64 * 1024;
const MAX_MODELS_RESPONSE = 512 * 1024;

/** A past reset is not evidence of replenishment; keep the observation stale. */
export function isUsageStale(usage: ProviderUsage, now: number): boolean {
  return usage.state === "ready" && (usage.observedAt === undefined || usage.observedAt > now || now - usage.observedAt >= TEN_MINUTES || usage.windows.some(window =>
    (window.observedAt !== undefined && (window.observedAt > now || now - window.observedAt >= TEN_MINUTES)) ||
    (window.reset !== undefined && window.reset <= now)));
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const unavailable = (provider: string, source: string, reason: string): ProviderUsage => ({ provider, source, state: "unavailable", windows: [], reason });
const resetTime = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
};
const used = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? 100 * (1 - value) : undefined;

/** Parse only the documented, source-observed quota summary buckets. */
export function parseGoogleSummary(payload: unknown, observedAt: number): ProviderUsage {
  const groups = object(payload)?.groups;
  if (!Array.isArray(groups)) return unavailable("google", GOOGLE_SOURCE, "Google returned an unrecognized quota summary.");
  const windows: UsageWindow[] = [];
  const ids: Record<string, [string, string, string?]> = { "gemini-5h": ["Gemini", "Gemini 5h"], "gemini-weekly": ["Gemini", "Gemini weekly"], "gemini-argon-wtu-weekly": ["Gemini", "Argon weekly", ARGON_MODEL], "3p-5h": ["third-party", "5h"], "3p-weekly": ["third-party", "weekly"] };
  for (const group of groups) {
    const buckets = object(group)?.buckets;
    if (!Array.isArray(buckets)) continue;
    for (const item of buckets) {
      const bucket = object(item);
      if (!bucket || bucket.disabled === true || typeof bucket.bucketId !== "string" || !Object.hasOwn(ids, bucket.bucketId)) continue;
      const [pool, label, model] = ids[bucket.bucketId];
      const percent = used(bucket.remainingFraction), reset = resetTime(bucket.resetTime);
      if ((bucket.remainingFraction !== undefined && percent === undefined) || (bucket.resetTime !== undefined && reset === undefined)) {
        if (pool === "Gemini") return unavailable("google", GOOGLE_SOURCE, `Google returned an invalid ${label} quota window.`);
        continue; // A third-party bucket is not applicable to Gemini.
      }
      if (percent === undefined && reset === undefined) continue;
      windows.push({ label, pool, quotaId: bucket.bucketId, scope: model ? "model" : "shared", ...(model ? { model } : {}), ...(percent === undefined ? {} : { used: percent }), ...(reset === undefined ? {} : { reset }) });
    }
  }
  return windows.length ? { provider: "google", source: GOOGLE_SOURCE, state: "ready", observedAt, windows } : unavailable("google", GOOGLE_SOURCE, "Google returned no recognizable quota windows.");
}

export const ARGON_MODEL = "antigravity-gemini-4-argon";
export type ArgonQuotaVariant = "gemini-4-argon-low" | "gemini-4-argon-medium" | "gemini-4-argon-high";
const isArgonVariant = (variant: string | undefined): variant is ArgonQuotaVariant =>
  variant === "gemini-4-argon-low" || variant === "gemini-4-argon-medium" || variant === "gemini-4-argon-high";

/** Callers first reject non-reasoning models and clamp the physical thinking level. */
export function argonQuotaVariant(level: string, thinkingLevelMap?: Readonly<Partial<Record<string, string | null>>>): ArgonQuotaVariant | undefined {
  const effective = thinkingLevelMap?.[level] === undefined ? level : thinkingLevelMap[level];
  if (effective === "off" || effective === "minimal" || effective === "low") return "gemini-4-argon-low";
  if (effective === "medium") return "gemini-4-argon-medium";
  if (effective === "high" || effective === "xhigh" || effective === "max") return "gemini-4-argon-high";
  return undefined;
}
/** The exact per-variant window, independent of its display label. */
export function isArgonVariantQuotaWindow(window: UsageWindow): boolean {
  return window.pool === "Gemini" && window.model === ARGON_MODEL && window.scope === "variant" &&
    isArgonVariant(window.variant) && window.quotaId === `model:${window.variant}`;
}
/** Argon weekly and exact variant quotas never bind another Gemini model. */
export function isArgonQuotaWindow(window: UsageWindow): boolean {
  return window.pool === "Gemini" && window.model === ARGON_MODEL &&
    ((window.scope === "model" && window.quotaId === "gemini-argon-wtu-weekly" && window.variant === undefined) || isArgonVariantQuotaWindow(window));
}
/** Shared Gemini buckets bind every Gemini model, Argon included. */
export function isSharedGeminiQuotaWindow(window: UsageWindow): boolean {
  return window.pool === "Gemini" && window.model === undefined && window.variant === undefined && window.scope === "shared" &&
    (window.quotaId === "gemini-5h" || window.quotaId === "gemini-weekly");
}

/** Identity/completeness only; allowance evaluation owns freshness and numeric validity. */
export function argonQuotaIssue(usage: ProviderUsage, variant: ArgonQuotaVariant): string | undefined {
  if (usage.state !== "ready") return usage.reason ?? "Antigravity quota is unavailable.";
  for (const [quotaId, label] of [["gemini-5h", "Shared Gemini 5h"], ["gemini-weekly", "Shared Gemini weekly"]]) {
    if (!usage.windows.some(window => isSharedGeminiQuotaWindow(window) && window.quotaId === quotaId)) return `${label} quota is unknown.`;
  }
  if (!usage.windows.some(window => isArgonQuotaWindow(window) && window.scope === "model")) return "Argon weekly quota is unknown.";
  if (!usage.windows.some(window => isArgonVariantQuotaWindow(window) && window.variant === variant)) return `${argonVariantLabel(variant)} quota is unknown.`;
  return undefined;
}
const argonVariantLabel = (variant: string | undefined): string => {
  const suffix = variant?.replace(/^gemini-4-argon-/, "");
  return suffix && suffix !== variant ? `Argon ${suffix}` : "Argon variant";
};

/** Select the active Antigravity model's pool without discarding the detail readings. */
export function selectGooglePool(usage: ProviderUsage, model: string): UsageWindow[] {
  const pool = model.startsWith("antigravity-gemini-") ? "Gemini" : model.startsWith("antigravity-claude-") ? "third-party" : undefined;
  if (!pool) return [];
  // Shared windows bind every model in the pool. Model-tagged windows bind only
  // their own model, so an exhausted Argon quota never hides or blocks the
  // shared Gemini reading for a non-Argon Gemini model (and vice versa).
  return usage.windows.filter(window => window.pool === pool && (!window.model || window.model === model));
}

/** A model quota has no established window duration. */
export function parseGoogleModels(payload: unknown, model: string, observedAt: number, variant?: string): ProviderUsage {
  const models = object(object(payload)?.models);
  const id = model.replace(/^antigravity-/, "");
  const endpointId = variant !== undefined ? variant : object(models?.[id]) ? id : model;
  const entry = object(models?.[endpointId]);
  const quota = object(entry?.quotaInfo);
  const percent = used(quota?.remainingFraction), reset = resetTime(quota?.resetTime);
  if (!quota || (quota.remainingFraction !== undefined && percent === undefined) || (quota.resetTime !== undefined && reset === undefined) || (percent === undefined && reset === undefined)) return unavailable("google", GOOGLE_SOURCE, "Google returned no quota for the active model.");
  const exactVariant = model === ARGON_MODEL && isArgonVariant(variant) ? variant : undefined;
  const label = exactVariant ? argonVariantLabel(exactVariant) : "model";
  return { provider: "google", source: GOOGLE_SOURCE, state: "ready", observedAt, windows: [{ label, model, quotaId: `model:${endpointId}`, scope: exactVariant ? "variant" : "model", ...(exactVariant ? { variant: exactVariant } : {}), pool: id.startsWith("claude-") ? "third-party" : "Gemini", ...(percent === undefined ? {} : { used: percent }), ...(reset === undefined ? {} : { reset }) }] };
}

/** Parse Muse CLI schema v1; timestamps are milliseconds, not seconds. */
export function parseMuseUsage(payload: unknown, observedAt: number): ProviderUsage {
  const envelope = object(payload);
  const invalid = () => unavailable("muse-sdk", MUSE_SOURCE, "Muse returned an invalid usage response.");
  if (!envelope || envelope.schemaVersion !== 1 || !Object.hasOwn(envelope, "allowance") ||
      (envelope.reason !== undefined && envelope.reason !== null && typeof envelope.reason !== "string") ||
      (envelope.hint !== undefined && envelope.hint !== null && typeof envelope.hint !== "string")) return invalid();
  if (envelope.allowance === null) return unavailable("muse-sdk", MUSE_SOURCE, envelope.reason === "api_key" ? "Subscription usage is unavailable for API key authentication." :
    envelope.reason === "server_sent_no_usage" ? MUSE_NO_USAGE_REASON : "Muse subscription usage is unavailable.");
  const allowance = object(envelope.allowance);
  const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
  const period = (value: unknown, label: string): UsageWindow | undefined => {
    const data = object(value);
    if (!data || typeof data.usedPercent !== "number" || !Number.isFinite(data.usedPercent) || data.usedPercent < 0 || data.usedPercent > 100 || !timestamp(data.resetsAtMs)) return undefined;
    return { label, used: data.usedPercent, reset: data.resetsAtMs };
  };
  const window = period(allowance?.window, "session"), weekly = period(allowance?.weekly, "weekly");
  if (!allowance || !window || !weekly || !timestamp(allowance.asOfMs) || !timestamp(observedAt)) return invalid();
  return { provider: "muse-sdk", source: MUSE_SOURCE, state: "ready", observedAt: Math.min(allowance.asOfMs, observedAt), windows: [window, weekly] };
}

function localEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

/** Return a state when no supported collector should be invoked. */
export function dispatchProviderUsage(source: UsageSource, _observedAt: number): ProviderUsage | undefined {
  const { provider, model, auth, baseUrl } = source;
  if (provider === "google" && (model?.startsWith("antigravity-gemini-") || model?.startsWith("antigravity-claude-"))) {
    if (baseUrl && baseUrl !== "https://cloudcode-pa.googleapis.com") return unavailable(provider, GOOGLE_SOURCE, "Custom Google endpoints are not supported.");
    if (auth?.kind === "vault") return unavailable(provider, GOOGLE_SOURCE, "Vault custody does not expose quota access.");
    // Google OAuth access tokens have this prefix; reject markers, placeholders and header injection.
    if (auth?.kind !== "local-oauth" || !/^ya29\.[A-Za-z0-9_-]+$/.test(auth.token ?? "")) return unavailable(provider, GOOGLE_SOURCE, "A local Google OAuth credential is unavailable.");
    return undefined;
  }
  if (provider === "muse-code") {
    // pi-muse-bridge registers muse-code at http://localhost with a "muse-code-local"
    // marker key and runs `muse exec` on the Muse CLI's signed-in subscription.
    if (auth?.kind !== "local-oauth" || auth.token !== "muse-code-local") return unavailable(provider, MUSE_SOURCE, "Only pi-muse-bridge's signed-in Muse CLI exposes subscription usage.");
    if (process.env.META_API_KEY) return unavailable(provider, MUSE_SOURCE, "META_API_KEY is set, so Muse may bill the API key instead of the subscription.");
    return undefined;
  }
  if (localEndpoint(baseUrl)) return { provider, source: "Local inference", state: "not-applicable", windows: [], reason: "Local inference has no account quota." };
  if (provider === "openai") return { ...unavailable(provider, "OpenAI subscription", "OpenAI subscription limits are unavailable."), detailsUrl: "https://chatgpt.com/settings/usage" };
  if (provider === "muse-sdk") {
    const placeholder = auth?.kind === "api-key" && auth.token === "muse-code-login";
    return auth?.kind === "api-key" && !placeholder ? unavailable(provider, MUSE_SOURCE, "Subscription usage is unavailable for API key authentication.") : undefined;
  }
  if (auth?.kind === "api-key") return unavailable(provider, provider, "Subscription allowance is not exposed for API key authentication.");
  return unavailable(provider, provider, "Subscription limits are unavailable for this provider.");
}

// CortexKit antigravity-auth-core 3.0.11 fingerprint.js: CLI 1.3.5 / changelist 998863838.
export function antigravityUserAgent(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform || "unknown";
  const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch || "unknown";
  return `antigravity/cli/1.3.5 (aidev_client; os_type=${platform}; arch=${arch}; cl=998863838; auth_method=consumer)`;
}

type Exec = (binary: string, args: string[], options: { signal: AbortSignal; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<string>;
const defaultExec: Exec = (binary, args, options) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, signal: options.signal, killSignal: "SIGKILL", env: options.env, cwd: homedir() });
  const chunks: Buffer[] = [];
  let bytes = 0, oversized = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxBuffer) { oversized = true; child.kill("SIGKILL"); }
    else chunks.push(chunk);
  });
  child.on("error", () => { clearTimeout(timer); reject(new Error("command failed")); });
  child.on("close", code => {
    clearTimeout(timer);
    if (code !== 0 || oversized || options.signal.aborted) reject(new Error("command failed"));
    else resolve(Buffer.concat(chunks).toString("utf8"));
  });
});
type CollectorOptions = { fetch?: typeof globalThis.fetch; exec?: Exec; now?: () => number };

async function readJson(response: Response, maxBytes = MAX_RESPONSE): Promise<unknown> {
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function createProviderUsageCollector(options: CollectorOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now;
  type Slot = { key: string; controller?: AbortController; flight?: Promise<ProviderUsage>; last?: ProviderUsage; attemptedAt?: number };
  const slots = new Map<string, Slot>();
  let disposed = false;

  async function google(source: UsageSource, signal: AbortSignal): Promise<ProviderUsage> {
    if (source.model === ARGON_MODEL) {
      if (source.variant === undefined) return unavailable("google", GOOGLE_SOURCE, "The exact Argon reasoning variant is unknown.");
      if (!isArgonVariant(source.variant)) return unavailable("google", GOOGLE_SOURCE, "Unknown Argon model variant.");
    }
    const headers = { Authorization: `Bearer ${source.auth!.token}`, "Content-Type": "application/json", "User-Agent": antigravityUserAgent() };
    const post = async (url: string, body: unknown) => {
      if (signal.aborted) throw new Error("cancelled");
      const response = await fetcher(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error("redirect");
      return response;
    };
    const projectResponse = await post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
    if (!projectResponse.ok) return unavailable("google", GOOGLE_SOURCE, "Google project discovery was refused or unavailable.");
    const rawProject = object(await readJson(projectResponse))?.cloudaicompanionProject;
    const project = typeof rawProject === "string" ? rawProject : object(rawProject)?.id;
    if (typeof project !== "string" || !project.trim()) return unavailable("google", GOOGLE_SOURCE, "Google did not return a managed project.");
    if (source.model === ARGON_MODEL && isArgonVariant(source.variant)) {
      // A malformed/rejected applicable pool is not proof it is under the cap.
      // Fetch both endpoints: either can reveal a binding Argon limit.
      const readQuota = async (endpoint: string, label: string, parse: (payload: unknown) => ProviderUsage, maxBytes = MAX_RESPONSE): Promise<ProviderUsage> => {
        try {
          const response = await post(`https://daily-cloudcode-pa.googleapis.com/v1internal:${endpoint}`, { project });
          if (!response.ok) return unavailable("google", GOOGLE_SOURCE, `${label} quota request was refused or unavailable.`);
          const parsed = parse(await readJson(response, maxBytes));
          return parsed.state === "ready" ? parsed : unavailable("google", GOOGLE_SOURCE, `${label} quota is unavailable: ${parsed.reason}`);
        } catch {
          return unavailable("google", GOOGLE_SOURCE, `${label} quota request failed or timed out.`);
        }
      };
      const variant = source.variant;
      const [summary, model] = await Promise.all([
        readQuota("retrieveUserQuotaSummary", "Shared Gemini and Argon weekly", payload => parseGoogleSummary(payload, now())),
        readQuota("fetchAvailableModels", argonVariantLabel(variant), payload => parseGoogleModels(payload, ARGON_MODEL, now(), variant), MAX_MODELS_RESPONSE),
      ]);
      if (summary.state !== "ready") return summary;
      if (model.state !== "ready") return model;
      const merged: ProviderUsage = { provider: "google", source: GOOGLE_SOURCE, state: "ready", observedAt: Math.min(summary.observedAt!, model.observedAt!),
        windows: [...selectGooglePool(summary, source.model), ...model.windows] };
      const issue = argonQuotaIssue(merged, source.variant);
      return issue ? unavailable("google", GOOGLE_SOURCE, issue) : merged;
    }
    const response = await post("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { project });
    if (response.status === 404 || response.status === 501) {
      const fallback = await post("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", { project });
      if (!fallback.ok) return unavailable("google", GOOGLE_SOURCE, "Google model quota was refused or unavailable.");
      return parseGoogleModels(await readJson(fallback, MAX_MODELS_RESPONSE), source.model!, now());
    }
    if (!response.ok) return unavailable("google", GOOGLE_SOURCE, "Google quota was refused or unavailable.");
    return parseGoogleSummary(await readJson(response), now());
  }

  async function collect(source: UsageSource, signal: AbortSignal): Promise<ProviderUsage> {
    const immediate = dispatchProviderUsage(source, now());
    if (immediate) return immediate;
    try {
      if (source.provider === "google") return await google(source, signal);
      const binary = process.env.PI_MUSE_BINARY?.trim() || "muse";
      const env: NodeJS.ProcessEnv = { ...process.env, MUSE_NO_AUTO_UPDATE: "1" };
      delete env.META_API_KEY;
      const output = await exec(binary, ["usage", "--json"], { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), timeout: 10_000, maxBuffer: MAX_RESPONSE, env });
      if (Buffer.byteLength(output) > MAX_RESPONSE) throw new Error("large");
      return { ...parseMuseUsage(JSON.parse(output), now()), provider: source.provider };
    } catch {
      return unavailable(source.provider, source.provider === "google" ? GOOGLE_SOURCE : MUSE_SOURCE, source.provider === "google" ? "Google quota request failed or timed out." : "Muse usage command failed or returned invalid data.");
    }
  }

  return {
    refresh(source: UsageSource): Promise<ProviderUsage> {
      if (disposed) return Promise.resolve(unavailable(source.provider, source.provider, "Usage collector is disposed."));
      // Include credential identity without retaining the credential in cache keys.
      const key = createHash("sha256").update(JSON.stringify(source)).update(source.provider === "muse-sdk" || source.provider === "muse-code" ? process.env.PI_MUSE_BINARY ?? "" : "").digest("hex");
      // The footer can poll a different model while the router reads Argon.
      // Do not cancel one model's flight just because it shares a provider.
      const slotKey = `${source.provider}\u0000${source.sourceId}\u0000${source.model ?? ""}\u0000${source.variant ?? ""}`;
      let slot = slots.get(slotKey);
      if (!slot || slot.key !== key) {
        slot?.controller?.abort();
        slot = { key };
        slots.set(slotKey, slot);
      }
      if (slot.flight) return slot.flight;
      if (slot.attemptedAt !== undefined && now() - slot.attemptedAt < FIVE_MINUTES && slot.last) return Promise.resolve(slot.last);
      slot.attemptedAt = now();
      const current = slot;
      const active = new AbortController();
      current.controller = active;
      const pending = collect(source, active.signal).then(result => {
        if (disposed || slots.get(slotKey) !== current || active.signal.aborted) return unavailable(source.provider, source.provider, "Usage request was cancelled.");
        // A failed Argon refresh cannot borrow a prior ready allowance for this
        // exact variant. Other collectors retain their existing transient fallback.
        if (source.provider === "google" && source.model === "antigravity-gemini-4-argon" ||
            result.state === "ready" || !current.last || current.last.state !== "ready") current.last = result;
        return current.last;
      }).finally(() => { if (slots.get(slotKey) === current) current.flight = undefined; });
      current.flight = pending;
      return pending;
    },
    dispose(): void { disposed = true; for (const slot of slots.values()) slot.controller?.abort(); slots.clear(); },
  };
}
