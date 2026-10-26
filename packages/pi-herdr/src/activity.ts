// The activity protocol: how pi-bg, pi-subagents, pi-marimo, pi-herdr and pi-plan-mode share the
// space under the prompt and one background-tasks dialog, the way Claude Code lays them out. Each
// works alone. This file is copied verbatim into pi-bg, pi-subagents, pi-marimo, pi-herdr
// (src/activity.ts) and pi-plan-mode; change it in all five. There is no shared runtime package:
// nothing here imports a sibling, and a sibling never imports this copy.
//
// Each extension offers its background work as a *source*:
// - pi-subagents is the host under the prompt: its list (FleetView, Claude Code's subagent panel)
//   ends with the other sources' pills (`2 tasks`, `1 notebook`), and calls `setHosted(true,
//   "subagents")` on each so they draw no pill of their own. Enter on a pill opens that source's
//   dialog.
// - Without pi-subagents, pi-bg hosts: its pill also counts the other sources' work
//   (`2 tasks · 1 notebook`), calling `setHosted(true, "bg")` on them.
// - pi-bg's `/tasks` dialog lists every source's entries: its tasks, pi-subagents' runs,
//   pi-marimo's notebooks, pi-herdr's children, pi-plan-mode's planners and scouts.
// - Without any host, a source with a pill draws its own.
//
// Over pi's event bus:
//   activity:section  { section }           a source is offered, at its owner's session start and
//                                           whenever a host announces itself
//   activity:host     { host, priority }    a host is ready (at its session start): sources are
//                                           offered again. `host` is the host's own source id
//                                           (`subagents`, `bg`); `priority` decides between hosts
//                                           (below). Older hosts sent `{}`: treat that as the
//                                           FleetView host.
//   activity:changed  { id }                a source's content changed: whoever shows it redraws
//   activity:gone     { id }                a source (or host) is going away (session end, reload)
//
// Host priority. Two hosts may be loaded at once (pi-subagents' FleetView and pi-bg's pill): the
// one with the higher priority hosts, the other yields. A host that hears `activity:host` from a
// higher-priority host (or an equal one whose id sorts first) stops hosting, releasing its guests
// with `setHosted(false, me)`, until `activity:gone` names that host; a host that hears a
// lower-priority one announces itself again so the newcomer yields. `hostOutranks` is the rule.
// Sources keep the set of hosts showing them (`setHosted(true/false, host)`), so one host leaving
// never erases another's claim; a source draws its own pill only while that set is empty.
//
// Stable ids. An entry's `key` names one piece of work for its whole life, across refreshes and
// status changes (a run id, a task id, a notebook path, a child name): hosts key their selection
// and their stop arming (`x` twice) by `${section.id}\0${key}` (`stableKey`), so rows coming and
// going never move either onto another entry.
//
// `stop` and `dismiss` stay optional. A host feature-tests them (`typeof section.stop ===
// "function"`) before offering `x`, and asks `canStop(key)` where present: a source may list
// running work it cannot stop (pi-herdr can interrupt an awaited child, never close it).

export const ACTIVITY_SECTION = "activity:section";
export const ACTIVITY_HOST = "activity:host";
export const ACTIVITY_CHANGED = "activity:changed";
export const ACTIVITY_GONE = "activity:gone";

/** The host under the prompt (pi-subagents' FleetView) outranks the pill host (pi-bg). */
export const FLEET_HOST_PRIORITY = 20;
export const PILL_HOST_PRIORITY = 10;

export interface ActivityHostEvent {
  /** The host's own source id: `subagents`, `bg`. */
  host?: string;
  priority?: number;
}

/** An announcement as sent; `{}` from an older host means the FleetView host. */
export function readHost(data: unknown): { host: string; priority: number } {
  const e = (data ?? {}) as ActivityHostEvent;
  return {
    host: typeof e.host === "string" && e.host ? e.host : "subagents",
    priority: typeof e.priority === "number" ? e.priority : FLEET_HOST_PRIORITY,
  };
}

/** Whether `other` takes hosting over from `me`. */
export function hostOutranks(
  other: { host: string; priority: number },
  me: { host: string; priority: number },
): boolean {
  if (other.host === me.host) return false;
  return other.priority > me.priority || (other.priority === me.priority && other.host < me.host);
}

