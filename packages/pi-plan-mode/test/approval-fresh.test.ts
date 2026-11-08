import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  type ApprovalInput,
  ApprovalPicker,
  type ApprovalResult,
  createApprovalState,
} from "../src/approval-picker.js";
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
function fixture(state = createApprovalState(), approvalInput: ApprovalInput = input) {
  const done = vi.fn<(result: ApprovalResult | undefined) => void>();
  const component = new ApprovalPicker(
    approvalInput,
    state,
    { efforts: () => ["off", "low", "medium", "high"] as ModelSpecThinkingLevel[] },
    theme,
    getKeybindings(),
    () => {},
    done,
  );
  return { component, state, done };
}

function choose(component: ApprovalPicker, context: "keep" | "compact" | "clear") {
  component.handleInput(down);
  component.handleInput("\r");
  const lines = component.render(120).join("\n");
  const labels = ["Keep history", "Compact to approved plan", "Fresh conversation"] as const;
  const desired = context === "keep" ? labels[0] : context === "compact" ? labels[1] : labels[2];
  for (let i = 0; i < 3 && !component.render(120).join("\n").includes(`→ ${desired}`); i++) component.handleInput(down);
  assert.ok(lines.includes(desired));
  component.handleInput("\r");
}

test("fresh effort is isolated and retained across Edit and revised recommendations", () => {
  const first = fixture(createApprovalState(), { ...input, effortDefaultKey: "one", recommendedThinkingLevel: "low" });
  first.component.handleInput(right); // keep medium
  choose(first.component, "clear");
  assert.match(first.component.render(120).join("\n"), /effort: low/u);
  first.component.handleInput(right); // fresh medium
  first.component.handleInput(down);
  first.component.handleInput(down);
  first.component.handleInput("\r");
  assert.equal(first.done.mock.calls[0]?.[0]?.choice.kind, "edit");
  const next = fixture(first.state, { ...input, effortDefaultKey: "two", recommendedThinkingLevel: "high" });
  assert.match(next.component.render(120).join("\n"), /effort: medium/u);
  next.component.handleInput(up);
  next.component.handleInput(up);
  choose(next.component, "compact");
  assert.match(next.component.render(120).join("\n"), /effort: medium/u);
  choose(next.component, "clear");
  next.component.handleInput("\r");
  assert.equal(next.done.mock.calls[0]?.[0]?.thinkingLevel, "medium");
  assert.equal(
    next.done.mock.calls[0]?.[0]?.choice.kind === "handoff" && next.done.mock.calls[0]?.[0]?.choice.context,
    "clear",
  );
});

test("fresh effort precedence preserves setting, recommendation and worker fallback", () => {
  for (const [setting, recommendation, expected] of [
    ["off", "low", "off"],
    [undefined, "low", "low"],
    ["off", undefined, "medium"],
  ] as const) {
    const current = fixture(createApprovalState(), {
      ...input,
      defaultThinkingLevel: setting,
      recommendedThinkingLevel: recommendation,
      effortDefaultKey: "plan",
    });
    choose(current.component, "clear");
    assert.match(current.component.render(120).join("\n"), new RegExp(`effort: ${expected}`));
    current.component.handleInput("\r");
    assert.equal(current.done.mock.calls[0]?.[0]?.thinkingLevel, expected);
  }
});

test("stale fresh capability resets to keep and requires approval", () => {
  const first = fixture();
  choose(first.component, "clear");
  first.component.dispose();
  const next = fixture(first.state, { ...input, freshTarget: undefined });
  assert.equal(first.state.context, "keep");
  assert.equal(next.done.mock.calls.length, 0);
  next.component.handleInput("\r");
  const choice = next.done.mock.calls[0]?.[0]?.choice;
  assert.equal(choice?.kind === "handoff" && choice.context, "keep");
});

for (const width of [46, 120, 180]) {
  test(`fresh stage is short at ${width} columns`, () => {
    const { component } = fixture();
    component.handleInput(down);
    component.handleInput("\r");
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    assert.ok(lines.some((line) => line.trim() === "Fresh conversation"));
    component.dispose();
  });
}
