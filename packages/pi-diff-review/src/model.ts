/** Lay a parsed diff out as rows: file headers, hunk headers, lines, and comment threads. */

import { pairRun } from "./intraline.ts";
import { type DiffLine, type FileDiff, filePath, type Hunk } from "./parse.ts";
import type { Side, Thread } from "./threads.ts";

export type ViewMode = "unified" | "split";

export type Row =
	| { kind: "file"; file: number }
	| { kind: "hunk"; file: number; hunk: number }
	| { kind: "line"; file: number; hunk: number; line: DiffLine; pair?: DiffLine }
	| { kind: "split"; file: number; hunk: number; left?: DiffLine; right?: DiffLine }
	| { kind: "note"; file: number; text: string; expand?: boolean }
	| { kind: "thread"; file: number; thread: string; outdated: boolean }
	| { kind: "blank"; file: number };

export interface LayoutOptions {
	mode: ViewMode;
	/** Files shown as their header only (by path). */
	folded: ReadonlySet<string>;
	/** Large files the user asked to show in full (by path). */
	expanded: ReadonlySet<string>;
	threads: readonly Thread[];
	/** Files with more diff lines than this start collapsed behind a note. */
	maxLines: number;
}

export interface Layout {
	rows: Row[];
	/** Index of each file's header row. */
	fileRows: number[];
	/** Threads on files that are not in this diff. */
	orphanStart?: number;
}

function hunkRows(fi: number, hi: number, h: Hunk, mode: ViewMode): Row[] {
	const out: Row[] = [{ kind: "hunk", file: fi, hunk: hi }];
	const lines = h.lines;
	let i = 0;
	while (i < lines.length) {
		const l = lines[i];
		if (l.kind === "context") {
			out.push(mode === "split" ? { kind: "split", file: fi, hunk: hi, left: l, right: l } : { kind: "line", file: fi, hunk: hi, line: l });
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
		while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
		if (mode === "split") {
			for (const [d, a] of pairRun(dels, adds)) out.push({ kind: "split", file: fi, hunk: hi, left: d, right: a });
		} else {
			dels.forEach((d, k) => out.push({ kind: "line", file: fi, hunk: hi, line: d, pair: adds[k] }));
			adds.forEach((a, k) => out.push({ kind: "line", file: fi, hunk: hi, line: a, pair: dels[k] }));
		}
	}
	return out;
}

/** The line a row shows on a side, if any. */
export function rowLineOn(row: Row, side: Side): DiffLine | undefined {
	if (row.kind === "line") {
		const n = side === "new" ? row.line.newLine : row.line.oldLine;
		return n === undefined ? undefined : row.line;
	}
	if (row.kind === "split") {
		const l = side === "new" ? row.right : row.left;
		const n = side === "new" ? l?.newLine : l?.oldLine;
		return n === undefined ? undefined : l;
	}
	return undefined;
}

function lineNo(l: DiffLine, side: Side): number | undefined {
	return side === "new" ? l.newLine : l.oldLine;
}

/** Where a thread sits among a file's rows: the row index to insert after, and whether it still matches. */
export function anchorThread(rows: Row[], from: number, to: number, t: Thread): { after: number; outdated: boolean } {
	if (t.start === 0) return { after: from, outdated: false };
	const want = t.excerpt[t.excerpt.length - 1]?.slice(2);
	let byNumber = -1;
	let best = -1;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let r = from; r < to; r++) {
		const l = rowLineOn(rows[r], t.side);
		if (!l) continue;
		const n = lineNo(l, t.side) ?? 0;
		if (n === t.end) {
			byNumber = r;
			if (want === undefined || l.text === want) return { after: r, outdated: false };
		}
		if (want !== undefined && l.text === want) {
			const d = Math.abs(n - t.end);
			if (d < bestDist) {
				bestDist = d;
				best = r;
			}
		}
	}
	if (best >= 0) return { after: best, outdated: false };
	if (byNumber >= 0) return { after: byNumber, outdated: true };
	return { after: from, outdated: true };
}

