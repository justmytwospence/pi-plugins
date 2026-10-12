import { describe, expect, it } from "vitest";
import { applyBgRanges, expandRanges, expandTabs } from "../src/ansi.ts";
import { intraline } from "../src/intraline.ts";
import { anchorThread, layout, selectionFromRows } from "../src/model.ts";
import { parseDiff, unquote } from "../src/parse.ts";
import { parseScopeArgs } from "../src/scopes.ts";
import { CHECKS_ENTRY, DRAFTS_ENTRY, fileKey, isChecked, lastChecks, lastDrafts, lastMark, lastThreads, MARK_ENTRY, pruneChecks, REWIND_ENTRY, THREADS_ENTRY, turnsOnBranch } from "../src/session.ts";
import { buildPrompt, parseReplies, type Thread } from "../src/threads.ts";
import { strip } from "./helpers.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function top()
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
diff --git a/new file.md b/new file.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new file.md
@@ -0,0 +1,2 @@
+# Title
+text
\\ No newline at end of file
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/x.bin b/x.bin
index 5555555..6666666 100644
Binary files a/x.bin and b/x.bin differ
diff --git a/from.ts b/to.ts
similarity index 100%
rename from from.ts
rename to to.ts
diff --git "a/tab\\there" "b/tab\\there"
index 7777777..8888888 100644
--- "a/tab\\there"
+++ "b/tab\\there"
@@ -1 +1 @@
-x
+y
`;

describe("parseDiff", () => {
	const files = parseDiff(PATCH);
	it("finds every file with its status", () => {
		expect(files.map((f) => [f.status, f.newPath])).toEqual([
			["modified", "src/a.ts"],
			["added", "new file.md"],
			["deleted", "old.txt"],
			["modified", "x.bin"],
			["renamed", "to.ts"],
			["modified", "tab\there"],
		]);
	});
	it("numbers lines on both sides and counts changes", () => {
		const f = files[0];
		expect(f.additions).toBe(2);
		expect(f.deletions).toBe(1);
		expect(f.hunks[0].section).toBe("function top()");
		expect(f.hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
			["context", 1, 1],
			["del", 2, undefined],
			["add", undefined, 2],
			["add", undefined, 3],
			["context", 3, 4],
			["context", 4, 5],
		]);
	});
	it("marks no-newline, binary and renames", () => {
		expect(files[1].hunks[0].lines[1].noNewline).toBe(true);
		expect(files[3]).toMatchObject({ binary: true, oldBlob: "5555555", newBlob: "6666666", oldMode: "100644", newMode: "100644" });
		expect(files[4].oldPath).toBe("from.ts");
		expect(files[4].hunks).toEqual([]);
	});
	it("unquotes C-style paths including octal UTF-8", () => {
		expect(unquote('"caf\\303\\251"')).toBe("café");
		expect(unquote("plain")).toBe("plain");
	});
});

describe("intraline", () => {
	it("marks only the changed words", () => {
		const r = intraline("const b = 2;", "const b = 3;");
		expect(r?.old).toEqual([{ start: 10, end: 11 }]);
		expect(r?.new).toEqual([{ start: 10, end: 11 }]);
	});
	it("gives up when nothing but whitespace is shared", () => {
		expect(intraline("alpha beta", "gamma delta")).toBeUndefined();
	});
});

describe("ansi", () => {
	it("expands tabs and maps ranges", () => {
		expect(expandTabs("\tx")).toBe("    x");
		expect(expandRanges("\tx", [{ start: 1, end: 2 }])).toEqual([{ start: 4, end: 5 }]);
	});
	it("applies a background to ranges and keeps it through fg resets", () => {
		const s = applyBgRanges("ab\x1b[31mcd\x1b[39mef", [{ start: 1, end: 4 }], "<ON>", "<BASE>");
		expect(s).toBe("<BASE>a<ON>b\x1b[31mcd\x1b[39m<BASE>ef");
		expect(applyBgRanges("a\x1b[0mb", [], "<ON>", "<B>")).toBe("<B>a\x1b[0m<B>b");
	});
});

const thread = (over: Partial<Thread> = {}): Thread => ({
	id: "abcd",
	file: "src/a.ts",
	side: "new",
	start: 2,
	end: 3,
	excerpt: ["- const b = 2;", "+ const b = 3;", "+ const c = 4;"],
	body: "why 4?",
	status: "draft",
	createdAt: 1,
	...over,
});

describe("layout", () => {
	const files = parseDiff(PATCH);
	const base = { folded: new Set<string>(), expanded: new Set<string>(), threads: [] as Thread[], maxLines: 1000 };

	it("pairs removals with additions in unified mode", () => {
		const { rows } = layout(files, { ...base, mode: "unified" });
		const lines = rows.filter((r) => r.kind === "line" && r.file === 0);
		const del = lines.find((r) => r.kind === "line" && r.line.kind === "del");
		expect(del?.kind === "line" && del.pair?.text).toBe("const b = 3;");
	});

	it("builds side-by-side rows with a blank side for unpaired additions", () => {
		const { rows } = layout(files, { ...base, mode: "split" });
		const split = rows.filter((r) => r.kind === "split" && r.file === 0);
		expect(split.map((r) => r.kind === "split" && [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
			["const a = 1;", "const a = 1;"],
			["const b = 2;", "const b = 3;"],
			[null, "const c = 4;"],
			["const d = 5;", "const d = 5;"],
			["const e = 6;", "const e = 6;"],
		]);
	});

	it("anchors threads under their last line, and re-anchors moved text", () => {
		const { rows } = layout(files, { ...base, mode: "unified", threads: [thread()] });
		const i = rows.findIndex((r) => r.kind === "thread");
		const prev = rows[i - 1];
		expect(prev.kind === "line" && prev.line.text).toBe("const c = 4;");

		const moved = thread({ start: 9, end: 9, excerpt: ["+ const c = 4;"] });
		const a = anchorThread(rows, 0, rows.length, moved);
		expect(a.outdated).toBe(false);
		const r = rows[a.after];
		expect(r.kind === "line" && r.line.newLine).toBe(3);
	});

	it("collects threads on files outside the diff", () => {
		const { rows, orphanStart } = layout(files, { ...base, mode: "unified", threads: [thread({ file: "elsewhere.ts" })] });
		expect(orphanStart).toBeDefined();
		expect(rows[rows.length - 1].kind).toBe("thread");
	});

	it("folds files and hides large ones behind a note", () => {
		const folded = layout(files, { ...base, mode: "unified", folded: new Set(["src/a.ts"]) });
		expect(folded.rows[1].kind).toBe("file");
		const big = layout(files, { ...base, mode: "unified", maxLines: 2 });
		expect(big.rows[1]).toMatchObject({ kind: "note", expand: true });
	});

	it("turns a row span into a selection on the new side", () => {
		const { rows } = layout(files, { ...base, mode: "unified" });
		const from = rows.findIndex((r) => r.kind === "line" && r.line.kind === "del");
		const sel = selectionFromRows(rows, from, from + 2);
		expect(sel).toMatchObject({ side: "new", start: 2, end: 3 });
		expect(sel?.excerpt).toEqual(["- const b = 2;", "+ const b = 3;", "+ const c = 4;"]);
		const onlyDel = selectionFromRows(rows, from, from);
		expect(onlyDel).toMatchObject({ side: "old", start: 2, end: 2 });
	});
});

describe("threads", () => {
	it("builds a prompt that quotes the lines and asks for tagged replies", () => {
		const p = buildPrompt([thread(), thread({ id: "wxyz", suggestion: "const c = 5;", body: "" })], "last turn");
		expect(p).toContain("[[dr:abcd]] `src/a.ts` lines 2-3");
		expect(p).toContain("```diff\n- const b = 2;");
		expect(p).toContain("Replace:\n```ts\nconst b = 2;\nconst b = 3;\nconst c = 4;\n```\nwith:\n```ts\nconst c = 5;\n```");
		expect(p).toMatch(/\[\[dr:wxyz\]\] <what you changed/);
	});
	it("parses replies, ignoring the template line", () => {
		const r = parseReplies("Done.\n\n- [[dr:abcd]] Changed it to 3.\n[[dr:wxyz]]: applied\n[[dr:zzzz]] <what you changed, or your answer>");
		expect([...r]).toEqual([
			["abcd", "Changed it to 3."],
			["wxyz", "applied"],
		]);
	});
});

