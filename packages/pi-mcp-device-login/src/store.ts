// Writes device-grant tokens where pi's built-in MCP client keeps its OAuth state, so pi uses and
// refreshes them like tokens from its own sign-in. Mirrors pi's private format (dist/extensions/mcp/
// oauth.js, McpOAuthCredentialStore): `mcp-auth.json` maps `mcp__<name>|<url>` to
// `{ serverUrl, tokens, tokensExpireAt?, ... }`, guarded by proper-lockfile's `<file>.lock` directory.

import { chmodSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Tokens } from "./device.ts";

/** proper-lockfile's default staleness, which pi's lockSync uses. */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5_000;

/** Namespace of a server, as pi computes it (core/mcp-servers.js `mcpNamespace`). */
export function storeKey(name: string, serverUrl: string): string {
  return `mcp__${name.replace(/-/g, "_")}|${String(new URL(serverUrl))}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withFileLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Timed out waiting for ${lock}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already gone.
    }
  }
}

/** Whether pi holds tokens for the server (they may still be expired or refused). */
export function hasTokens(file: string, name: string, serverUrl: string): boolean {
  try {
    const states = JSON.parse(readFileSync(file, "utf-8"));
    return Boolean(states?.[storeKey(name, serverUrl)]?.tokens?.access_token);
  } catch {
    return false;
  }
}

export async function saveTokens(file: string, name: string, serverUrl: string, tokens: Tokens, now = Date.now()): Promise<void> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) writeFileSync(file, "{}", { encoding: "utf-8", mode: 0o600 });
  const key = storeKey(name, serverUrl);
  await withFileLock(file, () => {
    const text = readFileSync(file, "utf-8");
    const parsed = text.trim() ? JSON.parse(text) : {};
    const states: Record<string, Record<string, unknown>> =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    const previous = states[key] ?? {};
    // Drop a pending browser sign-in and cached discovery: pi discovers again on its first refresh.
    const { codeVerifier: _v, oauthState: _s, discovery: _d, tokensExpireAt: _e, ...kept } = previous;
    const next: Record<string, unknown> = { ...kept, serverUrl: String(new URL(serverUrl)), tokens };
    if (typeof tokens.expires_in === "number") next.tokensExpireAt = now + tokens.expires_in * 1000;
    states[key] = next;
    writeFileSync(file, `${JSON.stringify(states, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    chmodSync(file, 0o600);
  });
}
