import type { ExtensionAPI, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import type { MermaidArt } from "grok-mermaid";

// Ported from pi-cc-extensions (MIT, minuque): extensions/renderer/markdown-enhance.ts.
// Pi gives each extension one markdownTransformer slot, so every transform is
// chained inside a single registration.

// ----------------------------------------------------------------------------
// grok-mermaid, loaded lazily
// ----------------------------------------------------------------------------

export interface MermaidModule {
  render(src: string): MermaidArt | null;
  sourceBox(src: string, width: number): { plain: string[] };
}

let mermaid: MermaidModule | null = null;

/** Load grok-mermaid once. Until it resolves (or if it cannot), diagram fences pass through. */
export async function loadMermaid(): Promise<MermaidModule | null> {
  if (mermaid) return mermaid;
  try {
    mermaid = (await import("grok-mermaid")) as MermaidModule;
  } catch {
    mermaid = null;
  }
  return mermaid;
}

/** Test hook: inject or clear the renderer without importing it. */
export function setMermaid(module: MermaidModule | null): void {
  mermaid = module;
  ART_CACHE.clear();
}

// ----------------------------------------------------------------------------
// Mermaid dialect fences
// ----------------------------------------------------------------------------

// Pi's built-in transformer only handles ```mermaid; this adds the other
// diagram headers grok-mermaid understands.
const DIAGRAM_FENCE =
  /^(`{3,})\s*(mermaid|statediagram|statediagram-v2|classdiagram|classdiagram-v2|erdiagram|sequencediagram)\s*$/i;
const FENCE_OPEN = /^(`{3,})/;
const FENCE_CLOSE = /^`{3,}\s*$/;

/** Wrap one diagram row as inline code so spacing and box-drawing characters survive. */
function codeSpan(line: string): string {
  const content = line || "\u00a0";
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

/** When rendering fails or the art is wider than the terminal, show the source in a titled box. */
function framedSource(module: MermaidModule, src: string, width: number): string {
  const box = module.sourceBox(src, Math.max(8, width - 2));
  return `\`\`\`\n${box.plain.join("\n")}\n\`\`\``;
}

/** Collect the body of the fence opened at line i. Returns null when it is never closed. */
function collectFence(lines: string[], i: number): { diagram: string; next: number } | null {
  const open = lines[i].match(FENCE_OPEN)?.[0] ?? "```";
  const src: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    if (lines[j].match(FENCE_CLOSE) && lines[j].startsWith(open)) {
      return { diagram: src.join("\n"), next: j + 1 };
    }
    src.push(lines[j]);
    j++;
  }
  return null;
}

// Resize and restore redraws transform the same text repeatedly; cache art by
// source. Fixed cap so long sessions do not grow unbounded; clear when full.
const ART_CACHE = new Map<string, MermaidArt>();
const ART_CACHE_MAX = 50;

function getArt(module: MermaidModule, src: string): MermaidArt | null {
  const cached = ART_CACHE.get(src);
  if (cached) return cached;
  let art: MermaidArt | null = null;
  try {
    art = module.render(src);
  } catch {
    art = null;
  }
  if (ART_CACHE.size >= ART_CACHE_MAX) ART_CACHE.clear();
  if (art) ART_CACHE.set(src, art);
  return art;
}

/** Replace diagram fences with Unicode art. Unclosed fences stay as they are. */
export function renderDiagrams(markdown: string, availableWidth = 80): string {
  const module = mermaid;
  if (!module) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(DIAGRAM_FENCE);
    if (fence) {
      const collected = collectFence(lines, i);
      if (collected) {
        const { diagram, next } = collected;
        // grok-mermaid wants the diagram type as the first line of the source;
        // for dialect fences it only appears in the fence label, so add it back.
        const label = fence[2];
        const src = label.toLowerCase() === "mermaid" ? diagram : `${label}\n${diagram}`;
        const art = getArt(module, src);
        if (art && art.width <= availableWidth) {
          // Hard line breaks (two trailing spaces) keep each row on its own line.
          out.push(art.plain.map(codeSpan).join("  \n"));
        } else {
          out.push(framedSource(module, src, availableWidth));
        }
        i = next;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// ----------------------------------------------------------------------------
// GitHub admonitions
// ----------------------------------------------------------------------------

const ADMONITION = /^>\s*\[\s*!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\s*\]\s*(.*)$/i;
const ADMONITION_LABEL: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/**
 * Turn `> [!TYPE]` and the `>` lines that follow it into a quote with a bold
 * label. Multi-line bodies are joined into one line. Returns null when the line
 * is not an admonition.
 */
function renderAdmonition(lines: string[], i: number): { output: string[]; next: number } | null {
  const m = lines[i].match(ADMONITION);
  if (!m) return null;
  const label = ADMONITION_LABEL[m[1].toUpperCase()];
  const body: string[] = [m[2]];
  let j = i + 1;
  while (j < lines.length && /^>\s?/.test(lines[j]) && !ADMONITION.test(lines[j])) {
    body.push(lines[j].replace(/^>\s?/, ""));
    j++;
  }
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  const content = body.join(" ").trim();
  return {
    output: [`> **${label}:**${content ? ` ${content}` : ""}`, ""],
    next: j,
  };
}

/** Admonitions outside fenced code become labelled quotes. */
export function renderAdmonitions(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (!inFence && /^>\s*\[\s*!/i.test(line)) {
      const result = renderAdmonition(lines, i);
      if (result) {
        out.push(...result.output);
        i = result.next;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// ----------------------------------------------------------------------------
// Circled numbers
// ----------------------------------------------------------------------------

// Nerd Font patches draw U+2460..U+2473 wider than one cell, so they overlap the
// next character on some renderers. "(n)" has the same width in every font.
const CIRCLED_RE = /[\u2460-\u2473]/g;

export function deCircled(markdown: string): string {
  return markdown.replace(CIRCLED_RE, (ch) => `(${ch.codePointAt(0)! - 0x2460 + 1})`);
}

// ----------------------------------------------------------------------------
// Multi-line link labels
// ----------------------------------------------------------------------------

const MULTILINE_LINK_RE = /\[([^\]\n]*(?:\n[^\]\n]*)+)\](?=\()/g;

/** Join link labels that span lines so trailing padding does not become part of the OSC 8 click area. */
export function normalizeMultilineLinks(markdown: string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let inFence = false;
  const flush = () => {
    if (prose.length === 0) return;
    out.push(
      prose.join("\n").replace(MULTILINE_LINK_RE, (_match, label: string) => {
        const normalized = label.replace(/[ \t]*\n[ \t]*/g, " ").trim();
        return `[${normalized}]`;
      }),
    );
    prose = [];
  };
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
    } else if (inFence) {
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

// ----------------------------------------------------------------------------
// Transformer
// ----------------------------------------------------------------------------

export function transform(markdown: string, context?: Partial<MarkdownTransformContext>): string {
  const { messageType, isStreaming = false, availableWidth = 80 } = context ?? {};
  // Thinking is left untouched. While streaming, only the multi-line link fix
  // runs so partial text never gets a wide click area.
  if (messageType === "assistant-thinking") return markdown;
  markdown = normalizeMultilineLinks(markdown);
  if (isStreaming) return markdown;
  markdown = deCircled(markdown);
  markdown = renderDiagrams(markdown, availableWidth);
  return renderAdmonitions(markdown);
}

export default function (pi: ExtensionAPI): void {
  void loadMermaid();
  pi.registerMarkdownTransformer(transform);
}
