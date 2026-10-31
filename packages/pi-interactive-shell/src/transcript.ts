import type { Component } from "@earendil-works/pi-tui";
import type { HandoffResult } from "./handoff.ts";

/** Unsupported Pi 1.4.0 document tree; fail closed if its shape changes. */
export interface ChatContainer {
  children: Component[];
  addChild(child: Component): void;
  removeChild(child: Component): void;
}

function container(value: unknown): value is ChatContainer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatContainer>;
  return Array.isArray(candidate.children) && typeof candidate.addChild === "function" && typeof candidate.removeChild === "function";
}

export interface LayoutShape {
  rendererMode: "regular" | "fullscreen" | "unknown";
  rootChildCount: number;
  rootChildren: string[];
  documentChildCount: number;
  documentChildren: string[];
  primaryLookup: boolean;
  layoutRoot: boolean;
}

type Layout = { mode?: unknown; children?: unknown; layoutRoot?: unknown; getPrimaryScrollView?: () => unknown };
const childrenOf = (value: unknown): unknown[] => {
  const children = (value as { children?: unknown } | undefined)?.children;
  return Array.isArray(children) ? children : [];
};
const names = (children: unknown[]) => children.slice(0, 12).map(child => {
  const name = (child as { constructor?: { name?: unknown } } | undefined)?.constructor?.name;
  return typeof name === "string" ? name.replace(/[^a-zA-Z0-9_$]/g, "").slice(0, 48) : "unknown";
});
export function layoutShape(tui: unknown, document?: unknown): LayoutShape {
  const layout = (tui ?? {}) as Layout;
  let candidate = document;
  if (candidate === undefined) {
    try {
      candidate = layout.mode === "fullscreen"
        ? (layout.getPrimaryScrollView?.() as { child?: unknown } | undefined)?.child
        : childrenOf(tui)[0];
    } catch { /* Diagnostics must not throw if a renderer lookup is unavailable. */ }
  }
  const root = childrenOf(tui), doc = childrenOf(candidate);
  return {
    rendererMode: layout.mode === "fullscreen" ? "fullscreen" : layout.mode === "regular" ? "regular" : "unknown",
    rootChildCount: root.length, rootChildren: names(root),
    documentChildCount: doc.length, documentChildren: names(doc),
    primaryLookup: typeof layout.getPrimaryScrollView === "function", layoutRoot: !!layout.layoutRoot,
  };
}

function documentChat(document: unknown): ChatContainer | undefined {
  if (!container(document) || document.children.length < 3) return undefined;
  const [header, resources, chat, ...trailers] = document.children;
  if (!container(header) || !container(resources) || !container(chat)) return undefined;
  if (!trailers.every(child => !!child && typeof child.render === "function" && typeof child.invalidate === "function")) return undefined;
  return chat;
}

