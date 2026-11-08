import assert from "node:assert/strict";
import { test, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Tracker } from "../src/quota-pressure.ts";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseClaudeQuota, parseClaudeHeaders, parseCodexUsage, parseCodexHeaders, claudeCodeUserAgent,
  codexAccountId, codexRateLimitsEvent, codexWindowLabel, mergeQuota, readPiAnthropicUsage, readCodexUsage, readSelectionPressure,
} from "../src/account-usage.ts";

const now = Date.parse("2026-09-23T12:00:00Z");
const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function isolatedCache() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-usage-test-"));
  directories.push(dir);
  vi.stubEnv("XDG_CACHE_HOME", dir);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(dir, "config"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "agent"));
  return dir;
}
const context = token => ({ modelRegistry: { getApiKeyForProvider: async () => token } });
const json = body => new Response(JSON.stringify(body), { status: 200 });

test("boundary pressure is neutral when verification is missing or cancelled", async () => {
  await isolatedCache();
  assert.equal((await readSelectionPressure(context("sk-ant-oat-test-token"), { provider: "anthropic", id: "claude" })).state, "unavailable");
  const abort = new AbortController(); abort.abort();
  const ctx = { modelRegistry: { ...context("sk-ant-oat-test-token").modelRegistry, find: (provider, id) => ({ provider, id, api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }), isUsingOAuth: () => true } };
  assert.equal((await readSelectionPressure(ctx, { provider: "anthropic", id: "claude" }, { signal: abort.signal })).state, "unavailable");
});

test("boundary pressure respects physical route, family and cached observation", async () => {
  await isolatedCache();
  const expires = new Date(Date.now() + 3600_000).toISOString();
  let calls = 0;
  vi.stubGlobal("fetch", async () => { calls++; return json({ five_hour: { utilization: 20, resets_at: expires }, limits: [{ kind: "weekly_scoped", percent: 90, resets_at: expires, scope: { model: { display_name: "Fable" } } }] }); });
  const registry = { getApiKeyForProvider: async () => "sk-ant-oat-test-token", isUsingOAuth: () => true,
    find: (provider, id) => ({ provider, id, api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }) };
  const ctx = { modelRegistry: registry };
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4" }, fable = { provider: "anthropic", id: "claude-fable-4" };
  assert.equal((await readSelectionPressure(ctx, sonnet)).p, 0);
  assert.equal((await readSelectionPressure(ctx, fable, { scope: "shared" })).p, 0);
  assert.equal((await readSelectionPressure(ctx, fable)).p, 1);
  assert.equal(calls, 1);
  assert.equal((await readSelectionPressure(ctx, { provider: "openai", id: "gpt" })).state, "not-applicable");
  registry.isUsingOAuth = () => false;
  assert.equal((await readSelectionPressure(ctx, sonnet)).state, "not-applicable");
});

test("Claude endpoint preserves percentage points, reset dates, scoped windows and spend", () => {
  const quota = parseClaudeQuota({
    five_hour: { utilization: 94.99, resets_at: "2026-09-23T14:00:00Z" },
    seven_day: { utilization: 95 },
    seven_day_opus: { utilization: 100, resets_at: "2026-09-30T12:00:00Z" },
    limits: [{ kind: "weekly_scoped", percent: 0.5, resets_at: "2026-09-30T12:00:00Z", scope: { model: { display_name: "Fable" } } }],
    spend: { enabled: true, used: { amount_minor: 15421, exponent: 2, currency: "USD" }, limit: { amount_minor: 15000, exponent: 2 } },
  }, now);
  assert.deepEqual(quota.windows, [
    { label: "5h", used: 94.99, reset: now + 7200_000 },
    { label: "week", used: 95, reset: undefined },
    { label: "Opus", used: 100, reset: now + 7 * 86400_000 },
    { label: "Fable", used: 0.5, reset: now + 7 * 86400_000 },
  ]);
  assert.deepEqual(quota.extra, { enabled: true, used: 154.21, limit: 150, currency: "USD" });
  assert.equal(quota.updated, now);
  assert.equal(quota.source, "Claude acct");
});

test("Claude handles alternate limits and malformed endpoint values", () => {
  assert.deepEqual(parseClaudeQuota(null, now).windows, []);
  assert.deepEqual(parseClaudeQuota({ five_hour: { utilization: -1 }, seven_day: { utilization: "95" },
    limits: [{ kind: "weekly_scoped", percent: NaN, scope: {} }] }, now).windows, []);
  assert.deepEqual(parseClaudeQuota({ limits: [{ kind: "session", percent: 95, resets_at: "invalid" },
    { kind: "weekly_all", percent: 100 }] }, now).windows,
  [{ label: "5h", used: 95, reset: undefined }, { label: "week", used: 100, reset: undefined }]);
});

test("Claude rejects each malformed present applicable quota rather than retaining generic windows", () => {
  const valid = { utilization: 25, resets_at: "2026-09-30T12:00:00Z" };
  const scoped = { kind: "weekly_scoped", percent: 25, resets_at: valid.resets_at, scope: { model: { display_name: "Fable" } } };
  const generic = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };
  for (const opus of [{}, { ...valid, utilization: undefined }, { ...valid, utilization: "25" },
    { ...valid, utilization: 101 }, { ...valid, resets_at: undefined }, { ...valid, resets_at: "invalid" }]) {
    assert.deepEqual(parseClaudeQuota({ ...generic, seven_day_opus: opus }, now).windows, []);
  }
  for (const limit of [{ ...scoped, percent: undefined }, { ...scoped, percent: NaN },
    { ...scoped, percent: 101 }, { ...scoped, resets_at: undefined }, { ...scoped, resets_at: "invalid" },
    { ...scoped, scope: undefined }, { ...scoped, scope: { model: { display_name: "" } } }]) {
    assert.deepEqual(parseClaudeQuota({ ...generic, limits: [limit] }, now).windows, []);
  }
  assert.deepEqual(parseClaudeQuota({ ...generic, seven_day_opus: valid, limits: [scoped] }, now).windows.map(w => w.label), ["5h", "week", "Opus", "Fable"]);
  // The live endpoint reports windows a plan does not have as null.
  assert.deepEqual(parseClaudeQuota({ ...generic, five_hour: null, seven_day_opus: null }, now).windows.map(w => w.label), ["week"]);
});

