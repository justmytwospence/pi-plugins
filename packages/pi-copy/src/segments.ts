// Pieces of the session worth copying, found in code: whole messages, and inside replies the
// logical groups of their Markdown: sections under a heading, fenced code blocks (any fence length,
// so a ````-fenced prompt holding its own ``` blocks is one piece, and its own sections are pieces
// too), lists (with the line that introduces them), list items that carry a nested list or code,
// tables, quotes, commit messages, paragraphs, shell commands, inline code, file paths, and URLs.

export type Kind =
  | "user"
  | "assistant"
  | "section"
  | "code"
  | "command"
  | "snippet"
  | "path"
  | "url"
  | "table"
  | "list"
  | "quote"
  | "commit"
  | "paragraph";

export interface Segment {
  id: string;
  kind: Kind;
  /** What gets copied. */
  text: string;
  /** Code block language, when known. */
  lang?: string;
  /** Index of the user turn the piece belongs to (0 = oldest included). */
  turn: number;
  /** Order within the session, oldest first. */
  order: number;
}

/** Kinds whose copy-worthiness Jev judges (structured kinds are copyable by construction). */
export const PROSE_KINDS = new Set<Kind>(["paragraph", "list", "section", "quote", "assistant"]);

const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "fish", "powershell", "ps1", "cmd"]);
/** Fence languages whose content may itself be Markdown (a prompt, a brief, a document). */
const PROSE_LANGS = new Set(["", "md", "markdown", "text", "txt", "prompt", "plaintext"]);
/** Programs common enough that `<name> <args>` is a command even without flags. */
const PROGRAMS = new Set(
  (
    "git gh npm npx pnpm yarn bun deno node python python3 pip pip3 uv uvx cargo rustup go make just docker podman kubectl helm " +
    "brew apt apt-get dnf pacman ssh scp rsync curl wget cd ls cat less rg grep find fd sed awk jq yq tar unzip chmod chown mkdir rm " +
    "mv cp ln touch echo export source sudo systemctl journalctl launchctl tmux herdr chezmoi stow pi claude codex opencode cursor " +
    "code vercel terraform tofu ansible openssl gpg kill pkill ps top htop env which open xargs tee head tail wc sort diff patch " +
    "bd worktree plugins direnv nix mise asdf poetry pytest vitest tsc eslint prettier ruff black psql sqlite3 redis-cli"
  ).split(" "),
);

