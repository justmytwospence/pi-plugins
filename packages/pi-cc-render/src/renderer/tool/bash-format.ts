/**
 * Pretty-print a bash command for the expanded Input view.
 *
 * shfmt (the `sh-syntax` wasm build, an optional dependency loaded on first use) normalizes layout and
 * indents compound commands; a quote- and heredoc-aware pass then puts long `&&`, `||`, `|` and `;` chains
 * on one step per line, which shfmt never does by itself. Without sh-syntax, or when the command does not
 * parse, only the second pass runs. Never throws.
 */

const MAX_FORMAT_CHARS = 20_000;
const CACHE_LIMIT = 200;
const DEFAULT_WIDTH = 80;
const COMPOUND_HEAD = /^\s*(for|while|until|if|elif|select|case)\b/;
const COMPOUND_TAIL = /;\s*(then|do)\b/;

type Printer = (text: string, options?: Record<string, unknown>) => Promise<string>;

let printerPromise: Promise<Printer | undefined> | undefined;

function loadPrinter(): Promise<Printer | undefined> {
	printerPromise ??= import("sh-syntax")
		.then((module) => module.print as Printer)
		.catch(() => undefined);
	return printerPromise;
}

const formatted = new Map<string, string>();
const pending = new Map<string, Set<() => void>>();

/** Break opportunities in one physical line: index just after an operator (and its trailing spaces). */
function breakPoints(line: string, state: { quote?: "'" | '"' }): { at: number; op: string }[] {
	const points: { at: number; op: string }[] = [];
	let depth = 0;
	let backtick = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i]!;
		if (state.quote) {
			if (char === "\\" && state.quote === '"') i += 1;
			else if (char === state.quote) state.quote = undefined;
			continue;
		}
		if (char === "\\") {
			i += 1;
		} else if (char === "'" || char === '"') {
			state.quote = char;
		} else if (char === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
			break;
		} else if (char === "`") {
			backtick = !backtick;
		} else if (char === "(" || char === "{") {
			depth += 1;
		} else if (char === ")" || char === "}") {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0 && !backtick) {
			let op = "";
			if ((char === "&" && line[i + 1] === "&") || (char === "|" && line[i + 1] === "|")) op = char + char;
			else if (char === "|" && line[i - 1] !== "|") op = line[i + 1] === "&" ? "|&" : "|";
			else if (char === ";" && line[i + 1] !== ";") op = ";";
			if (op && line[i - 1] !== ">" && line[i - 1] !== "<") {
				let end = i + op.length;
				while (line[end] === " ") end += 1;
				if (end < line.length) points.push({ at: end, op });
				i += op.length - 1;
			}
		}
	}
	return points;
}

/** Put each step of a long operator chain on its own line; heredoc bodies and multi-line strings are left as they are. */
export function breakLongLines(text: string, width = DEFAULT_WIDTH): string {
	const out: string[] = [];
	let heredoc: { delimiter: string; strip: boolean } | undefined;
	const state: { quote?: "'" | '"' } = {};
	for (const line of text.split("\n")) {
		if (heredoc) {
			out.push(line);
			if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) heredoc = undefined;
			continue;
		}
		const startedInQuote = Boolean(state.quote);
		const points = breakPoints(line, state);
		const here = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w]*))/.exec(line);
		if (here) heredoc = { delimiter: here[2] ?? here[3] ?? here[4]!, strip: here[1] === "-" };
		const compound = COMPOUND_HEAD.test(line) || COMPOUND_TAIL.test(line);
		const usable = points.filter((point) => point.op !== ";" || !compound);
		if (startedInQuote || line.length <= width || usable.length === 0 || here) {
			out.push(line);
			continue;
		}
		const indent = /^[ \t]*/.exec(line)![0];
		let cursor = 0;
		let first = true;
		for (const point of usable) {
			out.push(`${first ? "" : `${indent}${point.op === ";" ? "" : "  "}`}${line.slice(cursor, point.at).trimEnd()}`);
			cursor = point.at;
			first = false;
		}
		out.push(`${indent}  ${line.slice(cursor)}`);
	}
	return out.join("\n");
}

function remember(command: string, text: string): void {
	if (formatted.size >= CACHE_LIMIT) formatted.delete(formatted.keys().next().value!);
	formatted.set(command, text);
}

/**
 * Formatted command text. Returns the final text when it is ready; otherwise the line-broken command
 * straight away, and `onReady` is called once shfmt has produced the real result (ask again then).
 */
export function formatBashCommand(command: string, onReady?: () => void): string {
	const hit = formatted.get(command);
	if (hit !== undefined) return hit;
	const fallback = breakLongLines(command.replace(/\n+$/, ""));
	if (command.length > MAX_FORMAT_CHARS || !command.trim()) {
		remember(command, fallback);
		return fallback;
	}
	let waiters = pending.get(command);
	if (!waiters) {
		waiters = new Set();
		pending.set(command, waiters);
		const started = waiters;
		void loadPrinter()
			.then(async (print) => {
				if (!print) return fallback;
				try {
					return breakLongLines((await print(command, { indent: 2 })).replace(/\n+$/, ""));
				} catch {
					return fallback;
				}
			})
			.then((text) => {
				remember(command, text);
				pending.delete(command);
				if (text !== fallback) for (const callback of started) callback();
			});
	}
	if (onReady) waiters.add(onReady);
	return fallback;
}
