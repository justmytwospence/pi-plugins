import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { hasActiveTextPreview, showTextPreview } from "../text-preview.ts";
import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import {
	patchRegistry,
	TOOL_GROUPING_PARENT_KEY,
	TOOL_MOUSE_OWNER_KEY,
} from "../../utils/patch-keys.ts";
import { ToolGroupComponent } from "../tool/grouping.ts";
import {
	isCompactAssistantComponent,
	markCompactRoundToolExpanded,
	setHoveredCompactAssistant,
} from "../compact-mode.ts";
import { isMessageDisplayComponent } from "../tool/message-display.ts";
import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import { setToolTuiFullscreen, isCollapseHintLine } from "../tool/show-more-hint.ts";
import {
	type ExpandedToolIoView,
	getActiveIoViewFrame,
	isExpandedToolIoView,
	type IoViewFrameState,
	setActiveIoViewFrame,
	type ToolIoSection,
} from "../tool/result.ts";
import {
	collectToolComponents,
	extractToolFramePlacements,
	isSgrIdleMotion,
	isSgrLeftPress,
	isSgrLeftRelease,
	isToolExecutionComponent,
	parseSgrMousePackets,
	stripTerminalSequences,
	stripTerminalSequencesPreservingLayout,
	toolFrameMarker,
	type FrameToolPlacement,
	type SgrMousePacket,
} from "./packets.ts";
import {
	collectFullscreenToolCards,
	componentAtLocalRow,
	collapsedHintHitbox,
	fullscreenContentWidth,
	fullscreenLeafAt,
	isScrollbarColumnAt,
} from "./layout.ts";
import {
	fullscreenLazyTui,
	hideScrollButton,
	restoreOfficialScrollToEnd,
	syncOfficialScrollToEnd,
	isScrollBottomInput,
	renderScrollButton,
	resetScrollButtonState,
	scheduleScrollButtonSync,
	scrollTranscriptToBottom,
	setScrollButtonHovered,
	setScrollButtonVisible,
	setScrollButtonWidget,
	setToolMouseTui,
	getScrollButtonVisible,
	getScrollButtonWidget,
	getToolMouseTui,
	toolMouseInteractionActive,
	updateScrollButtonFromInput,
} from "./scroll.ts";
import {
	applyFullscreenHover,
	cachedFullscreenComponentAtRow,
	sharedToolHoverState,
	setHoveredToolCallId,
	setHoveredToolGroup,
	setHoveredThinking,
	setHoveredMessageDisplay,
	setHoveredToolIo,
	type FullscreenHoverTarget,
} from "./hover.ts";

type FrameToolRender = {
	component: any;
	lines: string[];
	contentBoxLines: number;
};

type InteractionRegion = {
	kind: "collapsed-hint" | "collapse-hint" | "expanded-card" | "show-more" | "scroll-bottom";
	row: number;
	startCol: number;
	endCol: number;
	component?: any;
	view?: ExpandedToolIoView;
	section?: ToolIoSection;
};

type InteractionFrame = { regions: InteractionRegion[] };

const TOOL_MOUSE_WIDGET_KEY = "ccstyle-tool-mouse";
const TOOL_MOUSE_MOTION_ENABLE = "\x1b[?1003h\x1b[?1006h";
const TOOL_MOUSE_MOTION_DISABLE = "\x1b[?1003l";
const FULLSCREEN_MOTION_ENABLED = Symbol("ccstyle.fullscreen-motion-enabled");
const DEFAULT_TOOL_MOUSE_OWNER = {};
export const TOOL_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

let toolMouseUi: any = null;
let toolMouseInputUnsubscribe: (() => void) | null = null;
let toolMouseRenderPatchTui: any = null;
let toolMouseRenderPatchOriginal: ((...args: any[]) => any) | null = null;
let toolMouseRenderPatchWrapper: ((...args: any[]) => any) | null = null;
let toolMouseRenderPatchState: { active: boolean } | null = null;
let toolMouseRawWrite: ((data: string) => unknown) | null = null;
let toolMouseInstallationOwner: object | null = null;
let fullscreenMotionTerminal: any = null;
let ownsFullscreenMotion = false;
let sessionRenderTimer: ReturnType<typeof setTimeout> | null = null;
let latestInteractionFrame: InteractionFrame = { regions: [] };

/** Summary markers used by Pi and ccstyle; unlike the trailing hint, these survive truncation. */
const COLLAPSED_TOOL_SUMMARY = /^\s*(?:↳|└|⎿|●|✓|✗|…)/;

function interactionRegionAt(packet: SgrMousePacket): InteractionRegion | null {
	const matches = latestInteractionFrame.regions.filter(
		(region) =>
			region.row === packet.row && packet.col >= region.startCol && packet.col <= region.endCol,
	);
	return (
		matches.find((region) => region.kind === "show-more") ??
		matches.find((region) => region.kind === "scroll-bottom") ??
		matches.find((region) => region.kind === "collapsed-hint") ??
		matches.find((region) => region.kind === "collapse-hint") ??
		matches.find((region) => region.kind === "expanded-card") ??
		null
	);
}

function tryOpenToolIoShowMore(region: InteractionRegion): boolean {
	const ioView = region.view;
	const section = region.section;
	if (!ioView || !section) return false;
	const ui = toolMouseUi;
	if (!ui || typeof ui.custom !== "function") {
		ui?.notify?.("Full preview requires TUI custom UI", "warning");
		return true;
	}
	const title = section === "input" ? "Tool Input" : "Tool Output";
	const content = section === "input" ? ioView.getInputBody() : ioView.getOutputBody();
	// When the whole text is code, wrap it in a fence: the popup renders Markdown, and only fenced code blocks get colored
	const fence = section === "input" ? ioView.getInputCodeFence() : undefined;
	const preview = fence ? `\`\`\`${fence.language}\n${fence.code}\n\`\`\`` : content;
	void showTextPreview({ ui }, title, preview || "(empty)");
	return true;
}

