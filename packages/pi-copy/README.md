# pi-copy

A Pi extension: `/yank` (or `ctrl+shift+x`) opens a scrollable picker of things you might want to copy from the session, and copies the one you pick to the clipboard. `/copy-mode` (or `alt+s`) is a vim-style copy mode over the whole transcript: search, hints, jumps and yank.

The picker opens at once in recency order. If a classifier model is available, Jev then ranks the newest pieces by how likely you are to want to copy each one now, and the list reorders in place. Pi's built-in `/copy` (the last reply) and `ctrl+x` are left as they are.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-copy/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-copy/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-copy
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## What it finds

Pieces are found in code, over the last 30 user turns on the current branch (`maxTurns`):

- Your messages and the agent's replies, in full.
- Inside replies, the logical groups of their Markdown, from a small block parser: sections (a heading and everything under it); fenced code blocks of any fence length (a ````-fenced prompt holding its own ``` blocks is one piece, and its own sections and lists are pieces too); lists together with the line that introduces them; list items that carry a nested list or code; tables; quotes; commit messages; and paragraphs. Lines that only introduce what follows ("Run this:") are not pieces of their own.
- Shell commands: from shell code blocks, unlabeled blocks that read as commands, inline code, and the agent's bash calls, with prompts and `\` continuations handled.
- Other inline code worth copying (identifiers, versions, hashes).
- File paths, including ones with spaces written in parentheses.
- URLs. Templated ones such as `http://127.0.0.1:<port>/x` are skipped.

Each row shows a badge (`you`, `reply`, `sect`, `code`, `cmd`, `snip`, `path`, `url`, `table`, `list`, `quote`, `commit`, `text`) and its age in user turns.

## How it ranks

[Jev](https://docs.typesafe.ai), called through Pi's classifier models (`ctx.modelRegistry.findOfType("classifier", ...)` and `ctx.modelRegistry.classify`), judges up to 120 of the newest pieces in one request (`rank.maxPieces`, also capped by `rank.stateBudgetChars` of state; each piece is clipped to `rank.pieceChars`). Its input is the pieces plus your last three user messages. For each piece it scores how likely you want to copy it now (0-3); for prose pieces (paragraphs, lists, sections, quotes, whole replies) it also judges whether the piece is something worth pasting elsewhere rather than explanation.

- Suggested is ordered by `wantWeight * (score / 3) + (1 - wantWeight) * recency` (default `0.6` / `0.4`); unjudged pieces get the recency term alone.
- Prose Jev judges below `rank.copyableThreshold` (default `0.3`) is left out of Suggested. It stays in All.
- If you have moved or filtered, the cursor stays on the same piece while the list reorders; otherwise it goes to the top.
- Judgments are cached by piece content for the session and cleared on `session_start`. Each successful request appends a `copy:decision` custom entry to the session (piece count, latency, input tokens).
- Without Jev (off, no classifier model, no credentials, timeout or error), Suggested stays in recency order and the header shows `(recency order)`.

## Keys

The picker is always a search field: typing filters the current tab (fuzzy). It reports the suite's input context `filter`, so text-editing keys keep their text meaning.

| Key | Action |
| --- | --- |
| Pi's `tui.select.up` / `tui.select.down` (default Up/Down), `ctrl+k` / `ctrl+j` | Move the selection |
| PageUp / PageDown | Move by a page of rows (12) |
| Typing, bracketed paste | Add to the filter (pasted control characters become spaces) |
| Backspace | Delete the last character (grapheme) of the filter |
| `ctrl+u` | Clear the filter |
| `ctrl+d` | Delete forward at the end of the filter: does nothing |
| Tab | Switch between Suggested and All (everything, newest first) |
| Right, or Space with an empty filter | Toggle the expanded preview of the selected piece |
| Left | Collapse the preview |
| Pi's `tui.select.confirm` (default Enter) | Copy the selected piece and close |
| Pi's `tui.select.cancel` (default Esc) | Clear a non-empty filter; with an empty filter, close |

The footer hint shows the keys currently bound to the `tui.select.*` actions. After copying, a notification reports the kind, line count and character count.

## Copy mode

`/copy-mode` (or `alt+s`, or `/` and `?` in pi-vim's idle Normal mode) opens a vim-style copy mode over the whole fullscreen transcript, like herdr's or tmux's copy mode. Those only see the screen, while this one covers the history above it. It takes a snapshot of every rendered transcript line, folded tool output as folded, and opens where you were looking. Esc clears the search highlights, then closes; `q` closes.

| keys | action |
|---|---|
| `h j k l`, `w b e W B E`, `0 ^ $`, `{ }` | move; counts work (`5j`, `3w`) |
| `gg G` (`12G`), `H M L`, Ctrl+U/D/F/B/E/Y, Space | jump or scroll |
| `/` `?` then Enter, `n N` | search forward or back with every match highlighted as you type. Smartcase (`\c`, `\C` force it); JavaScript regular expressions, literal if invalid; wraps with a notice; `[3/17]` counter; Up and Down recall earlier searches; an empty search repeats the last |
| `*` `#` | search the word under the cursor |
| `gu` `gf` `gh` `ge` | preset searches: URLs, file paths (with `:line`), git hashes, error lines; then `n N` |
| `f` | label every URL, path, hash and quoted string on screen: the label copies it, Shift+label inserts it into the prompt |
| `v` `V`, `o`, then `y` | select and copy; `yy`/`Y` copy lines |
| `I`, `>` | insert the selection (or line) into the prompt, or insert it as a `>` quote, and close |
| `[[ ]]`, `[t ]t`, `[e ]e`, `[m ]m` | previous or next prompt you sent, tool call or shell command, error, reply |
| Enter | close and scroll Pi's transcript to the cursor's line |

Outside fullscreen mode (`tuiMode: "regular"`, where the terminal's own scrollback and copy mode work), it falls back to the session's text, marked `(session text)`. The snapshot does not follow output that arrives while it is open.

## Configuration

`~/.pi/agent/copy.json` (or `$PI_CODING_AGENT_DIR/copy.json`), with `<project>/.pi/copy.json` merged on top. Objects merge key by key; other values replace only when the type matches. Unreadable or invalid files are ignored. Defaults:

```json
{
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 5000 },
  "rank": { "maxPieces": 120, "pieceChars": 600, "stateBudgetChars": 60000, "copyableThreshold": 0.3, "wantWeight": 0.6 },
  "maxTurns": 30,
  "shortcut": "ctrl+shift+x",
  "copyModeShortcut": "alt+s"
}
```

Settings are reread each time the picker opens. `shortcut` and `copyModeShortcut` (empty to register none) are read once when the extension loads (the global file, plus `.pi/copy.json` in the directory Pi was started from); a change takes effect after `/reload` or a restart.

## Requirements and costs

- Interactive terminal UI only. In other modes `/yank` shows a warning and does nothing.
- Copying uses Pi's clipboard helper (`copyToClipboard`). A failure is reported as `Copy failed: ...`.
- Ranking is optional. It needs a Pi with classifier models (Pi 0.99 or newer) and a configured classifier model; Pi resolves the credentials (`TYPESAFE_API_KEY` for its `typesafe` provider). Each `/yank` with unjudged pieces makes one classifier request, which can be billed. Set `jev.enabled` to `false` to turn it off.
- On disk it reads only the settings files above. It writes nothing outside the session, where it appends the `copy:decision` entries.

## Optional integrations

- [Herdr](https://herdr.dev): while the picker is open it emits `herdr:blocked` on Pi's event bus (`{ active: true, label: "Yank picker" }`, then `{ active: false }` when it closes), so Herdr shows the pane as blocked. Outside Herdr nothing listens and the events do nothing.
- [pi-vim](https://pi-plugins.vercel.app/plugins/pi-vim/): `/` and `?` in idle Normal mode open copy mode with the search line active. They emit `copy-mode:open { direction, handled }` on Pi's event bus; any extension can do the same.
- Suite key handlers such as pi-vim and pi-select-nav read the picker's `filter` input context and leave its text input alone. Neither is required.

## Limitations

- Pi's interactive editor handles `/copy` before extension commands and reports an extension `/copy` as a conflict, so this extension uses `/yank` instead.
- Only the last `maxTurns` user turns of the current branch are covered, and only up to `rank.maxPieces` pieces are ranked per request.

## Development

```sh
cd packages/pi-copy
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the Vitest unit tests (`vitest run`). `npm run eval` runs live evals in `eval/` (with the helpers in the repository's `evals/shared/`) against Jev through the Pi installation on `PATH` (or `PI_PACKAGE_DIR`); they are skipped without `TYPESAFE_API_KEY`. `npm run eval` makes live, paid classifier requests; run it only with explicit authorization. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