describe("session", () => {
	const root = "/repo";
	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: "first task", timestamp: 1 } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [] } },
		{ id: "c1", type: "custom", customType: REWIND_ENTRY, data: { checkpoints: [{ entryId: "u1", kind: "pre", root, tree: "t0" }, { entryId: "a1", kind: "post", root, tree: "t1" }] } },
		{ id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 } },
		{ id: "c2", type: "custom", customType: REWIND_ENTRY, data: { checkpoints: [{ entryId: "u2", kind: "pre", root, tree: "t1b" }] } },
		{ id: "m", type: "custom", customType: MARK_ENTRY, data: { root, tree: "t1", at: 5 } },
		{ id: "th", type: "custom", customType: THREADS_ENTRY, data: { root, threads: [thread()] } },
		{ id: "other", type: "custom", customType: REWIND_ENTRY, data: { checkpoints: [{ entryId: "u2", kind: "pre", root: "/elsewhere", tree: "zz" }] } },
	];
	it("reads turns with pre and post snapshots for this root", () => {
		expect(turnsOnBranch(branch, root)).toEqual([
			{ entryId: "u1", prompt: "first task", pre: "t0", post: "t1", timestamp: 1 },
			{ entryId: "u2", prompt: "second", pre: "t1b", timestamp: 2 },
		]);
	});
	it("reads the last mark and threads", () => {
		expect(lastMark(branch, root)?.tree).toBe("t1");
		expect(lastThreads(branch, root)).toHaveLength(1);
		expect(lastThreads(branch, "/elsewhere")).toHaveLength(0);
	});
	it("reads the last file checks for this root, and drops checks whose diff changed", () => {
		const files = parseDiff(PATCH);
		const a = files[0];
		const withChecks = [
			...branch,
			{ id: "k1", type: "custom", customType: CHECKS_ENTRY, data: { root, checks: { "src/a.ts": "stale", "old.txt": fileKey(files[2]), bogus: 3 } } },
			{ id: "k2", type: "custom", customType: CHECKS_ENTRY, data: { root: "/elsewhere", checks: { "src/a.ts": fileKey(a) } } },
		];
		const checks = lastChecks(withChecks, root);
		expect([...checks.keys()]).toEqual(["src/a.ts", "old.txt"]);
		expect(isChecked(checks, a)).toBe(false);
		expect(isChecked(checks, files[2])).toBe(true);
		expect(pruneChecks(checks, files)).toBe(true);
		expect([...checks.keys()]).toEqual(["old.txt"]);
		expect(pruneChecks(checks, files)).toBe(false);
		// The key follows the diff's content, not just the path.
		const other = parseDiff(PATCH.replace("+const c = 4;", "+const c = 5;"))[0];
		expect(fileKey(other)).not.toBe(fileKey(a));
		expect(fileKey(parseDiff(PATCH)[0])).toBe(fileKey(a));
		expect(lastChecks(branch, root).size).toBe(0);
	});

	it("keys binary content, modes, paths and no-newline markers without collisions", () => {
		const files = parseDiff(PATCH);
		expect(fileKey(parseDiff(PATCH.replace("5555555..6666666", "5555555..9999999"))[3])).not.toBe(fileKey(files[3]));
		expect(fileKey({ ...files[3], newMode: "100755" })).not.toBe(fileKey(files[3]));
		expect(fileKey({ ...files[3], newPath: "other.bin" })).not.toBe(fileKey(files[3]));
		const f = files[0];
		const line = (text: string, noNewline: boolean) => ({ ...f, hunks: [{ ...f.hunks[0], lines: [{ kind: "add" as const, text, noNewline }] }] });
		expect(fileKey(line("x\\", false))).not.toBe(fileKey(line("x", true)));
	});

	it("restores root/branch-local cancelled drafts, including empty suggestions", () => {
		const entries = [
			{ id: "d1", type: "custom", customType: DRAFTS_ENTRY, data: { root, drafts: { comment: "partial", suggestion: "", bad: 3 } } },
			{ id: "d2", type: "custom", customType: DRAFTS_ENTRY, data: { root: "/elsewhere", drafts: { comment: "foreign" } } },
		];
		expect([...lastDrafts(entries, root)]).toEqual([["comment", "partial"], ["suggestion", ""]]);
		expect(lastDrafts([], root).size).toBe(0);
		expect(lastDrafts([...entries, { id: "d3", type: "custom", customType: DRAFTS_ENTRY, data: { root, drafts: {} } }], root).size).toBe(0);
		const malformed = { id: "bad", type: "custom", data: { root, drafts: ["invalid"], checks: ["invalid"] } };
		expect(lastDrafts([...entries, { ...malformed, customType: DRAFTS_ENTRY }], root).get("comment")).toBe("partial");
		expect(lastChecks([{ ...malformed, customType: CHECKS_ENTRY }], root).size).toBe(0);
	});

	it("copies restored thread excerpts instead of mutating persisted branch entries", () => {
		const restored = lastThreads(branch, root);
		restored[0].body = "changed";
		restored[0].excerpt.push("new line");
		expect(lastThreads(branch, root)[0]).toEqual(thread());
	});
});

