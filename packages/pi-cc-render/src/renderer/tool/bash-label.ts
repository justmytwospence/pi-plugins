/**
 * Human-readable one-line label for a bash command.
 *
 * Priority: a leading `# description` comment, then a deterministic summary of the parsed command
 * (no model call), then the raw command. The shell tokenizer here only needs to split a command into
 * steps and words well enough to name what it does; it is not a validating parser.
 */

export type BashLabel = {
	text: string;
	source: "comment" | "heuristic" | "raw";
};

type Step = {
	words: string[];
	/** Target of the first `>`/`>>` redirect to a real file. */
	redirOut?: string;
	/** Lines in the heredoc body attached to this step. */
	heredocLines: number;
	/** True when stdout feeds the next step. */
	piped: boolean;
};

const NOISE_REDIRECT_TARGETS = new Set(["/dev/null", "&1", "&2", "-", ""]);

/** Split a command into steps of unquoted words. Handles quotes, `$(...)`, comments, redirects and heredocs. */
export function scanShell(command: string): Step[] {
	const steps: Step[] = [];
	let words: string[] = [];
	let word = "";
	let hasWord = false;
	let redirPending: "out" | "in" | "heredoc" | undefined;
	let heredocStrip = false;
	let redirOut: string | undefined;
	let heredocLines = 0;
	const heredocs: { delimiter: string; strip: boolean; step: Step | undefined }[] = [];
	const pendingForStep: { delimiter: string; strip: boolean }[] = [];

	const endWord = () => {
		if (!hasWord) return;
		const value = word;
		word = "";
		hasWord = false;
		if (redirPending === "heredoc") {
			pendingForStep.push({ delimiter: value, strip: heredocStrip });
		} else if (redirPending === "out") {
			if (!NOISE_REDIRECT_TARGETS.has(value) && redirOut === undefined) redirOut = value;
		} else if (!redirPending) {
			words.push(value);
		}
		redirPending = undefined;
	};
	let lastStep: Step | undefined;
	const endStep = (piped: boolean) => {
		endWord();
		if (words.length || redirOut !== undefined || pendingForStep.length) {
			const step: Step = { words, redirOut, heredocLines, piped };
			steps.push(step);
			lastStep = step;
			for (const entry of pendingForStep) heredocs.push({ ...entry, step });
			pendingForStep.length = 0;
		} else if (piped && lastStep) {
			lastStep.piped = true;
		}
		words = [];
		redirOut = undefined;
		heredocLines = 0;
	};

	const length = command.length;
	let i = 0;
	const skipBalanced = (open: string, close: string): string => {
		// i points at the opening character
		let depth = 0;
		const start = i;
		while (i < length) {
			const char = command[i]!;
			if (char === "\\") {
				i += 2;
				continue;
			}
			if (char === "'" || char === '"') {
				const quote = char;
				i += 1;
				while (i < length && command[i] !== quote) i += command[i] === "\\" && quote === '"' ? 2 : 1;
			} else if (char === open) depth += 1;
			else if (char === close) {
				depth -= 1;
				if (depth === 0) {
					i += 1;
					return command.slice(start, i);
				}
			}
			i += 1;
		}
		return command.slice(start);
	};

	while (i < length) {
		const char = command[i]!;
		const next = command[i + 1];
		if (char === " " || char === "\t" || char === "\r") {
			endWord();
			i += 1;
		} else if (char === "\n") {
			endStep(false);
			i += 1;
			while (heredocs.length) {
				const entry = heredocs.shift()!;
				let lines = 0;
				while (i < length) {
					let end = command.indexOf("\n", i);
					if (end < 0) end = length;
					const line = command.slice(i, end);
					i = Math.min(length, end + 1);
					const compare = entry.strip ? line.replace(/^\t+/, "") : line;
					if (compare === entry.delimiter) break;
					lines += 1;
				}
				if (entry.step) entry.step.heredocLines += lines;
			}
		} else if (char === "\\") {
			if (next === "\n") i += 2;
			else {
				if (next !== undefined) word += next;
				hasWord = true;
				i += 2;
			}
		} else if (char === "'") {
			const end = command.indexOf("'", i + 1);
			word += command.slice(i + 1, end < 0 ? length : end);
			hasWord = true;
			i = end < 0 ? length : end + 1;
		} else if (char === '"') {
			i += 1;
			while (i < length && command[i] !== '"') {
				if (command[i] === "\\" && i + 1 < length) {
					word += command[i + 1];
					i += 2;
				} else if (command[i] === "$" && command[i + 1] === "(") {
					i += 1;
					word += `$${skipBalanced("(", ")")}`;
				} else {
					word += command[i];
					i += 1;
				}
			}
			hasWord = true;
			i += 1;
		} else if (char === "$" && next === "(") {
			i += 1;
			word += `$${skipBalanced("(", ")")}`;
			hasWord = true;
		} else if (char === "$" && next === "{") {
			i += 1;
			word += `$${skipBalanced("{", "}")}`;
			hasWord = true;
		} else if (char === "`") {
			const end = command.indexOf("`", i + 1);
			word += command.slice(i, end < 0 ? length : end + 1);
			hasWord = true;
			i = end < 0 ? length : end + 1;
		} else if (char === "#" && !hasWord) {
			while (i < length && command[i] !== "\n") i += 1;
		} else if ((char === "<" || char === ">") && next === "(") {
			word += char;
			i += 1;
			word += skipBalanced("(", ")");
			hasWord = true;
		} else if (char === "&" && next === ">") {
			endWord();
			i += command[i + 2] === ">" ? 3 : 2;
			redirPending = "out";
		} else if (char === "&" && next === "&") {
			endStep(false);
			i += 2;
		} else if (char === "|") {
			const double = next === "|";
			endStep(!double);
			i += double ? 2 : 1;
		} else if (char === "&" || char === ";") {
			endStep(false);
			i += char === ";" && next === ";" ? 2 : 1;
		} else if (char === "(" || char === ")") {
			endStep(false);
			i += 1;
		} else if (char === ">" || char === "<") {
			// `2>&1`: a bare file-descriptor number before the operator is not a word
			if (hasWord && /^\d+$/.test(word)) {
				word = "";
				hasWord = false;
			} else endWord();
			if (char === ">") {
				i += next === ">" ? 2 : 1;
				if (command[i] === "&") {
					i += 1;
					if (/[\d-]/.test(command[i] ?? "")) {
						// `>&2`, `>&-`: duplicate or close a descriptor, no file target
						i += 1;
						continue;
					}
				}
				redirPending = "out";
			} else if (next === "<" && command[i + 2] === "<") {
				i += 3;
				redirPending = "in";
			} else if (next === "<") {
				heredocStrip = command[i + 2] === "-";
				i += heredocStrip ? 3 : 2;
				redirPending = "heredoc";
			} else {
				i += 1;
				redirPending = "in";
			}
		} else {
			word += char;
			hasWord = true;
			i += 1;
		}
	}
	endStep(false);
	return steps;
}

