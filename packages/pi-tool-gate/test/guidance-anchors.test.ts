import { describe, expect, test } from "vitest";
import { GUIDANCE_ANCHOR_ENTRY, type GuidanceAnchor, placeGuidance, restoreAnchors } from "../src/guidance-anchors.ts";

const TYPE = "tool-gate:mode-guidance";
const msg = (n: number) => ({ role: "user", content: `m${n}`, timestamp: n });
const history = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));
const texts = (messages: readonly unknown[]) =>
  messages.map((m) => {
    const message = m as { customType?: string; content: string };
    return message.customType === TYPE ? `G:${message.content}` : message.content;
  });

describe("placeGuidance", () => {
  test("guidance stays where it first appeared while the history grows", () => {
    const first = placeGuidance(history(2), "go", [], 100, TYPE);
    expect(texts(first.messages)).toEqual(["m1", "m2", "G:go"]);
    const second = placeGuidance(history(4), "go", first.anchors, 200, TYPE);
    expect(texts(second.messages)).toEqual(["m1", "m2", "G:go", "m3", "m4"]);
    // Byte-identical prefix: the inserted message is reused, timestamp included.
    expect(second.messages.slice(0, 3)).toEqual(first.messages);
    expect(JSON.stringify(second.messages.slice(0, 3))).toBe(JSON.stringify(first.messages));
  });

  test("a new guidance text is anchored at the tail and earlier ones stay put", () => {
    const first = placeGuidance(history(1), "go", [], 1, TYPE);
    const second = placeGuidance(history(3), "paused", first.anchors, 2, TYPE);
    expect(texts(second.messages)).toEqual(["m1", "G:go", "m2", "m3", "G:paused"]);
    const third = placeGuidance(history(4), "go", second.anchors, 3, TYPE);
    expect(texts(third.messages)).toEqual(["m1", "G:go", "m2", "m3", "G:paused", "m4", "G:go"]);
  });

  test("anchors that no longer match the history are dropped and the text re-anchored", () => {
    const first = placeGuidance(history(3), "go", [], 1, TYPE);
    const rewritten = [{ role: "user", content: "summary", timestamp: 99 }, msg(4)];
    const placed = placeGuidance(rewritten, "go", first.anchors, 2, TYPE);
    expect(texts(placed.messages)).toEqual(["summary", "m4", "G:go"]);
    expect(placed.anchors).toHaveLength(1);
  });

  test("kept anchors are returned as the same objects", () => {
    const first = placeGuidance(history(2), "go", [], 1, TYPE);
    const second = placeGuidance(history(3), "go", first.anchors, 2, TYPE);
    expect(second.anchors[0]).toBe(first.anchors[0]);
  });

  test("never mutates the request messages", () => {
    const messages = history(2);
    const before = structuredClone(messages);
    placeGuidance(messages, "go", [], 1, TYPE);
    expect(messages).toEqual(before);
  });

  test("a stable text keeps every earlier request a prefix of the next", () => {
    const m = history(3);
    const a = { role: "assistant", content: "a", timestamp: 10 };
    const r = { role: "toolResult", content: "r", timestamp: 11 };
    const placed = placeGuidance(m, "go", [], 5, TYPE);
    const next = placeGuidance([...m, a, r], "go", placed.anchors, 6, TYPE);
    expect(JSON.stringify(next.messages.slice(0, placed.messages.length))).toBe(JSON.stringify(placed.messages));
  });
});

describe("restoreAnchors", () => {
  const anchor: GuidanceAnchor = { text: "go", count: 2, ts: 2, timestamp: 100 };
  const entry = (data: unknown, customType = GUIDANCE_ANCHOR_ENTRY, type = "custom") => ({ type, customType, data });

  test("keeps valid anchors in branch order and ignores everything else", () => {
    const later = { text: "paused", count: 5, ts: undefined, timestamp: 200 };
    const restored = restoreAnchors([
      entry(anchor),
      entry(anchor, "other:entry"),
      entry(anchor, GUIDANCE_ANCHOR_ENTRY, "message"),
      entry({ text: 1, count: 2, timestamp: 3 }),
      entry({ text: "x", count: "2", timestamp: 3 }),
      entry({ text: "x", count: 2, ts: "bad", timestamp: 3 }),
      entry(undefined),
      entry(later),
      null,
    ]);
    expect(restored).toEqual([anchor, later]);
  });

  test("a saved anchor without ts (JSON drops undefined) restores with ts undefined", () => {
    const [restored] = restoreAnchors([entry(JSON.parse(JSON.stringify({ text: "go", count: 0, ts: undefined, timestamp: 1 })))]);
    expect(restored).toEqual({ text: "go", count: 0, ts: undefined, timestamp: 1 });
  });
});
