import { describe, expect, it } from "vitest";
import { abbreviateOutput, ARGS_MAX, clipMiddle, outlineOf } from "../src/outline.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });

describe("outlineOf", () => {
  it("keeps prompts and replies, drops thinking, and clips tool call arguments", () => {
    const outline = outlineOf([
      user("fix the bug"),
      assistant({ type: "thinking", thinking: "secret musings" }, { type: "text", text: "looking" }, { type: "toolCall", id: "1", name: "bash", arguments: { command: "x".repeat(1000) } }),
    ]);
    expect(outline).toContain("[user]\nfix the bug");
    expect(outline).toContain("[assistant]\nlooking");
    expect(outline).not.toContain("secret musings");
    const call = outline.split("\n").find((l) => l.startsWith("→ bash "))!;
    expect(call.length).toBeLessThanOrEqual("→ bash ".length + ARGS_MAX);
    expect(call.endsWith("…")).toBe(true);
  });

  it("shortens a long tool result to its head, tail and an error line", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    lines[500] = "Error: the thing broke";
    const outline = outlineOf([{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: lines.join("\n") }] }]);
    expect(outline.split("\n")[0]).toBe("← bash (error), 1000 lines");
    for (const kept of ["line 0", "line 2", "line 997", "line 999", "Error: the thing broke"]) expect(outline).toContain(kept);
    expect(outline).not.toContain("line 300");
    expect(outline).toContain("[… 497 lines omitted …]");
    expect(outline).toContain("[… 496 lines omitted …]");
  });

  it("keeps a short tool result whole", () => {
    expect(abbreviateOutput("a\nb\nc")).toBe("a\nb\nc");
  });

  it("keeps the start and end of an outline over budget", () => {
    const messages = Array.from({ length: 200 }, (_, i) => user(`prompt number ${i} ${"y".repeat(100)}`));
    const outline = outlineOf(messages, 5_000);
    expect(outline.length).toBeLessThanOrEqual(5_100);
    expect(outline).toContain("prompt number 0 ");
    expect(outline).toContain("prompt number 199 ");
    expect(outline).toContain("[… earlier part of the session omitted …]");
  });
});

describe("clipMiddle", () => {
  it("returns short text unchanged and keeps head and tail of long text", () => {
    expect(clipMiddle("short", 100)).toBe("short");
    const clipped = clipMiddle(`${"a".repeat(500)}${"b".repeat(500)}`, 100);
    expect(clipped.startsWith("a".repeat(60))).toBe(true);
    expect(clipped.endsWith("b".repeat(40))).toBe(true);
    expect(clipped).toContain("[… 900 characters omitted …]");
  });
});
