import assert from "node:assert/strict";
import { describe, it, vi, afterEach } from "vitest";
import {
  antigravityUserAgent, createProviderUsageCollector, dispatchProviderUsage, isUsageStale,
  parseGoogleModels, parseGoogleSummary, parseMuseUsage, selectGooglePool,
} from "../src/provider-usage.ts";

const now = 1_800_000_000_000;
const reset = "2030-01-15T12:00:00Z";
const google = { provider: "google", sourceId: "account-a", model: "antigravity-gemini-pro", auth: { kind: "local-oauth", token: "ya29.synthetic_token-1" } };
const muse = { provider: "muse-sdk", sourceId: "muse-account" };
// Synthetic, sanitized native envelope: no account identifiers or real CLI output.
const museEnvelope = { allowance: null, hint: "synthetic hint", reason: "synthetic reason", schemaVersion: 1 };
const museAllowance = { asOfMs: now - 1_000, window: { usedPercent: 0, resetsAtMs: now + 60_000 }, weekly: { usedPercent: 100, resetsAtMs: now + 600_000 } };
const argon = { ...google, model: "antigravity-gemini-4-argon" };
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
    ] });
    assert.deepEqual(selectGooglePool(result, "antigravity-gemini-pro"), result.windows.slice(0, 2));
    assert.deepEqual(selectGooglePool(result, "antigravity-claude-sonnet"), result.windows.slice(2));
    assert.deepEqual(selectGooglePool(result, "gemini-pro"), []);
  });

  it("keeps an Argon-specific weekly bucket apart from other Gemini models", () => {
    const reading = parseGoogleSummary({ groups: [{ buckets: [
      { bucketId: "gemini-5h", remainingFraction: 0.7 },
      { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.04, resetTime: reset },
    ] }] }, now);
    assert.equal(reading.state, "ready");
    assert.deepEqual(selectGooglePool(reading, "antigravity-gemini-4-argon"), reading.windows);
    assert.deepEqual(selectGooglePool(reading, "antigravity-gemini-pro"), [reading.windows[0]]);
    assert.equal(reading.windows[1].used, 96);
  });

  it("distinguishes malformed summaries from summaries with no recognizable windows", () => {
    for (const payload of [null, [], {}, { groups: {} }]) assert.match(parseGoogleSummary(payload, now).reason, /unrecognized/);
    for (const payload of [{ groups: [] }, { groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: NaN }] }] }]) {
      const result = parseGoogleSummary(payload, now);
      assert.equal(result.state, "unavailable");
      assert.deepEqual(result.windows, []);
      assert.match(result.reason, /no recognizable|invalid Gemini/);
    }
  });

  it("parses model fallback without inventing a window duration", () => {
    const payload = { models: { "claude-sonnet": { quotaInfo: { remainingFraction: 0.25, resetTime: reset } } } };
    assert.deepEqual(parseGoogleModels(payload, "antigravity-claude-sonnet", now).windows, [{ label: "model", model: "antigravity-claude-sonnet", pool: "third-party", used: 75, reset: Date.parse(reset) }]);
    const fallback = parseGoogleModels({ models: { "antigravity-gemini-pro": { quotaInfo: { resetTime: reset } } } }, google.model, now);
    assert.deepEqual(fallback.windows, [{ label: "model", model: google.model, pool: "Gemini", reset: Date.parse(reset) }]);
    assert.deepEqual(selectGooglePool(fallback, google.model), fallback.windows);
    assert.deepEqual(selectGooglePool(fallback, "antigravity-gemini-flash"), [], "another model in the same pool cannot borrow a model-specific reading");
    for (const value of [null, {}, { models: { "gemini-pro": { quotaInfo: { remainingFraction: Infinity } } } }]) assert.equal(parseGoogleModels(value, google.model, now).state, "unavailable");
  });

  it("parses Muse v1 windows and clamps future observation times", () => {
    const payload = { ...museEnvelope, allowance: museAllowance };
    assert.deepEqual(parseMuseUsage(payload, now), { provider: "muse-sdk", source: "Muse subscription", state: "ready", observedAt: now - 1_000, windows: [
      { label: "session", used: 0, reset: now + 60_000 }, { label: "weekly", used: 100, reset: now + 600_000 },
    ] });
    assert.equal(parseMuseUsage({ ...payload, allowance: { ...museAllowance, asOfMs: now + 1000 } }, now).observedAt, now);
    assert.equal(parseMuseUsage({ schemaVersion: 1, allowance: null }, now).state, "unavailable");
    assert.match(parseMuseUsage({ ...museEnvelope, reason: "api_key" }, now).reason, /API key authentication/);
  });

  it("rejects unknown Muse schemas and malformed allowances rather than displaying partial or zero usage", () => {
    const invalid = [null, {}, ...[null, 0, 2, "1"].map(schemaVersion => ({ ...museEnvelope, schemaVersion })),
      { ...museEnvelope, hint: 1 }, { ...museEnvelope, reason: {} },
      ...[{}, [], 0, false, "synthetic"].map(allowance => ({ ...museEnvelope, allowance }))];
    for (const asOfMs of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1"]) invalid.push({ ...museEnvelope, allowance: { ...museAllowance, asOfMs } });
    for (const key of ["window", "weekly"]) {
      for (const value of [undefined, null, {}, []]) invalid.push({ ...museEnvelope, allowance: { ...museAllowance, [key]: value } });
      for (const usedPercent of [undefined, null, -1, 101, NaN, Infinity, "50"]) invalid.push({ ...museEnvelope, allowance: { ...museAllowance, [key]: { ...museAllowance[key], usedPercent } } });
      for (const resetsAtMs of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1"]) invalid.push({ ...museEnvelope, allowance: { ...museAllowance, [key]: { ...museAllowance[key], resetsAtMs } } });
    }
    for (const payload of invalid) {
      const result = parseMuseUsage(payload, now);
      assert.equal(result.state, "unavailable"); assert.deepEqual(result.windows, []); assert.match(result.reason, /invalid usage response/);
    }
  });

  it("rejects supplied invalid Google quota fields while allowing missing optional fields", () => {
    for (const quota of [{ remainingFraction: -1, resetTime: reset }, { remainingFraction: 1.1, resetTime: reset }, { remainingFraction: null, resetTime: reset }, { remainingFraction: 0.5, resetTime: "invalid" }, { remainingFraction: 0.5, resetTime: null }]) {
      assert.equal(parseGoogleSummary({ groups: [{ buckets: [{ bucketId: "gemini-5h", ...quota }] }] }, now).state, "unavailable");
      assert.equal(parseGoogleModels({ models: { "gemini-pro": { quotaInfo: quota } } }, google.model, now).state, "unavailable");
    }
    for (const quota of [{ remainingFraction: 0.5 }, { resetTime: reset }]) {
      assert.equal(parseGoogleSummary({ groups: [{ buckets: [{ bucketId: "gemini-5h", ...quota }] }] }, now).state, "ready");
      assert.equal(parseGoogleModels({ models: { "gemini-pro": { quotaInfo: quota } } }, google.model, now).state, "ready");
    }
  });

  it("marks ready readings stale at ten minutes or a past reset, never assuming replenishment", () => {
    const ready = parseGoogleSummary({ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 1 }] }] }, now);
    assert.equal(isUsageStale(ready, now + 300_000), false);
    assert.equal(isUsageStale(ready, now + 599_999), false);
    assert.equal(isUsageStale(ready, now + 600_000), true);
    assert.equal(isUsageStale({ ...ready, observedAt: undefined }, now), true);
    assert.equal(isUsageStale({ ...ready, observedAt: now + 30_001 }, now), true);
    assert.equal(isUsageStale({ ...ready, windows: [{ label: "5h", reset: now }] }, now), true);
    assert.equal(isUsageStale({ ...ready, windows: [{ label: "5h", reset: now + 1 }] }, now), false);
    assert.equal(isUsageStale({ ...ready, state: "unavailable" }, now + 1_000_000), false);
  });
});

