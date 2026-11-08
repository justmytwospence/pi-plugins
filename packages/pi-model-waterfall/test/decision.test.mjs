import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { chooseWaterfall, evaluateAllowance, inspectAllowance, forPhysicalModel, DEFAULT_WATERFALL_ORDER, SUPPORTED_WATERFALL_MODELS, waterfallModels } from "../src/decision.ts";
import { rungState } from "../src/index.ts";

const now = 1_800_000_000_000;
const reading = (windows, observedAt = now) => ({ provider: "anthropic", source: "subscription", state: "ready", observedAt, windows });
const candidate = (provider, windows, verified = true) => ({ provider, model: `${provider}-model`, verified, reading: reading(windows) });
const window = (used, label = "5h") => ({ label, used, reset: now + 60_000 });

describe("subscription waterfall decision", () => {
  it("defaults to Anthropic when each applicable quota is below 95%", () => {
    const decision = chooseWaterfall([candidate("anthropic", [window(94.99), window(70, "weekly")]), candidate("openai", [window(0)])], now);
    assert.equal(decision.chosen?.provider, "anthropic");
    assert.deepEqual(decision.skipped, []);
  });
  it("switches on any applicable 5h/weekly/model-specific window at exactly 95%", () => {
    for (const label of ["5h", "weekly", "model"]) {
      const decision = chooseWaterfall([candidate("anthropic", [window(0), window(95, label)]), candidate("openai", [window(10)])], now);
      assert.equal(decision.chosen?.provider, "openai");
      assert.match(decision.skipped[0].reason, new RegExp(label));
    }
  });
  it("skips unknown and unverified rungs rather than spending or wrapping around", () => {
    const decision = chooseWaterfall([candidate("anthropic", [window(96)]), candidate("openai", [window(10)], false),
      candidate("google", [window(undefined)]), candidate("muse-sdk", [window(100)])], now);
    assert.equal(decision.chosen, undefined);
    assert.equal(decision.skipped.length, 4);
  });
  it("rejects stale, reset-due, future timestamps, empty, invalid and missing readings", () => {
    assert.match(evaluateAllowance(reading([window(0)], now - 600_000), now), /stale/);
    assert.match(evaluateAllowance(reading([{ label: "week", used: 0, reset: now }]), now), /stale/);
    assert.match(evaluateAllowance(reading([window(0)], now + 60_000), now), /stale/);
    assert.match(evaluateAllowance(reading([]), now), /No applicable/);
    assert.match(evaluateAllowance(reading([{ label: "5h", used: 0 }]), now), /unknown or due/);
    assert.match(evaluateAllowance(reading([{ ...window(0), observedAt: now - 600_000 }]), now), /stale/);
    for (const used of [undefined, NaN, -1, 101]) assert.match(evaluateAllowance(reading([window(used)]), now), /unknown/);
    assert.match(evaluateAllowance(undefined, now), /unavailable/);
  });
  it("keeps only exact model-specific windows, plus shared ones", () => {
    assert.deepEqual(forPhysicalModel(reading([window(12), { ...window(99), model: "other" }, { ...window(13), model: "ours" }]), "ours").windows.map(w => w.used), [12, 13]);
  });
  it("treats a blocked Codex account as unknown even below 95%", () => {
    assert.match(evaluateAllowance({ ...reading([window(10)]), access: { allowed: true, limitReached: true } }, now), /limit reached/);
    assert.match(evaluateAllowance({ ...reading([window(10)]), access: { allowed: false } }, now), /limit reached/);
    assert.equal(evaluateAllowance({ ...reading([window(10)]), access: { allowed: true, limitReached: false } }, now), undefined);
  });
  it("separates the supported catalog from the three default active rungs", () => {
    assert.deepEqual(DEFAULT_WATERFALL_ORDER, ["anthropic", "openai", "google"]);
    assert.deepEqual(SUPPORTED_WATERFALL_MODELS.map(model => model.provider), [...DEFAULT_WATERFALL_ORDER, "muse-code"]);
    assert.deepEqual(waterfallModels(["muse-code", "google"]), [SUPPORTED_WATERFALL_MODELS[3], SUPPORTED_WATERFALL_MODELS[2]]);
    assert.deepEqual(waterfallModels([]), []);
  });
  it("excludes unrelated Google pools and model windows", () => {
    const shared = { ...window(10), pool: "Gemini", scope: "shared", quotaId: "gemini-5h" };
    const argon = { ...window(97), pool: "Gemini", model: "antigravity-gemini-4-argon" };
    const usage = { ...reading([shared, argon, { ...window(100), pool: "third-party" }, { ...window(100), pool: "Gemini", model: "antigravity-gemini-pro" }]), provider: "google" };
    assert.deepEqual(forPhysicalModel(usage, argon.model).windows, [shared, argon]);
    assert.deepEqual(forPhysicalModel(usage, "antigravity-gemini-flash").windows, [shared]);
  });
  it("inspects every window before claiming exhaustion", () => {
    const blocked = { ...window(100, "Argon weekly"), scope: "model", reset: now + 120_000 };
    const valid = window(95, "Argon high");
    const result = inspectAllowance(reading([blocked, valid]), now);
    assert.deepEqual(result, { state: "exhausted", reason: "Argon weekly allowance is 100% used (95% waterfall threshold).", resetAt: now + 120_000, blockingQuota: { scope: "model", label: "Argon weekly" } });
    for (const bad of [window(undefined), window(NaN), { ...valid, reset: undefined }, { ...valid, reset: NaN }, { ...valid, reset: now }, { ...valid, observedAt: now - 600_000 }]) {
      const inspected = inspectAllowance(reading([blocked, bad]), now);
      assert.equal(inspected.state, "unknown");
      assert.equal(inspected.resetAt, undefined);
      assert.equal(inspected.blockingQuota, undefined);
      assert.equal(evaluateAllowance(reading([blocked, bad]), now), inspected.reason);
    }
    assert.deepEqual(inspectAllowance(reading([window(94.99)]), now), { state: "available" });
    assert.equal(inspectAllowance({ ...reading([blocked]), access: { allowed: false } }, now).state, "unknown");
  });
  it("publishes only fresh, valid scoped exhaustion, never stale reset claims", () => {
    const w = { ...window(95, "Argon high"), scope: "variant" };
    const checked = { ...candidate("google", [w]), model: "antigravity-gemini-4-argon" };
    assert.deepEqual(rungState(checked, now), { provider: "google", model: checked.model, ...inspectAllowance(checked.reading, now) });
    for (const usage of [reading([w], now - 600_000), reading([{ ...w, reset: now }]), reading([w, window(undefined)])]) {
      const state = rungState({ ...checked, reading: usage }, now);
      assert.equal(state.state, "unknown"); assert.equal(state.resetAt, undefined); assert.equal(state.blockingQuota, undefined);
    }
    assert.equal(rungState({ ...checked, verified: false, reason: "unverified" }, now).state, "unknown");
    assert.equal(rungState({ ...checked, reading: { ...checked.reading, access: { limitReached: true } } }, now).state, "unknown");
  });
  it("chooses a Muse rung that has no usage yet without windows", () => {
    const decision = chooseWaterfall([candidate("anthropic", [window(99)]), { provider: "muse-code", model: "m", verified: true, noUsage: true, reading: reading([]) }], now);
    assert.equal(decision.chosen?.provider, "muse-code");
  });
});
