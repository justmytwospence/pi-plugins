/**
 * Syntax highlighting for `!` / `!!` command output in the transcript.
 *
 * Pi's BashExecutionComponent draws output in one muted color. Once a command has finished, this
 * swaps that output block for a highlighted one when the language is known: from the file a reading
 * command prints (`cat src/a.ts`, `head -50 x.py`, `bat`, `sed -n`), from the command (`git diff`,
 * `git show`, `diff -u`, `jq`, `yq`), or from the output itself (JSON, a unified diff). Anything
 * else keeps Pi's rendering. Truncation and the collapsed preview follow Pi's own rules.
 */
import {
	BashExecutionComponent,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getLanguageFromPath,
	highlightCode,
	truncateTail,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { BASH_HIGHLIGHT_PATCH, patchRegistry } from "../../utils/patch-keys.ts";

/** Pi's collapsed preview of `!` output (bash-execution.js PREVIEW_LINES). */
const PREVIEW_LINES = 20;

const READERS = new Set(["cat", "bat", "batcat", "head", "tail", "less", "more", "nl", "sed", "cut"]);
const DIFF_GIT = new Set(["diff", "show"]);
const LANGUAGE_BY_NAME: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	gemfile: "ruby",
	rakefile: "ruby",
	justfile: "makefile",
	".bashrc": "bash",
	".zshrc": "bash",
	".profile": "bash",
};

/** Rough words of one simple command: quotes stripped, redirections and env assignments dropped. */
function words(segment: string): string[] {
	const out: string[] = [];
	for (const match of segment.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/gu)) {
		out.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	let start = 0;
	while (start < out.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(out[start] ?? "")) start++;
	const rest = out.slice(start);
	if (rest[0] === "sudo" || rest[0] === "command" || rest[0] === "env") rest.shift();
	return rest;
}

function fileLanguage(path: string): string | undefined {
	const base = path.split("/").pop()?.toLowerCase() ?? "";
	return LANGUAGE_BY_NAME[base] ?? (base.includes(".") ? getLanguageFromPath(base) : undefined);
}

function looksLikeJson(output: string): boolean {
	const text = output.trim();
	if (!/^[[{]/u.test(text) || text.length > 2_000_000) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		// JSON Lines: every line an object or array.
		const lines = text.split("\n").filter((l) => l.trim());
		if (lines.length < 2) return false;
		return lines.every((line) => {
			try {
				return typeof JSON.parse(line) === "object";
			} catch {
				return false;
			}
		});
	}
}

function looksLikeDiff(output: string): boolean {
	const text = output.trimStart();
	if (text.startsWith("diff --git ") || /^commit [0-9a-f]{7,}/u.test(text)) return /^@@ /mu.test(text);
	return /^--- .*\n\+\+\+ .*\n@@ /mu.test(text);
}

/** The language to highlight a command's output in, or undefined to keep Pi's plain rendering. */
export function bashOutputLanguage(command: string, output: string): string | undefined {
	const segments = command
		.split(/\|\||&&|[|;\n]/u)
		.map((s) => words(s.trim()))
		.filter((w) => w.length);
	for (const w of segments) {
		const [program = "", ...args] = w;
		const name = program.split("/").pop() ?? program;
		if (name === "git") {
			// The subcommand: skip global options and the values of `-C <path>` / `-c <name=value>`.
			let sub: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i] ?? "";
				if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") i++;
				else if (!arg.startsWith("-")) {
					sub = arg;
					break;
				}
			}
			if (sub && DIFF_GIT.has(sub)) return "diff";
			if ((sub === "log" || sub === "stash") && args.some((a) => a === "-p" || a === "--patch")) return "diff";
		}
		if (name === "diff" && args.some((a) => /^-\w*u/u.test(a) || a === "--unified")) return "diff";
		if (name === "jq") return looksLikeJson(output) ? "json" : undefined;
		if (name === "yq") return "yaml";
	}
	const first = segments[0];
	const reader = first?.[0]?.split("/").pop();
	if (first && reader && READERS.has(reader)) {
		// The first file argument: skip flags and the values of flags that take one.
		const takesValue = new Set(["-n", "-c", "-l", "-f", "-d", "--lines", "--bytes", "--language", "-e"]);
		let language: string | undefined;
		for (let i = 1; i < first.length; i++) {
			const arg = first[i] ?? "";
			if (takesValue.has(arg)) {
				i++;
				continue;
			}
			if (arg.startsWith("-") || (reader === "sed" && i === 1 && !arg.includes("/"))) continue;
			if (arg.startsWith("<")) continue;
			language = fileLanguage(arg);
			if (language) break;
		}
		if (language) return language;
	}
	if (looksLikeJson(output)) return "json";
	if (looksLikeDiff(output)) return "diff";
	return undefined;
}

type Patch = {
	active: boolean;
	original: (this: any, ...args: any[]) => unknown;
	installed: (this: any, ...args: any[]) => unknown;
};

/** Replace the finished output block of a BashExecutionComponent with a highlighted one. */
function highlightOutput(component: any): void {
	if (component.status === "running") return;
	const container = component.contentContainer;
	const children: unknown[] | undefined = container?.children;
	if (!Array.isArray(children) || children.length < 2) return;
	const full: string = (component.outputLines as string[]).join("\n");
	const available = truncateTail(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;
	if (!available) return;
	const language = bashOutputLanguage(String(component.command ?? ""), available);
	if (!language) return;
	const highlighted = highlightCode(available, language);
	const pad: number = component.outputPad ?? 1;
	let block: unknown;
	if (component.expanded) {
		block = new Text(`\n${highlighted.join("\n")}`, pad, 0);
	} else {
		const styled = `\n${highlighted.slice(-PREVIEW_LINES).join("\n")}`;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		block = {
			render(width: number) {
				if (cachedLines === undefined || cachedWidth !== width) {
					cachedLines = truncateToVisualLines(styled, PREVIEW_LINES, width, pad).visualLines;
					cachedWidth = width;
				}
				return cachedLines;
			},
			invalidate() {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	}
	// Pi's order: the `$ command` header, then the output block, then the status line.
	children[1] = block;
}

export function installBashHighlight(): void {
	const prototype = BashExecutionComponent.prototype as any;
	const previous = patchRegistry.get<Patch>(BASH_HIGHLIGHT_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.updateDisplay === previous.installed ? previous.original : prototype.updateDisplay;
	const patch: Patch = {
		active: true,
		original,
		installed: function (this: any, ...args: any[]) {
			const result = original.apply(this, args);
			if (patch.active && config.highlightBashOutput && config.mode !== "off") {
				try {
					highlightOutput(this);
				} catch {
					// Pi's own rendering stays.
				}
			}
			return result;
		},
	};
	prototype.updateDisplay = patch.installed;
	patchRegistry.install(BASH_HIGHLIGHT_PATCH, patch);
}