function updateToolSummaryHover(tui: any, packet: SgrMousePacket): void {
	if (!isSgrIdleMotion(packet)) return;
	const region = interactionRegionAt(packet);
	const nextScrollButtonHovered = region?.kind === "scroll-bottom";
	const scrollButtonChanged = setScrollButtonHovered(nextScrollButtonHovered);
	const component = region?.component;
	const nextToolCallId = region?.kind === "collapsed-hint" ? (component?.toolCallId ?? null) : null;
	// The group is highlighted only on the hint text (an expanded card is entirely expanded-card, which must not count as a hint).
	const nextGroup =
		(region?.kind === "collapsed-hint" || region?.kind === "collapse-hint") &&
		component instanceof ToolGroupComponent
			? component
			: null;
	const nextIoView = region?.kind === "show-more" ? (region.view ?? null) : null;
	const nextIoSection = region?.kind === "show-more" ? (region.section ?? null) : null;
	const changed = nextToolCallId !== sharedToolHoverState().toolCallId;
	setHoveredToolCallId(nextToolCallId);
	if (
		scrollButtonChanged ||
		setHoveredToolIo(nextIoView, nextIoSection) ||
		setHoveredToolGroup(nextGroup) ||
		changed
	)
		tui.requestRender?.();
}

/** Click detection: press and release land on the same cell (the condition for the renderer to synthesize a click), with tolerance for movement and time. */
const COLLAPSE_CLICK_MOVE_TOLERANCE = 1;
const COLLAPSE_CLICK_MAX_MS = 600;
/** After the extension collapses its own card, the official click may toggle the inner tool card again for the same click; swallow it briefly. */
const SUPPRESS_OFFICIAL_CARD_CLICK_MS = 300;
/** Official fullscreen focus event string: sending it to the original handler clears the selection anchor (see tui-alt-screen). */
const FULLSCREEN_FOCUS_OUT = "\x1b[O";

let pendingCollapsePress: {
	card: any;
	/** Innermost component hit: official tool cards are collapsed by the MouseRegion click. */
	component: any;
	col: number;
	row: number;
	at: number;
} | null = null;
let suppressOfficialCardClickUntil = 0;

function clearPendingCollapsePress(): void {
	pendingCollapsePress = null;
}

/** Drag or wheel with a key held: if the position really changed (beyond jitter tolerance) it is no longer a click. */
function clearPendingCollapsePressOnMove(packet: SgrMousePacket): void {
	const press = pendingCollapsePress;
	if (!press) return;
	if ((packet.code & 64) !== 0) {
		pendingCollapsePress = null;
		return;
	}
	if (Math.abs(packet.col - press.col) <= COLLAPSE_CLICK_MOVE_TOLERANCE) {
		if (Math.abs(packet.row - press.row) <= COLLAPSE_CLICK_MOVE_TOLERANCE) return;
	}
	pendingCollapsePress = null;
}

function clearHoverState(): void {
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredToolIo(null, null);
	setHoveredCompactAssistant(null);
}

/** Collapse an expanded card (the group's setExpanded propagates to inner tools). */
function collapseExpandedCard(tui: any, card: any): void {
	card.setExpanded(false);
	clearHoverState();
	card.invalidate?.();
	tui?.requestRender?.();
}

function rememberCollapsePress(card: any, component: any, packet: SgrMousePacket): void {
	pendingCollapsePress = { card, component, col: packet.col, row: packet.row, at: Date.now() };
}

/**
 * Release settlement: only a complete click (press and release on the same cell) collapses; dragging to select text keeps it expanded.
 * Official tool cards (the MouseRegion in the result area) are collapsed by the guard in the official click, so skip them here;
 * otherwise collapsing first would be flipped back by the official click's setExpanded(!expanded).
 */
function resolveCollapsePress(
	tui: any,
	packet: SgrMousePacket,
	options: { skipOfficialCards: boolean },
): any {
	const press = pendingCollapsePress;
	pendingCollapsePress = null;
	if (!press || packet.final !== "m") return undefined;
	if (Math.abs(packet.col - press.col) > COLLAPSE_CLICK_MOVE_TOLERANCE) return undefined;
	if (Math.abs(packet.row - press.row) > COLLAPSE_CLICK_MOVE_TOLERANCE) return undefined;
	if (Date.now() - press.at > COLLAPSE_CLICK_MAX_MS) return undefined;
	if (options.skipOfficialCards && press.component instanceof ToolExecutionComponent)
		return undefined;
	const card = press.card;
	if (
		(card instanceof ToolGroupComponent || isCompactAssistantComponent(card)) &&
		press.component !== card
	) {
		// Click landed on a tool row inside the card: the official click would toggle again for the same click, so swallow it.
		suppressOfficialCardClickUntil = Date.now() + SUPPRESS_OFFICIAL_CARD_CLICK_MS;
	}
	collapseExpandedCard(tui, card);
	// Returns the collapsed card: the caller only clears the official selection for compact panels.
	return card;
}

function toggleToolAtMouseClick(tui: any, packet: SgrMousePacket): boolean {
	const region = interactionRegionAt(packet);
	if (!region) return false;
	if (region.kind === "scroll-bottom") return false;
	if (region.kind === "show-more") return tryOpenToolIoShowMore(region);
	const component = region.component;
	if (!component) return false;
	if (region.kind === "expanded-card" || region.kind === "collapse-hint") {
		// Regular mode has no official click synthesis: record the press first, and settle on release whether to collapse.
		rememberCollapsePress(component, component, packet);
		return true;
	}
	component.setExpanded(true);
	clearPendingCollapsePress();
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredToolIo(null, null);
	component.invalidate?.();
	tui.requestRender?.();
	return true;
}

function officialFullscreenHasAllMotion(): boolean {
	const term = process.env.TERM?.toLowerCase() ?? "";
	return !(
		process.env.TMUX !== undefined ||
		process.env.ZELLIJ !== undefined ||
		process.env.STY !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen")
	);
}

