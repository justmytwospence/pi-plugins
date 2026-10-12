/**
 * pi-vim: Vim modal editing for Pi's prompt, and an editor factory other
 * suite components request over `pi.events` for their embedded editors.
 *
 * The engine under `engine/` is pi-vim 0.14.2 (MIT, lajarre). This entry
 * point is the upstream `session_start` wiring (settings, theme colorizers,
 * cursor shape, mode-change hook, EX command bridge) extended with the
 * `pi-plugins.editor-factory.v1` provider and a once-per-process diagnostic
 * when the standalone pi-vim package is loaded next to this one.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  EDITOR_FACTORY_CHANNEL,
  EDITOR_SURFACE,
  type EditorFactoryOptions,
  type EditorFactoryRequest,
  type SuiteEditor,
} from "./contract.js";
import { EmbeddedEditor } from "./embedded-editor.js";
import { EX_BUILTIN_COMMAND_NAMES } from "./engine/modal-editor.js";
import { cancelModeChangeCommands } from "./engine/mode-change-command.js";
import { MainEditor } from "./main-editor.js";
import { resolveSessionConfig, type SessionConfig } from "./session.js";

export {
  ModalEditor,
  setModeChangeCommandRunnerForTests,
} from "./engine/modal-editor.js";
export { EmbeddedEditor } from "./embedded-editor.js";
export { MainEditor } from "./main-editor.js";
export * from "./contract.js";

export const PROVIDER_NAME = "pi-vim";
export const MODE_CHANGE_EVENT = "pi-vim:mode-change";
export const DUPLICATE_WARNING =
  "pi-vim: another pi-vim editor is installed in this session (the standalone pi-vim package?). Enable only one copy.";

type Session = {
  config: SessionConfig;
  ctx: ExtensionContext;
  embedded: Set<EmbeddedEditor>;
  main: Set<MainEditor>;
};

function isFactoryRequest(data: unknown): data is EditorFactoryRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as EditorFactoryRequest).version === 1
  );
}

function isFactoryOptions(data: unknown): data is EditorFactoryOptions {
  if (typeof data !== "object" || data === null) return false;
  const options = data as Partial<EditorFactoryOptions>;
  return (
    (options.surface === "main" || options.surface === "embedded") &&
    typeof options.tui === "object" &&
    options.tui !== null &&
    typeof options.theme === "object" &&
    options.theme !== null &&
    typeof options.keybindings === "object" &&
    options.keybindings !== null
  );
}

/** An upstream pi-vim `pi-vim:mode-change` payload has no `surface`. */
function isForeignModeChange(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const event = data as Record<string, unknown>;
  return (
    typeof event.mode === "string" &&
    typeof event.previousMode === "string" &&
    !("surface" in event)
  );
}

/**
 * Probe an already-installed editor factory with a side-effect-free TUI stub
 * (no terminal writer, so no cursor-shape output) and recognize the upstream
 * pi-vim editor by its public surface. Our own editors carry the surface
 * marker and are never reported, even when another extension wraps them.
 */
