// The branch an issue gets: one already linked, one its body names, or a short slug of its title.
import type { Issue } from "./github.ts";

const BODY_BRANCH = /\bbranch\b:?\**\s*`([^`\s]+)`/i;

/** A branch named in the first three non-empty lines of an issue body ("Branch `trip-day`"). */
export function branchFromBody(body: string): string | undefined {
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3);
  for (const line of lines) {
    const match = BODY_BRANCH.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

const STOPWORDS = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "by", "from", "at", "as", "is"]);

/** At most three words and 24 characters of the title, or `issue-<n>`. */
export function slugify(title: string, number: number): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w && !STOPWORDS.has(w));
  let out = "";
  let count = 0;
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > 24 || count === 3) break;
    out = next;
    count++;
  }
  return out || `issue-${number}`;
}

export function suggestBranch(issue: Issue): string {
  return issue.linkedBranches[0] ?? branchFromBody(issue.body) ?? slugify(issue.title, issue.number);
}
