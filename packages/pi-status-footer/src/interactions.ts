import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { FooterActionId, FooterActionsRequest } from "./footer-actions.ts";
import type { SettingCycleTrigger } from "./settings-cycle.ts";

/** Zero-based, half-open terminal-cell bounds produced with the final rendered text. */
export interface FooterHit { row: number; startCol: number; endCol: number; action: string }
export interface FooterLayout { lines: string[]; hits: FooterHit[] }
export type FooterComponent = Component & { dispose(): void; describe(): { layouts: number[]; lastMouse?: { type: string; button: string; x: number; y: number; width: number; reason: string } } };

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
  let generation: number | string | undefined;
  const layouts = new Map<number, { height: number; hits: FooterHit[] }>();
  let pending: { x: number; y: number; width: number; generation: number | string; action: string } | undefined;
  let lastMouse: { type: string; button: string; x: number; y: number; width: number; reason: string } | undefined;
  let disposed = false;
  const invalidate = () => { generation = undefined; layouts.clear(); pending = undefined; };
  const describe = () => ({ layouts: [...layouts.keys()], lastMouse });
  return {
    render(nextWidth) {
      if (disposed) return [];
      const epoch = getGeneration();
      if (generation !== epoch) invalidate();
      const layout = getLayout(nextWidth);
      // A measurement render at a different width must not retire the visible hit map.
      if (epoch === getGeneration()) {
        generation = epoch;
        layouts.delete(nextWidth);
        layouts.set(nextWidth, { height: layout.lines.length, hits: layout.hits.map((hit) => ({ ...hit })) });
        if (layouts.size > 4) layouts.delete(layouts.keys().next().value!);
      }
      return layout.lines;
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      const note = (reason: string) => { lastMouse = { type: event.type, button: event.button, x: event.x, y: event.y, width: event.width, reason }; return undefined; };
      if (disposed || generation !== getGeneration()) { pending = undefined; return note("stale generation"); }
      const layout = layouts.get(event.width);
      if (!layout) { pending = undefined; return note("missing layout width"); }
      const valid = !event.shift && !event.alt && !event.ctrl && (event.clickCount ?? 1) === 1 &&
        Number.isInteger(event.x) && Number.isInteger(event.y) && event.x >= 0 && event.x < event.width &&
        event.y >= 0 && event.y < Math.min(layout.height, event.height);
      const hit = valid ? layout.hits.find((candidate) => candidate.row === event.y &&
        candidate.startCol >= 0 && candidate.endCol <= event.width &&
        event.x >= candidate.startCol && event.x < candidate.endCol) : undefined;
      if (event.type === "press") {
        pending = event.button === "left" && hit ? { x: event.x, y: event.y, width: event.width, generation, action: hit.action } : undefined;
        return note(pending ? "press recorded" : "press ignored");
      }
      if (event.type === "release") {
        if (!pending || !hit || pending.x !== event.x || pending.y !== event.y || pending.width !== event.width ||
          pending.action !== hit.action || (event.button !== "none" && event.button !== "left")) pending = undefined;
        return note(pending ? "matching release" : "release ignored");
      }
      if (event.type !== "click") { pending = undefined; return note("not a click"); }
      const matchingPress = pending && pending.x === event.x && pending.y === event.y &&
        pending.width === event.width && pending.generation === generation && pending.action === hit?.action;
      pending = undefined;
      if (!hit || (event.button !== "left" && !(event.button === "none" && matchingPress))) return note("invalid gesture or no hit");
      if (!canActivate(hit.action)) return note("action unavailable or focus changed");
      lastMouse = { type: event.type, button: event.button, x: event.x, y: event.y, width: event.width, reason: `activated ${hit.action}` };
      void activate(hit.action);
      return { handled: true, render: false };
    },
    describe,
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
  cycleReasoning(): void;
  captureCycleTrigger?(): SettingCycleTrigger | undefined;
  withCycleTrigger?<T>(trigger: SettingCycleTrigger, run: () => T): T;
  cancelSettings(reason: string): void;
  /** Read an already-discovered snapshot. Never emit a capability query from render. */
  getActions(): FooterActionsRequest["actions"];
  notify(message: string, type: "warning" | "error"): void;
  refresh(): void;
}
export interface FooterActionController {
  activate(action: string, origin?: "pointer" | "keyboard"): Promise<void>;
  available(action: string): boolean;
  describe(): { bound: boolean; current: boolean; mainFocus: boolean; overlay: boolean | null; promptDepth: number; blockedHolds: number; idle: boolean; opening: boolean; actions: string[] };
  /** Capture actual main editor/TUI identities. Returns an ownership-safe release. */
  wrapEditor(editor: FooterEditor, tui: FooterTui): () => void;
  dispose(): void;
}