/** Resolve only Pi's primary transcript, never another extension's nested chat. */
export function resolveTranscript(tui: unknown):
  { chat: ChatContainer; source: "primary-scroll-view" | "document-root" } | { reason: string; shape: LayoutShape } {
  const layout = (tui ?? {}) as Layout;
  const reject = (reason: string, document?: unknown) => ({ reason, shape: layoutShape(tui, document) });
  if (layout.mode === "fullscreen") {
    let mounted: unknown;
    try { mounted = layout.getPrimaryScrollView?.(); }
    catch { return reject("primary scroll view lookup failed"); }
    const document = (mounted as { child?: unknown } | undefined)?.child;
    const chat = documentChat(document);
    if (chat) return { chat, source: "primary-scroll-view" };
    const seen = new Set<unknown>(), primary: { child?: unknown }[] = [];
    const walk = (node: unknown, depth: number) => {
      if (!node || typeof node !== "object" || seen.has(node) || depth > 8 || seen.size >= 10_000) return;
      seen.add(node);
      const value = node as { primary?: unknown; child?: unknown; scrollTo?: unknown; entries?: unknown };
      if (value.primary === true && typeof value.scrollTo === "function") primary.push(value);
      const entries = Array.isArray(value.entries) ? value.entries : [];
      for (const entry of entries) walk((entry as { component?: unknown } | undefined)?.component, depth + 1);
      for (const child of childrenOf(node)) walk(child, depth + 1);
    };
    walk(layout.layoutRoot, 0);
    // The pre-frame implicit view is detached and has a render-only child without
    // children. A mounted view or container-shaped child must fail closed.
    if (mounted) {
      const implicit = !seen.has(mounted) && !!document && typeof document === "object" &&
        !("children" in document) && typeof (document as { render?: unknown }).render === "function";
      if (!implicit) return reject("malformed primary transcript document", document);
    }
    if (primary.length > 1) return reject("ambiguous primary scroll views");
    if (primary.length === 0) return reject("primary transcript scroll view not found", document);
    const candidate = primary[0]!.child;
    const found = documentChat(candidate);
    return found ? { chat: found, source: "primary-scroll-view" } : reject("malformed primary transcript document", candidate);
  }
  const document = childrenOf(tui)[0];
  const chat = container(tui) ? documentChat(document) : undefined;
  return chat ? { chat, source: "document-root" } : reject("regular transcript document not found or malformed", document);
}

/** Hide only the newly appended native status card when its preview is retained.
 * Pi appends and records the user_bash result after our handler resolves. Defer
 * until then; never change the result or suppress cards reconstructed on reload.
 * Private component fields are checked conservatively: layout/API drift leaves
 * the native card visible rather than removing an unrelated transcript entry.
 */
export function hideDuplicateStatus(chat: ChatContainer, snapshot: Component, command: string, result: HandoffResult, requestRender: () => void) {
  const existing = new Set(chat.children);
  setImmediate(() => {
    if (!chat.children.includes(snapshot)) return;
    const matches = chat.children.filter(child => {
      if (existing.has(child) || child.constructor.name !== "BashExecutionComponent") return false;
      const card = child as unknown as { command?: string; outputLines?: string[]; exitCode?: number; status?: string };
      const status = result.cancelled ? "cancelled" : result.exitCode !== 0 ? "error" : "complete";
      return card.command === command && card.exitCode === result.exitCode && card.status === status &&
        Array.isArray(card.outputLines) && card.outputLines.join("\n") === result.output;
    });
    if (matches.length !== 1) return;
    chat.removeChild(matches[0]!);
    requestRender();
  });
}

/** Own frozen children; native history remains managed by Pi. */
export class TranscriptPanels {
  private readonly snapshots = new Map<Component, ChatContainer>();

  insert(chat: ChatContainer, panel: Component) { chat.addChild(panel); }

  replace(chat: ChatContainer, panel: Component, snapshot: Component) {
    const index = chat.children.indexOf(panel);
    // A clear or rebuild must not resurrect old output.
    if (index === -1) return;
    chat.children.splice(index, 1, snapshot);
    // Drop references to snapshots Pi has already cleared.
    for (const [child, owner] of this.snapshots) {
      if (!owner.children.includes(child)) this.snapshots.delete(child);
    }
    this.snapshots.set(snapshot, chat);
  }

  clear() {
    for (const [child, chat] of this.snapshots) {
      if (chat.children.includes(child)) chat.removeChild(child);
    }
    this.snapshots.clear();
  }
}

interface FocusPanel {
  focused: boolean;
  handleInput(data: string): void;
  dispose(): void;
}

/** The dialog owns this proxy, not the transcript panel or its retained frame. */
export function createFocusProxy(panel: FocusPanel) {
  return {
    get focused() { return panel.focused; },
    set focused(value: boolean) { panel.focused = value; },
    [Symbol.for("pi-plugins.input-context.v1")]: () => "terminal",
    render: (_width: number): string[] => [],
    handleInput: (data: string) => panel.handleInput(data),
    invalidate() {},
    dispose: () => panel.dispose(),
  };
}
