import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.js";

type Ctx = Parameters<NonNullable<typeof adapter.onStatus>>[2];
type UINode = Parameters<Ctx["setPanel"]>[1];
type PanelOptions = Parameters<Ctx["setPanel"]>[2];

function makeCtx() {
  const store = new Map<string, unknown>();
  const panels: { slot: string; node: UINode | null; opts?: PanelOptions }[] = [];
  const ctx = {
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    setPanel: (slot: string, node: UINode | null, opts?: PanelOptions) => void panels.push({ slot, node, opts }),
  };
  return { ctx, panels };
}

describe("plan-mode switchyard adapter", () => {
  it("plan message -> plan panel; status keys -> plan-status table", async () => {
    const { ctx, panels } = makeCtx();
    await adapter.onCustomMessage({ customType: "plan-mode-plan", content: "# Plan\n1. Do it" }, ctx);
    await adapter.onCustomMessage({ customType: "other", content: "ignored" }, ctx);
    expect(await adapter.onStatus("workflow-mode", "planning", ctx)).toBe(true);
    await adapter.onStatus("plan", "3 steps", ctx);
    await adapter.onStatus("workflow-mode", undefined, ctx);
    expect(await adapter.onStatus("unrelated", "x", ctx)).toBe(false);
    expect(panels[0]).toMatchObject({
      slot: "plan",
      node: { t: "markdown", text: "# Plan\n1. Do it" },
      opts: { title: "Plan" },
    });
    expect(panels.filter((p) => p.slot === "plan")).toHaveLength(1);
    expect(panels.at(-1)).toMatchObject({
      slot: "plan-status",
      node: { t: "table", rows: [["plan", "3 steps"]] },
    });
  });

  it("reads text content blocks and clears the plan panel when empty", async () => {
    const { ctx, panels } = makeCtx();
    await adapter.onCustomMessage(
      {
        customType: "plan-mode-plan",
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      },
      ctx,
    );
    await adapter.onCustomMessage({ customType: "plan-mode-plan", content: "  " }, ctx);
    expect(panels[0]?.node).toEqual({ t: "markdown", text: "a\n\nb" });
    expect(panels[1]?.node).toBeNull();
  });
});
