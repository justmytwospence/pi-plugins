import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import extension from "../src/index.ts";
import { snapshot } from "../src/git.ts";
import { MARK_ENTRY, type Entry } from "../src/session.ts";
import type { DiffViewer } from "../src/viewer.ts";
import { fakeTui, gitRepo, makeTheme, strip } from "./helpers.ts";

test("index persists the displayed mark before custom UI closes; close never adds a mark", async () => {
	const repo = gitRepo();
	repo.write("file.txt", "before\n");
	repo.run("add", "-A");
	repo.run("commit", "-qm", "fixture");
	repo.write("file.txt", "displayed\n");
	const displayed = await snapshot(repo.root);
	const entries: Entry[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
	let open!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const api = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => handlers.set(name, handler),
		registerCommand: (_name: string, command: { handler: typeof open }) => { open = command.handler; },
		getCommands: () => [{ name: "rewind-undo" }],
		appendEntry: (customType: string, data: unknown) => entries.push({ id: String(entries.length), type: "custom", customType, data }),
		events: { emit() {} },
	};
	extension(api as unknown as ExtensionAPI);
	let viewer!: DiffViewer;
	let closed = false;
	let show!: () => void;
	const shown = new Promise<void>((resolve) => { show = resolve; });
	const ctx = {
		cwd: repo.root,
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: vi.fn(),
			custom: (factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void) => DiffViewer) => new Promise<void>((resolve) => {
				viewer = factory(fakeTui(), makeTheme("dark"), {} as KeybindingsManager, () => { closed = true; resolve(); });
				show();
			}),
		},
	} as unknown as ExtensionCommandContext;
	await handlers.get("session_start")!({}, ctx);
	const reviewing = open("unreviewed", ctx);
	await shown;
	// The disk advances after display: :mark must not recapture this unseen edit.
	repo.write("file.txt", "unseen\n");
	try {
		for (const key of [":", ..."mark", "\r"]) viewer.handleInput(key);
		expect(closed).toBe(false);
		expect(entries.filter((entry) => entry.customType === MARK_ENTRY)).toHaveLength(1);
		expect(entries.find((entry) => entry.customType === MARK_ENTRY)?.data).toMatchObject({ root: realpathSync(repo.root), tree: displayed });
		expect(viewer.render(120).map(strip).join("\n")).toContain("review stays open");
	} finally {
		viewer.handleInput("q");
		await reviewing;
	}
	expect(closed).toBe(true);
	expect(entries.filter((entry) => entry.customType === MARK_ENTRY)).toHaveLength(1);
});
