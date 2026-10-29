/**
 * Split a bash command into runs of lines by language, so a heredoc body is highlighted as what it is
 * (`python3 - <<EOF` as Python, `cat > a.json <<EOF` as JSON) instead of as shell.
 */

export type BashSegment = { language: string | undefined; lines: string[] };

const HEREDOC = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/u;

const EXTENSION_LANGUAGES: Record<string, string> = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	ts: "typescript",
	mts: "typescript",
	tsx: "tsx",
	json: "json",
	py: "python",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	md: "markdown",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	html: "html",
	css: "css",
	sql: "sql",
	rb: "ruby",
	rs: "rust",
	go: "go",
	xml: "xml",
};

const PROGRAM_LANGUAGES: [RegExp, string][] = [
	[/(?:^|[\s/;&|(])(?:python|python3(?:\.\d+)?|pypy3?|uv\s+run(?:\s+--?\S+)*\s+python3?)(?=\s|$)/u, "python"],
	[/(?:^|[\s/;&|(])(?:node|bun|deno|tsx)(?=\s|$)/u, "javascript"],
	[/(?:^|[\s/;&|(])ruby(?=\s|$)/u, "ruby"],
	[/(?:^|[\s/;&|(])perl(?=\s|$)/u, "perl"],
	[/(?:^|[\s/;&|(])(?:psql|sqlite3|duckdb|mysql|athena\S*)(?=\s|$)/u, "sql"],
	[/(?:^|[\s/;&|(])(?:ba|z)?sh(?=\s|$)/u, "bash"],
];

/** Language of the heredoc body that the line opens, or undefined when it cannot be told. */
export function heredocLanguage(line: string): string | undefined {
	const head = line.slice(0, line.search(HEREDOC));
	const rest = line.slice(line.search(HEREDOC));
	const target = /(?:^|\s)>{1,2}\s*(?:'([^']+)'|"([^"]+)"|(\S+))/u.exec(`${head} ${rest.replace(HEREDOC, "")}`);
	const file = target?.[1] ?? target?.[2] ?? target?.[3];
	const extension = file ? /\.([A-Za-z0-9]+)$/u.exec(file)?.[1]?.toLowerCase() : undefined;
	if (extension && EXTENSION_LANGUAGES[extension]) return EXTENSION_LANGUAGES[extension];
	for (const [pattern, language] of PROGRAM_LANGUAGES) if (pattern.test(head)) return language;
	return undefined;
}

/** Lines of the command in order, grouped into shell lines and heredoc bodies. The delimiter line is shell. */
export function splitBashSegments(code: string): BashSegment[] {
	const segments: BashSegment[] = [];
	const push = (language: string | undefined, line: string) => {
		const last = segments[segments.length - 1];
		if (last && last.language === language) last.lines.push(line);
		else segments.push({ language, lines: [line] });
	};
	const lines = code.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		push("bash", line);
		const here = HEREDOC.exec(line);
		if (!here) continue;
		const delimiter = (here[1] ?? here[2] ?? here[3]) as string;
		const strip = line.includes("<<-");
		const language = heredocLanguage(line);
		let end = index + 1;
		while (end < lines.length && (strip ? (lines[end] as string).replace(/^\t+/u, "") : lines[end]) !== delimiter) end++;
		for (let body = index + 1; body < end; body++) push(language, lines[body] as string);
		index = end - 1;
	}
	return segments;
}
