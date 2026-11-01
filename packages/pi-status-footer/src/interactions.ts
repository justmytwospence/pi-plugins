import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { FooterActionId, FooterActionsRequest } from "./footer-actions.ts";

/** Zero-based, half-open terminal-cell bounds produced with the final rendered text. */
export interface FooterHit { row: number; startCol: number; endCol: number; action: string }
export interface FooterLayout { lines: string[]; hits: FooterHit[] }
export type FooterComponent = Component & { dispose(): void };

/**
 * Container/fullscreen routing supplies local coordinates. No terminal listeners, mouse
 * capture or focus requests: ordinary-terminal selection remains entirely terminal-owned.
 * The owner must invalidate before replacing a snapshot (and on theme changes).
 * Include terminal columns/rows in the generation token to reject mouse events from
 * the SDK's previous layout between a terminal resize and its next rendered frame.
 */
export function createFooterComponent(
  getLayout: (width: number) => FooterLayout,
  getGeneration: () => number | string,
  canActivate: (action: string) => boolean,
  activate: (action: string) => void | Promise<void>,
): FooterComponent {
  let width: number | undefined;
  let generation: number | string | undefined;
  let height = 0;
  let hits: FooterHit[] = [];
  let disposed = false;
  const invalidate = () => { width = undefined; generation = undefined; height = 0; hits = []; };
  return {
    render(nextWidth) {
      invalidate();
      if (disposed) return [];
      const epoch = getGeneration();
      const layout = getLayout(nextWidth);
      // Do not expose hits if the snapshot/session was replaced while computing the frame.
      if (epoch === getGeneration()) {
        width = nextWidth;
        generation = epoch;
        height = layout.lines.length;
        hits = layout.hits.map((hit) => ({ ...hit }));
      }
      return layout.lines;
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (disposed || generation !== getGeneration() || width !== event.width ||
        event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl ||
        (event.clickCount ?? 1) !== 1 || !Number.isInteger(event.x) || !Number.isInteger(event.y) ||
        event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= Math.min(height, event.height)) return undefined;
      const hit = hits.find((candidate) => candidate.row === event.y &&
        candidate.startCol >= 0 && candidate.endCol <= event.width &&
        event.x >= candidate.startCol && event.x < candidate.endCol);
      if (!hit || !canActivate(hit.action)) return undefined;
      void activate(hit.action);
      return { handled: true, render: false };
    },
    invalidate,
    dispose() { disposed = true; invalidate(); },
  };
}

type NativeAction = "app.model.select" | "app.thinking.cycle";
type NativeHandler = () => void;
/** Narrow structural surface shared by CustomEditor and pi-vim's main editor. */
export interface FooterEditor extends Component {
  handleInput(data: string): void;
  actionHandlers?: {
    get(action: NativeAction): NativeHandler | undefined;
    set(action: NativeAction, handler: NativeHandler): unknown;
  };
}
export interface FooterTui {
  getFocusedComponent?(): Component | null;
  hasOverlay?(): boolean;
}
export interface FooterActionControllerOptions {
  getEditor(): FooterEditor | undefined;
  getTui(): FooterTui | undefined;
  getGeneration(): number;
  /** Active, enabled, current main session; never true for other-session chrome. */
  isCurrent(): boolean;
  getBlocked(): number;
  getPromptDepth(): number;
  isIdle(): boolean;
  isLinked(): boolean;
  /** Read an already-discovered snapshot. Never emit a capability query from render. */
  getActions(): FooterActionsRequest["actions"];
  notify(message: string, type: "warning" | "error"): void;
  refresh(): void;
}
export interface FooterActionController {
  activate(action: string): Promise<void>;
  available(action: string): boolean;
  /** Capture actual main editor/TUI identities. Returns an ownership-safe release. */
  wrapEditor(editor: FooterEditor, tui: FooterTui): () => void;
  dispose(): void;
}

type Binding = { editor: FooterEditor; tui: FooterTui; generation: number; release(): void };
const commands: Record<FooterActionId | "model.open" | "reasoning.cycle", string> = {
  "model.open": "/model", "reasoning.cycle": "/thinking", "workflow.cycle": "/mode",
  "workflow.open": "/mode", "flow.open": "/flow", "execution.status": "/plan-exec",
  "approvals.open": "/approvals", "effort.toggle": "/auto-effort", "context.open": "/context",
  "context.skills": "/context", "cache.status": "/cache-guard", "mcp.open": "/mcp",
};
const isAction = (action: string): action is keyof typeof commands => Object.hasOwn(commands, action);
// Status-only inspections may run during a turn; pickers and all mutations wait for idle.
const needsIdle = (action: string) => action !== "cache.status" && action !== "execution.status";

