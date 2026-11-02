import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { chooseWaterfall, evaluateAllowance, forPhysicalModel, pendingToolRound, stickyPhysicalModel, waterfallUnavailable } from "../src/decision.ts";

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
    assert.match(waterfallUnavailable(decision).message, /Select a physical model manually/);
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
  it("sticks to the selected physical model across tools, retry and steering", () => {
    const previous = { model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "medium" };
    const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "call-1" }] }, { role: "user", content: "steer" }];
    assert.ok(pendingToolRound(messages));
    const state = { version: 1, physical: { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "medium" } };
    assert.deepEqual(stickyPhysicalModel("user", previous, undefined, messages, state), state.physical);
    assert.deepEqual(stickyPhysicalModel("continuation", previous, undefined, [], state), state.physical);
    assert.deepEqual(stickyPhysicalModel("retry", undefined, previous, [], state), state.physical);
    assert.equal(stickyPhysicalModel("user", previous, undefined, [...messages, { role: "toolResult", toolCallId: "call-1" }], state), undefined);
    assert.equal(stickyPhysicalModel("user", { model: { provider: "meta", id: "paid" } }, undefined, messages, state), undefined);
    assert.equal(stickyPhysicalModel("retry", undefined, previous, [], undefined), undefined);
    assert.equal(stickyPhysicalModel("continuation", { ...previous, thinkingLevel: "high" }, undefined, [], state), undefined);
    assert.equal(stickyPhysicalModel("direct", previous, undefined, [], state), undefined);
  });
});
