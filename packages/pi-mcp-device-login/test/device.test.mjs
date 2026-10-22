import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, pollForTokens, requestDeviceCode, wellKnown } from "../src/device.ts";
import { saveTokens, storeKey } from "../src/store.ts";
import { loadServers, expandEnv } from "../src/config.ts";

const AS = "https://auth.example.com";
const MCP = "https://komodo.mcp.example.com/mcp";

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : undefined;
    calls.push({ url: String(url), body });
    const route = routes[String(url)];
    const result = typeof route === "function" ? route(body) : route;
    if (!result) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(result.json), { status: result.status ?? 200 });
  };
}

const metadataRoutes = {
  [`https://komodo.mcp.example.com/.well-known/oauth-protected-resource/mcp`]: {
    json: { resource: MCP, authorization_servers: [AS], scopes_supported: ["openid", "offline_access"] },
  },
  [`${AS}/.well-known/oauth-authorization-server`]: {
    json: { issuer: AS, token_endpoint: `${AS}/token`, device_authorization_endpoint: `${AS}/device` },
  },
};

test("wellKnown inserts the path after the well-known segment", () => {
  assert.equal(wellKnown(MCP, "oauth-protected-resource"), "https://komodo.mcp.example.com/.well-known/oauth-protected-resource/mcp");
  assert.equal(wellKnown(AS, "openid-configuration"), `${AS}/.well-known/openid-configuration`);
});

test("discover follows resource metadata to the device endpoint", async () => {
  const d = await discover(MCP, { fetch: fakeFetch(metadataRoutes) });
  assert.deepEqual(d, {
    resource: MCP,
    scopes: ["openid", "offline_access"],
    issuer: AS,
    tokenEndpoint: `${AS}/token`,
    deviceAuthorizationEndpoint: `${AS}/device`,
  });
});

test("discover rejects an authorization server without the device grant and mismatched issuers", async () => {
  const noDevice = { ...metadataRoutes, [`${AS}/.well-known/oauth-authorization-server`]: { json: { issuer: AS, token_endpoint: `${AS}/token` } } };
  await assert.rejects(discover(MCP, { fetch: fakeFetch(noDevice) }), /does not support the device authorization grant/);
  const wrongIssuer = { ...metadataRoutes, [`${AS}/.well-known/oauth-authorization-server`]: { json: { issuer: "https://evil", token_endpoint: `${AS}/token`, device_authorization_endpoint: `${AS}/device` } } };
  await assert.rejects(discover(MCP, { fetch: fakeFetch(wrongIssuer) }), /expected/);
});

test("device code request and polling send client, resource, and honor slow_down", async () => {
  const calls = [];
  let polls = 0;
  const routes = {
    ...metadataRoutes,
    [`${AS}/device`]: { json: { device_code: "dc", user_code: "ABCD", verification_uri: `${AS}/v`, verification_uri_complete: `${AS}/v?c=ABCD`, expires_in: 600, interval: 5 } },
    [`${AS}/token`]: () => {
      polls++;
      if (polls === 1) return { status: 400, json: { error: "authorization_pending" } };
      if (polls === 2) return { status: 400, json: { error: "slow_down" } };
      return { json: { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "bearer" } };
    },
  };
  const fetch = fakeFetch(routes, calls);
  const d = await discover(MCP, { fetch });
  const code = await requestDeviceCode(d, { clientId: "komodo-mcp", scope: "openid offline_access" }, { fetch });
  assert.equal(code.userCode, "ABCD");
  const waits = [];
  let clock = 0;
  const tokens = await pollForTokens(d, code, { clientId: "komodo-mcp" }, {
    fetch,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    now: () => clock,
  });
  assert.equal(tokens.access_token, "at");
  assert.deepEqual(waits, [5000, 5000, 10000]);
  const deviceCall = calls.find((c) => c.url === `${AS}/device`);
  assert.deepEqual(deviceCall.body, { client_id: "komodo-mcp", scope: "openid offline_access", resource: MCP });
  const tokenCall = calls.find((c) => c.url === `${AS}/token`);
  assert.equal(tokenCall.body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(tokenCall.body.resource, MCP);
});

test("polling stops on denial and on expiry", async () => {
  const d = { resource: MCP, issuer: AS, tokenEndpoint: `${AS}/token`, deviceAuthorizationEndpoint: `${AS}/device` };
  const code = { deviceCode: "dc", userCode: "X", verificationUri: "v", expiresIn: 20, interval: 5 };
  const denied = fakeFetch({ [`${AS}/token`]: { status: 400, json: { error: "access_denied" } } });
  await assert.rejects(pollForTokens(d, code, { clientId: "c" }, { fetch: denied, sleep: async () => {} }), /denied/);
  let clock = 0;
  const pending = fakeFetch({ [`${AS}/token`]: { status: 400, json: { error: "authorization_pending" } } });
  await assert.rejects(
    pollForTokens(d, code, { clientId: "c" }, { fetch: pending, sleep: async (ms) => { clock += ms; }, now: () => clock }),
    /expired/,
  );
});

test("cancelling aborts the wait", async () => {
  const d = { resource: MCP, issuer: AS, tokenEndpoint: `${AS}/token`, deviceAuthorizationEndpoint: `${AS}/device` };
  const code = { deviceCode: "dc", userCode: "X", verificationUri: "v", expiresIn: 600, interval: 5 };
  const controller = new AbortController();
  const p = pollForTokens(d, code, { clientId: "c" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(p, (e) => e.code === "cancelled");
});

test("saveTokens writes pi's mcp-auth.json format and keeps other servers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-device-"));
  const file = join(dir, "mcp-auth.json");
  const key = storeKey("my-server", MCP);
  assert.equal(key, `mcp__my_server|${MCP}`);
  writeFileSync(file, JSON.stringify({
    other: { tokens: { access_token: "keep" } },
    [key]: { serverUrl: MCP, codeVerifier: "v", oauthState: "s", discovery: { x: 1 }, tokens: { access_token: "old" }, tokensExpireAt: 1 },
  }));
  await saveTokens(file, "my-server", MCP, { access_token: "new", refresh_token: "r", expires_in: 3600, token_type: "Bearer" }, 1000);
  const states = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(states.other, { tokens: { access_token: "keep" } });
  assert.deepEqual(states[key], {
    serverUrl: MCP,
    tokens: { access_token: "new", refresh_token: "r", expires_in: 3600, token_type: "Bearer" },
    tokensExpireAt: 1000 + 3600 * 1000,
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("saveTokens takes over a stale lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-device-"));
  const file = join(dir, "mcp-auth.json");
  mkdirSync(`${file}.lock`);
  const { utimesSync } = await import("node:fs");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  await saveTokens(file, "s", MCP, { access_token: "a", token_type: "Bearer" });
  assert.equal(JSON.parse(readFileSync(file, "utf-8"))[storeKey("s", MCP)].tokens.access_token, "a");
});

test("loadServers merges user and trusted project files", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "proj-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    a: { url: "https://a/mcp", oauth: { clientId: "${CID}" } },
    stdio: { command: "x" },
  } }));
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { a: { url: "https://a2/mcp" }, b: { enabled: false } } }));
  process.env.CID = "client-a";
  const untrusted = loadServers({ agentDir, cwd, projectTrusted: false });
  assert.deepEqual([...untrusted.keys()], ["a"]);
  assert.equal(untrusted.get("a").clientId, "client-a");
  const trusted = loadServers({ agentDir, cwd, projectTrusted: true });
  assert.equal(trusted.get("a").url, "https://a2/mcp");
  assert.equal(expandEnv("x${NOPE_UNSET}y", {}), "xy");
});