/** The id hosts key selection and stop arming by. */
export function stableKey(sectionId: string, key: string): string {
  return `${sectionId}\0${key}`;
}

export interface ActivityTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** One piece of background work, for lists and dialogs. */
export interface ActivityEntry {
  /** Stable for the work's whole life (a run id, a task id, a path, a name). */
  key: string;
  /** `tests`, `scout`. */
  label: string;
  /** Beside the label: the command, the task. */
  detail: string;
  status: "running" | "done" | "failed" | "stopped";
  /** Flush right: `2:14`, `exit 1 · 0:12`, `1m00s · ↓ 13k tokens`. */
  stats: string;
  startedAt: number;
  /** When it ended, so a list mixing sources orders ended entries newest first. */
  endedAt?: number;
  /** Optional identity of the current stop target (e.g. a kernel session or awaited child turn).
   * Changes invalidate confirmation without changing this work's stable row key. */
  stopToken?: string;
}

/** The compact label a source shows under the prompt, Claude Code's footer pill: `2 tasks, 1 service`. */
export interface ActivityPill {
  label: string;
  /** Something failed or was stopped and has not been seen: drawn in the error color. */
  alert?: string;
}

export interface ActivitySection {
  id: string;
  /** What its entries are: `tasks`, `subagents`. */
  title: string;
  /** One of them, tagged on each row of a list that mixes sources: `task`, `agent`. */
  noun?: string;
  /** Running entries, then ended ones still worth showing (the source decides how long). */
  entries(now: number): ActivityEntry[];
  /** Opens an entry's detail view (an overlay through `ui.custom`); resolves when it closes. */
  open(key: string, ui: unknown): Promise<void>;
  /** Stops a running entry. Optional: a source may only list its work. */
  stop?(key: string): void | Promise<void>;
  /** Whether `stop` applies to this running entry now; without it, every running entry. */
  canStop?(key: string): boolean;
  /** Removes an ended entry from lists now. Optional. */
  dismiss?(key: string): void | Promise<void>;
  /** The pill under the prompt, or undefined when there is nothing to show. */
  pill?(now: number): ActivityPill | undefined;
  /** Opens the source's own dialog (pi-bg's background-tasks dialog). */
  openDialog?(ui: unknown): Promise<void>;
  /**
   * A host shows this source under the prompt (true) or stopped doing so (false). `host` is the
   * host's id (`subagents`, `bg`); a source tracks the set and draws its own pill only while it is
   * empty.
   */
  setHosted?(hosted: boolean, host?: string): void;
}

/** The target one `x` away from being stopped: row identity plus an optional operation epoch. */
export function stopKey(sectionId: string, entry: ActivityEntry): string {
  return JSON.stringify([sectionId, entry.key, entry.stopToken ?? ""]);
}

/** Whether a host may offer `x` to stop this entry. */
export function stoppable(section: ActivitySection, entry: ActivityEntry): boolean {
  if (entry.status !== "running" || typeof section.stop !== "function") return false;
  if (typeof section.canStop !== "function") return true;
  try {
    return section.canStop(entry.key) === true;
  } catch {
    return false;
  }
}

/** Whether a host may offer `x` to dismiss this entry. */
export function dismissable(section: ActivitySection, entry: ActivityEntry): boolean {
  return entry.status !== "running" && typeof section.dismiss === "function";
}

/**
 * Whether a key that moves down should leave the prompt for the list under it, as in Claude Code:
 * the prompt is empty, or its cursor sits at the end of its last line and no history entry is being
 * browsed (otherwise the editor moves the cursor first). With pi-vim, `j` in normal mode counts too.
 * `editor` is the focused component (pi's editor, or pi-vim's).
 */
