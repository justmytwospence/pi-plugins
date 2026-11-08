import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import modelWaterfall, { explicitModelArg } from "../src/index.ts";
import { queryWaterfall, WATERFALL_CHANNEL } from "../src/waterfall-contract.ts";
import { ARGON_MODEL, parseGoogleModels, parseGoogleSummary } from "@justmytwospence/pi-subscription-usage";
import { DEFAULT_WATERFALL_ORDER } from "../src/decision.ts";
import { loadWaterfallConfig } from "../src/config.ts";

const now = () => Date.now();
const quota = (provider, used = 10) => ({ provider, source: "test OAuth", state: "ready", observedAt: now(),
  windows: ["5h", "week"].map(label => ({ label, used, observedAt: now(), reset: now() + 60_000 })) });
let claude, codex, google, museRead, reads, googleReads, sources, collectors, disposed, googleRead, googleCredential, policy;
vi.mock("../src/config.ts", () => ({ loadWaterfallConfig: vi.fn(() => structuredClone(policy)) }));
vi.mock("@justmytwospence/pi-subscription-usage", async importOriginal => ({
  ...await importOriginal(),
  readPiAnthropicUsage: async () => { reads++; return structuredClone(claude); },
  readCodexUsage: async () => structuredClone(codex),
  createProviderUsageCollector: () => { collectors++; return { refresh: async source => { googleReads++; sources.push(source); if (source.provider === "muse-code") return structuredClone(museRead); return googleRead ? googleRead(source) : structuredClone(google); }, dispose() { disposed++; } }; },
}));
const models = [
  { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", reasoning: true, baseUrl: "https://api.anthropic.com" },
  { provider: "openai", id: "gpt-6.1-sol", api: "openai-responses" },
  { provider: "google", id: "antigravity-gemini-4-argon", api: "google", reasoning: true, baseUrl: "https://cloudcode-pa.googleapis.com" },
  { provider: "muse-code", id: "muse-wonder-1.0", api: "muse", baseUrl: "http://localhost" },
];
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.handlers.get("session_shutdown")(); });
const fixture = (available = structuredClone(models)) => {
  const handlers = new Map(), events = new Map(), commands = new Map(); 
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    events: { on(name, fn) { events.set(name, fn); }, emit(name, request) { events.get(name)?.(request); } },
    setModel: vi.fn(async () => true), registerCommand(name, command) { commands.set(name, command); },
    getThinkingLevel: vi.fn(() => "medium"),
  };
  modelWaterfall(pi);
  const output = [];
  const ctx = {
    modelRegistry: {
      find(provider, id) { return available.find(m => m.provider === provider && m.id === id); },
      isUsingOAuth(model) { return model.provider !== "muse-code"; },
      getApiKeyForProvider: vi.fn(async p => p === "muse-code" ? "muse-code-local" : googleCredential),
    },
    cwd: "/synthetic-project", hasUI: true, model: available[0], isIdle: () => true,
    ui: { notify(...args) { output.push(args); } },
  };
  const f = { pi, ctx, handlers, commands, output, start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx) };
  fixtures.push(f); return f;
};
const googleQuota = (variant = "gemini-4-argon-medium") => {
  const resetTime = new Date(now() + 60_000).toISOString();
  const summary = parseGoogleSummary({ groups: [{ buckets: ["gemini-5h", "gemini-weekly", "gemini-argon-wtu-weekly"].map(bucketId => ({ bucketId, remainingFraction: 0.99, resetTime })) }] }, now());
  const model = parseGoogleModels({ models: { [variant]: { quotaInfo: { remainingFraction: 0.99, resetTime } } } }, ARGON_MODEL, now(), variant);
  return { ...summary, windows: [...summary.windows, ...model.windows] };
};

