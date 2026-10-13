import { humanizeToolLabel } from "./names.ts";

/**
 * MCP tool detection and titles, shared by single cards (default-mode) and group rows/headers (grouping).
 *
 * - Detection: tool name contains an mcp segment (`mcp` gateway, `mcpScript`, `mcp__<server>`), or the label the adapter
 *   registered starts with `MCP:`. In default/none/short prefix modes, direct tool names have no mcp segment
 *   (`github_search_code`, `search_code`), so only the label can identify them.
 * - Title: concrete tools use the real tool name exposed by the adapter, without reformatting; only the `mcp` / `mcpScript`
 *   entry points lack a concrete tool name and are humanized like normal tools (MCP / MCP Script).
 * - Arg summary shares toolCallSummary's field chain with other tools; the gateway additionally puts `args.tool` after the title.
 */

/** Identification info for a single MCP call. */
export type McpToolCall = {
	toolName: string;
	/** Tool definition; default/none/short prefix modes rely on its label; may be missing during session replay. */
	definition?: any;
};

const GATEWAY_TOOL_NAME = "mcp";
const SCRIPT_TOOL_NAME = "mcpScript";

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (toolName === GATEWAY_TOOL_NAME || toolName === SCRIPT_TOOL_NAME) return true;
	return /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName);
}

/** Title: returns the title for MCP tools (entry points humanized, others use the real tool name); undefined for non-MCP. */
export function mcpToolTitle(call: McpToolCall): string | undefined {
	const { toolName } = call;
	if (!isMcpToolDefinition(call.definition, toolName)) return undefined;
	if (toolName === GATEWAY_TOOL_NAME || toolName === SCRIPT_TOOL_NAME) {
		return humanizeToolLabel(toolName);
	}
	return toolName;
}