describe("parseScopeArgs", () => {
	it("understands scope words and falls back to a ref", () => {
		expect(parseScopeArgs("")).toBeUndefined();
		expect(parseScopeArgs("turn 3")).toEqual({ kind: "turn", turn: 3 });
		expect(parseScopeArgs("--cached")).toEqual({ kind: "staged" });
		expect(parseScopeArgs("branch develop")).toEqual({ kind: "branch", ref: "develop" });
		expect(parseScopeArgs("HEAD~2")).toEqual({ kind: "ref", ref: "HEAD~2" });
	});
	it("strip helper works", () => {
		expect(strip("\x1b[31mx\x1b[0m")).toBe("x");
	});
});

describe("herdr", async () => {
	const { herdrActive, openInSplit, withZoom } = await import("../src/herdr.ts");
	const bus = (active: boolean) => {
		const sent: [string, any][] = [];
		return {
			sent,
			emit(channel: string, data: any) {
				sent.push([channel, data]);
				if (!active) return;
				if (channel === "herdr:probe") data.reply();
				if (channel === "herdr:split") data.done(true, "w1:p2");
			},
		};
	};
	it("zooms through pi-herdr while the action runs", async () => {
		const b = bus(true);
		expect(await withZoom(b, true, async () => 7)).toBe(7);
		expect(b.sent).toEqual([["herdr:zoom", { active: true }], ["herdr:zoom", { active: false }]]);
		const off = bus(true);
		await withZoom(off, false, async () => 0);
		expect(off.sent).toEqual([]);
	});
	it("opens a split through pi-herdr, or says it needs it", async () => {
		const b = bus(true);
		expect(herdrActive(b)).toBe(true);
		expect(await openInSplit(b, "/r", "a b.ts", 3)).toContain("opened a b.ts:3");
		expect(b.sent.at(-1)![1]).toMatchObject({ cwd: "/r" });
		expect(b.sent.at(-1)![1].command).toMatch(/ \+3 'a b\.ts'$/);
		expect(await openInSplit(bus(false), "/r", "x", undefined)).toContain("needs herdr and pi-herdr");
	});
});
