/**
 * Git plumbing. Every diff is computed between two tree objects, so all scopes
 * (a turn, everything unreviewed, HEAD, the index, a branch) take the same path,
 * untracked files included, and HEAD, the real index and the stash are never touched.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function git(
	cwd: string,
	args: string[],
	opts: { env?: Record<string, string>; input?: string; maxBytes?: number } = {},
): Promise<GitResult> {
	return new Promise((done) => {
		const child = spawn("git", args, {
			cwd,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			if (truncated) return;
			size += d.length;
			if (opts.maxBytes !== undefined && size > opts.maxBytes) {
				truncated = true;
				child.kill();
				return;
			}
			out.push(d);
		});
		child.stderr.on("data", (d) => (stderr += d));
		const fail = (e: Error) => done({ code: -1, stdout: "", stderr: String(e) });
		child.on("error", fail);
		child.stdin.on("error", (e: NodeJS.ErrnoException) => {
			// Git can exit without reading stdin. Keep its exit code and diagnostics.
			if (e.code !== "EPIPE") fail(e);
		});
		child.on("close", (code) =>
			done({
				code: truncated ? -2 : (code ?? -1),
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: truncated ? "output too large" : stderr,
			}),
		);
		child.stdin.end(opts.input ?? "");
	});
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
	const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

async function withTempIndex<T>(fn: (index: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
	try {
		return await fn(join(dir, "index"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Hash the working tree (tracked and untracked, minus ignored files) into a tree
 * object, the same way pi-rewind does, so its checkpoints and ours compare equal.
 */
export async function snapshot(root: string): Promise<string | undefined> {
	return withTempIndex(async (index) => {
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

/** The tree of the real index (what is staged). */
export async function indexTree(root: string): Promise<string | undefined> {
	const w = await git(root, ["write-tree"]);
	return w.code === 0 ? w.stdout.trim() : undefined;
}

/** Resolve any tree-ish (a commit, ref or tree id) to a tree id. */
export async function treeOf(root: string, rev: string): Promise<string | undefined> {
	const r = await git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function headTree(root: string): Promise<string> {
	return (await treeOf(root, "HEAD")) ?? EMPTY_TREE;
}

export async function treeExists(root: string, tree: string): Promise<boolean> {
	return (await git(root, ["cat-file", "-e", `${tree}^{tree}`])).code === 0;
}

/** The branch a feature branch would merge into: origin/HEAD, else main or master. */
export async function defaultBranch(root: string): Promise<string | undefined> {
	const sym = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
	for (const ref of ["origin/main", "origin/master", "main", "master"]) {
		if ((await git(root, ["rev-parse", "--verify", "--quiet", ref])).code === 0) return ref;
	}
	return undefined;
}

export async function mergeBase(root: string, ref: string): Promise<string | undefined> {
	const r = await git(root, ["merge-base", ref, "HEAD"]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function currentBranch(root: string): Promise<string | undefined> {
	const r = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Maximum patch size read from git; larger diffs are refused rather than freezing the TUI. */
export const MAX_PATCH_BYTES = 32 * 1024 * 1024;

/**
 * A unified patch between two trees. Defensive about user config: no pager, no
 * external diff tool, no color, no textconv, fixed prefixes.
 */
export async function diffTrees(
	root: string,
	base: string,
	target: string,
	opts: { context?: number; paths?: string[] } = {},
): Promise<GitResult> {
	const args = [
		"--no-pager",
		"-c",
		"diff.external=",
		"-c",
		"diff.noprefix=false",
		"-c",
		"diff.mnemonicPrefix=false",
		"-c",
		"core.quotePath=false",
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--find-renames",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		`--unified=${opts.context ?? 3}`,
		base,
		target,
	];
	if (opts.paths?.length) args.push("--", ...opts.paths);
	return git(root, args, { maxBytes: MAX_PATCH_BYTES });
}

/** Full content of a blob at a path in a tree, for expanding context. */
export async function readBlob(root: string, tree: string, path: string): Promise<string | undefined> {
	const r = await git(root, ["cat-file", "blob", `${tree}:${path}`], { maxBytes: 8 * 1024 * 1024 });
	return r.code === 0 ? r.stdout : undefined;
}
