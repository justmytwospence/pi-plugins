import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type UsageState = "ready" | "unavailable" | "not-applicable";
export type UsageWindow = { label: string; used?: number; reset?: number; pool?: string; model?: string };
export type ProviderUsage = { provider: string; source: string; state: UsageState; observedAt?: number; windows: UsageWindow[]; reason?: string; detailsUrl?: string };

export type UsageSource = {
  provider: string;
  sourceId: string;
  model?: string;
  baseUrl?: string;
  auth?: { kind: "local-oauth" | "api-key" | "vault"; token?: string };
};

const GOOGLE_SOURCE = "Google Antigravity subscription";
const MUSE_SOURCE = "Muse subscription";
const FIVE_MINUTES = 300_000;
const TEN_MINUTES = 600_000;
const MAX_RESPONSE = 64 * 1024;

/** A past reset is not evidence of replenishment; keep the observation stale. */
export function isUsageStale(usage: ProviderUsage, now: number): boolean {
  return usage.state === "ready" && (usage.observedAt === undefined || now - usage.observedAt >= TEN_MINUTES || usage.windows.some(window => window.reset !== undefined && window.reset <= now));
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
  const ids: Record<string, [string, string]> = { "gemini-5h": ["Gemini", "5h"], "gemini-weekly": ["Gemini", "weekly"], "3p-5h": ["third-party", "5h"], "3p-weekly": ["third-party", "weekly"] };
  for (const group of groups) {
    const buckets = object(group)?.buckets;
    if (!Array.isArray(buckets)) continue;
    for (const item of buckets) {
      const bucket = object(item);
      if (!bucket || bucket.disabled === true || typeof bucket.bucketId !== "string" || !Object.hasOwn(ids, bucket.bucketId)) continue;
      const [pool, label] = ids[bucket.bucketId];
      const percent = used(bucket.remainingFraction), reset = resetTime(bucket.resetTime);
      if (percent === undefined && reset === undefined) continue;
      windows.push({ label, pool, ...(percent === undefined ? {} : { used: percent }), ...(reset === undefined ? {} : { reset }) });
    }
  }
  return windows.length ? { provider: "google", source: GOOGLE_SOURCE, state: "ready", observedAt, windows } : unavailable("google", GOOGLE_SOURCE, "Google returned no recognizable quota windows.");
}

/** Select the active Antigravity model's pool without discarding the detail readings. */
export function selectGooglePool(usage: ProviderUsage, model: string): UsageWindow[] {
  const pool = model.startsWith("antigravity-gemini-") ? "Gemini" : model.startsWith("antigravity-claude-") ? "third-party" : undefined;
  return pool ? usage.windows.filter(window => window.pool === pool && (!window.model || window.model === model)) : [];
}

/** A model quota has no established window duration. */
export function parseGoogleModels(payload: unknown, model: string, observedAt: number): ProviderUsage {
  const models = object(object(payload)?.models);
  const id = model.replace(/^antigravity-/, "");
  const entry = object(models?.[id]) ?? object(models?.[model]);
  const quota = object(entry?.quotaInfo);
  const percent = used(quota?.remainingFraction), reset = resetTime(quota?.resetTime);
  if (!quota || (percent === undefined && reset === undefined)) return unavailable("google", GOOGLE_SOURCE, "Google returned no quota for the active model.");
  return { provider: "google", source: GOOGLE_SOURCE, state: "ready", observedAt, windows: [{ label: "model", model, pool: id.startsWith("claude-") ? "third-party" : "Gemini", ...(percent === undefined ? {} : { used: percent }), ...(reset === undefined ? {} : { reset }) }] };
}

