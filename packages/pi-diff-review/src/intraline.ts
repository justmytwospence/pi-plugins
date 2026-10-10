/**
 * Word-level changes between a removed line and the added line paired with it,
 * as character ranges to emphasize on each side.
 */

export interface Range {
	start: number;
	end: number;
}

const TOKEN_RE = /\w+|\s+|[^\w\s]/gu;
const MAX_TOKENS = 400;

function tokenize(s: string): string[] {
	return s.match(TOKEN_RE) ?? [];
}

/** Changed ranges in `a` and `b`, or undefined when the lines are too long or too different to be useful. */
export function intraline(a: string, b: string): { old: Range[]; new: Range[] } | undefined {
	if (a === b) return { old: [], new: [] };
	const ta = tokenize(a);
	const tb = tokenize(b);
	if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return undefined;

	// LCS table over tokens.
	const n = ta.length;
	const m = tb.length;
	const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const keepA = new Array<boolean>(n).fill(false);
	const keepB = new Array<boolean>(m).fill(false);
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (ta[i] === tb[j]) {
			keepA[i++] = true;
			keepB[j++] = true;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
		else j++;
	}

	// Only whitespace in common is not a meaningful pairing: show the lines as wholly changed.
	const commonNonSpace = ta.some((t, k) => keepA[k] && /\S/.test(t));
	if (!commonNonSpace) return undefined;

	return { old: ranges(ta, keepA), new: ranges(tb, keepB) };
}

function ranges(tokens: string[], keep: boolean[]): Range[] {
	const out: Range[] = [];
	let pos = 0;
	for (let k = 0; k < tokens.length; k++) {
		const len = tokens[k].length;
		if (!keep[k]) {
			const last = out[out.length - 1];
			if (last && last.end === pos) last.end = pos + len;
			else out.push({ start: pos, end: pos + len });
		}
		pos += len;
	}
	// Absorb single whitespace gaps between changed ranges so a phrase reads as one change.
	const merged: Range[] = [];
	for (const r of out) {
		const last = merged[merged.length - 1];
		if (last && r.start - last.end <= 1) last.end = r.end;
		else merged.push({ ...r });
	}
	return merged;
}

/**
 * Pair removed and added lines inside a run of changes: the k-th removal with the
 * k-th addition, which is what side-by-side views and intraline highlighting need.
 */
export function pairRun<T>(dels: T[], adds: T[]): Array<[T | undefined, T | undefined]> {
	const n = Math.max(dels.length, adds.length);
	const out: Array<[T | undefined, T | undefined]> = [];
	for (let k = 0; k < n; k++) out.push([dels[k], adds[k]]);
	return out;
}
