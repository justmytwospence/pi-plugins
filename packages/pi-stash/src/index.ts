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
import {
  isEditorSnapshot,
  readEditorSnapshotApi,
  readEditorSurface,
  STASH_CHANNEL,
  TAKE_NEXT_CHANNEL,
  type StashController,
  type StashControllerOptions,
  type StashEditor,
  type StashRequest,
  type TakeNextRequest,
} from "./contract.ts";
import {
  isClearedAfterAction,
  isImportAction,
  isNavigationAction,
  isShellAction,
  isTemporaryAction,
  PromptStash,
  restoreDraft,
  toggleDraft,
  type DraftTarget,
  type StashedPrompt,
} from "./core.ts";
import { readStashState, serializeStash, STASH_ENTRY_TYPE, type PersistedStashState } from "./persistence.ts";

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
/** Process-only binding retained across factory reloads; never part of the session payload. */
const SESSION = Symbol.for("pi-plugins.pi-stash/session.v1");
type BoundStash = PromptStash & { [SESSION]?: string };
const identityOf = (ctx: ExtensionContext): string =>
  JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile() ?? null]);

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type TaggedFactory = EditorFactory & { [WRAPPER]?: { owner: string; previous: EditorFactory | undefined } };
type FocusedTui = TUI & { getFocusedComponent?(): unknown };

