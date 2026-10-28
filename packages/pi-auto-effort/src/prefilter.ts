// The pre-filter: a prompt that is only a go-ahead or thanks ("yes", "go ahead", "lgtm", "thanks")
// keeps the level without asking Jev. Such a message says nothing about how hard the next step is,
// and Jev's answer to it is discarded anyway (the `ack` question). Matching is deliberately narrow:
// every word of the prompt must belong to a listed phrase and the prompt has at most four words, so
// a real request is never mistaken for one. A miss costs one Jev call; a false match would keep a
// stale level for new work.

export interface PrefilterConfig {
  enabled: boolean;
  /** Extra phrases (matched like the built-in ones: lowercase, punctuation ignored, at most 4 words). */
  phrases: string[];
}

export const DEFAULT_PREFILTER: PrefilterConfig = { enabled: true, phrases: [] };

/** Longest prompt, in words, that can be a go-ahead. */
export const MAX_WORDS = 4;

export const BUILT_IN_PHRASES: readonly string[] = [
  "yes",
  "y",
  "yep",
  "yeah",
  "ok",
  "okay",
  "sure",
  "go",
  "go ahead",
  "go for it",
  "continue",
  "proceed",
  "do it",
  "ship it",
  "sounds good",
  "looks good",
  "lgtm",
  "perfect",
  "great",
  "thanks",
  "thank you",
  "ty",
  "cool",
  "nice",
];

/** `value` checked against the defaults; anything invalid keeps the default. */
export function prefilterConfig(value: unknown): PrefilterConfig {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_PREFILTER.enabled,
    phrases: Array.isArray(v.phrases) ? v.phrases.filter((p): p is string => typeof p === "string") : DEFAULT_PREFILTER.phrases,
  };
}

/**
 * Words of a message: lowercase, with whitespace and punctuation (trailing or between words, like
 * "yes, go ahead!") ignored; an apostrophe inside a word stays.
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/gu, ""))
    .filter(Boolean);
}

/**
 * True when the whole prompt is made of go-ahead or thanks phrases (built-in, plus
 * `config.phrases`) and has at most four words: "yes", "Go ahead!", "ok, thanks", "yes do it".
 */
export function isGoAhead(prompt: string, config: Pick<PrefilterConfig, "phrases"> = DEFAULT_PREFILTER): boolean {
  const tokens = words(prompt);
  if (!tokens.length || tokens.length > MAX_WORDS) return false;
  const phrases = new Set([...BUILT_IN_PHRASES, ...config.phrases].map((p) => words(p).join(" ")).filter(Boolean));
  // Can tokens[i..] be split into phrases? At most four words, so the search is tiny.
  const covers = (i: number): boolean => {
    if (i === tokens.length) return true;
    for (let end = tokens.length; end > i; end--) if (phrases.has(tokens.slice(i, end).join(" ")) && covers(end)) return true;
    return false;
  };
  return covers(0);
}
