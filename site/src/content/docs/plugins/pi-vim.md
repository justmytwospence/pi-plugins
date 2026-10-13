---
title: pi-vim
description: Vim modal editing for Pi's prompt, plus the embedded modal editor that suite dialogs request for their text fields.
plugin: pi-vim
---

`pi-vim` replaces Pi's prompt editor with a Vim-style modal editor: Insert, Normal, Visual and Visual-line modes, motions, operators with counts, text objects, undo/redo, `.` repeat, and an EX line. It also answers a suite event-bus request for an **embedded** editor, so text fields in other suite dialogs can be modal too. The editing engine is [pi-vim](https://github.com/lajarre/pi-vim) 0.14.2 (MIT, lajarre); the suite adds the embedded-editor provider, the integration protocol and transcript scrolling.

## Enable and requirements

Entry: `packages/pi-vim/src/index.ts`. Follow [Install & select](/guides/install/), or merge this object into your `packages` array:

```json
{
  "packages": [
    {
      "source": "git:github.com/justmytwospence/pi-plugins",
      "extensions": ["packages/pi-vim/src/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Remove `npm:pi-vim` first. Two vim editors fight over the prompt; when the standalone package's editor or its mode events are detected, the suite copy warns once that only one copy should be enabled.

**Requirements and costs:** Pi's interactive TUI. There are no external services or model requests. The OS clipboard mirror uses Pi's clipboard support. An optional `modeChange` hook runs a shell command you configure (below). The suite manifest lists pi-vim first, so it is installed before [pi-status-footer](/plugins/pi-status-footer/) wraps the editor's borders and before [pi-stash](/plugins/pi-stash/) wraps the editor factory.

## Modes and the prompt

Escape (or Ctrl+[) leaves Insert for Normal. In **idle** Normal mode (no count, operator, pending motion or EX line), Escape reaches Pi, which by default means `app.interrupt`; Visual mode and pending commands handle Escape locally. The footer shows the current mode, and the cursor shape follows it on terminals that support it.

The EX line on the main prompt is a bridge to Pi, not Vim's ex language. `:name args` runs the Pi slash command of that name, `:!cmd` runs `cmd` through Pi's shell (`:!!cmd` keeps it out of context), and the draft is snapshotted before dispatch and restored after. `:q` quits Pi only when the prompt is empty; `:q!` forces it. Names Vim reserves for its own ex commands, such as `:s`, `:g` and `:w`, are never dispatched, and anything unknown produces a warning instead of reaching the model.

**Ctrl+U and Ctrl+D** scroll Pi's fullscreen transcript half a page, but only in idle Normal mode. In Insert mode they keep Pi's editing meanings (delete to line start; delete forward, or exit on an empty editor). In Visual mode and pending states they keep the engine's behavior. In regular, non-fullscreen mode there is no transcript viewport, so in idle Normal mode they are consumed and do nothing rather than deleting text or exiting.

## Finding files

In Insert mode on the main prompt, **Ctrl+X Ctrl+F** (Vim's file-name completion) opens a fuzzy file finder and inserts the chosen path as an `@` mention, the way Pi's `@` autocomplete does. A plain query searches the project with `fd`, respecting `.gitignore`, and, once you type something, your home directory too (four levels deep, skipping hidden entries), so `download` finds `~/Downloads` from any project; matches from both are ranked together, project first on ties. Start the query with `~/`, `/`, `./` or `../` to search only below that directory (four levels deep; hidden entries are skipped for `~/` and `/` themselves), for example `~/Downloads/inv`. Directory segments match fuzzily too: an exact name wins, then the shortest name starting with the segment, then the best fuzzy match, so `~/dl/inv` searches `~/Downloads` and `~/pr/pi-pl/READ` finds `~/Projects/pi-plugins/README.md`. Hidden directories match only when the segment starts with `.`. Up/Down (or Ctrl+P/N, Ctrl+K/J) move, Tab descends into a directory, Enter inserts and Escape cancels. Project paths are inserted relative to the project, others with `~/` or as absolute paths. Without `fd`, only one directory level is listed.

Ctrl+X waits one second for the second key. Any other key, or the timeout, passes Ctrl+X on to Pi, so its default binding (`app.message.copy`) still works, after the delay.

## Embedded editors in suite dialogs

pi-vim answers the `pi-plugins.editor-factory.v1` request on Pi's event bus while a session is active. A dialog that asks gets a multi-line modal editor; a dialog that gets no answer uses Pi's native editor. Current consumers include [pi-ask-user-question](/plugins/pi-ask-user-question/)'s free-text answer, [pi-diff-review](/plugins/pi-diff-review/)'s comment editor, the [pi-subagents](/plugins/pi-subagents/) conversation viewer's composer and [pi-btw](/plugins/pi-btw/)'s overlay.

An embedded editor never reaches Pi's agent, command registry, shell or process:

- Escape is local first (Insert to Normal, Visual to Normal, drop pending keys, close the EX line). Only Escape in idle Normal mode cancels the dialog.
- `:w`, `:wq` and `:x` submit. The `:q` family cancels, refusing with a warning while the editor has text unless you add `!`. Other EX commands, `/commands` and `!shell` lines are not dispatched.
- Ctrl+U and Ctrl+D in idle Normal mode scroll the dialog's own viewport when it provides one; otherwise they are consumed.

Editors are disposed when their dialog closes and at session shutdown. The editor also exposes the suite's input-context, mode and draft-snapshot protocol, which [pi-select-nav](/plugins/pi-select-nav/), [pi-next-prompt](/plugins/pi-next-prompt/) and pi-stash use to leave its keys alone or restore its cursor and mode. See [keyboard & focus](/guides/keyboard/).

## Settings

Settings live under a `piVim` key in Pi's own settings files, `~/.pi/agent/settings.json` and a trusted project's `.pi/settings.json`. They are read at session start, and invalid values produce a warning. For example:

```json
{
  "piVim": {
    "clipboardMirror": "yank",
    "exCommand": { "piDispatch": true, "copyInputToClipboard": false }
  }
}
```

- `clipboardMirror`: `all` (default), `yank` or `never`; which register writes are mirrored to the OS clipboard.
- `exCommand.piDispatch` turns the EX bridge to Pi commands off when `false`; `copyInputToClipboard` copies the prompt before each dispatch.
- `modeColors`, `borderSync` and `labelSync` choose per-mode colors for the input border and the footer label.
- `modeChange` runs a shell command when the main or embedded editor changes mode. Because it executes commands, it is read **only from the global settings file**; a project file cannot set it.

The engine's full key reference, Vim differences and limits are documented in the package; block Visual mode, macros, search and Vim ex semantics are out of scope.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-vim), including the [entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-vim/src/index.ts) and the [integration contract](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-vim/src/contract.ts).