interface Session {
  ctx: ExtensionContext;
  identity: string;
  dirty: boolean;
  lastSaved?: PersistedStashState;
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

/** Put a stashed draft into another plugin's editor: snapshot restore when possible, text otherwise. */
function applyToEditor(editor: StashEditor, entry: StashedPrompt): void {
  const api = entry.snapshot ? readEditorSnapshotApi(editor) : undefined;
  if (api && entry.snapshot) {
    try {
      if (api.restore(entry.snapshot) && editor.getText() === entry.text) return;
    } catch {
      // Fall back to text.
    }
  }
  editor.setText(entry.text);
}

/** A stash of its own for another plugin's editor (the `STASH_CHANNEL` service). */
export function createStashController(options: StashControllerOptions): StashController {
  const store = new PromptStash();
  const target = (editor: StashEditor): DraftTarget => ({
    getText: () => editor.getText(),
    capture: (text) => capture(editor as unknown as EditorComponent, text),
    apply: (entry) => applyToEditor(editor, entry),
    clear: () => editor.setText(""),
    notify: (message, type) => options.notify(message, type),
    changed: () => options.changed?.(),
  });
  return {
    get stashed() {
      return store.hasPrompt;
    },
    handleKey(data) {
      if (!matchesKey(data, STASH_KEY_ID)) return false;
      const editor = options.editor();
      if (!editor) return false;
      toggleDraft(store, target(editor));
      return true;
    },
    submitted(text) {
      const editor = options.editor();
      if (editor && isTemporaryAction(text)) restoreDraft(store, target(editor), true);
    },
  };
}

function isStashRequest(data: unknown): data is StashRequest {
  return typeof data === "object" && data !== null && (data as StashRequest).version === 1;
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
  /** Set at a fork's session start; the next editor setText is Pi loading the forked editor. */
  let awaitingForkText = false;

  const updateStatus = (state: Session) => {
    state.ctx.ui.setStatus(STATUS_ID, stash?.hasPrompt ? state.ctx.ui.theme.fg("accent", STATUS_TEXT) : undefined);
  };

  /** Save only the final logical mutation (a swap must not write an intermediate clear). */
  const persist = (state: Session) => {
    if (session !== state || globals[LEASE] !== lease) return;
    const retry = state.dirty;
    state.dirty = true;
    try {
      // Old contexts can outlive session replacement. Never save through a changed manager.
      if (identityOf(state.ctx) !== state.identity) throw new Error("stale session");
      const snapshot = serializeStash(stash?.entry);
      const encoded = JSON.stringify(snapshot);
      if (retry || encoded !== JSON.stringify(state.lastSaved)) {
        pi.appendEntry(STASH_ENTRY_TYPE, snapshot);
        // Keep no references that appendEntry or getEntries could subsequently mutate.
        state.lastSaved = JSON.parse(encoded) as PersistedStashState;
      }
      state.dirty = false;
    } catch {
      try {
        state.ctx.ui.notify(
          "pi-stash: could not save stash state; changes are in memory only until a save succeeds.",
          "warning",
        );
      } catch {
        // A stale outgoing UI must not make shutdown throw either.
      }
    }
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

  /** Pi's main editor as a stash target. */
  const mainTarget = (state: Session, editor?: EditorComponent): DraftTarget => ({
    getText: () => state.ctx.ui.getEditorText(),
    capture: (text) => capture(editor, text),
    apply: (entry) => apply(state, entry),
    clear: () => state.ctx.ui.setEditorText(""),
    notify: (message, type) => state.ctx.ui.notify(message, type),
    changed: () => {
      persist(state);
      updateStatus(state);
    },
  });

  const restore = (state: Session, automatic: boolean): boolean =>
    !!stash && restoreDraft(stash, mainTarget(state), automatic);

  /** The next-prompt suggestion on screen, withdrawn from pi-next-prompt (optional sibling). */
  const takeSuggestion = (): string | undefined => {
    const request: TakeNextRequest = {};
    try {
      pi.events?.emit?.(TAKE_NEXT_CHANNEL, request);
    } catch {
      return undefined;
    }
    return typeof request.text === "string" && request.text.trim().length > 0 ? request.text : undefined;
  };

  const toggle = (state: Session, editor: EditorComponent) => {
    if (!stash) return;
    // Nothing to stash or restore: a suggestion shown as ghost text counts as the draft.
    if (!stash.hasPrompt && state.ctx.ui.getEditorText().length === 0) {
      const suggestion = takeSuggestion();
      if (suggestion !== undefined) {
        stash.stash({ text: suggestion });
        persist(state);
        updateStatus(state);
        state.ctx.ui.notify("Suggestion stashed", "info");
        return;
      }
    }
    toggleDraft(stash, mainTarget(state, editor));
  };

  /** Held draft: restore into an empty editor, otherwise keep holding until the next submit. */
  const settle = (state: Session, entry: StashedPrompt | undefined) => {
    if (session !== state || !stash?.held || stash.entry !== entry) return;
    restore(state, true);
  };

  /**
   * Run `then` once the main editor has focus again (and, with `idle`, the session is idle),
   * as long as the stash still holds `entry`. While a selector, dialog or extension UI covers
   * the editor, a restored draft would block what the UI puts there (/tree loads the selected
   * message only into an empty editor) or be overwritten when the UI writes back the text it
   * saved on opening (ctx.ui.custom).
   */
  const whenEditorBack = (
    state: Session,
    editor: EditorComponent,
    tui: TUI,
    entry: StashedPrompt | undefined,
    options: { idle: boolean; delay: number },
    then: () => void,
  ) => {
    const mine = generation;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      timers.delete(timer);
      if (mine !== generation || session !== state || stash?.entry !== entry) return;
      let idle = true;
      try {
        if (options.idle && typeof state.ctx.isIdle === "function") idle = state.ctx.isIdle();
      } catch {
        return;
      }
      if (idle && (tui as FocusedTui).getFocusedComponent?.() === editor) then();
      else schedule(50);
    };
    const schedule = (delay: number) => {
      timer = setTimeout(check, delay);
      timers.add(timer);
    };
    schedule(options.delay);
  };

  const attach = (editor: EditorComponent, tui: TUI) => {
    if (wrappedEditors.has(editor)) return;
    wrappedEditors.add(editor);
    // After a fork or clone, Pi sets the new session's editor text (the selected message, or
    // empty) once the replacement has finished; that is when a held draft can settle.
    const setText = editor.setText.bind(editor);
    editor.setText = (text: string): void => {
      setText(text);
      const state = session;
      if (!awaitingForkText || !state || state.editor !== editor) return;
      awaitingForkText = false;
      const entry = stash?.entry;
      const mine = generation;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (mine === generation) settle(state, entry);
      }, 0);
      timers.add(timer);
    };
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
        const navigation = main && isNavigationAction(text);
        // A held draft (left by a navigation that loaded a message) returns after any submit.
        const held = main && !navigation && !!stash?.held && text.trim().length > 0;
        const command = main && !navigation && (held || isTemporaryAction(text));
        // Pi clears the editor after these finish; restoring earlier would lose the draft.
        const late = command && isClearedAfterAction(text);
        if (navigation) stash!.held = true;
        if (late && isImportAction(text)) stash!.awaitText = true;
        const revision = changes;
        let failure: unknown;
        let failed = false;
        try {
          const result = submit(text);
          // Only a real submit schedules restoration; accepting autocomplete does not.
          if (state && navigation && text.trim() === "/tree") {
            whenEditorBack(state, editor, tui, entry, { idle: true, delay: 50 }, () => settle(state, entry));
          } else if (state && command && !late) {
            whenEditorBack(state, editor, tui, entry, { idle: false, delay: 0 }, () => restore(state, true));
          }
          await result;
        } catch (error) {
          failure = error;
          failed = true;
        }
        if (main && state && session === state && stash?.entry === entry) {
          if (late && stash) stash.awaitText = false; // no session replacement happened
          if (command) {
            whenEditorBack(state, editor, tui, entry, { idle: false, delay: 0 }, () => restore(state, true));
          } else if (isShellAction(text)) {
            const current = state.ctx.ui.getEditorText();
            // An unchanged command left by Pi can be removed. Newly typed text is a draft,
            // even if it happens to equal the command, so text equality alone is not enough.
            if (current.length === 0 || (changes === revision && current === text)) {
              if (current.length > 0) state.ctx.ui.setEditorText("");
              restore(state, true);
            }
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

  const stop = (retry = true) => {
    if (retry && session?.dirty) persist(session);
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
    awaitingForkText = false;
    if (globals[LEASE] === lease) delete globals[LEASE];
  };

  pi.on("session_start", (event, ctx) => {
    const outgoing = globals[STASH_KEY] as BoundStash | undefined;
    const owned = outgoing && (outgoing as unknown as Record<symbol, unknown>)[STASH_OWNER] === OWNER;
    const outgoingIdentity = owned ? outgoing[SESSION] : undefined;
    const outgoingEntry = owned ? outgoing.entry : undefined;
    const outgoingState = session;
    const identity = identityOf(ctx);
    // A replacement can be prepared before shutdown. appendEntry now targets the destination,
    // so only normal outgoing shutdown (or a same-session restart) may retry an outgoing write.
    stop(!session || session.identity === identity);
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
    const state: Session = { ctx, identity, dirty: false };
    session = state;
    if (!install(ctx)) {
      session = undefined;
      return;
    }
    globals[LEASE] = lease;
    Object.defineProperty(stash, SESSION, { value: identity, writable: true, configurable: true, enumerable: false });
    const saved = readStashState(ctx.sessionManager.getEntries());
    if (saved.status === "valid") state.lastSaved = serializeStash(saved.entry);

    if (owned && outgoingIdentity === identity) {
      // A reload retains richer in-process snapshots/history, but never fills the editor.
      state.dirty = outgoingState?.dirty === true
        || (saved.status === "valid" && JSON.stringify(serializeStash(stash.entry)) !== JSON.stringify(state.lastSaved))
        || (saved.status === "missing" && stash.hasPrompt);
      stash.awaitText = false;
    } else if (outgoingIdentity !== undefined && outgoingIdentity !== identity
      && (event as { reason?: string } | undefined)?.reason === "fork") {
      // Copy the live parent, even when empty: copied ancestry may hold a consumed stash.
      // Durable fields make a detached child; opaque history stays in its original session.
      const copied = serializeStash(outgoingEntry);
      stash.take();
      if (copied.prompt) stash.stash(copied.prompt);
      state.lastSaved = undefined; // A child always records its initial live state once.
      persist(state);
      if (stash.hasPrompt) {
        stash.held = true;
        awaitingForkText = true; // Protect Pi's selected-message prefill after session_start.
      }
    } else if (saved.status === "missing" && owned && outgoingIdentity === undefined && outgoingEntry) {
      // One-time migration of an unbound suite stash, never an unknown upstream object.
      persist(state);
    } else {
      stash.take();
      if (saved.status === "valid" && saved.entry) stash.stash(saved.entry);
      if (saved.status === "invalid") {
        ctx.ui.notify("pi-stash: saved stash state is unsupported or invalid; no prompt was restored.", "warning");
      }
    }
    updateStatus(state);
  });

  pi.on("session_shutdown", () => stop());

  // Other plugins' editors (Sidebar's composer) get a stash of their own while this copy is active.
  pi.events?.on?.(STASH_CHANNEL, (data: unknown) => {
    if (!session || !isStashRequest(data) || data.create) return;
    data.create = createStashController;
    data.provider = "pi-stash";
  });

  pi.on("model_select", () => {
    if (session) restore(session, true);
  });

  pi.on("thinking_level_select", () => {
    if (session) restore(session, true);
  });
}
