/**
 * Rewind: restore files alongside conversation rewinds (/tree and /fork),
 * like Claude Code's /rewind or OpenCode's /undo.
 *
 * - When a user message is submitted, the working tree (tracked + untracked,
 *   minus ignored files) is snapshotted as a git tree object via a temporary
 *   index. HEAD, the real index, and the stash are never touched.
 * - When the agent run ends, the final state is snapshotted too.
 * - Snapshots are persisted as `rewind-checkpoint` custom entries, so they
 *   survive restarts. Tree objects are unreferenced; git keeps them for
 *   gc.pruneExpire (2 weeks by default).
 * - On /tree or /fork to a checkpointed entry, offers to restore files.
 *   Only differing files are rewritten; files created since are deleted.
 *   Files that could not be deleted or written are reported by name.
 * - A `rewind:keep-files` event on Pi's bus (sent by pi-plan-mode before it returns to the planning
 *   conversation) skips the offer for the next /tree, within 10 seconds.
 * - /rewind-undo restores the state saved just before the last restore. The
 *   undo slot belongs to the session and repository it was made in; after a
 *   failed undo it is kept, so the undo can be retried.
 *
 * Only active in git repos and in interactive sessions (set
 * PI_REWIND_ALWAYS=1 to snapshot in non-interactive modes too).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ENTRY_TYPE = "rewind-checkpoint";

type Kind = "pre" | "post";
interface Checkpoint {
	entryId: string;
	kind: Kind;
	root: string;
	tree: string;
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<GitResult> {
	return new Promise((done) => {
		const child = spawn("git", args, {
			cwd,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (e) => done({ code: -1, stdout, stderr: String(e) }));
		child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
		child.stdin.on("error", () => {
			// Git may exit before reading all of stdin; the close event still reports the outcome.
		});
		child.stdin.end(opts.input ?? "");
	});
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
	const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

async function withTempIndex<T>(fn: (index: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "pi-rewind-"));
	try {
		return await fn(join(dir, "index"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Hash the working tree (respecting .gitignore) into a tree object. */
export async function snapshot(root: string): Promise<string | undefined> {
	return withTempIndex(async (index) => {
		// Seed from the real index so unchanged files are not rehashed.
		const p = await git(root, ["rev-parse", "--git-path", "index"]);
		if (p.code === 0) {
			const real = resolve(root, p.stdout.trim());
			if (existsSync(real)) copyFileSync(real, index);
		}
		const env = { GIT_INDEX_FILE: index };
		if ((await git(root, ["add", "-A", "--", "."], { env })).code !== 0) return undefined;
		const w = await git(root, ["write-tree"], { env });
		return w.code === 0 ? w.stdout.trim() : undefined;
	});
}

/** Whether a tree object is still in the repository (unreferenced trees get garbage-collected). */
export async function treeExists(root: string, tree: string): Promise<boolean> {
	return (await git(root, ["cat-file", "-e", `${tree}^{tree}`])).code === 0;
}

export interface Diff {
	remove: string[]; // present now, absent in target
	write: string[]; // absent or different now
}

export async function diffTrees(root: string, target: string, current: string): Promise<Diff | undefined> {
	const r = await git(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", target, current]);
	if (r.code !== 0) return undefined;
	const parts = r.stdout.split("\0").filter((s) => s.length > 0);
	const diff: Diff = { remove: [], write: [] };
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const status = parts[i];
		const path = parts[i + 1];
		if (status === "A") diff.remove.push(path);
		else diff.write.push(path);
	}
	return diff;
}

/** What applying a tree did: every requested file is either done or named among the failures. */
export interface ApplyResult {
	removed: string[];
	failedRemoves: Array<{ path: string; error: string }>;
	/** Files actually written, not just requested. */
	written: string[];
	failedWrites: Array<{ path: string; error: string }>;
	/** An operational failure, for example creating or cleaning up the temporary index. */
	error?: string;
}

