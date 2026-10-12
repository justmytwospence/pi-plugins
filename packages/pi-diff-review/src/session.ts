/**
 * What the session remembers, read from the current branch of entries so /tree,
 * /fork and pi-rewind restores see the matching history:
 *
 * - checkpoints: working-tree snapshots before each prompt ("pre") and when each
 *   agent run ends ("post"). pi-rewind writes these as `rewind-checkpoint`
 *   entries; without pi-rewind this extension writes the same shape itself.
 * - review marks: the working tree when you last finished a review.
 * - threads: review comments and the agent's replies.
 * - file checks: the files you marked reviewed with `r`, each keyed by the
 *   diff you saw, so a check is dropped when the file's changes change.
 */

import { createHash } from "node:crypto";
import { type FileDiff, filePath } from "./parse.ts";
import type { Thread } from "./threads.ts";

export const REWIND_ENTRY = "rewind-checkpoint";
export const CHECKPOINT_ENTRY = "diff-review-checkpoint";
export const MARK_ENTRY = "diff-review-mark";
export const THREADS_ENTRY = "diff-review-threads";
export const CHECKS_ENTRY = "diff-review-file-checks";
export const DRAFTS_ENTRY = "diff-review-editor-drafts";

/** Cancelled editor text, keyed by file content, action and comment anchor. Empty suggestions are valid. */
export type EditorDrafts = Map<string, string>;

/** The last persisted editor drafts for one repository root on the branch. */
export function lastDrafts(branch: Entry[], root: string): EditorDrafts {
	let drafts: Record<string, string> = {};
	for (const e of branch) {
		if (e.type !== "custom" || e.customType !== DRAFTS_ENTRY) continue;
		const d = e.data as { root?: string; drafts?: Record<string, string> } | undefined;
		if (d?.root === root && d.drafts && typeof d.drafts === "object" && !Array.isArray(d.drafts)) drafts = d.drafts;
	}
	return new Map(Object.entries(drafts).filter(([, v]) => typeof v === "string"));
}

/** Per-file review checks: path to the key of the diff that was checked. */
export type FileChecks = Map<string, string>;

/** A key for a file's diff as shown: the same changes give the same key, any change to them a new one. */
export function fileKey(f: FileDiff): string {
	const h = createHash("sha1");
	h.update(JSON.stringify([f.status, f.oldPath, f.newPath, f.binary, f.oldMode, f.newMode, f.oldBlob, f.newBlob]));
	for (const hunk of f.hunks) {
		h.update(JSON.stringify([hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount, hunk.section]));
		for (const line of hunk.lines) h.update(JSON.stringify([line.kind, line.text, !!line.noNewline]));
	}
	return h.digest("hex");
}

/** Whether `f` is checked: the check exists and was made on this very diff. */
export function isChecked(checks: FileChecks, f: FileDiff): boolean {
	return checks.get(filePath(f)) === fileKey(f);
}

/** Drop the checks of files whose diff has changed since they were checked; returns whether any were. */
export function pruneChecks(checks: FileChecks, files: readonly FileDiff[]): boolean {
	let changed = false;
	for (const f of files) {
		const path = filePath(f);
		const key = checks.get(path);
		if (key !== undefined && key !== fileKey(f)) {
			checks.delete(path);
			changed = true;
		}
	}
	return changed;
}

/** The last persisted file checks for one repository root on the branch. */
export function lastChecks(branch: Entry[], root: string): FileChecks {
	let checks: Record<string, string> = {};
	for (const e of branch) {
		if (e.type !== "custom" || e.customType !== CHECKS_ENTRY) continue;
		const d = e.data as { root?: string; checks?: Record<string, string> } | undefined;
		if (d?.root === root && d.checks && typeof d.checks === "object" && !Array.isArray(d.checks)) checks = d.checks;
	}
	return new Map(Object.entries(checks).filter(([, v]) => typeof v === "string"));
}

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
	return threads.map((t) => ({ ...t, excerpt: [...t.excerpt] }));
}

/** Whether pi-rewind has written checkpoints on this branch (so we need not). */
export function hasRewindCheckpoints(branch: Entry[]): boolean {
	return branch.some((e) => e.type === "custom" && e.customType === REWIND_ENTRY);
}
