/**
 * codemode result rendering: collapsed state lays out sub-calls as a tree like a tool group, ending the last line with └.
 *
 * Data comes from `result.details.calls` (CodemodeNestedCall[], also present in partial updates), so sub-call
 * progress is visible while running. Two gotchas:
 *
 * - Sub-calls never get their own rows: pi skips tool_execution_start with `parentToolCallId`, so progress can only be shown here.
 * - Output starts with "Script completed\nWall time …\nOutput:\n" (pi natively strips it too); line counts and expanded body must drop it,
 *   otherwise the collapsed summary overcounts by 3 lines.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { mcpToolTitle } from "./mcp-title.ts";
import {
	type ToolCallSummary,
	humanizeToolLabel,
	renderToolSummary,
	toolCallSummary,
} from "./names.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import { headTruncateToWidth, toolViewportWidth } from "./result.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** Max sub-calls listed in collapsed state (matches pi native; earlier ones fold into one line). */
const COLLAPSED_CALL_LIMIT = 8;
/** Collapsed body indent, aligned with `   ↳ …`. */
const INDENT = "   ";

/** Script result header; only counts as header when the whole body equals it exactly. */
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

export type CodemodeNestedCall = {
	name?: unknown;
	/** Compact JSON; pi truncates it when too long, after which JSON.parse fails. */
	args?: unknown;
	status?: unknown;
	durationMs?: unknown;
	error?: unknown;
	cost?: unknown;
};

export function codemodeCalls(result: any): CodemodeNestedCall[] {
	const calls = result?.details?.calls;
	return Array.isArray(calls) ? calls : [];
}

/** Output body after stripping the script header (terminal escapes already cleaned). */
export function codemodeOutputText(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	const blocks = content
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item?.text ?? ""));
	if (blocks.length > 0 && SCRIPT_HEADER.test(blocks[0]!)) blocks.shift();
	return sanitizeToolResultText(blocks.join("\n"), 16_384).trim();
}

export function codemodeOutputLineCount(result: any): number {
	const text = codemodeOutputText(result).replace(/\n+$/, "");
	return text ? text.split("\n").length : 0;
}

/** Summary line segments (ordered by importance; dropped from the tail at render time to fit width). */
export function codemodeSummaryParts(
	calls: readonly CodemodeNestedCall[],
	outputLines: number,
	running: boolean,
): string[] {
	const total = calls.length;
	const failed = calls.filter((call) => call?.status === "error").length;
	const runningCount = calls.filter((call) => !call?.status || call?.status === "running").length;
	const parts: string[] = [];
	if (running) {
		if (runningCount)
			parts.push(`${runningCount} ${runningCount === 1 ? "call" : "calls"} running`);
		const done = total - runningCount;
		if (done) parts.push(`${done} done`);
		if (failed) parts.push(`${failed} failed`);
		return parts.length ? parts : ["running…"];
	}
	if (total) parts.push(`${total} ${total === 1 ? "call" : "calls"}`);
	if (failed) parts.push(`${failed} failed`);
	if (outputLines) parts.push(`${outputLines} ${outputLines === 1 ? "line" : "lines"} output`);
	return parts.length ? parts : ["Done"];
}

/** Drop segments from the tail when width is short (output line count first, then call count); never splits words. */
function fitSummaryParts(parts: readonly string[], width: number): string {
	const kept = [...parts];
	while (kept.length > 1 && visibleWidth(kept.join(" · ")) > width) kept.pop();
	const text = kept.join(" · ");
	return visibleWidth(text) <= width ? text : headTruncateToWidth(text, width);
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Matches pi native: under 1 cent shows two significant digits. */
function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** Duration/cost of a single sub-call (plain text; caller decides coloring). */
function callMeta(call: CodemodeNestedCall): string[] {
	const out: string[] = [];
	const duration = call?.durationMs;
	if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
		out.push(formatDuration(duration));
	}
	const cost = call?.cost;
	if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) out.push(formatCost(cost));
	return out;
}

/** Object recoverable from truncated compact JSON; complete marks whether it was whole to begin with. */
type ParsedCallArgs = { args: Record<string, unknown>; complete: boolean };

/** Candidate closers appended to a truncated string: try closing a string first, then arrays and objects. */
const REPAIR_CLOSERS = ['"}', '"}]}', '"}}', "}", "]}"];

/**
 * Sub-call args: parse directly first; for strings pi truncated from the tail (over 200 chars), try a rescue:
 * back off char by char appending missing closers, keeping the longest parseable object. Truncation keeps leading fields,
 * so early ones like path/command/pattern survive; the cut-off tail values are unrecoverable anyway.
 */
function parseCallArgs(raw: string): ParsedCallArgs | undefined {
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { args: parsed, complete: true };
		}
		return undefined;
	} catch {
		// Truncated string: take the rescue path
	}
	const body = raw.endsWith("...") ? raw.slice(0, -3) : raw;
	if (!body.startsWith("{")) return undefined;
	for (let end = body.length; end > 0; end--) {
		for (const closer of REPAIR_CLOSERS) {
			try {
				const parsed = JSON.parse(body.slice(0, end) + closer);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				// Empty object means no fields recovered; shorter only gets emptier
				if (Object.keys(parsed).length === 0) return undefined;
				return { args: parsed, complete: false };
			} catch {
				// Try next closer / next length
			}
		}
	}
	return undefined;
}