const codexQuota = (used = 10, access) => ({ provider: "openai-codex", source: "Codex", state: "ready", observedAt: now(), windows: [{ label: "week", used, observedAt: now(), reset: now() + 60_000 }], ...(access ? { access } : {}) });
const noUsage = () => ({ provider: "muse-code", source: "Muse", state: "unavailable", windows: [], reason: "Muse reported no usage yet in this window." });
beforeEach(() => { policy = { order: [...DEFAULT_WATERFALL_ORDER] }; loadWaterfallConfig.mockClear(); codex = codexQuota(); museRead = noUsage(); claude = quota("anthropic"); google = googleQuota(); reads = 0; googleReads = 0; sources = []; collectors = 0; disposed = 0; googleRead = undefined; googleCredential = "ya29.test"; });
describe("session-start waterfall", () => {
  const settle = async (f) => { f.start(); await vi.waitFor(() => assert.ok(f.output.length || f.pi.setModel.mock.calls.length || queryWaterfall(f.pi.events).physical)); await new Promise(r => setTimeout(r, 20)); };
  it("keeps the current model when Anthropic is under quota", async () => {
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    assert.equal(queryWaterfall(f.pi.events).physical.provider, "anthropic");
  });
  it("starts on OpenAI when Anthropic is over quota, naming what it skipped", async () => {
    claude = quota("anthropic", 100);
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls[0][0].id, "gpt-6.1-sol");
    assert.match(f.output[0][0], /started on openai\/gpt-6\.1-sol \(skipped anthropic:/);
    assert.equal(f.output[0][1], "info");
  });
  it("skips OpenAI when both are over quota, or when Codex is blocked below 95%", async () => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    let f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls[0][0].provider, "google");
    codex = codexQuota(10, { allowed: true, limitReached: true });
    f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls[0][0].provider, "google");
  });
  it("falls through to explicitly opted-in muse-code when it has no usage yet", async () => {
    policy = { order: [...DEFAULT_WATERFALL_ORDER, "muse-code"] };
    claude = quota("anthropic", 100); codex = codexQuota(100); google = { provider: "google", state: "unavailable", windows: [], reason: "x" };
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls[0][0].provider, "muse-code");
  });
  it("warns and stays put when nothing qualifies", async () => {
    claude = quota("anthropic", 100); codex = codexQuota(100); google = { provider: "google", state: "unavailable", windows: [], reason: "x" };
    museRead = { provider: "muse-code", state: "unavailable", windows: [], reason: "failed" };
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    assert.match(f.output[0][0], /^Waterfall: no subscription under quota/);
    assert.equal(f.output[0][1], "warning");
  });
  it("does nothing for resume, fork, reload, headless sessions or an explicit model argument", async () => {
    claude = quota("anthropic", 100);
    for (const reason of ["resume", "fork", "reload"]) { const f = fixture(); f.start(reason); await new Promise(r => setTimeout(r, 30)); assert.equal(f.pi.setModel.mock.calls.length, 0, reason); }
    let f = fixture(); f.ctx.hasUI = false; f.start(); await new Promise(r => setTimeout(r, 30)); assert.equal(f.pi.setModel.mock.calls.length, 0);
    const argv = process.argv; process.argv = [...argv, "--model", "x"];
    try { f = fixture(); f.start(); await new Promise(r => setTimeout(r, 30)); assert.equal(f.pi.setModel.mock.calls.length, 0); }
    finally { process.argv = argv; }
  });
  it("does not switch after the user changed model or started a turn during the quota read", async () => {
    claude = quota("anthropic", 100);
    let f = fixture(); f.start(); f.ctx.model = models[2];
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    f = fixture(); f.ctx.isIdle = () => false; f.start();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.pi.setModel.mock.calls.length, 0);
  });
  it("keeps the order and publishes rung states for the status surfaces", async () => {
    claude = quota("anthropic", 97);
    const f = fixture();
    assert.deepEqual(queryWaterfall(f.pi.events).order.map(r => r.provider), ["anthropic", "openai", "google"]);
    f.start("resume");
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    assert.deepEqual(queryWaterfall(f.pi.events).rungs.map(r => [r.provider, r.state]), [["anthropic", "exhausted"], ["openai", "available"], ["google", "available"]]);
    f.pi.events.emit(WATERFALL_CHANNEL, { kind: "other" });
    f.handlers.get("session_shutdown")();
    assert.equal(queryWaterfall(f.pi.events).rungs, undefined);
    await f.commands.get("waterfall").handler("", f.ctx);
    assert.match(f.output.at(-1)[0], /no startup choice/);
  });
  it("makes zero default Muse credential/CLI requests even with installed healthy entitlement", async () => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    google.windows[2].used = 100;
    museRead = quota("muse-code", 0);
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    assert.equal(sources.some(source => source.provider === "muse-code"), false);
    assert.equal(f.ctx.modelRegistry.getApiKeyForProvider.mock.calls.some(([provider]) => provider === "muse-code"), false);
    assert.match(f.output[0][0], /no subscription under quota/);
    assert.match(f.output[0][0], /Argon weekly.*95% waterfall threshold/);
  });
  it("keeps direct opted-in Muse verification and allowance behavior", async () => {
    policy = { order: ["muse-code"] };
    museRead = quota("muse-code", 10);
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls[0][0].provider, "muse-code");
    assert.equal(sources.every(source => source.provider === "muse-code"), true);
    assert.deepEqual(queryWaterfall(f.pi.events).order.map(r => r.provider), ["muse-code"]);
  });
  it("rejects unverified opted-in Muse credentials without CLI requests", async () => {
    policy = { order: ["muse-code"] };
    const f = fixture(); f.ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue("not-the-bridge");
    await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0); assert.equal(sources.length, 0);
    assert.match(f.output[0][0], /signed-in Muse CLI/);
  });
  it("preserves manually selected and resumed Muse sessions", async () => {
    const f = fixture(); f.ctx.model = models[3]; f.start("resume");
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    assert.equal(sources.some(source => source.provider === "muse-code"), false);
  });
  it.each([0, 1, 2, 3])("skips Google when binding window %s reaches threshold with other scopes healthy", async index => {
    claude = quota("anthropic", 95); codex = codexQuota(95); google.windows[index].used = 95;
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    const rung = queryWaterfall(f.pi.events).rungs.at(-1);
    assert.equal(rung.state, "exhausted");
    assert.deepEqual(rung.blockingQuota, { scope: google.windows[index].scope, label: google.windows[index].label });
    assert.match(rung.reason, /95% used \(95% waterfall threshold\)/);
    assert.equal(rung.resetAt, google.windows[index].reset);
  });
  it("skips exhausted exact Argon high despite healthy shared and weekly quota", async () => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    google = googleQuota("gemini-4-argon-high"); google.windows[3].used = 100;
    const f = fixture(); f.pi.getThinkingLevel.mockReturnValue("high"); await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    assert.match(f.output[0][0], /Argon high allowance is 100% used \(95% waterfall threshold\)/);
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    assert.deepEqual(queryWaterfall(f.pi.events).rungs.at(-1).blockingQuota, { scope: "variant", label: "Argon high" });
  });
  it("publishes the first binding scope and latest exhausted reset, not provider rejection", async () => {
    google.windows[1].used = 96; google.windows[1].reset = now() + 90_000;
    google.windows[2].used = 100; google.windows[2].reset = now() + 180_000;
    const f = fixture(); f.start("resume");
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    const rung = queryWaterfall(f.pi.events).rungs.at(-1);
    assert.deepEqual(rung.blockingQuota, { scope: "shared", label: "Gemini weekly" });
    assert.equal(rung.resetAt, google.windows[2].reset);
    assert.doesNotMatch(rung.reason, /reject|outage/);
  });
  it.each([0, 1, 2, 3])("reports missing Google scope %s precisely without substituting another Google model", async index => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    google.windows.splice(index, 1);
    const available = [...structuredClone(models), { ...models[2], id: "antigravity-gemini-flash" }];
    const f = fixture(available); await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    assert.match(f.output[0][0], new RegExp(["Shared Gemini 5h", "Shared Gemini weekly", "Argon weekly", "Argon medium"][index] + " quota is unknown"));
    assert.equal(sources.every(source => source.model === ARGON_MODEL), true);
  });
  it("selects exact Argon only when all four scopes qualify, regardless of labels", async () => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    google.windows.forEach(w => { w.label = "renamed display label"; w.used = 94.99; });
    const f = fixture(); await settle(f);
    assert.equal(f.pi.setModel.mock.calls[0][0].id, ARGON_MODEL);
    assert.equal(queryWaterfall(f.pi.events).physical.quotaVariant, "gemini-4-argon-medium");
  });
  it.each(["low", "medium", "high"])("checks the exact physical mapped Argon %s variant", async mapped => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    const variant = `gemini-4-argon-${mapped}`;
    google = googleQuota(variant);
    const f = fixture(); f.ctx.modelRegistry.find("google", ARGON_MODEL).thinkingLevelMap = { medium: mapped };
    await settle(f);
    assert.equal(f.pi.setModel.mock.calls[0][0].id, ARGON_MODEL);
    assert.equal(sources.every(source => source.variant === variant), true);
    assert.equal(queryWaterfall(f.pi.events).physical.thinkingLevel, "medium");
    assert.equal(queryWaterfall(f.pi.events).physical.quotaVariant, variant);
  });
  it("clamps thinking before mapping and rejects another variant's reading", async () => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    const f = fixture(); f.pi.getThinkingLevel.mockReturnValue("xhigh");
    google = googleQuota("gemini-4-argon-high");
    await settle(f);
    assert.equal(queryWaterfall(f.pi.events).physical.thinkingLevel, "high");
    assert.equal(sources.every(source => source.variant === "gemini-4-argon-high"), true);
    const mismatch = fixture(); mismatch.pi.getThinkingLevel.mockReturnValue("high");
    google = googleQuota("gemini-4-argon-medium");
    await settle(mismatch);
    assert.equal(mismatch.pi.setModel.mock.calls.length, 0);
    assert.match(mismatch.output[0][0], /Argon high quota is unknown/);
  });
  it.each(["non-reasoning", "unknown-map", "null-map"])("rejects an unverifiable %s Argon model before quota reads", async problem => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    const f = fixture(); const model = f.ctx.modelRegistry.find("google", ARGON_MODEL);
    if (problem === "non-reasoning") model.reasoning = false;
    if (problem === "unknown-map") model.thinkingLevelMap = { medium: "unknown" };
    if (problem === "null-map") model.thinkingLevelMap = Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => [level, null]));
    await settle(f);
    assert.equal(f.pi.setModel.mock.calls.length, 0); assert.equal(sources.length, 0);
    assert.match(f.output[0][0], /Argon reasoning variant cannot be verified/);
  });
  it.each(["account", "model", "map", "thinking"])("rejects a Google %s change during in-flight quota reads", async changed => {
    claude = quota("anthropic", 100); codex = codexQuota(100);
    const gates = [];
    googleRead = () => new Promise(resolve => { gates.push(resolve); });
    const f = fixture(); f.start();
    await vi.waitFor(() => assert.equal(gates.length, 2));
    if (changed === "account") googleCredential = "ya29.new_synthetic_account";
    if (changed === "model") f.ctx.modelRegistry.find("google", ARGON_MODEL).api = "pi-virtual";
    if (changed === "map") f.ctx.modelRegistry.find("google", ARGON_MODEL).thinkingLevelMap = { medium: "high" };
    if (changed === "thinking") f.pi.getThinkingLevel.mockReturnValue("high");
    gates.forEach(resolve => resolve(googleQuota()));
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    assert.equal(queryWaterfall(f.pi.events).rungs.at(-1).state, "unknown");
    assert.equal(f.pi.setModel.mock.calls.length, 0);
    if (changed !== "thinking") assert.match(f.output[0][0], /changed during the quota read/);
  });
  it.each(["stale", "reset-due", "invalid"])("publishes unknown without reset claims for %s Argon readings", async failure => {
    google.windows[2].used = 100;
    if (failure === "stale") google.observedAt = now() - 600_000;
    if (failure === "reset-due") google.windows[3].reset = now();
    if (failure === "invalid") google.windows[3].used = undefined;
    const f = fixture(); f.start("resume");
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    const rung = queryWaterfall(f.pi.events).rungs.at(-1);
    assert.equal(rung.state, "unknown"); assert.equal(rung.resetAt, undefined); assert.equal(rung.blockingQuota, undefined);
  });
  it("performs no checks or selection for valid empty policy and reports disabled", async () => {
    policy = { order: [] };
    const f = fixture(); f.start(); f.handlers.get("agent_settled")({}, f.ctx);
    await f.commands.get("waterfall").handler("", f.ctx);
    assert.equal(f.output.at(-1)[0], "Waterfall: automatic selection disabled.");
    assert.equal(reads, 0); assert.equal(googleReads, 0); assert.equal(f.ctx.modelRegistry.getApiKeyForProvider.mock.calls.length, 0);
    assert.equal(f.pi.setModel.mock.calls.length, 0); assert.deepEqual(queryWaterfall(f.pi.events).order, []);
  });
  it("warns once on invalid config, checks nothing and reports its path/field on demand", async () => {
    policy = { order: [], error: "/synthetic-project/.pi/model-waterfall.json: order contains duplicate provider IDs." };
    const f = fixture(); f.start(); f.handlers.get("agent_settled")({}, f.ctx);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.output.length, 1); assert.equal(f.output[0][1], "warning");
    assert.equal(reads, 0); assert.equal(googleReads, 0); assert.equal(f.pi.setModel.mock.calls.length, 0);
    await f.commands.get("waterfall").handler("", f.ctx);
    assert.equal(f.output.at(-1)[0], `Waterfall: ${policy.error}`);
  });
  it("freezes session policy and reloads it only for a new/reloaded session", async () => {
    policy = { order: [] };
    const f = fixture(); f.start();
    assert.equal(loadWaterfallConfig.mock.calls[0][0], f.ctx.cwd);
    assert.equal(typeof loadWaterfallConfig.mock.calls[0][1], "string");
    policy = { order: ["muse-code"] };
    f.handlers.get("agent_settled")({}, f.ctx);
    assert.deepEqual(queryWaterfall(f.pi.events).order, []); assert.equal(sources.length, 0);
    f.start("reload");
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    assert.deepEqual(queryWaterfall(f.pi.events).order.map(r => r.provider), ["muse-code"]);
    assert.equal(f.pi.setModel.mock.calls.length, 0);
  });
  it("recreates the quota collector after a session replacement", () => {
    const f = fixture();
    assert.equal(collectors, 1);
    f.handlers.get("session_shutdown")(); f.handlers.get("session_start")({ reason: "resume" }, f.ctx);
    assert.equal(collectors, 2); assert.equal(disposed, 2);
  });
  it("recognizes an explicit model argument", () => {
    for (const arg of ["--model", "-m", "--model=x", "--provider", "--provider=y"]) assert.equal(explicitModelArg(["node", "pi", arg]), true, arg);
    assert.equal(explicitModelArg(["node", "pi"]), false);
  });
});
