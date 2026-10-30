import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { COLLAPSED_LINES, reviewBody, reviewStatusLine } from "../src/review-card.js";

function themeSpy() {
  const fg = vi.fn((_role: string, text: string) => text);
  return { fg, theme: { fg } as never };
}

const saved = { tone: "neutral" as const, text: "Plan saved", context: "/plans/calm-river.md" };
const longLines = Array.from({ length: COLLAPSED_LINES + 3 }, (_, i) => `Plan line ${i + 1}`);

test("neutral status uses muted text and dim saved-path context, not success or warning", () => {
  const { fg, theme } = themeSpy();
  assert.equal(reviewStatusLine(theme, saved), "Plan saved · /plans/calm-river.md");
  assert.deepEqual(fg.mock.calls, [
    ["dim", " · /plans/calm-river.md"],
    ["muted", "Plan saved"],
  ]);
  assert.ok(fg.mock.calls.every(([role]) => role !== "success" && role !== "warning"));
});

test("collapsed long neutral body folds to the first lines and keeps its saved status", () => {
  const { fg, theme } = themeSpy();
  const markdown = vi.fn((text: string) => new Text(text, 0, 0));
  const body = reviewBody(theme, longLines.join("\n"), saved, { expanded: false }, markdown);
  assert.deepEqual(markdown.mock.calls, [[longLines.slice(0, COLLAPSED_LINES).join("\n")]]);
  assert.deepEqual(
    body.render(120).map((line) => line.trimEnd()),
    [
      ...longLines.slice(0, COLLAPSED_LINES),
      "… 3 more lines (ctrl+o to expand)",
      "",
      "Plan saved · /plans/calm-river.md",
    ],
  );
  assert.ok(fg.mock.calls.some(([role, text]) => role === "dim" && text.includes("3 more lines")));
  assert.ok(fg.mock.calls.every(([role]) => role !== "success" && role !== "warning"));
});

for (const status of [saved, { tone: "pending" as const, text: "Waiting for approval" }]) {
  test(`${status.tone} long body stays full when ${status.tone === "pending" ? "collapsed" : "expanded"}`, () => {
    const { theme } = themeSpy();
    const markdown = vi.fn((text: string) => new Text(text, 0, 0));
    const text = longLines.join("\n");
    const body = reviewBody(theme, text, status, { expanded: status.tone === "neutral" }, markdown);
    assert.deepEqual(markdown.mock.calls, [[text]]);
    assert.deepEqual(
      body.render(120).map((line) => line.trimEnd()),
      [...longLines, "", status.tone === "neutral" ? "Plan saved · /plans/calm-river.md" : status.text],
    );
  });
}

for (const length of [2, COLLAPSED_LINES]) {
  test(`collapsed neutral body with ${length} lines stays unfolded`, () => {
    const { theme } = themeSpy();
    const markdown = vi.fn((text: string) => new Text(text, 0, 0));
    const lines = longLines.slice(0, length);
    const text = lines.join("\n");
    const body = reviewBody(theme, text, saved, { expanded: false }, markdown);
    assert.deepEqual(markdown.mock.calls, [[text]]);
    assert.deepEqual(
      body.render(120).map((line) => line.trimEnd()),
      [...lines, "", "Plan saved · /plans/calm-river.md"],
    );
  });
}