test("Claude headers use fractions and epoch seconds, not endpoint units", () => {
  for (const [fraction, used] of [["0.9499", 94.99], ["0.95", 95], ["1", 100]]) {
    const quota = parseClaudeHeaders({ "Anthropic-Ratelimit-Unified-5h-Utilization": fraction,
      "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 60) }, now);
    assert.ok(Math.abs(quota.windows[0].used - used) < 1e-10);
    assert.equal(quota.windows[0].reset, now + 60_000);
  }
  for (const value of ["", " ", "NaN", "-1", "Infinity"]) {
    assert.equal(parseClaudeHeaders({ "anthropic-ratelimit-unified-5h-utilization": value }, now), undefined);
  }
  assert.equal(parseClaudeHeaders({}, now), undefined);
});

test("Codex endpoint preserves boundaries and prioritizes epoch reset over relative reset", () => {
  const quota = parseCodexUsage({ rate_limit: {
    primary_window: { used_percent: 94.99, limit_window_seconds: 18000, reset_at: now / 1000 + 120, reset_after_seconds: 30 },
    secondary_window: { used_percent: 95, limit_window_seconds: 604800, reset_after_seconds: 60 },
  }, additional_rate_limits: [{ limit_name: "reserve", rate_limit: { primary_window: { used_percent: 100 } } }] }, now);
  assert.deepEqual(quota.windows, [
    { label: "5h", used: 94.99, reset: now + 120_000 },
    { label: "week", used: 95, reset: now + 60_000 },
    { label: "reserve", used: 100, reset: undefined },
  ]);
  assert.equal(quota.source, "Codex acct");
  assert.equal(codexWindowLabel(86400, "primary"), "1d");
  assert.equal(codexWindowLabel(undefined, "primary"), "primary");
  assert.deepEqual(parseCodexUsage(null, now).windows, []);
  assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "95" }, secondary_window: { used_percent: -1 } } }, now).windows, []);
});

test("Codex headers parse case-insensitively, resets and malformed values", () => {
  const quota = parseCodexHeaders({ "X-Codex-Primary-Used-Percent": "95", "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(now / 1000 + 120), "x-codex-primary-reset-after-seconds": "30",
    "x-codex-secondary-used-percent": "100", "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-after-seconds": "60" }, now);
  assert.deepEqual(quota.windows, [{ label: "5h", used: 95, reset: now + 120_000 }, { label: "week", used: 100, reset: now + 60_000 }]);
  for (const value of ["", " ", "NaN", "-1", "Infinity"]) {
    assert.equal(parseCodexHeaders({ "x-codex-primary-used-percent": value }, now), undefined);
  }
  assert.equal(parseCodexHeaders({}, now), undefined);
});

test("partial header merges retain old window observation times and replace reset semantics", () => {
  const old = now - 11 * 60_000;
  const base = parseClaudeQuota({ five_hour: { utilization: 80, resets_at: now + 300_000 }, seven_day: { utilization: 95 },
    limits: [{ kind: "weekly_scoped", percent: 100, resets_at: now + 300_000, scope: { model: { display_name: "Fable" } } }] }, old);
  const update = parseClaudeHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.9499" }, now);
  const merged = mergeQuota(base, update);
  assert.equal(merged.updated, now);
  assert.ok(Math.abs(merged.windows[0].used - 94.99) < 1e-10);
  assert.equal(merged.windows[0].reset, undefined);
  assert.equal(merged.windows[0].observedAt, now);
  assert.deepEqual(merged.windows.slice(1).map(w => [w.label, w.observedAt]), [["week", old], ["Fable", old]]);
  const next = mergeQuota(merged, parseClaudeHeaders({ "anthropic-ratelimit-unified-7d-utilization": "1" }, now + 1000));
  assert.deepEqual(next.windows.map(w => w.observedAt), [now, now + 1000, old]);
  assert.equal(mergeQuota(undefined, update).windows[0].observedAt, now);
});

test("Codex header merge retains named pools and their timestamps", () => {
  const base = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } },
    additional_rate_limits: [{ limit_name: "reserve", rate_limit: { primary_window: { used_percent: 100 } } }] }, now - 60_000);
  const update = parseCodexHeaders({ "x-codex-primary-used-percent": "94.99", "x-codex-primary-window-minutes": "10080" }, now);
  assert.deepEqual(mergeQuota(base, update).windows.map(w => [w.label, w.used, w.observedAt]),
    [["week", 94.99, now], ["reserve", 100, now - 60_000]]);
});

test("Codex streamed events translate window minutes and reset values", () => {
  const event = codexRateLimitsEvent({ type: "codex.rate_limits", rate_limits: {
    primary: { used_percent: 95, window_minutes: 300, reset_after_seconds: 60 },
    secondary: { used_percent: 100, window_minutes: 10080, reset_at: now / 1000 + 120 },
  } });
  assert.deepEqual(parseCodexUsage(event, now).windows, [
    { label: "5h", used: 95, reset: now + 60_000 }, { label: "week", used: 100, reset: now + 120_000 },
  ]);
  assert.equal(codexRateLimitsEvent({ type: "response.created" }), undefined);
});

test("cold Anthropic read is single-flight, cached, and bound to the Pi credential", async () => {
  await isolatedCache();
  const fetcher = vi.fn(async () => json({ five_hour: { utilization: 94.99, resets_at: Date.now() + 3600_000 } }));
  vi.stubGlobal("fetch", fetcher);
  const first = context("sk-ant-oat-test-account-a");
  const [a, b] = await Promise.all([readPiAnthropicUsage(first), readPiAnthropicUsage(first)]);
  assert.equal(a.state, "ready");
  assert.equal(b.windows[0].used, 94.99);
  assert.equal(fetcher.mock.calls.length, 1);
  assert.equal((await readPiAnthropicUsage(first)).state, "ready");
  assert.equal(fetcher.mock.calls.length, 1);
  await readPiAnthropicUsage(context("sk-ant-oat-test-account-b"));
  assert.equal(fetcher.mock.calls.length, 2);
  assert.equal((await readPiAnthropicUsage(context("sk-ant-api-key"))).state, "unavailable");
  assert.equal(fetcher.mock.calls.length, 2);
});

