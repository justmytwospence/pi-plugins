import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.js";

type Ctx = Parameters<NonNullable<typeof adapter.onStatus>>[2];
type UINode = Parameters<Ctx["setPanel"]>[1];
type PanelOptions = Parameters<Ctx["setPanel"]>[2];

function makeCtx(modern = false) {
  const store = new Map<string, unknown>();
  const panels: { slot: string; node: UINode | null; opts?: PanelOptions }[] = [];
  const contributions: { id: string; value: Parameters<NonNullable<Ctx["setContribution"]>>[1] }[] = [];
  const ctx: Ctx = {
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    setPanel: (slot: string, node: UINode | null, opts?: PanelOptions) => void panels.push({ slot, node, opts }),
    ...(modern
      ? {
          setContribution: (id: string, value: Parameters<NonNullable<Ctx["setContribution"]>>[1]) =>
            void contributions.push({ id, value }),
        }
      : {}),
  };
  return { ctx, panels, contributions };
}

describe("plan-mode switchyard adapter", () => {
  it("restores portable plan/changes and workflow status without claiming an approval", () => {
    const { ctx, contributions, panels } = makeCtx(true);
    adapter.onToolUpdate(exitUpdate({ changes: ["Keep exact text"] }), ctx);
    adapter.onStatus("workflow-mode", "planning", ctx);
    adapter.onToolEnd({ toolCallId: "t1", name: "exit_plan_mode", args: {}, result: {}, isError: true }, ctx);
    expect(adapter.claimInteraction(approval, ctx)).toBeUndefined();
    contributions.length = 0;
    panels.length = 0;
    adapter.onRestore(ctx);
    expect(panels).toEqual([
      { slot: "plan", node: null, opts: undefined },
      { slot: "plan-status", node: null, opts: undefined },
    ]);
    expect(contributions).toMatchObject([
      { id: "plan", value: { placement: "session.panel", title: "Plan" } },
      { id: "plan-pill", value: { placement: "composer.pill", node: { t: "text", text: "planning" } } },
    ]);
    expect(JSON.stringify(contributions)).toContain("Keep exact text");
    expect(JSON.stringify(contributions)).toContain("# Plan");
    expect(JSON.stringify(contributions)).not.toMatch(/approved|executing/);
    const snapshot = structuredClone(contributions);
    contributions.length = 0;
    adapter.onRestore(ctx);
    expect(contributions).toEqual(snapshot);
    adapter.onStatus("workflow-mode", undefined, ctx);
    expect(contributions.at(-1)).toEqual({ id: "plan-pill", value: null });
  });

  it("plan text alone creates no workflow pill; empty display clears both slots", () => {
    const { ctx, contributions } = makeCtx(true);
    adapter.onToolUpdate(exitUpdate(), ctx);
    expect(contributions.at(-1)).toEqual({ id: "plan-pill", value: null });
    ctx.state.delete("display-plan");
    contributions.length = 0;
    adapter.onRestore(ctx);
    expect(contributions).toEqual([
      { id: "plan", value: null },
      { id: "plan-pill", value: null },
    ]);
  });

  const exitUpdate = (over: Record<string, unknown> = {}) => ({
    toolCallId: "t1",
    name: "exit_plan_mode",
    args: {},
    partialResult: {},
    details: { plan: "# Plan\n1. Do it", outcome: "pending", ...over },
  });
  const approval = {
    id: "r1",
    method: "select" as const,
    title: "Implement this plan?",
    options: ["Yes", "Edit the plan", "No"],
  };

  it("exit_plan_mode updates set the plan panel and keep the plan for the approval card", async () => {
    const { ctx, panels } = makeCtx();
    await adapter.onToolUpdate({ ...exitUpdate(), name: "other" }, ctx);
    expect(panels).toHaveLength(0);
    await adapter.onToolUpdate(exitUpdate(), ctx);
    expect(panels[0]).toMatchObject({
      slot: "plan",
      node: { t: "markdown", text: "# Plan\n1. Do it" },
      opts: { title: "Plan" },
    });
    expect(ctx.state.keys()).toContain("plan:t1");
  });

  it("claims the approval question with the plan, changes and one action per option", async () => {
    const { ctx } = makeCtx();
    expect(await adapter.claimInteraction(approval, ctx)).toBeUndefined();
    await adapter.onToolUpdate(exitUpdate({ changes: ["Dropped step 3"] }), ctx);
    const claim = (await adapter.claimInteraction(approval, ctx))!;
    expect(claim.title).toBe("Implement this plan?");
    const node = claim.presentation as { t: string; children: any[] };
    expect(node.children[0]).toEqual({ t: "markdown", text: "# Plan\n1. Do it" });
    expect(node.children[1]).toMatchObject({ t: "section", title: "Changes since the last version" });
    expect(node.children.at(-1).actions.map((x: { label: string }) => x.label)).toEqual(approval.options);
    expect(claim.toPiResponse({ kind: "action", actionId: "option-1" })).toEqual({ value: "Edit the plan" });
    expect(claim.toPiResponse({ kind: "cancel" })).toEqual({ cancelled: true });
    expect(() => claim.toPiResponse({ kind: "action", actionId: "option-9" })).toThrow(/unknown approval option/);
    expect(await adapter.claimInteraction({ ...approval, title: "Something else" }, ctx)).toBeUndefined();
  });

  it("cancellation clears pending approval ownership but retains the display plan", () => {
    const { ctx } = makeCtx();
    adapter.onToolUpdate(exitUpdate(), ctx);
    const claim = adapter.claimInteraction(approval, ctx);
    expect(claim?.toPiResponse({ kind: "cancel" })).toEqual({ cancelled: true });
    expect(ctx.state.keys()).not.toContain("plan:t1");
    expect(ctx.state.get("display-plan")).toEqual({ plan: "# Plan\n1. Do it" });
    expect(adapter.claimInteraction(approval, ctx)).toBeUndefined();
  });

  it("shows the plan in the finished tool card and clears the state", async () => {
    const { ctx } = makeCtx();
    await adapter.onToolUpdate(exitUpdate(), ctx);
    expect(adapter.toolCard({ toolCallId: "t1", name: "exit_plan_mode", args: {} }, ctx)).toBeUndefined();
    const card = adapter.toolCard({ toolCallId: "t1", name: "exit_plan_mode", args: {}, result: {} }, ctx);
    expect(card).toMatchObject({
      t: "section",
      title: "Plan",
      children: [{ t: "markdown", text: "# Plan\n1. Do it" }],
    });
    expect(ctx.state.keys()).not.toContain("plan:t1");
  });

  it("maps status keys to the plan-status table", async () => {
    const { ctx, panels } = makeCtx();
    expect(await adapter.onStatus("workflow-mode", "planning", ctx)).toBe(true);
    await adapter.onStatus("plan", "3 steps", ctx);
    await adapter.onStatus("workflow-mode", undefined, ctx);
    expect(await adapter.onStatus("unrelated", "x", ctx)).toBe(false);
    expect(panels.at(-1)).toMatchObject({ slot: "plan-status", node: { t: "table", rows: [["plan", "3 steps"]] } });
  });
});
