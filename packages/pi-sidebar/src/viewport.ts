// While Sidebar has focus, Pi's transcript scroll actions (as bound in keybindings.json: PgUp/PgDn,
// half pages, lines, top, bottom) scroll Sidebar instead of main.
//
// Pi's fullscreen renderer handles those keys in an input listener that runs before any extension's
// and calls `handleViewportInput` on itself each time. This wraps that method on the renderer
// instance, as pi-vim's viewport-input.ts does for Ctrl+U/D; a wrapper installed earlier or later
// (pi-vim's) keeps working, since each calls the one it replaced.
import { getKeybindings } from "@earendil-works/pi-tui";

export type ScrollAction = "pageUp" | "pageDown" | "halfPageUp" | "halfPageDown" | "lineUp" | "lineDown" | "top" | "bottom";

const ACTIONS: ScrollAction[] = ["pageUp", "pageDown", "halfPageUp", "halfPageDown", "lineUp", "lineDown", "top", "bottom"];

/** The transcript scroll action a key is bound to, if any. */
export function scrollActionFor(data: string, keys: { matches(data: string, action: string): boolean } = getKeybindings() as never): ScrollAction | undefined {
  return ACTIONS.find((action) => keys.matches(data, `tui.altScreen.${action}`));
}

type ViewportHost = { handleViewportInput?: (data: string) => unknown };

/**
 * Route scroll actions to `scroll` whenever `owns()` is true. Returns a release function that puts the
 * renderer's method back if nothing wrapped it since.
 */
export function routeViewportScroll(tui: object, owns: () => boolean, scroll: (action: ScrollAction) => void): () => void {
  const host = tui as ViewportHost;
  if (typeof host.handleViewportInput !== "function") return () => {};
  const descriptor = Object.getOwnPropertyDescriptor(host, "handleViewportInput");
  const previous = host.handleViewportInput;
  const wrapper = function (this: ViewportHost, data: string) {
    if (owns()) {
      const action = scrollActionFor(data);
      if (action) {
        scroll(action);
        return { consume: true };
      }
    }
    return previous.call(this, data);
  };
  host.handleViewportInput = wrapper;
  return () => {
    if (host.handleViewportInput !== wrapper) return;
    if (descriptor) Object.defineProperty(host, "handleViewportInput", descriptor);
    else delete host.handleViewportInput;
  };
}
