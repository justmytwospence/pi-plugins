/** Small ANSI helpers for composing syntax colors with diff backgrounds. */

import type { Range } from "./intraline.ts";

export function expandTabs(s: string, size = 4): string {
	if (!s.includes("\t")) return s;
	let out = "";
	let col = 0;
	for (const ch of s) {
		if (ch === "\t") {
			const n = size - (col % size);
			out += " ".repeat(n);
			col += n;
		} else {
			out += ch;
			col += ch.length;
		}
	}
	return out;
}

/** Map character ranges computed on the raw text onto the tab-expanded text. */
export function expandRanges(raw: string, ranges: Range[], size = 4): Range[] {
	if (!raw.includes("\t") || ranges.length === 0) return ranges;
	const map: number[] = [];
	let col = 0;
	let i = 0;
	for (const ch of raw) {
		map[i] = col;
		col += ch === "\t" ? size - (col % size) : ch.length;
		i += ch.length;
	}
	map[raw.length] = col;
	return ranges.map((r) => ({ start: map[r.start] ?? r.start, end: map[r.end] ?? r.end }));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const SGR_RE = /\x1b\[[0-9;:]*m/y;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const OTHER_ESC_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[A-Za-z])/y;

/**
 * Apply a background to the visible-character ranges of an ANSI string, keeping
 * `base` (the line's own background, or "") outside them and re-applying the
 * right one after any escape that resets the background.
 */
export function applyBgRanges(ansi: string, ranges: Range[], on: string, base: string): string {
	if (ranges.length === 0) return base ? base + reapplyAfterReset(ansi, base) : ansi;
	let out = base;
	let pos = 0; // UTF-16 offset into the visible text, like the ranges
	let r = 0;
	let inside = false;
	let i = 0;
	const current = () => (inside ? on : base);
	while (i < ansi.length) {
		if (ansi[i] === "\x1b") {
			SGR_RE.lastIndex = i;
			const m = SGR_RE.exec(ansi);
			if (m) {
				out += m[0];
				if (resetsBg(m[0])) out += current();
				i += m[0].length;
				continue;
			}
			OTHER_ESC_RE.lastIndex = i;
			const o = OTHER_ESC_RE.exec(ansi);
			if (o) {
				out += o[0];
				i += o[0].length;
				continue;
			}
		}
		while (r < ranges.length && pos >= ranges[r].end) r++;
		const want = r < ranges.length && pos >= ranges[r].start && pos < ranges[r].end;
		if (want !== inside) {
			inside = want;
			out += inside ? on : base || "\x1b[49m";
		}
		const cp = ansi.codePointAt(i) ?? 0;
		const ch = String.fromCodePoint(cp);
		out += ch;
		i += ch.length;
		pos += ch.length;
	}
	if (inside) out += base || "\x1b[49m";
	return out;
}

function resetsBg(sgr: string): boolean {
	const params = sgr.slice(2, -1);
	if (params === "" || params === "0") return true;
	return params.split(";").some((p) => p === "0" || p === "49");
}

function reapplyAfterReset(ansi: string, base: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
	return ansi.replace(/\x1b\[[0-9;:]*m/g, (m) => (resetsBg(m) ? m + base : m));
}
