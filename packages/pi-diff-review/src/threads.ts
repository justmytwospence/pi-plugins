/**
 * Review comments ("threads"): what the user wrote on which lines, the prompt
 * that sends them to the agent, and the agent's per-comment replies, which come
 * back tagged with the thread id and are shown under the comment.
 */

export type Side = "old" | "new";
export type ThreadStatus = "draft" | "sent" | "answered" | "resolved";

export interface Thread {
	id: string;
	file: string;
	side: Side;
	/** First and last line on `side`; 0 for a comment on the whole file. */
	start: number;
	end: number;
	/** The lines commented on, as shown ("+ x", "- y", "  z"), to re-anchor and to quote. */
	excerpt: string[];
	body: string;
	/** Replacement text for the selected lines, when the comment is a suggested edit. */
	suggestion?: string;
	status: ThreadStatus;
	reply?: string;
	createdAt: number;
}

const ID_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";

export function newThreadId(existing: Iterable<string>): string {
	const taken = new Set(existing);
	for (;;) {
		let id = "";
		for (let i = 0; i < 4; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
		if (!taken.has(id)) return id;
	}
}

export function tag(id: string): string {
	return `[[dr:${id}]]`;
}

const LANG_BY_EXT: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	py: "python",
	rs: "rust",
	go: "go",
	rb: "ruby",
	sh: "sh",
	zsh: "sh",
	bash: "sh",
	md: "markdown",
	json: "json",
	toml: "toml",
	yaml: "yaml",
	yml: "yaml",
	sql: "sql",
	css: "css",
	html: "html",
	swift: "swift",
	kt: "kotlin",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	lua: "lua",
	nix: "nix",
};

function fence(text: string): string {
	let ticks = "```";
	while (text.includes(ticks)) ticks += "`";
	return ticks;
}

function lang(file: string): string {
	const ext = file.split(".").pop()?.toLowerCase() ?? "";
	return LANG_BY_EXT[ext] ?? "";
}

export function location(t: Thread): string {
	if (t.start === 0) return `\`${t.file}\``;
	const side = t.side === "old" ? " (removed lines)" : "";
	return t.start === t.end
		? `\`${t.file}\` line ${t.start}${side}`
		: `\`${t.file}\` lines ${t.start}-${t.end}${side}`;
}

function threadBlock(t: Thread): string {
	const parts: string[] = [];
	const kind = t.suggestion !== undefined ? " (suggested edit)" : "";
	parts.push(`### ${tag(t.id)} ${location(t)}${kind}`);
	if (t.suggestion !== undefined) {
		const before = t.excerpt.map((l) => l.slice(2)).join("\n");
		const l = lang(t.file);
		const f1 = fence(before);
		const f2 = fence(t.suggestion);
		parts.push(`Replace:\n${f1}${l}\n${before}\n${f1}\nwith:\n${f2}${l}\n${t.suggestion}\n${f2}`);
	} else if (t.excerpt.length) {
		const body = t.excerpt.join("\n");
		const f = fence(body);
		parts.push(`${f}diff\n${body}\n${f}`);
	}
	if (t.body.trim()) parts.push(t.body.trim());
	return parts.join("\n");
}

/** The user message that sends review comments to the agent. */
export function buildPrompt(threads: Thread[], scopeLabel: string): string {
	const n = threads.length;
	const head =
		`I reviewed your changes (${scopeLabel}) and left ${n} comment${n === 1 ? "" : "s"}. ` +
		"Address each one: make the change when it asks for one, answer it when it asks a question. " +
		"Line numbers refer to the current files unless marked as removed lines.";
	const tail =
		"When you are done, end your reply with one line per comment, in this form:\n" +
		threads.map((t) => `${tag(t.id)} <what you changed, or your answer>`).join("\n");
	return [head, ...threads.map(threadBlock), tail].join("\n\n");
}

const REPLY_RE = /^[\s>*-]*\[\[dr:([a-z0-9]{4})\]\][\s:.-]*(.+)$/gm;

/** Replies the agent tagged with thread ids, from its final text. */
export function parseReplies(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of text.matchAll(REPLY_RE)) {
		const reply = m[2].trim();
		if (reply && !reply.startsWith("<what you changed")) out.set(m[1], reply);
	}
	return out;
}