const COMMIT = /^(feat|fix|docs|style|refactor|perf|test|tests|build|ci|chore|revert)(\([^)]+\))?!?: \S/u;
const URL = /\bhttps?:\/\/[^\s<>()`"'{}]+[^\s<>()`"'{}.,;:!?]/gu;
const PATH = /(?:^|[\s`'"(])((?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}|~\/[\w./@-]+)(?=$|[\s`'"),:;])/gu;
/** A path with spaces in it, written in parentheses: `(~/Library/Application Support/x.json)`. */
const PAREN_PATH = /\(((?:~|\.{1,2})?\/[^()\n`]*\.[A-Za-z0-9]{1,8})\)/gu;
const CODE_SPAN = /(`+)([^`\n]+?)\1(?!`)/gu;

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const BOLD_HEADING = /^\*\*([^*\n]+)\*\*:?$/u;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/u;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const QUOTE = /^ {0,3}> ?/u;
const TABLE_ROW = /^\s*\|/u;

interface Entry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[]).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
}

// ---------------------------------------------------------------------------------------------
// A small Markdown block parser: enough structure to find the groups a reader sees.

/** A block of a Markdown container. `start`/`end` are line indexes into the container (end exclusive). */
export type Block =
  | { type: "heading"; start: number; end: number; level: number; text: string }
  | { type: "fence"; start: number; end: number; lang: string; fence: string; body: string }
  | { type: "list"; start: number; end: number; items: string[][] }
  | { type: "quote"; start: number; end: number; lines: string[] }
  | { type: "table" | "paragraph" | "rule"; start: number; end: number };

const indentOf = (line: string) => (/^ */u.exec(line) as RegExpExecArray)[0].length;
const blank = (line: string | undefined) => line !== undefined && !line.trim();

function fenceOpen(line: string): { indent: number; fence: string; info: string } | undefined {
  const m = FENCE_OPEN.exec(line);
  if (!m) return undefined;
  const fence = m[2] as string;
  const info = (m[3] ?? "").trim();
  if (fence[0] === "`" && info.includes("`")) return undefined;
  return { indent: (m[1] as string).length, fence, info };
}

/** Whether a line starts a block, so it ends a paragraph or a lazy continuation. */
function startsBlock(line: string): boolean {
  return HEADING.test(line) || !!fenceOpen(line) || LIST_ITEM.test(line) || QUOTE.test(line) || HR.test(line) || TABLE_ROW.test(line);
}

/** The blocks of one Markdown container (a message, a list item, a quote, a fenced document). */
export function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i++;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      const close = new RegExp(`^ {0,3}${open.fence[0] === "`" ? "`" : "~"}{${open.fence.length},}[ \\t]*$`, "u");
      let j = i + 1;
      while (j < n && !close.test(lines[j] as string)) j++;
      const strip = new RegExp(`^ {0,${open.indent}}`, "u");
      const body = lines.slice(i + 1, j).map((l) => l.replace(strip, ""));
      blocks.push({ type: "fence", start: i, end: Math.min(j + 1, n), lang: open.info.split(/\s+/u)[0] ?? "", fence: open.fence, body: body.join("\n") });
      i = j + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", start: i, end: i + 1, level: (heading[1] as string).length, text: (heading[2] ?? "").trim() });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ type: "rule", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list);
      i = list.end;
      continue;
    }
    if (QUOTE.test(line)) {
      let j = i;
      const body: string[] = [];
      while (j < n && !blank(lines[j]) && (QUOTE.test(lines[j] as string) || !startsBlock(lines[j] as string))) {
        body.push((lines[j] as string).replace(QUOTE, ""));
        j++;
      }
      blocks.push({ type: "quote", start: i, end: j, lines: body });
      i = j;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_ROW.test(lines[i + 1] ?? "")) {
      let j = i;
      while (j < n && TABLE_ROW.test(lines[j] as string)) j++;
      blocks.push({ type: "table", start: i, end: j });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < n && !blank(lines[j]) && !startsBlock(lines[j] as string)) j++;
    // A paragraph that is one bold line reads as a heading below any real one.
    const bold = j === i + 1 ? BOLD_HEADING.exec(line.trim()) : null;
    if (bold) blocks.push({ type: "heading", start: i, end: j, level: 7, text: (bold[1] as string).trim() });
    else blocks.push({ type: "paragraph", start: i, end: j });
    i = j;
  }
  return blocks;
}

/** A list starting at `start`: its items, each as its own dedented container. */
function parseList(lines: readonly string[], start: number): Extract<Block, { type: "list" }> {
  const n = lines.length;
  const indent = indentOf(lines[start] as string);
  const items: string[][] = [];
  let i = start;
  let end = start;
  while (i < n) {
    if (blank(lines[i])) {
      // Blank lines between items keep the list going (a loose list).
      let next = i;
      while (next < n && blank(lines[next])) next++;
      const m = next < n ? LIST_ITEM.exec(lines[next] as string) : null;
      if (!m || (m[1] as string).length !== indent) break;
      i = next;
    }
    const m = LIST_ITEM.exec(lines[i] as string);
    if (!m || (m[1] as string).length !== indent) break;
    const gap = (m[3] ?? " ").length;
    const contentCol = indent + (m[2] as string).length + (gap > 4 ? 1 : gap);
    const item = [m[4] ?? ""];
    let j = i + 1;
    while (j < n) {
      const line = lines[j] as string;
      if (!line.trim()) {
        // A blank line stays in the item when what follows is indented under it.
        let next = j;
        while (next < n && blank(lines[next])) next++;
        if (next < n && indentOf(lines[next] as string) > indent) {
          for (; j < next; j++) item.push("");
          continue;
        }
        break;
      }
      const lineIndent = indentOf(line);
      if (lineIndent > indent) item.push(line.slice(Math.min(lineIndent, contentCol)));
      else if (!startsBlock(line)) item.push(line.trimStart()); // lazy continuation
      else break;
      j++;
    }
    items.push(item);
    i = j;
    end = j;
  }
  return { type: "list", start, end, items };
}

// ---------------------------------------------------------------------------------------------

/** Commands in a shell code block: one per line, without prompts, joining `\` continuations. */
export function shellCommands(code: string): string[] {
  const commands: string[] = [];
  let current = "";
  for (const raw of code.split("\n")) {
    const line = raw.replace(/^\s*(?:\$|%|>|PS>)\s+/u, "");
    if (!current && (!line.trim() || line.trim().startsWith("#"))) continue;
    current = current ? `${current}\n${line}` : line;
    if (!/\\\s*$/u.test(line)) {
      commands.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) commands.push(current.trim());
  return commands;
}

/** Whether a line reads as a shell command: a known program, a script path, or a word with flags. */
export function looksLikeCommand(text: string): boolean {
  const tokens = text.trim().split(/\s+/u);
  while (tokens.length > 1 && /^[A-Z_][A-Z0-9_]*=\S*$/u.test(tokens[0] as string)) tokens.shift();
  const head = tokens[0] ?? "";
  if (PROGRAMS.has(head)) return true;
  if (/^(?:\.{1,2}|~)?\/[\w./@-]+$/u.test(head) && !/\.(?:md|json|toml|ya?ml|txt|ts|js|py)$/u.test(head)) return tokens.length > 1 || /\.(?:sh|bash|zsh)$/u.test(head) || head.startsWith("./");
  return tokens.length > 1 && /^[a-z][\w.-]*$/u.test(head) && tokens.slice(1).some((t) => /^--?[A-Za-z]/u.test(t));
}

/** A code block with no language whose every command reads as a shell command. */
function looksLikeShell(code: string): boolean {
  const commands = shellCommands(code);
  return commands.length > 0 && commands.every((c) => looksLikeCommand(c.split("\n")[0] as string));
}

/** URLs, paths, and inline code worth copying on their own, from a run of prose. */
function inlinePieces(text: string): Array<{ kind: Kind; text: string }> {
  const out: Array<{ kind: Kind; text: string }> = [];
  const located = (t: string) => out.some((o) => (o.kind === "path" || o.kind === "url") && o.text.includes(t));
  for (const match of text.matchAll(CODE_SPAN)) {
    const span = (match[2] as string).trim();
    if (span.length < 2 || /^https?:\/\/\S+$/u.test(span)) continue;
    if (/^(?:~|\.{1,2})\/\S*$/u.test(span) || /^\/\S*(?:\/\S|\.[A-Za-z0-9]{1,8}$)/u.test(span) || /^(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}$/u.test(span)) out.push({ kind: "path", text: span });
    else if (span.includes(" ") && looksLikeCommand(span)) out.push({ kind: "command", text: span });
    else if (span.length >= 3 && (/[^A-Za-z0-9\s]/u.test(span) || /^[0-9a-f]{7,40}$/u.test(span) || span.length >= 16)) out.push({ kind: "snippet", text: span });
  }
  for (const match of text.matchAll(URL)) {
    // Skip templated URLs (`http://127.0.0.1:<port>/x`): the match stops at the placeholder.
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (/^:?[<{]/u.test(after)) continue;
    out.push({ kind: "url", text: match[0] });
  }
  for (const match of text.matchAll(PAREN_PATH)) {
    const path = match[1] as string;
    if (!located(path)) out.push({ kind: "path", text: path });
  }
  for (const match of text.matchAll(PATH)) {
    const path = match[1] as string;
    if (!/^https?:/u.test(path) && !located(path)) out.push({ kind: "path", text: path });
  }
  return out;
}

type Emit = (kind: Kind, text: string, lang?: string) => void;

/**
 * Pieces of one Markdown container, in document order. Inside list items standalone paragraphs are
 * not pieces (every bullet would be one); their code, nested lists, and inline pieces are.
 */
function markdownPieces(lines: readonly string[], emit: Emit, inItem: boolean): void {
  const blocks = parseBlocks(lines);
  const slice = (a: number, b: number) => lines.slice(a, b).join("\n").trim();
  const inline = (text: string) => {
    for (const piece of inlinePieces(text)) emit(piece.kind, piece.text);
  };
  const introduced = new Set<Block>();
  blocks.forEach((block, k) => {
    switch (block.type) {
      case "heading": {
        const next = blocks.slice(k + 1).find((b) => b.type === "heading" && b.level <= block.level);
        const end = next ? next.start : lines.length;
        if (blocks.some((b, x) => x > k && b.start < end && b.type !== "rule")) emit("section", slice(block.start, end).replace(/\n+ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u, ""));
        inline(block.text);
        break;
      }
      case "paragraph": {
        const body = slice(block.start, block.end);
        const next = blocks[k + 1];
        const intro = body.endsWith(":") && next !== undefined && next.type !== "heading" && next.type !== "paragraph";
        if (next?.type === "list" && (intro || (inItem && k === 0))) {
          // The line that introduces a list (or heads a list item) belongs with it.
          emit("list", slice(block.start, next.end));
          introduced.add(next);
        } else if (COMMIT.test(body.split("\n")[0] as string)) emit("commit", body);
        else if (!inItem && !intro && body.length >= 40) emit("paragraph", body);
        inline(body);
        break;
      }
      case "list": {
        if (!introduced.has(block)) emit("list", slice(block.start, block.end));
        for (const item of block.items) {
          if (block.items.length > 1 && parseBlocks(item).some((b) => b.type === "list" || b.type === "fence" || b.type === "table")) emit("list", item.join("\n").trim());
          markdownPieces(item, emit, true);
        }
        break;
      }
      case "quote":
        emit("quote", block.lines.join("\n").trim());
        markdownPieces(block.lines, emit, inItem);
        break;
      case "table": {
        const body = slice(block.start, block.end);
        emit("table", body);
        inline(body);
        break;
      }
      case "fence": {
        const lang = block.lang.toLowerCase();
        if (SHELL_LANGS.has(lang) || (!lang && looksLikeShell(block.body))) for (const command of shellCommands(block.body)) emit("command", command);
        emit(COMMIT.test(block.body.split("\n")[0] ?? "") ? "commit" : "code", block.body, block.lang || undefined);
        // A fence that holds a Markdown document (a prompt, a brief): its own groups are pieces too.
        const bodyLines = block.body.split("\n");
        const markdown = lang === "md" || lang === "markdown" || (PROSE_LANGS.has(lang) && (block.fence.length > 3 || bodyLines.some((l) => /^#{2,6}\s+\S/u.test(l))));
        if (markdown) markdownPieces(bodyLines, emit, false);
        break;
      }
      case "rule":
        break;
    }
  });
}

/** Every copyable piece of the last `maxTurns` user turns on the branch, oldest first. */
export function extractSegments(entries: readonly unknown[], maxTurns = 30): Segment[] {
  const messages = (entries as Entry[]).filter((e) => e?.type === "message" && e.message);
  const userIndices = messages.flatMap((e, i) => (e.message?.role === "user" ? [i] : []));
  const start = userIndices.length > maxTurns ? (userIndices[userIndices.length - maxTurns] as number) : 0;
  const segments: Segment[] = [];
  const seen = new Set<string>();
  let turn = -1;
  let whole = "";
  const add: Emit = (kind, text, lang) => {
    const trimmed = text.replace(/\s+$/u, "");
    if (!trimmed.trim()) return;
    const isMessage = kind === "user" || kind === "assistant";
    // A piece that is the whole message adds nothing to the message itself.
    if (!isMessage && trimmed.trim() === whole) return;
    const key = `${isMessage ? kind : "piece"}:${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push({ id: `S${String(segments.length + 1).padStart(3, "0")}`, kind, text: trimmed, ...(lang ? { lang } : {}), turn: Math.max(0, turn), order: segments.length });
  };
  for (const entry of messages.slice(start)) {
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role === "user") {
      turn++;
      whole = textOf(message.content).trim();
      add("user", whole);
    } else if (message.role === "assistant") {
      const text = textOf(message.content).trim();
      if (text) {
        add("assistant", text);
        whole = text;
        markdownPieces(text.split("\n"), add, false);
      }
      whole = "";
      if (Array.isArray(message.content)) {
        for (const block of message.content as ContentBlock[]) {
          if (block?.type !== "toolCall" || block.name !== "bash") continue;
          const command = (block.arguments as { command?: unknown } | undefined)?.command;
          if (typeof command === "string") add("command", command.trim());
        }
      }
    }
  }
  return segments;
}

/** One line for the list. */
export function preview(segment: Segment): string {
  const flat = segment.text.replace(/\s+/gu, " ").trim();
  return segment.kind === "code" && segment.lang ? `${segment.lang}: ${flat}` : flat;
}

/** A stable hash of a segment's content, for caching Jev's judgments within the session. */
export function segmentKey(segment: Segment): string {
  let h = 2166136261;
  const s = `${segment.kind}\u0000${segment.text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