describe("dispatch", () => {
  it("routes only supported sources and safely describes unsupported authentication", () => {
    assert.equal(dispatchProviderUsage(google, now), undefined);
    assert.equal(dispatchProviderUsage(muse, now), undefined);
    assert.match(dispatchProviderUsage({ ...muse, auth: { kind: "api-key", token: "synthetic" } }, now).reason, /API key authentication/);
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
    assert.deepEqual((await collector.refresh(google)).windows, [{ label: "model", model: google.model, pool: "Gemini", used: 50 }]);
    assert.match(calls[2].url, /fetchAvailableModels$/);
    assert.deepEqual(JSON.parse(calls[2].init.body), { project: "synthetic-project" });
    collector.dispose();
  });

  it("merges Argon Gemini summary windows with only the exact model quota", async () => {
    const calls = [];
    const collector = createProviderUsageCollector({ now: () => now, fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("loadCodeAssist")) return project();
      if (url.endsWith("retrieveUserQuotaSummary")) return json({ groups: [{ buckets: [
        { bucketId: "gemini-5h", remainingFraction: 0.5 }, { bucketId: "gemini-weekly", remainingFraction: 0.75 },
        { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.05 },
        { bucketId: "3p-5h", remainingFraction: 0.1 },
      ] }] });
      if (url.endsWith("fetchAvailableModels")) return json({ models: {
        "gemini-4-argon-medium": { quotaInfo: { remainingFraction: 0.25, resetTime: reset } },
        "gemini-other": { quotaInfo: { remainingFraction: 0.01 } },
      } });
      throw new Error("unexpected endpoint");
    } });
    const result = await collector.refresh(argon);
    assert.equal(result.state, "ready");
    assert.deepEqual(result.windows, [
      { label: "5h", pool: "Gemini", used: 50 }, { label: "weekly", pool: "Gemini", used: 25 },
      { label: "Argon weekly", pool: "Gemini", model: argon.model, used: 95 },
      { label: "model", pool: "Gemini", model: argon.model, used: 75, reset: Date.parse(reset) },
    ]);
    assert.equal(calls.length, 3);
    assert.deepEqual(new Set(calls.slice(1).map(call => new URL(call.url).pathname)), new Set(["/v1internal:retrieveUserQuotaSummary", "/v1internal:fetchAvailableModels"]));
    for (const call of calls.slice(1)) assert.deepEqual(JSON.parse(call.init.body), { project: "synthetic-project" });
    collector.dispose();
  });

  it("maps the logical Argon route to only its selected reasoning variant", async () => {
    const collector = createProviderUsageCollector({ now: () => now, fetch: async url => {
      if (url.endsWith("loadCodeAssist")) return project();
      if (url.endsWith("retrieveUserQuotaSummary")) return json({ groups: [{ buckets: [
        { bucketId: "gemini-5h", remainingFraction: 0.8 },
        { bucketId: "gemini-weekly", remainingFraction: 0.9 },
        { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.7 },
      ] }] });
      return json({ models: {
        "gemini-4-argon-high": { quotaInfo: { remainingFraction: 0.01 } },
        "gemini-4-argon-medium": { quotaInfo: { remainingFraction: 0.8 } },
      } });
    } });
    const medium = await collector.refresh({ ...argon, variant: "gemini-4-argon-medium" });
    const high = await collector.refresh({ ...argon, variant: "gemini-4-argon-high" });
    for (const [result, expected] of [[medium, [20, 10, 30, 20]], [high, [20, 10, 30, 99]]]) {
      assert.equal(result.state, "ready", result.reason);
      assert.equal(result.windows.length, expected.length);
      result.windows.forEach((window, index) => assert.ok(Math.abs(window.used - expected[index]) < 1e-9));
    }
    assert.equal((await collector.refresh({ ...argon, variant: "gemini-4-argon-unknown" })).state, "unavailable");
    collector.dispose();
  });

  it.each(["5h", "weekly", "Argon weekly", "model"])("requires the %s Argon quota alongside the other applicable windows", async missing => {
    const buckets = [
      { bucketId: "gemini-5h", remainingFraction: 0.5 },
      { bucketId: "gemini-weekly", remainingFraction: 0.5 },
      { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.5 },
    ];
    const ids = { "5h": "gemini-5h", weekly: "gemini-weekly", "Argon weekly": "gemini-argon-wtu-weekly" };
    const collector = createProviderUsageCollector({ now: () => now, fetch: async url => {
      if (url.endsWith("loadCodeAssist")) return project();
      if (url.endsWith("retrieveUserQuotaSummary")) return json({ groups: [{ buckets: buckets.filter(bucket => bucket.bucketId !== ids[missing]) }] });
      return json({ models: missing === "model" ? {} : { "gemini-4-argon-medium": { quotaInfo: { remainingFraction: 0.9 } } } });
    } });
    const result = await collector.refresh(argon);
    assert.equal(result.state, "unavailable");
    assert.deepEqual(result.windows, []);
    collector.dispose();
  });

  it("fails closed when the requested Argon variant is missing despite generic quota", async () => {
    const collector = createProviderUsageCollector({ now: () => now, fetch: async url => {
      if (url.endsWith("loadCodeAssist")) return project();
      if (url.endsWith("retrieveUserQuotaSummary")) return summary();
      return json({ models: { "gemini-4-argon": { quotaInfo: { remainingFraction: 0.9 } } } });
    } });
    const result = await collector.refresh({ ...argon, variant: "gemini-4-argon-high" });
    assert.equal(result.state, "unavailable");
    assert.deepEqual(result.windows, []);
    assert.match(result.reason, /no quota for the active model/);
    collector.dispose();
  });

  it.each(["summary", "models"])("fails closed when an Argon quota endpoint %s is unavailable", async unavailableEndpoint => {
    for (const failure of [() => json({}, 404), () => json({}, 501), () => json({}, 503), () => new Response("not json"), () => { throw new Error("offline failure"); }]) {
      const calls = [];
      const collector = createProviderUsageCollector({ now: () => now, fetch: async url => {
        calls.push(url);
        if (url.endsWith("loadCodeAssist")) return project();
        if (url.endsWith("retrieveUserQuotaSummary")) return unavailableEndpoint === "summary" ? failure() : summary();
        if (url.endsWith("fetchAvailableModels")) return unavailableEndpoint === "models" ? failure() : json({ models: { "gemini-4-argon-medium": { quotaInfo: { remainingFraction: 0.25 } } } });
        throw new Error("unexpected endpoint");
      } });
      const result = await collector.refresh(argon);
      assert.equal(result.state, "unavailable");
      assert.deepEqual(result.windows, []);
      assert.equal(calls.length, 3); collector.dispose();
    }
  });

  it.each(["summary", "models"])("does not reuse an old ready Argon reading after a malformed %s refresh", async broken => {
    let clock = now, attempts = 0;
    const credential = "ya29.synthetic_token-1";
    const collector = createProviderUsageCollector({ now: () => clock, fetch: async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${credential}`);
      if (url.endsWith("loadCodeAssist")) { attempts++; return project(); }
      if (url.endsWith("retrieveUserQuotaSummary")) return json({ groups: [{ buckets: [
        { bucketId: "gemini-5h", remainingFraction: 0.8 }, { bucketId: "gemini-weekly", remainingFraction: 0.6 },
        { bucketId: "gemini-argon-wtu-weekly", remainingFraction: attempts === 1 || broken !== "summary" ? 0.5 : "invalid" },
      ] }] });
      return json({ models: { "gemini-4-argon-medium": { quotaInfo: { remainingFraction: attempts === 1 || broken !== "models" ? 0.8 : "invalid" } } } });
    } });
    assert.equal((await collector.refresh(argon)).state, "ready");
    clock += 300_000;
    const failed = await collector.refresh(argon);
    assert.equal(failed.state, "unavailable");
    assert.deepEqual(failed.windows, []);
    assert.doesNotMatch(JSON.stringify(failed), /ya29|synthetic-project/);
    assert.strictEqual(await collector.refresh(argon), failed);
    assert.equal(attempts, 2);
    collector.dispose();
  });

  it.each(["summary", "models"])("does not reuse a ready Argon reading when the %s endpoint becomes unavailable", async broken => {
    let clock = now, attempts = 0;
    const collector = createProviderUsageCollector({ now: () => clock, fetch: async url => {
      if (url.endsWith("loadCodeAssist")) { attempts++; return project(); }
      if (url.endsWith("retrieveUserQuotaSummary")) return broken === "summary" && attempts === 2 ? json({}, 501) : json({ groups: [{ buckets: [
        { bucketId: "gemini-5h", remainingFraction: 0.5 }, { bucketId: "gemini-weekly", remainingFraction: 0.5 },
        { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.5 },
      ] }] });
      return broken === "models" && attempts === 2 ? json({}, 404) : json({ models: { "gemini-4-argon-medium": { quotaInfo: { remainingFraction: 0.5 } } } });
    } });
    assert.equal((await collector.refresh(argon)).state, "ready");
    clock += 300_000;
    const failed = await collector.refresh(argon);
    assert.equal(failed.state, "unavailable");
    assert.deepEqual(failed.windows, []);
    assert.strictEqual(await collector.refresh(argon), failed);
    assert.equal(attempts, 2);
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

  it("accepts large fetchAvailableModels catalogs up to 512 KB and rejects larger ones", async () => {
    const summaryBody = () => json({ groups: [{ buckets: [
      { bucketId: "gemini-5h", remainingFraction: 0.5 },
      { bucketId: "gemini-weekly", remainingFraction: 0.75 },
      { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.4, resetTime: reset },
    ] }] });
    const okCollector = createProviderUsageCollector({ now: () => now, fetch: async url => {
      if (url.endsWith("loadCodeAssist")) return project();
      if (url.endsWith("retrieveUserQuotaSummary")) return summaryBody();
      return json({
        models: { "gemini-4-argon-medium": { quotaInfo: { remainingFraction: 0.4, resetTime: reset } } },
        sharedModelExperiments: "x".repeat(150_000),
      });
    } });
    assert.equal((await okCollector.refresh(argon)).state, "ready");
    okCollector.dispose();

    const oversizedCollector = createProviderUsageCollector({ now: () => now, fetch: async url => {
      if (url.endsWith("loadCodeAssist")) return project();
      if (url.endsWith("retrieveUserQuotaSummary")) return summaryBody();
      return new Response("x".repeat(524_289));
    } });
    assert.equal((await oversizedCollector.refresh(argon)).state, "unavailable");
    oversizedCollector.dispose();
  });

  it("never fetches or executes for vault, invalid token, local or unsupported sources", async () => {
    const fetch = vi.fn(); const exec = vi.fn();
    const collector = createProviderUsageCollector({ fetch, exec });
    for (const source of [{ ...muse, auth: { kind: "api-key", token: "synthetic" } }, { ...google, auth: { kind: "vault" } }, { ...google, auth: { kind: "local-oauth", token: "bad" } }, { ...google, baseUrl: "http://localhost:8080" }, { provider: "other", sourceId: "x" }]) assert.notEqual((await collector.refresh(source)).state, "ready");
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

  it("does not cancel a model-specific quota read when the footer polls another model", async () => {
    const first = deferred(), second = deferred(); const signals = [];
    let calls = 0;
    const collector = createProviderUsageCollector({ fetch: async (_url, init) => {
      signals.push(init.signal); calls++;
      if (calls === 1) return first.promise;
      if (calls === 2) return second.promise;
      return summary();
    } });
    const a = collector.refresh(google);
    const b = collector.refresh({ ...google, sourceId: "another-model", model: "antigravity-gemini-flash" });
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, false);
    assert.equal(signals[1].aborted, false);
    first.resolve(project()); second.resolve(project());
    assert.equal((await a).state, "ready");
    assert.equal((await b).state, "ready");
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

  it("invokes injected Muse CLI without shell, with bounded output, timeout and no API key", async () => {
    vi.stubEnv("PI_MUSE_BINARY", " synthetic-muse ");
    vi.stubEnv("META_API_KEY", "synthetic-secret");
    vi.stubEnv("SYNTHETIC_MUSE_ENV", "preserved");
    const exec = vi.fn(async () => JSON.stringify(museEnvelope));
    const collector = createProviderUsageCollector({ now: () => now, exec });
    assert.match((await collector.refresh(muse)).reason, /subscription usage is unavailable/i);
    const [binary, args, options] = exec.mock.calls[0];
    assert.equal(binary, "synthetic-muse"); assert.deepEqual(args, ["usage", "--json"]);
    assert.equal(options.timeout, 10_000); assert.equal(options.maxBuffer, 65_536); assert.equal(options.signal.aborted, false);
    assert.equal(options.env.MUSE_NO_AUTO_UPDATE, "1");
    assert.equal(options.env.PI_MUSE_BINARY, " synthetic-muse ");
    assert.equal(options.env.SYNTHETIC_MUSE_ENV, "preserved");
    assert.equal(Object.hasOwn(options.env, "META_API_KEY"), false);
    collector.dispose(); assert.equal(options.signal.aborted, true);
  });

  it("collects only from the Muse SDK bridge and its login marker, not unmarked muse-code sources", async () => {
    const alias = { provider: "muse-sdk", sourceId: "sdk-account" };
    const exec = vi.fn(async () => JSON.stringify({ ...museEnvelope, allowance: museAllowance }));
    const fetch = vi.fn();
    const collector = createProviderUsageCollector({ now: () => now, exec, fetch });
    for (const auth of [undefined, { kind: "local-oauth", token: "synthetic" }, { kind: "api-key", token: "muse-code-login" }]) {
      const source = { ...alias, auth };
      assert.equal(dispatchProviderUsage(source, now), undefined);
      const result = await collector.refresh(source);
      assert.equal(result.state, "ready");
      assert.deepEqual(result.windows, parseMuseUsage({ ...museEnvelope, allowance: museAllowance }, now).windows);
    }
    const before = exec.mock.calls.length;
    for (const auth of [{ kind: "local-oauth" }, { kind: "api-key", token: "muse-code-local" }, { kind: "local-oauth", token: "other" }]) {
      const legacy = { provider: "muse-code", sourceId: "legacy-bridge", baseUrl: "http://localhost", auth };
      assert.match(dispatchProviderUsage(legacy, now).reason, /pi-muse-bridge/);
      assert.equal((await collector.refresh(legacy)).state, "unavailable");
    }
    for (const token of ["synthetic-api-key", "", undefined]) {
      const source = { ...alias, auth: { kind: "api-key", token } };
      assert.match(dispatchProviderUsage(source, now).reason, /API key/i);
      assert.equal((await collector.refresh(source)).state, "unavailable");
    }
    assert.equal(exec.mock.calls.length, before); assert.equal(fetch.mock.calls.length, 0);
    collector.dispose();
  });

  it("collects pi-muse-bridge's muse-code from the signed-in CLI despite its localhost URL, unless META_API_KEY is set", async () => {
    const bridge = { provider: "muse-code", sourceId: "muse-wonder-1.0", model: "muse-wonder-1.0", baseUrl: "http://localhost", auth: { kind: "local-oauth", token: "muse-code-local" } };
    const exec = vi.fn(async () => JSON.stringify({ ...museEnvelope, allowance: museAllowance }));
    const collector = createProviderUsageCollector({ now: () => now, exec });
    assert.equal(dispatchProviderUsage(bridge, now), undefined);
    const result = await collector.refresh(bridge);
    assert.equal(result.state, "ready");
    assert.equal(result.provider, "muse-code");
    assert.deepEqual(result.windows, parseMuseUsage({ ...museEnvelope, allowance: museAllowance }, now).windows);
    vi.stubEnv("META_API_KEY", "synthetic");
    try { assert.match(dispatchProviderUsage(bridge, now).reason, /META_API_KEY/); }
    finally { vi.unstubAllEnvs(); }
    collector.dispose();
  });

  it("explains a Muse window with no usage yet without inventing zero", () => {
    const result = parseMuseUsage({ schemaVersion: 1, allowance: null, reason: "server_sent_no_usage", hint: "synthetic" }, now);
    assert.equal(result.state, "unavailable");
    assert.match(result.reason, /no usage yet/);
    assert.deepEqual(result.windows, []);
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
