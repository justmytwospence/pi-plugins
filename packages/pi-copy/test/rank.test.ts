import { expect, test } from "vitest";
import { DEFAULT_RANK, chronological, piecesToJudge, rankQuestions, readJudgments, suggested } from "../src/rank.ts";
import { type Segment, segmentKey } from "../src/segments.ts";

const seg = (id: string, kind: Segment["kind"], turn: number, order: number, text = id): Segment => ({ id, kind, text, turn, order });
const segments = [seg("S001", "command", 0, 0), seg("S002", "paragraph", 1, 1), seg("S003", "code", 2, 2), seg("S004", "url", 2, 3)];

test("recency order without judgments, Jev's order with them", () => {
  expect(suggested(segments, undefined, DEFAULT_RANK).map((s) => s.id)).toEqual(["S004", "S003", "S002", "S001"]);
  const judged = new Map([
    [segmentKey(segments[0]!), { want: 3 }],
    [segmentKey(segments[1]!), { want: 1, copyable: 0.1 }],
    [segmentKey(segments[2]!), { want: 0 }],
    [segmentKey(segments[3]!), { want: 0 }],
  ]);
  // S001: 0.6 + 0 = 0.6; S004: 0 + 0.4 = 0.4; S003: 0.4·(0.8+0.2·2/3); S002 is not copyable.
  expect(suggested(segments, judged, DEFAULT_RANK).map((s) => s.id)).toEqual(["S001", "S004", "S003"]);
  expect(chronological(segments).map((s) => s.id)).toEqual(["S004", "S003", "S002", "S001"]);
});

test("questions: a want score for every piece, copyable for prose", () => {
  const q = rankQuestions(segments);
  expect(Object.keys(q)).toEqual(["want::S001", "want::S002", "copyable::S002", "want::S003", "want::S004"]);
  const judged = readJudgments(segments.slice(0, 2), {
    "want::S001": { type: "score", score: 2.5, confidence: 0.9 },
    "want::S002": { type: "score", score: 0.2, confidence: 0.9 },
    "copyable::S002": { type: "bool", probability: 0.1 },
  });
  expect(judged.get(segmentKey(segments[1]!))).toEqual({ want: 0.2, copyable: 0.1 });
});

test("piecesToJudge takes the newest that fit", () => {
  const many = Array.from({ length: 300 }, (_, i) => seg(`S${i}`, "code", i, i, "x".repeat(1_000)));
  const chosen = piecesToJudge(many, DEFAULT_RANK);
  expect(chosen.length).toBe(Math.floor(60_000 / 640));
  expect(chosen.at(-1)?.id).toBe("S299");
});