export function createFooterActionController(options: FooterActionControllerOptions): FooterActionController {
  let disposed = false;
  let binding: Binding | undefined;
  let opening: object | undefined;
  const current = (owner: Binding | undefined): owner is Binding => !!owner && !disposed && binding === owner &&
    options.isCurrent() && options.getGeneration() === owner.generation &&
    options.getEditor() === owner.editor && options.getTui() === owner.tui;
  const hasFocusApi = (owner: Binding) => typeof owner.tui.getFocusedComponent === "function" &&
    typeof owner.tui.hasOverlay === "function";
  const ready = (owner: Binding) => hasFocusApi(owner) && owner.tui.getFocusedComponent!() === owner.editor &&
    owner.tui.hasOverlay!() === false && options.getPromptDepth() === 0 && options.getBlocked() === 0;
  const resolve = (action: string, owner: Binding): (() => void | Promise<void>) | undefined => {
    if (!isAction(action)) return undefined;
    if (action === "model.open" || action === "reasoning.cycle") {
      const handlers = owner.editor.actionHandlers;
      const native = typeof handlers?.get === "function"
        ? handlers.get(action === "model.open" ? "app.model.select" : "app.thinking.cycle") : undefined;
      if (typeof native !== "function") return undefined;
      // The model click and its native key hint must share the same usable entry,
      // including in Linked; a provider alone cannot supply native keyboard routing.
      return action === "model.open" && options.isLinked() ? provider("flow.open") : native;
    }
    return provider(action);
  };
  const provider = (action: FooterActionId): (() => void | Promise<void>) | undefined => {
    const descriptor = options.getActions()[action];
    return descriptor && typeof descriptor.run === "function" ? () => descriptor.run() : undefined;
  };
  const unavailable = (action: string) => {
    if (isAction(action)) options.notify(`Footer control unavailable; use ${action === "model.open" && options.isLinked() ? "/flow" : commands[action]}.`, "warning");
  };
  const available = (action: string): boolean => {
    const owner = binding;
    return current(owner) && !opening && ready(owner) && (!needsIdle(action) || options.isIdle()) && !!resolve(action, owner);
  };
  const activate = async (action: string): Promise<void> => {
    const owner = binding;
    if (!current(owner) || opening) return;
    if (!hasFocusApi(owner)) { unavailable(action); return; }
    if (!ready(owner)) return;
    const run = resolve(action, owner);
    if (!run) { unavailable(action); return; }
    if (needsIdle(action) && !options.isIdle()) {
      options.notify("Wait for the current turn before changing settings or opening footer controls.", "warning");
      return;
    }
    const token = {};
    opening = token;
    try {
      await run();
    } catch (error) {
      if (current(owner)) options.notify(`Footer action failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (opening === token) opening = undefined;
      if (current(owner)) options.refresh();
    }
  };
  const wrapEditor = (editor: FooterEditor, tui: FooterTui): (() => void) => {
    if (disposed) return () => {};
    if (binding?.editor === editor && binding.tui === tui && binding.generation === options.getGeneration()) return binding.release;
    binding?.release();
    const original = editor.handleInput;
    const ownInput = Object.getOwnPropertyDescriptor(editor, "handleInput");
    let routing = false;
    const owner: Binding = { editor, tui, generation: options.getGeneration(), release };
    function handleInput(this: FooterEditor, data: string): void {
      // Substitute only at interaction time: Pi copies native entries after factory creation.
      // Do not interpret keys here. Vim, explicit history, shortcuts and autocomplete keep
      // their original precedence, including nested redispatch by modal editors.
      const handlers = editor.actionHandlers;
      const native = typeof handlers?.get === "function" ? handlers.get("app.model.select") : undefined;
      if (routing || !current(owner) || !options.isLinked() || typeof handlers?.set !== "function" || typeof native !== "function") {
        original.call(this, data);
        return;
      }
      const linked = () => { void activate("model.open"); };
      routing = true;
      handlers.set("app.model.select", linked);
      try {
        original.call(this, data);
      } finally {
        // A native callback or another wrapper may have replaced this entry while handling input.
        if (handlers.get("app.model.select") === linked) handlers.set("app.model.select", native);
        routing = false;
      }
    }
    function release(): void {
      if (editor.handleInput === handleInput) {
        if (ownInput) Object.defineProperty(editor, "handleInput", ownInput);
        else Reflect.deleteProperty(editor, "handleInput");
      }
      if (binding === owner) { binding = undefined; opening = undefined; }
    }
    binding = owner;
    editor.handleInput = handleInput;
    return release;
  };
  return { activate, available, wrapEditor, dispose() { disposed = true; binding?.release(); } };
}
