---
title: pi-vim
description: Vim modal editing for Pi's prompt, plus the embedded modal editor that suite dialogs request for their text fields.
plugin: pi-vim
---

## Quick reference

- **Use it for:** Edit the main prompt modally and provide optional modal text fields in suite dialogs.
- **Enable:** Select `packages/pi-vim/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Vim modes/motions; Ctrl+X Ctrl+E for external editor (main Insert/idle Normal); Ctrl+X Ctrl+F for files (main Insert). No slash command/global shortcut.
- **Settings:** Pi's `piVim` settings; clipboard mirror all by default. Settings load at session start; shell `modeChange` is global-only.
- **Requirements, cost & privacy:** TUI; `fd` for recursive file search, one-level fallback without it. No inference calls. Clipboard mirroring exports register text; external editor/hooks run locally.
- **Integrations & limits:** Optional embedded consumers, stash, navigation and footer. Explicit Downloads browsing is newest-modified-first; project/home ranking is unchanged. Only one Vim editor.

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

## Motion cheatsheet

These are **draft motions**, not transcript navigation. Escape (or Ctrl+[) enters Normal; `i` resumes Insert. The [supported-motion reference at the imported upstream revision](https://github.com/lajarre/pi-vim/blob/e55b07c05b648f3bbccf656c2b0c6ec63f1a91d1/README.md) covers the full engine and its Vim differences.

| Task | Keys / examples |
| --- | --- |
| Move by character, line or word | `h j k l`, `w b e`; `3w` moves three words. |
| Move within the draft | `0` line start, `^` first nonblank, `$` line end, `gg` / `G` draft start/end; `gj` / `gk` move by wrapped screen row. |
| Insert or open a line | `i a I A`, `o O`. |
| Operate on a motion / line | `dw`, `cw`, `yw`; `dd`, `cc`, `yy`; counts such as `2dd`. |
| Select / paste | `v` character Visual, `V` line Visual; `p` / `P`. A terminal paste or a file dragged in while in Normal or Visual inserts its text after the cursor, like `p`, and stays in Normal. |
| Undo / redo / repeat | `u`, Ctrl+R, `.`. |
| Sentences, lines and columns | `(` `)` sentences, `+` `-` next/previous line, `\|` column, `g_` last nonblank, `ge` / `gE` back to a word end. |
| Case, shift and numbers | `~`, `g~` / `gu` / `gU` / `g?` with a motion (`gUiw`, `guu`), `>>` / `<<` / `>ip`, Ctrl+A / Ctrl+X on a number. |
| Text objects | Words, `ip` / `ap`, `is` / `as`, `it` / `at`, `il` / `al`, brackets and quotes (outside one, the next one on the line). |
| Word search | `*` / `#` (and `g*` / `g#`) jump to the word under the cursor, `n` / `N` repeat. |
| Replace and reselect | `R` Replace mode (Backspace restores), `gv` last selection, `gi` Insert where you left it. |
| Visual | `p` / `P` replace the selection and keep the register; `~` `u` `U` case, `>` `<` shift, `J` / `gJ` join, `r` replace, text objects (`vi(`, `vip`). |

Operators, counts and text objects are supported. Every register name is the unnamed register except `"_`, the black hole. Macros, marks, block Visual, `/` search and general Vim EX semantics are not: an unsupported command that takes a key (`qa`, `@a`, `ma`, `'a`, `zz`, `]x`) drops that key rather than running it as a command.

### Plugin behavior

