// ctrl+l clears the screen the way a shell does: the transcript is pushed up out of view, new
// output starts at the top, and scrolling up still shows everything. Nothing is deleted from the
// session or the model context.
//
// Pi has no clear action (ctrl+l is app.model.select by default; rebind that in keybindings.json), so
// this works on the fullscreen transcript directly:
//   - A zero-width marker component is appended to the chat container. It renders one sentinel line.
//   - The document container's render() strips the sentinel and pads blank lines at the end until
//     the marker sits at the top of the viewport, exactly like a terminal's cleared screen. As new
//     output arrives the padding shrinks to nothing, so no blank page is left in the history.
// The marker is ephemeral: /new, /resume and /reload rebuild the chat and drop it.
//
// Only fullscreen mode (tuiMode: "fullscreen") has an application-owned transcript; in regular
// mode the terminal owns scrollback, so ctrl+l just says so.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { clearHandlerOf, routeCtrlC, routeEscape } from "./interrupt.ts";
import { TRANSCRIPT_ROWS, type TranscriptHooks, type TranscriptRowsContext } from "./transcript-contract.ts";

const KEY = "ctrl+l";
const SENTINEL = "\u0000pi-clear-screen\u0000";

type Comp = TranscriptHooks & { render(width: number): string[]; invalidate?(): void; children?: Comp[] };
type Tui = Comp & {
  children: Comp[];
  getFocusedComponent?(): unknown;
  layoutRoot?: { entries?: { component: unknown }[] };
  scrollToBottom?(): void;
  requestRender(force?: boolean): void;
};
type ScrollLike = { child?: unknown; viewportHeight: number; scrollToEnd(): void };

type RowSplice = { start: number; deleteCount: number; lines: string[] };
const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** Pure geometry shared by rendering and indexing; the sentinel never occupies a final row. */
function clearRows(input: readonly string[], height: number | undefined): { lines: string[]; splices: RowSplice[]; horizon?: number } {
  const lines = [...input];
  const at = lines.indexOf(SENTINEL);
  if (at < 0) return { lines, splices: [] };
  lines.splice(at, 1);
  const splices: RowSplice[] = [{ start: at, deleteCount: 1, lines: [] }];
  // Regular mode (e.g. the transcript printed on fullscreen exit) gets no padding.
  const padding = height === undefined ? 0 : Math.max(0, Math.ceil(at + height - lines.length));
  if (padding) {
    const blanks = Array<string>(padding).fill("");
    splices.push({ start: lines.length, deleteCount: 0, lines: blanks });
    lines.push(...blanks);
  }
  return { lines, splices, horizon: at };
}

/** Restore the exact descriptor, but never clobber a subsequent owner's method. */
function installMethod(target: Comp, key: PropertyKey, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  const installed = { value, writable: true, configurable: previous?.configurable ?? true, enumerable: previous?.enumerable ?? true };
  Object.defineProperty(target, key, installed);
  return () => {
    const current = Object.getOwnPropertyDescriptor(target, key);
    if (!current || current.value !== value || current.writable !== installed.writable
      || current.configurable !== installed.configurable || current.enumerable !== installed.enumerable) return;
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  };
}

class ClearMarker implements Comp {
  render(): string[] {
    return [SENTINEL];
  }
  invalidate(): void {}
}

/** Borrow the live TUI reference: widget factories receive it; the probe widget is removed at once. */
function grabTui(ctx: ExtensionContext): Tui | undefined {
  let tui: Tui | undefined;
  ctx.ui.setWidget("clear-screen-probe", (t) => {
    tui = t as unknown as Tui;
    return { render: () => [], invalidate() {} };
  });
  ctx.ui.setWidget("clear-screen-probe", undefined);
  return tui;
}

/**
 * The scroll view showing `doc`. Pi's layout root is a stack of the transcript and the editor dock,
 * but another extension may nest it (pi-sidebar puts it beside a panel), so stacks are walked.
 */