/** Muse CLI's successful allowance schema has not been verified. */
export function parseMuseUsage(payload: unknown, _observedAt: number): ProviderUsage {
  const envelope = object(payload);
  if (!envelope || !Object.hasOwn(envelope, "allowance") || !Object.hasOwn(envelope, "schemaVersion") || !Object.hasOwn(envelope, "reason") || !Object.hasOwn(envelope, "hint") ||
      !(typeof envelope.schemaVersion === "number" || typeof envelope.schemaVersion === "string") ||
      !(envelope.reason === null || typeof envelope.reason === "string") ||
      !(envelope.hint === null || typeof envelope.hint === "string")) return unavailable("muse-code", MUSE_SOURCE, "Muse returned an invalid usage response.");
  if (envelope.allowance !== null) return unavailable("muse-code", MUSE_SOURCE, "Muse returned an allowance format this footer does not yet support.");
  const reason = envelope.reason === "api_key" ? "Subscription usage is unavailable for API key authentication." : "Muse subscription usage is unavailable.";
  return unavailable("muse-code", MUSE_SOURCE, reason);
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
  if (localEndpoint(baseUrl)) return { provider, source: "Local inference", state: "not-applicable", windows: [], reason: "Local inference has no account quota." };
  if (provider === "openai") return { ...unavailable(provider, "OpenAI subscription", "OpenAI subscription limits are unavailable."), detailsUrl: "https://chatgpt.com/settings/usage" };
  if (provider === "muse-code") return undefined;
  if (auth?.kind === "api-key") return unavailable(provider, provider, "Subscription allowance is not exposed for API key authentication.");
  return unavailable(provider, provider, "Subscription limits are unavailable for this provider.");
}

// CortexKit antigravity-auth-core 3.0.11 fingerprint.js: CLI 1.3.5 / changelist 998863838.
export function antigravityUserAgent(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform || "unknown";
  const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch || "unknown";
  return `antigravity/cli/1.3.5 (aidev_client; os_type=${platform}; arch=${arch}; cl=998863838; auth_method=consumer)`;
}

type Exec = (binary: string, args: string[], options: { signal: AbortSignal; timeout: number; maxBuffer: number }) => Promise<string>;
const defaultExec: Exec = (binary, args, options) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, signal: options.signal });
  const chunks: Buffer[] = [];
  let bytes = 0, oversized = false;
  const timer = setTimeout(() => child.kill(), options.timeout);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxBuffer) { oversized = true; child.kill(); }
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

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error("large"); }
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
    const response = await post("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { project });
    if (response.status === 404 || response.status === 501) {
      const fallback = await post("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", { project });
      if (!fallback.ok) return unavailable("google", GOOGLE_SOURCE, "Google model quota was refused or unavailable.");
      return parseGoogleModels(await readJson(fallback), source.model!, now());
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
      const output = await exec(binary, ["usage", "--json"], { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), timeout: 10_000, maxBuffer: MAX_RESPONSE });
      if (Buffer.byteLength(output) > MAX_RESPONSE) throw new Error("large");
      return parseMuseUsage(JSON.parse(output), now());
    } catch {
      return unavailable(source.provider, source.provider === "google" ? GOOGLE_SOURCE : MUSE_SOURCE, source.provider === "google" ? "Google quota request failed or timed out." : "Muse usage command failed or returned invalid data.");
    }
  }

  return {
    refresh(source: UsageSource): Promise<ProviderUsage> {
      if (disposed) return Promise.resolve(unavailable(source.provider, source.provider, "Usage collector is disposed."));
      // Include credential identity without retaining the credential in cache keys.
      const key = createHash("sha256").update(JSON.stringify(source)).update(source.provider === "muse-code" ? process.env.PI_MUSE_BINARY ?? "" : "").digest("hex");
      let slot = slots.get(source.provider);
      if (!slot || slot.key !== key) {
        slot?.controller?.abort();
        slot = { key };
        slots.set(source.provider, slot);
      }
      if (slot.flight) return slot.flight;
      if (slot.attemptedAt !== undefined && now() - slot.attemptedAt < FIVE_MINUTES && slot.last) return Promise.resolve(slot.last);
      slot.attemptedAt = now();
      const current = slot;
      const active = new AbortController();
      current.controller = active;
      const pending = collect(source, active.signal).then(result => {
        if (disposed || slots.get(source.provider) !== current || active.signal.aborted) return unavailable(source.provider, source.provider, "Usage request was cancelled.");
        if (result.state === "ready" || !current.last || current.last.state !== "ready") current.last = result;
        return current.last;
      }).finally(() => { if (slots.get(source.provider) === current) current.flight = undefined; });
      current.flight = pending;
      return pending;
    },
    dispose(): void { disposed = true; for (const slot of slots.values()) slot.controller?.abort(); slots.clear(); },
  };
}
