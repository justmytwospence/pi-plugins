import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, visibleWidth } from "@earendil-works/pi-tui";
import { PrefixHistory, sessionPrompts } from "./history.ts";
import { HistoryPicker } from "./picker.ts";

const SURFACE = Symbol.for("pi-plugins.editor-surface.v1");
const MODE = Symbol.for("pi-plugins.editor-mode.v1");
type Editor = {
  getText(): string;
  setText(text: string): void;
  isShowingAutocomplete?(): boolean;
  [SURFACE]?: unknown;
  [MODE]?: () => { state: string; autocomplete?: boolean };
};
type Tui = { getFocusedComponent(): unknown; requestRender(): void };

function isEditor(value: unknown): value is Editor {
  return typeof value === "object" && value !== null
    && typeof (value as Editor).getText === "function"
    && typeof (value as Editor).setText === "function";
}

export default function historySearch(pi: ExtensionAPI) {
  const prefix = new PrefixHistory();
  let tui: Tui | undefined;
  let main: unknown;
  let lastFocus: unknown;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let browsing = false;
  let nativeRun = false;
  let lastText: string | undefined;
  let prompts: string[] = [];
  let opening: { close?: () => void } | undefined;

  function reset() {
    prefix.reset();
    browsing = nativeRun = false;
    lastText = undefined;
    prompts = [];
  }

  function focusedEditor(): Editor | undefined {
    const focused = tui?.getFocusedComponent();
    if (!isEditor(focused) || focused[SURFACE] === "embedded") return;
    if (focused !== main && focused[SURFACE] !== "main") return;
    return focused;
  }

  function eligible(editor: Editor, search = false): boolean {
    if (editor.isShowingAutocomplete?.()) return false;
    const mode = editor[MODE]?.();
    return !mode || (!mode.autocomplete && (mode.state === "insert" || (!search && mode.state === "normal")));
  }

  function invalidate() {
    generation++;
    reset();
    const previous = opening;
    opening = undefined;
    previous?.close?.();
  }

  async function search(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Prompt history search requires the interactive terminal UI.", "warning");
      return;
    }
    if (opening) return;
    const editor = focusedEditor();
    if (!editor) return;
    const snapshot = sessionPrompts(ctx.sessionManager.getBranch());
    if (!snapshot.length) {
      ctx.ui.notify("No prompts in this session yet.", "info");
      return;
    }
    reset();
    const currentGeneration = generation;
    const session = ctx.sessionManager.getSessionId();
    const leaf = ctx.sessionManager.getLeafId();
    const draft = ctx.ui.getEditorText();
    const pending: { close?: () => void } = {};
    opening = pending;
    try {
      const selected = await ctx.ui.custom<string | undefined>((ui, theme, keys, done) => {
        pending.close = () => done(undefined);
        const picker = new HistoryPicker(snapshot, draft.replace(/\s+/g, " "), theme, keys, () => ui.requestRender(), done);
        const render = picker.render.bind(picker);
        // OverlayOptions has no height: cover the viewport ourselves so a tall
        // footer cannot leave the native editor frame exposed to remote clients.
        picker.render = (width) => {
          const height = Math.max(0, ui.terminal.rows);
          const lines = render(width, height);
          while (lines.length < height) lines.push("");
          return lines.map((line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))));
        };
        return picker;
      }, { overlay: true, overlayOptions: { width: "100%" } });
      if (selected !== undefined && generation === currentGeneration
        && ctx.sessionManager.getSessionId() === session && ctx.sessionManager.getLeafId() === leaf
        && focusedEditor() === editor && ctx.ui.getEditorText() === draft) {
        ctx.ui.setEditorText(selected);
        tui?.requestRender();
      }
    } catch (error) {
      ctx.ui.notify(`history-search: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (opening === pending) opening = undefined;
    }
  }

  pi.registerShortcut("ctrl+r", {
    description: "Search session prompt history",
    handler: async (ctx) => {
      const editor = focusedEditor();
      if (ctx.mode === "tui" && editor && eligible(editor, true)) await search(ctx);
    },
  });
  pi.registerCommand("history-search", {
    description: "Search prompts from this session",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /history-search", "warning");
        return;
      }
      await search(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    invalidate();
    tui = undefined;
    main = lastFocus = undefined;
    if (ctx.mode !== "tui") return;
    const grabTui = (): Tui | undefined => {
      let captured: Tui | undefined;
      try {
        ctx.ui.setWidget("history-search-probe", (ui) => {
          captured = ui as unknown as Tui;
          return { render: () => [], invalidate() {} };
        });
      } finally {
        ctx.ui.setWidget("history-search-probe", undefined);
      }
      return captured;
    };
    tui = grabTui();
    if (!tui || typeof tui.getFocusedComponent !== "function") {
      tui = undefined;
      ctx.ui.notify("history-search: focus inspection unavailable; prefix navigation disabled", "warning");
      return;
    }
    main = lastFocus = tui.getFocusedComponent();
    let listening = true;
    const stop = ctx.ui.onTerminalInput((data) => {
      if (!listening || isKeyRelease(data)) return;
      const focus = tui?.getFocusedComponent();
      if (focus !== lastFocus) reset();
      lastFocus = focus;
      const editor = focusedEditor();
      if (!editor || !eligible(editor)) { reset(); return; }
      const keys = getKeybindings();
      const direction = keys.matches(data, "tui.editor.historyPrevious") ? -1
        : keys.matches(data, "tui.editor.historyNext") ? 1 : undefined;
      if (direction === undefined) { reset(); return; }
      const text = ctx.ui.getEditorText();
      // Native empty-draft browsing changes the buffer itself; keep passing it through.
      if (browsing && !nativeRun && text !== lastText) reset();
      if (!browsing) {
        nativeRun = text.length === 0;
        prompts = !nativeRun && direction === -1 ? sessionPrompts(ctx.sessionManager.getBranch()) : [];
        browsing = nativeRun || direction === -1;
      }
      const result = prefix.navigate(direction, text, prompts);
      if (!result.consume) return;
      if (result.text !== undefined) {
        ctx.ui.setEditorText(result.text);
        tui?.requestRender();
      }
      lastText = result.text ?? text;
      return { consume: true };
    });
    unsubscribe = () => {
      if (!listening) return;
      listening = false;
      stop();
    };
  });
  pi.on("input", () => { invalidate(); });
  pi.on("session_tree", () => { invalidate(); });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    invalidate();
    tui = undefined;
    main = lastFocus = undefined;
  });
}
