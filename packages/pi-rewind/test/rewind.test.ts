import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, mock, test } from "node:test";
import rewind, { applySucceeded, applyTree, describeFailure, diffTrees, snapshot } from "../src/index.ts";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function resetFs() {
	mock.restoreAll();
	syncBuiltinESMExports();
}
afterEach(resetFs);

/** Deterministic permission failure even when tests run as root or on another platform. */
function failDeletion(path: string) {
	const unlink = fs.unlinkSync;
	mock.method(fs, "unlinkSync", (file: PathLike) => {
		if (String(file) === path) throw Object.assign(new Error("blocked by test"), { code: "EACCES" });
		unlink(file);
	});
	syncBuiltinESMExports();
}

function repo() {
	const root = mkdtempSync(join(tmpdir(), "pi-rewind-test-"));
	dirs.push(root);
	const run = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	run("init", "-q", "-b", "main");
	const write = (path: string, text: string) => {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	};
	write("a.txt", "one\n");
	run("add", "-A");
	run("commit", "-qm", "init");
	return { root, run, write };
}

test("applyTree restores differing files, deletes new ones and reports success", async () => {
	const { root, run, write } = repo();
	const head = run("rev-parse", "HEAD");
	const index = readFileSync(join(root, ".git/index"));
	const stash = run("stash", "list");
	const before = (await snapshot(root)) as string;
	write("a.txt", "two\n");
	write("new/b.txt", "b\n");
	const after_ = (await snapshot(root)) as string;
	const diff = (await diffTrees(root, before, after_))!;
	assert.deepEqual(diff, { remove: ["new/b.txt"], write: ["a.txt"] });
	const result = await applyTree(root, before, diff);
	assert.equal(applySucceeded(result), true);
	assert.equal(describeFailure(result), undefined);
	assert.deepEqual(result, { removed: ["new/b.txt"], failedRemoves: [], written: ["a.txt"], failedWrites: [] });
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
	assert.equal(existsSync(join(root, "new")), false, "empty directories are pruned");
	assert.equal(await snapshot(root), before);
	assert.equal(run("rev-parse", "HEAD"), head);
	assert.deepEqual(readFileSync(join(root, ".git/index")), index);
	assert.equal(run("stash", "list"), stash);
});

test("a file that cannot be deleted is reported by name and the rest still happens", async () => {
	const { root, write } = repo();
	const before = (await snapshot(root)) as string;
	write("locked/keep.txt", "k\n");
	write("gone.txt", "g\n");
	write("a.txt", "changed\n");
	const after_ = (await snapshot(root)) as string;
	const diff = (await diffTrees(root, before, after_))!;
	failDeletion(join(root, "locked/keep.txt"));
	const result = await applyTree(root, before, diff);
	assert.equal(applySucceeded(result), false);
	assert.deepEqual(result.failedRemoves.map((f) => f.path), ["locked/keep.txt"]);
	assert.match(result.failedRemoves[0].error, /EACCES|EPERM/);
	assert.deepEqual(result.removed, ["gone.txt"]);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n", "writes still happen after a failed delete");
	assert.match(describeFailure(result)!, /1 of 2 deletions failed \(locked\/keep.txt: E(ACCES|PERM)\)/);
});

test("a write that git refuses is reported, not swallowed", async () => {
	const { root } = repo();
	const result = await applyTree(root, "0000000000000000000000000000000000000000", { remove: [], write: ["a.txt"] });
	assert.equal(applySucceeded(result), false);
	assert.deepEqual(result.written, []);
	assert.deepEqual(result.failedWrites.map((f) => f.path), ["a.txt"]);
	assert.match(result.failedWrites[0].error, /./);
	assert.match(describeFailure(result)!, /1 of 1 writes failed \(a.txt:/);
});

/** A fake Pi with one session's entries, enough for /tree restores and /rewind-undo. */
function harness(root: string, sessionId: string) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => undefined;
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => entries.push({ id: `custom-${entries.length}`, type: "custom", customType, data }),
	};
	rewind(pi as never);
	const entries: Array<Record<string, unknown>> = [];
	const notes: Array<{ message: string; type: string }> = [];
	const ctx = {
		cwd: root,
		hasUI: true,
		ui: {
			select: async () => "Restore files",
			notify: (message: string, type: string) => notes.push({ message, type }),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
			getEntry: (id: string) => entries.find((e) => e.id === id),
			getBranch: () => entries,
			getLeafEntry: () => entries.at(-1),
		},
	};
	const emit = async (name: string, event: unknown) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { ctx, entries, notes, emit, undo: (c: unknown = ctx) => commands.get("rewind-undo")!.handler("", c) };
}

