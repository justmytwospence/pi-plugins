// Mermaid blocks in a plan as terminal diagrams (grok-mermaid's box drawing), the way Pi draws them
// in chat. Pi's own transformer is not exported, so this mirrors it: each diagram row becomes an
// inline code span on its own line, which keeps its spacing and box-drawing characters through
// Markdown. A diagram wider than the view, or one grok-mermaid cannot draw, stays as its source.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, type MarkdownTheme, Marked } from "@earendil-works/pi-tui";
import { render } from "grok-mermaid";

const parser = new Marked();

type Span = { cls: "border" | "text" | "edge" | "edgeLabel" | "title" | "none"; text: string };

function isMermaid(token: { type: string; lang?: string }): boolean {
  return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

/** One diagram row as an inline code span, with a fence longer than any backtick run in it. */
function codeSpan(line: string): string {
  const content = line || "\u00a0";
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: Span, theme: Theme | undefined): string {
  if (!theme) return span.text;
  switch (span.cls) {
    case "border":
      return theme.fg("borderMuted", span.text);
    case "text":
      return theme.fg("text", span.text);
    case "edge":
      return theme.fg("accent", span.text);
    case "edgeLabel":
      return theme.fg("muted", span.text);
    case "title":
      return theme.fg("accent", theme.bold(span.text));
    default:
      return span.text;
  }
}

/**
 * Mermaid source grok-mermaid reads the way Mermaid does: a semicolon inside a node's label
 * (`D[Resolve tier; refill bucket]`, fine in Mermaid) otherwise ends the statement there, so such
 * labels are quoted.
 */
export function normalizeMermaid(source: string): string {
  return source.replace(
    /(\[|\(|\{)([^\])}"\n]*;[^\])}"\n]*)(\]|\)|\})/gu,
    (_all, open: string, label: string, close: string) => `${open}"${label}"${close}`,
  );
}

/** A left-to-right (or right-to-left) flowchart drawn top-down instead, or undefined. */
function topDown(source: string): string | undefined {
  const turned = source.replace(/^(\s*(?:flowchart|graph)\s+)(?:LR|RL)\b/imu, "$1TD");
  return turned === source ? undefined : turned;
}

function draw(source: string): ReturnType<typeof render> | null {
  try {
    const art = render(source);
    return art && art.warnings.length === 0 ? art : null;
  } catch {
    return null;
  }
}

const BLOCK_START = /^\s*(?:[-*+]|\d+[.)])\s|^\s*(?:```|~~~|>|#|\||-{3,}|\*{3,})/u;

/**
 * Prose a planner hard-wrapped at ~80 columns, rejoined so it reflows at the view's width (Pi's
 * Markdown keeps each source newline as a line break). Hard breaks (two trailing spaces or a
 * backslash), list items, quotes, tables and fenced code keep their lines.
 */
export function unwrapSoftBreaks(raw: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of raw.split("\n")) {
    const previous = out.at(-1);
    const fence = /^\s*(?:```|~~~)/u.test(line);
    const join =
      previous !== undefined &&
      !fenced &&
      !fence &&
      line.trim() !== "" &&
      previous.trim() !== "" &&
      !BLOCK_START.test(line) &&
      !/(?: {2}|\\)$/u.test(previous) &&
      !/^\s*(?:\||>|#)/u.test(previous);
    if (fence) fenced = !fenced;
    if (join) out[out.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}

/**
 * The plan with its top-level Mermaid blocks drawn as diagrams no wider than `width`. A wide
 * left-to-right flowchart is drawn top-down when that fits (terminals are narrower than they are
 * long); a diagram that still does not fit, or that grok-mermaid cannot draw, stays as its source.
 */
export function mermaidArt(markdown: string, width: number, theme?: Theme): string {
  return parser
    .lexer(markdown)
    .map((token) => {
      if (token.type === "paragraph" || token.type === "list") return unwrapSoftBreaks(token.raw);
      if (!isMermaid(token as { type: string; lang?: string })) return token.raw;
      const source = normalizeMermaid((token as { text: string }).text);
      let art = draw(source);
      if (art && art.width > width) {
        const turned = topDown(source);
        art = turned ? draw(turned) : null;
      }
      if (!art || art.width > width) return token.raw;
      const rows = (art.styled as Span[][]).map((row) => row.map((span) => styleSpan(span, theme)).join(""));
      // Markdown hard breaks keep every diagram row on its own line.
      return `${rows.map(codeSpan).join("  \n")}\n`;
    })
    .join("");
}

/** Pi's Markdown component with the plan's Mermaid diagrams drawn for the width it renders at. */
export class PlanMarkdown implements Component {
  private cache: { width: number; markdown: Markdown } | undefined;

  constructor(
    private readonly text: string,
    private readonly markdownTheme: MarkdownTheme,
    private readonly theme?: Theme,
  ) {}

  render(width: number): string[] {
    if (this.cache?.width !== width) {
      this.cache = {
        width,
        markdown: new Markdown(mermaidArt(this.text, width, this.theme), 0, 0, this.markdownTheme),
      };
    }
    return this.cache.markdown.render(width);
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
