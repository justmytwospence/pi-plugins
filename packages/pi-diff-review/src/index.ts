/**
 * pi-diff-review: review what the agent changed, the way you would review a pull
 * request, without leaving pi.
 *
 * /diff opens a full-screen diff of everything you have not reviewed yet (or a
 * turn, the session, HEAD, the index, a branch). Comment on lines or suggest
 * edits with vim keys; :w sends them to the agent as one message, and the agent's
 * per-comment replies show up under each comment.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig } from "./config.ts";
import { embeddedEditorFactory } from "./editor.ts";
import { diffTrees, repoRoot, snapshot } from "./git.ts";
import { openInSplit, withZoom } from "./herdr.ts";
import { parseDiff } from "./parse.ts";
import { defaultScope, parseScopeArgs, resolveScope, type ScopeRequest } from "./scopes.ts";
import {
	CHECKPOINT_ENTRY,
	CHECKS_ENTRY,
	type Checkpoint,
	DRAFTS_ENTRY,
	type EditorDrafts,
	type Entry,
	type FileChecks,
	lastChecks,
	lastDrafts,
	lastMark,
	lastThreads,
	MARK_ENTRY,
	messageText,
	THREADS_ENTRY,
	turnsOnBranch,
} from "./session.ts";
import { buildPrompt, parseReplies, type Thread } from "./threads.ts";
import { DiffViewer, type ReviewData } from "./viewer.ts";

const SCOPE_COMPLETIONS = [
	{ value: "unreviewed", label: "unreviewed", description: "everything since your last review (default)" },
	{ value: "turn", label: "turn", description: "the last agent run; turn 2 is the one before" },
	{ value: "session", label: "session", description: "everything this session changed" },
	{ value: "head", label: "head", description: "uncommitted changes vs HEAD" },
	{ value: "staged", label: "staged", description: "the index vs HEAD" },
	{ value: "branch", label: "branch", description: "vs the merge base with the default branch" },
];

export default function (pi: ExtensionAPI) {
	let config: Config = loadConfig();
	let root: string | undefined;
	let rootResolved = false;
	/** Threads for the current root on the current branch; the viewer shares this array. */
	const threads: Thread[] = [];
	let savedThreads = "[]";
	/** Files checked with `r`, keyed by the diff seen; the viewer shares this map. */
	const checks: FileChecks = new Map();
	let savedChecks = "{}";
	const editorDrafts: EditorDrafts = new Map();
	let savedDrafts = "{}";
	const editor = embeddedEditorFactory(pi);
	/** Without pi-rewind we record the turn checkpoints ourselves. */
	let ownCheckpoints = true;
	let pending: { message: unknown; timestamp: unknown; tree: string }[] = [];
	let viewer: DiffViewer | undefined;

	function disposeViewer(): void {
		viewer?.dispose();
	}

	async function getRoot(cwd: string): Promise<string | undefined> {
		if (!rootResolved) {
			root = await repoRoot(cwd);
			rootResolved = true;
		}
		return root;
	}

	function branch(ctx: ExtensionContext): Entry[] {
		return ctx.sessionManager.getBranch() as unknown as Entry[];
	}

	function loadThreads(ctx: ExtensionContext): void {
		threads.length = 0;
		checks.clear();
		editorDrafts.clear();
		if (root) {
			threads.push(...lastThreads(branch(ctx), root));
			for (const [k, v] of lastChecks(branch(ctx), root)) checks.set(k, v);
			for (const [k, v] of lastDrafts(branch(ctx), root)) editorDrafts.set(k, v);
		}
		savedThreads = JSON.stringify(threads);
		savedChecks = JSON.stringify(Object.fromEntries(checks));
		savedDrafts = JSON.stringify(Object.fromEntries(editorDrafts));
	}

	/** Write immutable snapshots: Pi retains entry data in memory as well as on disk. */
	function persist(): void {
		if (!root) return;
		const now = JSON.stringify(threads);
		if (now !== savedThreads) {
			pi.appendEntry(THREADS_ENTRY, { root, threads: JSON.parse(now) });
			savedThreads = now;
		}
		const checked = JSON.stringify(Object.fromEntries(checks));
		if (checked !== savedChecks) {
			pi.appendEntry(CHECKS_ENTRY, { root, checks: JSON.parse(checked) });
			savedChecks = checked;
		}
		const drafts = JSON.stringify(Object.fromEntries(editorDrafts));
		if (drafts !== savedDrafts) {
			pi.appendEntry(DRAFTS_ENTRY, { root, drafts: JSON.parse(drafts) });
			savedDrafts = drafts;
		}
	}

	function inputs(ctx: ExtensionContext, r: string) {
		const b = branch(ctx);
		return { root: r, turns: turnsOnBranch(b, r), mark: lastMark(b, r) };
	}

	async function load(ctx: ExtensionContext, r: string, req: ScopeRequest): Promise<ReviewData | string> {
		const scope = await resolveScope(req, inputs(ctx, r));
		if (typeof scope === "string") return scope;
		const patch = await diffTrees(r, scope.base, scope.target, { context: config.context });
		if (patch.code === -2) return "the diff is too large to show (over 32 MB)";
		if (patch.code !== 0) return `git diff failed: ${patch.stderr.trim()}`;
		return { root: r, scope, files: parseDiff(patch.stdout) };
	}

	function send(ctx: ExtensionContext, drafts: Thread[], label: string): string {
		const prompt = buildPrompt(drafts, label);
		const idle = ctx.isIdle();
		if (idle) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		for (const t of drafts) t.status = "sent";
		persist();
		const n = drafts.length;
		const what = `${n} comment${n === 1 ? "" : "s"}`;
		return idle ? `sent ${what} to the agent` : `queued ${what} after the current run`;
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		rootResolved = false;
		pending = [];
		await getRoot(ctx.cwd);
		loadThreads(ctx);
		ownCheckpoints = !pi.getCommands().some((c) => c.name === "rewind-undo");
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadThreads(ctx);
		viewer?.refreshThreads();
	});

	// Checkpoints before each prompt, when pi-rewind is not there to record them.
	pi.on("message_end", async (event, ctx) => {
		if (!ownCheckpoints || event.message.role !== "user" || !ctx.hasUI) return;
		const r = await getRoot(ctx.cwd);
		if (!r) return;
		const tree = await snapshot(r);
		if (tree) pending.push({ message: event.message, timestamp: (event.message as { timestamp?: unknown }).timestamp, tree });
	});

	pi.on("agent_end", async (event, ctx) => {
		const r = await getRoot(ctx.cwd);
		if (!r) return;

		if (ownCheckpoints && ctx.hasUI) {
			const b = branch(ctx);
			const found: Checkpoint[] = [];
			for (const p of pending) {
				const entry = [...b]
					.reverse()
					.find((e) => e.type === "message" && e.message?.role === "user" && (e.message === p.message || e.message?.timestamp === p.timestamp));
				if (entry) found.push({ entryId: entry.id, kind: "pre", root: r, tree: p.tree });
			}
			pending = [];
			const leaf = ctx.sessionManager.getLeafEntry() as unknown as Entry | undefined;
			if (leaf?.type === "message") {
				const tree = await snapshot(r);
				if (tree) found.push({ entryId: leaf.id, kind: "post", root: r, tree });
			}
			if (found.length) pi.appendEntry(CHECKPOINT_ENTRY, { checkpoints: found });
		}

		// Attach the agent's tagged replies to the comments they answer.
		const sent = threads.filter((t) => t.status === "sent");
		if (sent.length) {
			const text = event.messages
				.filter((m) => (m as { role?: string }).role === "assistant")
				.map((m) => messageText((m as { content?: unknown }).content))
				.join("\n");
			const replies = parseReplies(text);
			let changed = false;
			for (const t of sent) {
				const reply = replies.get(t.id);
				if (reply) {
					t.reply = reply;
					t.status = "answered";
					changed = true;
				}
			}
			if (changed) {
				persist();
				viewer?.refreshThreads();
			}
		}
	});

	pi.on("session_shutdown", async () => {
		disposeViewer();
		persist();
	});

	async function open(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/diff needs the interactive terminal UI", "warning");
			return;
		}
		if (viewer) return;
		config = loadConfig();
		const r = await getRoot(ctx.cwd);
		if (!r) {
			ctx.ui.notify("/diff: not inside a git repository", "error");
			return;
		}
		const req = parseScopeArgs(args) ?? defaultScope(inputs(ctx, r));
		const data = await load(ctx, r, req);
		if (typeof data === "string") {
			ctx.ui.notify(`/diff: ${data}`, "error");
			return;
		}
		const host = {
			threads,
			checks,
			editorDrafts,
			editor,
			config,
			turns: () => inputs(ctx, r).turns,
			load: (q: ScopeRequest) => load(ctx, r, q),
			onMark: (scope: ReviewData["scope"]) => {
				// Only :mark calls this: persist the snapshot on screen now, without closing or resnapshotting.
				pi.appendEntry(MARK_ENTRY, { root: r, tree: scope.target, at: Date.now() });
				for (const t of threads) if (t.status === "answered") t.status = "resolved";
				persist();
			},
			send: (drafts: Thread[], label: string) => send(ctx, drafts, label),
			persist,
			open: (file: string, line: number | undefined) => openInSplit(pi.events, r, file, line),
			copy: (text: string) => copyToClipboard(text),
		};
		try {
			await withZoom(pi.events, config.zoom, () =>
				ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						viewer = new DiffViewer(tui, theme, keybindings, host, data, done);
						return viewer;
					},
					{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
				),
			);
		} finally {
			disposeViewer();
			viewer = undefined;
			persist();
		}
	}

	pi.registerCommand("diff", {
		description: "Review changes: unreviewed (default), turn [n], session, head, staged, branch [ref], or a ref",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim();
			const items = SCOPE_COMPLETIONS.filter((c) => c.value.startsWith(p));
			return items.length ? items : null;
		},
		handler: open,
	});
}