export function applySucceeded(r: ApplyResult): boolean {
	return r.failedRemoves.length === 0 && r.failedWrites.length === 0 && r.error === undefined;
}

/** Report partial outcomes and every failed filename, without claiming unattempted writes succeeded. */
export function describeFailure(r: ApplyResult): string | undefined {
	if (applySucceeded(r)) return undefined;
	const parts: string[] = [];
	for (const [kind, done, failures] of [
		["deletions", r.removed, r.failedRemoves],
		["writes", r.written, r.failedWrites],
	] as const) {
		if (!failures.length) continue;
		const names = failures.map((f) => `${/[\r\n\t\x1b]/u.test(f.path) ? JSON.stringify(f.path) : f.path}: ${f.error}`);
		parts.push(`${failures.length} of ${failures.length + done.length} ${kind} failed (${names.join("; ")})`);
	}
	if (r.error !== undefined) parts.push(`operation failed: ${r.error}`);
	return parts.join("; ");
}

function errorText(e: unknown): string {
	if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code;
	return e instanceof Error ? e.message : String(e);
}

/** Make the working tree match `target` for the files in `diff`, reporting every file it could not. */
export async function applyTree(root: string, target: string, diff: Diff): Promise<ApplyResult> {
	const result: ApplyResult = { removed: [], failedRemoves: [], written: [], failedWrites: [] };
	const failRemaining = (error: string) => {
		for (const rel of diff.remove) {
			if (!result.removed.includes(rel) && !result.failedRemoves.some((f) => f.path === rel)) result.failedRemoves.push({ path: rel, error });
		}
		for (const rel of diff.write) {
			if (!result.written.includes(rel) && !result.failedWrites.some((f) => f.path === rel)) result.failedWrites.push({ path: rel, error });
		}
	};
	if (diff.remove.length + diff.write.length === 0) return result;
	try {
		await withTempIndex(async (index) => {
			const env = { GIT_INDEX_FILE: index };
			// Validate/read the target before deleting anything, including deletion-only restores.
			const rt = await git(root, ["read-tree", target], { env });
			if (rt.code !== 0) {
				failRemaining(rt.stderr.trim() || "git read-tree failed");
				return;
			}
			for (const rel of diff.remove) {
				const abs = join(root, rel);
				try {
					unlinkSync(abs);
				} catch (e) {
					// Already gone counts as removed; anything else is reported.
					if ((e as { code?: string })?.code === "ENOENT") result.removed.push(rel);
					else result.failedRemoves.push({ path: rel, error: errorText(e) });
					continue;
				}
				result.removed.push(rel);
				// Prune directories left empty.
				for (let dir = dirname(abs); dir.startsWith(root + "/") && dir !== root; dir = dirname(dir)) {
					try {
						rmdirSync(dir);
					} catch {
						break;
					}
				}
			}
			// Git can partially check out a batch before returning an error. One path per
			// invocation makes success/failure exact, including names containing newlines.
			for (const rel of diff.write) {
				const co = await git(root, ["checkout-index", "-f", "-z", "--stdin"], { env, input: `${rel}\0` });
				if (co.code === 0) result.written.push(rel);
				else result.failedWrites.push({ path: rel, error: co.stderr.trim() || "git checkout-index failed" });
			}
		});
	} catch (e) {
		result.error = errorText(e);
		failRemaining(result.error);
	}
	return result;
}

/** Whether two paths name the same directory, through symlinks (`/var` vs `/private/var` on macOS). */
function sameDir(a: string | undefined, b: string): boolean {
	if (!a) return false;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
}

/** The state /rewind-undo goes back to, valid for one session and repository. */
export interface UndoSlot {
	sessionId: string;
	root: string;
	tree: string;
	/** State before the first failed undo, retained across retries for a complete redo. */
	recoveryTree?: string;
}

