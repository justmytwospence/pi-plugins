import assert from "node:assert/strict";
import { describe, it, vi, afterEach } from "vitest";
import {
  antigravityUserAgent, createProviderUsageCollector, dispatchProviderUsage, isUsageStale,
  parseGoogleModels, parseGoogleSummary, parseMuseUsage, selectGooglePool,
} from "../src/provider-usage.ts";

const now = 1_800_000_000_000;
const reset = "2030-01-15T12:00:00Z";
const google = { provider: "google", sourceId: "account-a", model: "antigravity-gemini-pro", auth: { kind: "local-oauth", token: "ya29.synthetic_token-1" } };
const muse = { provider: "muse-code", sourceId: "muse-account" };
// Synthetic, sanitized native envelope: no account identifiers or real CLI output.
const museEnvelope = { allowance: null, hint: "synthetic hint", reason: "synthetic reason", schemaVersion: 1 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const project = () => json({ cloudaicompanionProject: { id: "synthetic-project" } });
const summary = () => json({ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.5 }] }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => vi.unstubAllEnvs());

describe("provider usage parsers", () => {
  it("parses recognized Google buckets independently, retaining partial readings", () => {
    const result = parseGoogleSummary({ groups: [null, { buckets: [
      { bucketId: "gemini-5h", remainingFraction: 0.75, resetTime: reset },
      { bucketId: "gemini-weekly", remainingFraction: 0 },
      { bucketId: "3p-5h", remainingFraction: 2, resetTime: reset },
      { bucketId: "3p-weekly", remainingFraction: 1, resetTime: "invalid" },
      { bucketId: "gemini-5h", remainingFraction: 0.5, disabled: true },
      { bucketId: "unknown", remainingFraction: 0.5 },
      { bucketId: "constructor", remainingFraction: 0.5 },
      { bucketId: "3p-weekly", remainingFraction: -1, resetTime: 42 }, null,
    ] }] }, now);
    assert.deepEqual(result, { provider: "google", source: "Google Antigravity subscription", state: "ready", observedAt: now, windows: [
      { label: "5h", pool: "Gemini", used: 25, reset: Date.parse(reset) },
      { label: "weekly", pool: "Gemini", used: 100 },
      { label: "5h", pool: "third-party", reset: Date.parse(reset) },
      { label: "weekly", pool: "third-party", used: 0 },
    ] });
    assert.deepEqual(selectGooglePool(result, "antigravity-gemini-pro"), result.windows.slice(0, 2));
    assert.deepEqual(selectGooglePool(result, "antigravity-claude-sonnet"), result.windows.slice(2));
    assert.deepEqual(selectGooglePool(result, "gemini-pro"), []);
  });

  it("distinguishes malformed summaries from summaries with no recognizable windows", () => {
    for (const payload of [null, [], {}, { groups: {} }]) assert.match(parseGoogleSummary(payload, now).reason, /unrecognized/);
    for (const payload of [{ groups: [] }, { groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: NaN }] }] }]) {
      const result = parseGoogleSummary(payload, now);
      assert.equal(result.state, "unavailable");
      assert.deepEqual(result.windows, []);
      assert.match(result.reason, /no recognizable/);
    }
  });

  it("parses model fallback without inventing a window duration", () => {
    const payload = { models: { "claude-sonnet": { quotaInfo: { remainingFraction: 0.25, resetTime: reset } } } };
    assert.deepEqual(parseGoogleModels(payload, "antigravity-claude-sonnet", now).windows, [{ label: "model", pool: "third-party", used: 75, reset: Date.parse(reset) }]);
    assert.deepEqual(parseGoogleModels({ models: { "antigravity-gemini-pro": { quotaInfo: { resetTime: reset } } } }, google.model, now).windows, [{ label: "model", pool: "Gemini", reset: Date.parse(reset) }]);
    for (const value of [null, {}, { models: { "gemini-pro": { quotaInfo: { remainingFraction: Infinity } } } }]) assert.equal(parseGoogleModels(value, google.model, now).state, "unavailable");
  });

  it("treats native Muse null allowance as unavailable and non-null as unsupported", () => {
    const result = parseMuseUsage(museEnvelope, now);
    assert.deepEqual(result, { provider: "muse-code", source: "Muse subscription", state: "unavailable", windows: [], reason: "Muse subscription usage is unavailable." });
    assert.match(parseMuseUsage({ ...museEnvelope, reason: "api_key" }, now).reason, /API key authentication/);
    assert.match(parseMuseUsage({ ...museEnvelope, schemaVersion: "synthetic-version", reason: null, hint: null }, now).reason, /subscription usage is unavailable/i);
    for (const allowance of [{ remaining: 10 }, [], 0, false, "synthetic"]) assert.match(parseMuseUsage({ ...museEnvelope, allowance }, now).reason, /does not yet support/);
    for (const invalid of [null, {}, { ...museEnvelope, schemaVersion: null }, { ...museEnvelope, hint: 1 }, { ...museEnvelope, reason: {} }, { allowance: null, hint: null, reason: null }]) assert.match(parseMuseUsage(invalid, now).reason, /invalid usage response/);
  });

  it("marks ready readings stale at ten minutes or a past reset, never assuming replenishment", () => {
    const ready = parseGoogleSummary({ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 1 }] }] }, now);
    assert.equal(isUsageStale(ready, now + 300_000), false);
    assert.equal(isUsageStale(ready, now + 599_999), false);
    assert.equal(isUsageStale(ready, now + 600_000), true);
    assert.equal(isUsageStale({ ...ready, observedAt: undefined }, now), true);
    assert.equal(isUsageStale({ ...ready, windows: [{ label: "5h", reset: now }] }, now), true);
    assert.equal(isUsageStale({ ...ready, windows: [{ label: "5h", reset: now + 1 }] }, now), false);
    assert.equal(isUsageStale({ ...ready, state: "unavailable" }, now + 1_000_000), false);
  });
});

