import type { TUI } from "@earendil-works/pi-tui";

type Node = {
  children?: Node[];
  entries?: Array<{ component?: Node }>;
  primary?: boolean;
  scrollTo?: unknown;
  render?: (width: number) => string[];
};

/** Read Pi's footer without replacing it. Fullscreen uses [transcript, dock];
 * scrollback uses the footer as the last root child. Unknown layouts leave the existing overlay behavior unchanged.
 * Like pi-copy's transcript discovery, this is guarded private-layout access.
 */
export function footerRows(tui: TUI): number {
  try {
    const ui = tui as unknown as Node & { layoutRoot?: Node; mode?: string };
    const width = tui.terminal.columns;
    if (!ui.layoutRoot) {
      const footer = ui.children?.at(-1);
      return footer?.render ? footer.render(width).length : 0;
    }
    const seen = new Set<Node>();
    const walk = (node: Node, depth: number): number | undefined => {
      if (seen.has(node) || depth > 8) return undefined;
      seen.add(node);
      const entries = node.entries;
      const transcript = entries?.[0]?.component;
      if (entries?.length === 2 && typeof transcript?.scrollTo === "function" && transcript.primary !== false) {
        const footer = entries[1]?.component?.entries?.at(-1)?.component;
        if (footer?.render) return footer.render(width).length;
      }
      for (const child of [...(node.children ?? []), ...(entries ?? []).flatMap(entry => entry.component ? [entry.component] : [])]) {
        const rows = walk(child, depth + 1);
        if (rows !== undefined) return rows;
      }
      return undefined;
    };
    return walk(ui.layoutRoot, 0) ?? 0;
  } catch {
    return 0;
  }
}
