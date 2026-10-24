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

// setup runs before the replacement's session_start. Carry plain data, never stale APIs.
type Selection = { provider: string; modelId: string; thinkingLevel: ExtensionContext["thinkingLevel"] };
const RESTORE_ENTRY = "clear-screen:model-restore";

const KEY = "ctrl+l";
const SENTINEL = "\u0000pi-clear-screen\u0000";

type Comp = { render(width: number): string[]; invalidate?(): void; children?: Comp[] };
type Tui = Comp & {
  children: Comp[];
  getFocusedComponent?(): unknown;
  layoutRoot?: { entries?: { component: unknown }[] };
  scrollToBottom?(): void;
  requestRender(force?: boolean): void;
};
type ScrollLike = { child?: unknown; viewportHeight: number; scrollToEnd(): void };

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

  pi.on("session_start", async (event, ctx) => {
    cleanup();
    if (event.reason === "new") {
      const entry = ctx.sessionManager.getBranch().find((entry) => entry.type === "custom" && entry.customType === RESTORE_ENTRY);
      const selection = entry?.type === "custom" ? entry.data as Selection : undefined;
      if (selection) {
        const model = ctx.modelRegistry.find(selection.provider, selection.modelId);
        if (!model || !(await pi.setModel(model))) {
          ctx.ui.notify(`Could not preserve ${selection.provider}/${selection.modelId} after /clear`, "error");
        } else if (selection.thinkingLevel !== undefined) {
          pi.setThinkingLevel(selection.thinkingLevel);
        }
      }
    }
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
    description: "Start a fresh session, keeping the current model and thinking level",
    handler: async (_args, ctx) => {
      const selection = ctx.model && {
        provider: ctx.model.provider,
        modelId: ctx.model.id,
        thinkingLevel: ctx.thinkingLevel,
      };
      await ctx.newSession({
        setup: async (manager) => {
          if (selection) manager.appendCustomEntry(RESTORE_ENTRY, selection);
        },
      });
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
        const own = Object.hasOwn(doc, "render");
        const wrapper = (width: number) => {
          const lines = [...render.call(doc, width)];
          if (!active) return lines;
          const at = lines.indexOf(SENTINEL);
          if (at < 0) return lines;
          lines.splice(at, 1);
          // Regular mode (e.g. the transcript printed on fullscreen exit) gets no padding.
          if (!tui?.layoutRoot) return lines;
          // Pad so the marker is the first visible row; viewportHeight is from the last frame.
          const height = scroll.viewportHeight || process.stdout.rows || 24;
          for (let n = at + height - lines.length; n > 0; n--) lines.push("");
          return lines;
        };
        doc.render = wrapper;
        release = () => {
          active = false;
          if (marker) chat.removeChild(marker);
          if (doc.render === wrapper) {
            if (own) doc.render = render;
            else delete (doc as Partial<Comp>).render;
          }
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
