// Canonical: shared/transcript/transcript-style.ts. Sync: node scripts/sync-transcript-helpers.mjs
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ThemeBg,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Markdown,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

export interface StyledMessage {
  content: string | { type: string; text?: string }[];
  timestamp: number;
}

/** One visual language for the suite's transcript items: tones, rows, blocks, clocks and in-place runs. */

export type Tone = "running" | "done" | "failed" | "stopped" | "attention" | "warning" | "info" | "incoming";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

export const TONES: Record<Tone, { glyph: string; fg: ThemeColor; bg: ThemeBg }> = {
  running: { glyph: "", fg: "accent", bg: "toolPendingBg" },
  done: { glyph: "✓", fg: "success", bg: "toolSuccessBg" },
  failed: { glyph: "✗", fg: "error", bg: "toolErrorBg" },
  stopped: { glyph: "■", fg: "muted", bg: "toolPendingBg" },
  attention: { glyph: "?", fg: "warning", bg: "toolPendingBg" },
  warning: { glyph: "!", fg: "warning", bg: "toolPendingBg" },
  info: { glyph: "○", fg: "muted", bg: "customMessageBg" },
  incoming: { glyph: "◆", fg: "accent", bg: "customMessageBg" },
};

type Paint = Pick<Theme, "fg" | "bg">;

export function glyph(theme: Pick<Theme, "fg">, tone: Tone, now = Date.now()): string {
  const t = TONES[tone];
  const g = tone === "running" ? SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]! : t.glyph;
  return theme.fg(t.fg, g);
}

export function toneOfTool(
  context: { isError?: boolean; isPartial?: boolean; executionStarted?: boolean },
  hasResult: boolean,
): Tone {
  if (context.isError) return "failed";
  if (hasResult && !context.isPartial) return "done";
  if (context.executionStarted) return "running";
  return "attention";
}

const GLOBAL = globalThis as unknown as Record<symbol, unknown>;
const TIMESTAMPS_KEY = Symbol.for("pi-plugins.transcript-style.timestamps");
const FULLSCREEN_KEY = Symbol.for("pi-plugins.transcript-style.fullscreen");
const VISIBLE_KEY = Symbol.for("pi-plugins.transcript-style.visible-types");
const RUNS_KEY = Symbol.for("pi-plugins.transcript-style.v1");

export function timestampsEnabled(): boolean {
  return GLOBAL[TIMESTAMPS_KEY] !== false;
}

export function setTimestampsEnabled(value: boolean): void {
  GLOBAL[TIMESTAMPS_KEY] = value;
}

export function setStyleFullscreen(value: boolean): void {
  GLOBAL[FULLSCREEN_KEY] = value;
}

const DAY_MS = 86_400_000;

