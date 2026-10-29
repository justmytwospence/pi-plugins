/**
 * Pretty-print a bash command for the expanded Input view.
 *
 * shfmt (the `sh-syntax` wasm build, an optional dependency loaded on first use) normalizes layout and
 * indents compound commands; a quote- and heredoc-aware pass then puts long `&&`, `||`, `|` and `;` chains
 * on one step per line, which shfmt never does by itself. Without sh-syntax, or when the command does not
 * parse, only the second pass runs. Never throws.
 */

import { layoutBash } from "./bash-layout.ts";

const MAX_FORMAT_CHARS = 20_000;
const CACHE_LIMIT = 200;

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
	const fallback = layoutBash(command.replace(/\n+$/, ""));
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
					return layoutBash((await print(command, { indent: 2 })).replace(/\n+$/, ""));
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