/**
 * Hover depends on DECSET 1003. Official fullscreen only enables 1002 under a multiplexer,
 * so the extension must enable it on every actual renderer (the Symbol resolves to the current instance via the lazy Proxy).
 */
function ensureFullscreenToolMouseMotion(tui: any): void {
	setToolTuiFullscreen(fullscreenLazyTui(tui));
	if (!fullscreenLazyTui(tui)) {
		releaseFullscreenToolMouseMotion(tui);
		return;
	}
	// After the panel changes scrollStepLines, the next frame syncs it (restore still restores from original).
	if (typeof tui.wheelScrollLines === "number" && tui.wheelScrollLines !== config.scrollStepLines) {
		tui.wheelScrollLines = config.scrollStepLines;
	}
	if (
		!toolMouseInteractionActive() ||
		tui.mouseEnabled === false ||
		tui.altScreenActive === false ||
		tui[FULLSCREEN_MOTION_ENABLED]
	) {
		return;
	}
	try {
		tui.terminal?.write?.(TOOL_MOUSE_MOTION_ENABLE);
		tui[FULLSCREEN_MOTION_ENABLED] = true;
		fullscreenMotionTerminal = tui.terminal;
		ownsFullscreenMotion = !officialFullscreenHasAllMotion();
	} catch {
		// The renderer may be switching or the terminal already closed.
	}
}

function releaseFullscreenToolMouseMotion(tui?: any): void {
	try {
		if (tui?.[FULLSCREEN_MOTION_ENABLED]) tui[FULLSCREEN_MOTION_ENABLED] = false;
	} catch {
		// The lazy Proxy may have switched to another renderer.
	}
	const terminal = fullscreenMotionTerminal;
	const shouldDisable = ownsFullscreenMotion;
	fullscreenMotionTerminal = null;
	ownsFullscreenMotion = false;
	try {
		if (shouldDisable) terminal?.write?.(TOOL_MOUSE_MOTION_DISABLE);
	} catch {
		// The renderer may be switching or the terminal already closed.
	}
}

const FULLSCREEN_VIEWPORT_PATCH = Symbol("ccstyle.fullscreen-viewport-patch");
const FULLSCREEN_WHEEL_SCROLL_ORIGINAL = Symbol("ccstyle.fullscreen-wheel-scroll-original");

/**
 * A diff result component carries its own remainder row: when declared, only that row is the expand entry (the same wording in the body does not count);
 * undeclared components keep using the text rules.
 */
function isCollapsedHintRow(component: any, finalLine: string): boolean {
	const result = component?.resultRendererComponent;
	return typeof result?.isCollapsedHintLine === "function"
		? result.isCollapsedHintLine(finalLine)
		: true;
}

/**
 * pi 0.87 wraps the tool result area in a MouseRegion: any left click on the whole card calls setExpanded.
 * When this region is hit, the official handler skips text selection, so it is safe to swallow; single-line summary cards declare no
 * remainder row and keep the official whole-row behavior.
 */
function blocksOfficialCardToggle(component: any, event: any): boolean {
	if (event?.type !== "click" || event.button !== "left" || component?.expanded) return false;
	const result = component?.resultRendererComponent;
	if (typeof result?.isCollapsedHintLine !== "function") return false;
	const lines = component.render?.(Math.max(1, Math.floor(Number(event.width) || 0)));
	const line = Array.isArray(lines) ? lines[event.y] : undefined;
	return typeof line === "string" && !result.isCollapsedHintLine(line);
}

/**
 * Official fullscreen tool card click: a single click on a collapsed hint expands
 * (keeping exactly one expanded: other tool cards are collapsed first); expanded cards let the official press through,
 * and a release at an unchanged position collapses (official cards via the guard; thinking/group/compact own cards are settled by the extension);
 * dragging to select text does not collapse; clicking the truncated header's show-more opens the full preview; the back-to-bottom button calls scrollToBottom.
 * The scrollbar column, rows with OSC8 links, non-tool areas, and collapsed card bodies are passed to the official handler.
 */