for (const kind of ["Opus", "scoped", "JSON"]) test(`a newly malformed Claude ${kind} response invalidates prior ready memory and disk cache`, async () => {
  await isolatedCache();
  let clock = Date.now();
  const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
  try {
    const token = "sk-ant-oat-test-applicable-quota";
    let body = { five_hour: { utilization: 10, resets_at: clock + 3600_000 },
      seven_day_opus: { utilization: 90, resets_at: clock + 3600_000 } };
    const fetcher = vi.fn(async () => kind === "JSON" && body === null ? new Response("bad json") : json(body));
    vi.stubGlobal("fetch", fetcher);
    assert.equal((await readPiAnthropicUsage(context(token))).state, "ready");
    clock += 300_000;
    body = kind === "JSON" ? null : { five_hour: { utilization: 10, resets_at: clock + 3600_000 },
      ...(kind === "Opus" ? { seven_day_opus: { utilization: "0", resets_at: new Date(clock + 3600_000).toISOString() } } :
        { limits: [{ kind: "weekly_scoped", percent: "0", resets_at: new Date(clock + 3600_000).toISOString(), scope: { model: { display_name: "Fable" } } }] }) };
    const malformed = await readPiAnthropicUsage(context(token));
    assert.equal(malformed.state, "unavailable");
    assert.deepEqual(malformed.windows, []);
    assert.doesNotMatch(JSON.stringify(malformed), /sk-ant|Fable/);
    assert.equal(fetcher.mock.calls.length, 2);
    // A new module instance must not recover the previously persisted ready reading.
    vi.resetModules();
    const coldRead = (await import("../src/account-usage.ts")).readPiAnthropicUsage;
    assert.equal((await coldRead(context(token))).state, "unavailable");
    assert.equal((await readPiAnthropicUsage(context(token))).state, "unavailable");
    assert.equal(fetcher.mock.calls.length, 4);
  } finally { date.mockRestore(); }
});

test("Codex reads only account-bound OAuth diagnostics and rejects reset-due readings", async () => {
  await isolatedCache();
  const token = account => `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.s`;
  const fetcher = vi.fn(async () => json({ rate_limit: { primary_window: { used_percent: 95, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }));
  vi.stubGlobal("fetch", fetcher);
  const result = await readCodexUsage(context(token("account-a")));
  assert.equal(result.state, "ready");
  assert.match(result.reason, /Diagnostic/);
  assert.equal((await readCodexUsage(context(token("account-a")))).state, "ready");
  assert.equal(fetcher.mock.calls.length, 1);
  fetcher.mockImplementation(async () => json({ rate_limit: { primary_window: { used_percent: 0, reset_at: 1 } } }));
  assert.equal((await readCodexUsage(context(token("account-b")))).state, "unavailable");
  assert.equal((await readCodexUsage(context("api-key"))).state, "unavailable");
});

test("abort prevents quota calls and errors never expose credentials", async () => {
  await isolatedCache();
  const fetcher = vi.fn(async () => { throw new Error("secret credential"); });
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController(); controller.abort();
  const aborted = await readPiAnthropicUsage(context("sk-ant-oat-test-abort"), { signal: controller.signal });
  assert.equal(aborted.state, "unavailable");
  assert.equal(fetcher.mock.calls.length, 0);
  const failed = await readPiAnthropicUsage(context("sk-ant-oat-test-error"));
  assert.equal(failed.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(failed), /secret|sk-ant/);
});

test("a cross-process lock prevents a competing fetch until released", async () => {
  const dir = await isolatedCache();
  const token = "sk-ant-oat-locked-account";
  const cache = path.join(dir, "pi-subscription-usage");
  await mkdir(cache, { mode: 0o700 });
  const lock = path.join(cache, `anthropic-${createHash("sha256").update(token).digest("hex")}.json.lock`);
  await mkdir(lock, { mode: 0o700 });
  const fetcher = vi.fn(async () => json({ five_hour: { utilization: 10, resets_at: Date.now() + 3600_000 } }));
  vi.stubGlobal("fetch", fetcher);
  const pending = readPiAnthropicUsage(context(token));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(fetcher.mock.calls.length, 0);
  await rm(lock, { recursive: true });
  assert.equal((await pending).state, "ready");
  assert.equal(fetcher.mock.calls.length, 1);
});

test("a registry that never resolves is bounded by the five-second deadline", async () => {
  vi.useFakeTimers();
  try {
    const pending = readPiAnthropicUsage({ modelRegistry: { getApiKeyForProvider: () => new Promise(() => {}) } });
    await vi.advanceTimersByTimeAsync(5_001);
    assert.equal((await pending).state, "unavailable");
  } finally { vi.useRealTimers(); }
});

const collectors = [
  {
    provider: "anthropic", read: readPiAnthropicUsage,
    token: account => `sk-ant-oat-test-${account}`,
    quota: used => ({ five_hour: { utilization: used, resets_at: Date.now() + 3600_000 } }),
    exportName: "readPiAnthropicUsage",
  },
  {
    provider: "openai-codex", read: readCodexUsage,
    token: account => `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.s`,
    quota: used => ({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000,
      reset_at: Math.floor(Date.now() / 1000) + 3600 } } }),
    exportName: "readCodexUsage",
  },
];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

