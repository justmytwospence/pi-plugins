/**
 * Switchyard adapter for @justmytwospence/pi-plan-mode. Self-contained: the host loads this file with
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
export type CustomMessageInfo = { customType: string; content: unknown };

/**
 * Panels: the plan custom message becomes the "plan" panel,
 * and the plugin's status keys become the "plan-status" table.
 */

export const PLAN_MESSAGE = "plan-mode-plan";
export const STATUS_KEYS = ["workflow-mode", "plan", "plan-exec"] as const;

/** Text of a custom message `content` (a string or text content blocks). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: unknown }).type === "text"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export default {
  onCustomMessage(m: CustomMessageInfo, ctx: AdapterContext): void {
    if (m.customType !== PLAN_MESSAGE) return;
    const text = contentText(m.content).trim();
    ctx.setPanel("plan", text ? { t: "markdown", text } : null, {
      title: "Plan",
      mobileFallback: text || null,
    });
  },

  onStatus(key: string, text: string | undefined, ctx: AdapterContext): boolean {
    if (!(STATUS_KEYS as readonly string[]).includes(key)) return false;
    const statuses = { ...(ctx.state.get<Record<string, string>>("status") ?? {}) };
    if (text === undefined || text === "") delete statuses[key];
    else statuses[key] = text;
    ctx.state.set("status", statuses);
    const rows = STATUS_KEYS.filter((k) => statuses[k] !== undefined).map((k) => [k, statuses[k] as string]);
    ctx.setPanel("plan-status", rows.length ? { t: "table", columns: ["Key", "Status"], rows } : null, {
      title: "Plan mode",
    });
    return true;
  },
};
