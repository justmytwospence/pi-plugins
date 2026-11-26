// Issue and pull request titles next to their numbers in the agent's replies.
//
// A finished assistant message is rewritten (message_end) so the first mention of each reference
// carries its title: `#76` becomes `#76 (Library panel)`. References are bare `#N` (this checkout's
// repository), `owner/repo#N`, and bare github.com issue and pull request URLs. Code, `<next>` tags
// and mentions whose title is already nearby are left alone, and a reference GitHub does not know
// stays as it is. Titles come from one batched GraphQL query and are cached for the session.
import type { Exec } from "./exec.ts";

export interface Ref {
  /** owner/name, or undefined for this checkout's repository. */
  repo?: string;
  number: number;
  /** Offsets of the reference in the text; the title goes after `end`. */
  start: number;
  end: number;
}

const NAME = "[A-Za-z0-9_.-]+";
const REF = new RegExp(
  [
    // A bare issue or pull request URL (not a Markdown link target, whose label already says what it is).
    `(?<![\\w/(\\]])https?://github\\.com/(?<urlOwner>${NAME})/(?<urlRepo>${NAME})/(?:issues|pull)/(?<urlNumber>\\d+)(?![\\w/#?])`,
    // owner/repo#N
    `(?<![\\w/.-])(?<owner>${NAME})/(?<repo>${NAME})#(?<number>\\d+)(?!\\w)`,
    // #N, not an HTML entity (&#38;), a URL fragment (page#12) or part of a word.
    `(?<![\\w&/#])#(?<bare>\\d+)(?![\\w-])`,
  ].join("|"),
  "g",
);

/** Spans to leave alone: fenced code, inline code, and pi-next-prompt's `<next>` tag. */
function skippedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
  for (const m of text.matchAll(fence)) spans.push([m.index, m.index + m[0].length]);
  const outside = (i: number) => !spans.some(([a, b]) => i >= a && i < b);
  const extra: [number, number][] = [];
  for (const m of text.matchAll(/(`+)[^`]*?\1|<next>[\s\S]*?<\/next>/g)) if (outside(m.index)) extra.push([m.index, m.index + m[0].length]);
  return [...spans, ...extra];
}

export function findRefs(text: string): Ref[] {
  if (!text.includes("#") && !text.includes("github.com")) return [];
  const skipped = skippedSpans(text);
  const refs: Ref[] = [];
  for (const m of text.matchAll(REF)) {
    const start = m.index;
    if (skipped.some(([a, b]) => start >= a && start < b)) continue;
    const g = m.groups!;
    const end = start + m[0].length;
    if (g.urlNumber) refs.push({ repo: `${g.urlOwner}/${g.urlRepo}`, number: Number(g.urlNumber), start, end });
    else if (g.number) refs.push({ repo: `${g.owner}/${g.repo}`, number: Number(g.number), start, end });
    else refs.push({ number: Number(g.bare), start, end });
  }
  return refs;
}

const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** Markdown-inert title text. */
function escapeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

/**
 * The text with the first mention of each reference followed by its title. `repoOf` maps a
 * reference to its owner/name; `title` returns its title, or undefined to leave it as it is.
 */
export function annotate(
  text: string,
  refs: Ref[],
  repoOf: (ref: Ref) => string | undefined,
  title: (key: string) => string | undefined,
  seen = new Set<string>(),
): string {
  let out = "";
  let at = 0;
  for (const ref of refs) {
    const repo = repoOf(ref);
    if (!repo) continue;
    const k = key(repo, ref.number);
    if (seen.has(k)) continue;
    const t = title(k);
    if (!t) continue;
    seen.add(k);
    // Already named nearby ("Library panel (#76)", "#76: Library panel"): leave this mention alone.
    const window = text.slice(Math.max(0, ref.start - t.length - 8), ref.end + t.length + 8).toLowerCase();
    if (window.includes(t.toLowerCase())) continue;
    out += text.slice(at, ref.end) + ` (${escapeTitle(t)})`;
    at = ref.end;
  }
  return at === 0 ? text : out + text.slice(at);
}

