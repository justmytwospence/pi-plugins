import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { ApprovalPicker, type ApprovalResult, createApprovalState, LINKED_FRESH } from "../src/approval-picker.js";
import type { ModelSpecThinkingLevel } from "../src/implementation-models.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const target = { provider: "test", modelId: "same-plan-and-worker", thinkingLevel: "high" as const };
const input = {
  intent: "linked-execution" as const,
  planning: target,
  targets: [{ target, targetName: "Worker" }],
  freshTarget: { target: { ...target, thinkingLevel: "medium" as const }, targetName: "Worker" },
};
const down = "\x1b[B";
const up = "\x1b[A";
const right = "\x1b[C";
function fixture(state = createApprovalState()) {
  const done = vi.fn<(result: ApprovalResult | undefined) => void>();
  const component = new ApprovalPicker(
    input,
    state,
    { efforts: () => ["off", "low", "medium", "high"] as ModelSpecThinkingLevel[] },
    theme,
    getKeybindings(),
    () => {},
    done,
  );
  return { component, state, done };
}

test("fresh worker effort is separate from retained in-place/compact effort, including after Edit", () => {
  const first = fixture();
  first.component.handleInput(down);
  assert.match(first.component.render(120).join("\n"), /effort: high/u);
  first.component.handleInput(down);
  assert.match(first.component.render(120).join("\n"), /effort: medium/u);
  first.component.handleInput(right);
  first.component.handleInput(right); // explicit fresh off
  first.component.handleInput(up);
  assert.match(first.component.render(120).join("\n"), /effort: high/u);
  first.component.handleInput(down);
  first.component.dispose();
  const reopened = fixture(first.state);
  assert.match(reopened.component.render(120).join("\n"), /effort: off/u);
  reopened.component.handleInput("\r");
  const result = reopened.done.mock.calls[0]?.[0];
  assert.equal(result?.thinkingLevel, "off");
  assert.equal(result?.choice.kind, "handoff");
  if (result?.choice.kind === "handoff") assert.equal(result.choice.context, "clear");
});

for (const width of [46, 120, 180]) {
  test(`fresh option is a plain short label at ${width} columns`, () => {
    const { component } = fixture();
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    assert.ok(lines.some((line) => line.trim() === LINKED_FRESH));
    assert.ok(visibleWidth(LINKED_FRESH) <= 42);
    assert.ok(!lines.join(" ").includes("use /planners"));
    component.dispose();
  });
}