export function leavesPromptDown(editor: unknown, data: string, isDown: boolean, isJ: boolean): boolean {
  const e = editor as {
    getText?: () => string;
    getLines?: () => string[];
    getCursor?: () => { line: number; col: number };
    isShowingAutocomplete?: () => boolean;
    historyIndex?: number;
    getMode?: () => string;
  } | null;
  void data;
  if (!e || typeof e.getText !== "function") return isDown;
  // A modal editor of the suite (pi-vim) reports its state; `j` leaves only from idle Normal mode.
  const modal = readEditorMode(e);
  if (modal) {
    if (isJ && modal.state !== "normal") return false;
    if (!isDown && !isJ) return false;
    if (modal.autocomplete || (modal.state !== "normal" && modal.state !== "insert")) return false;
  } else {
    if (isJ && e.getMode?.() !== "normal") return false;
    if (!isDown && !isJ) return false;
  }
  if (e.isShowingAutocomplete?.()) return false;
  if (typeof e.historyIndex === "number" && e.historyIndex > -1) return false;
  const lines = e.getLines?.() ?? e.getText().split("\n");
  const cursor = e.getCursor?.();
  if (!cursor) return e.getText() === "";
  const last = lines.length - 1;
  // vim normal mode: the cursor sits on the last character, not past it.
  const end = (lines[last] ?? "").length - (modal?.state === "normal" || isJ ? 1 : 0);
  return cursor.line === last && cursor.col >= Math.max(0, end);
}

/**
 * The suite's editor contract (pi-vim's src/contract.ts, copied structurally: nothing imports a
 * sibling). Components tell global listeners what input they own through these registry symbols:
 * - `INPUT_CONTEXT`: a method returning `"editor"` (a prompt), `"filter"` (a search field), `"list"`
 *   (a selection list) or `"viewer"` (read-only scrolling content). A component without it has an
 *   unknown context, and a view under the prompt falls back to its own heuristic.
 * - `EDITOR_SURFACE`: a property on an editor, `"main"` or `"embedded"` (one inside a screen).
 * - `EDITOR_MODE`: a method on a modal editor returning its state (`normal`, `insert`, `pending`...).
 * Views that own the keyboard (dialogs, viewers) report their own context the same way.
 */
export const INPUT_CONTEXT = Symbol.for("pi-plugins.input-context.v1");
export const EDITOR_SURFACE = Symbol.for("pi-plugins.editor-surface.v1");
export const EDITOR_MODE = Symbol.for("pi-plugins.editor-mode.v1");

export type InputContext = "editor" | "filter" | "list" | "viewer";

export interface EditorModeContext {
  state: "insert" | "normal" | "visual" | "ex" | "pending";
  mode: "insert" | "normal" | "visual" | "visual-line";
  pending: string;
  ex: string | null;
  autocomplete: boolean;
}

/** A component's input context, tolerating a plain string value; undefined when it reports none. */
export function readInputContext(component: unknown): InputContext | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  try {
    const value = (component as Record<symbol, unknown>)[INPUT_CONTEXT];
    const context = typeof value === "function" ? value.call(component) : value;
    return context === "editor" || context === "filter" || context === "list" || context === "viewer"
      ? context
      : undefined;
  } catch {
    return undefined;
  }
}

/** A component's editor surface marker. */
export function readEditorSurface(component: unknown): "main" | "embedded" | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  try {
    const value = (component as Record<symbol, unknown>)[EDITOR_SURFACE];
    return value === "main" || value === "embedded" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A modal editor's mode context; undefined for other components. */
export function readEditorMode(component: unknown): EditorModeContext | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  try {
    const value = (component as Record<symbol, unknown>)[EDITOR_MODE];
    const context = typeof value === "function" ? (value.call(component) as EditorModeContext | undefined) : undefined;
    return context && typeof context.state === "string" ? context : undefined;
  } catch {
    return undefined;
  }
}

/** The component with the keyboard, as pi's TUI reports it. */
export function focusedComponent(tui: unknown): unknown {
  const t = tui as { getFocusedComponent?: () => unknown; focusedComponent?: unknown } | undefined;
  return typeof t?.getFocusedComponent === "function" ? t.getFocusedComponent() : t?.focusedComponent;
}

/**
 * Whether the main prompt has the keyboard, so a view under it may take arrow keys: a component
 * reporting its context answers (`"editor"` on a `"main"` surface, or on no marked surface); else
 * pi's editor has `getText` and `setText` while its dialogs and overlays do not. Unknown focus
 * counts as the editor.
 */
export function mainEditorFocused(focused: unknown): boolean {
  if (focused == null) return true;
  const context = readInputContext(focused);
  if (context) return context === "editor" && readEditorSurface(focused) !== "embedded";
  const c = focused as { getText?: unknown; setText?: unknown };
  return typeof c.getText === "function" && typeof c.setText === "function";
}

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): unknown;
}
