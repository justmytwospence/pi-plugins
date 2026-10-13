import { posix, win32 } from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { oneLine } from "../../utils/format.ts";
import { headTruncateToWidth } from "./result.ts";

/** With inputClip=0 there is no character cap; truncation is left to the actual width at render time. */
function clipLimit(): number {
	return config.inputClip > 0 ? config.inputClip : Number.POSITIVE_INFINITY;
}

function clip(value: unknown): string {
	return oneLine(value, clipLimit());
}

/** Payload (input JSON / script code) is shown only if at least this much width remains, otherwise omitted entirely (avoids a lone " {…"). */
const MIN_PAYLOAD_WIDTH = 10;

/** Fixed brand capitalization; tool names humanize cannot derive go here. */
const TOOL_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
	powershell: "PowerShell",
	// The two MCP entry points have no specific tool name and are humanized like normal tools; acronyms stay uppercase
	mcp: "MCP",
	mcpscript: "MCP Script",
};

/**
 * Humanize tool names/labels: default-mode's humanizeToolLabel and grouping's humanizeToolName
 * were character-for-character identical, so they are merged into one shared implementation.
 */
export function humanizeToolLabel(label: string): string {
	const brand = TOOL_LABEL_OVERRIDES[label.toLowerCase()];
	if (brand) return brand;
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

const AGENT_FAMILY_TOOL_NAMES = new Set([
	"Agent",
	"Agents",
	"get_subagent_result",
	"steer_subagent",
]);

/** default-mode (single tool card) and grouping (group card) differ in agent/bash/grep/find/read/fallback wording. */
export type ToolCallSummaryVariant = "default" | "grouping";

export type ToolCallSummaryOptions = {
	/** Resolved title; defaults to humanizeToolLabel(toolName). */
	title?: string;
	/** Wording variant; defaults to "default". */
	variant?: ToolCallSummaryVariant;
	/** Tool working directory; only used to build display paths, never modifies call args. */
	cwd?: string;
};

export type ToolCallSummary = {
	main: string;
	detail: string;
	/** Path summary keeps its structure so final rendering can prioritize the file name at actual width. */
	path?: { prefix: string; value: string };
	/** Raw payload beyond the title (full input JSON, script code…), collapsed to one line, rendered dim after the title. */
	payload?: string;
};

function pathApi(value: string) {
	if (posix.isAbsolute(value)) return posix;
	if (win32.isAbsolute(value)) return win32;
	return undefined;
}

/** Convert absolute paths inside cwd to relative; paths outside cwd stay unchanged. */
export function displayPath(value: unknown, cwd?: string): string {
	const text = oneLine(value, 4096);
	const base = cwd ? oneLine(cwd, 4096) : "";
	const api = pathApi(text);
	if (!api || !base || !api.isAbsolute(base)) return text;
	const relative = api.relative(base, text);
	if (!relative) return api.basename(text) || ".";
	if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
		return text;
	}
	return relative;
}

function headToWidth(text: string, width: number, ellipsis = ""): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
	const contentWidth = width - visibleWidth(suffix);
	let head = "";
	for (const char of Array.from(text)) {
		if (visibleWidth(head + char) > contentWidth) break;
		head += char;
	}
	return head + suffix;
}

function tailToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let tail = "";
	for (const char of Array.from(text).reverse()) {
		if (visibleWidth(char + tail) > width) break;
		tail = char + tail;
	}
	return tail;
}

/** Middle-truncate a path: keep the directory start, prefer keeping the file name intact at the end. */
export function truncatePathToWidth(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	if (width <= 1) return width === 1 ? "…" : "";
	const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const filename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	const filenameWidth = visibleWidth(filename);
	if (separatorIndex >= 0 && filenameWidth + 1 <= width) {
		const separator = path[separatorIndex]!;
		const suffix = `${separator}${filename}`;
		const prefixWidth = width - visibleWidth(suffix) - 1;
		const prefix = headToWidth(path.slice(0, separatorIndex), Math.max(0, prefixWidth));
		return `${prefix}…${prefix ? suffix : filename}`;
	}
	const leftWidth = Math.max(1, Math.floor((width - 1) * 0.45));
	const rightWidth = Math.max(0, width - leftWidth - 1);
	return `${headToWidth(filename, leftWidth)}…${tailToWidth(filename, rightWidth)}`;
}

