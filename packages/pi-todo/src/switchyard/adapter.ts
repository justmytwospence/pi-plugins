/**
 * Switchyard adapter for @justmytwospence/pi-todo. Self-contained: the host loads this file with
 * Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * On contract v2 hosts the list is a Todo tracker above the input (`Todo 2/5 · writing tests`,
 * opening to a checklist) and a session badge while items are open, and each `todo` call is a
 * one-line row; older hosts get the Todo panel and pill.
 */

import type {
  AdapterContext as HostContext,
  AdapterFeature,
  ChecklistItem,
  ToolEndEvent,
  ToolInfo,
  ToolViewData,
  UINode,
} from "./contract.ts";

/** What the adapter uses of its context; `setContribution` is missing on the oldest hosts. */
export type AdapterContext = Pick<HostContext, "state" | "setPanel" | "features"> &
  Partial<Pick<HostContext, "setContribution">>;

/** Contract v2 feature guard: `ctx.features` is undefined on a host from before v2. */
const supports = (ctx: { readonly features?: readonly string[] }, feature: AdapterFeature): boolean =>
  ctx.features?.includes(feature) === true;

/** `todo` tool `details.tasks` -> the "todo" panel. */

export const TOOL_NAME = "todo";

export interface TodoItem {
  title: string;
  status: string;
  /** The in-progress label (`activeForm`). */
  active?: string;
}

const pick = (o: Record<string, unknown>, keys: string[]) =>
  keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.trim() !== "");

/** Normalize task records; tolerant of title/subject/content and status/state field names. */
export function todoItems(tasks: unknown[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const status =
      pick(o, ["status", "state"]) ??
      (o.done === true || o.completed === true ? "completed" : "pending");
    if (status === "deleted") continue;
    const active = pick(o, ["activeForm"]);
    out.push({
      title: pick(o, ["title", "subject", "content", "text", "description"]) ?? "(untitled)",
      status,
      ...(active ? { active } : {}),
    });
  }
  return out;
}

function mark(status: string): string {
  if (status === "completed" || status === "done") return "[x]";
  if (status === "in_progress" || status === "active") return "[~]";
  if (status === "pending" || status === "todo") return "[ ]";
  return `[${status}]`;
}

export function todoPanel(items: TodoItem[]): UINode | null {
  if (items.length === 0) return null;
  return {
    t: "list",
    items: items.map((i): UINode => {
      const text = `${mark(i.status)} ${i.title}`;
      return i.status === "completed" || i.status === "done"
        ? { t: "text", text, tone: "muted" }
        : { t: "text", text };
    }),
  };
}

const isDone = (status: string) => status === "completed" || status === "done";
const isActive = (status: string) => status === "in_progress" || status === "active";

function checkState(status: string): ChecklistItem["state"] {
  if (isDone(status)) return "done";
  if (isActive(status)) return "doing";
  if (status === "pending" || status === "todo") return "todo";
  return "skipped";
}

/** `2/5` and the step in progress. */
export function todoSummary(items: TodoItem[]): { count: string; step?: string; open: boolean; active: boolean } {
  const done = items.filter((i) => isDone(i.status)).length;
  const doing = items.find((i) => isActive(i.status));
  const step = doing ? (doing.active ?? doing.title).slice(0, 120) : undefined;
  return {
    count: `${done}/${items.length}`,
    ...(step ? { step } : {}),
    open: done < items.length,
    active: !!doing,
  };
}

/** The list as a checklist where the host draws one, else the legacy list. */
export function todoNode(items: TodoItem[], ctx: Pick<AdapterContext, "features">): UINode | null {
  if (!supports(ctx, "ui.nodes.v2")) return todoPanel(items);
  return items.length ? { t: "checklist", items: items.map((i) => ({ text: i.title, state: checkState(i.status) })) } : null;
}

/** Contract v2: the Todo tracker and, while items are open, a badge; the panel and pill go. */
function renderTracker(ctx: AdapterContext & Required<Pick<AdapterContext, "setContribution">>, items: TodoItem[]): void {
  ctx.setPanel("todo", null);
  ctx.setContribution("todo", null);
  ctx.setContribution("todo-pill", null);
  const node = todoNode(items, ctx);
  const s = todoSummary(items);
  const fallback = items.map((i) => `${mark(i.status)} ${i.title}`).join("\n").slice(0, 2000);
  ctx.setContribution(
    "todo-tracker",
    node
      ? {
          placement: "composer.tracker",
          title: "Todo",
          node,
          mobileFallback: fallback,
          tracker: {
            count: s.count,
            status: s.active ? "running" : s.open ? "idle" : "ok",
            ...(s.step ? { step: s.step } : {}),
          },
        }
      : null,
  );
  ctx.setContribution(
    "todo-badge",
    node && s.open
      ? {
          placement: "session.badge",
          title: "Todo",
          node: { t: "badge", text: `Todo ${s.count}`.slice(0, 24) },
          mobileFallback: `Todo ${s.count}`,
        }
      : null,
  );
}

