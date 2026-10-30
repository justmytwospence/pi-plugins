# pi-history-search

Fuzzy-search prompts from the current session's active branch with Ctrl+R, or browse history matching the entire initial draft prefix using Pi's configured history actions. Restoring a prompt never sends it.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-history-search/>.

## Enable

Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`), preserving other entries:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-history-search/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite entry; run `pi config` to keep only what you want, then `/reload`. One Git ref versions all selected components. Do not load a second copy alongside the suite.

For one isolated run from a suite checkout:

```sh
pi --no-extensions -e ./packages/pi-history-search
```

No new runtime dependencies, editor replacement or sibling plugin is required.

## Native history keybindings

Dedicated history actions are unbound in stock Pi. Merge this optional example into `~/.pi/agent/keybindings.json` and `/reload`:

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "app.model.cycleForward": [],
  "app.model.cycleBackward": []
}
```

These assignments belong to native Pi; the plugin does not install or rewrite them. Stock Ctrl+P cycles models, so the example disables both model-cycle actions to remove ambiguity, including platform aliases. Other history assignments work too; unassigned actions remain untouched. Inspect `/hotkeys` after reloading. Ctrl+R search works without configuring history actions.

## Fuzzy picker

Press **Ctrl+R** in the focused native main editor or Vim Insert mode, or run **`/history-search`** with no arguments. The picker snapshots current-branch prompts and seeds its query from the draft, flattening whitespace for the single-line input. Empty queries show newest first; nonempty queries rank fuzzy matches with recency breaking ties.

| Controls | Action |
| --- | --- |
| Type, paste, Backspace | Edit the query; j/k remain literal letters. |
| Up, Ctrl+P/K | Previous result. |
| Down, Ctrl+N/J, repeated Ctrl+R | Next result. |
| PageUp/PageDown | Move by eight results. |
| Enter | Restore the full selected text without submitting; inert with no matches. |
| Escape/Ctrl+C | Cancel immediately, even with a query; draft unchanged. |

Configured Pi selection actions also work. Up to eight sanitized, whitespace-flattened previews are shown; acceptance restores the original multiline text, not the preview. Blank prompts are ignored and exact duplicate texts retain their newest occurrence. A changed session, branch leaf, editor or draft invalidates a pending selection rather than overwriting new work.

Empty history reports `No prompts in this session yet.`. Non-TUI commands report that the interactive terminal UI is required. The picker is terminal-operated like native tree navigation, not a model question: remote clients must not expose its search field as an editable prompt composer. Type, filter and select in the terminal.

## Prefix browsing

On the first older-history request with a nonempty draft, freeze the **entire initial draft** as a case-sensitive `startsWith` prefix and snapshot its matches. Exact copies of the draft are excluded. Older moves newest-first through matching prompts; newer moves back and restores the exact initial draft beyond the newest match. There is no wrapping or fallback to unrelated entries. No matches, or newer before older on a nonempty draft, consumes the key without changing text.

An external edit starts a fresh browse on the next history request. Nonhistory keys, focus changes, submission, session-tree changes and shutdown reset the run; key releases do not. Starting empty delegates the entire run to native Pi even once native history recalls nonempty text. Ordinary Up/Down remain native cursor/history browsing. Plugin branch reconstruction includes resumed sessions and prompts older than the native recent-history buffer; native empty-history behavior and limits are unchanged.

## Focus and optional integrations

Prefix browsing requires actual focused main-editor ownership, not merely text equal to the main draft. Embedded fields keep their input. With optional pi-vim, prefix browsing works in Insert and idle Normal, but not Visual, EX, pending operations or autocomplete. **Normal Ctrl+R stays Vim redo**; Ctrl+R search is native/Insert only. `/history-search` can open independently of Insert mode.

The picker declares a filter input context so optional pi-select-nav leaves its keys alone. Neither companion is required; there are no runtime sibling imports. If Pi's focus inspection is unavailable, the plugin warns and disables prefix navigation without intercepting native history keys. Focus inspection uses TUI hooks acquired through a temporary invisible widget.

## Scope, privacy and cost

Only user-message text on the current active session branch is recalled. Text blocks join with newlines; whitespace and multiline content are preserved, with trimming only for blank detection. No other session files or abandoned branches are searched. Images and other attachments are not restored, and recalling text does not promise native cursor or undo-state preservation.

There is no separate history store, network/model request, credential, external executable or inference cost. The plugin needs Pi's interactive terminal UI; it is not a custom RPC form or cross-session search service.

## Development

```sh
cd packages/pi-history-search
npm ci
npm run check
```

Suite loading/selection and contracts are checked from the repository root with `npm test`. Automated checks are not a substitute for live terminal focus and key-ownership acceptance.

## License

MIT. See [LICENSE](./LICENSE).