function handleFullscreenToolClick(tui: any, packet: SgrMousePacket): boolean {
	const layout = tui.currentLayout;
	if (!layout?.root) return false;
	// Official event coordinates are 0-based; SGR packets are 1-based.
	const x = packet.col - 1;
	const y = packet.row - 1;
	if (isScrollbarColumnAt(layout, x)) return false;
	const hit = fullscreenLeafAt(layout, x, y);
	if (!hit) return false;
	const width = Math.max(1, Number(tui.terminal?.columns) || 80);
	// The layout tree renders content with the scroll's contentWidth (= width-1 when the scrollbar is shown);
	// row lookup must use the same width, or wrapping differences misalign component rows.
	const contentWidth = fullscreenContentWidth(hit.box, width);
	const target = componentAtLocalRow(hit.box.component, hit.localRow, contentWidth);
	if (!target) return false;
	const component = target.component;
	// When hit inside a compact expanded panel the owner is the panel: both the collapse target and the bookkeeping target belong to the panel,
	// otherwise skipOfficialCards would skip inner tools as official cards.
	const card = target.group ?? target.owner ?? component;
	const pressComponent = target.owner ?? component;
	// Back-to-bottom button: hit by component reference, independent of the rendered-line cache.
	if (getScrollButtonVisible() && component === getScrollButtonWidget()) {
		scrollTranscriptToBottom(tui);
		hideScrollButton(tui);
		return true;
	}
	const line = hit.box.lines?.[hit.localRow];
	if (typeof line !== "string" || /\x1b]8;[^;]*;/.test(line)) return false;
	const isTool = isToolExecutionComponent(component);
	const isGroup = component instanceof ToolGroupComponent;
	const isAssistant = isCompactAssistantComponent(component);
	const isThinking = component instanceof ThinkingPreviewBlock;
	const isMessage = isMessageDisplayComponent(component);
	if (!isTool && !isGroup && !isAssistant && !isThinking && !isMessage) return false;
	if (!component.expanded) {
		// When collapsed, only the button text can expand; the body text or blank space on the same row must not become a click area.
		const hint = collapsedHintHitbox(line);
		const onHint = Boolean(
			hint &&
				packet.col >= hint.startCol &&
				packet.col <= hint.endCol &&
				isCollapsedHintRow(component, line),
		);
		if (!onHint) {
			// Non-hint area inside the panel (tool card title/summary rows, thinking preview body): a single click collapses the whole panel.
			if (target.owner) rememberCollapsePress(target.owner, target.owner, packet);
			return false;
		}
		// single-expand: collapse other expanded tool cards/groups before expanding.
		const others: any[] = [];
		collectFullscreenToolCards(hit.box.component, others);
		for (const other of others) {
			if (other !== component && other.expanded) {
				// When expanding thinking/tools inside a round card, the outer compact card is their container and must not be collapsed.
				// When the panel hangs on the summary row, anchor and summary row are the same outer card, so clicking an inner tool must not collapse it.
				if (
					(isThinking || isTool) &&
					isCompactAssistantComponent(other) &&
					(other === target.owner || other === target.owner?.roundAnchor)
				)
					continue;
				other.setExpanded(false);
				other.invalidate?.();
			}
		}
		// When expanding a tool inside a round card, let compact's forced collapse let it through (no-op for tools outside a round).
		if (isTool) markCompactRoundToolExpanded(component);
		component.setExpanded(true);
		clearPendingCollapsePress();
	} else {
		// Normal tool truncated header show-more: open the full preview (without collapsing).
		const view = isTool ? component.resultRendererComponent : null;
		if (isExpandedToolIoView(view)) {
			const plain = stripTerminalSequencesPreservingLayout(line);
			const section = view.matchShowMoreLine(plain);
			if (section) {
				clearPendingCollapsePress();
				const box = view.showMoreHitbox(plain);
				return tryOpenToolIoShowMore({
					kind: "show-more",
					row: 0,
					startCol: box?.startCol ?? 1,
					endCol: box?.endCol ?? 1,
					component,
					view,
					section,
				});
			}
		}
		// Everything else goes to the official handler: selection, OSC8 links, and click synthesis are left to the renderer.
		// Collapse on a complete click: official cards are handled by the guard; own cards are settled on release.
		rememberCollapsePress(card, pressComponent, packet);
		return false;
	}
	// Clear the hover highlight after a click. Only invalidate the clicked component (or its group),
	// and do not touch the owner panel: invalidating the panel re-runs updateContent and rebuilds thinking instances.
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredToolIo(null, null);
	setHoveredCompactAssistant(null);
	(target.group ?? component).invalidate?.();
	tui.requestRender?.();
	return true;
}

/**
 * Fullscreen mouse hover: the [click to show more] hint on collapsed cards,
 * the truncated-header show-more on expanded cards, and the back-to-bottom button. Motion is not consumed; the official chain runs as usual.
 */
function handleFullscreenToolHover(tui: any, packet: SgrMousePacket): void {
	if (!isSgrIdleMotion(packet)) return;
	const layout = tui.currentLayout;
	if (!layout?.root) return;
	const x = packet.col - 1;
	const y = packet.row - 1;
	let target: FullscreenHoverTarget | null = null;
	const hit = fullscreenLeafAt(layout, x, y);
	if (hit) {
		const line = hit.box.lines?.[hit.localRow];
		// Back-to-bottom button: identified by rendered line text + column range (no component tree cost).
		if (typeof line === "string" && getScrollButtonVisible() && line.includes("[ ↓")) {
			const plain = stripTerminalSequencesPreservingLayout(line);
			const idx = plain.indexOf("[ ↓");
			if (idx >= 0 && x >= idx && x <= idx + plain.length - 1) {
				target = { kind: "button" };
			}
		} else if (typeof line === "string" && !/\x1b]8;/.test(line)) {
			const width = Math.max(1, Number(tui.terminal?.columns) || 80);
			const contentWidth = fullscreenContentWidth(hit.box, width);
			// Share the positioning algorithm with click, so hover's own row segments cannot drift from the real component tree.
			const componentHit = cachedFullscreenComponentAtRow(
				layout,
				hit.box.component,
				hit.localRow,
				contentWidth,
			);
			const component = componentHit?.component;
			const hintBox = collapsedHintHitbox(line);
			const overHint = Boolean(
				hintBox && packet.col >= hintBox.startCol && packet.col <= hintBox.endCol,
			);
			if (component instanceof ToolGroupComponent) {
				if (overHint) target = { kind: "group", component };
			} else if (component instanceof ThinkingPreviewBlock) {
				if (component.expanded || overHint) target = { kind: "thinking", component };
			} else if (isToolExecutionComponent(component)) {
				let view: ExpandedToolIoView | null = null;
				let section: ToolIoSection | null = null;
				if (component.expanded) {
					const resultView = component.resultRendererComponent;
					if (isExpandedToolIoView(resultView)) {
						view = resultView;
						const plain = stripTerminalSequencesPreservingLayout(line);
						const candidate = view.matchShowMoreLine(plain);
						if (candidate) {
							const box = view.showMoreHitbox(plain);
							if (box && x + 1 >= box.startCol && x + 1 <= box.endCol) {
								section = candidate;
							}
						}
					}
					target = { kind: "tool", component, view, section };
				} else if (overHint) {
					target = { kind: "tool", component, view, section };
				}
			} else if (isCompactAssistantComponent(component)) {
				// compact summary row: when collapsed only the hint text is highlighted; an expanded card is highlighted as a whole.
				if (component.expanded || overHint) target = { kind: "assistant", component };
			} else if (isMessageDisplayComponent(component)) {
				if (overHint) target = { kind: "message", component };
			}
		}
	}
	applyFullscreenHover(tui, target);
}

