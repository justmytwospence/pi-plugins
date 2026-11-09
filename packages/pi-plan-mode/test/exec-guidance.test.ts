import assert from "node:assert/strict";
import { test } from "vitest";
import { EXEC_GUIDANCE_TYPE, type GuidanceAnchor, placeGuidance } from "../src/exec-guidance.js";

const msg = (n: number) => ({ role: "user", content: `m${n}`, timestamp: n });
const history = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));
const texts = (messages: readonly unknown[]) =>
  messages.map((m) => {
    const message = m as { customType?: string; content: string };
    return message.customType === EXEC_GUIDANCE_TYPE ? `G:${message.content}` : message.content;
  });

test("guidance stays where it first appeared while the history grows", () => {
  let anchors: GuidanceAnchor[] = [];
  const first = placeGuidance(history(2), "go", anchors, 100);
  anchors = first.anchors;
  assert.deepEqual(texts(first.messages), ["m1", "m2", "G:go"]);
  const second = placeGuidance(history(4), "go", anchors, 200);
  assert.deepEqual(texts(second.messages), ["m1", "m2", "G:go", "m3", "m4"]);
  // Byte-identical prefix: the inserted message is reused, timestamp included.
  assert.deepEqual(second.messages.slice(0, 3), first.messages);
});

test("a new guidance text is anchored at the tail and earlier ones stay put", () => {
  const first = placeGuidance(history(1), "go", [], 1);
  const second = placeGuidance(history(3), "paused", first.anchors, 2);
  assert.deepEqual(texts(second.messages), ["m1", "G:go", "m2", "m3", "G:paused"]);
  const third = placeGuidance(history(4), "go", second.anchors, 3);
  assert.deepEqual(texts(third.messages), ["m1", "G:go", "m2", "m3", "G:paused", "m4", "G:go"]);
});

test("anchors that no longer match the history are dropped and the text re-anchored", () => {
  const first = placeGuidance(history(3), "go", [], 1);
  const rewritten = [{ role: "user", content: "summary", timestamp: 99 }, msg(4)];
  const placed = placeGuidance(rewritten, "go", first.anchors, 2);
  assert.deepEqual(texts(placed.messages), ["summary", "m4", "G:go"]);
  assert.equal(placed.anchors.length, 1);
});

test("never mutates the request messages", () => {
  const messages = history(2);
  const before = structuredClone(messages);
  placeGuidance(messages, "go", [], 1);
  assert.deepEqual(messages, before);
});
