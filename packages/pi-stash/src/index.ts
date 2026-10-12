// Claude Code-style prompt stashing for Pi's main editor: Ctrl+S stashes the draft and
// clears the editor, a slash or shell command runs, and the draft comes back on its own.
//
// Origin: @saadjs/pi-stash 0.0.3 (MIT, Saad Bash). Suite changes:
//   - Only Pi's main editor is stashed. Editors marked embedded by the suite editor
//     contract, and editors that are not the focused main editor, pass Ctrl+S through.
//   - Editors implementing the suite snapshot protocol (pi-vim) stash cursor and mode with
//     the text; every other editor falls back to plain text.
//   - Automatic restoration never overwrites text typed since the stash.
//   - The editor wrapper is tagged and released on shutdown, and the handlers read the
//     live session context instead of the one captured at install time.
//   - A second prompt-stash owner in the process is reported instead of stacked.
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { isEditorSnapshot, readEditorSnapshotApi, readEditorSurface } from "./contract.ts";
import { isShellAction, isTemporaryAction, PromptStash, type StashedPrompt } from "./core.ts";

/** Footer status key and text; pi-status-footer absorbs exactly this pair into its stash row. */
export const STATUS_ID = "prompt-stash";
export const STATUS_TEXT = "prompt stashed";
export const STASH_KEY_ID = "ctrl+s";
/** Process-global stash, under the upstream key so pi-status-footer's preview keeps reading it. */
export const STASH_KEY = Symbol.for("@saadjs/pi-stash/prompt");
/** Non-enumerable tag on a stash created by this component (any instance of it). */
export const STASH_OWNER = Symbol.for("pi-plugins.pi-stash/owner.v1");
/** Tag on this component's editor factory wrapper, naming what it wraps. */
export const WRAPPER = Symbol.for("pi-plugins.pi-stash/wrapper.v1");
export const OWNER = "pi-plugins/pi-stash";
/** Active-instance lease, separate from the draft that survives session replacement. */
export const LEASE = Symbol.for("pi-plugins.pi-stash/active.v1");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type TaggedFactory = EditorFactory & { [WRAPPER]?: { owner: string; previous: EditorFactory | undefined } };
type FocusedTui = TUI & { getFocusedComponent?(): unknown };

interface Session {
  ctx: ExtensionContext;
  /** The main editor instance that last handled a key for us; used for snapshot restores. */
  editor?: EditorComponent;
  factory?: EditorFactory;
}

type StashAdoption = { status: "ready"; stash: PromptStash } | { status: "unknown" };

/**
 * Adopt only a suite-created stash. The legacy factory publishes an untagged stash
 * even before session_start and retains it after shutdown. Its presence proves
 * neither that legacy handlers are active nor that they have retired; ExtensionAPI
 * exposes no complete loaded-extension inventory. Leave unknown state untouched
 * rather than risk sharing incompatible stash APIs and conflicting Ctrl+S handlers.
 * The separate LEASE checks whether another cooperating suite instance is active.
 */
export function adoptStash(): StashAdoption {
  const globals = globalThis as Record<symbol, unknown>;
  const existing = globals[STASH_KEY];
  if (existing !== null && typeof existing === "object") {
    const owned = (existing as Record<symbol, unknown>)[STASH_OWNER] === OWNER;
    return owned ? { status: "ready", stash: existing as PromptStash } : { status: "unknown" };
  }
  const created = new PromptStash();
  Object.defineProperty(created, STASH_OWNER, { value: OWNER, enumerable: false });
  globals[STASH_KEY] = created;
  return { status: "ready", stash: created };
}

/**
 * Whether `editor` is Pi's main editor right now: not marked embedded by the suite contract,
 * the focused component, and showing the text Pi reports for the main editor.
 */
export function isMainEditor(editor: EditorComponent, tui: TUI, ctx: ExtensionContext): boolean {
  if (readEditorSurface(editor) === "embedded") return false;
  const focused = (tui as FocusedTui).getFocusedComponent?.();
  if (focused !== editor) return false;
  return editor.getText() === ctx.ui.getEditorText();
}