/**
 * Instance-level wrapper for TuiAltScreen.handleViewportInput (safe with the lazy Proxy):
 * take original from the prototype method (bypassing the proxy function wrapper), and install the wrapper as an instance own property
 * (the constructor arrow's dynamic lookup hits it). Only in fullscreen with no overlay, consume
 * tool card left clicks first; everything else goes to the official selection/scrollbar/URL/keyboard chain.
 */
function patchFullscreenViewportInput(tui: any): void {
	if (tui[FULLSCREEN_VIEWPORT_PATCH] || !isLazyProxyTui(tui)) return;
	const proto = Object.getPrototypeOf(tui);
	const original = proto?.handleViewportInput;
	if (typeof original !== "function") return;
	// The official native routeWheel already handles nested ScrollViews; only adjust the default step (config.scrollStepLines).
	if (typeof tui.wheelScrollLines === "number") {
		tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL] = tui.wheelScrollLines;
		tui.wheelScrollLines = config.scrollStepLines;
	}
	tui[FULLSCREEN_VIEWPORT_PATCH] = true;
	tui.handleViewportInput = function (this: any, data: string) {
		if (toolMouseInteractionActive() && tui.mode === "fullscreen") {
			// After scroll input (wheel/pageUp/end etc.), sync the back-to-bottom button's visibility;
			// the official viewport consumes keyboard input, so the extension listener cannot compensate and must schedule it here.
			scheduleScrollButtonSync(tui, data);
			const packets = parseSgrMousePackets(data);
			// Official fullscreen consumes all mouse input; while a text preview overlay is active, let it through to the focused
			// custom component so [esc] clicks and the wheel work.
			if (packets && tui.hasOverlay?.() && hasActiveTextPreview()) return undefined;
			if (packets && !tui.hasOverlay?.()) {
				for (const packet of packets) {
					if (isSgrLeftRelease(packet)) {
						// Clear the selection only for compact panels: collapsing an own panel reflows the layout, and the official selection anchor
						// still sits on the old layout, so the same release would settle into a multi-row highlight.
						if (
							isCompactAssistantComponent(
								resolveCollapsePress(tui, packet, { skipOfficialCards: true }),
							)
						) {
							try {
								Reflect.apply(original, this, [FULLSCREEN_FOCUS_OUT]);
							} catch {
								/* older versions have no selection state */
							}
						}
					} else if (!isSgrLeftPress(packet) && !isSgrIdleMotion(packet))
						clearPendingCollapsePressOnMove(packet);
					if (isSgrLeftPress(packet) && handleFullscreenToolClick(tui, packet)) {
						return { consume: true };
					}
					// Only motion with no button goes to hover; left-button drag (multi-line text selection) goes to the official selection, avoiding hit-test + redraw per pixel.
					if (isSgrIdleMotion(packet)) {
						handleFullscreenToolHover(tui, packet);
					}
				}
			}
		}
		return Reflect.apply(original, this, [data]);
	};
}

function restoreFullscreenViewportInput(tui: any): void {
	if (!tui || !tui[FULLSCREEN_VIEWPORT_PATCH]) return;
	const proto = Object.getPrototypeOf(tui);
	if (typeof proto?.handleViewportInput === "function") {
		tui.handleViewportInput = proto.handleViewportInput;
	}
	const originalWheelScrollLines = tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL];
	if (typeof originalWheelScrollLines === "number") {
		tui.wheelScrollLines = originalWheelScrollLines;
		tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL] = undefined;
	}
	tui[FULLSCREEN_VIEWPORT_PATCH] = false;
}

function restoreToolMouseRenderPatch(): void {
	if (toolMouseRenderPatchState) toolMouseRenderPatchState.active = false;
	if (
		toolMouseRenderPatchTui &&
		toolMouseRenderPatchOriginal &&
		toolMouseRenderPatchTui.doRender === toolMouseRenderPatchWrapper
	) {
		toolMouseRenderPatchTui.doRender = toolMouseRenderPatchOriginal;
	}
	toolMouseRenderPatchTui = null;
	toolMouseRenderPatchOriginal = null;
	toolMouseRenderPatchWrapper = null;
	toolMouseRenderPatchState = null;
	toolMouseRawWrite = null;
	latestInteractionFrame = { regions: [] };
}

function buildInteractionFrame(
	tui: any,
	renderedTools: FrameToolRender[],
	placements: FrameToolPlacement[],
): InteractionFrame {
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	// native: full buffer; map with the post-doRender previousViewportTop.
	const lineIndexToScreenRow = (lineIndex: number) =>
		lineIndex - (Number(tui?.previousViewportTop) || 0) + 1;
	const visibleRows = Math.max(1, Number(tui?.terminal?.rows) || Number.POSITIVE_INFINITY);
	const regions: InteractionRegion[] = [];
	const renderedByComponent = new Map<any, FrameToolRender>();
	for (const rendered of renderedTools) renderedByComponent.set(rendered.component, rendered);
	const placementsByComponent = new Map<any, FrameToolPlacement[]>();
	for (const placement of placements) {
		const list = placementsByComponent.get(placement.component) ?? [];
		list.push(placement);
		placementsByComponent.set(placement.component, list);
	}
	for (const [component, componentPlacements] of placementsByComponent) {
		const rendered = renderedByComponent.get(component);
		if (!rendered) continue;
		for (const placement of componentPlacements) {
			const finalRow = lineIndexToScreenRow(placement.lineIndex);
			if (finalRow < 1 || finalRow > visibleRows) continue;
			// Hit columns come from the final painted line (parent may prefix/transform).
			const line = placement.finalLine;
			if (!component.expanded) {
				const box = collapsedHintHitbox(line);
				if (
					box &&
					COLLAPSED_TOOL_SUMMARY.test(stripTerminalSequences(line)) &&
					isCollapsedHintRow(component, line)
				) {
					regions.push({ kind: "collapsed-hint", row: finalRow, ...box, component });
				}
				continue;
			}
			if (placement.view && placement.section) {
				const plain = stripTerminalSequencesPreservingLayout(line);
				const box = placement.view.showMoreHitbox(plain);
				if (box) {
					regions.push({
						kind: "show-more",
						row: finalRow,
						...box,
						component,
						view: placement.view,
						section: placement.section,
					});
				}
			}
		}
		if (!component.expanded) continue;
		let cardStart = 0;
		if (!(component instanceof ToolGroupComponent)) {
			const box = component.contentBox;
			if (!box || !Array.isArray(component.children) || !component.children.includes(box)) {
				continue;
			}
			if (!rendered.contentBoxLines) continue;
			cardStart = Math.max(0, rendered.lines.length - rendered.contentBoxLines);
		}
		for (const placement of componentPlacements) {
			if (placement.componentRow < cardStart) continue;
			const finalRow = lineIndexToScreenRow(placement.lineIndex);
			if (finalRow >= 1 && finalRow <= visibleRows) {
				// The expanded-state "↑ Collapse" hint is its own region: hover highlights the hint, and clicking still collapses the whole card.
				const hintBox = collapsedHintHitbox(placement.finalLine);
				if (hintBox && isCollapseHintLine(stripTerminalSequences(placement.finalLine))) {
					regions.push({ kind: "collapse-hint", row: finalRow, ...hintBox, component });
				}
				regions.push({
					kind: "expanded-card",
					row: finalRow,
					startCol: 1,
					endCol: width,
					component,
				});
			}
		}
	}
	return { regions };
}

