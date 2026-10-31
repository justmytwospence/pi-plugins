import { VStack, type Component, type TUI } from "@earendil-works/pi-tui";
import type { FamilyViewOptions } from "../family-contract.ts";
import { canSplit, SplitLayout, type PrimaryViewTui } from "../layout.ts";
type View = { component?: Component; root?: Component; focus: Component | null; finish(): void };

/** One primary interaction, composed with (never placed over) the family Sidebar.
 * All renderer-private access remains in SplitLayout. No overlay handles are owned here.
 */
export class FamilyViewHost {
  private readonly original: Component;
  private readonly originalFocus: Component | null;
  private active: View | undefined;
  private split: SplitLayout | undefined;
  private requestedOpen = false;
  private budget = { width: 0, height: 0 };
  private suspensions = new Map<symbol, "native" | "local">();
  private suspendedFocus: Component | null = null;
  private disposed = false;

  constructor(private readonly tui: PrimaryViewTui, private readonly theme: unknown, private readonly keybindings: unknown) {
    if (!canSplit(tui)) throw new Error("Family views require Pi's fullscreen layout");
    this.original = tui.layoutRoot!;
    this.originalFocus = tui.getFocusedComponent?.() ?? null;
    this.budget = { width: tui.terminal?.columns ?? 0, height: tui.terminal?.rows ?? 0 };
  }

  get currentPrimary(): Component { return this.active?.component ?? this.original; }
  get hasView(): boolean { return !!this.active; }
  get suspended(): boolean { return this.suspensions.size > 0; }
  get sidebarRequestedOpen(): boolean { return this.requestedOpen; }
  private get nativeSuspended(): boolean { return [...this.suspensions.values()].includes("native"); }
  viewport = (): { width: number; height: number } => ({ ...this.budget });

  /** Controller owns the panel/settings; retain its requested-open state across views/dialogs. */
  mountSplit(layout: SplitLayout): boolean {
    if (this.disposed) return false;
    if (this.split === layout && this.requestedOpen && layout.mounted) return true;
    if (this.split !== layout) this.split?.unmount();
    this.split = layout;
    this.requestedOpen = true;
    this.render();
    return layout.mounted || this.suspended;
  }

  unmountSplit(): void {
    this.requestedOpen = false;
    if (this.suspended) this.suspendedFocus = this.active?.component ?? this.originalFocus;
    this.render();
    this.focusPrimary();
  }

  focusPrimary(): void {
    if (this.disposed) return;
    const native = this.nativeSuspended;
    this.tui.setFocus(native ? this.originalFocus : this.active?.component ?? this.originalFocus);
    this.tui.requestRender();
  }

  async view(options: FamilyViewOptions): Promise<void> {
    if (this.disposed) throw new Error("Family view host is disposed");
    if (this.active) throw new Error("A family primary view is already open");
    let resolve!: () => void;
    const closed = new Promise<void>((done) => { resolve = done; });
    const view: View = { focus: this.tui.getFocusedComponent?.() ?? null, finish: () => {} };
    view.finish = () => {
      if (this.active !== view) return;
      this.active = undefined;
      const focus = this.requestedOpen ? view.focus : this.originalFocus;
      if (this.suspendedFocus === view.component || !this.requestedOpen) this.suspendedFocus = focus;
      this.render();
      if (!this.suspended && !this.disposed) this.tui.setFocus(focus);
      resolve();
    };
    this.active = view;
    let component: Component;
    try {
      component = await options.factory(this.tui as unknown as TUI, this.theme, this.keybindings, () => view.finish(), this.viewport);
    } catch (error) {
      view.finish();
      throw error;
    }
    // done/dispose may win while an asynchronous factory is still constructing.
    if (this.active !== view) {
      (component as Component & { dispose?(): void }).dispose?.();
      return;
    }
    view.component = component;
    view.root = new VStack([{ component, basis: 0, grow: 1, minSize: 1, visible: (viewport) => {
      if (!this.split?.mounted) this.budget = { ...viewport };
      return true;
    } }]);
    const finish = view.finish;
    view.finish = () => {
      if (this.active !== view) return;
      finish();
      (component as Component & { dispose?(): void }).dispose?.();
    };
    this.render();
    if (!this.suspended) this.focusPrimary();
    await closed;
  }

  /** Native dialogs need main's real dock; planner-local questions keep their primary screen.
   * Call before starting a dialog, and invoke the returned release in finally. Nesting is safe.
   */
  suspend(kind: "native" | "local"): () => void {
    if (this.disposed) return () => {};
    if (!this.suspended) this.suspendedFocus = this.tui.getFocusedComponent?.() ?? null;
    const token = Symbol(kind);
    const focus = this.tui.getFocusedComponent?.() ?? null;
    this.suspensions.set(token, kind);
    this.render();
    if (kind === "native") this.tui.setFocus(this.originalFocus);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suspensions.delete(token);
      if (this.disposed) return;
      this.render();
      if (!this.suspended) {
        this.tui.setFocus(this.suspendedFocus);
        this.suspendedFocus = null;
      } else if (kind === "native" && !this.nativeSuspended) {
        this.tui.setFocus(focus === this.active?.component ? focus : this.active?.component ?? this.originalFocus);
      }
    };
  }

  private render(): void {
    this.split?.unmount();
    if (this.disposed) return;
    const native = this.nativeSuspended;
    this.tui.setLayoutRoot?.(native ? this.original : this.active?.root ?? this.original);
    if (this.requestedOpen && !this.suspended) {
      this.split?.mount(this.active?.root ?? this.original, (viewport) => { this.budget = { ...viewport }; });
    }
    this.tui.requestRender(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.active?.finish();
    this.split?.unmount();
    this.disposed = true;
    this.requestedOpen = false;
    this.suspensions.clear();
    this.tui.setLayoutRoot?.(this.original);
    this.tui.setFocus(this.originalFocus);
    this.tui.requestRender(true);
  }
}

