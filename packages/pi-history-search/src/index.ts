import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease } from "@earendil-works/pi-tui";
import { PrefixHistory, sessionPrompts } from "./history.ts";
import { HistoryPicker } from "./picker.ts";

const SURFACE = Symbol.for("pi-plugins.editor-surface.v1");
const MODE = Symbol.for("pi-plugins.editor-mode.v1");
type Editor = {
  getText(): string;
  setText(text: string): void;
  getExpandedText?(): string;
  onChange?: (text: string) => void;
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
    let preClose: { text: string } | undefined;
    let restoreHardwareCursor = () => {};
    // Ordinary custom dialogs snapshot getText(), then restore with setText(),
    // clearing native paste storage. Keep this editor marker-free throughout
    // our interaction, not just at opening: external pastes must be expanded
    // before a concurrent dialog can snapshot them. This instance-local change
    // listener is synchronous and forwards the existing listener exactly once.
    // Close deactivates even copies nested inside a replacement editor's hook,
    // and removes directly owned listeners (also on cancellation and failures).
    const onChange = editor.onChange;
    const guardedEditors = new Set([editor]);
    let expanding = false;
    let guarding = true;
    function expandDraft(this: Editor | undefined, text: string) {
      // Native replacement copies onChange, and Vim's lazy hook invokes that
      // copy unbound. In that case the UI API still addresses the live editor;
      // never fall back to reading/writing the obsolete opening editor.
      const receiver = isEditor(this) ? this : undefined;
      if (!guarding) { onChange?.call(receiver ?? editor, text); return; }
      if (receiver) guardedEditors.add(receiver);
      if (expanding) return;
      const expanded = receiver ? receiver.getExpandedText?.() ?? text : ctx.ui.getEditorText();
      const raw = receiver ? receiver.getText() : text;
      if (raw !== expanded) {
        expanding = true;
        try {
          if (receiver) receiver.setText(expanded);
          else ctx.ui.setEditorText(expanded);
        } finally { expanding = false; }
      }
      onChange?.call(receiver ?? editor, expanded);
    }
    const releaseDraft = () => {
      guarding = false;
      for (const guarded of guardedEditors) {
        if (guarded.onChange === expandDraft) guarded.onChange = onChange;
      }
      guardedEditors.clear();
    };
    try {
      editor.onChange = expandDraft;
      if (editor.getText() !== draft) ctx.ui.setEditorText(draft);
      const selected = await ctx.ui.custom<string | undefined>((ui, theme, keys, done) => {
        // The picker marker is a clipping anchor, not the filter's caret.
        // Own the TUI setting here so close, errors and lifecycle cancellation
        // restore it even when the component never gets another render.
        const showHardwareCursor = ui.getShowHardwareCursor();
        let restored = false;
        restoreHardwareCursor = () => {
          if (restored) return;
          ui.setShowHardwareCursor(showHardwareCursor);
          restored = true;
        };
        ui.setShowHardwareCursor(false);
        const close = (value: string | undefined) => {
          restoreHardwareCursor();
          if (preClose) return;
          // Native done synchronously restores its opening snapshot into the
          // *current* editor, which may have been replaced while we were open.
          // Repair that restoration in the same stack, before subsequent input
          // or another custom UI can observe/save it. Never repair after await:
          // that would overwrite an edit made immediately after closing.
          preClose = { text: ctx.ui.getEditorText() };
          try {
            done(value);
            if (ctx.ui.getEditorText() !== preClose.text) ctx.ui.setEditorText(preClose.text);
          } finally {
            releaseDraft();
          }
        };
        pending.close = () => close(undefined);
        const picker = new HistoryPicker(snapshot, draft.replace(/\s+/g, " "), theme, keys, () => ui.requestRender(), close,
          () => ui.terminal.rows);
        return picker;
      });
      if (selected !== undefined && preClose?.text === draft && generation === currentGeneration
        && ctx.sessionManager.getSessionId() === session && ctx.sessionManager.getLeafId() === leaf
        && focusedEditor() === editor && ctx.ui.getEditorText() === draft) {
        ctx.ui.setEditorText(selected);
        tui?.requestRender();
      }
    } catch (error) {
      ctx.ui.notify(`history-search: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      restoreHardwareCursor();
      releaseDraft();
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
