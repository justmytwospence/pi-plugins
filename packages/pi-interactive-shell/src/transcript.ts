import type { Component } from "@earendil-works/pi-tui";

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

export function findChatContainer(tui: unknown): ChatContainer | undefined {
  if (!container(tui)) return undefined;
  const document = tui.children[0];
  if (!container(document) || document.children.length !== 3 || !document.children.every(container)) return undefined;
  return document.children[2] as unknown as ChatContainer;
}

/** Own only frozen children, never Pi's status messages or other extensions' UI. */
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
