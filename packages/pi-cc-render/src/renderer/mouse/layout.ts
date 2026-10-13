import { visibleWidth } from "@earendil-works/pi-tui";
import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import { isCompactAssistantComponent } from "../compact-mode.ts";
import { ToolGroupComponent } from "../tool/grouping.ts";
import { isMessageDisplayComponent } from "../tool/message-display.ts";
import { isToolExecutionComponent, stripTerminalSequencesPreservingLayout } from "./packets.ts";
import { getScrollButtonWidget } from "./scroll.ts";

export type ComponentRowHit = {
	component: any;
	row: number;
	/** The expanded group owning an inner tool hit; clicking a plain card still collapses the whole group. */
	group?: ToolGroupComponent;
	/** Hit inside a compact expanded panel: the outer panel, which a click outside the hint area collapses. */
	owner?: any;
};

/** Hit column range (1-based, inclusive) of the inline [click to show more] / [↑ Collapse] hint. */
export function collapsedHintHitbox(line: string): { startCol: number; endCol: number } | null {
	const plain = stripTerminalSequencesPreservingLayout(line);
	const match =
		/(\([^()\n]* \/ click\)|click to show more|to show more|↑ Collapse|to collapse)(?=\)?\s*$)/.exec(
			plain,
		);
	if (!match?.[1]) return null;
	const startCol = visibleWidth(plain.slice(0, match.index)) + 1;
	return { startCol, endCol: startCol + visibleWidth(match[1]) - 1 };
}

/** Layout tree point query: returns the deepest leaf box containing line (x,y) (screen row -> component-local row). */
export function fullscreenLeafAt(
	layout: any,
	x: number,
	y: number,
): { box: any; localRow: number } | null {
	const root = layout?.root;
	if (!root) return null;
	let best: { box: any; localRow: number } | null = null;
	let bestDepth = -1;
	const visit = (box: any, depth: number) => {
		if (!box) return;
		const clip = box.clip;
		if (!clip || x < clip.x || x >= clip.x + clip.width || y < clip.y || y >= clip.y + clip.height)
			return;
		const isLeaf = !Array.isArray(box.children) || box.children.length === 0;
		if (
			isLeaf &&
			y >= box.rect.y &&
			y < box.rect.y + Math.max(1, box.rect.height) &&
			depth > bestDepth
		) {
			best = { box, localRow: Math.max(0, y - box.rect.y) };
			bestDepth = depth;
		}
		for (const child of box.children ?? []) visit(child, depth + 1);
	};
	visit(root, 0);
	return best;
}

/** A leaf has no scrollView of its own; content width is determined by the nearest scroll ancestor. */
export function fullscreenContentWidth(box: any, terminalWidth: number): number {
	for (let current = box; current; current = current.parent) {
		if (typeof current.scrollView?.getContentWidth === "function") {
			return Math.max(1, current.scrollView.getContentWidth(terminalWidth));
		}
	}
	return terminalWidth;
}

/** Whether the clicked column is the host scrollbar column (lets host dragging through). */
export function isScrollbarColumnAt(layout: any, x: number): boolean {
	let hit = false;
	const visit = (box: any) => {
		if (hit || !box) return;
		if (box.scrollView?.isScrollbarVisible && x === box.rect.x + box.rect.width - 1) {
			hit = true;
			return;
		}
		for (const child of box.children ?? []) visit(child);
	};
	visit(layout?.root);
	return hit;
}

/** A compact expanded card maps thinking via childAtRow; otherwise descend by render line counts. */
function nestedChildAtRow(node: any, localRow: number, width: number): any {
	if (typeof node?.childAtRow === "function") {
		return node.childAtRow(localRow, width);
	}
	if (!Array.isArray(node?.children)) return null;
	let offset = 0;
	for (const child of node.children) {
		let count = 0;
		try {
			const rendered = child.render?.(width);
			if (Array.isArray(rendered)) count = rendered.length;
		} catch {
			count = 0;
		}
		if (localRow < offset + count) {
			return nestedChildAtRow(child, localRow - offset, width);
		}
		offset += count;
	}
	return null;
}

/**
 * The component of a layout leaf box is usually a container (documentContainer/dock container etc.), with tool cards and
 * widgets inside its children. Walks the component tree by local row to locate the child component actually hit.
 */
export function componentAtLocalRow(
	component: any,
	localRow: number,
	width: number,
): ComponentRowHit | null {
	if (component instanceof ToolGroupComponent) {
		// Expanded group: the first two lines (blank line + header line) belong to the group, the remaining lines map to the inner tools.
		const child = component.childAtRow(localRow, width);
		return child ? { ...child, group: component } : { component, row: localRow };
	}
	if (isToolExecutionComponent(component)) {
		return { component, row: localRow };
	}
	if (isCompactAssistantComponent(component)) {
		// Collapsed: the whole line is the summary. Expanded: first hit thinking/tool cards/text inside the panel; the rest (blank lines) still belong to the outer card.
		if (component.expanded === true) {
			const inner = nestedChildAtRow(component, localRow, width);
			if (inner) {
				// An expanded thinking has its own expanded state: clicking it collapses only itself, not the whole panel.
				const ownExpandable = inner instanceof ThinkingPreviewBlock && inner.expanded === true;
				return ownExpandable
					? { component: inner, row: localRow }
					: { component: inner, row: localRow, owner: component };
			}
		}
		return { component, row: localRow };
	}
	if (component instanceof ThinkingPreviewBlock) {
		return { component, row: localRow };
	}
	if (isMessageDisplayComponent(component)) {
		return { component, row: localRow };
	}
	if (component === getScrollButtonWidget()) {
		return { component, row: localRow };
	}
	if (!Array.isArray(component.children)) return null;
	let offset = 0;
	for (const child of component.children) {
		let lines: string[] = [];
		try {
			const rendered = child.render?.(width);
			if (Array.isArray(rendered)) lines = rendered.map((line) => String(line));
		} catch {
			lines = [];
		}
		if (localRow < offset + lines.length) {
			return (
				componentAtLocalRow(child, localRow - offset, width) ?? {
					component: child,
					row: localRow - offset,
				}
			);
		}
		offset += lines.length;
	}
	return null;
}

/** Fullscreen single-expand: the group acts as a whole; do not recurse into its inner tools. */
export function collectFullscreenToolCards(
	component: any,
	out: any[],
	seen = new Set<any>(),
): void {
	if (!component || typeof component !== "object" || seen.has(component)) return;
	seen.add(component);
	if (
		isToolExecutionComponent(component) ||
		component instanceof ToolGroupComponent ||
		isCompactAssistantComponent(component) ||
		component instanceof ThinkingPreviewBlock ||
		isMessageDisplayComponent(component)
	) {
		out.push(component);
		return;
	}
	if (!Array.isArray(component.children)) return;
	for (const child of component.children) collectFullscreenToolCards(child, out, seen);
}
