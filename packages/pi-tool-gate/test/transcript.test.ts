import { expect, test } from "vitest";
import { approvedPlanOf, callerText } from "../src/transcript.ts";

const entry = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
const snapshot = (customType: string, content: unknown) => ({
  id: "snapshot", parentId: null, timestamp: "2026-10-30T00:00:00Z",
  type: "custom_message", customType, content, display: true,
  details: { planFile: "/nonexistent/mutable-plan.md", lines: 1 },
});

for (const type of ["plan-mode-handoff", "plan-mode-implementation"]) {
  test(`approvedPlanOf reads the stored ${type} content, not its file metadata`, () => {
    const content = "The user approved the plan.\n\n## Approved plan\n\nImplement only the tests.";
    expect(approvedPlanOf([snapshot(type, content)])).toBe(content);
    expect(approvedPlanOf([snapshot(type, [{ type: "text", text: content }, { type: "image", data: "ignored" }])])).toBe(content);
  });
}

test("approvedPlanOf chooses the latest recognized custom message across both types", () => {
  const branch = [snapshot("plan-mode-handoff", "old"), snapshot("plan-mode-implementation", "new")];
  expect(approvedPlanOf(branch)).toBe("new");
  expect(approvedPlanOf([...branch, snapshot("plan-mode-handoff", "newest")])).toBe("newest");
  expect(approvedPlanOf([...branch, snapshot("other", "not approval")])).toBe("new");
});

const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });

test("withdrawal stays invalid after six unrelated user messages", () => {
  const branch = [
    snapshot("plan-mode-handoff", "Deploy the site"),
    user("Do not deploy; approval withdrawn."),
    ...Array.from({ length: 6 }, (_, i) => user(`Unrelated question ${i}`)),
  ];
  expect(approvedPlanOf(branch)).toBeUndefined();
});

test("even a benign follow-up or textless user entry invalidates approval", () => {
  for (const content of ["Thanks, how is it going?", "", undefined, [{ type: "image", data: "ignored" }]]) {
    expect(approvedPlanOf([snapshot("plan-mode-handoff", "Deploy"), user(content)])).toBeUndefined();
  }
});

for (const type of ["plan-mode-handoff", "plan-mode-implementation"]) {
  test(`fresh ${type} reapproval reinstates only its active branch`, () => {
    const shared = [snapshot("plan-mode-handoff", "Old approval"), user("Stop")];
    const reapproved = [...shared, user("Approve the revised plan"), snapshot(type, "Revised approval")];
    const sibling = [...shared, user("Keep it stopped")];
    expect(approvedPlanOf(reapproved)).toBe("Revised approval");
    expect(approvedPlanOf(sibling)).toBeUndefined();
    expect(approvedPlanOf(shared)).toBeUndefined();
    expect(approvedPlanOf(reapproved)).toBe("Revised approval");
  });
}

test("approvedPlanOf clips stored content to 12000 characters", () => {
  const exact = "x".repeat(12_000);
  expect(approvedPlanOf([snapshot("plan-mode-handoff", exact)])).toBe(exact);
  const clipped = approvedPlanOf([snapshot("plan-mode-handoff", exact + "overflow")]);
  expect(clipped).toHaveLength(12_000);
  expect(clipped).toBe("x".repeat(11_999) + "…");
});

test("approvedPlanOf is isolated to the supplied active branch and resets on replacement", () => {
  const shared = [entry([{ type: "text", text: "The plan is approved" }])];
  const branchA = [...shared, snapshot("plan-mode-handoff", "branch A")];
  const branchB = [...shared, snapshot("plan-mode-implementation", "branch B")];
  expect(approvedPlanOf(branchA)).toBe("branch A");
  expect(approvedPlanOf(branchB)).toBe("branch B");
  expect(approvedPlanOf(shared)).toBeUndefined();
  expect(approvedPlanOf([])).toBeUndefined();
  expect(approvedPlanOf(branchA)).toBe("branch A");
});

test("approvedPlanOf never infers approval from prose, custom state, paths or malformed content", () => {
  expect(approvedPlanOf([
    null, undefined, entry([{ type: "text", text: "Approved plan: deploy" }]),
    { type: "message", message: { role: "user", content: "Approved plan" } },
    { type: "custom", customType: "plan-mode-handoff", data: { planFile: "/plan.md" } },
    snapshot("unrelated", "Approved plan"),
  ])).toBeUndefined();
  for (const content of [undefined, null, 7, {}, "", [{ type: "image", data: "ignored" }]]) {
    expect(approvedPlanOf([snapshot("plan-mode-handoff", "old"), snapshot("plan-mode-implementation", content)])).toBeUndefined();
  }
});

const call = { type: "toolCall", id: "t1", name: "bash", arguments: {} };

test("callerText prefers the visible text beside the call", () => {
  const branch = [entry([{ type: "thinking", thinking: "private" }, { type: "text", text: "Pushing is what you asked for." }, call])];
  expect(callerText(branch, "t1")).toBe("Pushing is what you asked for.");
});

test("callerText falls back to thinking when the agent wrote no text", () => {
  const branch = [
    entry([
      { type: "thinking", thinking: "", redacted: true },
      { type: "thinking", thinking: "Pushing this branch and opening the PR, as you chose.\n\n" },
      call,
    ]),
  ];
  expect(callerText(branch, "t1")).toBe("Pushing this branch and opening the PR, as you chose.");
});

test("callerText is empty when the call came with neither", () => {
  expect(callerText([entry([call])], "t1")).toBe("");
  expect(callerText([entry([{ type: "text", text: "other" }])], "t1")).toBe("");
});
