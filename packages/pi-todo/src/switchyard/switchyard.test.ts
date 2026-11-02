import { describe, expect, it } from "vitest";
import adapter from "./adapter.ts";

type Ctx = Parameters<typeof adapter.onToolEnd>[1];
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

const end = (name: string, result: unknown) => ({ toolCallId: "c1", name, args: {}, result, isError: false });

describe("todo switchyard adapter", () => {
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