/**
 * Temporarily wrap the render of outermost tools/components to inject a zero-width marker, returning a list to restore.
 * The caller must restore immediately with restoreRenderOverride (valid within the same render).
 */
function wrapToolRendersForFrame(
	outermost: any[],
	renderedTools: FrameToolRender[],
	idToComponent: Map<number, any>,
): Array<{ target: any; descriptor?: PropertyDescriptor }> {
	const restores: Array<{ target: any; descriptor?: PropertyDescriptor }> = [];
	let nextId = 0;
	try {
		for (const component of outermost) {
			const originalRender = component.render;
			if (typeof originalRender !== "function") continue;
			const id = nextId++;
			idToComponent.set(id, component);
			const wrappedRender = function (this: any, ...renderArgs: any[]) {
				let contentBoxLines = 0;
				const box = component.contentBox;
				let boxRestore: { target: any; descriptor?: PropertyDescriptor } | undefined;
				if (
					box &&
					Array.isArray(component.children) &&
					component.children.includes(box) &&
					typeof box.render === "function"
				) {
					const boxOriginal = box.render;
					const boxWrapped = function (this: any, ...boxArgs: any[]) {
						const boxLines = Reflect.apply(boxOriginal, this, boxArgs);
						if (Array.isArray(boxLines)) contentBoxLines = boxLines.length;
						return boxLines;
					};
					const boxDescriptor = defineRenderOverride(box, boxWrapped);
					if (boxDescriptor !== undefined || box.render === boxWrapped) {
						boxRestore = { target: box, descriptor: boxDescriptor };
					}
				}
				try {
					const lines = Reflect.apply(originalRender, this, renderArgs);
					if (!Array.isArray(lines)) return lines;
					renderedTools.push({
						component,
						lines: lines.map((line) => String(line)),
						contentBoxLines,
					});
					return lines.map((line, row) => `${line}${toolFrameMarker(id, row)}`);
				} finally {
					if (boxRestore) restoreRenderOverride(boxRestore.target, boxRestore.descriptor);
				}
			};
			const descriptor = defineRenderOverride(component, wrappedRender);
			if (descriptor !== undefined || component.render === wrappedRender) {
				restores.push({ target: component, descriptor });
			}
		}
		return restores;
	} catch (error) {
		for (const { target, descriptor } of restores.reverse()) {
			restoreRenderOverride(target, descriptor);
		}
		throw error;
	}
}

function defineRenderOverride(
	target: any,
	wrapped: (...args: any[]) => any,
): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(target, "render");
	try {
		Object.defineProperty(
			target,
			"render",
			descriptor && "value" in descriptor
				? { ...descriptor, value: wrapped }
				: {
						configurable: true,
						enumerable: descriptor?.enumerable ?? false,
						writable: true,
						value: wrapped,
					},
		);
		return descriptor;
	} catch {
		return undefined;
	}
}

function restoreRenderOverride(target: any, descriptor: PropertyDescriptor | undefined): void {
	try {
		if (descriptor) Object.defineProperty(target, "render", descriptor);
		else delete target.render;
	} catch {
		// Keep restoring siblings after a hostile descriptor change.
	}
}

