import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import { setHoveredCompactAssistant } from "../compact-mode.ts";
import { patchRegistry, TOOL_HOVER_STATE_KEY } from "../../utils/patch-keys.ts";
import {
	isExpandedToolIoView,
	invalidateIoView,
	type ExpandedToolIoView,
	type ToolIoSection,
} from "../tool/result.ts";
import type { ToolGroupComponent } from "../tool/grouping.ts";
import { componentAtLocalRow, type ComponentRowHit } from "./layout.ts";
import { setScrollButtonHovered } from "./scroll.ts";

type SharedToolHoverState = { toolCallId: string | null };

/**
 * Hover state host (Symbol.for + globalThis): old and new instances share it after a module reload;
 * tests depend on this cross-instance semantics.
 */
export function sharedToolHoverState(): SharedToolHoverState {
	return patchRegistry.ensure(TOOL_HOVER_STATE_KEY, () => ({ toolCallId: null }));
}

export function setHoveredToolCallId(toolCallId: string | null): void {
	sharedToolHoverState().toolCallId = toolCallId;
}

export function isToolCallHovered(toolCallId: string | null | undefined): boolean {
	return Boolean(toolCallId && sharedToolHoverState().toolCallId === toolCallId);
}

let hoveredToolGroup: ToolGroupComponent | null = null;

export function setHoveredToolGroup(group: ToolGroupComponent | null): boolean {
	if (group === hoveredToolGroup) return false;
	hoveredToolGroup?.setHintHovered(false);
	hoveredToolGroup = group;
	group?.setHintHovered(true);
	return true;
}

let hoveredThinking: ThinkingPreviewBlock | null = null;

export function setHoveredThinking(block: ThinkingPreviewBlock | null): boolean {
	if (block === hoveredThinking) return false;
	hoveredThinking?.setHintHovered(false);
	hoveredThinking = block;
	block?.setHintHovered(true);
	return true;
}

let hoveredMessageDisplay: any = null;

export function setHoveredMessageDisplay(component: any): boolean {
	if (component === hoveredMessageDisplay) return false;
	hoveredMessageDisplay?.setHintHovered?.(false);
	hoveredMessageDisplay = component;
	component?.setHintHovered?.(true);
	return true;
}

let hoveredToolIoView: ExpandedToolIoView | null = null;
let hoveredToolIoSection: ToolIoSection | null = null;

export function setHoveredToolIo(
	view: ExpandedToolIoView | null,
	section: ToolIoSection | null,
): boolean {
	// resultRendererComponent may be Text/a third-party renderer; stale old instances may also remain after reload.
	const nextView = isExpandedToolIoView(view) ? view : null;
	const nextSection = nextView ? section : null;
	if (nextView === hoveredToolIoView && nextSection === hoveredToolIoSection) return false;
	if (isExpandedToolIoView(hoveredToolIoView)) {
		hoveredToolIoView.setHoveredSection(null);
		invalidateIoView(hoveredToolIoView);
	}
	hoveredToolIoView = nextView;
	hoveredToolIoSection = nextSection;
	if (nextView) {
		nextView.setHoveredSection(nextSection);
		invalidateIoView(nextView);
	}
	return true;
}

/** Hover and click share component lookup; under the same layout, cached by container/width/row to avoid repeated rendering on motion. */
let fullscreenHoverCacheLayout: unknown = null;
let fullscreenHoverComponentCache = new WeakMap<object, Map<string, ComponentRowHit | null>>();

export function cachedFullscreenComponentAtRow(
	layout: any,
	container: any,
	row: number,
	width: number,
): ComponentRowHit | null {
	if (!container || typeof container !== "object") return null;
	if (fullscreenHoverCacheLayout !== layout) {
		fullscreenHoverCacheLayout = layout;
		fullscreenHoverComponentCache = new WeakMap();
	}
	let rows = fullscreenHoverComponentCache.get(container);
	if (!rows) {
		rows = new Map();
		fullscreenHoverComponentCache.set(container, rows);
	}
	const key = `${width}:${row}`;
	if (rows.has(key)) return rows.get(key) ?? null;
	const hit = componentAtLocalRow(container, row, width);
	rows.set(key, hit);
	return hit;
}

/** Fullscreen mouse hover target. */
export type FullscreenHoverTarget =
	| { kind: "button" }
	| { kind: "group"; component: ToolGroupComponent }
	| { kind: "thinking"; component: ThinkingPreviewBlock }
	| { kind: "message"; component: any }
	| { kind: "assistant"; component: any }
	| {
			kind: "tool";
			component: any;
			view: ExpandedToolIoView | null;
			section: ToolIoSection | null;
	  };

/** Render only when the hover state changes (motion events are dense; skip when the state is unchanged). */
export function applyFullscreenHover(tui: any, target: FullscreenHoverTarget | null): void {
	let changed = false;
	const nextCallId =
		target?.kind === "tool" && !target.component.expanded
			? (target.component.toolCallId ?? null)
			: null;
	if (nextCallId !== sharedToolHoverState().toolCallId) {
		setHoveredToolCallId(nextCallId);
		changed = true;
	}
	const nextGroup = target?.kind === "group" ? target.component : null;
	if (setHoveredToolGroup(nextGroup)) changed = true;
	const nextThinking = target?.kind === "thinking" ? target.component : null;
	if (setHoveredThinking(nextThinking)) changed = true;
	const nextMessage = target?.kind === "message" ? target.component : null;
	if (setHoveredMessageDisplay(nextMessage)) changed = true;
	const nextAssistant = target?.kind === "assistant" ? target.component : null;
	if (setHoveredCompactAssistant(nextAssistant)) changed = true;
	const nextView = target?.kind === "tool" ? target.view : null;
	const nextSection = target?.kind === "tool" ? target.section : null;
	if (setHoveredToolIo(nextView, nextSection)) changed = true;
	const nextButton = target?.kind === "button";
	if (setScrollButtonHovered(nextButton)) changed = true;
	if (changed) tui.requestRender?.();
}
