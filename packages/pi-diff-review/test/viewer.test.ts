import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.ts";
import { diffTrees, snapshot } from "../src/git.ts";
import { parseDiff } from "../src/parse.ts";
import { resolveScope, type ScopeRequest } from "../src/scopes.ts";
import type { Turn } from "../src/session.ts";
import type { Thread } from "../src/threads.ts";
import { DiffViewer, type ReviewData, type ViewerHost, type ViewerResult } from "../src/viewer.ts";
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

function makeViewer(data: ReviewData, root: string, turns: Turn[], opts: { cols?: number; theme?: "dark" | "light" } = {}) {
	const tui = fakeTui(opts.cols ?? 120, 30);
	const sent: Thread[][] = [];
	const results: ViewerResult[] = [];
	const host: ViewerHost = {
		threads: [],
		config: { ...DEFAULTS, view: "unified" },
		turns: () => turns,
		load: (q) => load(root, turns, q),
		send: (drafts) => {
			sent.push(drafts.map((d) => ({ ...d })));
			for (const d of drafts) d.status = "sent";
			return `sent ${drafts.length}`;
		},
		persist: () => {},
		open: async () => "opened",
		copy: async () => {},
	};
	// biome-ignore lint/suspicious/noExplicitAny: keybindings are unused by the viewer
	const v = new DiffViewer(tui, makeTheme(opts.theme ?? "dark"), {} as any, host, data, (r) => results.push(r));
	v.focused = true;
	const keys = (...ks: string[]) => {
		for (const k of ks) v.handleInput(k);
	};
	const screen = () => v.render(opts.cols ?? 120).map(strip);
	return { v, tui, host, sent, results, keys, screen };
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

	it("marks files reviewed, folds them and moves on; q closes and marks the scope", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { results, keys, screen } = makeViewer(data, repo.root, turns);
		keys("g", "g", "r");
		expect(screen().join("\n")).toContain("✓ reviewed");
		keys("q");
		expect(results).toEqual([expect.objectContaining({ markReviewed: true })]);
	});

	it("Q closes without marking, and help toggles", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { results, keys, screen } = makeViewer(data, repo.root, turns);
		keys("?");
		expect(screen().join("\n")).toContain("Keys");
		keys("x", "Q");
		expect(results).toEqual([expect.objectContaining({ markReviewed: false })]);
	});

	it("switches scope from the picker", async () => {
		const { repo, turns } = await setup();
		const data = (await load(repo.root, turns, { kind: "unreviewed" })) as ReviewData;
		const { keys, screen } = makeViewer(data, repo.root, turns);
		keys("S");
		expect(screen().join("\n")).toContain("Last turn");
		keys("\x1b", ":", "scope head", "\r");
		await new Promise((r) => setTimeout(r, 300));
		expect(screen()[0]).toContain("uncommitted vs HEAD");
	});
});
