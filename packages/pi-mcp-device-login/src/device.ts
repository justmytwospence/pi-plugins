// OAuth 2.0 Device Authorization Grant (RFC 8628) for an MCP server, with discovery through the
// server's protected resource metadata (RFC 9728) and its authorization server's metadata (RFC 8414).

export type Fetch = typeof globalThis.fetch;

export interface Discovery {
  resource: string;
  scopes?: string[];
  issuer: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface Tokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  [key: string]: unknown;
}

export class DeviceFlowError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
    this.name = "DeviceFlowError";
  }
}

/** `https://host/.well-known/<name>` with the URL's path appended, as RFC 8414 and RFC 9728 place it. */
export function wellKnown(url: string, name: string): string {
  const u = new URL(url);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/${name}${path}`;
}

async function getJson(fetch: Fetch, url: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) return undefined;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function unique(urls: string[]): string[] {
  return [...new Set(urls)];
}

export async function discover(
  serverUrl: string,
  options: { fetch?: Fetch; authServerMetadataUrl?: string; signal?: AbortSignal } = {},
): Promise<Discovery> {
  const fetch = options.fetch ?? globalThis.fetch;
  let resourceMetadata: Record<string, unknown> | undefined;
  for (const url of unique([wellKnown(serverUrl, "oauth-protected-resource"), `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`])) {
    resourceMetadata = await getJson(fetch, url, options.signal);
    if (resourceMetadata) break;
  }
  const servers = resourceMetadata?.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : undefined;
  if (!issuer && !options.authServerMetadataUrl) {
    throw new DeviceFlowError(`${serverUrl} does not publish protected resource metadata naming an authorization server`);
  }
  const candidates = options.authServerMetadataUrl
    ? [options.authServerMetadataUrl]
    : [wellKnown(issuer!, "oauth-authorization-server"), wellKnown(issuer!, "openid-configuration"), `${issuer!.replace(/\/$/, "")}/.well-known/openid-configuration`];
  let metadata: Record<string, unknown> | undefined;
  for (const url of unique(candidates)) {
    metadata = await getJson(fetch, url, options.signal);
    if (metadata) break;
  }
  if (!metadata) throw new DeviceFlowError(`No authorization server metadata found for ${issuer ?? options.authServerMetadataUrl}`);
  if (issuer && metadata.issuer !== issuer) {
    throw new DeviceFlowError(`Authorization server metadata names issuer ${String(metadata.issuer)}, expected ${issuer}`);
  }
  const deviceAuthorizationEndpoint = metadata.device_authorization_endpoint;
  const tokenEndpoint = metadata.token_endpoint;
  if (typeof deviceAuthorizationEndpoint !== "string") {
    throw new DeviceFlowError(`The authorization server ${String(metadata.issuer)} does not support the device authorization grant`);
  }
  if (typeof tokenEndpoint !== "string") throw new DeviceFlowError("Authorization server metadata has no token_endpoint");
  for (const endpoint of [deviceAuthorizationEndpoint, tokenEndpoint]) {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
      throw new DeviceFlowError(`Refusing non-HTTPS endpoint ${endpoint}`);
    }
  }
  const scopes = resourceMetadata?.scopes_supported;
  const resource = typeof resourceMetadata?.resource === "string" ? resourceMetadata.resource : serverUrl;
  return {
    resource,
    scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : undefined,
    issuer: String(metadata.issuer ?? issuer),
    tokenEndpoint,
    deviceAuthorizationEndpoint,
  };
}

async function postForm(fetch: Fetch, url: string, body: Record<string, string | undefined>, signal?: AbortSignal) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) if (value) form.set(key, value);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
    signal,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // An empty or non-JSON body is reported by status below.
  }
  return { ok: res.ok, status: res.status, json };
}

function oauthError(json: Record<string, unknown>, status: number): DeviceFlowError {
  const code = typeof json.error === "string" ? json.error : undefined;
  const description = typeof json.error_description === "string" ? json.error_description : undefined;
  return new DeviceFlowError(description ?? code ?? `HTTP ${status}`, code);
}

export async function requestDeviceCode(
  discovery: Discovery,
  request: { clientId: string; scope?: string },
  options: { fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<DeviceCode> {
  const { ok, status, json } = await postForm(
    options.fetch ?? globalThis.fetch,
    discovery.deviceAuthorizationEndpoint,
    { client_id: request.clientId, scope: request.scope, resource: discovery.resource },
    options.signal,
  );
  if (!ok) throw oauthError(json, status);
  if (typeof json.device_code !== "string" || typeof json.user_code !== "string" || typeof json.verification_uri !== "string") {
    throw new DeviceFlowError("Malformed device authorization response");
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    verificationUriComplete: typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : undefined,
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : 600,
    interval: typeof json.interval === "number" ? json.interval : 5,
  };
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DeviceFlowError("Sign-in cancelled", "cancelled"));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(new DeviceFlowError("Sign-in cancelled", "cancelled"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });

/** Polls the token endpoint until the user approves, denies, or the code expires (RFC 8628 section 3.4). */
export async function pollForTokens(
  discovery: Discovery,
  code: DeviceCode,
  request: { clientId: string },
  options: { fetch?: Fetch; signal?: AbortSignal; sleep?: typeof defaultSleep; now?: () => number } = {},
): Promise<Tokens> {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = Math.max(code.interval, 1);
  while (now() < deadline) {
    await sleep(interval * 1000, options.signal);
    const { ok, status, json } = await postForm(
      fetch,
      discovery.tokenEndpoint,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.deviceCode,
        client_id: request.clientId,
        resource: discovery.resource,
      },
      options.signal,
    );
    if (ok) {
      if (typeof json.access_token !== "string") throw new DeviceFlowError("Token response has no access_token");
      return { token_type: "Bearer", ...json } as Tokens;
    }
    const error = typeof json.error === "string" ? json.error : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") throw new DeviceFlowError("Sign-in was denied", error);
    if (error === "expired_token") throw new DeviceFlowError("The code expired before it was approved", error);
    throw oauthError(json, status);
  }
  throw new DeviceFlowError("The code expired before it was approved", "expired_token");
}