/** Display state only; Pi remains the sole owner of todo mutations. */
export function renderTodo(ctx: AdapterContext): void {
  const items = ctx.state.get<TodoItem[]>("items") ?? [];
  if (ctx.setContribution && supports(ctx, "adapter.trackers.v1")) {
    renderTracker(ctx as AdapterContext & Required<Pick<AdapterContext, "setContribution">>, items);
    return;
  }
  const node = todoPanel(items);
  const fallback = items.map((i) => `${mark(i.status)} ${i.title}`).join("\n");
  if (ctx.setContribution) {
    ctx.setPanel("todo", null);
    ctx.setContribution("todo", node ? {
      placement: "session.panel", title: "Todo", node, mobileFallback: fallback.slice(0, 2000),
    } : null);
    const complete = items.filter((i) => i.status === "completed" || i.status === "done").length;
    const text = `Todo: ${complete} of ${items.length} complete`;
    ctx.setContribution("todo-pill", node ? {
      placement: "composer.pill", title: "Todo", node: { t: "text", text }, mobileFallback: text,
    } : null);
  } else {
    ctx.setPanel("todo", node, { title: "Todo", mobileFallback: fallback || null });
  }
}

const tasksOf = (tool: { details?: unknown; result?: unknown }): unknown[] | undefined => {
  const details = (tool.details ?? (tool.result as { details?: unknown } | null | undefined)?.details) as
    | { tasks?: unknown }
    | undefined;
  return Array.isArray(details?.tasks) ? details.tasks : undefined;
};

const VERBS: Record<string, [string, string]> = {
  create: ["Added todo", "Adding todo"],
  list: ["Listed todos", "Listing todos"],
  get: ["Read todo", "Reading todo"],
  delete: ["Deleted todo", "Deleting todo"],
  clear: ["Cleared todos", "Clearing todos"],
};
const STATUS_VERBS: Record<string, [string, string]> = {
  in_progress: ["Started todo", "Starting todo"],
  completed: ["Completed todo", "Completing todo"],
  pending: ["Reopened todo", "Reopening todo"],
  deleted: ["Deleted todo", "Deleting todo"],
};

/** Contract v2: one row per `todo` call (`Completed todo Write the tests · 3/5`), opening to the list. */
export function todoView(tool: ToolInfo, ctx: AdapterContext): ToolViewData | undefined {
  if (tool.name !== TOOL_NAME) return undefined;
  const args = (tool.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" ? args.action : "";
  const status = typeof args.status === "string" ? args.status : "";
  const [verb, activeVerb] =
    (action === "update" ? STATUS_VERBS[status] : VERBS[action]) ?? ["Updated todo", "Updating todo"];
  const tasks = tasksOf(tool);
  const items = tasks ? todoItems(tasks) : undefined;
  let target = typeof args.subject === "string" ? args.subject : "";
  if (!target && typeof args.id === "number" && tasks) {
    const task = tasks.find((t) => (t as { id?: unknown } | null)?.id === args.id) as Record<string, unknown> | undefined;
    target = typeof task?.subject === "string" ? task.subject : `#${args.id}`;
  } else if (!target && typeof args.id === "number") target = `#${args.id}`;
  const node = items ? todoNode(items, ctx) : null;
  return {
    kind: "other",
    verb,
    activeVerb,
    target: target.slice(0, 500),
    meta: tool.isError ? ["failed"] : items?.length ? [todoSummary(items).count] : [],
    ...(node ? { detail: node } : {}),
  };
}

export default {
  onRestore: renderTodo,
  toolView: todoView,

  onToolEnd(e: ToolEndEvent, ctx: AdapterContext): void {
    if (e.name !== TOOL_NAME) return;
    const tasks = tasksOf(e);
    if (!tasks) return;
    ctx.state.set("items", todoItems(tasks));
    renderTodo(ctx);
  },
};