export function formatClock(ts: number | string | undefined, now = Date.now()): string | undefined {
  if (ts === undefined || ts === "") return undefined;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startOfDate === startOfToday) return time;
  const daysAgo = Math.round((startOfToday - startOfDate) / DAY_MS);
  if (daysAgo > 0 && daysAgo <= 6) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  const sameYear = date.getFullYear() === today.getFullYear();
  const day = date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${day}, ${time}`;
}

function keyText(): string {
  let keys: string[] = [];
  try {
    keys = getKeybindings().getKeys("app.tools.expand") as string[];
  } catch {
    /* no keybindings yet */
  }
  if (keys.length === 0) return "ctrl+o";
  return keys
    .join("/")
    .split("/")
    .map((part) =>
      part
        .split("+")
        .map((p) => (process.platform === "darwin" && p.toLowerCase() === "alt" ? "option" : p))
        .join("+"),
    )
    .join("/");
}

export function expandHint(theme: Pick<Theme, "fg">, fullscreen: boolean = GLOBAL[FULLSCREEN_KEY] === true): string {
  return theme.fg("dim", fullscreen ? " · click to expand" : ` · ${keyText()} to expand`);
}

const identity = (s: string) => s;

export interface LabelOptions {
  pad?: number;
  gap?: number;
  bg?: (s: string) => string;
  fg?: (s: string) => string;
}

/** The line with `label` right-aligned, or undefined when its trailing space cannot hold label + gap + pad. */
export function rightLabel(line: string, label: string, width: number, opts: LabelOptions = {}): string | undefined {
  const pad = opts.pad ?? 1;
  const gap = opts.gap ?? 2;
  const bg = opts.bg ?? identity;
  const fg = opts.fg ?? identity;
  const plain = stripTerminalSequences(line);
  const contentEnd = visibleWidth(plain.trimEnd());
  const labelWidth = visibleWidth(label);
  if (width - contentEnd < labelWidth + pad + gap) return undefined;
  const kept = contentEnd > 0 ? truncateToWidth(line, contentEnd, "", false) : "";
  const filler = " ".repeat(width - contentEnd - labelWidth - pad);
  return kept + bg(filler + fg(label) + " ".repeat(pad));
}

/** Puts `label` on the middle row (or the nearest row with room); the lines come back unchanged when none has. */
export function labelBlock(
  lines: string[],
  label: string | undefined,
  width: number,
  opts: LabelOptions & { skipEdges?: boolean } = {},
): string[] {
  if (!label || lines.length === 0) return lines;
  const n = lines.length;
  const order: number[] = [];
  const c = Math.floor((n - 1) / 2);
  order.push(c);
  for (let i = 1; i < n; i++) {
    if (c + i < n) order.push(c + i);
    if (c - i >= 0) order.push(c - i);
  }
  for (const row of order) {
    if (opts.skipEdges && (row === 0 || row === n - 1)) continue;
    const next = rightLabel(lines[row]!, label, width, opts);
    if (next === undefined) continue;
    const out = lines.slice();
    out[row] = next;
    return out;
  }
  return lines;
}

export interface RowSpec {
  tone: Tone;
  title: string;
  titleColor?: ThemeColor;
  detail?: string;
  hint?: string;
  time?: number | string;
}

export function rowLine(theme: Pick<Theme, "fg">, spec: RowSpec, width: number): string {
  const content =
    " " +
    glyph(theme, spec.tone) +
    " " +
    theme.fg(spec.titleColor ?? "toolTitle", spec.title) +
    (spec.detail ? theme.fg("dim", " · ") + theme.fg("muted", spec.detail) : "") +
    (spec.hint ?? "");
  const fitted = truncateToWidth(content, Math.max(1, width), "…");
  const clock = timestampsEnabled() ? formatClock(spec.time) : undefined;
  if (!clock) return fitted;
  const padded = fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
  return rightLabel(padded, clock, width, { fg: (s) => theme.fg("dim", s) }) ?? fitted;
}

export class Row implements Component {
  constructor(
    private readonly theme: Pick<Theme, "fg">,
    private readonly spec: () => RowSpec,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [rowLine(this.theme, this.spec(), width)];
  }
}

export interface BlockSpec {
  tone: Tone;
  title: string;
  titleColor?: ThemeColor;
  detail?: string;
  body: string | Component;
  fold?: number;
  expanded?: boolean;
  time?: number | string;
  bodyColor?: ThemeColor;
}

export class Block implements Component {
  constructor(
    private readonly theme: Paint,
    private readonly spec: () => BlockSpec,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const s = this.spec();
    const theme = this.theme;
    const bg = (text: string) => theme.bg(TONES[s.tone].bg, text);
    const inner = Math.max(1, width - 2);
    const row = (text: string) => bg(" " + truncateToWidth(text, inner, "", true) + " ");
    const title = rowLine(theme, { tone: s.tone, title: s.title, titleColor: s.titleColor, detail: s.detail }, inner + 1).replace(/^ /, "");
    const bodyComponent: Component =
      typeof s.body === "string"
        ? new Markdown(s.body, 0, 0, getMarkdownTheme(), { color: (t: string) => theme.fg(s.bodyColor ?? "customMessageText", t) })
        : s.body;
    let body = bodyComponent.render(inner);
    const fold = s.fold ?? 8;
    let hint: string | undefined;
    if (!s.expanded && fold > 0 && body.length > fold) {
      const more = body.length - fold;
      body = body.slice(0, fold);
      hint = theme.fg("dim", `… ${more} more line${more === 1 ? "" : "s"}`) + expandHint(theme);
    }
    const lines = [row(""), row(title), ...body.map(row), ...(hint ? [row(hint)] : []), row("")];
    const clock = timestampsEnabled() ? formatClock(s.time) : undefined;
    return labelBlock(lines, clock, width, { skipEdges: true, bg, fg: (t) => theme.fg("dim", t) });
  }
}

export function messageText(message: Pick<StyledMessage, "content">): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

export function messageView(
  theme: Paint,
  message: StyledMessage,
  options: { expanded: boolean },
  spec: { tone: Tone; title: string; titleColor?: ThemeColor },
): Component {
  const text = messageText(message);
  if (!text.includes("\n")) {
    return new Row(theme, () => ({ ...spec, detail: text || undefined, time: message.timestamp }));
  }
  return new Block(theme, () => ({ ...spec, body: text, expanded: options.expanded, time: message.timestamp }));
}

export function visibleEntryTypes(): Set<string> {
  let set = GLOBAL[VISIBLE_KEY] as Set<string> | undefined;
  if (!set) {
    set = new Set(["agent-summary", "settings:cycle", "transcript-style:report"]);
    GLOBAL[VISIBLE_KEY] = set;
  }
  return set;
}

export function isVisibleEntry(entry: { type?: string; customType?: string; display?: boolean }): boolean {
  switch (entry.type) {
    case "message":
    case "compaction":
    case "branch_summary":
      return true;
    case "custom_message":
      return entry.display === true;
    case "custom":
      return visibleEntryTypes().has(entry.customType ?? "");
    default:
      return false;
  }
}

interface RunState {
  journal: Map<string, { data: unknown; time: string }>;
  rebuilders: Set<symbol>;
}

function runsOf(type: string): RunState {
  let all = GLOBAL[RUNS_KEY] as Map<string, RunState> | undefined;
  if (!all) {
    all = new Map();
    GLOBAL[RUNS_KEY] = all;
  }
  let state = all.get(type);
  if (!state) {
    state = { journal: new Map(), rebuilders: new Set() };
    all.set(type, state);
  }
  return state;
}

export interface RowRunOptions<T> {
  anchorType: string;
  stateType: string;
  sameRun(a: T, b: T): boolean;
  merge(a: T, b: T): T;
  render(state: { data: T; time: string }, theme: Theme, options: { expanded: boolean }): Component | undefined;
}

/**
 * Entries of one kind that repeat back to back (nothing visible between them) update one displayed row instead of
 * adding another: the first is an anchor entry with a renderer, later ones are renderer-less state entries that
 * update an in-memory journal, which session_start and session_tree rebuild.
 */
export function registerRowRun<T>(pi: ExtensionAPI, options: RowRunOptions<T>): { append(ctx: ExtensionContext, data: T): void } {
  visibleEntryTypes().add(options.anchorType);
  const run = runsOf(options.anchorType);
  const owner = Symbol(options.anchorType);
  const rebuild = (ctx: ExtensionContext) => {
    try {
      run.journal.clear();
      const branch = ctx.sessionManager.getBranch() as { id: string; type: string; customType?: string; data?: any; timestamp: string }[];
      const ids = new Set(branch.map((e) => e.id));
      for (const e of branch) {
        if (e.type === "custom" && e.customType === options.stateType && ids.has(e.data?.anchor)) {
          run.journal.set(e.data.anchor, { data: e.data.data, time: e.timestamp });
        }
      }
    } catch {
      /* the runtime went stale */
    }
  };
  pi.registerEntryRenderer<T>(options.anchorType, (entry, o, theme) => {
    const known = run.journal.get(entry.id) as { data: T; time: string } | undefined;
    return options.render(known ?? { data: entry.data as T, time: entry.timestamp }, theme, o);
  });
  if (!run.rebuilders.has(owner)) {
    run.rebuilders.add(owner);
    pi.on("session_start", (_e, ctx) => rebuild(ctx));
    pi.on("session_tree", (_e, ctx) => rebuild(ctx));
  }
  return {
    append(ctx, data) {
      try {
        const branch = ctx.sessionManager.getBranch() as { id: string; type: string; customType?: string; display?: boolean; data?: any; timestamp: string }[];
        let last: (typeof branch)[number] | undefined;
        for (let i = branch.length - 1; i >= 0; i--) {
          if (isVisibleEntry(branch[i]!)) {
            last = branch[i];
            break;
          }
        }
        if (last && last.type === "custom" && last.customType === options.anchorType) {
          const current = (run.journal.get(last.id) as { data: T } | undefined)?.data ?? (last.data as T);
          if (options.sameRun(current, data)) {
            const merged = options.merge(current, data);
            pi.appendEntry(options.stateType, { anchor: last.id, data: merged });
            run.journal.set(last.id, { data: merged, time: new Date().toISOString() });
            return;
          }
        }
        pi.appendEntry(options.anchorType, data);
      } catch {
        /* the runtime went stale */
      }
    },
  };
}

export const REPORT_TYPE = "transcript-style:report";

export function registerReportRenderer(pi: ExtensionAPI): void {
  visibleEntryTypes().add(REPORT_TYPE);
  pi.registerEntryRenderer<{ title?: string; body?: string }>(REPORT_TYPE, (entry, o, theme) => {
    const body = entry.data?.body;
    if (!body) return undefined;
    return new Block(theme, () => ({ tone: "info", title: entry.data?.title ?? "Report", body, fold: 20, expanded: o.expanded, time: entry.timestamp }));
  });
}

export function appendReport(pi: ExtensionAPI, title: string, body: string): void {
  try {
    pi.appendEntry(REPORT_TYPE, { title, body });
  } catch {
    /* the runtime went stale */
  }
}
