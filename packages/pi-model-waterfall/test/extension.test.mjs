import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import modelWaterfall from "../src/index.ts";
import { queryWaterfall, WATERFALL_CHANNEL } from "../src/waterfall-contract.ts";

const now = () => Date.now();
const quota = (provider, used = 10) => ({ provider, source: "test OAuth", state: "ready", observedAt: now(),
  windows: ["5h", "week"].map(label => ({ label, used, observedAt: now(), reset: now() + 60_000 })) });
let claude, google, reads, googleReads, sources, collectors, disposed, googleRead, googleCredential;
vi.mock("@justmytwospence/pi-subscription-usage", () => ({
  isUsageStale: (reading, time) => reading.observedAt >= time + 30_000 || time - reading.observedAt >= 600_000 ||
    reading.windows.some(w => w.reset <= time || (w.observedAt !== undefined && time - w.observedAt >= 600_000)),
  readPiAnthropicUsage: async () => { reads++; return structuredClone(claude); },
  createProviderUsageCollector: () => { collectors++; return { refresh: async source => { googleReads++; sources.push(source); return googleRead ? googleRead(source) : structuredClone(google); }, dispose() { disposed++; } }; },
}));
const models = [
  { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", reasoning: true, baseUrl: "https://api.anthropic.com" },
  { provider: "openai", id: "gpt-6.1-sol", api: "openai-responses" },
  { provider: "google", id: "antigravity-gemini-4-argon", api: "google", reasoning: true, baseUrl: "https://cloudcode-pa.googleapis.com" },
  { provider: "muse-sdk", id: "muse-wonder-1.0", api: "muse" },
];
const fixture = (available = models) => {
  const handlers = new Map(), events = new Map(), commands = new Map(); let virtual;
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    events: { on(name, fn) { events.set(name, fn); }, emit(name, request) { events.get(name)?.(request); } },
    registerVirtualModel(definition) { virtual = definition; }, registerCommand(name, command) { commands.set(name, command); },
  };
  modelWaterfall(pi);
  const output = [];
  const ctx = {
    modelRegistry: {
      find(provider, id) { return available.find(m => m.provider === provider && m.id === id); },
      isUsingOAuth(model) { return model.provider !== "muse-sdk"; },
      async getApiKeyForProvider() { return googleCredential; },
    },
    ui: { notify(...args) { output.push(args); } },
  };
  const request = (options = {}) => ({ reason: "user", thinkingLevel: "medium", messages: [{ role: "user", content: "hello" }], ...options });
  return { pi, ctx, handlers, commands, get route() { return virtual.route; }, request, output };
};
const googleQuota = () => ({ provider: "google", source: "Antigravity", state: "ready", observedAt: now(), windows: [
  { label: "5h", pool: "Gemini", used: 1, reset: now() + 60_000 },
  { label: "weekly", pool: "Gemini", used: 1, reset: now() + 60_000 },
  { label: "Argon weekly", pool: "Gemini", model: "antigravity-gemini-4-argon", used: 1, reset: now() + 60_000 },
  { label: "model", pool: "Gemini", model: "antigravity-gemini-4-argon", used: 1, reset: now() + 60_000 },
] });