export default function (pi: ExtensionAPI) {
	const always = process.env.PI_REWIND_ALWAYS === "1";
	let pending: { message: unknown; timestamp: unknown; root: string; tree: string; sessionId: string }[] = [];
	let lastUndo: UndoSlot | undefined;
	const sessionIds = new WeakMap<object, string>();
	let nextSessionId = 0;

	function sessionId(ctx: any): string {
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			if (typeof id === "string" && id) return `id:${id}`;
		} catch {
			// An older Pi without getSessionId: fall back to the session file.
		}
		try {
			const file = ctx.sessionManager?.getSessionFile?.();
			if (typeof file === "string" && file) return `file:${file}`;
		} catch {
			// In-memory/older sessions can still be distinguished by their manager identity.
		}
		const manager = ctx.sessionManager;
		if (!manager || typeof manager !== "object") return "";
		let id = sessionIds.get(manager);
		if (!id) { id = `manager:${++nextSessionId}`; sessionIds.set(manager, id); }
		return id;
	}

	function checkpoints(ctx: any): Map<string, Checkpoint> {
		const map = new Map<string, Checkpoint>();
		for (const e of ctx.sessionManager.getEntries()) {
			if (e.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
			for (const c of (e.data?.checkpoints ?? []) as Checkpoint[]) map.set(`${c.kind}:${c.entryId}`, c);
		}
		return map;
	}

	/** Find the checkpoint matching the file state at a conversation point. */
	function lookup(ctx: any, entryId: string, preferPre: boolean): Checkpoint | undefined {
		const map = checkpoints(ctx);
		let entry = ctx.sessionManager.getEntry(entryId);
		// Skip non-message entries (labels, summaries, our own checkpoints).
		while (entry && entry.type !== "message") entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : undefined;
		if (!entry) return undefined;
		if (preferPre && entry.message?.role === "user") return map.get(`pre:${entry.id}`);
		return map.get(`post:${entry.id}`);
	}

	async function offerRestore(ctx: any, cp: Checkpoint | undefined) {
		if (!cp || !ctx.hasUI) return;
		// Resolve the current cwd afresh: it can change without a session_start event.
		if (!sameDir(await repoRoot(ctx.cwd), cp.root)) {
			ctx.ui.notify(`Rewind: the checkpoint belongs to ${cp.root}, not this repository; files not restored`, "warning");
			return;
		}
		if (!existsSync(cp.root)) return;
		if (!(await treeExists(cp.root, cp.tree))) {
			ctx.ui.notify("Rewind: file checkpoint was garbage-collected; files not restored", "warning");
			return;
		}
		const current = await snapshot(cp.root);
		if (!current || current === cp.tree) return;
		const diff = await diffTrees(cp.root, cp.tree, current);
		if (!diff) return;
		const n = diff.remove.length + diff.write.length;
		if (n === 0) return;
		const choice = await ctx.ui.select(`Restore files to this point? (${n} file${n === 1 ? "" : "s"} differ)`, [
			"Keep current files",
			"Restore files",
		]);
		if (choice !== "Restore files") return;
		// Save recovery before attempting any mutations, including a partial restore.
		lastUndo = { sessionId: sessionId(ctx), root: cp.root, tree: current };
		const result = await applyTree(cp.root, cp.tree, diff);
		const failure = describeFailure(result);
		if (failure) ctx.ui.notify(`Rewind: restore incomplete: ${failure}. Check the files named; /rewind-undo reverts what was restored.`, "error");
		else ctx.ui.notify(`Rewind: restored ${n} file${n === 1 ? "" : "s"} (/rewind-undo to revert)`, "info");
	}

	// Another plugin that moves the conversation on purpose while keeping the files (pi-plan-mode returning
	// to the planner after an implementation) announces it, so the next /tree is not offered a restore that
	// would undo that work. The announcement lapses after a few seconds if no /tree follows.
	let skipTreeUntil = 0;
	pi.events?.on("rewind:keep-files", () => {
		skipTreeUntil = Date.now() + 10_000;
	});

	pi.on("session_start", () => {
		pending = [];
		lastUndo = undefined;
	});

	// Snapshot before the agent acts on each user message (prompts and queued messages).
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user" || (!ctx.hasUI && !always)) return;
		const r = await repoRoot(ctx.cwd);
		if (!r) return;
		const tree = await snapshot(r);
		if (tree) pending.push({ message: event.message, timestamp: (event.message as any).timestamp, root: r, tree, sessionId: sessionId(ctx) });
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI && !always) return;
		const r = await repoRoot(ctx.cwd);
		if (!r) return;
		const branch = ctx.sessionManager.getBranch();
		const found: Checkpoint[] = [];
		for (const p of pending) {
			if (p.sessionId !== sessionId(ctx)) continue;
			const entry = [...branch]
				.reverse()
				.find((e: any) => e.type === "message" && e.message?.role === "user" && (e.message === p.message || e.message?.timestamp === p.timestamp));
			if (entry) found.push({ entryId: entry.id, kind: "pre", root: p.root, tree: p.tree });
		}
		pending = [];
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf?.type === "message") {
			const tree = await snapshot(r);
			if (tree) found.push({ entryId: leaf.id, kind: "post", root: r, tree });
		}
		if (found.length > 0) pi.appendEntry(ENTRY_TYPE, { checkpoints: found });
	});

	pi.on("session_before_tree", async (event, ctx) => {
		if (skipTreeUntil > Date.now()) {
			skipTreeUntil = 0;
			return;
		}
		await offerRestore(ctx, lookup(ctx, event.preparation.targetId, true));
	});

	pi.on("session_before_fork", async (event, ctx) => {
		await offerRestore(ctx, lookup(ctx, event.entryId, event.position === "before"));
	});

	pi.registerCommand("rewind-undo", {
		description: "Revert the last file restore made by /tree or /fork",
		handler: async (_args, ctx) => {
			if (!lastUndo) {
				ctx.ui.notify("Rewind: nothing to undo", "warning");
				return;
			}
			if (!lastUndo.sessionId || lastUndo.sessionId !== sessionId(ctx)) {
				ctx.ui.notify("Rewind: nothing to undo in this session (the last restore was made in another one)", "warning");
				return;
			}
			if (!sameDir(await repoRoot(ctx.cwd), lastUndo.root)) {
				ctx.ui.notify(`Rewind: the last restore was made in ${lastUndo.root}, not in this repository; nothing undone`, "warning");
				return;
			}
			const { root: r, tree } = lastUndo;
			if (!(await treeExists(r, tree))) {
				ctx.ui.notify("Rewind: the undo snapshot was garbage-collected; nothing undone", "error");
				return;
			}
			const current = await snapshot(r);
			const diff = current ? await diffTrees(r, tree, current) : undefined;
			if (!current || !diff) {
				ctx.ui.notify("Rewind: could not compute undo", "error");
				return;
			}
			const n = diff.remove.length + diff.write.length;
			if (n === 0) {
				if (lastUndo.recoveryTree) lastUndo = { sessionId: lastUndo.sessionId, root: r, tree: lastUndo.recoveryTree };
				ctx.ui.notify("Rewind: files already match the undo point", "info");
				return;
			}
			const recoveryTree = lastUndo.recoveryTree ?? current;
			const result = await applyTree(r, tree, diff);
			const failure = describeFailure(result);
			if (failure) {
				// Keep both the target for retry and the original pre-attempt state for redo.
				lastUndo.recoveryTree = recoveryTree;
				ctx.ui.notify(`Rewind: undo incomplete: ${failure}. Check the files named and run /rewind-undo again; the state before this undo is git tree ${recoveryTree}.`, "error");
				return;
			}
			lastUndo = { sessionId: lastUndo.sessionId, root: r, tree: recoveryTree }
			ctx.ui.notify(`Rewind: reverted ${n} file${n === 1 ? "" : "s"} (/rewind-undo again redoes the restore)`, "info");
		},
	});
}
