import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { registerWorkflowRenderer, sendWorkflowTransition } from "../src/workflow-ui.js";

const theme: any = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

function fake() {
  const branch: any[] = [];
  const sent: any[] = [];
  const renderers: Record<string, any> = {};
  const messageRenderers: Record<string, any> = {};
  let n = 0;
  const pi: any = {
    registerEntryRenderer: (t: string, r: any) => (renderers[t] = r),
    registerMessageRenderer: (t: string, r: any) => (messageRenderers[t] = r),
    on() {},
    sendMessage: (message: any) => sent.push(message),
    appendEntry: (customType: string, data: any) =>
      branch.push({ id: `wf${n++}`, type: "custom", customType, data, timestamp: new Date().toISOString() }),
  };
  const ctx: any = { sessionManager: { getBranch: () => branch } };
  return { pi, ctx, branch, sent, renderers, messageRenderers };
}

test("work -> chat -> plan with nothing between shows one row reading plan", () => {
  const f = fake();
  registerWorkflowRenderer(f.pi);
  sendWorkflowTransition(f.pi, f.ctx, "work", "chat");
  sendWorkflowTransition(f.pi, f.ctx, "chat", "plan");
  assert.deepEqual(f.branch.map((e) => e.customType), ["workflow:row", "workflow:row-state"]);
  assert.ok(f.sent.every((m) => m.display === false && m.customType === "workflow:transition"));
  const text = f.renderers["workflow:row"](f.branch[0], { expanded: false }, theme).render(100).join("\n");
  expect(text).toContain("plan");
  expect(text).toContain("research and plan only");
  expect(text).not.toContain("chat");
});

test("a visible entry in between starts a new row, and a round trip draws nothing", () => {
  const f = fake();
  registerWorkflowRenderer(f.pi);
  sendWorkflowTransition(f.pi, f.ctx, "work", "chat");
  f.branch.push({ id: "m", type: "message" });
  sendWorkflowTransition(f.pi, f.ctx, "chat", "work");
  assert.equal(f.branch.filter((e) => e.customType === "workflow:row").length, 2);
  const g = fake();
  registerWorkflowRenderer(g.pi);
  sendWorkflowTransition(g.pi, g.ctx, "work", "chat");
  sendWorkflowTransition(g.pi, g.ctx, "chat", "work");
  assert.equal(g.renderers["workflow:row"](g.branch[0], { expanded: false }, theme), undefined);
});

test("the legacy transition message draws the same row", () => {
  const f = fake();
  registerWorkflowRenderer(f.pi);
  const message = { content: "plan", details: { version: 1, previous: "work", mode: "plan" }, timestamp: Date.now() };
  const text = f.messageRenderers["workflow:transition"](message, { expanded: false }, theme).render(100).join("\n");
  expect(text).toContain("plan");
  expect(text).toContain("research and plan only");
});
