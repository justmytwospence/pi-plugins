import { Editor } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.ts";
import { type CommentEditor, EDITOR_FACTORY_CHANNEL, EDITOR_MODE, type EditorCreator, type EditorFactoryRequest, embeddedEditorFactory, INPUT_CONTEXT } from "../src/editor.ts";
import { diffTrees, snapshot } from "../src/git.ts";
import { parseDiff } from "../src/parse.ts";
import { resolveScope, type ResolvedScope, type ScopeRequest } from "../src/scopes.ts";
import { type EditorDrafts, type FileChecks, fileKey, type Turn } from "../src/session.ts";
import type { Thread } from "../src/threads.ts";
import { DiffViewer, type ReviewData, type ViewerHost } from "../src/viewer.ts";
import { fakeTui, gitRepo, makeTheme, strip } from "./helpers.ts";

async function setup() {
	const repo = gitRepo();
	repo.write("src/app.ts", "export function add(a: number, b: number) {\n\treturn a + b;\n}\n\nexport const x = 1;\n");
	repo.write("README.md", "# Demo\n");
	repo.run("add", "-A");
	repo.run("commit", "-qm", "init");
	const t0 = (await snapshot(repo.root)) as string;
	repo.write("src/app.ts", "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n\nexport const x = 2;\nexport const y = 3;\n");
	repo.write("notes/new.txt", "untracked file\n");
	const turns: Turn[] = [{ entryId: "u1", prompt: "make add typed", pre: t0 }];
	return { repo, turns, t0 };
}

async function load(root: string, turns: Turn[], req: ScopeRequest): Promise<ReviewData | string> {
	const scope = await resolveScope(req, { root, turns });
	if (typeof scope === "string") return scope;
	const p = await diffTrees(root, scope.base, scope.target);
	return { root, scope, files: parseDiff(p.stdout) };
}

function makeViewer(
	data: ReviewData,
	root: string,
	turns: Turn[],
	opts: { cols?: number; theme?: "dark" | "light"; checks?: FileChecks; editorDrafts?: EditorDrafts; threads?: Thread[]; editor?: EditorCreator } = {},
) {
	const tui = fakeTui(opts.cols ?? 120, 30);
	const sent: Thread[][] = [];
	const results: undefined[] = [];
	const marks: ResolvedScope[] = [];
	let persisted = 0;
	let pendingLoad: Promise<ReviewData | string> | undefined;
	const host: ViewerHost = {
		threads: opts.threads ?? [],
		checks: opts.checks ?? new Map(),
		editorDrafts: opts.editorDrafts ?? new Map(),
		editor: opts.editor,
		config: { ...DEFAULTS, view: "unified" },
		turns: () => turns,
		load: (q) => (pendingLoad = load(root, turns, q)),
		onMark: (scope) => { marks.push(scope); persisted++; },
		send: (drafts) => {
			sent.push(drafts.map((d) => ({ ...d })));
			for (const d of drafts) d.status = "sent";
			return `sent ${drafts.length}`;
		},
		persist: () => {
			persisted++;
		},
		open: async () => "opened",
		copy: async () => {},
	};
	// biome-ignore lint/suspicious/noExplicitAny: keybindings are unused by the viewer
	const v = new DiffViewer(tui, makeTheme(opts.theme ?? "dark"), {} as any, host, data, () => results.push(undefined));
	v.focused = true;
	const keys = (...ks: string[]) => {
		for (const k of ks) v.handleInput(k);
	};
	const screen = () => v.render(opts.cols ?? 120).map(strip);
	return { v, tui, host, sent, results, marks, keys, screen, persisted: () => persisted, loaded: () => pendingLoad };
}

