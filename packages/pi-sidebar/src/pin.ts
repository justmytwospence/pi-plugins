// The pinned prompt bar main shows (pi-sticky-last-prompt), for Sidebar's transcript: once your
// latest prompt has scrolled above the top, it is pinned on the top row; clicking it jumps back.
// Anchor rules and the bar's look follow packages/pi-sticky-last-prompt/src/index.ts (same suite),
// copied so pi-sidebar has no sibling imports; keep the two in step.
import { SkillInvocationMessageComponent, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PIN_ICON = "\uf007";

export interface PromptAnchor {
  /** First document row. */
  start: number;
  /** Exclusive end row. */
  end: number;
  text: string;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function label(child: unknown): string | undefined {
  if (child instanceof UserMessageComponent) return collapse(userText((child as unknown as { text?: unknown }).text));
  if (child instanceof SkillInvocationMessageComponent) {
    const name = (child as unknown as { skillBlock?: { name?: unknown } }).skillBlock?.name;
    return typeof name === "string" && name ? `[skill] ${collapse(name)}` : undefined;
  }
  return undefined;
}

/** Each prompt's rows in a transcript of `children` rendered at `width`. */
export function promptAnchors(children: readonly { render(width: number): string[] }[], width: number): PromptAnchor[] {
  const anchors: PromptAnchor[] = [];
  let row = 0;
  for (const child of children) {
    let height = 0;
    try {
      height = child.render(width).length;
    } catch {
      height = 0;
    }
    const text = label(child);
    if (text && height > 0) anchors.push({ start: row, end: row + height, text });
    row += height;
  }
  return anchors;
}

/** The newest prompt at or above `top`, if it is wholly above it; one on the boundary pins nothing. */
export function pinnedAnchor(anchors: readonly PromptAnchor[], top: number): PromptAnchor | undefined {
  let selected: PromptAnchor | undefined;
  for (const anchor of anchors) if (anchor.start <= top) selected = anchor;
  return selected && selected.end <= top ? selected : undefined;
}

/** The bar, as main draws it. */
export function pinBar(theme: Theme, text: string, width: number): string {
  const name = truncateToWidth(text, Math.max(0, width - 4), "…");
  const line = truncateToWidth(` ${theme.fg("accent", PIN_ICON)} ${theme.fg("text", name)}`, width, "");
  return theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
}
