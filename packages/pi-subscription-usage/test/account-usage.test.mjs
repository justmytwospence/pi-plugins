import assert from "node:assert/strict";
import { test, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseClaudeQuota, parseClaudeHeaders, parseCodexUsage, parseCodexHeaders,
  codexAccountId, codexRateLimitsEvent, codexWindowLabel, mergeQuota, readPiAnthropicUsage, readCodexUsage,
} from "../src/account-usage.ts";

const now = Date.parse("2026-09-23T12:00:00Z");
const directories = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function isolatedCache() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-usage-test-"));
  directories.push(dir);
  vi.stubEnv("XDG_CACHE_HOME", dir);
  return dir;
}
const context = token => ({ modelRegistry: { getApiKeyForProvider: async () => token } });
const json = body => new Response(JSON.stringify(body), { status: 200 });

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
  for (const opus of [null, {}, { ...valid, utilization: undefined }, { ...valid, utilization: "25" },
    { ...valid, utilization: 101 }, { ...valid, resets_at: undefined }, { ...valid, resets_at: "invalid" }]) {
    assert.deepEqual(parseClaudeQuota({ ...generic, seven_day_opus: opus }, now).windows, []);
  }
  for (const limit of [{ ...scoped, percent: undefined }, { ...scoped, percent: NaN },
    { ...scoped, percent: 101 }, { ...scoped, resets_at: undefined }, { ...scoped, resets_at: "invalid" },
    { ...scoped, scope: undefined }, { ...scoped, scope: { model: { display_name: "" } } }]) {
    assert.deepEqual(parseClaudeQuota({ ...generic, limits: [limit] }, now).windows, []);
  }
  assert.deepEqual(parseClaudeQuota({ ...generic, seven_day_opus: valid, limits: [scoped] }, now).windows.map(w => w.label), ["5h", "week", "Opus", "Fable"]);
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
