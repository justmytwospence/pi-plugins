import assert from "node:assert/strict";
import { test } from "vitest";
import { isVirtual, payloadModel, routedModel } from "../src/routed-model.js";

const opus = { provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" };
const pair = { provider: "anthropic", id: "opusplan", api: "pi-virtual" };

const ctx = (model: unknown, branch: unknown[] = []) =>
  ({
    model,
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (provider: string, id: string) => [opus, sonnet, pair].find((m) => m.provider === provider && m.id === id),
      getAvailable: () => [opus, sonnet, pair],
    },
  }) as never;

const reply = (model: string, stopReason = "stop") => ({
  type: "message",
  message: { role: "assistant", provider: "anthropic", model, stopReason },
});

test("a physical selection is its own routed model", () => {
  assert.equal(isVirtual(opus), false);
  assert.equal(routedModel(ctx(opus)), opus);
  assert.equal(payloadModel(ctx(opus), "anything"), opus);
});

test("a virtual selection routes to the latest successful assistant response", () => {
  assert.equal(isVirtual(pair), true);
  assert.equal(routedModel(ctx(pair)), undefined);
  const branch = [reply("claude-opus-4-5"), reply("claude-sonnet-4-5"), reply("claude-opus-4-5", "error")];
  assert.equal(routedModel(ctx(pair, branch)), sonnet);
});

test("a payload's model id resolves to the physical model under a virtual selection", () => {
  assert.equal(payloadModel(ctx(pair), "claude-sonnet-4-5"), sonnet);
  assert.equal(payloadModel(ctx(pair), "opusplan"), undefined);
  assert.equal(payloadModel(ctx(pair), 5), undefined);
});