describe("dispatch", () => {
  it("routes only supported sources and safely describes unsupported authentication", () => {
    assert.equal(dispatchProviderUsage(google, now), undefined);
    assert.equal(dispatchProviderUsage(muse, now), undefined);
    for (const baseUrl of ["http://localhost:8080/v1", "https://127.0.0.1", "http://[::1]:1234"]) assert.equal(dispatchProviderUsage({ provider: "ollama", sourceId: "local", baseUrl }, now).state, "not-applicable");
    for (const baseUrl of ["http://localhost:8080", "https://localhost.evil.example"]) assert.match(dispatchProviderUsage({ ...google, baseUrl }, now).reason, /Custom Google/);
    assert.match(dispatchProviderUsage({ ...google, auth: { kind: "vault", token: "ya29.synthetic" } }, now).reason, /Vault/);
    for (const token of ["", "ya29.", "ya29.test\r\nX: bad", "placeholder", "ya29.with.dot"]) assert.match(dispatchProviderUsage({ ...google, auth: { kind: "local-oauth", token } }, now).reason, /OAuth/);
    assert.match(dispatchProviderUsage({ ...google, auth: { kind: "api-key", token: "ya29.synthetic" } }, now).reason, /OAuth/);
    assert.match(dispatchProviderUsage({ ...google, model: "gemini-pro", auth: { kind: "api-key" } }, now).reason, /API key/);
    const openai = dispatchProviderUsage({ provider: "openai", sourceId: "x" }, now);
    assert.equal(openai.detailsUrl, "https://chatgpt.com/settings/usage");
    assert.equal(dispatchProviderUsage({ provider: "other", sourceId: "x" }, now).state, "unavailable");
  });
});