/** Sub-call args: reuse the field-chain summary if parseable; if unrecognized (malformed even after rescue), show raw text. */
function callSummary(call: CodemodeNestedCall): ToolCallSummary {
	const name = String(call?.name ?? "tool");
	const title = mcpToolTitle({ toolName: name }) ?? humanizeToolLabel(name);
	const raw = typeof call?.args === "string" ? call.args : "";
	if (!raw) return { main: title, detail: "" };
	const parsed = parseCallArgs(raw);
	if (parsed) {
		const summary = toolCallSummary(name, parsed.args, { title, variant: "default" });
		// Truncated string recovered only some fields: use them only if the field chain recognizes them, otherwise show raw text,
		// so incomplete JSON is not laid out as if it were complete input.
		if (parsed.complete || summary.payload === undefined) return summary;
	}
	return { main: title, detail: "", payload: raw };
}

function statusIcon(status: unknown, theme: any): string {
	switch (status) {
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
		default:
			// Running: frame is fetched inside render(); the animation timer only calls requestRender
			return theme.fg("accent", toolLoadingIcon());
	}
}

function callRow(call: CodemodeNestedCall, theme: any, rowWidth: number): string {
	const fg = theme.fg.bind(theme);
	const prefix = `${INDENT}${fg("dim", "├")} ${statusIcon(call?.status, theme)} `;
	// detail (read's offset/limit etc.) follows the title, same as tool group rows
	const summary = callSummary(call);
	const detail = fg("dim", summary.detail);
	const suffix = callMeta(call)
		.map((text) => ` ${fg("dim", text)}`)
		.join("");
	const mainWidth = Math.max(
		0,
		rowWidth - visibleWidth(prefix) - visibleWidth(detail) - visibleWidth(suffix),
	);
	const row = `${prefix}${renderToolSummary(summary, mainWidth, fg)}${detail}${suffix}`;
	return truncateToWidth(row, rowWidth, "");
}

/**
 * Collapsed-state rows (including running partial updates): all sub-calls use ├, the last line closes the summary with └,
 * consistent with the tool group tree.
 */
export function codemodeCollapsedLines(options: {
	result: any;
	theme: any;
	running: boolean;
	isError: boolean;
	width: number;
	/** When hovering the whole card, the expand hint uses text color, consistent with other collapsed cards. */
	hovered?: boolean;
}): string[] {
	const { result, theme, running, isError } = options;
	const fg = theme.fg.bind(theme);
	const calls = codemodeCalls(result);
	const rowWidth = toolViewportWidth(options.width);
	const shown = calls.slice(-COLLAPSED_CALL_LIMIT);
	const lines: string[] = [];
	if (shown.length < calls.length) {
		const hidden = calls.length - shown.length;
		lines.push(
			truncateToWidth(
				`${INDENT}${fg("dim", "├")} ${fg("dim", `… ${hidden} earlier ${hidden === 1 ? "call" : "calls"}`)}`,
				rowWidth,
				"",
			),
		);
	}
	for (const call of shown) lines.push(callRow(call, theme, rowWidth));

	const summary = codemodeSummaryParts(calls, codemodeOutputLineCount(result), running);
	// Without sub-calls, draw no connector to avoid a lone └
	const prefix = shown.length > 0 ? `${INDENT}${fg("dim", "└")} ` : INDENT;
	const hint = running ? "" : ` ${fg(options.hovered ? "text" : "dim", `· ${showMoreHintText()}`)}`;
	const bodyWidth = Math.max(1, rowWidth - visibleWidth(prefix) - visibleWidth(hint));
	const body = fg(isError ? "error" : "muted", fitSummaryParts(summary, bodyWidth));
	lines.push(truncateToWidth(`${prefix}${body}${hint}`, rowWidth, ""));
	return lines;
}

/** Expanded body: all sub-calls (with error text) + output minus the script header + full output path. */
export function codemodeExpandedBody(result: any): string {
	const parts: string[] = [];
	const calls = codemodeCalls(result);
	if (calls.length > 0) {
		parts.push(
			calls
				.map((call) => {
					const name = String(call?.name ?? "tool");
					const raw = typeof call?.args === "string" ? call.args : "";
					const meta = callMeta(call);
					const head = [name, raw, ...meta].filter(Boolean).join(" ");
					const error =
						typeof call?.error === "string" && call.error
							? `\n    ${call.error.split("\n").join("\n    ")}`
							: "";
					return `${head}${error}`;
				})
				.join("\n"),
		);
	}
	const output = codemodeOutputText(result);
	if (output) parts.push(output);
	const full = result?.details?.fullOutputPath;
	if (typeof full === "string" && full.trim()) parts.push(`Full output: ${full.trim()}`);
	return parts.join("\n\n");
}

/**
 * Collapsed result component. Only the summary line is the expand target, consistent with diff cards; rows are cheap,
 * so no own caching (settled cards have a separate whole-row paint cache; running ones recompute per frame anyway). Hover state is
 * read inside render() so it stays in sync with requestRender from mouse motion.
 */
export function createCodemodeResultComponent(options: {
	result: any;
	theme: any;
	running: boolean;
	isError: boolean;
	/** Collapsed hover query, same mechanism as diff cards (mouse/hover). */
	isHovered?: () => boolean;
}): any {
	const { result, theme, running, isError } = options;
	return {
		render(width: number): string[] {
			return codemodeCollapsedLines({
				result,
				theme,
				running,
				isError,
				width,
				hovered: options.isHovered?.() ?? false,
			});
		},
		invalidate(): void {},
		isCollapsedHintLine(plainLine: string): boolean {
			return !running && /(click to show more|to show more)\s*$/.test(stripAnsi(plainLine));
		},
	};
}
