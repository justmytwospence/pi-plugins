import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Extract only the supplied branch's text prompts, most recent distinct text first. */
export function sessionPrompts(entries: readonly SessionEntry[]): string[] {
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content
      .filter((block) => block.type === "text")
      .map((block) => block.text).join("\n");
    if (!text.trim() || seen.has(text)) continue;
    seen.add(text);
    prompts.push(text);
  }
  return prompts;
}

type Navigation = { consume: boolean; text?: string };

/** A frozen prefix run, or a native empty-draft run, lasting until reset/edit. */
export class PrefixHistory {
  private native = false;
  private draft: string | undefined;
  private last: string | undefined;
  private matches: string[] = [];
  private index = -1;

  reset(): void {
    this.native = false;
    this.draft = undefined;
    this.last = undefined;
    this.matches = [];
    this.index = -1;
  }

  navigate(direction: -1 | 1, current: string, prompts: readonly string[]): Navigation {
    if (this.native) return { consume: false };
    if (this.draft !== undefined && current !== this.last) this.reset();
    if (this.draft === undefined) {
      if (current === "") {
        this.native = true;
        return { consume: false };
      }
      // A newer request cannot start a prefix run.
      if (direction === 1) return { consume: true };
      this.draft = current;
      this.last = current;
      this.matches = prompts.filter((text) => text !== current && text.startsWith(current));
    }
    const next = direction === -1
      ? Math.min(this.index + 1, this.matches.length - 1)
      : Math.max(-1, this.index - 1);
    if (next === this.index) return { consume: true };
    this.index = next;
    this.last = next === -1 ? this.draft : this.matches[next];
    return { consume: true, text: this.last };
  }
}