beforeEach(() => { claude = quota("anthropic"); google = googleQuota(); reads = 0; googleReads = 0; sources = []; collectors = 0; disposed = 0; googleRead = undefined; googleCredential = "ya29.test"; });
describe("standalone virtual model", () => {
  it("routes the first turn, rechecks user turns and exposes only a detached read-only snapshot", async () => {
    const f = fixture();
    const first = await f.route(f.request(), f.ctx);
    assert.equal(first.model.provider, "anthropic");
    assert.deepEqual(first.state, { version: 1, physical: { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "medium" } });
    const view = queryWaterfall(f.pi.events);
    assert.equal(view.physical.provider, "anthropic");
    view.physical.id = "tampered";
    await f.commands.get("waterfall").handler("", f.ctx);
    assert.match(f.output[0][0], /claude-opus-5-5/);
    assert.equal(reads, 1);
    await f.route(f.request({ state: first.state }), f.ctx);
    assert.equal(reads, 2);
    f.handlers.get("session_tree")();
    assert.equal(queryWaterfall(f.pi.events).physical, undefined);
  });
  it("recreates the quota collector after a session replacement", async () => {
    const f = fixture();
    assert.equal(collectors, 1);
    f.handlers.get("session_shutdown")();
    f.handlers.get("session_start")();
    assert.equal(collectors, 2);
    assert.equal(disposed, 2);
    claude = quota("anthropic", 95);
    const result = await f.route(f.request(), f.ctx);
    assert.equal(result.model.provider, "google");
    assert.equal(googleReads, 1);
  });
  it("does not trust a manual previous model or route state without matching prior response", async () => {
    const f = fixture();
    const prior = { model: models[0], thinkingLevel: "medium" };
    claude = quota("anthropic", 95);
    const out = await f.route(f.request({ reason: "continuation", previous: prior, state: undefined }), f.ctx);
    assert.equal(out.model.provider, "google");
    assert.equal(googleReads, 1);
    await assert.rejects(f.route(f.request({ reason: "retry", failed: prior, state: { version: 1, physical: { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "medium" } } }), f.ctx), /no verified subscription route/);
  });
  it("checks direct calls without writing branch presentation or trusting state", async () => {
    const f = fixture();
    await f.route(f.request({ reason: "direct", state: undefined }), f.ctx);
    assert.equal(queryWaterfall(f.pi.events).physical, undefined);
    assert.equal(reads, 1);
  });
  it("fails before inference when all readings are unknown and never selects disabled OpenAI/Muse", async () => {
    claude = { provider: "anthropic", state: "unavailable", windows: [], reason: "missing" };
    google = { provider: "google", state: "unavailable", windows: [], reason: "missing" };
    const f = fixture();
    await assert.rejects(f.route(f.request(), f.ctx), /no verified subscription route below 95%/);
    const view = queryWaterfall(f.pi.events);
    assert.equal(view.physical, undefined);
    assert.deepEqual(view.skipped.map(x => x.provider), ["anthropic", "openai", "google", "muse-sdk"]);
    assert.ok(view.skipped.some(x => /not been verified/.test(x.reason)));
    assert.ok(view.skipped.some(x => /lossy/.test(x.reason)));
  });
  it("rechecks a branch-sticky pending-tool turn at its verified thinking level", async () => {
    const f = fixture();
    claude = quota("anthropic", 95);
    const first = await f.route(f.request({ thinkingLevel: "high" }), f.ctx);
    assert.equal(first.model.provider, "google");
    assert.equal(sources[0].variant, "gemini-4-argon-high");
    const steered = f.request({ reason: "user", thinkingLevel: "low", state: first.state,
      previous: { model: models[2], thinkingLevel: "high" },
      messages: [{ role: "assistant", content: [{ type: "toolCall", id: "tool" }] }, { role: "user", content: "steer" }] });
    const kept = await f.route(steered, f.ctx);
    assert.equal(kept.model.provider, "google");
    assert.equal(kept.thinkingLevel, "high");
    assert.equal(sources[1].variant, "gemini-4-argon-high");
    assert.equal(reads, 1);
  });
  it("rejects Google quota read under a changed or missing OAuth account", async () => {
    claude = quota("anthropic", 95);
    let finish;
    googleRead = () => new Promise(resolve => { finish = resolve; });
    const f = fixture();
    const pending = f.route(f.request(), f.ctx);
    await vi.waitFor(() => assert.equal(typeof finish, "function"));
    googleCredential = "ya29.other";
    finish(googleQuota());
    await assert.rejects(pending, /no verified subscription route/);
    assert.equal(queryWaterfall(f.pi.events).physical, undefined);
    assert.equal(sources[0].auth.token, "ya29.test");
  });
  it("clamps physical reasoning before selecting Argon quota and saves the effective level", async () => {
    claude = quota("anthropic", 95);
    const physical = { ...models[2], thinkingLevelMap: { off: null, minimal: null, low: null, max: "medium" } };
    const f = fixture([models[0], models[1], physical, models[3]]);
    const out = await f.route(f.request({ thinkingLevel: "off" }), f.ctx);
    assert.equal(out.thinkingLevel, "medium");
    assert.equal(sources[0].variant, "gemini-4-argon-medium");
    assert.equal(out.state.physical.thinkingLevel, "medium");
    const max = await f.route(f.request({ thinkingLevel: "max" }), f.ctx);
    assert.equal(max.thinkingLevel, "max");
    assert.equal(sources[1].variant, "gemini-4-argon-medium");
  });
  it("rejects a changed physical model and a cancelled pending quota read", async () => {
    claude = quota("anthropic", 95);
    const physical = { ...models[2] };
    let finish;
    googleRead = () => new Promise(resolve => { finish = resolve; });
    const f = fixture([models[0], models[1], physical, models[3]]);
    const pending = f.route(f.request(), f.ctx);
    await vi.waitFor(() => assert.equal(typeof finish, "function"));
    physical.baseUrl = "https://external.example";
    finish(googleQuota());
    await assert.rejects(pending, /no verified subscription route/);
    assert.equal(queryWaterfall(f.pi.events).physical, undefined);

    physical.baseUrl = "https://cloudcode-pa.googleapis.com";
    let cancelFinish;
    googleRead = () => new Promise(resolve => { cancelFinish = resolve; });
    const controller = new AbortController();
    const cancelling = f.route(f.request({ signal: controller.signal }), f.ctx);
    await vi.waitFor(() => assert.equal(typeof cancelFinish, "function"));
    controller.abort();
    await assert.rejects(cancelling, /cancelled/);
    cancelFinish(googleQuota());
    assert.equal(queryWaterfall(f.pi.events).physical, undefined);
  });
  it("preserves a clamped physical route across a pending-tool steer", async () => {
    claude = quota("anthropic", 95);
    const physical = { ...models[2], thinkingLevelMap: { off: null, minimal: null, low: null } };
    const f = fixture([models[0], models[1], physical, models[3]]);
    const first = await f.route(f.request({ thinkingLevel: "off" }), f.ctx);
    const kept = await f.route(f.request({ reason: "user", thinkingLevel: "high", previous: {
      model: physical, thinkingLevel: "medium" }, state: first.state,
      messages: [{ role: "assistant", content: [{ type: "toolCall", id: "tool" }] }, { role: "user", content: "steer" }] }), f.ctx);
    assert.equal(kept.thinkingLevel, "medium");
    assert.equal(sources[1].variant, "gemini-4-argon-medium");
  });
  it("rejects an external Anthropic endpoint even with OAuth and valid quota", async () => {
    const f = fixture([{ ...models[0], baseUrl: "https://external.example" }, ...models.slice(1)]);
    const selected = await f.route(f.request(), f.ctx);
    assert.equal(selected.model.provider, "google");
    assert.equal(reads, 0);
    assert.match(queryWaterfall(f.pi.events).skipped[0].reason, /unverified subscription endpoint/);
  });
  it("rejects missing exact Google window and missing physical models", async () => {
    claude = quota("anthropic", 95);
    google.windows = google.windows.filter(x => x.label !== "model");
    const f = fixture(models.filter(m => m.provider !== "openai"));
    await assert.rejects(f.route(f.request(), f.ctx), /no verified subscription route/);
    assert.equal(queryWaterfall(f.pi.events).physical, undefined);
  });
  it("aborts an already-cancelled route without a quota read", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.route(f.request({ signal: controller.signal }), f.ctx), /cancelled/);
    assert.equal(reads, 0);
  });
  it("keeps the channel's query synchronous and ignores unknown messages", () => {
    const f = fixture();
    f.pi.events.emit(WATERFALL_CHANNEL, { kind: "other" });
    assert.equal(queryWaterfall(f.pi.events).version, 1);
  });
});
