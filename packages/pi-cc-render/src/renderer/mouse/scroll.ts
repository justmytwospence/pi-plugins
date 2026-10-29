import {
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Keybinding,
} from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import { parseSgrMousePackets } from "./packets.ts";
import {
	OFFICIAL_SCROLL_TO_END_KEY,
	patchRegistry,
	SCROLL_BUTTON_STATE_SLOT,
	TOOL_MOUSE_TUI_SLOT,
} from "../../utils/patch-keys.ts";

const ZENTUI_PAGE_UP_INPUT = /^\x1b\[5;9(?::[12])?~$|^\x1b\[57421;9(?::[12])?u$|^\x1b\[1;6A$/;
const ZENTUI_PAGE_DOWN_INPUT = /^\x1b\[6;9(?::[12])?~$|^\x1b\[57422;9(?::[12])?u$|^\x1b\[1;6B$/;
const SCROLL_BOTTOM_SHORTCUT = "ctrl+end";

patchRegistry.ensure(TOOL_MOUSE_TUI_SLOT, () => null);
export function getToolMouseTui(): any {
	return patchRegistry.get(TOOL_MOUSE_TUI_SLOT);
}
export function setToolMouseTui(tui: any): void {
	patchRegistry.install(TOOL_MOUSE_TUI_SLOT, tui);
}

type ScrollButtonState = {
	visible: boolean;
	hovered: boolean;
	widget: any;
	/** New transcript blocks (messages + tool cards) added while the button is visible. */
	newCount: number;
};
function scrollButtonState(): ScrollButtonState {
	return patchRegistry.ensure(SCROLL_BUTTON_STATE_SLOT, () => ({
		visible: false,
		hovered: false,
		widget: null,
		newCount: 0,
	}));
}
export function getScrollButtonVisible(): boolean {
	return scrollButtonState().visible;
}
export function getScrollButtonHovered(): boolean {
	return scrollButtonState().hovered;
}
export function getScrollButtonWidget(): any {
	return scrollButtonState().widget;
}
export function getScrollButtonNewCount(): number {
	return scrollButtonState().newCount;
}
export function setScrollButtonVisible(visible: boolean): void {
	const state = scrollButtonState();
	state.visible = visible;
	// The count only applies while away from the bottom: following output resets it and the label returns to Back to bottom.
	if (!visible) state.newCount = 0;
}

/**
 * Records a new block landed in the transcript (user/assistant message, tool card).
 * Accumulates only while the button is visible (scrolled away from bottom) and requests a redraw so the label updates immediately.
 */
export function noteNewTranscriptItem(): void {
	const state = scrollButtonState();
	const tui = getToolMouseTui();
	if (!state.visible || !tui) return;
	// On submitting a new message the host may jump straight to the bottom (without scroll input): sync with the live follow state first,
	// otherwise content added while following would be counted as "new messages while away from bottom".
	if (isAtTranscriptBottom(tui)) {
		hideScrollButton(tui);
		return;
	}
	state.newCount += 1;
	tui.requestRender?.();
}

/** Returns whether anything changed (the caller uses it to decide on re-rendering). */
export function setScrollButtonHovered(hovered: boolean): boolean {
	if (hovered === scrollButtonState().hovered) return false;
	scrollButtonState().hovered = hovered;
	return true;
}

export function setScrollButtonWidget(widget: any): void {
	scrollButtonState().widget = widget;
}

/** Full reset on teardown (visible/hovered/widget/sync scheduling). */
export function resetScrollButtonState(): void {
	scrollButtonState().visible = false;
	scrollButtonState().hovered = false;
	scrollButtonState().widget = null;
	scrollButtonState().newCount = 0;
	scrollButtonSyncScheduled = false;
}

let scrollButtonSyncScheduled = false;

// The interaction switch depends only on the configured mode: the original implementation branched on isLazyProxyTui(toolMouseTui),
// but both branches were always true (under the 0.84+ lazy Proxy the check no longer affects the switch), so it is collapsed to one condition.
export function toolMouseInteractionActive(): boolean {
	return config.mode !== "off";
}

/** Detects the host's fullscreen (TuiAltScreen) under the lazy Proxy. */
export function fullscreenLazyTui(tui: any): boolean {
	return isLazyProxyTui(tui) && tui.mode === "fullscreen";
}

/** Disables pi 0.85's Jump to latest overlay so it does not stack with this repo's dock button. */
export function disableOfficialScrollToEnd(tui: any): void {
	if (!tui) return;
	const current = tui.scrollToEndIndicator;
	if (typeof current !== "function") return;
	// Keep the original function inside an object so the lazy Proxy does not wrap the function property again.
	if (!tui[OFFICIAL_SCROLL_TO_END_KEY]) {
		tui[OFFICIAL_SCROLL_TO_END_KEY] = { original: current };
	}
	// Replace rather than remove: Pi composites this label over the transcript's last row (an overlay that
	// takes no dock row) and handles the click itself. Only the wording and colors are ours.
	tui.scrollToEndIndicator = scrollIndicatorLabel;
}

let scrollIndicatorTheme: any = null;

function scrollIndicatorLabel(): string {
	const text = `[ ↓ ${scrollButtonText()} ]`;
	if (!scrollIndicatorTheme) return text;
	return scrollIndicatorTheme.fg(getScrollButtonHovered() ? "text" : "accent", text);
}

/** Restores the host overlay on /ccstyle off or teardown. */
export function restoreOfficialScrollToEnd(tui: any): void {
	if (!tui) return;
	const original = tui[OFFICIAL_SCROLL_TO_END_KEY]?.original;
	if (typeof original === "function") tui.scrollToEndIndicator = original;
	tui[OFFICIAL_SCROLL_TO_END_KEY] = undefined;
}

/** on/compact use the dock button; off restores pi's native Jump to latest. */
export function syncOfficialScrollToEnd(tui: any): void {
	if (toolMouseInteractionActive()) disableOfficialScrollToEnd(tui);
	else restoreOfficialScrollToEnd(tui);
}

/** A scroll view over a document (main's transcript is a container of message components). */
function isDocumentView(view: any): boolean {
	return !!view && typeof view.scrollToEnd === "function" && Array.isArray(view.child?.children);
}

/**
 * Main's transcript scroll view, which the dock button sits under. Usually Pi's primary scroll view,
 * but another one can be primary (pi-sidebar's panel while it has focus); then the scroll view over
 * a document anywhere in the layout tree. Falls back to the primary view.
 */
export function transcriptScrollView(tui: any): any {
	const primary = tui?.getPrimaryScrollView?.();
	if (isDocumentView(primary)) return primary;
	const seen = new Set<unknown>();
	const walk = (node: any, depth: number): any => {
		if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return undefined;
		seen.add(node);
		if (isDocumentView(node)) return node;
		const kids = [
			...(Array.isArray(node.entries) ? node.entries.map((entry: any) => entry?.component) : []),
			...(Array.isArray(node.children) ? node.children : []),
		];
		for (const kid of kids) {
			const found = walk(kid, depth + 1);
			if (found) return found;
		}
		return undefined;
	};
	try {
		return walk(tui?.layoutRoot, 0) ?? primary;
	} catch {
		return primary;
	}
}

/** Host fullscreen: whether main's transcript follows its bottom (button hidden condition). */
export function isFullscreenAtBottom(tui: any): boolean {
	const view = transcriptScrollView(tui);
	const following = view ? view.isFollowingEnd : tui.isFollowingOutput;
	return Boolean(following ?? true);
}

/** The dock button's action: scroll main's transcript to its end. */
export function scrollTranscriptToBottom(tui: any): void {
	const view = transcriptScrollView(tui);
	if (view && view !== tui.getPrimaryScrollView?.()) {
		view.scrollToEnd();
		tui.requestRender?.();
	} else tui.scrollToBottom?.();
}

function formatShortcut(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) =>
			part.length <= 1 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
		)
		.join("+");
}

export function isScrollBottomInput(data: string): boolean {
	return matchesKey(data, SCROLL_BOTTOM_SHORTCUT);
}

function isScrollNavigationInput(data: string): boolean {
	if (
		matchesKey(data, "pageUp") ||
		matchesKey(data, "pageDown") ||
		ZENTUI_PAGE_UP_INPUT.test(data) ||
		ZENTUI_PAGE_DOWN_INPUT.test(data) ||
		// Scroll keys of the host fullscreen viewport (half-page/prompt/top/bottom).
		[
			"tui.altScreen.pageUp",
			"tui.altScreen.pageDown",
			"tui.altScreen.halfPageUp",
			"tui.altScreen.halfPageDown",
			"tui.altScreen.previousPrompt",
			"tui.altScreen.nextPrompt",
			"tui.altScreen.top",
			"tui.altScreen.bottom",
		].some((key) => getKeybindings().matches(data, key as Keybinding))
	) {
		return true;
	}
	const packets = parseSgrMousePackets(data);
	return Boolean(
		packets?.some((packet) => {
			const baseButton = packet.code & ~(4 | 8 | 16 | 32);
			return packet.final === "M" && (baseButton === 64 || baseButton === 65);
		}),
	);
}

function isAtTranscriptBottom(tui: any): boolean {
	// Lazy Proxy fullscreen: the host viewport uses isFollowingOutput to decide whether it is at the bottom.
	if (fullscreenLazyTui(tui)) return isFullscreenAtBottom(tui);
	return true;
}

export function hideScrollButton(tui: any): void {
	const changed = getScrollButtonVisible() || getScrollButtonHovered();
	setScrollButtonVisible(false);
	setScrollButtonHovered(false);
	if (changed) tui.requestRender?.();
}

export function scheduleScrollButtonSync(tui: any, data: string): void {
	if (
		!fullscreenLazyTui(tui) ||
		!toolMouseInteractionActive() ||
		!isScrollNavigationInput(data) ||
		scrollButtonSyncScheduled
	)
		return;
	scrollButtonSyncScheduled = true;
	const previousLines = tui.previousLines;
	const check = (attempt: number) => {
		scrollButtonSyncScheduled = false;
		if (getToolMouseTui() !== tui) return;
		// Pi renders on its own frame timer. Inspect the resulting viewport before
		// showing the button so empty or non-scrollable transcripts never flash it.
		const rendered = tui.previousLines !== previousLines;
		// In fullscreen isFollowingOutput is live state; no need to wait for the host frame to render.
		if (!rendered && attempt < 4 && !fullscreenLazyTui(tui)) {
			scrollButtonSyncScheduled = true;
			const timer = setTimeout(() => check(attempt + 1), 16);
			if (typeof timer === "object" && timer !== null && "unref" in timer) {
				(timer as { unref: () => void }).unref();
			}
			return;
		}
		const nextVisible = !isAtTranscriptBottom(tui);
		if (nextVisible !== getScrollButtonVisible()) {
			setScrollButtonVisible(nextVisible);
			tui.requestRender?.();
		}
	};
	process.nextTick(() => check(0));
}

export function updateScrollButtonFromInput(tui: any, data: string): void {
	if (!fullscreenLazyTui(tui) || !toolMouseInteractionActive()) return;
	if (matchesKey(data, "enter") || matchesKey(data, "return")) hideScrollButton(tui);
}

/** Show the original label when there is no new content; otherwise show the accumulated count. */
function scrollButtonText(): string {
	const count = getScrollButtonNewCount();
	const shortcut = formatShortcut(SCROLL_BOTTOM_SHORTCUT);
	if (count <= 0) return `Back to bottom · ${shortcut}`;
	return `${count} new message${count === 1 ? "" : "s"} · ${shortcut}`;
}

/** The button is Pi's own overlay on the transcript's last row (see disableOfficialScrollToEnd); it has no dock row. */
export function renderScrollButton(_width: number, theme: any): string[] {
	scrollIndicatorTheme = theme;
	return [];
}
