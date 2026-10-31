/**
 * The review screen: a full-screen component with a file list, the diff, inline
 * comment threads, and a vim-style key grammar.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	decodeKittyPrintable,
	type Focusable,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Config } from "./config.ts";
import { type CommentEditor, type EditorCreator, editorHint, editorOwnsEscape, INPUT_CONTEXT, nativeEditor } from "./editor.ts";
import { type Layout, layout, type Row, rowLineOn, selectionFromRows, type ViewMode } from "./model.ts";
import { type FileDiff, filePath } from "./parse.ts";
import { type FileState, Painter, type RowState } from "./render.ts";
import { parseScopeArgs, type ResolvedScope, type ScopeRequest } from "./scopes.ts";
import { type EditorDrafts, type FileChecks, fileKey, isChecked, pruneChecks, type Turn } from "./session.ts";
import { newThreadId, type Thread } from "./threads.ts";

const EDITOR_SURFACE = Symbol.for("pi-plugins.editor-surface.v1");

export interface ReviewData {
	root: string;
	scope: ResolvedScope;
	files: FileDiff[];
}

export interface ViewerHost {
	/** Shared with the extension, which attaches the agent's replies while the viewer is open. */
	threads: Thread[];
	/** Files marked reviewed with `r`, keyed by the diff that was seen; shared and persisted like threads. */
	checks: FileChecks;
	/** Cancelled editor drafts, shared with the extension and persisted separately from sendable threads. */
	editorDrafts: EditorDrafts;
	/** Makes the comment editor; Pi's native editor when absent. */
	editor?: EditorCreator;
	config: Config;
	turns(): Turn[];
	load(req: ScopeRequest): Promise<ReviewData | string>;
	/** Persist the displayed eligible live snapshot immediately; marking never closes the viewer. */
	onMark(scope: ResolvedScope): void;
	/** Send draft threads to the agent; returns a status message. */
	send(threads: Thread[], scopeLabel: string): string;
	persist(): void;
	open(file: string, line: number | undefined): Promise<string>;
	copy(text: string): Promise<void>;
}

type Panel =
	| { kind: "none" }
	| { kind: "editor"; editor: CommentEditor; title: string; cancel: () => void }
	| { kind: "picker"; list: SelectList; title: string }
	| { kind: "prompt"; prefix: "/" | ":"; text: string };

const HELP: Array<[string, string]> = [
	["j k  ↓ ↑", "next / previous line (counts work: 5j)"],
	["ctrl+d ctrl+u", "half page down / up"],
	["ctrl+f ctrl+b", "page down / up"],
	["gg  G", "first / last line"],
	["]c [c", "next / previous hunk"],
	["]f [f  } {", "next / previous file"],
	["/  n N", "search, next / previous match"],
	["v  V", "select lines (visual mode)"],
	["c", "comment on the line, selection or file header"],
	["s", "suggest an edit to the line or selection"],
	["e  x", "edit / delete the comment under the cursor"],
	[":w  :wq  ZZ", "send drafts to the agent (and close)"],
	["q  esc  Q  :q!", "close; drafts and file checks are kept, nothing is marked reviewed"],
	["r", "check the file as reviewed (folds it) / uncheck; checks persist until its diff changes"],
	["za  enter", "fold / unfold the file; enter also expands large files"],
	["zM zR", "fold / unfold all files"],
	["S", "pick the scope: unreviewed, a turn, session, HEAD, staged, branch"],
	["< >", "one turn older / newer"],
	["t  w  b", "split/unified, wrap, file list"],
	["tab", "focus the file list (j/k, enter)"],
	["o", "open the file at the line in $EDITOR (herdr split)"],
	["y", "copy path:line"],
	["R", "reload"],
	[":mark", "mark the snapshot shown as reviewed; stay open (unreviewed and session scopes)"],
	[":scope <s>", "unreviewed | turn [n] | session | head | staged | branch [ref] | <ref>"],
];