function transcriptOf(tui: Tui, doc: Comp): ScrollLike | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): ScrollLike | undefined => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 6) return undefined;
    seen.add(node);
    const c = node as Partial<ScrollLike> & { entries?: { component?: unknown }[] };
    if (c.child === doc && typeof c.scrollToEnd === "function") return c as ScrollLike;
    for (const entry of Array.isArray(c.entries) ? c.entries : []) {
      const found = walk(entry?.component, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(tui.layoutRoot, 0);
}

export default function (pi: ExtensionAPI) {
  let tui: Tui | undefined;
  let marker: ClearMarker | undefined;
  let release: (() => void) | undefined;
  let stopKeys: (() => void) | undefined;
  const cleanup = () => {
    release?.(); release = undefined; marker = undefined; tui = undefined;
    stopKeys?.(); stopKeys = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    cleanup();
    if (ctx.mode !== "tui") return;
    tui = grabTui(ctx);
    // Ctrl+C interrupts a running turn, and Esc/Ctrl+C take queued prompts back before they stop
    // it (see interrupt.ts). The prompt editor has focus now.
    let mainClear = clearHandlerOf(tui?.getFocusedComponent?.());
    stopKeys = ctx.ui.onTerminalInput?.((data) => {
      const focused = tui?.getFocusedComponent?.();
      mainClear ??= clearHandlerOf(focused);
      const busy = !ctx.isIdle();
      const state = { focused, mainClear, busy, queued: busy && ctx.hasPendingMessages() };
      return routeEscape(data, state) ?? routeCtrlC(data, state);
    });
    if (getKeybindings().getKeys("app.model.select").includes(KEY)) {
      ctx.ui.notify('clear-screen: Ctrl+L conflicts with Pi model selection. Set "app.model.select": ["alt+p", "alt+m"] in keybindings.json, then reload.', "warning");
    }
  });
  pi.on("session_shutdown", cleanup);

  pi.registerCommand("clear", {
    // Same as /new: the fresh session picks its model and thinking level the way startup does.
    description: "Start a fresh session with the startup model and thinking level",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
  pi.registerCommand("exit", {
    description: "Exit Pi",
    handler: async (_args, ctx) => { ctx.shutdown(); },
  });

  pi.registerShortcut(KEY, {
    description: "Clear screen (keeps history; scroll up to see it)",
    handler: (ctx) => {
      tui ??= grabTui(ctx);
      if (!tui?.layoutRoot) {
        ctx.ui.notify("clear-screen: only fullscreen mode (tuiMode) has a clearable transcript", "info");
        return;
      }
      // documentContainer = [header, loadedResources, chat]; messages are appended to chat.
      const doc = tui.children?.[0] as Comp;
      const chat = (Array.isArray(doc?.children) ? doc.children.at(-1) : undefined) as (Comp & { addChild(c: Comp): void; removeChild(c: Comp): void }) | undefined;
      const scroll = doc && transcriptOf(tui, doc);
      if (!chat || !scroll || typeof chat.addChild !== "function" || typeof chat.removeChild !== "function" || typeof doc.render !== "function") {
        ctx.ui.notify("clear-screen: pi's transcript layout changed; extension needs updating", "warning");
        return;
      }

      if (!release) {
        let active = true;
        const render = doc.render;
        const precedingRows = doc[TRANSCRIPT_ROWS];
        // Pad so the marker is the first visible row; viewportHeight is from the last frame.
        const height = () => tui?.layoutRoot ? scroll.viewportHeight || process.stdout.rows || 24 : undefined;
        const wrapper = (width: number) => {
          const lines = [...render.call(doc, width)];
          return active ? clearRows(lines, height()).lines : lines;
        };
        const rows = (context: TranscriptRowsContext) => {
          // A preceding transform must see its own rendered rows, not our sentinel-free output.
          const lines = active ? [...render.call(doc, context.width)] : context.lines;
          let index = precedingRows
            ? precedingRows.call(doc, { ...context, lines })
            : context.index(doc.children ?? [], context.width);
          if (!index || !sameLines(index.lines, lines)) return undefined;
          const transformed = active ? clearRows(lines, height()) : { lines, splices: [], horizon: undefined };
          for (const splice of transformed.splices) index = context.splice(index, splice.start, splice.deleteCount, splice.lines);
          if (transformed.horizon !== undefined) index = { ...index, horizons: [...index.horizons, transformed.horizon] };
          return sameLines(index.lines, transformed.lines) && sameLines(index.lines, context.lines) ? index : undefined;
        };
        let restoreRender: (() => void) | undefined;
        let restoreRows: (() => void) | undefined;
        try {
          restoreRender = installMethod(doc, "render", wrapper);
          restoreRows = installMethod(doc, TRANSCRIPT_ROWS, rows);
        } catch {
          active = false;
          restoreRender?.();
          ctx.ui.notify("clear-screen: pi's transcript methods cannot be wrapped; extension needs updating", "warning");
          return;
        }
        release = () => {
          active = false;
          if (marker) chat.removeChild(marker);
          restoreRender?.();
          restoreRows?.();
          tui?.requestRender();
        };
      }

      if (marker) chat.removeChild(marker);
      marker = new ClearMarker();
      chat.addChild(marker);
      scroll.scrollToEnd();
      tui.requestRender();
    },
  });
}