describe("scopes against a real repository", () => {
	it("the unreviewed scope includes untracked files and the turn's edits", async () => {
		const { repo, turns } = await setup();
		const data = await load(repo.root, turns, { kind: "unreviewed" });
		if (typeof data === "string") throw new Error(data);
		expect(data.scope.label).toBe("unreviewed, since the session began");
		expect(data.files.map((f) => [f.status, f.newPath])).toEqual([
			["added", "notes/new.txt"],
			["modified", "src/app.ts"],
		]);
	});

	it("staged compares the index with HEAD", async () => {
		const { repo, turns } = await setup();
		repo.run("add", "src/app.ts");
		const data = await load(repo.root, turns, { kind: "staged" });
		if (typeof data === "string") throw new Error(data);
		expect(data.files.map((f) => f.newPath)).toEqual(["src/app.ts"]);
	});

	it("reports a missing turn history", async () => {
		const { repo } = await setup();
		expect(await load(repo.root, [], { kind: "turn" })).toBe("no turns recorded in this session yet");
	});
});

describe("DiffViewer", () => {
	it("renders exactly the terminal height with header, file list and footer", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { screen } = makeViewer(data, repo.root, turns);
		const s = screen();
		expect(s).toHaveLength(30);
		expect(s[0]).toContain("unreviewed, since the session began");
		expect(s[0]).toContain("2 files");
		expect(s.join("\n")).toContain("src/app.ts");
		expect(s.join("\n")).toContain("export const y = 3;");
		expect(s[29]).toContain(":w send");
	});

	it("renders in a light theme and split view without overflowing", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { v, keys } = makeViewer(data, repo.root, turns, { cols: 180, theme: "light" });
		keys("t");
		const lines = v.render(180);
		const { visibleWidth } = await import("@earendil-works/pi-tui");
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(180);
		expect(lines.map(strip).join("\n")).toContain("│");
	});

	it("comments on a line, sends it with :w and shows the reply", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { v, host, sent, keys, screen } = makeViewer(data, repo.root, turns);
		// Go to the y line via search, then comment.
		keys("/", ..."const y", "\r");
		keys("c", ..."why y?", "\r");
		expect(host.threads).toHaveLength(1);
		expect(host.threads[0]).toMatchObject({ file: "src/app.ts", side: "new", start: 6, end: 6, body: "why y?", status: "draft" });
		expect(screen().join("\n")).toContain("why y?");
		keys(":", "w", "\r");
		expect(sent).toHaveLength(1);
		expect(host.threads[0].status).toBe("sent");
		host.threads[0].reply = "y is needed by the caller";
		host.threads[0].status = "answered";
		v.refreshThreads();
		expect(screen().join("\n")).toContain("y is needed by the caller");
	});

	it("suggests an edit for a visual selection", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { host, keys } = makeViewer(data, repo.root, turns);
		keys("/", ..."const x = 2", "\r", "V", "j", "s");
		// The editor opens prefilled with the selected new lines; replace them.
		for (let i = 0; i < 60; i++) keys("\x7f");
		keys(..."export const x = 2;", "\r");
		expect(host.threads[0]).toMatchObject({ start: 5, end: 6, suggestion: "export const x = 2;" });
	});

	it("checks files reviewed, folds them and moves on; closing never marks the scope", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { results, keys, screen, host } = makeViewer(data, repo.root, turns);
		keys("g", "g", "r");
		expect(screen().join("\n")).toContain("✓ reviewed");
		expect(host.checks.get("notes/new.txt")).toBe(fileKey(data.files[0]));
		keys("q");
		expect(results).toEqual([undefined]);
	});

	it.each([[["q"]], [["Q"]], [["\x1b"]], [[":", "q", "\r"]], [[":", "q!", "\r"]], [[":", "wq", "\r"]], [[":", "x", "\r"]], [["Z", "Z"]], [["Z", "Q"]]])(
		"%j closes without marking",
		async (ks) => {
			const { repo, turns } = await setup();
			const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
			const { results, marks, keys } = makeViewer(data, repo.root, turns);
			keys(...ks);
			expect(results).toEqual([undefined]);
			expect(marks).toEqual([]);
		},
	);

	it("sending with :wq closes without marking; drafts become sent", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { results, marks, keys, host, sent } = makeViewer(data, repo.root, turns);
		keys("/", ..."const y", "\r", "c", ..."why?", "\r", ":", "wq", "\r");
		expect(sent).toHaveLength(1);
		expect(host.threads[0].status).toBe("sent");
		expect(results).toEqual([undefined]);
		expect(marks).toEqual([]);
	});

	it(":mark immediately persists the displayed snapshot, confirms and stays open for more live marks", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const a = makeViewer(data, repo.root, turns);
		// The working tree changes after the diff was loaded: marking must use what is on screen.
		repo.write("src/app.ts", "export const later = true;\n");
		a.keys(":", "mark", "\r");
		expect(a.marks).toEqual([data.scope]);
		expect(a.persisted()).toBe(1);
		expect(a.results).toEqual([]);
		expect(a.screen()[29]).toContain("displayed snapshot marked reviewed; review stays open");
		expect(a.marks[0].target).not.toBe(await snapshot(repo.root));

		// The same viewer can reload, display newer live content and immediately mark that snapshot too.
		a.keys("R");
		await a.loaded();
		a.keys(":", "mark", "\r");
		expect(a.marks).toHaveLength(2);
		expect(a.marks[1].target).toBe(await snapshot(repo.root));
		expect(a.persisted()).toBe(2);
		expect(a.results).toEqual([]);
		a.keys("q");
		expect(a.results).toEqual([undefined]);
		expect(a.marks).toHaveLength(2);

		const head = (await load(repo.root, turns, { kind: "head" })) as ReviewData;
		const h = makeViewer(head, repo.root, turns);
		h.keys(":", "mark", "\r");
		expect(h.marks).toEqual([]);
		expect(h.results).toEqual([]);
		expect(h.screen()[29]).toContain(":mark needs the unreviewed or session scope");

		const session = (await load(repo.root, turns, { kind: "session" })) as ReviewData;
		const z = makeViewer(session, repo.root, turns);
		z.keys(":", "mark", "\r");
		expect(z.marks).toEqual([session.scope]);
		expect(z.results).toEqual([]);
	});

	it("file checks persist across viewers and are dropped when the file's diff changes", async () => {
		const { repo, turns } = await setup();
		const checks: FileChecks = new Map();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const first = makeViewer(data, repo.root, turns, { checks });
		first.keys("g", "g", "r", "r");
		// The second `r` checks src/app.ts, where the cursor moved on to.
		expect([...checks.keys()].sort()).toEqual(["notes/new.txt", "src/app.ts"]);
		expect(first.persisted()).toBe(0);
		first.keys("q");
		expect(first.persisted()).toBe(1);

		// Reopened: both still checked and folded.
		const again = makeViewer((await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData, repo.root, turns, { checks });
		const text = again.screen().join("\n");
		expect(text.match(/✓ reviewed/g)).toHaveLength(2);
		expect(text).not.toContain("export const y = 3;");
		again.keys("q");

		// src/app.ts changes: its check is gone, the untouched file's stays.
		repo.write("src/app.ts", "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n\nexport const x = 2;\nexport const y = 4;\n");
		const changed = makeViewer((await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData, repo.root, turns, { checks });
		expect([...checks.keys()]).toEqual(["notes/new.txt"]);
		const shown = changed.screen().join("\n");
		expect(shown.match(/✓ reviewed/g)).toHaveLength(1);
		expect(shown).toContain("export const y = 4;");
		// Unchecking removes the check.
		changed.keys("g", "g", "r");
		expect(checks.size).toBe(0);
	});

	it("invalidates binary file checks when hidden blob content changes", async () => {
		const { repo, turns } = await setup();
		repo.write("asset.bin", "\0first");
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		expect(data.files[0]).toMatchObject({ binary: true, newPath: "asset.bin" });
		expect(data.files[0].newBlob).toMatch(/^[a-f0-9]{40}$/);
		const a = makeViewer(data, repo.root, turns);
		a.keys("g", "g", "r");
		expect(a.host.checks.has("asset.bin")).toBe(true);
		repo.write("asset.bin", "\0second");
		a.keys("R");
		await a.loaded();
		expect(a.host.checks.has("asset.bin")).toBe(false);
	});

	it("a cancelled comment is kept as a draft for the next editor on the same lines", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { host, keys, screen } = makeViewer(data, repo.root, turns);
		keys("/", ..."const y", "\r", "c", ..."half a tho", "\x1b");
		expect(host.threads).toHaveLength(0);
		expect(screen()[29]).toContain("draft kept");
		keys("c");
		expect(screen().join("\n")).toContain("continuing the draft");
		keys(..."ught", "\r");
		expect(host.threads[0]).toMatchObject({ body: "half a thought", start: 6, end: 6, status: "draft" });
		// Saved: the next editor there starts empty.
		keys("k", "c");
		expect(screen().join("\n")).not.toContain("continuing the draft");
		keys("\x1b");
		expect(screen()[29]).not.toContain("draft kept");
	});

	it("keeps multiple cancelled drafts across close/reopen without offering them on changed content", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const first = makeViewer(data, repo.root, turns);
		first.keys("/", ..."const y", "\r", "c", ..."line draft", "\x1b", "g", "g", "c", ..."file draft", "\x1b", "q");
		expect(first.host.editorDrafts.size).toBe(2);
		const editorDrafts = new Map(Object.entries(JSON.parse(JSON.stringify(Object.fromEntries(first.host.editorDrafts)))) as [string, string][]);
		const next = makeViewer(data, repo.root, turns, { editorDrafts });
		next.keys("g", "g", "c");
		expect(next.screen().join("\n")).toContain("file draft");
		next.keys("\x1b", "/", ..."const y", "\r", "c");
		expect(next.screen().join("\n")).toContain("line draft");
		next.keys("\r", "q");
		expect(editorDrafts.size).toBe(1);
		expect(next.host.threads[0]).toMatchObject({ body: "line draft", status: "draft" });

		repo.write("notes/new.txt", "changed content\n");
		const changed = makeViewer((await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData, repo.root, turns, { editorDrafts });
		changed.keys("g", "g", "c");
		expect(changed.screen().join("\n")).not.toContain("file draft");
		changed.v.dispose();
	});

	it("separates old/new-side comments and suggestions at the same line numbers", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const a = makeViewer(data, repo.root, turns);
		a.keys("/", ..."const x = 1", "\r", "c", ..."old side", "\x1b", "/", ..."const x = 2", "\r", "c");
		expect(a.screen().join("\n")).not.toContain("old side");
		a.keys(..."new side", "\x1b", "s");
		expect(a.screen().join("\n")).not.toContain("new side");
		a.keys("\x1b", "c");
		expect(a.screen().join("\n")).toContain("new side");
		a.keys("\x1b", "/", ..."const x = 1", "\r", "c");
		expect(a.screen().join("\n")).toContain("old side");
		a.v.dispose();
	});

	it("retains an empty cancelled suggestion as a deletion, not the original prefill", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const first = makeViewer(data, repo.root, turns);
		first.keys("/", ..."const y", "\r", "s", ...Array<string>(100).fill("\x7f"), "\x1b", "q");
		expect([...first.host.editorDrafts.values()]).toEqual([""]);
		const next = makeViewer(data, repo.root, turns, { editorDrafts: first.host.editorDrafts });
		next.keys("/", ..."const y", "\r", "s", "\r");
		expect(next.host.threads[0]).toMatchObject({ suggestion: "", status: "draft", start: 6 });
		expect(next.host.editorDrafts.size).toBe(0);
	});

	it("does not mix cancelled edits of different threads with identical display titles", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const threads: Thread[] = ["abcd", "efgh"].map((id, i) => ({ id, file: "src/app.ts", side: "new", start: 6, end: 6, excerpt: ["+ export const y = 3;"], body: `${id} original`, status: "answered", reply: "answer", createdAt: i }));
		const a = makeViewer(data, repo.root, turns, { threads });
		a.keys("/", ..."abcd original", "\r", "e", ..." edited", "\x1b", "/", ..."efgh original", "\r", "e");
		expect(a.screen().join("\n")).not.toContain("abcd original edited");
		a.keys("\x1b", "/", ..."abcd original", "\r", "e", "\r");
		expect(threads[0]).toMatchObject({ body: "abcd original edited", status: "draft", reply: undefined });
		expect(threads[1]).toMatchObject({ body: "efgh original", status: "answered", reply: "answer" });
	});

	it.each(["turn", "head", "staged", "branch", "ref"] as const)("does not :mark a %s scope, even when its target is live", async (kind) => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const a = makeViewer({ ...data, scope: { ...data.scope, request: { kind }, live: true } }, repo.root, turns);
		a.keys(":", "mark", "\r");
		expect(a.marks).toEqual([]);
		expect(a.results).toEqual([]);
	});

	it("does not :mark a historical snapshot even if it is labelled unreviewed", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const a = makeViewer({ ...data, scope: { ...data.scope, live: false } }, repo.root, turns);
		a.keys(":", "mark", "\r");
		expect(a.marks).toEqual([]);
		expect(a.results).toEqual([]);
	});

	it("rechecks content on reload and ignores late loads after the viewer closes", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const a = makeViewer(data, repo.root, turns);
		a.keys("g", "g", "r");
		repo.write("notes/new.txt", "changed content\n");
		a.keys("R");
		await a.loaded();
		expect(a.host.checks.size).toBe(0);
		expect(a.screen().join("\n")).toContain("changed content");
		let finish!: (value: ReviewData) => void;
		a.host.load = () => new Promise((resolve) => { finish = resolve; });
		a.keys("R", "q");
		const renders = a.tui.renders;
		finish({ ...data, scope: { ...data.scope, label: "late load" } });
		await Promise.resolve();
		expect(a.tui.renders).toBe(renders);
		expect(a.screen()[0]).not.toContain("late load");
		a.keys(":", "mark", "\r", "q");
		expect(a.results).toHaveLength(1);
	});

	it("Q closes without marking, and help toggles", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { results, keys, screen } = makeViewer(data, repo.root, turns);
		keys("?");
		expect(screen().join("\n")).toContain("Keys");
		keys("x", "Q");
		expect(results).toEqual([undefined]);
	});

	it("switches scope from the picker", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { keys, screen, loaded } = makeViewer(data, repo.root, turns);
		keys("S");
		expect(screen().join("\n")).toContain("Last turn");
		keys("\x1b", ":", "scope head", "\r");
		await loaded();
		expect(screen()[0]).toContain("uncommitted vs HEAD");
	});
});