function createsForeignModalEditor(factory: unknown): boolean {
  if (typeof factory !== "function") return false;
  const identity = (s: string) => s;
  const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
  const theme = {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
  const keybindings = { matches: () => false };
  let candidate: Record<PropertyKey, unknown> | undefined;
  try {
    const editor: unknown = (factory as (...args: unknown[]) => unknown)(
      tui,
      theme,
      keybindings,
    );
    if (typeof editor !== "object" || editor === null) return false;
    candidate = editor as Record<PropertyKey, unknown>;
    return (
      !(EDITOR_SURFACE in candidate) &&
      typeof candidate.getMode === "function" &&
      typeof candidate.setQuitFn === "function"
    );
  } catch {
    return false;
  } finally {
    try {
      if (typeof candidate?.dispose === "function") candidate.dispose();
    } catch {
      // A foreign provider's cleanup cannot block installing the editor.
    }
  }
}

export default function piVim(pi: ExtensionAPI) {
  let session: Session | null = null;
  let duplicateWarned = false;

  const warnDuplicate = (ctx: ExtensionContext | undefined) => {
    if (duplicateWarned || !ctx?.hasUI) return;
    duplicateWarned = true;
    ctx.ui.notify(DUPLICATE_WARNING, "warning");
  };

  const disposeEditors = (event?: { reason?: string }) => {
    if (!session) return;
    for (const editor of [...session.embedded]) editor.dispose();
    session.embedded.clear();
    for (const editor of session.main) editor.dispose(event);
    session.main.clear();
  };

  const createEditor = (
    current: Session,
    options: EditorFactoryOptions,
  ): SuiteEditor => {
    if (session !== current || current.ctx.mode !== "tui") {
      throw new Error("pi-vim editor factory: session is no longer active");
    }
    if (!isFactoryOptions(options)) {
      throw new TypeError(
        "pi-vim editor factory: options need surface, tui, theme and keybindings",
      );
    }
    if (options.surface === "main") {
      const { ctx, config } = current;
      const editor = new MainEditor(options.tui, options.theme, options.keybindings, config.editorOptions);
      current.main.add(editor);
      editor.setClipboardMirrorPolicy(config.clipboardMirrorPolicy);
      editor.setQuitFn(() => ctx.shutdown());
      editor.setNotifyFn((message) => ctx.ui.notify(message, "warning"));
      editor.setExCommandSettings(config.exCommand);
      editor.setCommandNamesFn(() => new Set([
        ...EX_BUILTIN_COMMAND_NAMES,
        ...pi.getCommands().map((command) => command.name),
      ]));
      editor.setPaddingX(options.paddingX ?? 0);
      if (options.initialText !== undefined) editor.setText(options.initialText);
      if (options.initialMode === "normal") editor.handleInput("\x1b");
      editor.setModeChangeFn(config.modeChangeFor("main"));
      return editor;
    }
    const editor = new EmbeddedEditor(
      options,
      current.config.editorOptions,
      () => current.embedded.delete(editor),
    );
    editor.setClipboardMirrorPolicy(current.config.clipboardMirrorPolicy);
    editor.setModeChangeFn(current.config.modeChangeFor("embedded"));
    current.embedded.add(editor);
    return editor;
  };

  // Answered only while a session is active, so a dialog opening before the
  // first session_start (or after shutdown) falls back to Pi's native editor.
  pi.events.on(EDITOR_FACTORY_CHANNEL, (data) => {
    const current = session;
    if (!current || current.ctx.mode !== "tui" || !isFactoryRequest(data) || data.factory) return;
    data.factory = (options) => createEditor(current, options);
    data.provider = PROVIDER_NAME;
  });

  pi.events.on(MODE_CHANGE_EVENT, (data) => {
    if (isForeignModeChange(data)) warnDuplicate(session?.ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    disposeEditors();
    session = null;
    // Discovery also detects a second suite owner without creating a probe
    // editor. Leave the first owner's factory and main editor in place.
    if (ctx.mode === "tui") {
      const request: EditorFactoryRequest = { version: 1 };
      pi.events.emit(EDITOR_FACTORY_CHANNEL, request);
      if (request.factory && request.provider === PROVIDER_NAME) {
        warnDuplicate(ctx);
        return;
      }
    }
    const config = resolveSessionConfig(ctx.cwd, ctx.ui.theme, (event) =>
      pi.events.emit(MODE_CHANGE_EVENT, event),
    );
    if (ctx.hasUI) {
      for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
    }
    session = { config, ctx, embedded: new Set(), main: new Set() };
    // RPC supports notifications but cannot install terminal components.
    if (ctx.mode !== "tui") return;
    if (createsForeignModalEditor(ctx.ui.getEditorComponent?.())) {
      warnDuplicate(ctx);
    }
    const current = session;
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      createEditor(current, { surface: "main", tui, theme, keybindings }),
    );
  });

  pi.on("session_shutdown", (event) => {
    cancelModeChangeCommands();
    disposeEditors(event);
    session = null;
  });
}