const WRAPPERS = new Set(["sudo", "time", "nohup", "command", "builtin", "exec", "nice", "caffeinate", "stdbuf", "env"]);
const NOISE_PROGRAMS = new Set([
	"set",
	"export",
	"unset",
	"true",
	"false",
	":",
	"[",
	"[[",
	"test",
	"source",
	".",
	"alias",
	"shopt",
	"umask",
	"trap",
	"local",
	"declare",
	"readonly",
	"read",
	"wait",
	"done",
	"fi",
	"esac",
	"}",
	"{",
]);
/** Pipeline consumers that only trim or count; they do not change what the command is about. */
const TRIM_FILTERS = new Set(["grep", "egrep", "fgrep", "rg", "awk", "sed", "jq", "head", "tail", "wc", "less", "more", "tee", "cat", "sort", "uniq", "tr", "cut", "column", "nl", "xargs", "bat"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function clipText(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

function lastSegments(path: string, count = 2): string {
	const clean = path.replace(/\/+$/, "");
	const parts = clean.split("/").filter(Boolean);
	if (parts.length <= count || (parts[0] === "~" && parts.length <= count + 1)) return clean || path;
	return `…/${parts.slice(-count).join("/")}`;
}

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(index + 1) : path;
}

/** Non-flag arguments; `valueFlags` consume the following word. `--` ends flag parsing. */
function positionals(args: string[], valueFlags: ReadonlySet<string> = new Set()): string[] {
	const out: string[] = [];
	let flags = true;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (flags && arg === "--") {
			flags = false;
			continue;
		}
		if (flags && arg.startsWith("-") && arg.length > 1) {
			if (valueFlags.has(arg)) index += 1;
			continue;
		}
		out.push(arg);
	}
	return out;
}

function flagValue(args: string[], ...names: string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		for (const name of names) {
			if (arg === name) return args[index + 1];
			if (name.startsWith("--") && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
		}
	}
	return undefined;
}

function numericFlag(args: string[]): number | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "-n" || arg === "--lines" || arg === "-c") {
			const value = Number(args[index + 1]);
			if (Number.isFinite(value)) return value;
		}
		const match = /^-(\d+)$/.exec(arg) ?? /^-n(\d+)$/.exec(arg) ?? /^--lines=(\d+)$/.exec(arg);
		if (match) return Number(match[1]);
	}
	return undefined;
}