function patchToolMouseMotionAfterRender(tui: any): void {
	// Same tui is not enough: footer/compositor rebuild may replace doRender under us.
	if (
		toolMouseRenderPatchTui === tui &&
		toolMouseRenderPatchState?.active &&
		tui.doRender === toolMouseRenderPatchWrapper
	) {
		return;
	}
	// 0.84+ lazy Proxy: the captured doRender would resolve to the wrapper itself (infinite recursion), so skip.
	if (isLazyProxyTui(tui)) return;
	restoreToolMouseRenderPatch();
	const original = tui?.doRender;
	const terminal = tui?.terminal;
	const rawWrite = typeof terminal?.write === "function" ? terminal.write : undefined;
	if (typeof original !== "function") return;

	toolMouseRawWrite = rawWrite ? (data) => Reflect.apply(rawWrite, terminal, [data]) : null;
	const patchState = { active: true };
	const wrapper = function (this: any, ...args: any[]) {
		if (!patchState.active) return Reflect.apply(original, this, args);
		const renderedTools: FrameToolRender[] = [];
		const idToComponent = new Map<number, any>();
		const frame: IoViewFrameState = {
			viewIds: new Map(),
			idToView: new Map(),
			nextId: 0,
		};
		const outermost: any[] = [];
		collectToolComponents(this, outermost);
		const restores = wrapToolRendersForFrame(outermost, renderedTools, idToComponent);
		let placements: FrameToolPlacement[] = [];
		const originalTuiRender = typeof this.render === "function" ? this.render : null;
		let tuiRenderDescriptor: PropertyDescriptor | undefined;
		let sawTuiRender = false;
		if (originalTuiRender) {
			const wrappedTuiRender = function (this: any, ...renderArgs: any[]) {
				const lines = Reflect.apply(originalTuiRender, this, renderArgs);
				if (!Array.isArray(lines)) return lines;
				sawTuiRender = true;
				const extracted = extractToolFramePlacements(
					lines.map((line) => String(line)),
					idToComponent,
					frame.idToView,
				);
				placements = extracted.placements;
				return extracted.lines;
			};
			tuiRenderDescriptor = defineRenderOverride(this, wrappedTuiRender);
		}
		let succeeded = false;
		const previousFrame = getActiveIoViewFrame();
		setActiveIoViewFrame(frame);
		try {
			const result = Reflect.apply(original, this, args);
			succeeded = true;
			// Test harnesses may paint via doRender without tui.render; recover markers there.
			if (!sawTuiRender && Array.isArray(this.previousLines)) {
				const extracted = extractToolFramePlacements(
					this.previousLines.map((line: unknown) => String(line)),
					idToComponent,
					frame.idToView,
				);
				this.previousLines = extracted.lines;
				placements = extracted.placements;
			}
			if (toolMouseInteractionActive()) toolMouseRawWrite?.(TOOL_MOUSE_MOTION_ENABLE);
			return result;
		} finally {
			setActiveIoViewFrame(previousFrame);
			if (originalTuiRender) restoreRenderOverride(this, tuiRenderDescriptor);
			for (const { target, descriptor } of restores.reverse()) {
				restoreRenderOverride(target, descriptor);
			}
			if (succeeded) {
				latestInteractionFrame = buildInteractionFrame(this, renderedTools, placements);
			}
		}
	};
	try {
		tui.doRender = wrapper;
	} catch {
		toolMouseRawWrite = null;
		return;
	}
	toolMouseRenderPatchTui = tui;
	toolMouseRenderPatchOriginal = original;
	toolMouseRenderPatchWrapper = wrapper;
	toolMouseRenderPatchState = patchState;
	if (toolMouseInteractionActive()) toolMouseRawWrite?.(TOOL_MOUSE_MOTION_ENABLE);
}

function handleToolMouseInput(data: string): { consume: true } | undefined {
	if (!getToolMouseTui()) return undefined;
	// Lazy Proxy fullscreen: the mouse is consumed by the handleViewportInput wrapper (before the official chain),
	// so only the keyboard is handled here (mouse events are already consumed by the official listener and never reach this point).
	if (fullscreenLazyTui(getToolMouseTui())) {
		scheduleScrollButtonSync(getToolMouseTui(), data);
		if (isScrollBottomInput(data)) {
			getToolMouseTui().scrollToBottom?.();
			hideScrollButton(getToolMouseTui());
			return { consume: true };
		}
		return undefined;
	}
	updateScrollButtonFromInput(getToolMouseTui(), data);
	// Off mode restores native input: wheel keeps scrolling through Pi's normal
	// dispatcher, while hover/click affordances are entirely inactive.
	if (!toolMouseInteractionActive()) return undefined;
	const packets = parseSgrMousePackets(data);
	if (!packets) {
		scheduleScrollButtonSync(getToolMouseTui(), data);
		return undefined;
	}

	let consumed = false;
	for (const packet of packets) {
		updateToolSummaryHover(getToolMouseTui(), packet);
		if (isSgrLeftRelease(packet)) {
			resolveCollapsePress(getToolMouseTui(), packet, { skipOfficialCards: false });
			continue;
		}
		if (!isSgrLeftPress(packet)) {
			// Drag or wheel with a key held: if the position changed it is no longer a click.
			if (!isSgrIdleMotion(packet)) clearPendingCollapsePressOnMove(packet);
			continue;
		}
		if (toggleToolAtMouseClick(getToolMouseTui(), packet)) {
			consumed = true;
		}
	}

	// Let scrolling, motion, release, and clicks outside tool results reach the
	// normal TUI input chain (including other extensions such as pi-zentui).
	scheduleScrollButtonSync(getToolMouseTui(), data);
	return consumed ? { consume: true } : undefined;
}

export function teardownToolMouseInteraction(
	owner: object = toolMouseInstallationOwner ?? DEFAULT_TOOL_MOUSE_OWNER,
): void {
	const current = patchRegistry.get<object>(TOOL_MOUSE_OWNER_KEY);
	if (current && current !== owner) return;
	if (sessionRenderTimer) {
		clearTimeout(sessionRenderTimer);
		sessionRenderTimer = null;
	}
	toolMouseInputUnsubscribe?.();
	toolMouseInputUnsubscribe = null;
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredToolIo(null, null);
	setHoveredCompactAssistant(null);
	releaseToolCardMouseGuard();
	clearPendingCollapsePress();
	suppressOfficialCardClickUntil = 0;
	try {
		if (isLazyProxyTui(getToolMouseTui())) releaseFullscreenToolMouseMotion(getToolMouseTui());
		else getToolMouseTui()?.terminal?.write?.(TOOL_MOUSE_DISABLE);
	} catch {
		// The terminal may already be closed during shutdown.
	}
	try {
		toolMouseUi?.setWidget?.(TOOL_MOUSE_WIDGET_KEY, undefined);
	} catch {
		// The UI context may already have been reset during /reload.
	}
	restoreToolMouseRenderPatch();
	restoreFullscreenViewportInput(getToolMouseTui());
	restoreOfficialScrollToEnd(getToolMouseTui());
	resetScrollButtonState();
	setToolMouseTui(null);
	toolMouseUi = null;
	patchRegistry.dispose(TOOL_MOUSE_OWNER_KEY, owner);
	if (toolMouseInstallationOwner === owner) toolMouseInstallationOwner = null;
}