for (const collector of collectors) {
  test(`${collector.provider} consults only its exact legacy provider, with no auth fallback`, async () => {
    await isolatedCache();
    const getApiKeyForProvider = vi.fn(async provider => provider === collector.provider ? undefined : collector.token("fallback"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await collector.read({ modelRegistry: { getApiKeyForProvider } });
    assert.equal(result.state, "unavailable");
    assert.deepEqual(result.windows, []);
    assert.deepEqual(getApiKeyForProvider.mock.calls, [[collector.provider]]);
    assert.equal(fetcher.mock.calls.length, 0);
  });

  for (const changedTo of ["account-b", undefined]) {
    test(`${collector.provider} discards account A when ${changedTo ? "switched to B" : "auth is lost"} during I/O`, async () => {
      await isolatedCache();
      let token = collector.token("account-a");
      const getApiKeyForProvider = vi.fn(async () => token);
      const started = deferred(), response = deferred();
      const fetcher = vi.fn(() => { started.resolve(); return response.promise; });
      vi.stubGlobal("fetch", fetcher);
      const pending = collector.read({ modelRegistry: { getApiKeyForProvider } });
      await started.promise;
      token = changedTo ? collector.token(changedTo) : undefined;
      response.resolve(json(collector.quota(91)));
      const result = await pending;
      assert.equal(result.state, "unavailable");
      assert.deepEqual(result.windows, []);
      assert.match(result.reason, /account changed/);
      assert.deepEqual(getApiKeyForProvider.mock.calls, [[collector.provider], [collector.provider]]);
      assert.equal(fetcher.mock.calls.length, 1);
    });
  }

  test(`${collector.provider} isolates cached A, B and missing auth in memory and on disk`, async () => {
    await isolatedCache();
    let token = collector.token("cached-a");
    const ctx = { modelRegistry: { getApiKeyForProvider: async () => token } };
    const fetcher = vi.fn(async (_url, options) => json(collector.quota(
      options.headers.Authorization === `Bearer ${collector.token("cached-a")}` ? 91 : 12)));
    vi.stubGlobal("fetch", fetcher);
    assert.equal((await collector.read(ctx)).windows[0].used, 91);
    token = collector.token("cached-b");
    assert.equal((await collector.read(ctx)).windows[0].used, 12);
    assert.equal(fetcher.mock.calls.length, 2);
    // Reload the module to prove the disk cache is also account-bound, not just memory.
    vi.resetModules();
    const coldRead = (await import("../src/account-usage.ts"))[collector.exportName];
    for (const read of [collector.read, coldRead]) {
      token = collector.token("cached-a");
      assert.equal((await read(ctx)).windows[0].used, 91);
      token = collector.token("cached-b");
      assert.equal((await read(ctx)).windows[0].used, 12);
      token = undefined;
      const missing = await read(ctx);
      assert.equal(missing.state, "unavailable");
      assert.deepEqual(missing.windows, []);
    }
    assert.equal(fetcher.mock.calls.length, 2);
  });

  for (const stalled of ["fetch", "body"]) {
    for (const cancellation of ["deadline", "caller abort"]) {
      test(`${collector.provider} bounds ${stalled} ignoring ${cancellation} and uncooperative cancellation`, async () => {
        await isolatedCache();
        const started = deferred();
        const never = () => new Promise(() => {});
        const cancel = vi.fn(never);
        const fetcher = vi.fn((_url, options) => {
          assert.equal(options.signal.aborted, false);
          if (stalled === "fetch") { started.resolve(); return never(); }
          return Promise.resolve({ ok: true, headers: new Headers(), body: { getReader: () => ({
            read: () => { started.resolve(); return never(); }, cancel,
          }) } });
        });
        vi.stubGlobal("fetch", fetcher);
        vi.useFakeTimers();
        try {
          const controller = new AbortController();
          const pending = collector.read(context(collector.token(`stalled-${stalled}-${cancellation.replaceAll(" ", "-")}`)), { signal: controller.signal });
          await started.promise;
          if (cancellation === "deadline") await vi.advanceTimersByTimeAsync(5_001);
          else controller.abort();
          const result = await pending;
          assert.equal(result.state, "unavailable");
          assert.deepEqual(result.windows, []);
          assert.equal(fetcher.mock.calls.length, 1);
          assert.equal(fetcher.mock.calls[0][1].signal.aborted, true);
          if (stalled === "body") assert.equal(cancel.mock.calls.length, 1);
        } finally { vi.useRealTimers(); }
      });
    }
  }
}

test("Codex account ID comes only from the OAuth JWT auth claim", () => {
  const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  assert.equal(codexAccountId(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })), "acct-1");
  for (const token of ["not-a-jwt", jwt({}), jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "" } }),
    jwt({ "https://api.openai.com/auth": { chatgpt_account_id: 123 } })]) assert.equal(codexAccountId(token), undefined);
});

test("the Claude usage request reports a current Claude Code release", () => {
  assert.equal(claudeCodeUserAgent({}), "claude-code/2.1.284");
  assert.equal(claudeCodeUserAgent({ PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION: " 2.1.300 " }), "claude-code/2.1.300");
  assert.equal(claudeCodeUserAgent({ PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION: "latest" }), "claude-code/2.1.284");
});

test("a rejected Anthropic read reports its HTTP status and error code, never the body", async () => {
  await isolatedCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
    message: "secret detail sk-ant-oat-test-account-z", details: { error_code: "claude_code_version_too_old" } } }), { status: 400 })));
  const reading = await readPiAnthropicUsage(context("sk-ant-oat-test-account-z"));
  assert.equal(reading.state, "unavailable");
  assert.equal(reading.reason, "The usage endpoint answered HTTP 400 (claude_code_version_too_old).");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 429 })));
  const throttled = await readPiAnthropicUsage(context("sk-ant-oat-test-account-y"));
  assert.equal(throttled.reason, "The usage endpoint answered HTTP 429.");
});

test("Claude extra usage records whether its spend cap is reached", () => {
  const quota = parseClaudeQuota({
    seven_day: { utilization: 100, resets_at: "2026-09-30T12:00:00Z" },
    extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 7673, currency: "USD", decimal_places: 2, spend_limit_reached: false },
  }, now);
  assert.equal(quota.windows[0].used, 100);
  assert.deepEqual(quota.extra, { enabled: true, used: 76.73, limit: 100, currency: "USD", capReached: false });
});

