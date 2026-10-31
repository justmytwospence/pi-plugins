import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, matchesKey, type TUI } from "@earendil-works/pi-tui";

interface ReviewScrollView {
  child: Component;
  scrollTop: number;
  viewportHeight: number;
  getContentWidth(width: number): number;
  scrollTo(top: number, options: { disableFollow: boolean }): void;
  scrollToEnd(): void;
}

/** Optional fullscreen internals: regular terminals and RPC keep their usual presentation. */
type ReviewTui = TUI & {
  getPrimaryScrollView?(): ReviewScrollView;
  layoutRoot?: { entries?: readonly { component?: unknown }[] };
};

interface Review {
  id: string;
  tui?: ReviewTui;
  view?: ReviewScrollView;
  removeWidget(): void;
  removeKeys?(): void;
  jump: boolean;
  queued: boolean;
  suspendedKeys: number;
  wasAtStart?: boolean;
  dimensions?: string;
  anchor?: number;
}

const EMPTY: Component = { render: () => [], invalidate() {} };
const CLEAR_SENTINEL = "\u0000pi-clear-screen\u0000";

function scrollView(tui: ReviewTui | undefined): ReviewScrollView | undefined {
  if (tui?.mode !== "fullscreen") return undefined;
  const valid = (value: unknown): value is ReviewScrollView => {
    const view = value as Partial<ReviewScrollView> | undefined;
    return (
      !!view?.child &&
      typeof view.child.render === "function" &&
      typeof view.getContentWidth === "function" &&
      typeof view.scrollTo === "function" &&
      typeof view.scrollToEnd === "function" &&
      Number.isFinite(view.viewportHeight)
    );
  };
  // Before the first frame, the SDK can return its implicit (empty) scroll view.
  const direct = tui.getPrimaryScrollView?.();
  if (valid(direct) && Array.isArray((direct.child as { children?: unknown }).children)) return direct;
  const mounted = tui.layoutRoot?.entries?.find(
    (entry) => (entry.component as { primary?: boolean } | undefined)?.primary === true,
  )?.component;
  return valid(mounted) ? mounted : undefined;
}

/** Only plain Containers concatenate children without adding padding or layout transforms. */
function planRow(component: Component, id: string, width: number, offset = 0): number | undefined {
  const tool = component as Component & { toolCallId?: string; toolName?: string };
  if (tool.toolCallId === id && tool.toolName === "exit_plan_mode") {
    // SDK's default tool shell: leading spacer, then Box top padding, then the call heading.
    // Keep the padding row at the top so an optional sticky-prompt bar cannot cover the heading.
    return offset + 1;
  }
  if (component.constructor.name !== "Container") return undefined;
  for (const child of (component as Component & { children: Component[] }).children) {
    const found = planRow(child, id, width, offset);
    if (found !== undefined) return found;
    offset += child.render(width).filter((line) => line !== CLEAR_SENTINEL).length;
  }
  return undefined;
}

/** A review-scoped, one-shot jump; normal renders never fight the reader's scrolling. */
export class PlanReviewViewport {
  private review?: Review;

  begin(ctx: ExtensionContext, id: string): void {
    this.end();
    if (ctx.mode !== "tui") return;
    const widget = `plan-review-viewport/${randomUUID()}`;
    const review: Review = {
      id,
      jump: true,
      queued: false,
      suspendedKeys: 0,
      removeWidget: () => ctx.ui.setWidget(widget, undefined),
    };
    this.review = review;
    // Ctrl+U / Ctrl+D scroll the plan half a page while you decide, as in /planners. Only for the
    // review: elsewhere they stay the editor's. Pi's own half-page bindings count too.
    try {
      review.removeKeys = ctx.ui.onTerminalInput((data) => {
        const up = matchesKey(data, "ctrl+u") || getKeybindings().matches(data, "tui.altScreen.halfPageUp");
        const down = matchesKey(data, "ctrl+d") || getKeybindings().matches(data, "tui.altScreen.halfPageDown");
        if ((!up && !down) || this.review !== review || review.suspendedKeys > 0) return undefined;
        return this.scrollHalf(review, up ? -1 : 1) ? { consume: true } : undefined;
      });
    } catch {
      // No raw input (not the interactive TUI): the keys keep their usual meaning.
    }
    // A zero-row widget gives us Pi's stable renderer proxy without replacing any UI.
    try {
      ctx.ui.setWidget(widget, (tui) => {
        review.tui = tui as ReviewTui;
        review.view = scrollView(review.tui);
        return EMPTY;
      });
    } catch {
      this.end();
    }
  }

