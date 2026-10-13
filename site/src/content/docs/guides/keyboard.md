---
title: Keyboard & focus
description: Which component receives a key, the shortcuts suite plugins add, and where Ctrl+L, Ctrl+J/K and Ctrl+U/D apply.
---

Pi sends each key to the component that has focus: the prompt editor, a dialog, a picker or a full-screen viewer. Extensions can also register application shortcuts, and some listen to raw terminal input before the focused component sees it. The suite follows three rules:

1. **Text fields keep text-editing keys.** A prompt, a search filter or a comment box is never hijacked for navigation.
2. **Read-only viewers own movement keys.** Scrolling keys apply where there is nothing to type into.
3. **Few shortcuts are global.** The ones that are, and their conflicts, are listed below.

## Shortcuts the suite adds

| Keys | Plugin | Where it acts |
| --- | --- | --- |
| Ctrl+L | [pi-clear-screen](/plugins/pi-clear-screen/) | Clears the fullscreen transcript view. Conflicts with Pi's model selector; see [below](#ctrll). |
| Ctrl+Shift+X | [pi-copy](/plugins/pi-copy/) | Opens the `/yank` picker. Configurable with `shortcut`. |
| Ctrl+S | [pi-stash](/plugins/pi-stash/) | Stashes, restores or swaps the main prompt draft. Only when the main editor has focus. |
| Tab | [pi-select-nav](/plugins/pi-select-nav/) | Accept explicit completion, then an empty-editor next-prompt, then select/cycle available task panels; otherwise nothing. Drafts are preserved. |
| Right (also Tab without select-nav) | [pi-next-prompt](/plugins/pi-next-prompt/) | Accepts a shown suggestion into the empty, focused main editor. Configurable with `acceptKeys`. |
| Ctrl+J, Ctrl+K; j, k | [pi-select-nav](/plugins/pi-select-nav/) | Move down and up in lists and pickers that do not own those keys. |
| Alt+/, Super+/, Ctrl+Alt+W | [pi-btw](/plugins/pi-btw/) | Move focus between the BTW overlay and the main editor. `PI_BTW_FOCUS_KEYS` replaces them. |
| Alt+W | [pi-btw](/plugins/pi-btw/) | Toggles the BTW overlay between window and full width. |
| Shift+Tab | [pi-tool-gate](/plugins/pi-tool-gate/) | Cycles permission modes (manual, accept edits, plan, auto). Overrides Pi's thinking-level cycle; configurable with `cycleShortcut`. |
| Your choice | [pi-plan-mode](/plugins/pi-plan-mode/) | Toggles plan mode only if you set `toggleShortcut` (with the gate, cycles its modes); none by default. |

Everything else, such as the `x`, `r` or `f` keys in task views, belongs to one dialog and only works while it has focus. Each reference page lists its own keys.

## Input contexts

Suite components declare what kind of input they own through a shared method keyed by `Symbol.for("pi-plugins.input-context.v1")`:

| Context | Meaning | Examples |
| --- | --- | --- |
| `editor` | A text editor owns every key | pi-vim editors, the BTW overlay, a question dialog while you type a free-text answer |
| `filter` | A search field; printable keys are text | The `/yank` picker |
| `list` | A selection list | pi-bg's `/tasks` dialog, a question dialog while choosing |
| `viewer` | Read-only scrolling content | pi-bg log viewer, subagent conversation viewer, marimo notebook view |

Global list-navigation listeners leave a component that declares a context alone; it implements its own bindings. pi-select-nav, for example, neither inspects nor rewrites its list keys. Its contextual Tab routing is a separate, main-prompt-only action. A component without the declaration, such as another package's picker, has an unknown context, and select-nav falls back to heuristics that protect text entry. See the [pi-select-nav reference](/plugins/pi-select-nav/).

## Ctrl+L

Pi binds Ctrl+L to `app.model.select` by default. pi-clear-screen registers the same key, and at the start of an interactive session it warns while that conflict is present. Move the model selector in `~/.pi/agent/keybindings.json`, then `/reload`:

```json
{
  "app.model.select": ["alt+p", "alt+m"]
}
```

Disable any model-cycling bindings that use Alt+P; the personal profile below disables both cycling actions. On Windows and WSL, Pi's default `app.model.cycleBackward` is Alt+P, so the picker remap must not leave that conflict active. Clearing is a shortcut, not a command: it adds nothing to the prompt history and leaves your draft in the editor. It only acts in fullscreen mode and never removes conversation context.

