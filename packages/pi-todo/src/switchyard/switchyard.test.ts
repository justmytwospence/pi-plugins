import { describe, expect, it } from "vitest";
import adapter from "./adapter.ts";

type Ctx = Parameters<typeof adapter.onToolEnd>[1];
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
    ...(modern ? { setContribution: (id: string, value: Parameters<NonNullable<Ctx["setContribution"]>>[1]) => void contributions.push({ id, value }) } : {}),
  };
  return { ctx, panels, contributions };
}

const end = (name: string, result: unknown) => ({ toolCallId: "c1", name, args: {}, result, isError: false });

describe("todo switchyard adapter", () => {
  it("persists normalized display, restores portable slots, and clears an empty/deleted list", () => {
    const { ctx, panels, contributions } = makeCtx(true);
    adapter.onToolEnd(end("todo", { details: { tasks: [
      { subject: "Done", status: "completed" }, { title: "Next" }, { title: "Gone", status: "deleted" },
    ] } }), ctx);
    expect(ctx.state.get("items")).toEqual([{ title: "Done", status: "completed" }, { title: "Next", status: "pending" }]);
    expect(panels).toMatchObject([{ slot: "todo", node: null }]);
    expect(contributions).toMatchObject([
      { id: "todo", value: { placement: "session.panel", title: "Todo" } },
      { id: "todo-pill", value: { placement: "composer.pill", node: { text: "Todo: 1 of 2 complete" } } },
    ]);
    const node = contributions[0]!.value!.node;
    expect(node).not.toHaveProperty("ordered");
    expect(JSON.parse(JSON.stringify(node))).toEqual(node);
    const snapshot = structuredClone(contributions);
    contributions.length = 0;
    adapter.onRestore(ctx);
    expect(contributions).toEqual(snapshot);
    adapter.onToolEnd(end("todo", { details: { tasks: [{ status: "deleted" }] } }), ctx);
    expect(contributions.slice(-2)).toEqual([{ id: "todo", value: null }, { id: "todo-pill", value: null }]);
  });

  it("todo tool details.tasks -> todo panel list", async () => {
    const { ctx, panels } = makeCtx();
    await adapter.onToolEnd(
      end("todo", {
        details: {
          tasks: [
            { id: 1, subject: "Write tests", status: "in_progress" },
            { id: 2, subject: "Ship", status: "pending" },
            { id: 3, subject: "Plan", status: "completed" },
            { id: 4, subject: "Gone", status: "deleted" },
          ],
        },
      }),
      ctx,
    );
    expect(panels[0]).toMatchObject({
      slot: "todo",
      opts: { title: "Todo", mobileFallback: "[~] Write tests\n[ ] Ship\n[x] Plan" },
      node: {
        t: "list",
        items: [
          { t: "text", text: "[~] Write tests" },
          { t: "text", text: "[ ] Ship" },
          { t: "text", text: "[x] Plan", tone: "muted" },
        ],
      },
    });
  });

  it("ignores other tools and results without tasks; an empty list clears the panel", async () => {
    const { ctx, panels } = makeCtx();
    await adapter.onToolEnd(end("bash", { details: { tasks: [{ title: "x" }] } }), ctx);
    await adapter.onToolEnd(end("todo", { details: {} }), ctx);
    expect(panels).toEqual([]);
    await adapter.onToolEnd(end("todo", { details: { tasks: [] } }), ctx);
    expect(panels).toMatchObject([{ slot: "todo", node: null, opts: { mobileFallback: null } }]);
  });
});