  restart(): void {
    if (this.review) this.review.jump = true;
  }

  /** Let the filename editor own Ctrl+U/D until its prompt closes. */
  suspendScrollKeys(): () => void {
    const review = this.review;
    if (!review) return () => {};
    review.suspendedKeys++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      review.suspendedKeys--;
    };
  }

  wrap(id: string, component: Component): Component {
    return {
      invalidate: () => component.invalidate(),
      render: (width) => {
        const lines = [...component.render(width)];
        const review = this.review;
        if (!review || review.id !== id) return lines;
        try {
          const tui = review.tui;
          const view = scrollView(tui);
          if (!tui || !view || (review.view && review.view !== view)) return lines;
          review.view = view;
          const height = view.viewportHeight || tui.terminal.rows;
          // A plan that fits (with the call heading and Box padding) stays inline below the chat:
          // following the transcript's end already shows all of it.
          if (lines.length + 2 <= height) {
            if (review.jump) {
              // A new review (or a revision shorter than the last) follows the end again.
              review.jump = false;
              queueMicrotask(() => {
                if (this.review !== review) return;
                view.scrollToEnd();
                tui.requestRender();
              });
            }
            return lines;
          }
          // A longer one gets enough temporary tail to put its top at the top of the view; no
          // transcript entries are added.
          while (lines.length < height - 1) lines.push("");
          if (!review.queued) {
            // Capture this before layout can clamp scrollTop during a resize.
            review.wasAtStart = view.scrollTop === review.anchor;
            review.queued = true;
            // Wait until the whole frame (including the approval picker) has laid out.
            queueMicrotask(() => this.anchor(review));
          }
        } catch {
          // An unsupported/stale renderer must never prevent approval.
        }
        return lines;
      },
    };
  }

  private anchor(review: Review): void {
    review.queued = false;
    if (this.review !== review) return;
    try {
      const tui = review.tui;
      const view = scrollView(tui);
      if (!tui || !view || view !== review.view || view.viewportHeight <= 0) return;
      const width = view.getContentWidth(tui.terminal.columns);
      const dimensions = `${width}:${view.viewportHeight}`;
      if (!review.jump && dimensions === review.dimensions) return;
      const atStart = review.wasAtStart || view.scrollTop === review.anchor;
      const row = planRow(view.child, review.id, width);
      if (row === undefined) return;
      review.dimensions = dimensions;
      review.anchor = row;
      if (review.jump || atStart) {
        view.scrollTo(row, { disableFollow: true });
        // A growing viewport needs one more frame to grow the temporary tail as well.
        review.jump = view.scrollTop !== row;
        tui.requestRender();
      }
    } catch {
      review.jump = false;
    }
  }

  /** Scroll the transcript half its height up (-1) or down (1); false without a full-screen view. */
  private scrollHalf(review: Review, direction: -1 | 1): boolean {
    try {
      const view = scrollView(review.tui);
      if (!review.tui || !view || view.viewportHeight <= 0) return false;
      const step = Math.max(1, Math.floor(view.viewportHeight / 2));
      view.scrollTo(Math.max(0, view.scrollTop + direction * step), { disableFollow: true });
      // The reader moved: resizes no longer snap back to the plan's top.
      review.jump = false;
      review.tui.requestRender();
      return true;
    } catch {
      return false;
    }
  }

  end(): void {
    const review = this.review;
    this.review = undefined; // Invalidates queued jumps and removes padding from old components.
    if (!review) return;
    try {
      review.removeKeys?.();
    } catch {
      // Already gone with the UI.
    }
    try {
      review.removeWidget();
    } catch {
      // A dead UI must not prevent restoring follow-to-latest below.
    } finally {
      try {
        review.view?.scrollToEnd();
        review.tui?.requestRender();
      } catch {
        // The session may already have replaced or stopped its renderer.
      }
    }
  }
}