test("/tree restores, /rewind-undo reverts and redoes, and the slot is scoped to the session and repository", async () => {
	const { root, write } = repo();
	const tree0 = (await snapshot(root)) as string;
	const h = harness(root, "s1");
	h.entries.push({ id: "u1", type: "message", message: { role: "user", content: "x" } });
	h.entries.push({ id: "c1", type: "custom", customType: "rewind-checkpoint", data: { checkpoints: [{ entryId: "u1", kind: "pre", root, tree: tree0 }] } });
	await h.emit("session_start", { type: "session_start" });

	write("a.txt", "edited\n");
	write("extra.txt", "x\n");
	await h.emit("session_before_tree", { preparation: { targetId: "u1" } });
	assert.match(h.notes.at(-1)!.message, /restored 2 files/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
	assert.equal(existsSync(join(root, "extra.txt")), false);

	// Another session, or another repository, cannot use this session's undo slot.
	await h.undo({ ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "s2" } });
	assert.match(h.notes.at(-1)!.message, /nothing to undo in this session/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");

	await h.undo();
	assert.match(h.notes.at(-1)!.message, /reverted 2 files/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "edited\n");
	assert.equal(readFileSync(join(root, "extra.txt"), "utf8"), "x\n");

	// Check AFTER a successful undo has resolved the original root: a cached root must not
	// make a different cwd look like the original repository.
	const other = repo();
	await h.undo({ ...h.ctx, cwd: other.root });
	assert.match(h.notes.at(-1)!.message, /not in this repository; nothing undone/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "edited\n");
	assert.equal(readFileSync(join(other.root, "a.txt"), "utf8"), "one\n");
	await h.undo({ ...h.ctx, cwd: tmpdir() });
	assert.match(h.notes.at(-1)!.message, /nothing undone/);

	// A symlink spelling of the same repository is allowed and keeps recovery usable.
	const alias = join(other.root, "original-repo");
	symlinkSync(root, alias, "dir");
	await h.undo({ ...h.ctx, cwd: alias });
	assert.match(h.notes.at(-1)!.message, /reverted 2 files/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");

	// A new session start drops the slot.
	await h.emit("session_start", { type: "session_start" });
	await h.undo();
	assert.equal(h.notes.at(-1)!.message, "Rewind: nothing to undo");
});

test("a partial restore reports the failed file and keeps the undo point", async () => {
	const { root, write } = repo();
	const tree0 = (await snapshot(root)) as string;
	const h = harness(root, "s1");
	h.entries.push({ id: "u1", type: "message", message: { role: "user", content: "x" } });
	h.entries.push({ id: "c1", type: "custom", customType: "rewind-checkpoint", data: { checkpoints: [{ entryId: "u1", kind: "pre", root, tree: tree0 }] } });
	await h.emit("session_start", { type: "session_start" });

	write("a.txt", "edited\n");
	write("locked/keep.txt", "k\n");
	failDeletion(join(root, "locked/keep.txt"));
	await h.emit("session_before_tree", { preparation: { targetId: "u1" } });
	const partial = h.notes.at(-1)!;
	assert.equal(partial.type, "error");
	assert.match(partial.message, /restore incomplete: 1 of 1 deletions failed \(locked\/keep.txt/);
	assert.match(partial.message, /\/rewind-undo reverts/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");

	// The undo point was kept: the edit comes back (the failed deletion exists on both sides).
	resetFs();
	await h.undo();
	assert.match(h.notes.at(-1)!.message, /reverted 1 file/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "edited\n");
	assert.equal(readFileSync(join(root, "locked/keep.txt"), "utf8"), "k\n");
});

test("a failed undo reports the file, names the state before it, and keeps the slot for a retry", async () => {
	const { root, write } = repo();
	const tree0 = (await snapshot(root)) as string;
	const h = harness(root, "s1");
	h.entries.push({ id: "u1", type: "message", message: { role: "user", content: "x" } });
	h.entries.push({ id: "c1", type: "custom", customType: "rewind-checkpoint", data: { checkpoints: [{ entryId: "u1", kind: "pre", root, tree: tree0 }] } });
	await h.emit("session_start", { type: "session_start" });

	write("a.txt", "edited\n");
	write("locked/keep.txt", "k\n");
	await h.emit("session_before_tree", { preparation: { targetId: "u1" } });
	assert.match(h.notes.at(-1)!.message, /restored 2 files/);
	await h.undo();
	assert.match(h.notes.at(-1)!.message, /reverted 2 files/);
	assert.equal(readFileSync(join(root, "locked/keep.txt"), "utf8"), "k\n");

	// Redoing the restore must delete locked/keep.txt. Inject a deletion failure.
	failDeletion(join(root, "locked/keep.txt"));
	await h.undo();
	const failed = h.notes.at(-1)!;
	assert.equal(failed.type, "error");
	assert.match(failed.message, /undo incomplete: 1 of 1 deletions failed \(locked\/keep.txt/);
	assert.match(failed.message, /run \/rewind-undo again; the state before this undo is git tree [0-9a-f]{40}/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n", "the rest of the undo still happened");
	const recovery = failed.message.match(/git tree ([0-9a-f]{40})/)![1];
	await h.undo();
	assert.equal(h.notes.at(-1)!.type, "error");
	assert.ok(h.notes.at(-1)!.message.includes(`git tree ${recovery}`), "repeated failures keep the original recovery tree");

	// The slot was kept: once the failure is fixed, the same undo goes through.
	resetFs();
	await h.undo();
	assert.match(h.notes.at(-1)!.message, /reverted 1 file/);
	assert.equal(existsSync(join(root, "locked/keep.txt")), false);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
	// Redo retains the whole state before the FIRST attempt, not the partially restored retry state.
	await h.undo();
	assert.match(h.notes.at(-1)!.message, /reverted 2 files/);
	assert.equal(readFileSync(join(root, "locked/keep.txt"), "utf8"), "k\n");
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "edited\n");
});

test("an invalid target fails before any deletion, naming every unperformed write", async () => {
	const { root, write } = repo();
	write("gone.txt", "keep me\n");
	const paths = ["a.txt", "b.txt", "c.txt", "d.txt"];
	const result = await applyTree(root, "0000000000000000000000000000000000000000", { remove: ["gone.txt"], write: paths });
	assert.equal(applySucceeded(result), false);
	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.written, []);
	assert.deepEqual(result.failedRemoves.map((f) => f.path), ["gone.txt"]);
	assert.deepEqual(result.failedWrites.map((f) => f.path), paths);
	assert.equal(readFileSync(join(root, "gone.txt"), "utf8"), "keep me\n");
	for (const path of paths) assert.ok(describeFailure(result)!.includes(path), path);
});

test("partial checkout reports actual written files and continues after a failed write", async () => {
	const { root, write } = repo();
	write("b.txt", "before\n");
	const before = (await snapshot(root))!;
	write("a.txt", "changed\n");
	write("b.txt", "changed\n");
	write("gone.txt", "g\n");
	const diff = (await diffTrees(root, before, (await snapshot(root))!))!;
	// A path absent from the target index produces a real, deterministic checkout-index error.
	// Git -f replaces ordinary directory/file blockers, so those are not failure fixtures.
	diff.write.unshift("not-in-target.txt");
	const result = await applyTree(root, before, diff);
	assert.equal(applySucceeded(result), false);
	assert.deepEqual(result.removed, ["gone.txt"]);
	assert.deepEqual(result.failedRemoves, []);
	assert.deepEqual(result.written, ["a.txt", "b.txt"]);
	assert.deepEqual(result.failedWrites.map((f) => f.path), ["not-in-target.txt"]);
	assert.match(describeFailure(result)!, /1 of 3 writes failed \(not-in-target.txt:/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
	assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "before\n");
});

function addCheckpoint(h: ReturnType<typeof harness>, root: string, tree: string) {
	h.entries.push({ id: "u1", type: "message", message: { role: "user", content: "x" } });
	h.entries.push({ id: "c1", type: "custom", customType: "rewind-checkpoint", data: { checkpoints: [{ entryId: "u1", kind: "pre", root, tree }] } });
}

test("a checkpoint in another repository never restores that repository's files", async () => {
	const original = repo();
	const tree = (await snapshot(original.root))!;
	original.write("a.txt", "original edits\n");
	const current = repo();
	current.write("a.txt", "current edits\n");
	const h = harness(current.root, "s1");
	addCheckpoint(h, original.root, tree);
	await h.emit("session_before_tree", { preparation: { targetId: "u1" } });
	assert.match(h.notes.at(-1)!.message, /not this repository; files not restored/);
	assert.equal(readFileSync(join(original.root, "a.txt"), "utf8"), "original edits\n");
	assert.equal(readFileSync(join(current.root, "a.txt"), "utf8"), "current edits\n");
	await h.undo();
	assert.match(h.notes.at(-1)!.message, /nothing to undo/);
});

test("legacy in-memory sessions without IDs do not share the undo slot", async () => {
	const { root, write } = repo();
	const h = harness(root, "");
	addCheckpoint(h, root, (await snapshot(root))!);
	write("a.txt", "edited\n");
	await h.emit("session_before_tree", { preparation: { targetId: "u1" } });
	await h.undo({ ...h.ctx, sessionManager: { ...h.ctx.sessionManager } });
	assert.match(h.notes.at(-1)!.message, /nothing to undo in this session/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
	await h.undo();
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "edited\n");
});

test("a pending pre-checkpoint retains the repository it was captured in", async () => {
	const original = repo();
	const current = repo();
	const h = harness(original.root, "s1");
	const message = { role: "user", content: "x", timestamp: 1 };
	h.entries.push({ id: "u1", type: "message", message });
	await h.emit("message_end", { message });
	h.ctx.cwd = current.root;
	await h.emit("agent_end", {});
	const data = h.entries.at(-1)!.data as { checkpoints: Array<{ kind: string; root: string }> };
	const pre = data.checkpoints.find((cp) => cp.kind === "pre")!;
	const post = data.checkpoints.find((cp) => cp.kind === "post")!;
	assert.equal(fs.realpathSync(pre.root), fs.realpathSync(original.root));
	assert.equal(fs.realpathSync(post.root), fs.realpathSync(current.root));
});
