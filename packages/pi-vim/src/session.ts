/**
 * Per-session configuration shared by the main and embedded editors: the
 * `piVim` settings resolved once at `session_start`, the colorizers built
 * from the session theme and the mode-change handler. Reading settings and
 * building colorizers is pi-vim's upstream `session_start` logic, kept in one
 * place so every editor the session creates behaves the same.
 */
import type { ClipboardMirrorPolicy } from "./engine/clipboard-policy.js";
import { resolveClipboardMirrorPolicy } from "./engine/clipboard-policy.js";
import type { ModalEditorOptions } from "./engine/modal-editor.js";
import { createModeChangeHandler } from "./engine/mode-change-command.js";
import {
  buildModeColorizers,
  buildOffBorderColor,
  buildSelectionColor,
  resolveModeColors,
  type ThemeLike,
} from "./engine/mode-colors.js";
import {
  type ExCommandSettings,
  readPiVimSettings,
  resolveExCommandSettings,
  resolveSurfaceSyncMaps,
} from "./engine/settings.js";
import type { Mode } from "./engine/types.js";
import type { EditorSurface, ModeChangeEvent } from "./contract.js";

export type ModeChangeFn = (mode: Mode, previousMode: Mode) => void;

export type SessionConfig = {
  clipboardMirrorPolicy: ClipboardMirrorPolicy;
  exCommand: ExCommandSettings;
  /** Options shared by every editor of the session (colorizers, sync maps). */
  editorOptions: ModalEditorOptions;
  /** Settings problems to report once, in order. */
  warnings: string[];
  /** Mode-change hook for one surface: emits the bus event, runs the user's command. */
  modeChangeFor(surface: EditorSurface): ModeChangeFn;
};

const reverseVideo = (s: string) => `\x1b[7m${s}\x1b[27m`;

export function resolveSessionConfig(
  cwd: string,
  theme: ThemeLike | undefined,
  emit: (event: ModeChangeEvent) => void,
): SessionConfig {
  const settings = readPiVimSettings(cwd);
  const warnings: string[] = [];
  const clipboard = resolveClipboardMirrorPolicy(settings.clipboardMirror);
  if (clipboard.warning) warnings.push(clipboard.warning);
  const exCommand = resolveExCommandSettings(
    settings.exCommand,
    settings.globalExCommand,
  );
  if (exCommand.warning) warnings.push(exCommand.warning);

  const displayLineMotion = settings.displayLineMotion === true;
  if (settings.displayLineMotion !== undefined && typeof settings.displayLineMotion !== "boolean") {
    warnings.push("Invalid piVim.displayLineMotion; expected a boolean.");
  }

  // Plugin behaviour pi-vim reproduces (vim-wordmotion, targets.vim,
  // surround.vim): on unless a setting turns it off.
  const toggles = { wordMotion: true, targets: true, surround: true };
  for (const key of ["wordMotion", "targets", "surround"] as const) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value === "boolean") toggles[key] = value;
    else warnings.push(`Invalid piVim.${key}; expected a boolean.`);
  }

  const modeColors = resolveModeColors(settings.modeColors);
  const { borderSync, labelSync } = resolveSurfaceSyncMaps(settings);
  // Both surfaces get their colorizers unconditionally; the editor installs
  // the border trap only when a surface actually needs it, so the all-default
  // case leaves the host border untouched.
  const editorOptions: ModalEditorOptions = {
    labelColorizers: theme
      ? buildModeColorizers(theme, modeColors, reverseVideo)
      : null,
    borderColorizers: theme ? buildModeColorizers(theme, modeColors) : null,
    borderSync,
    labelSync,
    offBorderColor: theme ? buildOffBorderColor(theme) : null,
    selectionColor: theme ? buildSelectionColor(theme) : null,
    labelTransform: reverseVideo,
    displayLineMotion,
    ...toggles,
  };

  const handlers = new Map<EditorSurface, ModeChangeFn>();
  return {
    clipboardMirrorPolicy: clipboard.policy,
    exCommand: exCommand.settings,
    editorOptions,
    warnings,
    modeChangeFor(surface) {
      let handler = handlers.get(surface);
      if (!handler) {
        handler = createModeChangeHandler(settings.modeChange, (event) =>
          emit({ ...event, surface }),
        );
        handlers.set(surface, handler);
      }
      return handler;
    },
  };
}