describe("collector", () => {
  it("posts project discovery and quota with fixed endpoints, headers and redirects disabled", async () => {
    const calls = [];
    const collector = createProviderUsageCollector({ now: () => now, fetch: async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? project() : summary(); } });
    const result = await collector.refresh(google);
    assert.equal(result.state, "ready");
    assert.deepEqual(calls.map(c => c.url), ["https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"]);
    assert.deepEqual(calls.map(c => JSON.parse(c.init.body)), [{ metadata: { ideType: "ANTIGRAVITY" } }, { project: "synthetic-project" }]);
    for (const { init } of calls) {
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer ya29.synthetic_token-1");
      assert.equal(init.headers["User-Agent"], antigravityUserAgent());
      assert.equal(init.signal.aborted, false);
    }
    collector.dispose();
  });

  it.each([404, 501])("falls back to model quota only on summary status %s", async status => {
    const calls = [];
    const collector = createProviderUsageCollector({ now: () => now, fetch: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? json({ cloudaicompanionProject: "synthetic-project" }) : calls.length === 2 ? json({}, status) : json({ models: { "gemini-pro": { quotaInfo: { remainingFraction: 0.5 } } } });
    } });
    assert.deepEqual((await collector.refresh(google)).windows, [{ label: "model", pool: "Gemini", used: 50 }]);
    assert.match(calls[2].url, /fetchAvailableModels$/);
    assert.deepEqual(JSON.parse(calls[2].init.body), { project: "synthetic-project" });
    collector.dispose();
  });

  it("refuses redirects, errors, malformed or oversized bodies and never falls back on refusal", async () => {
    for (const response of [new Response(null, { status: 302, headers: { location: "https://evil.example" } }), json({}, 403), new Response("not json"), new Response("x".repeat(65_537))]) {
      let calls = 0;
      const collector = createProviderUsageCollector({ fetch: async () => { calls++; return response; } });
      assert.equal((await collector.refresh(google)).state, "unavailable");
      assert.equal(calls, 1); collector.dispose();
    }
    for (const response of [json({}, 403), Object.defineProperty(json({}), "redirected", { value: true })]) {
      let calls = 0;
      const collector = createProviderUsageCollector({ fetch: async () => ++calls === 1 ? project() : response });
      assert.equal((await collector.refresh(google)).state, "unavailable");
      assert.equal(calls, 2); collector.dispose();
    }
    let calls = 0;
    const collector = createProviderUsageCollector({ fetch: async () => { calls++; return json({ cloudaicompanionProject: "  " }); } });
    assert.match((await collector.refresh(google)).reason, /managed project/);
    assert.equal(calls, 1); collector.dispose();
  });

  it("never fetches or executes for vault, invalid token, local or unsupported sources", async () => {
    const fetch = vi.fn(); const exec = vi.fn();
    const collector = createProviderUsageCollector({ fetch, exec });
    for (const source of [{ ...google, auth: { kind: "vault" } }, { ...google, auth: { kind: "local-oauth", token: "bad" } }, { ...google, baseUrl: "http://localhost:8080" }, { provider: "other", sourceId: "x" }]) assert.notEqual((await collector.refresh(source)).state, "ready");
    assert.equal(fetch.mock.calls.length, 0); assert.equal(exec.mock.calls.length, 0); collector.dispose();
  });

  it("coalesces flights, caches attempts and keeps last ready reading after failure", async () => {
    let clock = now; const gate = deferred(); let calls = 0;
    const collector = createProviderUsageCollector({ now: () => clock, fetch: async () => { calls++; if (calls === 1) return gate.promise; if (calls === 2) return summary(); return json({}, 403); } });
    const a = collector.refresh(google), b = collector.refresh(google);
    assert.strictEqual(a, b); assert.equal(calls, 1);
    gate.resolve(project()); const ready = await a; assert.equal(ready.state, "ready");
    assert.strictEqual(await collector.refresh(google), ready); assert.equal(calls, 2);
    clock += 300_000;
    assert.strictEqual(await collector.refresh(google), ready); assert.equal(calls, 3);
    assert.equal(isUsageStale(ready, clock), false);
    assert.equal(isUsageStale(ready, clock + 300_000), true);
    assert.strictEqual(await collector.refresh(google), ready); assert.equal(calls, 3);
    collector.dispose();
  });

  it("caches unavailable attempts until the retry interval", async () => {
    let clock = now, calls = 0;
    const collector = createProviderUsageCollector({ now: () => clock, fetch: async () => { calls++; return json({}, 403); } });
    const first = await collector.refresh(google); await collector.refresh(google);
    assert.equal(calls, 1); assert.equal(first.state, "unavailable");
    clock += 300_000; await collector.refresh(google); assert.equal(calls, 2); collector.dispose();
  });

  it("aborts and ignores old flights on auth change, even if fetch ignores abort", async () => {
    const gate = deferred(); let firstSignal; let calls = 0;
    const collector = createProviderUsageCollector({ fetch: async (_url, init) => { calls++; if (calls === 1) { firstSignal = init.signal; return gate.promise; } return calls === 2 ? project() : summary(); } });
    const old = collector.refresh(google);
    const fresh = collector.refresh({ ...google, auth: { kind: "local-oauth", token: "ya29.new_token" } });
    assert.equal(firstSignal.aborted, true);
    assert.equal((await fresh).state, "ready");
    gate.resolve(json({}, 403)); assert.match((await old).reason, /cancelled/);
    assert.equal((await collector.refresh({ ...google, auth: { kind: "local-oauth", token: "ya29.new_token" } })).state, "ready");
    assert.equal(calls, 3); collector.dispose();
  });

  it("disposes, aborts outstanding work and rejects later refreshes", async () => {
    const gate = deferred(); let signal;
    const collector = createProviderUsageCollector({ fetch: async (_url, init) => { signal = init.signal; return gate.promise; } });
    const flight = collector.refresh(google); collector.dispose();
    assert.equal(signal.aborted, true); gate.resolve(json({}, 403));
    assert.match((await flight).reason, /cancelled/);
    assert.match((await collector.refresh(google)).reason, /disposed/);
  });

  it("invokes injected Muse CLI without shell, with bounded output and timeout", async () => {
    vi.stubEnv("PI_MUSE_BINARY", " synthetic-muse ");
    const exec = vi.fn(async () => JSON.stringify(museEnvelope));
    const collector = createProviderUsageCollector({ now: () => now, exec });
    assert.match((await collector.refresh(muse)).reason, /subscription usage is unavailable/i);
    const [binary, args, options] = exec.mock.calls[0];
    assert.equal(binary, "synthetic-muse"); assert.deepEqual(args, ["usage", "--json"]);
    assert.equal(options.timeout, 10_000); assert.equal(options.maxBuffer, 65_536); assert.equal(options.signal.aborted, false);
    collector.dispose(); assert.equal(options.signal.aborted, true);
  });

  it("handles Muse invalid output, oversized output and command failures without exposing details", async () => {
    for (const exec of [async () => "not json", async () => "x".repeat(65_537), async () => { throw new Error("synthetic secret"); }]) {
      const collector = createProviderUsageCollector({ exec });
      const result = await collector.refresh(muse);
      assert.equal(result.state, "unavailable"); assert.match(result.reason, /command failed or returned invalid data/);
      assert.doesNotMatch(JSON.stringify(result), /synthetic secret/); collector.dispose();
    }
  });
});
