import type { ExpandedToolIoView, ToolIoSection } from "../tool/result.ts";
import { walkComponentTree } from "../../utils/component-tree.ts";
export {
	stripTerminalSequences,
	stripTerminalSequencesPreservingLayout,
} from "../../utils/ansi-text.ts";
export {
	parseSgrMousePackets,
	isSgrLeftPress,
	isSgrLeftRelease,
	isSgrIdleMotion,
	type SgrMousePacket,
} from "../../utils/sgr-mouse.ts";

/** Final painted placement of one outermost tool/group row after parent layout. */
export type FrameToolPlacement = {
	component: any;
	componentRow: number;
	lineIndex: number;
	/** Marker-stripped final line text as painted after parent layout. */
	finalLine: string;
	view?: ExpandedToolIoView;
	section?: ToolIoSection;
};

/** Zero-width APC row marker (like pi CURSOR_MARKER); stripped before terminal output. */
const TOOL_FRAME_MARKER_RE = /\x1b_cc:t(\d+):(\d+)\x07/g;
const TOOL_VIEW_MARKER_RE = /\x1b_cc:v(\d+):([io])\x07/g;
export const toolFrameMarker = (id: number, row: number) => `\x1b_cc:t${id}:${row}\x07`;

/** Recognizes a tool execution component (toolCallId + setExpanded + render). */
export function isToolExecutionComponent(value: any): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof value.toolCallId === "string" &&
			typeof value.setExpanded === "function" &&
			typeof value.render === "function",
	);
}

/** Deeply collects tool execution components in the component tree (including the getMountedRoots branch). */
export function collectToolComponents(component: any, tools: any[]): void {
	walkComponentTree(component, (value: any) => {
		if (isToolExecutionComponent(value)) {
			tools.push(value);
			return false;
		}
	});
}

/** Strips zero-width frame/view markers from a line. */
export function stripToolFrameMarkers(line: string): string {
	return line.replace(TOOL_FRAME_MARKER_RE, "").replace(TOOL_VIEW_MARKER_RE, "");
}

/**
 * Extracts the tool frame placement from a rendered line (component/componentRow/lineIndex/finalLine
 * plus its owning view and section), and also returns the line with markers stripped.
 */
export function extractToolFramePlacements(
	lines: string[],
	idToComponent: Map<number, any>,
	idToView: Map<number, ExpandedToolIoView>,
): { lines: string[]; placements: FrameToolPlacement[] } {
	const placements: FrameToolPlacement[] = [];
	const cleaned = lines.map((line, lineIndex) => {
		const toolMatches = [...line.matchAll(TOOL_FRAME_MARKER_RE)];
		const viewMatches = [...line.matchAll(TOOL_VIEW_MARKER_RE)];
		const finalLine = stripToolFrameMarkers(line);
		let view: ExpandedToolIoView | undefined;
		let section: ToolIoSection | undefined;
		for (const match of viewMatches) {
			const candidate = idToView.get(Number(match[1]));
			if (!candidate) continue;
			view = candidate;
			section = match[2] === "i" ? "input" : "output";
			break;
		}
		for (const match of toolMatches) {
			const component = idToComponent.get(Number(match[1]));
			if (!component) continue;
			placements.push({
				component,
				componentRow: Number(match[2]),
				lineIndex,
				finalLine,
				view,
				section,
			});
		}
		return finalLine;
	});
	return { lines: cleaned, placements };
}
