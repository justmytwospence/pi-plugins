// Plain shell words for Sidebar's write exceptions (Slack drafts, GitHub issues): a command split
// into statements of pipelines of words, with literal text, quotes, variables assigned earlier in
// the same command, and heredocs. Anything beyond plain words (command substitution, globs,
// redirections, unknown variables) makes it undefined, so the exceptions refuse what they cannot read.

export type Word = { text: string; assign?: string };
export type Stage = { words: Word[]; stdin?: string };

export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Statements of pipelines of words, or undefined when the command uses anything beyond plain words. */
export function tokenize(command: string): Stage[][] | undefined {
  const statements: Stage[][] = [];
  let pipeline: Stage[] = [];
  let stage: Stage = { words: [] };
  let word: Word | undefined;
  let quoted = false;
  let pendingHeredoc: { stage: Stage; delimiter: string; literal: boolean; strip: boolean } | undefined;
  const variables = new Map<string, string>();

  const endWord = () => {
    if (word) stage.words.push(word);
    word = undefined;
    quoted = false;
  };
  const endStage = (): boolean => {
    endWord();
    if (stage.words.length === 0) return false;
    pipeline.push(stage);
    stage = { words: [] };
    return true;
  };
  const endStatement = (): boolean => {
    if (!endStage()) return pipeline.length === 0 && stage.words.length === 0;
    statements.push(pipeline);
    // A statement made only of assignments sets them for the statements after it.
    const only = pipeline.length === 1 && pipeline[0]!.words.every((w) => w.assign !== undefined);
    if (only) for (const w of pipeline[0]!.words) variables.set(w.assign!, w.text);
    pipeline = [];
    return true;
  };
  const append = (text: string) => {
    word ??= { text: "" };
    word.text += text;
  };
  const expand = (source: string, at: number): { value: string; next: number } | undefined => {
    const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(source.slice(at));
    const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(at));
    const match = braced ?? bare;
    if (!match) return undefined;
    const value = variables.get(match[1]!);
    return value === undefined ? undefined : { value, next: at + match[0].length };
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      append(command.slice(i + 1, end));
      quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      word ??= { text: "" };
      quoted = true;
      i += 1;
      for (;;) {
        if (i >= command.length) return undefined;
        const d = command[i]!;
        if (d === '"') { i += 1; break; }
        if (d === "`") return undefined;
        if (d === "\\") {
          const next = command[i + 1];
          if (next === undefined) return undefined;
          if (next === "\n") { i += 2; continue; }
          word.text += '"\\$`'.includes(next) ? next : `\\${next}`;
          i += 2;
          continue;
        }
        if (d === "$") {
          const expanded = expand(command, i);
          if (!expanded) return undefined;
          word.text += expanded.value;
          i = expanded.next;
          continue;
        }
        word.text += d;
        i += 1;
      }
      continue;
    }
    if (c === "\\") {
      const next = command[i + 1];
      if (next === undefined) return undefined;
      if (next !== "\n") append(next);
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); i += 1; continue; }
    if (c === "\n") {
      endWord();
      if (pendingHeredoc) {
        const { stage: target, delimiter, literal, strip } = pendingHeredoc;
        pendingHeredoc = undefined;
        const lines: string[] = [];
        let pos = i + 1;
        for (;;) {
          if (pos > command.length) return undefined;
          const end = command.indexOf("\n", pos);
          const raw = command.slice(pos, end < 0 ? command.length : end);
          const line = strip ? raw.replace(/^\t+/, "") : raw;
          pos = end < 0 ? command.length + 1 : end + 1;
          if (line === delimiter) break;
          if (end < 0) return undefined;
          lines.push(line);
        }
        const body = lines.join("\n");
        if (!literal && /[$`\\]/.test(body)) return undefined;
        target.stdin = `${body}\n`;
        i = pos - 1;
      }
      if (!endStatement()) return undefined;
      i += 1;
      continue;
    }
    if (c === "|") {
      if (command[i + 1] === "|") return undefined;
      if (!endStage()) return undefined;
      i += 1;
      continue;
    }
    if (c === ";" || (c === "&" && command[i + 1] === "&")) {
      if (pendingHeredoc) return undefined;
      if (!endStatement()) return undefined;
      i += c === ";" ? 1 : 2;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      if (pendingHeredoc) return undefined;
      endWord();
      let pos = i + 2;
      const strip = command[pos] === "-";
      if (strip) pos += 1;
      while (command[pos] === " " || command[pos] === "\t") pos += 1;
      const q = command[pos];
      let delimiter: string;
      let literal = false;
      if (q === "'" || q === '"') {
        const end = command.indexOf(q, pos + 1);
        if (end < 0) return undefined;
        delimiter = command.slice(pos + 1, end);
        literal = true;
        pos = end + 1;
      } else {
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(pos));
        if (!match) return undefined;
        delimiter = match[0];
        pos += delimiter.length;
      }
      if (!NAME.test(delimiter)) return undefined;
      pendingHeredoc = { stage, delimiter, literal, strip };
      i = pos;
      continue;
    }
    if (c === "$") {
      // Unquoted expansions split into words; keep to literal text and quoted variables.
      return undefined;
    }
    if (`&<>()\`{}*?[]#~!`.includes(c)) return undefined;
    if (c === "=" && word && !quoted && word.assign === undefined && NAME.test(word.text) && stage.words.length === 0) {
      word.assign = word.text;
      word.text = "";
      i += 1;
      continue;
    }
    append(c);
    i += 1;
  }
  if (pendingHeredoc) return undefined;
  if (!endStatement()) return undefined;
  return statements.length > 0 ? statements : undefined;
}