test("Codex endpoint records access and only real credit balances", () => {
  const window = { used_percent: 100, limit_window_seconds: 604800, reset_at: 1_800_000_000 };
  const rate_limit = { allowed: true, limit_reached: false, primary_window: window };
  assert.deepEqual(parseCodexUsage({ rate_limit, credits: { has_credits: false, balance: "0", unlimited: false } }, now).access, { allowed: true, limitReached: false });
  assert.deepEqual(parseCodexUsage({ rate_limit, credits: { has_credits: true, balance: "12.5", unlimited: false } }, now).access,
    { allowed: true, limitReached: false, credits: { balance: 12.5, unlimited: false } });
  assert.equal(parseCodexUsage({ rate_limit, credits: { has_credits: true, balance: "abc", unlimited: false } }, now).access.credits, undefined);
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: window } }, now).access, undefined);
});

test("account readers carry extra usage and access through memory and disk cache", async () => {
  await isolatedCache();
  const reset = () => Math.floor(Date.now() / 1000) + 3600;
  const claudeBody = () => ({ seven_day: { utilization: 100, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 7673, currency: "USD", decimal_places: 2, spend_limit_reached: true } });
  const codexBody = () => ({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: reset() } },
    credits: { has_credits: true, balance: "3", unlimited: false } });
  const fetcher = vi.fn(async url => json(String(url).includes("anthropic") ? claudeBody() : codexBody()));
  vi.stubGlobal("fetch", fetcher);
  const token = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-x" } })).toString("base64url")}.s`;
  const claudeExpected = { enabled: true, used: 76.73, limit: 100, currency: "USD", capReached: true };
  const codexExpected = { allowed: true, limitReached: false, credits: { balance: 3, unlimited: false } };
  assert.deepEqual((await readPiAnthropicUsage(context("sk-ant-oat-test-extra"))).extra, claudeExpected);
  assert.deepEqual((await readCodexUsage(context(token))).access, codexExpected);
  assert.equal(fetcher.mock.calls.length, 2);
  vi.resetModules();
  const cold = await import("../src/account-usage.ts");
  assert.deepEqual((await cold.readPiAnthropicUsage(context("sk-ant-oat-test-extra"))).extra, claudeExpected);
  assert.deepEqual((await cold.readCodexUsage(context(token))).access, codexExpected);
  assert.equal(fetcher.mock.calls.length, 2);
});

test("mergeQuota keeps access from the base", () => {
  const base = { source: "Codex acct", updated: now, windows: [{ label: "week", used: 100 }], access: { allowed: true } };
  const merged = mergeQuota(base, { source: "Codex acct", updated: now + 1, windows: [{ label: "week", used: 100 }] });
  assert.deepEqual(merged.access, { allowed: true });
});

test("a fresh cache file from a writer without extra usage support is refetched once", async () => {
  const dir = await isolatedCache();
  const token = "sk-ant-oat-test-legacy-writer";
  const account = createHash("sha256").update(token).digest("hex");
  const at = Date.now();
  const { writeFile, chmod } = await import("node:fs/promises");
  await mkdir(path.join(dir, "pi-subscription-usage"), { mode: 0o700 });
  const file = path.join(dir, "pi-subscription-usage", `anthropic-${account}.json`);
  await writeFile(file, JSON.stringify({ version: 1, account, provider: "anthropic", updated: at,
    windows: [{ label: "week", used: 100, reset: at + 3600_000, observedAt: at }] }), { mode: 0o600 });
  await chmod(file, 0o600);
  const fetcher = vi.fn(async () => json({ seven_day: { utilization: 100, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 7673, currency: "USD", decimal_places: 2 } }));
  vi.stubGlobal("fetch", fetcher);
  const first = await readPiAnthropicUsage(context(token));
  assert.equal(fetcher.mock.calls.length, 1);
  assert.deepEqual(first.extra, { enabled: true, used: 76.73, limit: 100, currency: "USD" });
  vi.resetModules();
  const cold = await import("../src/account-usage.ts");
  assert.deepEqual((await cold.readPiAnthropicUsage(context(token))).extra, first.extra);
  assert.equal(fetcher.mock.calls.length, 1);
});

