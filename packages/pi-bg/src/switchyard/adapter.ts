/**
 * Switchyard adapter for @justmytwospence/pi-bg. Self-contained: the host loads this file with
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

/**
 * Panel presentation for pi-bg: the `bg` status (and `bg` widget lines, when present)
 * become the "bg" panel, as progress when the text carries a fraction or percentage and as text
 * otherwise. The custom web renderer (bg-renderer.html) draws the same data as a compact
 * task list from the panel `state`.
 */

export const STATUS_KEY = "bg";

export interface BgState {
  status: string | null;
  lines: string[];
}

/** Progress value in 0..1 from "3/5" or "40%", else undefined. */
export function progressValue(text: string): number | undefined {
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (frac) {
    const total = Number(frac[2]);
    if (total > 0) return Math.min(1, Number(frac[1]) / total);
  }
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct) return Math.min(1, Number(pct[1]) / 100);
  return undefined;
}

export function bgPanel(s: BgState): UINode | null {
  const children: UINode[] = [];
  if (s.status) {
    const value = progressValue(s.status);
    children.push(
      value === undefined ? { t: "text", text: s.status } : { t: "progress", label: s.status, value, status: "running" },
    );
  }
  if (s.lines.length) children.push({ t: "list", items: s.lines.map((l): UINode => ({ t: "text", text: l })), ordered: undefined });
  if (children.length === 0) return null;
  return children.length === 1 ? children[0]! : { t: "section", children };
}

function render(ctx: AdapterContext, s: BgState) {
  if (!s.status && s.lines.length === 0) ctx.state.delete("bg");
  else ctx.state.set("bg", s);
  ctx.setPanel("bg", bgPanel(s), {
    title: "Background",
    mobileFallback: [s.status, ...s.lines].filter(Boolean).join("\n") || null,
    state: s,
  });
}

const current = (ctx: AdapterContext): BgState =>
  ctx.state.get<BgState>("bg") ?? { status: null, lines: [] };

export default {
  onStatus(key: string, text: string | undefined, ctx: AdapterContext): boolean {
    if (key !== STATUS_KEY) return false;
    render(ctx, { ...current(ctx), status: text?.trim() ? text : null });
    return true;
  },

  onWidget(key: string, lines: string[] | undefined, ctx: AdapterContext): boolean {
    if (key !== STATUS_KEY) return false;
    render(ctx, { ...current(ctx), lines: lines ?? [] });
    return true;
  },
};