/** Single entry point for path display: relativize, then truncate per config and available width. */
export function formatDisplayPath(value: unknown, cwd: string | undefined, width: number): string {
	return truncatePathToWidth(displayPath(value, cwd), Math.min(width, clipLimit()));
}

/** Render the summary at final terminal width; path summaries are no longer cut by whole-line head truncation. */
export function fitToolCallSummary(summary: ToolCallSummary, width: number): string {
	if (!summary.path) return headToWidth(summary.main, width, "…");
	const prefix = summary.path.prefix;
	const pathWidth = Math.max(0, width - visibleWidth(prefix) - 1);
	if (pathWidth <= 0) return headToWidth(prefix, width, "…");
	return `${prefix} ${truncatePathToWidth(summary.path.value, Math.min(pathWidth, clipLimit()))}`;
}

function pathSummary(
	prefix: string,
	value: unknown,
	cwd: string | undefined,
	detail = "",
): ToolCallSummary {
	const path = displayPath(value, cwd);
	return {
		main: `${prefix} ${truncatePathToWidth(path, clipLimit())}`,
		detail,
		path: { prefix, value: path },
	};
}

/** Tools whose input is a shell command. */
const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "pwsh", "sh", "zsh", "cmd"]);

/** Built-in search tools: keep the "…" placeholder when pattern is missing (invalid call). */
const SEARCH_TOOL_NAMES = new Set(["grep", "find"]);

/**
 * Generic summary field priority: default and grouping share the same lookup chain.
 * They used to be maintained separately, so grouping missed command (powershell) and array-typed args;
 * paths are not on the chain; pathSummary handles them so they can be cwd-relativized and middle-truncated.
 */
const GENERIC_SUMMARY_FIELDS = [
	"agent_id",
	"command",
	"query",
	"queries",
	"claim",
	"question",
	"questions",
	"url",
	"urls",
	"responseId",
	"findText",
	"name",
	"tool_use_id",
	"toolCallId",
	"id",
	"subject",
	"taskId",
	"task_id",
	"message",
	"description",
	"prompt",
] as const;

/** Generic field-chain value: strings used directly; arrays take the first displayable item and note the remaining count. */
type SummaryValue = { text: string; more: number };

function arrayItemText(item: unknown): string | undefined {
	if (typeof item === "string" && item) return item;
	if (!item || typeof item !== "object") return undefined;
	for (const key of ["query", "url", "question", "header", "name"] as const) {
		const text = (item as Record<string, unknown>)[key];
		if (typeof text === "string" && text) return text;
	}
	return undefined;
}

function summaryFieldValue(value: unknown): SummaryValue | undefined {
	if (typeof value === "string" && value) return { text: value, more: 0 };
	if (!Array.isArray(value)) return undefined;
	let first: string | undefined;
	let count = 0;
	for (const item of value) {
		const text = arrayItemText(item);
		if (!text) continue;
		count += 1;
		first ??= text;
	}
	return first === undefined ? undefined : { text: first, more: count - 1 };
}

/** Generic field-chain value; returns undefined when no field is usable, letting the caller fall back further. */
function genericSummary(title: string, args: any): ToolCallSummary | undefined {
	for (const key of GENERIC_SUMMARY_FIELDS) {
		const found = summaryFieldValue(args[key]);
		if (!found) continue;
		// (+N) is appended after truncation so an overly long first element doesn't squeeze out the count
		const more = found.more > 0 ? ` (+${found.more})` : "";
		return { main: `${title} ${clip(found.text)}${more}`, detail: "" };
	}
	return undefined;
}

