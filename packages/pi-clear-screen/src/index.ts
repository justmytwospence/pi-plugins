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

const KEY = "ctrl+l";
const SENTINEL = "\u0000pi-clear-screen\u0000";
const PATCHED = Symbol.for("pi-clear-screen.patched");

type Comp = { render(width: number): string[]; invalidate?(): void; children?: Comp[] };
type Tui = Comp & {
  children: Comp[];
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

function transcriptOf(tui: Tui, doc: Comp): ScrollLike | undefined {
  for (const entry of tui.layoutRoot?.entries ?? []) {
    const c = entry.component as Partial<ScrollLike>;
    if (c && c.child === doc && typeof c.scrollToEnd === "function") return c as ScrollLike;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let tui: Tui | undefined;
  let marker: ClearMarker | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) tui = grabTui(ctx);
    marker = undefined;
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
      const doc = tui.children[0] as Comp & { [PATCHED]?: boolean };
      const chat = doc?.children?.at(-1) as (Comp & { addChild(c: Comp): void; removeChild(c: Comp): void }) | undefined;
      const scroll = doc && transcriptOf(tui, doc);
      if (!chat || !scroll) {
        ctx.ui.notify("clear-screen: pi's transcript layout changed; extension needs updating", "warning");
        return;
      }

      if (!doc[PATCHED]) {
        doc[PATCHED] = true;
        const render = doc.render.bind(doc);
        doc.render = (width: number) => {
          const lines = render(width);
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
      }

      if (marker) chat.removeChild(marker);
      marker = new ClearMarker();
      chat.addChild(marker);
      scroll.scrollToEnd();
      tui.requestRender();
    },
  });
}
