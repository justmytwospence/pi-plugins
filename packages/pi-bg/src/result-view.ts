// How bg_wait's result reads in the transcript. A result is a list of text blocks: task reports and
// log tails stay verbatim, while the result another extension hands over with its outside work (a
// subagent's answer) is Markdown and is rendered as such, as it is when it arrives as a message.
import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Text } from "@earendil-works/pi-tui";

export interface Block {
  text: string;
  markdown?: boolean;
}

/** Details of a result with Markdown blocks: the indexes of its content items to render as Markdown. */
export interface BlockDetails {
  markdown?: number[];
}

/** Rows shown while collapsed, as in Pi's own tool output. */
export const PREVIEW_LINES = 10;

/** A tool result made of blocks; the model gets one text item per block. */
export function blocks(list: Block[]) {
  const markdown = list.flatMap((b, i) => (b.markdown ? [i] : []));
  return {
    content: list.map((b) => ({ type: "text" as const, text: b.text })),
    details: (markdown.length ? { markdown } : {}) as BlockDetails,
  };
}

type Content = { type: string; text?: string };

/** The renderer for a result's blocks: plain ones as Pi shows tool output, the others as Markdown. */
export function blocksView(result: { content: Content[]; details?: unknown }, expanded: boolean, theme: Theme): Component {
  const marked = new Set((result.details as BlockDetails | undefined)?.markdown ?? []);
  const items = result.content.flatMap((c, i) => (c.type === "text" && typeof c.text === "string" ? [{ text: c.text, markdown: marked.has(i) }] : []));
  return new BlocksView(items, expanded, theme);
}

class BlocksView implements Component {
  private cache?: { width: number; lines: string[] };

  constructor(
    private readonly items: Block[],
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines: string[] = [];
    for (const item of this.items) {
      const body = item.text.replace(/\s+$/u, "");
      if (!body) continue;
      if (lines.length) lines.push("");
      const rendered = item.markdown
        ? new Markdown(body.trim(), 0, 0, getMarkdownTheme()).render(width)
        : new Text(body.split("\n").map((l) => this.theme.fg("toolOutput", l)).join("\n"), 0, 0).render(width);
      while (rendered.length && !rendered.at(-1)?.trim()) rendered.pop();
      lines.push(...rendered);
    }
    let out = lines;
    if (!this.expanded && lines.length > PREVIEW_LINES) {
      out = lines.slice(0, PREVIEW_LINES);
      out.push(`${this.theme.fg("muted", `... (${lines.length - PREVIEW_LINES} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${this.theme.fg("muted", ")")}`);
    }
    this.cache = { width, lines: out };
    return out;
  }
}