pi-vim reproduces three popular Vim plugins; each has a [setting](#settings) to turn it off.

- **[surround.vim](https://github.com/tpope/vim-surround):** `ys{motion}{char}` (`ysiw)`, `ysiw(` with inner spaces, `ysiwt` then a tag ending in `>` or Enter, `ysiwf` then a function name), `yss` for the line, `ySS` on its own lines; `ds{char}`; `cs{old}{new}` (`cs"'`, `cs)]`, `cst<p>`); Visual `S{char}`. `.` repeats them and the unnamed register is left alone.
- **[targets.vim](https://github.com/wellle/targets.vim):** pair, quote, separator (`, . ; : + - = ~ _ * # / | \ & $`), argument (`a`) and tag text objects that seek the next or previous one on the line, with `I` / `A` (inside without blanks, around with one side's blank), `n` for the next object (`cin(`), `b` for any bracket and `q` for any quote. The targets.vim `l` (last) modifier is not available: `il` / `al` are Neovim's line objects.
- **[vim-wordmotion](https://github.com/chaoren/vim-wordmotion):** lowercase `w`, `b`, `e`, `ge`, `iw` and `aw` stop inside `CamelCase`, `ACRONYMWords`, `snake_case` and `kebab-case`; `W`, `B`, `E` and `iW` still use whole WORDs.

Neovim (with these plugins loaded for their cases) is the reference: the package's parity tests run every case in both editors. In idle Normal, Ctrl+U/D scroll the host viewport instead of moving through the draft, and with [pi-copy](/plugins/pi-copy/#copy-mode) loaded `/` and `?` open its copy mode over the whole transcript. [Keymap & focus](/guides/keyboard/#use-vim-on-the-main-prompt-or-in-a-dialog) compares main and embedded behavior.

## Finding files

In Insert mode on the main prompt, **Ctrl+X Ctrl+F** (Vim's file-name completion) opens a fuzzy file finder and inserts the chosen path as an `@` mention, the way Pi's `@` autocomplete does. A plain query searches the project with `fd`, respecting `.gitignore`, and, once you type something, your home directory too (four levels deep, skipping hidden entries), so `download` finds `~/Downloads` from any project; matches from both are ranked together, project first on ties. Start the query with `~/`, `/`, `./` or `../` to search only below that directory (four levels deep; hidden entries are skipped for `~/` and `/` themselves), for example `~/Downloads/inv`. Directory segments match fuzzily too: an exact name wins, then the shortest name starting with the segment, then the best fuzzy match, so `~/dl/inv` searches `~/Downloads` and `~/pr/pi-pl/READ` finds `~/Projects/pi-plugins/README.md`. Hidden directories match only when the segment starts with `.`. Up/Down (or Ctrl+P/N, Ctrl+K/J) move, Tab descends into a directory, Enter inserts and Escape cancels. Project paths are inserted relative to the project, others with `~/` or as absolute paths. Without `fd`, only one directory level is listed.

When explicitly browsing **`~/Downloads/` or a descendant**, entries are sorted by newest **modification** time first; fuzzy filtering keeps that order rather than ranking by match score. The rule applies after fuzzy directory resolution, so `~/dl/` gets the same order. Ordinary project/home searches keep their existing fuzzy ranking. The picker reads timestamps asynchronously, at most 16 at a time, and caches the listing and recency for its lifetime. Unreadable/missing times sort last, with alphabetical ties. A `newest modified first` hint identifies this mode; close and reopen to refresh cached timestamps.

On the main prompt, **Ctrl+X Ctrl+E** opens Pi's external editor in Insert or idle Normal mode, matching the shell convention. It invokes `app.editor.external` even if that action's direct keybinding is disabled. Embedded dialogs, pending Vim commands, and EX input keep their own keys.

Ctrl+X waits one second for the second key. Any other key, or the timeout, passes Ctrl+X on. In Normal mode it then decrements the number at or after the cursor, like Vim; on a line without a number, and in Insert mode, it reaches Pi's default binding (`app.message.copy`), after the delay.

## Embedded editors in suite dialogs

pi-vim answers the `pi-plugins.editor-factory.v1` request on Pi's event bus while a session is active. A dialog that asks gets a multi-line modal editor; a dialog that gets no answer uses Pi's native editor. Current consumers include [pi-ask-user-question](/plugins/pi-ask-user-question/)'s free-text answer, [pi-diff-review](/plugins/pi-diff-review/)'s comment editor and the [pi-subagents](/plugins/pi-subagents/) session view's editor.

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
- `displayLineMotion`: `true` makes Normal and Visual mode treat each wrapped screen row as its own line: `j`/`k`, `0`/`^`/`$`, `gg`/`G`, `dd`/`yy`/`cc`/`S`/`D`/`C`/`Y`, `dj`/`yk`, `V`, `o`/`O` and linewise `p` all work on rows. Yanked rows keep no soft-wrap breaks; opening or pasting a line between two rows splits the underlying line there. Insert mode is unaffected. Default `false`.
- `wordMotion`, `targets` and `surround`: `false` turns off the vim-wordmotion, targets.vim or surround.vim behavior described [above](#plugin-behavior). Default `true` each.
- `exCommand.piDispatch` turns the EX bridge to Pi commands off when `false`; `copyInputToClipboard` copies the prompt before each dispatch.
- `modeColors`, `borderSync` and `labelSync` choose per-mode colors for the input border and the footer label.
- `modeChange` runs a shell command when the main or embedded editor changes mode. Because it executes commands, it is read **only from the global settings file**; a project file cannot set it.

See the [local motion cheatsheet](#motion-cheatsheet) and [full key reference at the imported upstream revision](https://github.com/lajarre/pi-vim/blob/e55b07c05b648f3bbccf656c2b0c6ec63f1a91d1/README.md) for Vim differences and limits; block Visual mode, macros, marks, `/` search and Vim ex semantics are out of scope.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-vim), including the [entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-vim/src/index.ts) and the [integration contract](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-vim/src/contract.ts).
