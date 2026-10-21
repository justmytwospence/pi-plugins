import { describe, expect, it } from "vitest";
import { displayMessage, parseUpdate, parseUpdates, stripHidden } from "../src/quiz/protocol.ts";

const KEY = "<quiz-key>It retries twice because attempts starts at 1.</quiz-key>";
const UPDATE = '<quiz-update>{"concept":"retry-budget","title":"Retry budget","result":"partial","difficulty":3,"paths":["src/retry.ts"],"note":"right count, wrong reason"}</quiz-update>';

describe("stripHidden", () => {
  it("removes rubric and grade blocks", () => {
    expect(stripHidden(`Close: the count is right.\n\n${UPDATE}\n\nNext: what if the timeout fires first?\n\n${KEY}`)).toBe(
      "Close: the count is right.\n\nNext: what if the timeout fires first?",
    );
  });

  it("hides a block that is still streaming, and a tag still being typed", () => {
    expect(stripHidden("What happens on the third failure?\n\n<quiz-key>It gives u")).toBe("What happens on the third failure?");
    expect(stripHidden("What happens on the third failure?\n\n<quiz-k")).toBe("What happens on the third failure?");
    expect(stripHidden("What happens?\n\n<")).toBe("What happens?");
  });

  it("leaves other text exactly as it was", () => {
    const text = "Use `a < b` and <div>.\n\n\n\nok  ";
    expect(stripHidden(text)).toBe(text);
  });
});

describe("parseUpdates", () => {
  it("reads every grade, one or several per block", () => {
    const two = '<quiz-update>[{"concept":"a","title":"A","result":"correct","difficulty":1},{"concept":"b","result":"wrong"}]</quiz-update>';
    const { updates, invalid } = parseUpdates(`x ${UPDATE} y ${two}`);
    expect(invalid).toBe(0);
    expect(updates.map((u) => [u.concept, u.result, u.difficulty])).toEqual([
      ["retry-budget", "partial", 3],
      ["a", "correct", 1],
      ["b", "wrong", 2],
    ]);
    expect(updates[0]).toMatchObject({ title: "Retry budget", paths: ["src/retry.ts"], note: "right count, wrong reason" });
  });

  it("counts unreadable blocks instead of guessing", () => {
    const { updates, invalid } = parseUpdates('<quiz-update>not json</quiz-update><quiz-update>{"concept":"c","result":"great"}</quiz-update>');
    expect(updates).toEqual([]);
    expect(invalid).toBe(2);
  });

  it("derives an id from the title and normalizes it", () => {
    expect(parseUpdate({ title: "Cache TTL vs. idle", result: "correct" })).toMatchObject({ concept: "cache-ttl-vs-idle", difficulty: 2 });
    expect(parseUpdate({ concept: "  Retry Budget!! ", result: "skipped" })?.concept).toBe("retry-budget");
    expect(parseUpdate({ result: "correct" })).toBeUndefined();
  });
});

describe("displayMessage", () => {
  it("strips hidden blocks from an assistant reply only", () => {
    const reply = { role: "assistant", content: [{ type: "thinking", thinking: "<quiz-key>x</quiz-key>" }, { type: "text", text: `Q?\n${KEY}` }] };
    const shown = displayMessage(reply);
    expect(shown.content).toEqual([{ type: "thinking", thinking: "<quiz-key>x</quiz-key>" }, { type: "text", text: "Q?" }]);
    expect(reply.content[1]).toEqual({ type: "text", text: `Q?\n${KEY}` });
    const user = { role: "user", content: [{ type: "text", text: KEY }] };
    expect(displayMessage(user)).toBe(user);
  });

  it("returns the same message when there is nothing to hide", () => {
    const reply = { role: "assistant", content: [{ type: "text", text: "plain" }] };
    expect(displayMessage(reply)).toBe(reply);
  });
});