const sonnetTarget = { provider: "anthropic", id: "claude-sonnet-4" };
function selectionContext(getToken = async () => "sk-ant-oat-selection-tests") {
  return { modelRegistry: {
    getApiKeyForProvider: vi.fn(getToken),
    find: vi.fn((provider, id) => ({ provider, id, type: "chat",
      api: provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses",
      baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://chatgpt.com/backend-api" })),
    isUsingOAuth: vi.fn(() => true),
  } };
}
const assertNeutral = (result, state = "unavailable") => {
  assert.equal(result.state, state);
  assert.equal(result.tier, "none");
  assert.equal(result.p, 0);
  assert.equal(result.label, undefined);
};

// These exercise the boundary API itself, not only the shared account collector.
test("mixed fresh weekly and reset-due 5h quota is unavailable until a fully fresh snapshot recovers", async () => {
  const cwd = await isolatedCache();
  const clock = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(clock);
  const ctx = selectionContext();
  const fetcher = vi.fn(async () => json({
    five_hour: { utilization: 99, resets_at: clock },
    seven_day: { utilization: 90, resets_at: clock + 7 * 86400_000 },
  }));
  vi.stubGlobal("fetch", fetcher);
  const record = vi.spyOn(Tracker.prototype, "record"), assess = vi.spyOn(Tracker.prototype, "assess");
  assertNeutral(await readSelectionPressure(ctx, sonnetTarget, { cwd }));
  assert.equal(record.mock.calls.length, 0);
  assert.equal(assess.mock.calls.length, 0);
  // The strict footer/waterfall reader rejects the same whole account snapshot.
  assert.equal((await readPiAnthropicUsage(ctx)).state, "unavailable");
  fetcher.mockImplementation(async () => json({
    five_hour: { utilization: 10, resets_at: clock + 5 * 3600_000 },
    seven_day: { utilization: 90, resets_at: clock + 7 * 86400_000 },
  }));
  const recovered = await readSelectionPressure(ctx, sonnetTarget, { cwd });
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.p, 1);
  assert.equal(recovered.label, "week");
  assert.equal(record.mock.calls.length, 2);
  assert.equal(assess.mock.calls.length, 1);
  assert.equal((await readPiAnthropicUsage(ctx)).state, "ready");
  assert.equal(fetcher.mock.calls.length, 3);
});

for (const invalid of ["reset", "age", "future"]) test(`whole-account ${invalid} freshness is rechecked after the final identity await`, async () => {
  const cwd = await isolatedCache();
  let clock = Date.now();
  const observedAt = clock;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  // identity is read before selection, before collection, after collection, and
  // finally before recording. Only that last await advances time.
  let identities = 0;
  const ctx = selectionContext(async () => {
    if (++identities === 4) clock += invalid === "age" ? 600_000 : invalid === "future" ? -1 : 1000;
    return "sk-ant-oat-final-freshness";
  });
  vi.stubGlobal("fetch", vi.fn(async () => json({
    five_hour: { utilization: 10, resets_at: observedAt + (invalid === "reset" ? 1000 : 3600_000) },
    seven_day: { utilization: 90, resets_at: observedAt + 7 * 86400_000 },
  })));
  const record = vi.spyOn(Tracker.prototype, "record"), assess = vi.spyOn(Tracker.prototype, "assess");
  assertNeutral(await readSelectionPressure(ctx, sonnetTarget, { cwd }));
  assert.equal(identities, 4);
  assert.equal(record.mock.calls.length, 0);
  assert.equal(assess.mock.calls.length, 0);
});

for (const change of ["account", "auth", "route", "oauth", "cancel"]) {
  for (const stage of ["fetch", "final identity"]) test(`boundary discards stale pressure on ${change} during ${stage}`, async () => {
    const cwd = await isolatedCache();
    let token = "sk-ant-oat-selection-a", identities = 0;
    const controller = new AbortController();
    const started = deferred(), response = deferred();
    const ctx = selectionContext(async () => {
      if (++identities === 4 && stage === "final identity") mutate();
      return token;
    });
    function mutate() {
      if (change === "account") token = "sk-ant-oat-selection-b";
      if (change === "auth") token = undefined;
      if (change === "route") ctx.modelRegistry.find.mockImplementation((provider, id) => ({ provider, id, api: "anthropic-messages", baseUrl: "http://localhost:8080" }));
      if (change === "oauth") ctx.modelRegistry.isUsingOAuth.mockReturnValue(false);
      if (change === "cancel") controller.abort();
    }
    const fetcher = vi.fn(() => { started.resolve(); return response.promise; });
    vi.stubGlobal("fetch", fetcher);
    const record = vi.spyOn(Tracker.prototype, "record"), assess = vi.spyOn(Tracker.prototype, "assess");
    const pending = readSelectionPressure(ctx, sonnetTarget, { cwd, signal: controller.signal });
    await started.promise;
    if (stage === "fetch") mutate();
    response.resolve(json({ five_hour: { utilization: 99, resets_at: Date.now() + 3600_000 } }));
    assertNeutral(await pending);
    assert.equal(record.mock.calls.length, 0);
    assert.equal(assess.mock.calls.length, 0);
    // A later, healthy account must not inherit account A's rejected critical tier.
    const healthy = selectionContext(async () => "sk-ant-oat-selection-b");
    fetcher.mockImplementation(async () => json({ five_hour: { utilization: 10, resets_at: Date.now() + 3600_000 } }));
    assert.equal((await readSelectionPressure(healthy, sonnetTarget, { cwd })).p, 0);
  });
}

test("boundary normalizes percentages and week duration without manufacturing cache observations", async () => {
  const cwd = await isolatedCache();
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const observedAt = clock;
  const ctx = selectionContext();
  const fetcher = vi.fn(async () => json({ seven_day: { utilization: 30, resets_at: observedAt + 6 * 86400_000 } }));
  vi.stubGlobal("fetch", fetcher);
  const record = vi.spyOn(Tracker.prototype, "record"), assess = vi.spyOn(Tracker.prototype, "assess");
  assert.equal((await readSelectionPressure(ctx, sonnetTarget, { cwd })).p, 0);
  assert.deepEqual(record.mock.calls, [[{ window: "week", used: 0.3, at: observedAt, resetsAt: observedAt + 6 * 86400_000, lengthMs: 7 * 86400_000 }]]);
  // With seven-day normalization this is a warming critical pace (30% in one
  // day). Confirm at the next selection, reusing the exact original observation.
  clock += 299_999;
  assert.equal(assess.mock.calls.length, 1);
  assert.equal((await readSelectionPressure(ctx, sonnetTarget, { cwd })).p, 0);
  clock++;
  fetcher.mockRejectedValue(new Error("offline"));
  assert.equal((await readSelectionPressure(ctx, sonnetTarget, { cwd })).p, 1);
  assert.equal(record.mock.calls.length, 1);
  assert.equal(assess.mock.calls.length, 3);
  clock = observedAt + 599_999;
  assert.equal((await readSelectionPressure(ctx, sonnetTarget, { cwd })).state, "ready");
  clock++;
  assertNeutral(await readSelectionPressure(ctx, sonnetTarget, { cwd }));
  assert.equal(record.mock.calls.length, 1);
  assert.equal(assess.mock.calls.length, 4);
});

for (const body of [null, {}, { five_hour: { utilization: "90", resets_at: 1 } },
  { five_hour: { utilization: 90 } }, { five_hour: { utilization: 90, resets_at: 1 } },
  { five_hour: { utilization: 10, resets_at: 1 }, seven_day_opus: { utilization: "90", resets_at: 1 } }]) {
  test(`boundary returns neutral unknown for missing/malformed/expired quota ${JSON.stringify(body)}`, async () => {
    const cwd = await isolatedCache();
    vi.stubGlobal("fetch", vi.fn(async () => json(body)));
    const record = vi.spyOn(Tracker.prototype, "record");
    assertNeutral(await readSelectionPressure(selectionContext(), sonnetTarget, { cwd }));
    assert.equal(record.mock.calls.length, 0);
  });
}

test("disabled pressure skips identity, registry and network work", async () => {
  const cwd = await isolatedCache();
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi", "quota-pressure.json"), JSON.stringify({ limits: { enabled: false } }));
  const ctx = selectionContext(), fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  assertNeutral(await readSelectionPressure(ctx, sonnetTarget, { cwd }), "disabled");
  assert.equal(ctx.modelRegistry.find.mock.calls.length, 0);
  assert.equal(ctx.modelRegistry.getApiKeyForProvider.mock.calls.length, 0);
  assert.equal(fetcher.mock.calls.length, 0);
});

for (const model of [undefined,
  { provider: "anthropic", id: "different" },
  { provider: "anthropic", id: sonnetTarget.id, type: "embedding", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  { ...sonnetTarget, api: "openai-completions", baseUrl: "https://api.anthropic.com" },
  { ...sonnetTarget, api: "anthropic-messages", baseUrl: "http://localhost:8080" },
  { ...sonnetTarget, api: "anthropic-messages", baseUrl: "https://api.anthropic.com/proxy" }]) {
  test(`unregistered/nonphysical/unsupported route skips quota I/O: ${JSON.stringify(model)}`, async () => {
    const cwd = await isolatedCache();
    const ctx = selectionContext(); ctx.modelRegistry.find.mockReturnValue(model);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    assertNeutral(await readSelectionPressure(ctx, sonnetTarget, { cwd }), "not-applicable");
    assert.equal(ctx.modelRegistry.getApiKeyForProvider.mock.calls.length, 0);
    assert.equal(fetcher.mock.calls.length, 0);
  });
}

test("scoped Anthropic windows never leak across targets or shared selection", async () => {
  const cwd = await isolatedCache();
  const ctx = selectionContext();
  const fetcher = vi.fn(async () => json({ five_hour: { utilization: 0.5, resets_at: Date.now() + 3600_000 },
    limits: [{ kind: "weekly_scoped", percent: 99, resets_at: Date.now() + 86400_000, scope: { model: { display_name: "Fable" } } }] }));
  vi.stubGlobal("fetch", fetcher);
  for (const id of ["claude-fable-4", "claude-sonnet-4", "claude-opus-4", "claude-fablelike-4"]) {
    const target = { provider: "anthropic", id };
    assert.equal((await readSelectionPressure(ctx, target, { cwd })).p, id === "claude-fable-4" ? 1 : 0);
    assert.equal((await readSelectionPressure(ctx, target, { cwd, scope: "shared" })).p, 0);
  }
  assert.equal(fetcher.mock.calls.length, 1);
});

for (const label of ["primary", "secondary", "week", "2h", "1d"]) test(`legacy Codex common ${label} excludes named additional pools and modern OpenAI`, async () => {
  const cwd = await isolatedCache();
  const token = collectors[1].token("selection-codex");
  const ctx = selectionContext(async () => token);
  const seconds = { week: 604800, "2h": 7200, "1d": 86400 }[label];
  const key = label === "secondary" ? "secondary_window" : "primary_window";
  const fetcher = vi.fn(async () => json({ rate_limit: { [key]: { used_percent: 65, limit_window_seconds: seconds, reset_after_seconds: 3600 } },
    additional_rate_limits: [{ limit_name: "reserve", rate_limit: { primary_window: { used_percent: 99, reset_after_seconds: 3600 } } }] }));
  vi.stubGlobal("fetch", fetcher);
  const target = { provider: "openai-codex", id: "gpt-codex" };
  const record = vi.spyOn(Tracker.prototype, "record");
  for (const scope of ["shared", "target"]) {
    const result = await readSelectionPressure(ctx, target, { cwd, scope });
    assert.equal(result.state, "ready"); assert.equal(result.p, 0.5);
    assert.ok([label, "5h", "7d"].includes(result.label));
  }
  assert.equal(record.mock.calls.length, 2);
  assert.equal(record.mock.calls[0][0].window, label);
  assert.equal(record.mock.calls[0][0].used, 0.65);
  if (seconds) assert.equal(record.mock.calls[0][0].lengthMs, seconds * 1000);
  assert.equal(fetcher.mock.calls.length, 1);
  ctx.modelRegistry.getApiKeyForProvider.mockClear();
  assertNeutral(await readSelectionPressure(ctx, { provider: "openai", id: "gpt" }, { cwd }), "not-applicable");
  assert.equal(ctx.modelRegistry.getApiKeyForProvider.mock.calls.length, 0);
});

test("concurrent boundary callers share collection, not cancellation or manufactured observations", async () => {
  const cwd = await isolatedCache();
  const ctx = selectionContext();
  const started = deferred(), response = deferred(), joined = deferred();
  let identities = 0;
  ctx.modelRegistry.getApiKeyForProvider.mockImplementation(async () => {
    if (++identities === 6) joined.resolve(); // all three have reached readUsage
    return "sk-ant-oat-concurrent-selection";
  });
  const fetcher = vi.fn(() => { started.resolve(); return response.promise; });
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const record = vi.spyOn(Tracker.prototype, "record"), assess = vi.spyOn(Tracker.prototype, "assess");
  const pending = [readSelectionPressure(ctx, sonnetTarget, { cwd, signal: controller.signal }),
    readSelectionPressure(ctx, sonnetTarget, { cwd }), readSelectionPressure(ctx, sonnetTarget, { cwd })];
  await Promise.all([started.promise, joined.promise]);
  controller.abort();
  assertNeutral(await pending[0]);
  response.resolve(json({ five_hour: { utilization: 90, resets_at: Date.now() + 3600_000 } }));
  assert.deepEqual((await Promise.all(pending.slice(1))).map(r => r.p), [1, 1]);
  assert.equal(fetcher.mock.calls.length, 1);
  assert.equal(record.mock.calls.length, 1);
  assert.equal(assess.mock.calls.length, 2);
});

for (const isolation of ["account", "cache root"]) test(`boundary Tracker history is isolated by ${isolation}`, async () => {
  const cwd = await isolatedCache();
  const clock = Date.now(); vi.spyOn(Date, "now").mockReturnValue(clock);
  let used = 81, token = "sk-ant-oat-history-a";
  const ctx = selectionContext(async () => token);
  const fetcher = vi.fn(async () => json({ five_hour: { utilization: used, resets_at: clock + 3600_000 } }));
  vi.stubGlobal("fetch", fetcher);
  assert.equal((await readSelectionPressure(ctx, sonnetTarget, { cwd })).p, 1);
  // A one-point drop would retain critical under Tracker hysteresis if reused.
  used = 79;
  if (isolation === "account") token = "sk-ant-oat-history-b";
  else await isolatedCache();
  assert.equal((await readSelectionPressure(ctx, sonnetTarget, { cwd })).p, 0.5);
  assert.equal(fetcher.mock.calls.length, 2);
});

test("boundary Tracker history has a bounded 32-entry LRU, not a provider-global tier", async () => {
  const cwd = await isolatedCache();
  let clock = Date.now(), used = 81;
  const reset = clock + 3600_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  // A fresh module isolates the LRU itself, not just each observation's cache root.
  vi.resetModules();
  const { readSelectionPressure: read } = await import("../src/account-usage.ts");
  const ctx = selectionContext();
  const fetcher = vi.fn(async () => json({ five_hour: { utilization: used, resets_at: reset } }));
  vi.stubGlobal("fetch", fetcher);
  const targets = Array.from({ length: 33 }, (_, i) => ({ provider: "anthropic", id: `claude-sonnet-${i}` }));
  for (const target of targets.slice(0, 32)) assert.equal((await read(ctx, target, { cwd })).p, 1);
  await read(ctx, targets[0], { cwd }); // touch oldest so target 1, not 0, is evicted
  await read(ctx, targets[32], { cwd });
  clock += 300_000; used = 79;
  // The retained tier holds under hysteresis; an evicted target starts at caution.
  assert.equal((await read(ctx, targets[0], { cwd })).p, 1);
  assert.equal((await read(ctx, targets[1], { cwd })).p, 0.5);
  assert.equal(fetcher.mock.calls.length, 2);
});

test("a boundary's final uncooperative identity await is bounded and never records quota", async () => {
  const cwd = await isolatedCache();
  let identities = 0;
  const stalled = deferred();
  const ctx = selectionContext(() => {
    if (++identities === 4) { stalled.resolve(); return new Promise(() => {}); }
    return Promise.resolve("sk-ant-oat-final-stall");
  });
  vi.stubGlobal("fetch", vi.fn(async () => json({ five_hour: { utilization: 99, resets_at: Date.now() + 3600_000 } })));
  const record = vi.spyOn(Tracker.prototype, "record");
  vi.useFakeTimers();
  try {
    const pending = readSelectionPressure(ctx, sonnetTarget, { cwd });
    await stalled.promise;
    await vi.advanceTimersByTimeAsync(5_001);
    assertNeutral(await pending);
    assert.equal(record.mock.calls.length, 0);
  } finally { vi.useRealTimers(); }
});

for (const stale of [false, true]) test(`boundary ${stale ? "rejects" : "preserves"} original per-window observation timestamps from shared cache`, async () => {
  const cwd = await isolatedCache();
  const clock = Date.now(); vi.spyOn(Date, "now").mockReturnValue(clock);
  const token = "sk-ant-oat-window-ages";
  const account = createHash("sha256").update(token).digest("hex");
  const root = path.join(cwd, "pi-subscription-usage");
  await mkdir(root, { mode: 0o700 });
  const windows = [{ label: "5h", used: 10, reset: clock + 3600_000, observedAt: clock },
    { label: "week", used: 20, reset: clock + 6 * 86400_000, observedAt: clock - 60_000 },
    { label: "Fable", used: 99, reset: clock + 86400_000, observedAt: clock - (stale ? 600_000 : 120_000) }];
  await writeFile(path.join(root, `anthropic-${account}.json`), JSON.stringify({ version: 1, detail: 2,
    account, provider: "anthropic", updated: clock, windows }), { mode: 0o600 });
  const fetcher = vi.fn(async () => { throw new Error("offline"); }); vi.stubGlobal("fetch", fetcher);
  const record = vi.spyOn(Tracker.prototype, "record");
  const ctx = selectionContext(async () => token);
  const result = await readSelectionPressure(ctx, sonnetTarget, { cwd, scope: "shared" });
  if (stale) {
    // Even an out-of-scope family window invalidates the whole account snapshot.
    assertNeutral(result);
    assert.equal(record.mock.calls.length, 0);
    assert.equal(fetcher.mock.calls.length, 1);
  } else {
    assert.equal(result.state, "ready");
    assert.deepEqual(record.mock.calls.map(([r]) => [r.window, r.used, r.at]), [["5h", 0.1, clock], ["week", 0.2, clock - 60_000]]);
    assert.equal(fetcher.mock.calls.length, 0);
  }
});

test("family-only quota is unavailable, not healthy, outside its target scope", async () => {
  const cwd = await isolatedCache();
  vi.stubGlobal("fetch", vi.fn(async () => json({ limits: [{ kind: "weekly_scoped", percent: 99,
    resets_at: Date.now() + 86400_000, scope: { model: { display_name: "Fable" } } }] })));
  const ctx = selectionContext(), fable = { provider: "anthropic", id: "claude-fable-4" };
  assertNeutral(await readSelectionPressure(ctx, sonnetTarget, { cwd }));
  assertNeutral(await readSelectionPressure(ctx, fable, { cwd, scope: "shared" }));
  assert.equal((await readSelectionPressure(ctx, fable, { cwd })).p, 1);
});
