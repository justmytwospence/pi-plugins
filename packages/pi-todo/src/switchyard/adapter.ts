/**
 * Switchyard adapter for @justmytwospence/pi-todo. Self-contained: the host loads this file with
 * Node's native type stripping, so it imports nothing and uses erasable TypeScript only. The
 * local types are structurally compatible with Switchyard's UINode and AdapterContext.
 */

export type UINode =
  | { t: "text"; text: string; tone?: "default" | "muted" | "success" | "warning" | "danger" }
  | { t: "markdown"; text: string }
  | { t: "list"; items: UINode[]; ordered?: boolean }
  | { t: "table"; columns: string[]; rows: string[][] }
  | { t: "section"; title?: string; collapsible?: boolean; children: UINode[] }
  | { t: "progress"; label: string; value?: number; status?: "running" | "ok" | "error" };
type PanelOptions = { title?: string; mobileFallback?: string | null; state?: unknown };
export type AdapterContext = {
  readonly state: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    keys(): string[];
  };
  setPanel(slot: string, node: UINode | null, opts?: PanelOptions): void;
};
export type ToolEndEvent = {
  toolCallId: string;
  name: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  details?: unknown;
};

/** `todo` tool `details.tasks` -> the "todo" panel. */

export const TOOL_NAME = "todo";

export interface TodoItem {
  title: string;
  status: string;
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
    out.push({
      title: pick(o, ["title", "subject", "content", "text", "description"]) ?? "(untitled)",
      status,
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
    ordered: undefined,
  };
}

export default {
  onToolEnd(e: ToolEndEvent, ctx: AdapterContext): void {
    if (e.name !== TOOL_NAME) return;
    const details = (e.details ?? (e.result as { details?: unknown } | null)?.details) as
      | { tasks?: unknown }
      | undefined;
    if (!Array.isArray(details?.tasks)) return;
    const items = todoItems(details.tasks);
    ctx.setPanel("todo", todoPanel(items), {
      title: "Todo",
      mobileFallback: items.map((i) => `${mark(i.status)} ${i.title}`).join("\n") || null,
    });
  },
};
