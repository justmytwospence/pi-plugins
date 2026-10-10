/** Paint rows as terminal lines with the active pi theme. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { applyBgRanges, expandRanges, expandTabs } from "./ansi.ts";
import { intraline, type Range } from "./intraline.ts";
import type { Row } from "./model.ts";
import { type DiffLine, type FileDiff, filePath } from "./parse.ts";
import type { Thread } from "./threads.ts";

/** Per-row decorations owned by the viewer. */
export interface RowState {
	cursor: boolean;
	selected: boolean;
	/** The row has a comment anchored to it. */
	commented: boolean;
	/** Search matches in this row's text. */
	match: boolean;
}

export interface FileState {
	folded: boolean;
	reviewed: boolean;
	comments: number;
}

const MAX_HIGHLIGHT_LINES = 4000;

interface Highlighted {
	old: Map<number, string>;
	new: Map<number, string>;
}

export class Painter {
	private hl = new Map<number, Highlighted>();
	private styles?: {
		addBg: string;
		delBg: string;
		addEmph: string;
		delEmph: string;
	};
	numWidth: number;

	constructor(
		private theme: Theme,
		private files: readonly FileDiff[],
		public wrap: boolean,
	) {
		let max = 1;
		for (const f of files) for (const h of f.hunks) max = Math.max(max, h.oldStart + h.oldCount, h.newStart + h.newCount);
		this.numWidth = String(max).length;
	}

	invalidate(theme?: Theme): void {
		if (theme) this.theme = theme;
		this.hl.clear();
		this.styles = undefined;
	}

	private s() {
		if (this.styles) return this.styles;
		const t = this.theme;
		const mode = t.getColorMode();
		const c = t.colors;
		// The theme's success/error backgrounds suit its light or dark appearance; the
		// changed words get the same background pushed toward the diff color.
		this.styles = {
			addBg: t.getBgAnsi("toolSuccessBg"),
			delBg: t.getBgAnsi("toolErrorBg"),
			addEmph: backgroundAnsi(mixColors(c.toolSuccessBg, c.toolDiffAdded, 0.3), mode),
			delEmph: backgroundAnsi(mixColors(c.toolErrorBg, c.toolDiffRemoved, 0.3), mode),
		};
		return this.styles;
	}

	private highlighted(fi: number): Highlighted {
		let h = this.hl.get(fi);
		if (h) return h;
		h = { old: new Map(), new: new Map() };
		const f = this.files[fi];
		const lang = getLanguageFromPath(filePath(f));
		const oldLines: DiffLine[] = [];
		const newLines: DiffLine[] = [];
		for (const hunk of f.hunks)
			for (const l of hunk.lines) {
				if (l.oldLine !== undefined) oldLines.push(l);
				if (l.newLine !== undefined) newLines.push(l);
			}
		const fill = (lines: DiffLine[], map: Map<number, string>, key: "oldLine" | "newLine") => {
			if (!lang || lines.length > MAX_HIGHLIGHT_LINES) return;
			let out: string[];
			try {
				out = highlightCode(lines.map((l) => expandTabs(l.text)).join("\n"), lang);
			} catch {
				return;
			}
			if (out.length !== lines.length) return;
			lines.forEach((l, k) => map.set(l[key] as number, out[k]));
		};
		fill(oldLines, h.old, "oldLine");
		fill(newLines, h.new, "newLine");
		this.hl.set(fi, h);
		return h;
	}

	private code(fi: number, l: DiffLine): string {
		const h = this.highlighted(fi);
		const hit = l.kind === "del" ? h.old.get(l.oldLine ?? -1) : h.new.get(l.newLine ?? -1);
		return hit ?? expandTabs(l.text);
	}

	private num(n: number | undefined): string {
		return n === undefined ? " ".repeat(this.numWidth) : String(n).padStart(this.numWidth);
	}

	/** The left column: cursor, selection and comment markers. */
	private mark(st: RowState): string {
		const t = this.theme;
		if (st.cursor) return t.fg("accent", "▌");
		if (st.selected) return t.fg("borderAccent", "┃");
		if (st.commented) return t.fg("warning", "●");
		return " ";
	}

	/** One side of a line: background, intraline emphasis and wrapping into `width` columns. */
	private side(fi: number, l: DiffLine | undefined, pair: DiffLine | undefined, width: number, gutter: string, st: RowState): string[] {
		const t = this.theme;
		const s = this.s();
		if (width <= 0) return [""];
		if (!l) return [t.fg("borderMuted", "╱".repeat(Math.max(0, width)))];
		const bg = l.kind === "add" ? s.addBg : l.kind === "del" ? s.delBg : "";
		const emph = l.kind === "add" ? s.addEmph : s.delEmph;
		let ranges: Range[] = [];
		if (pair && l.kind !== "context") {
			const r = l.kind === "del" ? intraline(l.text, pair.text) : intraline(pair.text, l.text);
			if (r) ranges = expandRanges(l.text, l.kind === "del" ? r.old : r.new);
		}
		const sign = l.kind === "add" ? t.fg("toolDiffAdded", "+") : l.kind === "del" ? t.fg("toolDiffRemoved", "-") : " ";
		let text = applyBgRanges(this.code(fi, l), ranges, emph, bg);
		if (st.match) text = t.underline(text);
		if (l.noNewline) text += t.fg("muted", " ⏎̸");
		const gw = visibleWidth(gutter) + 2;
		const tw = Math.max(1, width - gw);
		const parts = this.wrap ? wrapTextWithAnsi(text, tw) : [truncateToWidth(text, tw, "…")];
		if (parts.length === 0) parts.push("");
		return parts.map((p, k) => {
			const g = k === 0 ? `${gutter}${sign} ` : `${" ".repeat(gw - 2)}${t.fg("muted", "↪")} `;
			const pad = Math.max(0, tw - visibleWidth(p));
			return `${bg}${g}${bg}${p}${bg}${" ".repeat(pad)}\x1b[49m`;
		});
	}