const SUBCOMMAND_TOOLS = new Set([
	"docker",
	"podman",
	"kubectl",
	"gh",
	"systemctl",
	"journalctl",
	"launchctl",
	"brew",
	"chezmoi",
	"cargo",
	"go",
	"uv",
	"pip",
	"pip3",
	"apt",
	"apt-get",
	"herdr",
	"vercel",
	"aws",
	"gcloud",
	"terraform",
	"helm",
	"tmux",
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"slackcli",
	"aac",
]);

const SEARCH_VALUE_FLAGS = new Set([
	"-e",
	"-g",
	"-t",
	"-T",
	"-A",
	"-B",
	"-C",
	"-m",
	"-j",
	"-f",
	"--glob",
	"--type",
	"--max-count",
	"--include",
	"--exclude",
	"--exclude-dir",
	"--type-not",
	"--context",
	"--after-context",
	"--before-context",
	"--max-depth",
	"--threads",
]);

function describeSearch(args: string[]): string {
	const explicit = flagValue(args, "-e", "--regexp");
	const rest = positionals(args, SEARCH_VALUE_FLAGS);
	const pattern = explicit ?? rest.shift();
	if (pattern === undefined) return "Search";
	const where = rest.length ? ` in ${rest.slice(0, 2).map((p) => lastSegments(p)).join(", ")}${rest.length > 2 ? "…" : ""}` : "";
	return `Search "${clipText(pattern, 40)}"${where}`;
}