export function layout(files: readonly FileDiff[], opts: LayoutOptions): Layout {
	const rows: Row[] = [];
	const fileRows: number[] = [];
	const byFile = new Map<string, Thread[]>();
	for (const t of opts.threads) {
		const list = byFile.get(t.file) ?? [];
		list.push(t);
		byFile.set(t.file, list);
	}
	const placed = new Set<string>();

	files.forEach((f, fi) => {
		const path = filePath(f);
		fileRows.push(rows.length);
		rows.push({ kind: "file", file: fi });
		if (opts.folded.has(path)) {
			for (const t of byFile.get(path) ?? []) placed.add(t.id);
			return;
		}
		const body: Row[] = [];
		const total = f.hunks.reduce((s, h) => s + h.lines.length, 0);
		if (f.binary) body.push({ kind: "note", file: fi, text: "binary file" });
		else if (f.hunks.length === 0) {
			if (f.status === "renamed") body.push({ kind: "note", file: fi, text: `renamed from ${f.oldPath}, contents unchanged` });
			else if (f.oldMode && f.newMode) body.push({ kind: "note", file: fi, text: `mode ${f.oldMode} → ${f.newMode}` });
			else body.push({ kind: "note", file: fi, text: f.status === "added" ? "empty file" : "no textual changes" });
		} else if (total > opts.maxLines && !opts.expanded.has(path)) {
			body.push({ kind: "note", file: fi, text: `${total} diff lines hidden; Enter shows them`, expand: true });
		} else {
			f.hunks.forEach((h, hi) => body.push(...hunkRows(fi, hi, h, opts.mode)));
		}
		if (f.status === "renamed" && f.hunks.length > 0) body.unshift({ kind: "note", file: fi, text: `renamed from ${f.oldPath}` });

		// Insert threads after their anchor rows (indices relative to `body`, with the header at -1).
		const threads = (byFile.get(path) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
		const inserts = new Map<number, Row[]>();
		for (const t of threads) {
			const a = anchorThread(body, 0, body.length, t);
			const after = t.start === 0 ? -1 : a.after;
			const list = inserts.get(after) ?? [];
			list.push({ kind: "thread", file: fi, thread: t.id, outdated: a.outdated });
			inserts.set(after, list);
			placed.add(t.id);
		}
		rows.push(...(inserts.get(-1) ?? []));
		body.forEach((r, k) => {
			rows.push(r);
			rows.push(...(inserts.get(k) ?? []));
		});
		rows.push({ kind: "blank", file: fi });
	});

	const orphans = opts.threads.filter((t) => !placed.has(t.id));
	let orphanStart: number | undefined;
	if (orphans.length) {
		orphanStart = rows.length;
		rows.push({ kind: "note", file: -1, text: "Comments on files not in this diff" });
		for (const t of orphans) rows.push({ kind: "thread", file: -1, thread: t.id, outdated: true });
	}
	return { rows, fileRows, orphanStart };
}

/** The file a row belongs to (-1 for the orphan section). */
export function rowFile(row: Row): number {
	return row.file;
}

export interface Selection {
	file: number;
	side: Side;
	start: number;
	end: number;
	excerpt: string[];
}

function marker(l: DiffLine): string {
	return l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  ";
}

/**
 * The lines a comment covers, from a span of rows in one file. Comments anchor
 * on the new side when the span has any current line, else on the removed lines.
 */
export function selectionFromRows(rows: readonly Row[], from: number, to: number): Selection | undefined {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	const file = rows[lo]?.file;
	if (file === undefined || file < 0) return undefined;
	const lines: DiffLine[] = [];
	const seen = new Set<DiffLine>();
	const push = (l: DiffLine | undefined) => {
		if (l && !seen.has(l)) {
			seen.add(l);
			lines.push(l);
		}
	};
	for (let r = lo; r <= hi; r++) {
		const row = rows[r];
		if (row.file !== file) continue;
		if (row.kind === "line") push(row.line);
		else if (row.kind === "split") {
			push(row.left);
			push(row.right);
		}
	}
	if (lines.length === 0) return undefined;
	// Split rows interleave; show removals before additions like a unified diff.
	const ordered = [...lines.filter((l) => l.kind !== "add"), ...lines.filter((l) => l.kind === "add")];
	const unified = rows[lo].kind === "line" ? lines : ordered;
	const side: Side = lines.some((l) => l.newLine !== undefined) ? "new" : "old";
	const nums = lines.map((l) => (side === "new" ? l.newLine : l.oldLine)).filter((n): n is number => n !== undefined);
	return {
		file,
		side,
		start: Math.min(...nums),
		end: Math.max(...nums),
		excerpt: unified.map((l) => marker(l) + l.text),
	};
}
