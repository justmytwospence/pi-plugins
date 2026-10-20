import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import { sanitizeTerminalText } from "./sanitize.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "./types.js";

/**
 * Format a single task as a `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 * line. Used by the `list` content branch only — the overlay and `/todos`
 * formatting paths use `view/format.ts` for richer presentations.
 */
function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

/**
 * Multi-line presentation for the `get` action. Order of rows is pinned by
 * pre-refactor `todo.ts:354-376` — description, activeForm, blockedBy, blocks,
 * owner — so envelope-level snapshot tests stay byte-equivalent.
 */
function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 * The strings on each branch are byte-equivalent to pre-refactor `todo.ts`
 * reducer output.
 */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			// Defensive — `op.taskId` always resolves on success path.
			if (!t) return `Created #${op.taskId}`;
			return `Created #${t.id}: ${sanitizeTerminalText(t.subject)} (pending)`;
		}
		case "update": {
			if (!op.changed) {
				return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * The whole visible list after a change, appended to create/update/delete results. The model
 * sees where the list stands without a `list` call, and herdr-web-ui (the phone client) draws
 * these lines as its todo checklist instead of the raw output: it reads `    - [X] label` /
 * `    - [ ] label`, with a trailing `(in progress: note)` or `(blocked: note)`, from the output
 * of a tool named `todo`. Keep that shape; the heading at column 0 is not a phase to it.
 */
export function formatChecklist(state: TaskState): string | null {
	const visible = state.tasks.filter((t) => t.status !== "deleted");
	if (visible.length === 0) return null;
	const done = new Set(state.tasks.filter((t) => t.status === "completed").map((t) => t.id));
	const lines = visible.map((t) => {
		const label = `#${t.id} ${sanitizeTerminalText(t.subject)}`;
		if (t.status === "completed") return `    - [X] ${label}`;
		if (t.status === "in_progress") {
			const form = t.activeForm ? sanitizeTerminalText(t.activeForm) : "";
			return `    - [ ] ${label} (in progress${form ? `: ${form}` : ""})`;
		}
		const waiting = (t.blockedBy ?? []).filter((id) => !done.has(id));
		if (waiting.length) return `    - [ ] ${label} (blocked: waiting on ${waiting.map((id) => `#${id}`).join(", ")})`;
		return `    - [ ] ${label}`;
	});
	return `Todo list (${done.size}/${visible.length} done):\n${lines.join("\n")}`;
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 *
 * Mirrors `packages/rpiv-ask-user-question/tool/response-envelope.ts:13-47`.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const summary = formatContent(op, state);
	const checklist = op.kind === "create" || op.kind === "update" || op.kind === "delete" ? formatChecklist(state) : null;
	const text = checklist ? `${summary}\n\n${checklist}` : summary;
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}
