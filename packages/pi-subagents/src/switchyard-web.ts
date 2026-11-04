/**
 * Web views for Switchyard (switchyard.web-command.v1): when Switchyard's web app runs one of this
 * package's commands, it asks here first and shows the returned view instead of the TUI overlay.
 * Copied per package; nothing imports across package directories.
 */
export const WEB_COMMAND_CHANNEL = "switchyard.web-command.v1";
export type WebNode = Record<string, unknown> & { t: string };
export interface WebAction { label: string; command: string; tone?: "default" | "primary" | "danger" }
export interface WebView { title: string; body: WebNode; actions?: WebAction[] }
interface Req { version: 1; name: string; args: string; probe: boolean; ctx?: any; accept?: boolean; view?: WebView | Promise<WebView> }

export const text = (value: string): WebNode => ({ t: "text", text: value });
export const table = (columns: string[], rows: string[][]): WebNode => ({ t: "table", columns, rows });
export const section = (title: string | undefined, children: WebNode[], collapsible = false): WebNode => ({ t: "section", ...(title ? { title } : {}), ...(collapsible ? { collapsible: true } : {}), children });

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
