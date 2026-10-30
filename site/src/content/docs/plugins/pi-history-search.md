---
title: pi-history-search
description: Fuzzy-search prompts from the current session branch and browse history matching the entire initial draft prefix.
plugin: pi-history-search
---

## Quick reference

- **Use it for:** Recall a previous prompt without sending it, by fuzzy search or a case-sensitive draft prefix.
- **Enable:** Select `packages/pi-history-search/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Ctrl+R or `/history-search` opens the picker; configured native history actions browse prefixes. Enter restores text; Escape/Ctrl+C cancels.
- **Settings:** No plugin configuration. Bind Pi's `tui.editor.historyPrevious` and `tui.editor.historyNext` yourself; the plugin never rewrites keybindings or model-cycling settings.
- **Requirements, cost & privacy:** Interactive terminal UI and focus inspection; no external executable, network, model call, credentials or inference cost. Reads user-message text from the active session branch, not other session files.
- **Integrations & limits:** Independently usable; pi-vim and pi-select-nav are optional. Normal Ctrl+R remains Vim redo. Text only, no attachment restoration; terminal-operated picker, not a remote editable composer.

## Enable

Choose `packages/pi-history-search/src/index.ts` from the suite using [Install & select](/guides/install/). Installing the suite loads every entry by default; `pi config` narrows the selection, then `/reload` applies it. Every selected component shares one Git pin. Do not load another copy of the component alongside the suite.

From a local suite checkout, try only this component for one run:

```sh
pi --no-extensions -e ./packages/pi-history-search
```

The extension adds no runtime dependencies or editor replacement. Other suite components are not required.

## Configure native history keys

Dedicated history actions are unbound in stock Pi. To use Ctrl+P/N for older/newer prompts, merge this example into `~/.pi/agent/keybindings.json`, preserving unrelated actions:

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "app.model.cycleForward": [],
  "app.model.cycleBackward": []
}
```

Run `/reload` and inspect `/hotkeys`. These are **native Pi assignments**, not plugin shortcuts. Stock Ctrl+P cycles models; disabling both model-cycle actions removes that ambiguity (including the backward-cycle platform aliases). You can choose other history keys; the plugin resolves the configured actions rather than hardcoding Ctrl+P/N. Unassigned actions stay unassigned. Ctrl+R search needs no history-action binding.

## Search prompts

At the focused main prompt, press **Ctrl+R**, or run **`/history-search`** with no arguments. The picker snapshots prompts from the current active branch and seeds its single-line query from the current draft, flattening whitespace. An empty query keeps newest-first order; typing fuzzy-filters and ranks matches with recency breaking ties. Duplicate full texts appear once, at their newest occurrence; blank prompts are omitted.

| Task | Controls |
| --- | --- |
| Edit the query | Type, paste, Backspace and normal Input editing; j/k are literal text. |
| Previous result | Up or configured select-up action; Ctrl+P or Ctrl+K. |
| Next result | Down or configured select-down action; Ctrl+N, Ctrl+J or repeated Ctrl+R. |
| Move eight results | PageUp/PageDown or configured selection page actions. |
| Restore selected text | Enter or configured select-confirm action; never submits. |
| Cancel immediately | Escape or Ctrl+C, regardless of query; configured select-cancel also works. |

The view shows up to eight single-line previews. Preview whitespace is flattened and terminal controls are stripped, but acceptance restores the complete original multiline text. Confirming with no matches does nothing. Cancellation leaves the underlying draft untouched. A result is discarded if the session, branch leaf, editor or original draft has changed before it can be applied.

An empty history reports `No prompts in this session yet.`. Non-TUI invocation reports that the interactive terminal UI is required. The picker is terminal-operated, like native tree navigation: remote clients must not treat its filter as an editable prompt composer. Use the terminal to type and select; this is not a model question or a remote form.

## Prefix navigation and boundaries

With a nonempty draft, the first older-history action freezes **the entire initial draft** as a case-sensitive `startsWith` prefix and snapshots matching prompts. It is not substring or fuzzy matching. Exact copies of the initial draft are excluded. Repeated older actions move through matches newest first; newer actions move back toward the initial draft. Moving newer past the newest match restores that draft exactly.

Neither end wraps or falls through to unrelated native history. No matches consumes the history action without changing text; newer before any older request is likewise inert on a nonempty draft. Editing recalled text starts a fresh browse on the next history request. Nonhistory keys, focus changes, submission, session-tree changes and shutdown reset browsing; key releases do not.

Starting from an **empty draft** leaves the whole browsing run to native Pi, even after Pi recalls nonempty text. Ordinary Up/Down remain native cursor/history behavior. The plugin does not extend native empty-history storage or change its limits; branch reconstruction for plugin prefix matching and the picker includes older prompts, including resumed sessions and entries beyond the native recent-history buffer.

## Focus, Vim and scope

Prefix navigation acts only on the actually focused main editor, never a same-text embedded editor. With optional [pi-vim](/plugins/pi-vim/), it works in Insert and idle Normal, not Visual, EX, pending operations or autocomplete. **Ctrl+R opens search only in native editing or Vim Insert mode; Normal Ctrl+R remains redo.** `/history-search` opens independently of Insert mode. No sibling runtime import or companion configuration is required. The picker declares its own filter context, so optional [pi-select-nav](/plugins/pi-select-nav/) leaves its keys alone.

Prompt extraction uses only user-message text on the current active branch, joins text blocks with newlines, and preserves whitespace except when checking for blank entries. It does not scan other sessions or abandoned branches, store a separate history database, replay image attachments, send a prompt, or make network/model calls. Restoring text does not promise native cursor or undo-state restoration.

Focus inspection uses Pi TUI hooks obtained through a temporary invisible widget. If inspection is unavailable, prefix navigation is disabled with a warning and native keys are left alone. Automated checks are not full live-terminal or remote-client compatibility proof; see [keyboard ownership](/guides/keyboard/) when diagnosing focus or remapped keys.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-history-search)
