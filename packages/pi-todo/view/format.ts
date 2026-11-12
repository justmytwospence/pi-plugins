import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Block, expandHint, Row, toneOfTool } from "../src/transcript-style.ts";
import { formatStatusLabel } from "../state/i18n-bridge.js";
import { selectTaskSubjectById } from "../state/selectors.js";
import type { TaskState } from "../state/state.js";
import { sanitizeTerminalText } from "../tool/sanitize.js";
import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "../tool/types.js";

type ToneContext = { isError?: boolean; isPartial?: boolean; executionStarted?: boolean; lastComponent?: unknown };

// Re-export so legacy import paths (todo.ts, tests) continue to resolve;
// the canonical definition lives in the i18n bridge.
export { formatStatusLabel };

// ---------------------------------------------------------------------------
// Status presentation tables — the single source of truth for glyph/color.
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

/**
 * Color palette for the renderResult status echo. `deleted` uses `muted` so a
 * successful delete is visually distinct from the error branch (which uses
 * `error` + `✗`)..
 */
export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

/**
 * Per-action prefix glyph for renderCall. `+` create, `→` update, `×` delete,
 * `›` get, `☰` list, `∅` clear..
 */
export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

/**
 * Glyph for the persistent overlay's per-task row. Differs from `STATUS_GLYPH`
 * for `completed` (`✓` vs `●`) and `deleted` (`✗` vs `⊘`) because the
 * overlay caller never renders a `deleted` row but uses `✗` in its
 * error-toned palette..
 */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/**
 * Format a single task row for the persistent overlay. The subject color
 * reflects task state while IDs and supporting metadata stay visually quiet.
 */
export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(t.status, theme);
	const subjectColor =
		t.status === "in_progress" ? "accent" : t.status === "completed" || t.status === "deleted" ? "muted" : "text";
	let subject = theme.fg(subjectColor, sanitizeTerminalText(t.subject));
	if (t.status === "completed" || t.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph}`;
	if (showId) line += ` ${theme.fg("dim", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("muted", `(${sanitizeTerminalText(t.activeForm)})`)}`;
	}
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("muted", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/**
 * Format a single task line for the `/todos` slash command (no glyph color,
 * indented bullet prefix). Pre-refactor `todo.ts:670-674`.
 */
export function formatCommandTaskLine(t: Task, glyph: string): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

// ---------------------------------------------------------------------------
// Tool render hooks — wrapped so `todo.ts` becomes a thin call-site.
// ---------------------------------------------------------------------------

/**
 * `renderCall` body: a one-line transcript row, `Todo · <op> <subject>`, whose
 * glyph follows the tool's lifecycle tone.
 */
export function renderTodoCall(
	args: TaskMutationParams & { action: TaskAction },
	theme: Theme,
	state: TaskState,
	context?: ToneContext,
): Row {
	let subject = "";
	if (args.action === "create" && args.subject) {
		subject = sanitizeTerminalText(args.subject);
	} else if (
		(args.action === "update" || args.action === "get" || args.action === "delete") &&
		args.id !== undefined
	) {
		const found = selectTaskSubjectById(state, args.id);
		subject = found ? sanitizeTerminalText(found) : `#${args.id}`;
	} else if (args.action === "list" && args.status) {
		subject = formatStatusLabel(args.status);
	}
	const detail = `${args.action}${subject ? ` ${subject}` : ""}`;
	return new Row(theme, () => ({
		tone: toneOfTool(context ?? {}, context?.lastComponent !== undefined),
		title: "Todo",
		detail,
	}));
}

/**
 * `renderResult` body. Collapsed: one dim `↳` line holding the first line of
 * the formatted result (plus the expand hint when there is more). Expanded: a
 * block with the full text in the tool's tone.
 */
export function renderTodoResult(
	result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
	theme: Theme,
	options: { expanded?: boolean } = {},
	context?: ToneContext,
): Component {
	const text = (result.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
	const lines = text ? text.split("\n").map((line) => sanitizeTerminalText(line)) : [];
	const tone = toneOfTool(context ?? {}, true);
	if (options.expanded && lines.length > 1) {
		return new Block(theme, () => ({ tone, title: "Todo", body: lines.join("\n"), expanded: true }));
	}
	const first = lines[0] ?? "done";
	return new Text(
		theme.fg("dim", `   ↳ ${first}`) + (lines.length > 1 ? expandHint(theme) : ""),
		0,
		0,
	);
}