/** The GraphQL query for titles of `wanted` (owner/name -> numbers). */
export function titleQuery(wanted: Map<string, number[]>): string {
  const repos = [...wanted].map(([repo, numbers], i) => {
    const [owner, name] = repo.split("/");
    const items = numbers.map((n) => `n${n}: issueOrPullRequest(number:${n}){... on Issue{title} ... on PullRequest{title}}`);
    return `r${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${items.join(" ")}}`;
  });
  return `query{${repos.join(" ")}}`;
}

export interface TitleSource {
  /** owner/name of the checkout at `cwd`, or undefined when it has no GitHub repository. */
  repoAt(cwd: string): Promise<string | undefined>;
  /** Titles by `owner/name#N` key (lowercase repo); null when GitHub has no such issue or pull request. */
  titles(keys: string[], cwd: string): Promise<Map<string, string | null>>;
}

/** Titles from `gh`, cached for the session. Failures are not cached; a later message tries again. */
export function ghTitles(exec: Exec): TitleSource {
  const repos = new Map<string, Promise<string | undefined>>();
  const known = new Map<string, string | null>();
  return {
    repoAt(cwd) {
      let repo = repos.get(cwd);
      if (!repo) {
        repo = exec("gh", ["repo", "view", "--json", "nameWithOwner"], cwd).then(
          (r) => {
            if (r.code !== 0) return undefined;
            try {
              return (JSON.parse(r.stdout) as { nameWithOwner?: string }).nameWithOwner || undefined;
            } catch {
              return undefined;
            }
          },
          () => undefined,
        );
        repos.set(cwd, repo);
      }
      return repo;
    },
    async titles(keys, cwd) {
      const missing = keys.filter((k) => !known.has(k));
      if (missing.length) {
        const wanted = new Map<string, number[]>();
        for (const k of missing) {
          const [repo, n] = k.split("#");
          wanted.set(repo!, [...(wanted.get(repo!) ?? []), Number(n)]);
        }
        // gh exits non-zero when any reference is missing but still prints the rest.
        const r = await exec("gh", ["api", "graphql", "-f", `query=${titleQuery(wanted)}`], cwd).catch(() => undefined);
        let data: Record<string, Record<string, { title?: string } | null> | null> | undefined;
        try {
          data = r?.stdout ? JSON.parse(r.stdout)?.data : undefined;
        } catch {
          data = undefined;
        }
        if (data) {
          [...wanted].forEach(([repo, numbers], i) => {
            const found = data![`r${i}`];
            if (found === undefined) return;
            for (const n of numbers) {
              const item = found?.[`n${n}`];
              if (item === undefined && found) continue;
              known.set(key(repo, n), item?.title ?? null);
            }
          });
        }
      }
      return new Map(keys.filter((k) => known.has(k)).map((k) => [k, known.get(k)!]));
    },
  };
}

interface TextBlock {
  type: "text";
  text: string;
}

/** The assistant message with titles added, or undefined when nothing changes. */
export async function titledMessage<M extends { role?: string; content?: unknown }>(message: M, cwd: string, source: TitleSource): Promise<M | undefined> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const blocks = message.content as { type?: string; text?: string }[];
  const found = blocks.map((b) => (b.type === "text" && typeof b.text === "string" ? findRefs(b.text) : []));
  if (!found.some((refs) => refs.length)) return undefined;
  const here = found.some((refs) => refs.some((r) => !r.repo)) ? await source.repoAt(cwd) : undefined;
  const repoOf = (ref: Ref) => ref.repo ?? here;
  const keys = new Set<string>();
  for (const refs of found) for (const ref of refs) {
    const repo = repoOf(ref);
    if (repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) keys.add(key(repo, ref.number));
  }
  if (!keys.size) return undefined;
  const titles = await source.titles([...keys], cwd);
  const seen = new Set<string>();
  let changed = false;
  const content = blocks.map((b, i) => {
    if (!found[i]!.length) return b;
    const text = annotate((b as TextBlock).text, found[i]!, repoOf, (k) => titles.get(k) ?? undefined, seen);
    if (text === (b as TextBlock).text) return b;
    changed = true;
    return { ...b, text };
  });
  return changed ? { ...message, content } : undefined;
}
