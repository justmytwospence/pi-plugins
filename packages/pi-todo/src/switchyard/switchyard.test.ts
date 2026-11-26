import { describe, expect, it } from "vitest";
import adapter from "./adapter.ts";

type Ctx = Parameters<typeof adapter.onToolEnd>[1];
type UINode = Parameters<Ctx["setPanel"]>[1];
type PanelOptions = Parameters<Ctx["setPanel"]>[2];

function makeCtx(modern = false, features?: string[]) {
  const store = new Map<string, unknown>();
  const panels: { slot: string; node: UINode | null; opts?: PanelOptions }[] = [];
  const contributions: { id: string; value: Parameters<NonNullable<Ctx["setContribution"]>>[1] }[] = [];
  const ctx: Ctx = {
    ...(features ? { features } : {}),
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

describe("contract v2", () => {
  const V2 = ["tool.views.v1", "ui.nodes.v2", "adapter.trackers.v1", "interaction.kinds.v1"];
  const tasks = [
    { id: 1, subject: "Write the tests", activeForm: "writing tests", status: "in_progress" },
    { id: 2, subject: "Ship", status: "pending" },
    { id: 3, subject: "Plan", status: "completed" },
    { id: 4, subject: "Gone", status: "deleted" },
  ];
  const latest = (contributions: { id: string; value: unknown }[], id: string) =>
    contributions.filter((c) => c.id === id).at(-1)?.value;

  it("the list is a Todo tracker with a checklist, and a badge while items are open", () => {
    const { ctx, contributions, panels } = makeCtx(true, V2);
    adapter.onToolEnd({ ...end("todo", {}), details: { tasks } }, ctx);
    expect(latest(contributions, "todo-tracker")).toEqual({
      placement: "composer.tracker",
      title: "Todo",
      node: {
        t: "checklist",
        items: [
          { text: "Write the tests", state: "doing" },
          { text: "Ship", state: "todo" },
          { text: "Plan", state: "done" },
        ],
      },
      mobileFallback: "[~] Write the tests\n[ ] Ship\n[x] Plan",
      tracker: { count: "1/3", status: "running", step: "writing tests" },
    });
    expect(latest(contributions, "todo-badge")).toMatchObject({ placement: "session.badge", node: { t: "badge", text: "Todo 1/3" } });
    expect(latest(contributions, "todo")).toBeNull();
    expect(latest(contributions, "todo-pill")).toBeNull();
    expect(panels).toEqual([{ slot: "todo", node: null, opts: undefined }]);
    adapter.onToolEnd({ ...end("todo", {}), details: { tasks: tasks.map((t) => ({ ...t, status: "completed" })) } }, ctx);
    expect(latest(contributions, "todo-tracker")).toMatchObject({ tracker: { count: "4/4", status: "ok" } });
    expect(latest(contributions, "todo-badge")).toBeNull();
    adapter.onToolEnd({ ...end("todo", {}), details: { tasks: [] } }, ctx);
    expect(latest(contributions, "todo-tracker")).toBeNull();
  });

  it("each todo call is a one-line row with the list behind it", () => {
    const { ctx } = makeCtx(true, V2);
    const call = (args: Record<string, unknown>, done = true) => ({
      toolCallId: "c1", name: "todo", args, ...(done ? { result: {}, details: { tasks } } : {}),
    });
    expect(adapter.toolView(call({ action: "create", subject: "Ship" }, false), ctx)).toEqual({
      kind: "other", verb: "Added todo", activeVerb: "Adding todo", target: "Ship", meta: [],
    });
    expect(adapter.toolView(call({ action: "update", id: 1, status: "completed" }), ctx)).toMatchObject({
      verb: "Completed todo", target: "Write the tests", meta: ["1/3"], detail: { t: "checklist" },
    });
    expect(adapter.toolView(call({ action: "update", id: 2, status: "in_progress" }), ctx)).toMatchObject({ verb: "Started todo", target: "Ship" });
    expect(adapter.toolView(call({ action: "list" }), ctx)).toMatchObject({ verb: "Listed todos", target: "" });
    expect(adapter.toolView({ ...call({ action: "update", id: 9 }), isError: true, details: undefined }, ctx)).toMatchObject({
      verb: "Updated todo", target: "#9", meta: ["failed"],
    });
    expect(adapter.toolView(call({}), makeCtx(true).ctx)).toMatchObject({ detail: { t: "list" } });
    expect(adapter.toolView({ toolCallId: "x", name: "bash", args: {} }, ctx)).toBeUndefined();
  });
});