	render(
		row: Row,
		width: number,
		st: RowState,
		ctx: { thread?: Thread; file?: FileState; isOrphanHeader?: boolean },
	): string[] {
		const t = this.theme;
		const mark = this.mark(st);
		const w = width - 1;
		const fit = (s: string) => truncateToWidth(s, width, "…");
		switch (row.kind) {
			case "blank":
				return [mark];
			case "file": {
				const f = this.files[row.file];
				const fs = ctx.file ?? { folded: false, reviewed: false, comments: 0 };
				const status = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" }[f.status];
				const color = f.status === "added" ? "toolDiffAdded" : f.status === "deleted" ? "toolDiffRemoved" : "accent";
				const name = f.status === "renamed" ? `${f.oldPath} → ${f.newPath}` : filePath(f);
				const stats = `${t.fg("toolDiffAdded", `+${f.additions}`)} ${t.fg("toolDiffRemoved", `-${f.deletions}`)}`;
				const extra = [
					fs.comments ? t.fg("warning", `● ${fs.comments}`) : "",
					fs.reviewed ? t.fg("success", "✓ reviewed") : "",
				]
					.filter(Boolean)
					.join("  ");
				const fold = fs.folded ? "▸" : "▾";
				const label = fs.reviewed
					? t.fg("dim", `${fold} ${status} ${name}`)
					: `${t.fg("muted", fold)} ${t.fg(color, status)} ${t.bold(name)}`;
				const title = `${label}  ${stats}${extra ? `  ${extra}` : ""} `;
				const rule = t.fg("borderMuted", "─".repeat(Math.max(0, w - visibleWidth(title))));
				return [fit(`${mark}${title}${rule}`)];
			}
			case "hunk": {
				const h = this.files[row.file].hunks[row.hunk];
				const head = `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;
				return [fit(`${mark}${t.fg("muted", head)} ${t.fg("mdHeading", h.section)}`)];
			}
			case "note":
				return [fit(`${mark}${t.fg(row.file < 0 ? "accent" : "muted", row.file < 0 ? row.text : `  ${row.text}`)}`)];
			case "line": {
				const l = row.line;
				const gutter = t.fg("muted", `${this.num(l.oldLine)} ${this.num(l.newLine)} `);
				return this.side(row.file, l, row.pair, w, gutter, st).map((s, k) => (k === 0 ? mark : st.selected || st.cursor ? mark : " ") + s);
			}
			case "split": {
				const lw = Math.floor((w - 1) / 2);
				const rw = w - 1 - lw;
				const leftL = row.left;
				const rightL = row.right;
				const pairL = leftL?.kind === "del" ? rightL : undefined;
				const pairR = rightL?.kind === "add" ? leftL : undefined;
				const left = this.side(row.file, leftL, pairL, lw, t.fg("muted", `${this.num(leftL?.oldLine)} `), st);
				const right = this.side(row.file, rightL, pairR, rw, t.fg("muted", `${this.num(rightL?.newLine)} `), st);
				const n = Math.max(left.length, right.length);
				const out: string[] = [];
				for (let k = 0; k < n; k++) {
					const lpart = left[k] ?? " ".repeat(lw);
					const rpart = right[k] ?? " ".repeat(rw);
					out.push(`${k === 0 || st.cursor || st.selected ? mark : " "}${lpart}${t.fg("borderMuted", "│")}${rpart}`);
				}
				return out;
			}
			case "thread": {
				const th = ctx.thread;
				if (!th) return [mark];
				return this.thread(th, row.outdated, width, mark);
			}
		}
	}

	private thread(th: Thread, outdated: boolean, width: number, mark: string): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 5);
		const bar = t.fg(th.status === "draft" ? "warning" : th.status === "answered" ? "success" : "borderAccent", "┃");
		const statusText = {
			draft: t.fg("warning", "draft"),
			sent: t.fg("accent", "sent"),
			answered: t.fg("success", "answered"),
			resolved: t.fg("dim", "resolved"),
		}[th.status];
		const where = th.start === 0 ? "file" : th.start === th.end ? `L${th.start}` : `L${th.start}-${th.end}`;
		const head = `${t.bold("you")} ${t.fg("muted", `${where}${th.side === "old" ? " (old)" : ""}`)} ${statusText}${outdated ? ` ${t.fg("warning", "outdated")}` : ""}`;
		const lines: string[] = [head];
		if (th.suggestion !== undefined) {
			for (const l of th.suggestion.split("\n")) lines.push(t.fg("toolDiffAdded", `+ ${expandTabs(l)}`));
		}
		if (th.body.trim()) for (const l of th.body.split("\n")) lines.push(t.fg("text", l));
		if (th.reply) {
			lines.push(t.bold(t.fg("accent", "agent")));
			for (const l of th.reply.split("\n")) lines.push(t.fg("customMessageText", l));
		}
		const out: string[] = [];
		lines.forEach((l, k) => {
			for (const part of wrapTextWithAnsi(l, inner)) out.push(`${k === 0 && out.length === 0 ? mark : " "}   ${bar} ${part}`);
		});
		return out.map((s) => truncateToWidth(s, width, "…"));
	}
}
