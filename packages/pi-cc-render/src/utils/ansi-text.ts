/**
 * Top-level shared ANSI/terminal control sequence handling.
 *
 * Consolidates the duplicated stripping logic previously scattered across renderer/grouping.ts / renderer/mouse/packets.ts /
 * renderer/compact-mode.ts, shared by renderer and feature.
 */

/** A single CSI sequence (SGR/CUP/ED etc. for colors, cursor, ...). */
const CSI_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** OSC sequence (e.g. \x1b]8;;url\x07 or ST-terminated). */
const OSC_SEQUENCE_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
/** The stricter OSC used by compact-mode's original hasVisibleText (content may not embed ESC). */
const OSC_SEQUENCE_STRICT_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strips all CSI sequences within a line. */
export function stripAnsi(line: string): string {
	return line.replace(CSI_SEQUENCE_RE, "");
}

/** Strips only terminal sequences, preserving the original layout (newlines/whitespace untouched), for hit-range computation. */
export function stripTerminalSequencesPreservingLayout(value: string): string {
	return value.replace(OSC_SEQUENCE_RE, "").replace(CSI_SEQUENCE_RE, "");
}

/** Strips terminal sequences and collapses whitespace (for plain-text comparison). */
export function stripTerminalSequences(value: string): string {
	return stripTerminalSequencesPreservingLayout(value).replace(/\s+/g, " ").trim();
}

/** Whether visible text remains after removing all CSI/OSC sequences from a line (to find first/last content lines of a tool card). */
export function hasVisibleText(line: string): boolean {
	// OSC uses the stricter variant: when content embeds ESC it does not swallow following text, keeping compact-mode's original semantics.
	return line.replace(CSI_SEQUENCE_RE, "").replace(OSC_SEQUENCE_STRICT_RE, "").trim().length > 0;
}

/** Strips background-color ANSI (for repainting the background of a line). */
export function stripBackgroundAnsi(line: string): string {
	return line.replace(/\x1b\[(?:4[0-9]|10[0-7]|48(?:(?:;|:)[0-9]+)+|49)m/g, "");
}

/** Strips the leading status icon of a line (reused for the first tool line inside an expanded group). */
export function stripLeadingStatusIcon(line: string): string {
	return line.replace(
		// Leading icon: ccstyle uses `·`, pi's native output also has `•`; strip both
		/^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)(?:\x1b\[[0-9;]*m)*(?:[✓✗●○■⬤•·])(?:\x1b\[[0-9;]*m)*\s+/,
		"$1",
	);
}

/** Terminal sequences are zero-width (not counted in plain indices), consistent with stripAnsi/stripTerminalSequencesPreservingLayout. */
const ANY_SEQUENCE_RE = new RegExp(`${CSI_SEQUENCE_RE.source}|${OSC_SEQUENCE_RE.source}`, "g");

/** Keeps only characters outside [start, end) (base is the plain index of the first character of text). */
function keepOutsideRange(text: string, base: number, start: number, end: number): string {
	if (base + text.length <= start || base >= end) return text;
	return text.slice(0, Math.max(0, start - base)) + text.slice(Math.max(0, end - base));
}

/**
 * Deletes characters in the plain range [start, end) while keeping the ANSI styles of the rest.
 * Terminal sequences inside the range are kept as is, so characters after the range (such as a closing parenthesis) inherit the previous color,
 * instead of falling back to the terminal default foreground as happens when concatenating plain text after truncation.
 */
export function removeStyledRange(styled: string, start: number, end: number): string {
	if (end <= start) return styled;
	let plain = 0;
	let cursor = 0;
	let out = "";
	for (const match of styled.matchAll(ANY_SEQUENCE_RE)) {
		const text = styled.slice(cursor, match.index);
		out += keepOutsideRange(text, plain, start, end);
		plain += text.length;
		out += match[0];
		cursor = match.index + match[0].length;
	}
	return out + keepOutsideRange(styled.slice(cursor), plain, start, end);
}