function describeGit(args: string[]): string {
	const rest = [...args];
	while (rest.length) {
		const arg = rest[0]!;
		if (arg === "-C" || arg === "-c") rest.splice(0, 2);
		else if (arg.startsWith("-")) rest.shift();
		else break;
	}
	const sub = rest.shift();
	if (!sub) return "git";
	const tail = positionals(rest, new Set(["-m", "-n", "-b", "-u", "--format", "--pretty", "--author", "--since", "--until"]));
	switch (sub) {
		case "log": {
			const count = numericFlag(rest);
			return count ? `git log (${count} commit${count === 1 ? "" : "s"})` : "git log";
		}
		case "commit": {
			const message = flagValue(rest, "-m", "--message");
			return message ? `git commit: ${clipText(message.split("\n")[0]!, 50)}` : "git commit";
		}
		case "status":
		case "fetch":
		case "pull":
		case "push":
		case "stash":
			return tail.length ? `git ${sub} ${tail.slice(0, 2).join(" ")}` : `git ${sub}`;
		default:
			return tail.length ? `git ${sub} ${clipText(tail.slice(0, 2).join(" "), 40)}` : `git ${sub}`;
	}
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

function describePackageManager(name: string, args: string[]): string {
	const rest = positionals(args, new Set(["--prefix", "-C", "--filter", "-w", "--workspace", "--cwd"]));
	const sub = rest.shift();
	if (!sub) return name;
	if (sub === "run" || sub === "run-script" || sub === "exec" || sub === "dlx" || sub === "x") {
		const script = rest[0];
		return script ? `Run ${clipText(script, 40)} (${name})` : `${name} ${sub}`;
	}
	if (["test", "start", "build", "check", "lint", "dev"].includes(sub)) return `Run ${sub} (${name})`;
	if (sub === "ci" || sub === "install" || sub === "i" || sub === "add") {
		return rest.length ? `${name} ${sub} ${clipText(rest.slice(0, 3).join(" "), 40)}` : `Install dependencies (${name})`;
	}
	return rest.length ? `${name} ${sub} ${clipText(rest[0]!, 40)}` : `${name} ${sub}`;
}

function describeFetch(name: string, args: string[]): string {
	const url = args.find((arg) => /^https?:\/\//.test(arg)) ?? positionals(args, new Set(["-H", "-X", "-d", "-o", "-A", "-u", "--header", "--request", "--data", "--output", "-O"])).find((arg) => /\./.test(arg));
	const method = flagValue(args, "-X", "--request");
	let target = url ?? "";
	try {
		const parsed = new URL(url!.includes("://") ? url! : `https://${url}`);
		target = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
	} catch {
		// keep the raw text
	}
	const verb = method && method.toUpperCase() !== "GET" ? method.toUpperCase() : name === "wget" ? "Download" : "Fetch";
	return target ? `${verb} ${clipText(target, 60)}` : verb;
}

const SCRIPT_RUNNERS = new Set(["python", "python3", "node", "ruby", "perl", "bun", "deno", "tsx", "ts-node"]);

function describeScriptRunner(name: string, step: Step, args: string[]): string {
	const label = name.startsWith("python") ? "python" : name;
	const inline = args.includes("-c") || args.includes("-e") || args.includes("-") || args.includes("-p");
	if (step.heredocLines > 0 || inline) {
		const lines = step.heredocLines > 0 ? step.heredocLines : 1;
		return `Run ${label} script (${lines} line${lines === 1 ? "" : "s"})`;
	}
	const file = positionals(args, new Set(["-m", "-W", "-X", "-r"]))[0];
	if (args.includes("-m") && flagValue(args, "-m")) return `Run ${label} -m ${flagValue(args, "-m")}`;
	return file ? `Run ${label} ${lastSegments(file)}` : name;
}

function describeRead(name: string, args: string[]): string | undefined {
	const files = positionals(args, name === "sed" ? new Set() : new Set(["-n", "-c", "--lines", "--bytes"]));
	if (name === "sed") {
		const script = files[0];
		const range = script ? /^(\d+),(\d+)p$/.exec(script) : null;
		const file = files[1];
		if (args.includes("-n") && file) return range ? `Read ${lastSegments(file)} (lines ${range[1]}-${range[2]})` : `Read ${lastSegments(file)}`;
		return file ? `Edit ${lastSegments(file)} (sed)` : "sed";
	}
	if (!files.length) return undefined;
	const file = lastSegments(files[0]!);
	const count = numericFlag(args);
	if (name === "head" && count) return `Read ${file} (first ${count} lines)`;
	if (name === "tail" && count) return `Read ${file} (last ${count} lines)`;
	return `Read ${file}${files.length > 1 ? ` (+${files.length - 1} files)` : ""}`;
}

/** Describe one step (a command with its arguments). Returns undefined for steps that do not say what the command does. */
function describeStep(step: Step, depth: number): string | undefined {
	let words = [...step.words];
	// Leading control keywords and env assignments do not change what runs
	while (words.length && ["do", "then", "else", "{", "!"].includes(words[0]!)) words.shift();
	while (words.length && (ENV_ASSIGNMENT.test(words[0]!) || WRAPPERS.has(words[0]!))) words.shift();
	if (words[0] === "timeout") words = words.slice(positionals(words.slice(1)).length ? 2 : 1);
	if (!words.length) return step.redirOut ? `Write ${lastSegments(step.redirOut)}` : undefined;

	const program = baseName(words[0]!);
	const args = words.slice(1);

	if (NOISE_PROGRAMS.has(program)) return undefined;
	if (step.redirOut && ["cat", "echo", "printf", "tee"].includes(program)) {
		const lines = step.heredocLines;
		return `Write ${lastSegments(step.redirOut)}${lines ? ` (${lines} line${lines === 1 ? "" : "s"})` : ""}`;
	}

	switch (program) {
		case "cd":
		case "pushd":
			return `cd ${lastSegments(args[0] ?? "~")}`;
		case "rg":
		case "grep":
		case "egrep":
		case "fgrep":
		case "ag":
		case "ack":
			return describeSearch(args);
		case "find": {
			const name = flagValue(args, "-name", "-iname", "-path");
			const root = positionals(args.slice(0, args.findIndex((arg) => arg.startsWith("-")) >= 0 ? args.findIndex((arg) => arg.startsWith("-")) : undefined))[0] ?? ".";
			return name ? `Find ${clipText(name, 40)} in ${lastSegments(root)}` : `Find files in ${lastSegments(root)}`;
		}
		case "fd": {
			const rest = positionals(args, new Set(["-e", "-t", "-d", "-E", "--extension", "--type", "--max-depth", "--exclude"]));
			return rest[0] ? `Find ${clipText(rest[0], 40)}${rest[1] ? ` in ${lastSegments(rest[1])}` : ""}` : "Find files";
		}
		case "ls":
		case "tree":
		case "eza":
		case "exa": {
			const target = positionals(args)[0];
			return target ? `List ${lastSegments(target)}` : "List current directory";
		}
		case "cat":
		case "head":
		case "tail":
		case "bat":
		case "sed":
		case "less":
		case "nl":
			return describeRead(program, args) ?? program;
		case "wc":
			return `Count lines${positionals(args)[0] ? ` in ${lastSegments(positionals(args)[0]!)}` : ""}`;
		case "git":
			return describeGit(args);
		case "curl":
		case "wget":
			return describeFetch(program, args);
		case "jq":
		case "yq":
			return `Query ${program === "jq" ? "JSON" : "YAML"} (${program})`;
		case "echo":
		case "printf":
			return "Print text";
		case "sleep":
			return `Wait ${args[0] ?? ""}${/^\d+$/.test(args[0] ?? "") ? "s" : ""}`.trim();
		case "mkdir":
			return `Create ${lastSegments(positionals(args)[0] ?? "directory")}`;
		case "rm":
		case "rmdir":
		case "trash":
			return `Delete ${positionals(args).slice(0, 2).map((p) => lastSegments(p)).join(", ") || "files"}`;
		case "mv":
		case "cp": {
			const rest = positionals(args);
			const verb = program === "mv" ? "Move" : "Copy";
			return rest.length >= 2 ? `${verb} ${lastSegments(rest[0]!)} → ${lastSegments(rest[rest.length - 1]!)}` : verb;
		}
		case "touch":
		case "chmod":
		case "ln":
			return `${program} ${positionals(args).slice(-1).map((p) => lastSegments(p)).join(" ")}`.trim();
		case "make":
			return `make ${positionals(args)[0] ?? ""}`.trim();
		case "bash":
		case "sh":
		case "zsh": {
			const inner = flagValue(args, "-c");
			if (inner && depth < 1) return describeCommand(inner, depth + 1) ?? "Run shell script";
			const file = positionals(args)[0];
			return file ? `Run ${lastSegments(file)}` : "Run shell script";
		}
		case "ssh": {
			const rest = positionals(args, new Set(["-p", "-i", "-o", "-l", "-J", "-F"]));
			const host = rest.shift();
			const remote = rest.join(" ");
			const inner = remote && depth < 1 ? describeCommand(remote, depth + 1) : undefined;
			const where = host ? host.replace(/^.*@/, "") : "host";
			return inner ? `On ${where}: ${inner}` : `ssh ${where}`;
		}
		case "npx":
		case "bunx":
			return `Run ${clipText(positionals(args)[0] ?? program, 40)} (${program})`;
		case "uv": {
			if (args[0] === "run") {
				const rest = positionals(args.slice(1), new Set(["--with", "--python", "-p", "--project", "--directory"]));
				return rest[0] ? `Run ${clipText(rest[0], 40)} (uv)` : "uv run";
			}
			break;
		}
		default:
	}
	if (PACKAGE_MANAGERS.has(program)) return describePackageManager(program, args);
	if (SCRIPT_RUNNERS.has(program) || /^python3?\.\d+$/.test(program)) return describeScriptRunner(program, step, args);
	if (SUBCOMMAND_TOOLS.has(program)) {
		const values = new Set(["-f", "-n", "-p", "-o", "--namespace", "--context", "--profile", "--region", "--format", "--filter", "--output", "--tail", "--since"]);
		// Subcommand words only: option values such as `--format '{{.Names}}'` are not part of the name
		const rest = positionals(args, values).filter((word) => /^\w[\w.-]*$/.test(word));
		return rest.length ? `${program} ${clipText(rest.slice(0, program === "docker" ? 3 : 2).join(" "), 40)}` : program;
	}
	const first = positionals(args)[0];
	return first ? `${program} ${clipText(first, 40)}` : program;
}

/** Describe a pipeline: the first meaningful step, plus any non-trimming consumers. */
function describePipeline(steps: Step[], depth: number): string | undefined {
	const parts: string[] = [];
	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!;
		const program = baseName(step.words.find((word) => !ENV_ASSIGNMENT.test(word)) ?? "");
		if (index > 0 && TRIM_FILTERS.has(program)) continue;
		const text = describeStep(step, depth);
		if (text) parts.push(text);
	}
	return parts.length ? parts.join(" → ") : undefined;
}

function describeCommand(command: string, depth = 0): string | undefined {
	const steps = scanShell(command);
	const groups: Step[][] = [];
	let current: Step[] = [];
	for (const step of steps) {
		current.push(step);
		if (!step.piped) {
			groups.push(current);
			current = [];
		}
	}
	if (current.length) groups.push(current);

	let loop: string | undefined;
	let condition = false;
	let directory: string | undefined;
	const descriptions: string[] = [];
	for (const group of groups) {
		const head = group[0]!.words[0];
		if (head === "for") {
			const list = group[0]!.words.slice(3).join(" ");
			loop = `For each ${clipText(list || "item", 40)}`;
			continue;
		}
		if (head === "if" || head === "elif" || head === "while" || head === "until") {
			condition = true;
			continue;
		}
		if (condition) {
			if (head !== "then" && head !== "do") continue;
			condition = false;
		}
		if (head === "cd" && group.length === 1 && groups.length > 1) {
			directory = baseName((group[0]!.words[1] ?? "~").replace(/\/+$/, "")) || "/";
			continue;
		}
		const text = describePipeline(group, depth);
		if (!text) continue;
		if (descriptions[descriptions.length - 1] !== text) descriptions.push(text);
	}
	if (descriptions.length > 1) {
		const informative = descriptions.filter((text) => text !== "Print text");
		if (informative.length) descriptions.splice(0, descriptions.length, ...informative);
	}
	if (!descriptions.length) return directory ? `cd ${directory}` : undefined;

	let text: string;
	if (descriptions.length <= 2) text = descriptions.join(", then ");
	else text = `${descriptions[0]} (+${descriptions.length - 1} more steps)`;
	if (loop) text = `${loop}: ${text}`;
	if (directory) text += ` in ${directory}`;
	return text;
}

/** First non-empty line of the command when it is a `# description` comment (not a shebang). */
export function commentDescription(command: string): string | undefined {
	for (const line of command.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (!trimmed.startsWith("#") || trimmed.startsWith("#!")) return undefined;
		const text = trimmed.replace(/^#+\s*/, "").trim();
		return text.length >= 3 ? text : undefined;
	}
	return undefined;
}

const cache = new Map<string, BashLabel>();
const CACHE_LIMIT = 500;

/** Label for a bash command; never throws. */
export function bashLabel(command: string): BashLabel {
	const hit = cache.get(command);
	if (hit) return hit;
	let result: BashLabel;
	try {
		const comment = commentDescription(command);
		const summary = comment ? undefined : describeCommand(command);
		result = comment
			? { text: comment, source: "comment" }
			: summary
				? { text: summary, source: "heuristic" }
				: { text: command.replace(/\s+/g, " ").trim(), source: "raw" };
	} catch {
		result = { text: command.replace(/\s+/g, " ").trim(), source: "raw" };
	}
	if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	cache.set(command, result);
	return result;
}