/**
 * Single tool call summary ({ main, detail }).
 *
 * Both variants share the same lookup chain; only named branches like read/agent/skill/task differ where necessary.
 */
export function toolCallSummary(
	toolName: string,
	args: any,
	opts: ToolCallSummaryOptions = {},
): ToolCallSummary {
	const title = opts.title ?? humanizeToolLabel(toolName);
	const variant = opts.variant ?? "default";
	if (!args || typeof args !== "object") return { main: title, detail: "" };
	const name = toolName.toLowerCase();

	// MCP entry points follow mcp-adapter's own title style (the adapter's formatMcpProxyToolCallLines):
	// `MCP <action> <target>` / `MCP Script <code>`, more readable than dumping all args as JSON
	if (name === "mcp") {
		const gateway = mcpGatewaySummary(title, args);
		if (gateway) return gateway;
	}
	if (name === "mcpscript") {
		const code = typeof args.code === "string" && args.code ? clip(args.code) : "";
		return code ? { main: title, detail: "", payload: code } : { main: title, detail: "" };
	}
	// Built-in codemode: the title reports only the tool name. Scripts are long; cramming them into the row is crowded and unreadable;
	// expand Input to see the code, and the sub-call rows to see what ran.
	if (name === "codemode") return { main: title, detail: "" };

	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return `${title} ${clip(found || fallback)}`;
	};

	if (variant === "default" && AGENT_FAMILY_TOOL_NAMES.has(toolName) && args.agent_id) {
		return { main: `${title} ${clip(args.agent_id)}`, detail: "" };
	}
	if (variant === "grouping" && (name === "agent" || name === "agents")) {
		const displayName = args.subagent_type ?? args.agent_type ?? args.agent;
		if (typeof displayName === "string" && displayName) {
			return { main: `${title} ${displayName}`, detail: "" };
		}
		return {
			main: value(name === "agent" ? "launch agent" : "launch agents", "description", "prompt"),
			detail: "",
		};
	}
	if (variant === "grouping" && (name === "get_subagent_result" || name === "steer_subagent")) {
		return {
			main: value(name === "get_subagent_result" ? "agent result" : "steer agent", "agent_id"),
			detail: "",
		};
	}
	if (variant === "default" && name === "agents") {
		return { main: value("launch agents", "description", "prompt"), detail: "" };
	}
	if (name === "skill") return { main: value("run skill", "name"), detail: "" };
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: `${title} enable read-only planning`, detail: "" };
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: `${title} present plan`, detail: "" };
	}
	if (name === "taskcreate") return { main: value("create task", "subject"), detail: "" };
	if (name === "tasklist") return { main: `${title} task list`, detail: "" };
	if (name === "taskget" || name === "taskupdate") {
		return { main: value("task", "taskId", "task_id"), detail: "" };
	}
	if (name === "taskoutput" || name === "taskstop") {
		return { main: value("background task", "task_id", "taskId"), detail: "" };
	}
	if (name === "taskexecute") {
		const ids = Array.isArray(args.task_ids)
			? args.task_ids
			: Array.isArray(args.taskIds)
				? args.taskIds
				: [];
		const summary = ids.length
			? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}`
			: "start tasks";
		return { main: `${title} ${summary}`, detail: "" };
	}
	if (toolName === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		const detail = details.length ? ` (${details.join(", ")})` : "";
		if (typeof args.path === "string" && args.path) {
			return pathSummary(variant === "grouping" ? "Read" : title, args.path, opts.cwd, detail);
		}
		return {
			main: variant === "grouping" ? "Read ..." : title,
			detail,
		};
	}
	if (variant === "grouping" && SHELL_TOOL_NAMES.has(name)) {
		// Group rows keep a placeholder when command is missing, so they don't end up with just a title like single tool cards
		return { main: value("...", "command"), detail: "" };
	}

	// Search tools: pattern is the body, path is just the scope; both variants use the same format
	if (typeof args.pattern === "string" || SEARCH_TOOL_NAMES.has(name)) {
		const pattern = clip(args.pattern || "...");
		const scope = typeof args.path === "string" && args.path ? ` in ${clip(args.path)}` : "";
		return { main: `${title} ${JSON.stringify(pattern)}${scope}`, detail: "" };
	}

	const generic = genericSummary(title, args);
	if (generic) return generic;

	const preferredPath = args.path ?? args.file_path;
	if (typeof preferredPath === "string" && preferredPath) {
		return pathSummary(title, preferredPath, opts.cwd);
	}

	// Args the field chain can't recognize (namespace proxy tool+args, third-party custom keys…) expand to the full input JSON
	// instead of leaving just a title; gateway and script specific shapes are handled above
	const payload = jsonArgs(args);
	return payload ? { main: title, detail: "", payload } : { main: title, detail: "" };
}

/**
 * MCP gateway annotation `mcp <action> <target>`: action and target copied from mcp-adapter's formatMcpProxyToolCallLines,
 * faster to read than arg JSON; `instructions` is a case the adapter itself misses (it falls through to mcp status there).
 * Unrecognized args return undefined, deferring to the generic JSON fallback rather than guessing status.
 */
function mcpGatewaySummary(title: string, args: any): ToolCallSummary | undefined {
	const text = (value: unknown) => (typeof value === "string" && value ? value : "");
	const tool = text(args.tool);
	const connect = text(args.connect);
	const describe = text(args.describe);
	const instructions = text(args.instructions);
	const search = text(args.search);
	const server = text(args.server);
	const action = text(args.action);
	const scoped = (target: string) => (server ? `${target} @ ${server}` : target);

	if (action === "ui-messages") return { main: `${title} ${action}`, detail: "" };
	if (tool) {
		const main = `${title} call ${scoped(tool)}`;
		const payload = innerArgsPayload(args.args);
		return payload ? { main, detail: "", payload } : { main, detail: "" };
	}
	if (connect) return { main: `${title} connect ${connect}`, detail: "" };
	if (describe) return { main: `${title} describe ${scoped(describe)}`, detail: "" };
	if (instructions) return { main: `${title} instructions ${instructions}`, detail: "" };
	if (search) {
		const flags = [
			args.regex === true ? "regex" : "",
			args.includeSchemas === false ? "schemas hidden" : "",
		].filter(Boolean);
		return {
			main: `${title} search ${scoped(search)}`,
			detail: flags.length ? ` (${flags.join(", ")})` : "",
		};
	}
	if (server) return { main: `${title} list ${server}`, detail: "" };
	if (action) return { main: `${title} ${action}`, detail: "" };
	if (Object.keys(args).length === 0) return { main: `${title} status`, detail: "" };
	return undefined;
}

/** Inner tool args for a gateway call: objects become single-line JSON; the gateway accepts JSON strings, which are used as-is without re-escaping. */
function innerArgsPayload(value: unknown): string {
	if (typeof value === "string") return value ? clip(value) : "";
	if (!value || typeof value !== "object") return "";
	return jsonArgs(value);
}

/** Serialize args to single-line JSON; returns "" for empty or unserializable objects. */
function jsonArgs(args: any): string {
	try {
		const json = JSON.stringify(args);
		return json && json !== "{}" ? clip(json) : "";
	} catch {
		return "";
	}
}

/**
 * Title line content: title uses the caller's toolTitle color, the raw payload (input JSON / script code) uses dim separately.
 * The title takes width first (it is the identity), the rest goes to the payload; an overwide payload is elided at the tail, and
 * when even MIN_PAYLOAD_WIDTH doesn't fit, it is omitted entirely.
 */
export function renderToolSummary(
	summary: ToolCallSummary,
	width: number,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const title = fitToolCallSummary(summary, width);
	if (!summary.payload) return fg("toolTitle", title);
	const room = width - visibleWidth(title);
	return room >= MIN_PAYLOAD_WIDTH
		? `${fg("toolTitle", title)}${fg("dim", headTruncateToWidth(` ${summary.payload}`, room))}`
		: fg("toolTitle", title);
}