export class DiffViewer implements Component, Focusable {
	focused = false;
	private data: ReviewData;
	private mode: ViewMode;
	private painter: Painter;
	private lay: Layout = { rows: [], fileRows: [] };
	private cursor = 0;
	private top = 0;
	private visualFrom: number | undefined;
	private folded = new Set<string>();
	private expanded = new Set<string>();
	private disposed = false;
	private loadGeneration = 0;
	private sidebar: boolean;
	private sidebarFocus = false;
	private sidebarIndex = 0;
	private sidebarTop = 0;
	private panel: Panel = { kind: "none" };
	private help = false;
	private pending = "";
	private count = "";
	private searchQuery = "";
	private matches: number[] = [];
	private message = "";
	private messageIsError = false;
	private loading = false;
	private cache = new Map<number, { key: string; lines: string[] }>();
	private lastBodyHeight = 20;
	private bodyTopRow = 1;
	private sidebarWidth = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private host: ViewerHost,
		data: ReviewData,
		private done: () => void,
	) {
		this.data = data;
		const cols = tui.terminal.columns;
		this.mode = host.config.view === "auto" ? (cols >= host.config.splitMinWidth ? "split" : "unified") : host.config.view;
		this.sidebar = host.config.fileList && cols >= 100;
		this.painter = new Painter(theme, data.files, host.config.wrap);
		this.applyChecks();
		this.rebuild();
		this.cursor = this.firstContentRow();
		if (data.files.length === 0) this.flash(`No changes (${data.scope.label}). S picks another scope.`);
	}

	/** Drop checks whose file changed since, and start checked files folded. */
	private applyChecks(): void {
		pruneChecks(this.host.checks, this.data.files);
		for (const f of this.data.files) if (isChecked(this.host.checks, f)) this.folded.add(filePath(f));
	}

	// ---- state ---------------------------------------------------------------------------------

	private get rows(): Row[] {
		return this.lay.rows;
	}

	private threadsInRoot(): Thread[] {
		return this.host.threads;
	}

	private rebuild(keepRow?: Row): void {
		const prev = keepRow ?? this.rows[this.cursor];
		this.lay = layout(this.data.files, {
			mode: this.mode,
			folded: this.folded,
			expanded: this.expanded,
			threads: this.threadsInRoot().filter((t) => t.status !== "resolved"),
			maxLines: this.host.config.maxFileLines,
		});
		this.cache.clear();
		if (prev) this.cursor = this.findEquivalent(prev);
		this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
		if (this.searchQuery) this.runSearch(this.searchQuery, false);
	}

	/** After a relayout, the row that shows the same thing as `prev` did. */
	private findEquivalent(prev: Row): number {
		const rows = this.rows;
		const same = (r: Row): boolean => {
			if (r.file !== prev.file) return false;
			if (prev.kind === "thread") return r.kind === "thread" && r.thread === prev.thread;
			if (prev.kind === "file") return r.kind === "file";
			if (prev.kind === "hunk") return r.kind === "hunk" && r.hunk === prev.hunk;
			const pl = prev.kind === "line" ? prev.line : prev.kind === "split" ? (prev.right ?? prev.left) : undefined;
			if (!pl) return false;
			if (r.kind === "line") return r.line === pl || r.pair === pl;
			if (r.kind === "split") return r.left === pl || r.right === pl;
			return false;
		};
		const i = rows.findIndex(same);
		if (i >= 0) return i;
		return this.lay.fileRows[prev.file] ?? this.cursor;
	}

	private firstContentRow(): number {
		const i = this.rows.findIndex((r) => r.kind === "line" || r.kind === "split");
		return i >= 0 ? i : 0;
	}

	private fileState(fi: number): FileState {
		const f = this.data.files[fi];
		const path = f ? filePath(f) : "";
		return {
			folded: this.folded.has(path),
			reviewed: f !== undefined && isChecked(this.host.checks, f),
			comments: this.host.threads.filter((t) => t.file === path && t.status !== "resolved").length,
		};
	}

	private threadById(id: string): Thread | undefined {
		return this.host.threads.find((t) => t.id === id);
	}

	private currentFile(): number {
		const r = this.rows[this.cursor];
		if (!r) return 0;
		if (r.file >= 0) return r.file;
		return Math.max(0, this.data.files.length - 1);
	}

	private flash(msg: string, error = false): void {
		this.message = msg;
		this.messageIsError = error;
	}

	private drafts(): Thread[] {
		return this.host.threads.filter((t) => t.status === "draft");
	}

	private selectTheme(): SelectListTheme {
		const t = this.theme;
		return {
			selectedPrefix: (s) => t.fg("accent", s),
			selectedText: (s) => t.bold(t.fg("accent", s)),
			description: (s) => t.fg("muted", s),
			scrollInfo: (s) => t.fg("dim", s),
			noMatch: (s) => t.fg("warning", s),
		};
	}

	// ---- lifecycle -----------------------------------------------------------------------------

	invalidate(): void {
		this.cache.clear();
		this.painter.invalidate(this.theme);
		if (this.panel.kind === "editor") this.panel.editor.invalidate();
		if (this.panel.kind === "picker") this.panel.list.invalidate();
	}

	/** Called by the extension when replies arrive or threads change elsewhere. */
	refreshThreads(): void {
		this.rebuild();
		this.tui.requestRender();
	}

	/** Release the embedded editor and save its draft even if Pi closes the overlay externally. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.closeEditor();
		this.host.persist();
	}

	readonly [EDITOR_SURFACE] = "embedded";

	[INPUT_CONTEXT](): "editor" | "filter" | "list" | "viewer" {
		if (this.panel.kind === "editor") return "editor";
		if (this.panel.kind === "prompt") return "filter";
		return this.panel.kind === "picker" || this.sidebarFocus ? "list" : "viewer";
	}

	/** Close without marking anything reviewed: drafts, checks and answers stay as they are. */
	private close(): void {
		if (this.disposed) return;
		this.dispose();
		this.done();
	}

	/** Whether `:mark` applies to what is shown: a live working tree in the unreviewed or session scope. */
	private markable(): boolean {
		const k = this.data.scope.request.kind;
		return this.data.scope.live && (k === "unreviewed" || k === "session");
	}

	/** `:mark`: persist the snapshot on screen (not a fresh one), confirm, and stay open. */
	private mark(): void {
		if (this.disposed) return;
		if (!this.markable()) {
			this.flash(`:mark needs the unreviewed or session scope (this is ${this.data.scope.label})`, true);
			return;
		}
		this.host.onMark(this.data.scope);
		this.rebuild();
		this.flash("displayed snapshot marked reviewed; review stays open");
	}

	// ---- rendering -----------------------------------------------------------------------------

	render(width: number): string[] {
		const t = this.theme;
		const height = Math.max(5, this.tui.terminal.rows);
		const panelLines = this.renderPanel(width);
		const bodyH = Math.max(1, height - 2 - panelLines.length);
		this.lastBodyHeight = bodyH;
		this.bodyTopRow = 1;

		const header = this.renderHeader(width);
		let body: string[];
		if (this.help) body = this.renderHelp(width, bodyH);
		else {
			const sw = this.sidebar && width >= 60 ? Math.min(48, Math.max(24, Math.floor(width * 0.24))) : 0;
			this.sidebarWidth = sw;
			const dw = sw ? width - sw - 1 : width;
			const diff = this.renderDiff(dw, bodyH);
			if (sw) {
				const side = this.renderSidebar(sw, bodyH);
				const sep = t.fg(this.sidebarFocus ? "borderAccent" : "borderMuted", "│");
				body = diff.map((d, k) => `${side[k] ?? " ".repeat(sw)}${sep}${d}`);
			} else body = diff;
		}
		while (body.length < bodyH) body.push("");
		const footer = this.renderFooter(width);
		return [header, ...body.slice(0, bodyH), ...panelLines, footer].map((l) => truncateToWidth(l, width, ""));
	}

	private renderHeader(width: number): string {
		const t = this.theme;
		const files = this.data.files;
		const add = files.reduce((s, f) => s + f.additions, 0);
		const del = files.reduce((s, f) => s + f.deletions, 0);
		const drafts = this.drafts().length;
		const left = `${t.bold(t.fg("accent", " diff "))} ${t.fg("text", this.data.scope.label)}`;
		const stats = `${files.length} file${files.length === 1 ? "" : "s"} ${t.fg("toolDiffAdded", `+${add}`)} ${t.fg("toolDiffRemoved", `-${del}`)}`;
		const extra = [drafts ? t.fg("warning", `${drafts} draft${drafts === 1 ? "" : "s"}`) : "", this.loading ? t.fg("muted", "loading…") : ""]
			.filter(Boolean)
			.join("  ");
		const right = `${stats}${extra ? `  ${extra}` : ""}  ${t.fg("muted", this.mode)}  ${t.fg("dim", "? help")} `;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "…");
	}

	private renderFooter(width: number): string {
		const t = this.theme;
		if (this.panel.kind === "prompt") {
			return `${this.panel.prefix}${this.panel.text}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`;
		}
		if (this.message) return truncateToWidth(t.fg(this.messageIsError ? "error" : "accent", ` ${this.message}`), width, "…");
		if (this.visualFrom !== undefined) return t.fg("accent", " -- VISUAL --  c comment  s suggest  esc cancel");
		const pend = this.pending || this.count ? t.fg("accent", ` ${this.count}${this.pending}`) : "";
		const hints = " j/k move  ]c hunk  ]f file  c comment  s suggest  :w send  S scope  r reviewed  q close";
		return truncateToWidth(`${t.fg("dim", hints)}${pend}`, width, "…");
	}

	private renderPanel(width: number): string[] {
		const t = this.theme;
		const p = this.panel;
		if (p.kind === "editor") {
			const title = t.fg("accent", ` ${p.title}`);
			const hint = t.fg("dim", editorHint(p.editor));
			p.editor.focused = this.focused;
			return [truncateToWidth(title + hint, width, "…"), ...p.editor.render(width)];
		}
		if (p.kind === "picker") {
			return [t.fg("borderMuted", "─".repeat(width)), t.fg("accent", ` ${p.title}`), ...p.list.render(width)];
		}
		return [];
	}

	private renderHelp(width: number, h: number): string[] {
		const t = this.theme;
		const out = [t.bold(t.fg("accent", " Keys")), ""];
		const kw = Math.max(...HELP.map(([k]) => k.length)) + 2;
		for (const [k, d] of HELP) out.push(truncateToWidth(` ${t.fg("accent", k.padEnd(kw))}${d}`, width, "…"));
		out.push("", t.fg("dim", " any key closes this help"));
		return out.slice(0, h);
	}

	private rowState(i: number): RowState {
		const row = this.rows[i];
		const lo = this.visualFrom === undefined ? -1 : Math.min(this.visualFrom, this.cursor);
		const hi = this.visualFrom === undefined ? -1 : Math.max(this.visualFrom, this.cursor);
		return {
			cursor: i === this.cursor && !this.sidebarFocus,
			selected: i >= lo && i <= hi,
			commented: this.rows[i + 1]?.kind === "thread" && row.kind !== "thread" && row.kind !== "file",
			match: this.matches.includes(i),
		};
	}

	private rowLines(i: number, width: number): string[] {
		const st = this.rowState(i);
		const row = this.rows[i];
		const th = row.kind === "thread" ? this.threadById(row.thread) : undefined;
		const fs = row.kind === "file" ? this.fileState(row.file) : undefined;
		const key = `${width}|${this.mode}|${this.painter.wrap}|${st.cursor}|${st.selected}|${st.commented}|${st.match}|${th ? `${th.status}|${th.body}|${th.reply}|${th.suggestion}` : ""}|${fs ? `${fs.folded}${fs.reviewed}${fs.comments}` : ""}`;
		const hit = this.cache.get(i);
		if (hit && hit.key === key) return hit.lines;
		const lines = this.painter.render(row, width, st, { thread: th, file: fs });
		this.cache.set(i, { key, lines });
		return lines;
	}

	private scrollIntoView(width: number, h: number): void {
		const margin = Math.min(3, Math.floor(h / 4));
		if (this.cursor < this.top + 0) this.top = Math.max(0, this.cursor - margin);
		// Keep `margin` lines of context above the cursor.
		while (this.top > 0 && this.top > this.cursor - margin) this.top--;
		// Ensure the cursor row (plus margin rows below) fits.
		const fits = () => {
			let used = 0;
			const end = Math.min(this.rows.length - 1, this.cursor + margin);
			for (let r = this.top; r <= end; r++) {
				used += this.rowLines(r, width).length;
				if (used > h) return false;
			}
			return true;
		};
		while (this.top < this.cursor && !fits()) this.top++;
	}

	private renderDiff(width: number, h: number): string[] {
		const out: string[] = [];
		if (this.rows.length === 0) return out;
		this.scrollIntoView(width, h);
		for (let r = this.top; r < this.rows.length && out.length < h; r++) out.push(...this.rowLines(r, width));
		return out.slice(0, h);
	}

	private renderSidebar(width: number, h: number): string[] {
		const t = this.theme;
		const files = this.data.files;
		const cur = this.sidebarFocus ? this.sidebarIndex : this.currentFile();
		if (cur < this.sidebarTop) this.sidebarTop = cur;
		if (cur >= this.sidebarTop + h) this.sidebarTop = cur - h + 1;
		const out: string[] = [];
		for (let i = this.sidebarTop; i < files.length && out.length < h; i++) {
			const f = files[i];
			const fs = this.fileState(i);
			const status = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" }[f.status];
			const color = f.status === "added" ? "toolDiffAdded" : f.status === "deleted" ? "toolDiffRemoved" : "accent";
			const tail = `${fs.comments ? t.fg("warning", ` ●${fs.comments}`) : ""}${fs.reviewed ? t.fg("success", " ✓") : ""}`;
			const tw = visibleWidth(tail);
			let path = filePath(f);
			const room = Math.max(4, width - 3 - tw);
			if (path.length > room) path = `…${path.slice(path.length - room + 1)}`;
			let line = ` ${t.fg(color, status)} ${fs.reviewed ? t.fg("dim", path) : path}`;
			line = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line) - tw))}${tail}`;
			if (i === cur) line = this.sidebarFocus ? t.bg("selectedBg", line) : t.bold(line);
			out.push(truncateToWidth(line, width, "…", true));
		}
		while (out.length < h) out.push(" ".repeat(width));
		return out;
	}

	// ---- movement ------------------------------------------------------------------------------

	private moveTo(i: number): void {
		const n = this.rows.length;
		if (n === 0) return;
		let j = Math.max(0, Math.min(n - 1, i));
		// Skip spacer rows in the direction of travel.
		const dir = j >= this.cursor ? 1 : -1;
		while (this.rows[j]?.kind === "blank" && j + dir >= 0 && j + dir < n) j += dir;
		this.cursor = j;
	}

	private jump(pred: (r: Row, i: number) => boolean, dir: 1 | -1, wrap = false): boolean {
		const n = this.rows.length;
		for (let k = 1; k <= n; k++) {
			let i = this.cursor + dir * k;
			if (i < 0 || i >= n) {
				if (!wrap) return false;
				i = (i + n) % n;
			}
			if (pred(this.rows[i], i)) {
				this.cursor = i;
				return true;
			}
		}
		return false;
	}

	private jumpFile(dir: 1 | -1): void {
		const fr = this.lay.fileRows;
		const cur = this.currentFile();
		const target = dir > 0 ? cur + 1 : this.cursor > fr[cur] ? cur : cur - 1;
		if (target < 0 || target >= fr.length) return;
		this.cursor = fr[target];
		this.top = this.cursor;
	}

	private jumpHunk(dir: 1 | -1): void {
		if (!this.jump((r) => r.kind === "hunk", dir)) this.flash(dir > 0 ? "last hunk" : "first hunk");
		else {
			// Land on the first changed line of the hunk, not its header.
			const h = this.rows[this.cursor];
			let i = this.cursor + 1;
			while (i < this.rows.length && this.rows[i].file === h.file && !this.isChange(this.rows[i]) && this.rows[i].kind !== "hunk") i++;
			if (i < this.rows.length && this.isChange(this.rows[i])) this.cursor = i;
		}
	}

	private isChange(r: Row): boolean {
		if (r.kind === "line") return r.line.kind !== "context";
		if (r.kind === "split") return r.left?.kind === "del" || r.right?.kind === "add";
		return false;
	}

	// ---- search --------------------------------------------------------------------------------

	private rowText(r: Row): string {
		switch (r.kind) {
			case "line":
				return r.line.text;
			case "split":
				return `${r.left?.text ?? ""}\n${r.right?.text ?? ""}`;
			case "file":
				return filePath(this.data.files[r.file]);
			case "thread": {
				const t = this.threadById(r.thread);
				return t ? `${t.body}\n${t.reply ?? ""}` : "";
			}
			default:
				return "";
		}
	}

	private runSearch(q: string, move = true): void {
		this.searchQuery = q;
		if (!q) {
			this.matches = [];
			return;
		}
		const smart = q === q.toLowerCase();
		const needle = smart ? q.toLowerCase() : q;
		this.matches = [];
		this.rows.forEach((r, i) => {
			const text = smart ? this.rowText(r).toLowerCase() : this.rowText(r);
			if (text.includes(needle)) this.matches.push(i);
		});
		this.cache.clear();
		if (move) this.nextMatch(1, true);
	}

	private nextMatch(dir: 1 | -1, inclusive = false): void {
		if (!this.matches.length) {
			this.flash(this.searchQuery ? `no match: ${this.searchQuery}` : "no search", true);
			return;
		}
		const set = new Set(this.matches);
		if (inclusive && set.has(this.cursor)) return;
		if (!this.jump((_r, i) => set.has(i), dir, true)) return;
		const idx = this.matches.indexOf(this.cursor) + 1;
		this.flash(`/${this.searchQuery}  ${idx}/${this.matches.length}`);
	}

	// ---- comments ------------------------------------------------------------------------------

	private threadAtCursor(): Thread | undefined {
		const r = this.rows[this.cursor];
		if (r?.kind === "thread") return this.threadById(r.thread);
		const next = this.rows[this.cursor + 1];
		if (next?.kind === "thread" && r?.kind !== "file") return this.threadById(next.thread);
		return undefined;
	}

	/** Draft identities include the displayed file content, operation, side and anchor, not UI titles. */
	private editorDraftKey(path: string, anchor: unknown[]): string {
		const file = this.data.files.find((f) => filePath(f) === path);
		return JSON.stringify([path, file ? fileKey(file) : null, ...anchor]);
	}

	/** Open an editor, restoring only the cancelled draft for this exact file content and anchor. */
	private openEditor(
		key: string,
		title: string,
		prefill: string,
		onSave: (text: string) => void,
		mode: "insert" | "normal" = "insert",
	): void {
		const held = this.host.editorDrafts.get(key);
		const initialText = held ?? prefill;
		let current: CommentEditor | undefined;
		const active = () => this.panel.kind === "editor" && this.panel.editor === current;
		const finish = (): boolean => {
			if (!active()) return false;
			this.panel = { kind: "none" };
			try {
				current?.dispose?.();
			} catch {
				// Optional editor cleanup must not lose the draft or prevent closing the review.
			}
			return true;
		};
		const request = {
			tui: this.tui,
			theme: { borderColor: (s: string) => this.theme.fg("borderAccent", s), selectList: this.selectTheme() },
			keybindings: this.keybindings,
			onSubmit: (text: string) => {
				if (!finish()) return;
				this.host.editorDrafts.delete(key);
				onSave(text);
				this.host.persist();
				this.rebuild();
				this.tui.requestRender();
			},
			onCancel: () => {
				if (!active()) return;
				const text = current?.getText() ?? "";
				if (!finish()) return;
				if (text !== prefill) {
					this.host.editorDrafts.set(key, text);
					this.flash("draft kept: it comes back when you comment here again");
				} else this.host.editorDrafts.delete(key);
				this.host.persist();
				this.tui.requestRender();
			},
			scrollViewport: (direction: -1 | 1) => {
				if (!active()) return;
				this.moveTo(this.cursor + direction * Math.max(1, Math.floor(this.lastBodyHeight / 2)));
				this.tui.requestRender();
			},
			notify: (message: string, type: "info" | "warning" | "error") => {
				if (!active()) return;
				this.flash(message, type === "error");
				this.tui.requestRender();
			},
			initialText,
			initialMode: mode,
			paddingX: 1,
		};
		const editor = (this.host.editor ?? nativeEditor)(request);
		current = editor;
		editor.focused = true;
		this.panel = { kind: "editor", editor, title, cancel: request.onCancel };
		if (held !== undefined) this.flash("continuing the draft you cancelled");
	}

	/** Escape in Pi's native editor: cancel, keeping typed text as a held draft. */
	private cancelEditor(): void {
		if (this.panel.kind === "editor") this.panel.cancel();
	}

	/** Close an open comment editor through its cancellation path, preserving changed text. */
	private closeEditor(): void {
		if (this.panel.kind === "editor") this.panel.cancel();
	}

	private comment(suggest: boolean): void {
		const r = this.rows[this.cursor];
		if (!r) return;
		if (!suggest && r.kind === "thread") return this.editThread();
		const fi = r.file;
		if (fi < 0) return;
		const path = filePath(this.data.files[fi]);
		const sel =
			r.kind === "file" || r.kind === "hunk" || r.kind === "note"
				? undefined
				: selectionFromRows(this.rows, this.visualFrom ?? this.cursor, this.cursor);
		if (suggest && !sel) {
			this.flash("put the cursor on lines to suggest an edit", true);
			return;
		}
		const fileLevel = !sel;
		if (r.kind === "hunk" && !suggest) {
			// A hunk header comments on the whole hunk.
			let end = this.cursor + 1;
			while (end < this.rows.length && this.rows[end].file === fi && (this.rows[end].kind === "line" || this.rows[end].kind === "split" || this.rows[end].kind === "thread")) end++;
			const hs = selectionFromRows(this.rows, this.cursor + 1, end - 1);
			if (hs) return this.newThread(path, hs, false);
		}
		this.visualFrom = undefined;
		if (fileLevel) {
			this.openEditor(this.editorDraftKey(path, ["comment", "new", 0, 0]), `Comment on ${path}`, "", (text) => {
				if (!text.trim()) return;
				this.host.threads.push({
					id: newThreadId(this.host.threads.map((t) => t.id)),
					file: path,
					side: "new",
					start: 0,
					end: 0,
					excerpt: [],
					body: text,
					status: "draft",
					createdAt: Date.now(),
				});
			});
			return;
		}
		this.newThread(path, sel, suggest);
	}

	private newThread(path: string, sel: NonNullable<ReturnType<typeof selectionFromRows>>, suggest: boolean): void {
		this.visualFrom = undefined;
		const where = sel.start === sel.end ? `L${sel.start}` : `L${sel.start}-${sel.end}`;
		const lines = sel.excerpt.filter((l) => (sel.side === "new" ? !l.startsWith("- ") : !l.startsWith("+ "))).map((l) => l.slice(2));
		this.openEditor(
			this.editorDraftKey(path, [suggest ? "suggest" : "comment", sel.side, sel.start, sel.end, sel.excerpt]),
			suggest ? `Suggest an edit to ${path} ${where}` : `Comment on ${path} ${where}`,
			suggest ? lines.join("\n") : "",
			(text) => {
				if (!suggest && !text.trim()) return;
				if (suggest && text === lines.join("\n")) {
					this.flash("suggestion unchanged; discarded");
					return;
				}
				this.host.threads.push({
					id: newThreadId(this.host.threads.map((t) => t.id)),
					file: path,
					side: sel.side,
					start: sel.start,
					end: sel.end,
					excerpt: sel.excerpt,
					body: suggest ? "" : text,
					suggestion: suggest ? text : undefined,
					status: "draft",
					createdAt: Date.now(),
				});
			},
			// A suggestion starts from the lines as they are: a modal editor opens in Normal mode to move around them.
			suggest ? "normal" : "insert",
		);
	}

	private editThread(): void {
		const th = this.threadAtCursor();
		if (!th) {
			this.flash("no comment here", true);
			return;
		}
		const isSuggest = th.suggestion !== undefined;
		const where = th.start ? ` L${th.start}${th.end !== th.start ? `-${th.end}` : ""}` : "";
		this.openEditor(
			this.editorDraftKey(th.file, ["edit", th.id, th.side, th.start, th.end, th.excerpt, th.body, th.suggestion]),
			`${isSuggest ? "Edit suggestion" : "Edit comment"} on ${th.file}${where}`,
			isSuggest ? (th.suggestion ?? "") : th.body,
			(text) => {
				if (isSuggest) th.suggestion = text;
				else th.body = text;
				if (th.status !== "draft") {
					th.status = "draft";
					th.reply = undefined;
				}
			},
		);
	}

	private deleteThread(): void {
		const th = this.threadAtCursor();
		if (!th) {
			this.flash("no comment here", true);
			return;
		}
		const i = this.host.threads.indexOf(th);
		if (i >= 0) this.host.threads.splice(i, 1);
		this.flash(th.status === "draft" ? "draft deleted" : "comment removed");
		this.rebuild();
	}

	/** Send the drafts; with `thenClose`, close afterwards. Neither marks anything reviewed. */
	private sendDrafts(thenClose: boolean): void {
		const drafts = this.drafts();
		if (!drafts.length) {
			this.flash("no draft comments to send");
			if (thenClose) this.close();
			return;
		}
		const msg = this.host.send(drafts, this.data.scope.label);
		this.flash(msg);
		this.rebuild();
		if (thenClose) this.close();
	}

	// ---- scopes --------------------------------------------------------------------------------

	private async switchScope(req: ScopeRequest): Promise<void> {
		const generation = ++this.loadGeneration;
		this.loading = true;
		this.tui.requestRender();
		let r: ReviewData | string;
		try {
			r = await this.host.load(req);
		} catch (error) {
			r = `could not load diff: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (this.disposed || generation !== this.loadGeneration) return;
		this.loading = false;
		if (typeof r === "string") {
			this.flash(r, true);
			this.tui.requestRender();
			return;
		}
		this.closeEditor();
		this.data = r;
		this.painter = new Painter(this.theme, r.files, this.painter.wrap);
		this.folded.clear();
		this.expanded.clear();
		this.applyChecks();
		this.top = 0;
		this.rebuild(undefined);
		this.cursor = this.firstContentRow();
		this.flash(r.files.length ? r.scope.label : `No changes (${r.scope.label})`);
		this.tui.requestRender();
	}

	private openPicker(): void {
		const turns = this.host.turns();
		const items: SelectItem[] = [
			{ value: "unreviewed", label: "Unreviewed", description: "since your last review" },
			...turns
				.slice()
				.reverse()
				.map((t, k) => ({
					value: `turn ${k + 1}`,
					label: k === 0 ? "Last turn" : `Turn -${k + 1}`,
					description: t.prompt.replace(/\s+/g, " ").slice(0, 80),
				})),
			{ value: "session", label: "Session", description: "everything this session changed" },
			{ value: "head", label: "Uncommitted", description: "working tree vs HEAD" },
			{ value: "staged", label: "Staged", description: "index vs HEAD" },
			{ value: "branch", label: "Branch", description: "vs the merge base with the default branch" },
		];
		const list = new SelectList(items, Math.min(12, Math.max(4, Math.floor(this.tui.terminal.rows / 3))), this.selectTheme());
		const cur = this.data.scope.request;
		const curValue = cur.kind === "turn" ? `turn ${cur.turn ?? 1}` : cur.kind;
		const idx = items.findIndex((i) => i.value === curValue);
		if (idx >= 0) list.setSelectedIndex(idx);
		list.onSelect = (item) => {
			this.panel = { kind: "none" };
			const [kind, n] = item.value.split(" ");
			void this.switchScope(kind === "turn" ? { kind: "turn", turn: Number(n) } : { kind: kind as ScopeRequest["kind"] });
		};
		list.onCancel = () => {
			this.panel = { kind: "none" };
			this.tui.requestRender();
		};
		this.panel = { kind: "picker", list, title: "Scope" };
	}

	private stepTurn(dir: 1 | -1): void {
		const n = this.host.turns().length;
		if (!n) {
			this.flash("no turns recorded in this session", true);
			return;
		}
		const cur = this.data.scope.request.kind === "turn" ? (this.data.scope.request.turn ?? 1) : 0;
		const next = cur + dir;
		if (next < 1) {
			void this.switchScope({ kind: "unreviewed" });
			return;
		}
		if (next > n) {
			this.flash("oldest turn", true);
			return;
		}
		void this.switchScope({ kind: "turn", turn: next });
	}

	// ---- commands ------------------------------------------------------------------------------

	private ex(cmd: string): void {
		const c = cmd.trim();
		if (/^\d+$/.test(c)) {
			// :N goes to new-side line N in the current file.
			const fi = this.currentFile();
			const n = Number(c);
			const i = this.rows.findIndex((r) => r.file === fi && rowLineOn(r, "new")?.newLine === n);
			if (i >= 0) this.cursor = i;
			else this.flash(`line ${n} is not in this diff`, true);
			return;
		}
		switch (c) {
			case "w":
				return this.sendDrafts(false);
			case "wq":
			case "x":
				return this.sendDrafts(true);
			case "q":
			case "q!":
				return this.close();
			case "mark":
				return this.mark();
			case "split":
			case "unified":
				this.mode = c;
				this.rebuild();
				return;
		}
		const m = /^scope\s+(.+)$/.exec(c);
		if (m) {
			const req = parseScopeArgs(m[1]);
			if (req) void this.switchScope(req);
			return;
		}
		this.flash(`unknown command: ${c}`, true);
	}

	// ---- input ---------------------------------------------------------------------------------

	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed) return { handled: true };
		if (this.panel.kind !== "none" || this.help) return { handled: true };
		if (e.type === "wheel" && e.wheelDelta) {
			const n = Math.sign(e.wheelDelta) * 3;
			this.top = Math.max(0, Math.min(this.rows.length - 1, this.top + n));
			this.moveTo(Math.max(this.top, Math.min(this.cursor + n, this.rows.length - 1)));
			this.tui.requestRender();
			return { handled: true };
		}
		if (e.type === "click" && e.button === "left" && this.sidebarWidth && e.x < this.sidebarWidth) {
			const fi = this.sidebarTop + (e.y - this.bodyTopRow);
			if (fi >= 0 && fi < this.data.files.length) {
				this.cursor = this.lay.fileRows[fi];
				this.top = this.cursor;
				this.sidebarFocus = false;
				this.tui.requestRender();
			}
			return { handled: true };
		}
		return { handled: true };
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		this.message = "";
		const p = this.panel;
		if (p.kind === "editor") {
			// A modal editor takes Escape itself (leaving Insert mode, or cancelling from Normal mode).
			if (matchesKey(data, "escape") && !editorOwnsEscape(p.editor)) this.cancelEditor();
			else p.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (p.kind === "picker") {
			const key = decodeKittyPrintable(data) ?? data;
			if (key === "j") p.list.handleInput("\x1b[B");
			else if (key === "k") p.list.handleInput("\x1b[A");
			else if (key === "q") p.list.onCancel?.();
			else p.list.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (p.kind === "prompt") {
			this.handlePrompt(p, data);
			this.tui.requestRender();
			return;
		}
		if (this.help) {
			this.help = false;
			this.tui.requestRender();
			return;
		}
		if (this.sidebarFocus) this.handleSidebar(data);
		else this.handleNormal(data);
		this.tui.requestRender();
	}

	private handlePrompt(p: Extract<Panel, { kind: "prompt" }>, data: string): void {
		if (matchesKey(data, "escape")) {
			this.panel = { kind: "none" };
			return;
		}
		if (matchesKey(data, "enter")) {
			this.panel = { kind: "none" };
			if (p.prefix === "/") this.runSearch(p.text);
			else this.ex(p.text);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (!p.text) this.panel = { kind: "none" };
			else p.text = [...p.text].slice(0, -1).join("");
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			p.text = "";
			return;
		}
		const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : data.length > 1 && !data.startsWith("\x1b") ? data : undefined);
		if (ch) p.text += ch;
	}

	private handleSidebar(data: string): void {
		const key = decodeKittyPrintable(data) ?? data;
		const n = this.data.files.length;
		if (matchesKey(data, "tab") || matchesKey(data, "escape") || key === "h" || key === "q") {
			this.sidebarFocus = false;
			return;
		}
		if (key === "j" || matchesKey(data, "down")) this.sidebarIndex = Math.min(n - 1, this.sidebarIndex + 1);
		else if (key === "k" || matchesKey(data, "up")) this.sidebarIndex = Math.max(0, this.sidebarIndex - 1);
		else if (key === "g") this.sidebarIndex = 0;
		else if (key === "G") this.sidebarIndex = n - 1;
		else if (matchesKey(data, "enter") || key === "l" || key === "o") {
			this.cursor = this.lay.fileRows[this.sidebarIndex] ?? this.cursor;
			this.top = this.cursor;
			this.sidebarFocus = false;
		} else if (key === "r") this.toggleReviewed(this.sidebarIndex);
	}

	private toggleFold(fi: number, value?: boolean): void {
		const f = this.data.files[fi];
		if (!f) return;
		const path = filePath(f);
		const fold = value ?? !this.folded.has(path);
		if (fold) this.folded.add(path);
		else this.folded.delete(path);
		const row = this.rows[this.lay.fileRows[fi]];
		this.rebuild(row);
		this.cursor = this.lay.fileRows[fi];
	}

	private toggleReviewed(fi: number): void {
		const f = this.data.files[fi];
		if (!f) return;
		const path = filePath(f);
		// Checks are written to the session with the threads when the viewer closes.
		if (isChecked(this.host.checks, f)) {
			this.host.checks.delete(path);
			this.toggleFold(fi, false);
			return;
		}
		this.host.checks.set(path, fileKey(f));
		this.toggleFold(fi, true);
		// Move on to the next file still to review.
		const next = this.data.files.findIndex((g, k) => k > fi && !isChecked(this.host.checks, g));
		if (next >= 0) {
			this.cursor = this.lay.fileRows[next];
			this.top = this.cursor;
		} else if (this.data.files.every((g) => isChecked(this.host.checks, g))) {
			this.flash(this.markable() ? "all files checked; :mark marks them reviewed, q closes" : "all files checked; q closes");
		}
	}

	private handleNormal(data: string): void {
		const key = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
		const half = Math.max(1, Math.floor(this.lastBodyHeight / 2));

		// Multi-key sequences.
		if (this.pending) {
			const seq = this.pending + (key ?? "");
			this.pending = "";
			switch (seq) {
				case "gg":
					this.cursor = 0;
					this.moveTo(0);
					return;
				case "]c":
					return this.jumpHunk(1);
				case "[c":
					return this.jumpHunk(-1);
				case "]f":
					return this.jumpFile(1);
				case "[f":
					return this.jumpFile(-1);
				case "za":
				case "zo":
				case "zc":
					return this.toggleFold(this.currentFile(), seq === "za" ? undefined : seq === "zc");
				case "zM":
					this.data.files.forEach((f) => this.folded.add(filePath(f)));
					this.rebuild();
					return;
				case "zR":
					this.folded.clear();
					this.rebuild();
					return;
				case "zz":
					this.top = Math.max(0, this.cursor - Math.floor(this.lastBodyHeight / 3));
					return;
				case "ZZ":
					return this.sendDrafts(true);
				case "ZQ":
					return this.close();
				case "dd":
					return this.deleteThread();
			}
			return;
		}

		if (key && /^[1-9]$/.test(key) || (key === "0" && this.count)) {
			this.count += key;
			return;
		}
		const count = Math.max(1, Number.parseInt(this.count || "1", 10));
		this.count = "";

		if (matchesKey(data, "escape")) {
			if (this.visualFrom !== undefined) this.visualFrom = undefined;
			else if (this.matches.length) {
				this.matches = [];
				this.searchQuery = "";
				this.cache.clear();
			} else this.close();
			return;
		}
		if (matchesKey(data, "ctrl+d")) return this.moveTo(this.cursor + half * count);
		if (matchesKey(data, "ctrl+u")) return this.moveTo(this.cursor - half * count);
		if (matchesKey(data, "ctrl+f") || matchesKey(data, "pageDown")) return this.moveTo(this.cursor + this.lastBodyHeight * count);
		if (matchesKey(data, "ctrl+b") || matchesKey(data, "pageUp")) return this.moveTo(this.cursor - this.lastBodyHeight * count);
		if (matchesKey(data, "down")) return this.moveTo(this.cursor + count);
		if (matchesKey(data, "up")) return this.moveTo(this.cursor - count);
		if (matchesKey(data, "tab")) {
			if (!this.sidebar) this.sidebar = true;
			this.sidebarFocus = true;
			this.sidebarIndex = this.currentFile();
			return;
		}
		if (matchesKey(data, "enter")) {
			const r = this.rows[this.cursor];
			if (r?.kind === "note" && r.expand) {
				this.expanded.add(filePath(this.data.files[r.file]));
				this.rebuild();
			} else if (r?.kind === "file") this.toggleFold(r.file);
			else if (r?.kind === "thread") this.editThread();
			return;
		}

		switch (key) {
			case "j":
				return this.moveTo(this.cursor + count);
			case "k":
				return this.moveTo(this.cursor - count);
			case "G":
				return this.moveTo(this.rows.length - 1);
			case "g":
			case "]":
			case "[":
			case "z":
			case "Z":
			case "d":
				this.pending = key;
				return;
			case "}":
				return this.jumpFile(1);
			case "{":
				return this.jumpFile(-1);
			case "n":
				return this.nextMatch(1);
			case "N":
				return this.nextMatch(-1);
			case "/":
				this.panel = { kind: "prompt", prefix: "/", text: "" };
				return;
			case ":":
				this.panel = { kind: "prompt", prefix: ":", text: "" };
				return;
			case "?":
				this.help = true;
				return;
			case "v":
			case "V":
				this.visualFrom = this.visualFrom === undefined ? this.cursor : undefined;
				return;
			case "c":
				return this.comment(false);
			case "s":
				return this.comment(true);
			case "e":
				return this.editThread();
			case "x":
				return this.deleteThread();
			case "r":
				return this.toggleReviewed(this.currentFile());
			case "t":
				this.mode = this.mode === "split" ? "unified" : "split";
				this.rebuild();
				return;
			case "w":
				this.painter.wrap = !this.painter.wrap;
				this.cache.clear();
				return;
			case "b":
				this.sidebar = !this.sidebar;
				return;
			case "S":
				return this.openPicker();
			case "<":
				return this.stepTurn(1);
			case ">":
				return this.stepTurn(-1);
			case "R":
				void this.switchScope(this.data.scope.request);
				return;
			case "o":
			case "y": {
				const r = this.rows[this.cursor];
				if (!r || r.file < 0) return;
				const path = filePath(this.data.files[r.file]);
				const line = rowLineOn(r, "new")?.newLine ?? rowLineOn(r, "old")?.oldLine;
				if (key === "y") {
					const text = line ? `${path}:${line}` : path;
					void this.host.copy(text).then(
						() => this.flash(`copied ${text}`),
						() => this.flash("copy failed", true),
					);
				} else
					void this.host.open(path, rowLineOn(r, "new")?.newLine).then((m) => {
						this.flash(m);
						this.tui.requestRender();
					});
				return;
			}
			case "q":
			case "Q":
				return this.close();
		}
	}
}