/** The text plus, when the editor offers it and agrees on the text, its cursor/mode snapshot. */
export function capture(editor: EditorComponent | undefined, text: string): StashedPrompt {
  const api = editor ? readEditorSnapshotApi(editor) : undefined;
  if (!api) return { text };
  try {
    const snapshot = api.capture();
    return isEditorSnapshot(snapshot) && snapshot.text === text ? { text, snapshot } : { text };
  } catch {
    return { text };
  }
}

export default function promptStash(pi: ExtensionAPI): void {
  let stash: PromptStash | undefined;
  let session: Session | undefined;
  let generation = 0;
  let release: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const ownFactories = new WeakSet<object>();
  const wrappedEditors = new WeakSet<object>();
  const globals = globalThis as Record<symbol, unknown>;
  const lease = {};

  const updateStatus = (state: Session) => {
    state.ctx.ui.setStatus(STATUS_ID, stash?.hasPrompt ? state.ctx.ui.theme.fg("accent", STATUS_TEXT) : undefined);
  };

  /** Put a stashed prompt into the main editor: snapshot restore when possible, text otherwise. */
  const apply = (state: Session, entry: StashedPrompt) => {
    const api = state.editor && entry.snapshot && state.ctx.ui.getEditorComponent() === state.factory
      && state.editor.getText() === state.ctx.ui.getEditorText()
      ? readEditorSnapshotApi(state.editor) : undefined;
    if (api && entry.snapshot) {
      try {
        if (api.restore(entry.snapshot) && state.ctx.ui.getEditorText() === entry.text) return;
      } catch {
        // Fall back to text.
      }
    }
    state.ctx.ui.setEditorText(entry.text);
  };

  /** Automatic restoration only fills an empty editor; it never overwrites a newer draft. */
  const restore = (state: Session, automatic: boolean): boolean => {
    const entry = stash?.entry;
    if (!entry || !stash) return false;
    if (automatic && state.ctx.ui.getEditorText().length > 0) return false;
    stash.take();
    apply(state, entry);
    updateStatus(state);
    state.ctx.ui.notify("Restored stashed prompt", "info");
    return true;
  };

  const toggle = (state: Session, editor: EditorComponent) => {
    if (!stash) return;
    const current = state.ctx.ui.getEditorText();
    if (!stash.hasPrompt) {
      if (current.length === 0) {
        state.ctx.ui.notify("Nothing to stash", "warning");
        return;
      }
      stash.stash(capture(editor, current));
      state.ctx.ui.setEditorText("");
      updateStatus(state);
      state.ctx.ui.notify("Prompt stashed", "info");
      return;
    }
    if (current.length === 0) {
      restore(state, false);
      return;
    }
    const previous = stash.take()!;
    stash.stash(capture(editor, current));
    apply(state, previous);
    updateStatus(state);
    state.ctx.ui.notify("Swapped current and stashed prompts", "info");
  };

  /** Restore once the just-submitted slash command has started (Pi clears the editor synchronously). */
  const restoreAfterAction = (state: Session, entry: StashedPrompt | undefined) => {
    const mine = generation;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (mine === generation && session === state && stash?.entry === entry) restore(state, true);
    }, 0);
    timers.add(timer);
  };

  const attach = (editor: EditorComponent, tui: TUI) => {
    if (wrappedEditors.has(editor)) return;
    wrappedEditors.add(editor);
    const handleInput = editor.handleInput.bind(editor);
    editor.handleInput = (data: string): void => {
      const state = session;
      if (!state || !stash || !isMainEditor(editor, tui, state.ctx)) {
        handleInput(data);
        return;
      }
      state.editor = editor;
      if (matchesKey(data, STASH_KEY_ID)) {
        toggle(state, editor);
        return;
      }
      handleInput(data);
    };
    // Pi wires onSubmit right after the factory returns; wrap it one microtask later so the
    // awaited shell command's completion can restore the prompt.
    queueMicrotask(() => {
      if (!session) return;
      const submit = editor.onSubmit;
      if (!submit) return;
      let changes = 0;
      const onChange = editor.onChange;
      editor.onChange = (text) => {
        changes++;
        onChange?.(text);
      };
      editor.onSubmit = async (text: string): Promise<void> => {
        const state = session;
        const entry = stash?.entry;
        const main = !!state && !!entry && isMainEditor(editor, tui, state.ctx);
        const revision = changes;
        let failure: unknown;
        let failed = false;
        try {
          const result = submit(text);
          // Only a real submit schedules restoration; accepting autocomplete does not.
          if (main && state && isTemporaryAction(text)) restoreAfterAction(state, entry);
          await result;
        } catch (error) {
          failure = error;
          failed = true;
        }
        if (main && state && session === state && stash?.entry === entry
          && (isShellAction(text) || isTemporaryAction(text))) {
          const current = state.ctx.ui.getEditorText();
          // An unchanged command left by Pi can be removed. Newly typed text is a draft,
          // even if it happens to equal the command, so text equality alone is not enough.
          if (current.length === 0 || (isShellAction(text) && changes === revision && current === text)) {
            if (current.length > 0) state.ctx.ui.setEditorText("");
            restore(state, true);
          }
        }
        if (failed) throw failure;
      };
    });
  };

  /** Wrap the installed editor factory; false when another pi-stash instance already owns it. */
  const install = (ctx: ExtensionContext): boolean => {
    const current = ctx.ui.getEditorComponent() as TaggedFactory | undefined;
    let previous: TaggedFactory | undefined = current;
    while (previous && ownFactories.has(previous)) previous = previous[WRAPPER]?.previous;
    if (previous?.[WRAPPER]) {
      ctx.ui.notify(
        `pi-stash: another pi-stash instance (${previous[WRAPPER].owner}) already wraps the editor; this copy stays inactive. Enable only one copy.`,
        "warning",
      );
      return false;
    }
    const base = previous;
    let created: EditorComponent | undefined;
    const factory: TaggedFactory = (tui, theme, keybindings) => {
      const editor = base?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      attach(editor, tui);
      created = editor;
      return editor;
    };
    factory[WRAPPER] = { owner: OWNER, previous: base };
    ownFactories.add(factory);
    ctx.ui.setEditorComponent(factory);
    if (session) {
      session.editor = created;
      session.factory = factory;
    }
    release = () => {
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(base);
    };
    return true;
  };

  const stop = () => {
    generation++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    try {
      release?.();
    } catch {
      // The previous session's UI is already gone; nothing to release.
    }
    release = undefined;
    session = undefined;
    if (globals[LEASE] === lease) delete globals[LEASE];
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const adopted = adoptStash();
    if (adopted.status === "unknown") {
      ctx.ui.notify(
        "pi-stash: found an unrecognized process-global stash (possibly retained from @saadjs/pi-stash). Cannot tell whether the legacy copy is still active; this copy stays inactive and leaves the stash untouched to avoid conflicting Ctrl+S handlers. Save any current/stashed drafts, disable other stash copies, then fully quit and restart Pi (not /reload).",
        "warning",
      );
      return;
    }
    if (globals[LEASE] && globals[LEASE] !== lease) {
      ctx.ui.notify("pi-stash: another pi-stash instance is active; this copy stays inactive. Enable only one copy.", "warning");
      return;
    }
    stash = adopted.stash;
    const state: Session = { ctx };
    session = state;
    if (!install(ctx)) {
      session = undefined;
      return;
    }
    globals[LEASE] = lease;
    if (!restore(state, true)) updateStatus(state);
  });

  pi.on("session_shutdown", () => stop());

  pi.on("model_select", () => {
    if (session) restore(session, true);
  });

  pi.on("thinking_level_select", () => {
    if (session) restore(session, true);
  });
}