## Optional personal profile

These are explicit preferences, not stock Pi defaults. Merge with existing bindings rather than replacing unrelated settings:

```json
{
  "app.model.select": ["alt+p", "alt+m"],
  "app.model.cycleForward": [],
  "app.model.cycleBackward": [],
  "app.thinking.cycle": "alt+t",
  "app.thinking.toggle": "ctrl+shift+t",
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

pi-tool-gate binds Shift+Tab to its permission-mode cycle, which is why Alt+T takes the thinking cycle here. Without the gate, set plan-mode's `toggleShortcut` to `shift+tab` instead; never both. Ctrl+O still expands tool detail and Ctrl+G opens Pi's external editor. The retained todo package supplies personal Ctrl+T, which [pi-select-nav](/plugins/pi-select-nav/) keeps working while a dialog has focus; todos are not process activities. Alt+T cycles effort; it is not a promise of identical Claude thinking semantics.

Do not assign Ctrl+U/D to `tui.altScreen.halfPageUp`/`halfPageDown`. Those fullscreen actions run before the editor and would steal Insert-mode editing. The owned editor handles the mode-sensitive path instead. Normal-mode `gg/G` in an editor retain Vim cursor motions; read-only viewers use their own document motions.

Herdr and tmux own their Ctrl+B prefixes before applications see input. Keep their navigation separate from Pi's editor and viewer bindings; no claim of complete cross-tool mirroring is implied.

## Ctrl+J and Ctrl+K

In the prompt editor, Pi uses Ctrl+J for a new line and Ctrl+K to delete to the end of the line. pi-select-nav turns them into down and up only in lists. It leaves them alone in the main editor, in any active editor nested inside a dialog, and in any component that declares an input context. Plain `j` and `k` move only where nothing accepts text and the component does not bind those letters itself.

Pi's own list bindings do not include Ctrl+J/K. To use them in the editor's autocomplete popup and other keybinding-aware lists, add them in `keybindings.json`:

```json
{
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

## Ctrl+U and Ctrl+D

These are **not** global scrolling shortcuts. In Pi's editor, Ctrl+U deletes to the start of the line and Ctrl+D deletes forward, or exits Pi when the editor is empty. Suite components only scroll with them where no text is being edited:

| Surface | Ctrl+U / Ctrl+D |
| --- | --- |
| Pi's prompt editor, or pi-vim in Insert mode | Pi's editing keys, unchanged |
| pi-vim main editor in idle Normal mode | Scroll the fullscreen transcript half a page; consumed and inert in regular mode |
| pi-vim embedded editor in idle Normal mode | Scroll the dialog's own view when it offers one |
| `/yank` filter | Ctrl+U clears the query; Ctrl+D deletes forward, which does nothing at the end of the query |
| BTW native composer | Scroll the BTW transcript half a page only while the composer is empty |
| Subagent conversation viewer | Half page; while its steering composer is open, the composer owns the keys |
| pi-diff-review viewer | Half page; an open comment editor owns the keys |
| pi-bg log viewer | Half page; PageUp/PageDown remain optional full-page aliases |

In pi-vim's Insert mode on the main prompt, Ctrl+X Ctrl+F opens a file finder that can also search outside the project; see [pi-vim](/plugins/pi-vim/#finding-files). A lone Ctrl+X reaches Pi after one second.

"Idle" Normal mode means no count, operator, pending motion or EX line. In Visual mode and while a command is pending, pi-vim keeps its own behavior. Plan-mode screens have their own lane and tool-tree keys; see its reference.

## Escape and focus

Escape is local first. In pi-vim it leaves Insert or Visual mode and cancels pending keys; only in idle Normal mode does it reach Pi (on the main prompt, by default `app.interrupt`) or cancel an embedded editor's dialog. Dialogs and viewers close on Escape; the `/yank` picker first clears a non-empty filter. In the BTW overlay, Escape while a reply streams aborts it, and Escape when idle dismisses the overlay.

Overlays that stay open, like BTW, can give focus back to the main editor without closing. Keys then go to the editor until you switch back.

For conflicts with other extensions, see [troubleshooting](/guides/troubleshooting/#shortcuts-and-vim-keys).