type Binding = { editor: FooterEditor; tui: FooterTui; generation: number; release(): void };
const commands: Record<FooterActionId | "model.open" | "reasoning.cycle", string> = {
  "model.open": "/model", "reasoning.cycle": "/thinking", "workflow.cycle": "/mode",
  "workflow.open": "/mode", "flow.open": "/flow", "execution.status": "/plan-exec",
  "approvals.open": "/approvals", "effort.toggle": "/auto-effort", "context.open": "/context",
  "context.skills": "/context", "cache.status": "/cache-guard", "mcp.open": "/mcp", "system1.open": "/system1", "headsup.open": "/sidebar",
};
const isAction = (action: string): action is keyof typeof commands => Object.hasOwn(commands, action);
// Status-only inspections may run during a turn; pickers and all mutations wait for idle.
const needsIdle = (action: string) => !["cache.status", "execution.status", "reasoning.cycle", "effort.toggle", "headsup.open"].includes(action);

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
      if (action === "reasoning.cycle") return options.cycleReasoning;
      return options.isLinked() ? provider("flow.open") : native;
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
    // A busy click is recognized so activate() can explain why its picker cannot open.
    return current(owner) && !opening && ready(owner) && !!resolve(action, owner);
  };
  const describe = () => {
    const owner = binding;
    return { bound: !!owner, current: current(owner), mainFocus: !!owner && owner.tui.getFocusedComponent?.() === owner.editor,
      overlay: owner && typeof owner.tui.hasOverlay === "function" ? owner.tui.hasOverlay() : null,
      promptDepth: options.getPromptDepth(), blockedHolds: options.getBlocked(), idle: options.isIdle(),
      opening: !!opening, actions: owner && current(owner) ? Object.keys(commands).filter((action) => !!resolve(action, owner)) : [] };
  };
  const activate = async (action: string, origin: "pointer" | "keyboard" = "pointer"): Promise<void> => {
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
      if (["model.open", "workflow.open", "flow.open", "approvals.open"].includes(action)) options.cancelSettings("opened settings picker");
      const trigger: SettingCycleTrigger = origin === "keyboard"
        ? options.captureCycleTrigger?.() ?? { kind: "programmatic" }
        : { kind: "pointer" };
      const result = options.withCycleTrigger ? options.withCycleTrigger(trigger, run) : run();
      if (result) await result;
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
      if (routing || !current(owner) || typeof handlers?.get !== "function" || typeof handlers?.set !== "function") {
        original.call(this, data);
        return;
      }
      const model = handlers.get("app.model.select");
      const thinking = handlers.get("app.thinking.cycle");
      const select = () => {
        if (!ready(owner)) return;
        options.cancelSettings("opened settings picker");
        if (options.isLinked()) void activate("model.open");
        else model?.();
      };
      const cycle = () => { void activate("reasoning.cycle", "keyboard"); };
      routing = true;
      if (model) handlers.set("app.model.select", select);
      if (thinking) handlers.set("app.thinking.cycle", cycle);
      try {
        original.call(this, data);
      } finally {
        // Another owner may have replaced an entry while handling input.
        if (model && handlers.get("app.model.select") === select) handlers.set("app.model.select", model);
        if (thinking && handlers.get("app.thinking.cycle") === cycle) handlers.set("app.thinking.cycle", thinking);
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
  return { activate, available, describe, wrapEditor, dispose() { disposed = true; binding?.release(); } };
}
