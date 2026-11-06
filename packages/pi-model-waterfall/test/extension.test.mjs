import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import modelWaterfall, { explicitModelArg } from "../src/index.ts";
import { queryWaterfall, WATERFALL_CHANNEL } from "../src/waterfall-contract.ts";

const now = () => Date.now();
const quota = (provider, used = 10) => ({ provider, source: "test OAuth", state: "ready", observedAt: now(),
  windows: ["5h", "week"].map(label => ({ label, used, observedAt: now(), reset: now() + 60_000 })) });
let claude, codex, google, museRead, reads, googleReads, sources, collectors, disposed, googleRead, googleCredential;
vi.mock("@justmytwospence/pi-subscription-usage", () => ({
  isUsageStale: (reading, time) => reading.observedAt >= time + 30_000 || time - reading.observedAt >= 600_000 ||
    reading.windows.some(w => w.reset <= time || (w.observedAt !== undefined && time - w.observedAt >= 600_000)),
  MUSE_NO_USAGE_REASON: "Muse reported no usage yet in this window.",
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
const fixture = (available = models) => {
  const handlers = new Map(), events = new Map(), commands = new Map(); 
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    events: { on(name, fn) { events.set(name, fn); }, emit(name, request) { events.get(name)?.(request); } },
    setModel: vi.fn(async () => true), registerCommand(name, command) { commands.set(name, command); },
    getThinkingLevel() { return "medium"; },
  };
  modelWaterfall(pi);
  const output = [];
  const ctx = {
    modelRegistry: {
      find(provider, id) { return available.find(m => m.provider === provider && m.id === id); },
      isUsingOAuth(model) { return model.provider !== "muse-code"; },
      async getApiKeyForProvider(p) { return p === "muse-code" ? "muse-code-local" : googleCredential; },
    },
    hasUI: true, model: available[0], isIdle: () => true,
    ui: { notify(...args) { output.push(args); } },
  };
  return { pi, ctx, handlers, commands, output, start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx) };
};
const googleQuota = () => ({ provider: "google", source: "Antigravity", state: "ready", observedAt: now(), windows: [
  { label: "5h", pool: "Gemini", used: 1, reset: now() + 60_000 },
  { label: "weekly", pool: "Gemini", used: 1, reset: now() + 60_000 },
  { label: "Argon weekly", pool: "Gemini", model: "antigravity-gemini-4-argon", used: 1, reset: now() + 60_000 },
  { label: "model", pool: "Gemini", model: "antigravity-gemini-4-argon", used: 1, reset: now() + 60_000 },
] });

const codexQuota = (used = 10, access) => ({ provider: "openai-codex", source: "Codex", state: "ready", observedAt: now(), windows: [{ label: "week", used, observedAt: now(), reset: now() + 60_000 }], ...(access ? { access } : {}) });
const noUsage = () => ({ provider: "muse-code", source: "Muse", state: "unavailable", windows: [], reason: "Muse reported no usage yet in this window." });
beforeEach(() => { codex = codexQuota(); museRead = noUsage(); claude = quota("anthropic"); google = googleQuota(); reads = 0; googleReads = 0; sources = []; collectors = 0; disposed = 0; googleRead = undefined; googleCredential = "ya29.test"; });
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
  it("falls through to muse-code when it has no usage yet", async () => {
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
    assert.deepEqual(queryWaterfall(f.pi.events).order.map(r => r.provider), ["anthropic", "openai", "google", "muse-code"]);
    f.start("resume");
    await vi.waitFor(() => assert.ok(queryWaterfall(f.pi.events).rungs));
    assert.deepEqual(queryWaterfall(f.pi.events).rungs.map(r => [r.provider, r.state]), [["anthropic", "exhausted"], ["openai", "available"], ["google", "available"], ["muse-code", "available"]]);
    f.pi.events.emit(WATERFALL_CHANNEL, { kind: "other" });
    f.handlers.get("session_shutdown")();
    assert.equal(queryWaterfall(f.pi.events).rungs, undefined);
    await f.commands.get("waterfall").handler("", f.ctx);
    assert.match(f.output.at(-1)[0], /no startup choice/);
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
