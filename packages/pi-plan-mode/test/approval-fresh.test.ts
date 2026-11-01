import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  type ApprovalInput,
  ApprovalPicker,
  type ApprovalResult,
  createApprovalState,
  LINKED_FRESH,
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

test("recommendation replaces the untouched fresh worker baseline and is approved", () => {
  const recommended = { ...input, effortDefaultKey: "plan-1", recommendedThinkingLevel: "low" as const };
  const { component, done } = fixture(createApprovalState(), recommended);
  component.handleInput(down);
  component.handleInput(down);
  assert.match(component.render(120).join("\n"), /effort: low/u);
  component.handleInput("\r");
  assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, "low");
  assert.equal(done.mock.calls[0]?.[0]?.choice.kind, "handoff");
  const choice = done.mock.calls[0]?.[0]?.choice;
  if (choice?.kind === "handoff") assert.equal(choice.context, "clear");
});

test("manual fresh effort survives revised defaults while untouched in-place effort updates", () => {
  const firstInput = { ...input, effortDefaultKey: "plan-1", recommendedThinkingLevel: "low" as const };
  const first = fixture(createApprovalState(), firstInput);
  first.component.handleInput(down);
  first.component.handleInput(down);
  first.component.handleInput(right); // fresh low -> medium
  first.component.dispose();

  const revised = { ...input, effortDefaultKey: "plan-2", recommendedThinkingLevel: "high" as const };
  const reopened = fixture(first.state, revised);
  assert.match(reopened.component.render(120).join("\n"), /effort: medium/u);
  reopened.component.handleInput(up); // compact shares in-place with keep
  assert.match(reopened.component.render(120).join("\n"), /effort: high/u);
  reopened.component.handleInput(up);
  assert.match(reopened.component.render(120).join("\n"), /effort: high/u);
  reopened.component.dispose();
});

test("manual in-place effort survives revised defaults without contaminating fresh effort", () => {
  const firstInput = { ...input, effortDefaultKey: "plan-1", recommendedThinkingLevel: "low" as const };
  const first = fixture(createApprovalState(), firstInput);
  first.component.handleInput(right); // keep low -> medium
  first.component.handleInput(down); // compact shares the manual choice
  assert.match(first.component.render(120).join("\n"), /effort: medium/u);
  first.component.dispose();

  const revised = { ...input, effortDefaultKey: "plan-2", recommendedThinkingLevel: "high" as const };
  const reopened = fixture(first.state, revised);
  assert.match(reopened.component.render(120).join("\n"), /effort: medium/u);
  reopened.component.handleInput(down);
  assert.match(reopened.component.render(120).join("\n"), /effort: high/u);
  reopened.component.dispose();
});

test("explicit fresh setting takes precedence over recommendation but not an in-place default", () => {
  const configured = {
    ...input,
    defaultThinkingLevel: "off" as const,
    effortDefaultKey: "plan-1",
    recommendedThinkingLevel: "low" as const,
  };
  const { component, done } = fixture(createApprovalState(), configured);
  assert.match(component.render(120).join("\n"), /effort: low/u);
  component.handleInput(down);
  assert.match(component.render(120).join("\n"), /effort: low/u);
  component.handleInput(down);
  assert.match(component.render(120).join("\n"), /effort: off/u);
  component.handleInput("\r");
  assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, "off");
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
