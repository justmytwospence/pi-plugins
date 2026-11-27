/**
 * Web views for Switchyard (switchyard.web-command.v1): when Switchyard's web app runs one of this
 * package's commands, it asks here first and shows the returned view instead of the TUI overlay.
 * Copied per package; nothing imports across package directories.
 */
import { outcome, queueReason, queueTime, runtime, waitedText } from "./format.ts";
import { isActive, type Task } from "./registry.ts";

export const WEB_COMMAND_CHANNEL = "switchyard.web-command.v1";
export type WebNode = Record<string, unknown> & { t: string };
export interface WebAction { label: string; command: string; tone?: "default" | "primary" | "danger" }
export interface WebView { title: string; body: WebNode; actions?: WebAction[] }
interface Req { version: 1; name: string; args: string; probe: boolean; ctx?: any; accept?: boolean; view?: WebView | Promise<WebView> }

export const text = (value: string): WebNode => ({ t: "text", text: value });
export const table = (columns: string[], rows: string[][]): WebNode => ({ t: "table", columns, rows });
export const section = (title: string | undefined, children: WebNode[], collapsible = false): WebNode => ({ t: "section", ...(title ? { title } : {}), ...(collapsible ? { collapsible: true } : {}), children });

/** The task list for Switchyard’s web command. `tasks` is already scoped to the current session. */
export function tasksWebView(tasks: readonly Task[], now = Date.now()): WebView {
  const active = tasks.filter(isActive).sort((a, b) => (a.requestedAt ?? a.startedAt) - (b.requestedAt ?? b.startedAt));
  const ended = tasks.filter((t) => !isActive(t));
  const queued = active.filter((t) => t.status === "queued").length;
  const count = [`${active.length - queued} running`, queued ? `${queued} queued` : undefined, `${ended.length} ended`].filter(Boolean).join(" · ");
  const body = tasks.length
    ? section(undefined, [
      text(count),
      table(["ID", "Name", "Status", "Runtime", "Queue time", "Command"], [...active, ...ended].map((t) => [
        t.id, t.name, t.status === "queued" ? `queued · ${queueReason(t)}` : outcome(t), runtime(t, now),
        waitedText(t) ?? queueTime(t, now) ?? "—", t.command.slice(0, 120),
      ])),
    ])
    : text("No background tasks.");
  const actions: WebAction[] = active.map((t) => ({ label: `Stop ${t.name || t.id}`, command: `/tasks kill ${t.id}`, tone: "danger" }));
  if (ended.length) actions.push({ label: "Clear ended", command: "/tasks clear", tone: "danger" });
  return { title: "Background tasks", body, actions };
}

export function onWebCommand(
  pi: any,
  names: string[],
  accepts: (name: string, args: string) => boolean,
  build: (name: string, args: string, ctx: any) => WebView | Promise<WebView>,
): void {
  pi.events?.on?.(WEB_COMMAND_CHANNEL, (data: unknown) => {
    const req = data as Req;
    if (req?.version !== 1 || !names.includes(req.name)) return;
    const args = String(req.args ?? "").trim();
    if (!accepts(req.name, args)) return;
    if (req.probe) { req.accept = true; return; }
    try { req.view = Promise.resolve(build(req.name, args, req.ctx)); } catch (e) { req.view = Promise.reject(e); }
  });
}