/** Off-mode cleanup: clear hover and back-to-bottom button state (cross-module rebinds all go through this function). */
export function resetToolHoverState(): void {
	setHoveredToolCallId(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredCompactAssistant(null);
	setScrollButtonVisible(false);
	setScrollButtonHovered(false);
	restoreOfficialScrollToEnd(getToolMouseTui());
	releaseFullscreenToolMouseMotion(getToolMouseTui());
}

/**
 * Since pi 0.87 the tool card result area has its own MouseRegion, and any left click on the whole card calls setExpanded.
 * ccstyle's multi-line collapsed cards (rich diff) only allow the declared remainder row to expand;
 * clicks elsewhere are swallowed, so the official handler does not treat the diff body as an expand entry.
 * 0.84 and earlier have no handleMouse, so installation is skipped.
 */
const TOOL_CARD_MOUSE_GUARD_KEY = Symbol.for("pi.ccstyle.tool-card-mouse-guard");

type ToolCardMouseGuard = {
	prototype: any;
	original: (event: any) => any;
	wrapper: (event: any) => any;
};

/** Official click on an expanded card: any inner tool row of the same group collapses the whole group. */
function collapseExpandedCardFromOfficialClick(component: any): void {
	if (typeof component?.setExpanded !== "function") return;
	const group = component?.[TOOL_GROUPING_PARENT_KEY];
	collapseExpandedCard(getToolMouseTui(), group instanceof ToolGroupComponent ? group : component);
}

function installToolCardMouseGuard(): void {
	const prototype = (ToolExecutionComponent as any)?.prototype;
	if (typeof prototype?.handleMouse !== "function") return;
	const previous = (globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] as ToolCardMouseGuard | undefined;
	if (previous && previous.prototype === prototype && prototype.handleMouse === previous.wrapper)
		return;
	// Take the current value as downstream each time; it may be another extension's wrapper.
	const original = prototype.handleMouse;
	const wrapper = function (this: any, event: any) {
		if (event?.type === "click" && event.button === "left") {
			// The extension just collapsed its own card: this click belongs to the same single click, so swallow it to avoid flipping the inner tool back to expanded.
			if (suppressOfficialCardClickUntil && Date.now() <= suppressOfficialCardClickUntil) {
				suppressOfficialCardClickUntil = 0;
				if (this?.expanded) collapseExpandedCardFromOfficialClick(this);
				return { handled: true };
			}
			// Whole-card click on an expanded card: take over the official toggle and collapse instead (an inner tool row of a group collapses the whole group).
			if (this?.expanded && typeof this.setExpanded === "function") {
				collapseExpandedCardFromOfficialClick(this);
				return { handled: true };
			}
		}
		if (blocksOfficialCardToggle(this, event)) return { handled: true };
		return original.call(this, event);
	};
	prototype.handleMouse = wrapper;
	(globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] = { prototype, original, wrapper };
}

function releaseToolCardMouseGuard(): void {
	const guard = (globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] as ToolCardMouseGuard | undefined;
	if (!guard) return;
	if (guard.prototype?.handleMouse === guard.wrapper) guard.prototype.handleMouse = guard.original;
	(globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] = undefined;
}

export function installToolMouseInteraction(
	ctx: any,
	owner: object = DEFAULT_TOOL_MOUSE_OWNER,
): void {
	teardownToolMouseInteraction(toolMouseInstallationOwner ?? owner);
	if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
	if (typeof ctx.ui?.onTerminalInput !== "function" || typeof ctx.ui?.setWidget !== "function")
		return;

	toolMouseInstallationOwner = owner;
	patchRegistry.install(TOOL_MOUSE_OWNER_KEY, owner);
	installToolCardMouseGuard();
	setHoveredToolCallId(null);
	toolMouseUi = ctx.ui;
	// 0.84+ tui is a lazy Proxy: regular keeps native scrollback; fullscreen
	// is hit by the official LayoutFrame, and the extension adds the all-motion reporting hover needs.
	ctx.ui.setWidget(TOOL_MOUSE_WIDGET_KEY, (tui: any, theme: any) => {
		setToolMouseTui(tui);
		setToolTuiFullscreen(fullscreenLazyTui(tui));
		if (isLazyProxyTui(tui)) {
			patchFullscreenViewportInput(tui);
			ensureFullscreenToolMouseMotion(tui);
			syncOfficialScrollToEnd(tui);
			setScrollButtonWidget({
				render: (width: number) => {
					patchFullscreenViewportInput(tui);
					ensureFullscreenToolMouseMotion(tui);
					syncOfficialScrollToEnd(tui);
					return renderScrollButton(width, theme);
				},
				invalidate() {},
			});
			return getScrollButtonWidget();
		}
		// Wrap doRender to capture the live frame for tool click/hover mapping.
		patchToolMouseMotionAfterRender(tui);
		if (toolMouseInteractionActive()) tui?.terminal?.write?.(TOOL_MOUSE_MOTION_ENABLE);
		const widget = {
			render: (width: number) => renderScrollButton(width, theme),
			invalidate() {},
		};
		setScrollButtonWidget(widget);
		return widget;
	});
	toolMouseInputUnsubscribe = ctx.ui.onTerminalInput(handleToolMouseInput);
}

function refreshToolRendererComponents(tui: any): void {
	const tools: any[] = [];
	collectToolComponents(tui, tools);
	for (const tool of tools) tool.invalidate?.();
}

export function scheduleSessionRender(refresh?: () => void): void {
	const tui = getToolMouseTui();
	if (!tui || typeof tui.requestRender !== "function") return;
	if (sessionRenderTimer) clearTimeout(sessionRenderTimer);
	// Restored transcripts are populated at different points for startup, reload,
	// and session replacement. Repaint after session_start and the surrounding UI
	// rebuild finish so messages are not left hidden until the next terminal input.
	sessionRenderTimer = setTimeout(() => {
		sessionRenderTimer = null;
		if (getToolMouseTui() !== tui) return;
		patchToolMouseMotionAfterRender(tui);
		refreshToolRendererComponents(tui);
		refresh?.();
		tui.requestRender(true);
	}, 0);
}
