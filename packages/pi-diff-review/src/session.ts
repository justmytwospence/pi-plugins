/**
 * What the session remembers, read from the current branch of entries so /tree,
 * /fork and pi-rewind restores see the matching history:
 *
 * - checkpoints: working-tree snapshots before each prompt ("pre") and when each
 *   agent run ends ("post"). pi-rewind writes these as `rewind-checkpoint`
 *   entries; without pi-rewind this extension writes the same shape itself.
 * - review marks: the working tree when you last finished a review.
 * - threads: review comments and the agent's replies.
 */

import type { Thread } from "./threads.ts";

export const REWIND_ENTRY = "rewind-checkpoint";
export const CHECKPOINT_ENTRY = "diff-review-checkpoint";
export const MARK_ENTRY = "diff-review-mark";
export const THREADS_ENTRY = "diff-review-threads";

export interface Checkpoint {
	entryId: string;
	kind: "pre" | "post";
	root: string;
	tree: string;
}

export interface ReviewMark {
	root: string;
	tree: string;
	at: number;
}

/** The minimal entry shape this module reads. */
export interface Entry {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown; timestamp?: number };
	timestamp?: string;
}

export interface Turn {
	/** The user message that started the run. */
	entryId: string;
	prompt: string;
	pre: string;
	/** Snapshot when the run ended, if recorded. */
	post?: string;
	timestamp?: number;
}

export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
			.join("");
	}
	return "";
}

/** Turns on the branch, oldest first, for one repository root. */
export function turnsOnBranch(branch: Entry[], root: string): Turn[] {
	const pre = new Map<string, string>();
	const post = new Map<string, string>();
	for (const e of branch) {
		if (e.type !== "custom" || (e.customType !== REWIND_ENTRY && e.customType !== CHECKPOINT_ENTRY)) continue;
		const cps = ((e.data as { checkpoints?: Checkpoint[] } | undefined)?.checkpoints ?? []) as Checkpoint[];
		for (const c of cps) {
			if (c.root !== root) continue;
			(c.kind === "pre" ? pre : post).set(c.entryId, c.tree);
		}
	}
	const turns: Turn[] = [];
	let current: Turn | undefined;
	for (const e of branch) {
		if (e.type !== "message") continue;
		if (e.message?.role === "user") {
			const tree = pre.get(e.id);
			current = undefined;
			if (tree) {
				current = {
					entryId: e.id,
					prompt: messageText(e.message.content),
					pre: tree,
					timestamp: e.message.timestamp,
				};
				turns.push(current);
			}
			continue;
		}
		// A post checkpoint is keyed by the leaf message when the run ended.
		const p = post.get(e.id);
		if (p && current) current.post = p;
	}
	return turns;
}

export function lastMark(branch: Entry[], root: string): ReviewMark | undefined {
	let mark: ReviewMark | undefined;
	for (const e of branch) {
		if (e.type !== "custom" || e.customType !== MARK_ENTRY) continue;
		const m = e.data as ReviewMark | undefined;
		if (m && m.root === root && typeof m.tree === "string") mark = m;
	}
	return mark;
}

export function lastThreads(branch: Entry[], root: string): Thread[] {
	let threads: Thread[] = [];
	for (const e of branch) {
		if (e.type !== "custom" || e.customType !== THREADS_ENTRY) continue;
		const d = e.data as { root?: string; threads?: Thread[] } | undefined;
		if (d?.root === root && Array.isArray(d.threads)) threads = d.threads;
	}
	return threads.map((t) => ({ ...t }));
}

/** Whether pi-rewind has written checkpoints on this branch (so we need not). */
export function hasRewindCheckpoints(branch: Entry[]): boolean {
	return branch.some((e) => e.type === "custom" && e.customType === REWIND_ENTRY);
}