describe("comment editor factory", () => {
	/** A fake Pi event bus with an optional provider answering the factory request. */
	function bus(factory?: EditorFactoryRequest["factory"]) {
		const requests: EditorFactoryRequest[] = [];
		const events = {
			emit: (channel: string, data: unknown) => {
				expect(channel).toBe(EDITOR_FACTORY_CHANNEL);
				const r = data as EditorFactoryRequest;
				requests.push(r);
				if (factory && !r.factory) {
					r.factory = factory;
					r.provider = "fake-vim";
				}
			},
			on: () => () => {},
		};
		return { events, requests };
	}

	/** A modal editor over Pi's native one: Escape leaves Insert mode, Escape again cancels. */
	function modalFactory(log: string[]): EditorFactoryRequest["factory"] {
		return (options) => {
			log.push(`surface=${options.surface} mode=${options.initialMode} text=${JSON.stringify(options.initialText)} paddingX=${options.paddingX}`);
			const native = new Editor(options.tui, options.theme, { paddingX: options.paddingX ?? 0 });
			native.setText(options.initialText ?? "");
			native.onSubmit = options.onSubmit;
			let state: "insert" | "normal" = options.initialMode ?? "insert";
			const editor = Object.assign(native, {
				dispose: () => log.push("dispose"),
				[EDITOR_MODE]: () => ({ state, autocomplete: false }),
			}) as CommentEditor & { handleInput(data: string): void };
			const handle = native.handleInput.bind(native);
			editor.handleInput = (data: string) => {
				if (data === "\x1b") {
					if (state === "insert") state = "normal";
					else options.onCancel();
					return;
				}
				if (state === "normal") {
					if (data === "i") state = "insert";
					else if (data === "\x04") options.scrollViewport?.(1);
					else if (data === "\x15") options.scrollViewport?.(-1);
					else if (data === ":") {
						// `:w` submits through the provider's own path.
						options.onSubmit(native.getText());
					}
					return;
				}
				handle(data);
			};
			return editor;
		};
	}

	it("uses Pi's native editor when nobody answers, or the provider throws", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const silent = bus();
		const a = makeViewer(data, repo.root, turns, { editor: embeddedEditorFactory(silent as never) });
		a.keys("/", ..."const y", "\r", "c", ..."native", "\r");
		expect(silent.requests).toEqual([{ version: 1 }]);
		expect(a.host.threads[0]).toMatchObject({ body: "native" });

		const broken = bus(() => {
			throw new Error("no editor for you");
		});
		const b = makeViewer(data, repo.root, turns, { editor: embeddedEditorFactory(broken as never) });
		b.keys("/", ..."const y", "\r", "c", ..."still native", "\r");
		expect(b.host.threads[0]).toMatchObject({ body: "still native" });
		expect(b.screen().join("\n")).toContain("still native");
	});

	it("uses the provider's editor, which owns Escape and scrolls the diff", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const log: string[] = [];
		const provided = bus(modalFactory(log));
		const { host, keys, screen, v } = makeViewer(data, repo.root, turns, { editor: embeddedEditorFactory(provided as never) });
		keys("/", ..."const y", "\r", "c");
		expect(log).toEqual(['surface=embedded mode=insert text="" paddingX=1']);
		expect(screen().join("\n")).toContain(":w or enter save");
		keys(..."typed", "\x1b");
		// First Escape only left Insert mode: the editor is still open with its text.
		expect(host.threads).toHaveLength(0);
		expect(screen().join("\n")).toContain("typed");
		// Ctrl+U / Ctrl+D in Normal mode move through the diff behind the editor by half a page.
		// biome-ignore lint/suspicious/noExplicitAny: the cursor row is private
		const cursor = () => (v as any).cursor as number;
		const before = cursor();
		keys("\x15");
		expect(cursor()).toBeLessThan(before);
		keys("\x04");
		expect(cursor()).toBeGreaterThanOrEqual(before);
		// Escape again cancels: the draft is kept, the editor disposed.
		keys("\x1b");
		expect(log).toContain("dispose");
		expect(screen()[29]).toContain("draft kept");
		expect(host.threads).toHaveLength(0);
		// Back on the line, the draft comes back; `:` submits through the provider.
		keys("/", ..."const y", "\r", "c");
		expect(log.at(-1)).toBe('surface=embedded mode=insert text="typed" paddingX=1');
		keys("\x1b", ":");
		expect(host.threads[0]).toMatchObject({ body: "typed", status: "draft" });
		expect(log.filter((l) => l === "dispose")).toHaveLength(2);
		// A suggestion opens in Normal mode on the selected lines.
		keys("V", "s");
		expect(log.at(-1)).toMatch(/^surface=embedded mode=normal text="export const y = 3;"/);
		v.invalidate();
		v.dispose();
		expect(log.filter((l) => l === "dispose")).toHaveLength(3);
	});

	it("discovers the provider at editor-open time, cleans invalid providers up and falls back locally", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const log: string[] = [];
		const provided = bus();
		const a = makeViewer(data, repo.root, turns, { editor: embeddedEditorFactory(provided as never) });
		expect(provided.requests).toHaveLength(0);
		const emit = provided.events.emit;
		provided.events.emit = (channel, payload) => {
			emit(channel, payload);
			(payload as EditorFactoryRequest).factory = () => ({ render: () => [], handleInput: () => {}, dispose: () => log.push("invalid disposed") }) as never;
		};
		a.keys("/", ..."const y", "\r", "c", ..."fallback", "\r");
		expect(log).toEqual(["invalid disposed"]);
		expect(a.host.threads[0].body).toBe("fallback");

		provided.events.emit = () => { throw new Error("bus failed"); };
		a.keys("k", "c", ..."bus fallback", "\r");
		expect(a.host.threads[1].body).toBe("bus fallback");
	});

	it("preserves the provider's submit handling instead of overwriting it", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const provided = bus((options) => {
			const native = new Editor(options.tui, options.theme);
			native.setText(options.initialText ?? "");
			native.onSubmit = (text) => options.onSubmit(`provider: ${text}`);
			return native;
		});
		const a = makeViewer(data, repo.root, turns, { editor: embeddedEditorFactory(provided as never) });
		a.keys("/", ..."const y", "\r", "c", ..."typed", "\r");
		expect(a.host.threads[0].body).toBe("provider: typed");
		expect(a.marks).toEqual([]);
	});

	it("forwards popup Escape to the native editor instead of cancelling the draft", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		let popup = true;
		const editor: EditorCreator = (request) => {
			const native = new Editor(request.tui, request.theme);
			native.setText(request.initialText);
			native.onSubmit = request.onSubmit;
			native.isShowingAutocomplete = () => popup;
			const handle = native.handleInput.bind(native);
			native.handleInput = (key) => {
				if (key === "\x1b") popup = false;
				else handle(key);
			};
			return native;
		};
		const a = makeViewer(data, repo.root, turns, { editor });
		a.keys("/", ..."const y", "\r", "c", ..."typed", "\x1b");
		expect(a.v[INPUT_CONTEXT]()).toBe("editor");
		expect(a.host.editorDrafts.size).toBe(0);
		a.keys("\x1b");
		expect(a.v[INPUT_CONTEXT]()).toBe("viewer");
		expect([...a.host.editorDrafts.values()]).toEqual(["typed"]);
	});

	it("disposes externally closed editors once, persists text, and ignores stale provider callbacks", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const log: string[] = [];
		let options!: Parameters<NonNullable<EditorFactoryRequest["factory"]>>[0];
		const provided = bus((request) => {
			options = request;
			return modalFactory(log)!(request);
		});
		const a = makeViewer(data, repo.root, turns, { editor: embeddedEditorFactory(provided as never) });
		a.keys("/", ..."const y", "\r", "c", ..."unfinished");
		a.v.dispose();
		a.v.dispose();
		const renders = a.tui.renders;
		options.onCancel();
		options.onSubmit("stale save");
		options.scrollViewport?.(1);
		options.notify?.("stale message", "warning");
		expect(options.onExCommand?.("mark", "", "mark")).toBe(false);
		expect(a.tui.renders).toBe(renders);
		expect(log.filter((s) => s === "dispose")).toHaveLength(1);
		expect(a.host.threads).toEqual([]);
		expect([...a.host.editorDrafts.values()]).toEqual(["unfinished"]);
		const next = makeViewer(data, repo.root, turns, { editorDrafts: a.host.editorDrafts });
		next.keys("/", ..."const y", "\r", "c");
		expect(next.screen().join("\n")).toContain("unfinished");
		next.v.dispose();
	});
});
