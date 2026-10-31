import { getKeybindings, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { focusedComponent } from "../activity.ts";
import type { Keybindings, ViewerUI } from "./viewer.ts";
import type { Theme } from "./format.ts";

/** Native prompt depth is already coalesced by Pi; independent block owners are not. */
export class ViewerPromptState {
  private promptActive = false;
  private anonymousHolds = 0;
  private readonly owners = new Set<string>();
  private readonly listeners = new Set<() => void>();

  get blocked(): boolean { return this.promptActive || this.anonymousHolds > 0 || this.owners.size > 0; }

  setPromptActive(active: boolean): void {
    const before = this.blocked;
    this.promptActive = active;
    if (before !== this.blocked) this.reconcile();
  }

  setBlocked(id: string | undefined, active: boolean): void {
    const before = this.blocked;
    // Legacy producers emit balanced anonymous holds, not idempotent named updates.
    if (id === undefined) this.anonymousHolds = Math.max(0, this.anonymousHolds + (active ? 1 : -1));
    else if (active) this.owners.add(id);
    else this.owners.delete(id);
    if (before !== this.blocked) this.reconcile();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Retry pending installation/restoration without inventing a prompt-end event. */
  reconcile(): void {
    for (const listener of [...this.listeners]) listener();
  }

  reset(): void {
    const before = this.blocked;
    this.promptActive = false;
    this.anonymousHolds = 0;
    this.owners.clear();
    if (before) this.reconcile();
  }
}

let nextProbe = 0;
type View = Component & { dispose?(): void };

/** Own the TUI handle directly: a long-lived ui.custom would hold Pi's prompt depth. */
export function mountViewerOverlay(
  ui: Pick<ViewerUI, "setWidget">,
  factory: (tui: TUI, theme: Theme, keys: Keybindings | undefined, close: () => void) => View,
  options: { height: number; onOpen?: (close: () => void) => void; canInstall?: () => boolean; promptState?: ViewerPromptState },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let live = true;
    let view: View | undefined;
    let handle: OverlayHandle | undefined;
    let tui: TUI | undefined;
    let theme: Theme | undefined;
    let underlying: unknown;
    let hidden = false;
    let unsubscribe: (() => void) | undefined;
    let reconciling = false;
    const close = (error?: unknown) => {
      if (!live) return;
      live = false;
      unsubscribe?.();
      // Removing our own handle also retargets dialogs' saved focus away from us.
      try { handle?.hide(); } catch { /* Already removed by renderer shutdown. */ }
      try { view?.dispose?.(); } catch { /* Cleanup must still settle the reservation. */ }
      if (error !== undefined) reject(error);
      else resolve();
    };
    const reconcile = () => {
      if (!live || !tui || !theme || reconciling) return;
      reconciling = true;
      try {
        if (options.promptState?.blocked) {
          if (handle && !hidden) {
            hidden = true;
            handle.setHidden(true);
          }
          return;
        }
        if (!handle) {
          if (options.canInstall?.() === false) {
            close(new Error("Viewer opening cancelled"));
            return;
          }
          if (!view) {
            underlying = focusedComponent(tui);
            let keys: Keybindings | undefined;
            try { keys = getKeybindings() as unknown as Keybindings; } catch { /* Older SDK. */ }
            view = factory(tui, theme, keys, () => close());
          }
          // A factory can synchronously close or start a prompt.
          if (!live) { view.dispose?.(); return; }
          if (options.promptState?.blocked) return;
          const focused = focusedComponent(tui);
          if (focused !== underlying && focused !== view) return;
          if (options.canInstall?.() === false) {
            close(new Error("Viewer opening cancelled"));
            return;
          }
          handle = tui.showOverlay(view, { anchor: "top-left", width: "100%", maxHeight: `${options.height}%` });
        } else if (hidden) {
          const focused = focusedComponent(tui);
          if (focused !== view && (underlying === undefined || focused !== underlying)) return;
          hidden = false;
          handle.setHidden(false);
        }
      } catch (error) {
        close(error);
      } finally {
        reconciling = false;
      }
    };
    try {
      // Cancellation is available even before the probe or deferred installation.
      options.onOpen?.(() => close());
      if (!live) return;
      unsubscribe = options.promptState?.subscribe(reconcile);
      const probe = `subagents-viewer-probe-${++nextProbe}`;
      try {
        ui.setWidget(probe, (renderer, activeTheme) => {
          tui = renderer;
          theme = activeTheme;
          return { render: () => [], invalidate() {} };
        });
      } finally {
        ui.setWidget(probe, undefined);
      }
      if (!tui || !theme) throw new Error("Viewer TUI unavailable");
      reconcile();
    } catch (error) {
      close(error);
    }
  });
}
