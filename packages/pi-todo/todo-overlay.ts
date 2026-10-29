/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), Pi tool-output expansion awareness, auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getRenderState } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private collapsed = false;
	/** The user expanded the panel while every task is complete (which collapses it by itself). */
	private expandedWhenAllDone = false;
	private suppressed = false;

	/** Hide the widget while a dialog waits on the user (it needs the rows), keeping its state. */
	setSuppressed(suppressed: boolean): void {
		if (suppressed === this.suppressed) return;
		this.suppressed = suppressed;
		this.tui?.requestRender(true);
	}

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	toggleCollapse(): void {
		if (this.allDone) {
			// Fully completed lists start collapsed; the shortcut opens or closes them.
			const open = this.collapsed || !this.expandedWhenAllDone;
			this.collapsed = false;
			this.expandedWhenAllDone = open;
			if (!open) this.collapsed = true;
		} else {
			this.collapsed = !this.collapsed;
		}
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private allDone = false;

	/** The panel belongs to the end of the conversation: hide it while the transcript is scrolled back. */
	private isScrolledBack(): boolean {
		const view = this.findScrollView();
		return view !== undefined && view.isFollowingEnd === false;
	}

	private findScrollView(): { isFollowingEnd: boolean; primary?: boolean } | undefined {
		const seen = new Set<unknown>();
		const walk = (node: unknown, depth: number): { isFollowingEnd: boolean } | undefined => {
			if (!node || typeof node !== "object" || seen.has(node) || depth > 6) return undefined;
			seen.add(node);
			const c = node as { isFollowingEnd?: unknown; scrollToEnd?: unknown; primary?: unknown; entries?: { component?: unknown }[] };
			if (typeof c.isFollowingEnd === "boolean" && typeof c.scrollToEnd === "function" && c.primary === true) {
				return c as { isFollowingEnd: boolean };
			}
			for (const entry of Array.isArray(c.entries) ? c.entries : []) {
				const found = walk(entry?.component, depth + 1);
				if (found) return found;
			}
			return undefined;
		};
		const root = (this.tui as unknown as { layoutRoot?: unknown } | undefined)?.layoutRoot;
		return walk(root, 0);
	}

	private getSnapshot() {
		const state = getRenderState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	/** The panel, indented one column so it lines up with the transcript and other widgets. */
	private renderWidget(theme: Theme, width: number): string[] {
		return this.renderPanel(theme, Math.max(0, width - 1)).map((line) => (line ? ` ${line}` : line));
	}

	private renderPanel(theme: Theme, width: number): string[] {
		if (this.suppressed || this.isScrolledBack()) return [];
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		this.allDone = overlayTasks.every((task) => task.status === "completed");
		if (!this.allDone) this.expandedWhenAllDone = false;
		const collapsed = this.allDone ? this.collapsed || !this.expandedWhenAllDone : this.collapsed;
		if (collapsed && this.allDone) {
			// Collapsed, but still hides after the user's next message.
			for (const task of overlayTasks) {
				if (!this.hiddenCompletedTaskIds.has(task.id)) this.completedTaskIdsPendingHide.add(task.id);
			}
		}
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const showIds = selectShowTaskIds(overlayState);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const label = t("overlay.heading", OVERLAY_HEADING);
		const countText = `(${counts.completed}/${counts.total})`;
		const headingText = `${label} ${countText}`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		// One compact heading plus the trailing spacer; no separate hint row.
		// Short-circuit before budget math and completed-display tracking so tasks
		// not displayed while collapsed aren't queued to hide. Resolve the key live
		// (rebinding still needs /reload). "off" can occur after collapsing and
		// editing config, so show a static localized label rather than a fake key.
		if (collapsed) {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([
				this.renderCollapsedHeading(theme, width, headingColor, headingIcon, label, countText, hint),
			]);
		}

		const lines: string[] = [heading];
		// Budget for content rows (heading + tasks/summary). The rendered widget is
		// one line taller — withTrailingSpacer() appends a blank row below the panel.
		// Pi's global tool-output expansion mode is read on every render so its
		// expand/collapse shortcut also expands this live widget. Optional chaining
		// preserves compatibility with hosts predating getToolsExpanded().
		const bodyBudget = this.uiCtx?.getToolsExpanded?.() === true ? overlayTasks.length : getMaxWidgetLines() - 1;
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return this.withTrailingSpacer(lines);
	}

	/** Reserve counts before spending columns on the translated label or hint.
	 * ANSI-aware width/truncation matters for themes and wide-character locales.
	 * At extremely narrow widths drop label/icon before truncating the counts. */
	private renderCollapsedHeading(
		theme: Theme,
		width: number,
		color: "accent" | "dim",
		icon: string,
		label: string,
		counts: string,
		hint: string,
	): string {
		const countWidth = visibleWidth(counts);
		const prefix = `${theme.fg(color, icon)} `;
		const prefixWidth = visibleWidth(prefix);
		if (width < prefixWidth + countWidth) {
			return truncateToWidth(theme.fg(color, counts), Math.max(0, width), "…");
		}
		const labelBudget = width - prefixWidth - countWidth - 1;
		if (labelBudget < 1) return `${prefix}${theme.fg(color, counts)}`;
		const heading = `${prefix}${theme.fg(color, truncateToWidth(label, labelBudget, "…"))} ${theme.fg(color, counts)}`;
		const hintBudget = width - visibleWidth(heading) - 2;
		if (hintBudget < 1) return heading;
		return `${heading}  ${truncateToWidth(theme.fg("dim", hint), hintBudget, "…")}`;
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "+N more" summary) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.collapsed = false;
		this.expandedWhenAllDone = false;
		this.resetCompletedDisplayState();
	}
}
