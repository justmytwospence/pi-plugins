# pi-copy

A [pi](https://pi.dev) extension: `/yank` (or `ctrl+shift+x`) opens a scrollable picker of things you
might want to copy from the session, and copies the one you pick.

**What it finds** (in code, over the last 30 user turns): your messages and the agent's replies in
full, and inside replies the logical groups of their Markdown, from a small block parser: sections
(a heading and everything under it), fenced code blocks of any fence length (a ````-fenced prompt
holding its own ``` blocks is one piece, and its own sections and lists are pieces too), lists
together with the line that introduces them, list items that carry a nested list or code, tables,
quotes, commit messages, and paragraphs. Also shell commands (from shell code blocks, unlabeled
blocks that read as commands, inline code, and the agent's bash calls, with prompts and `\`
continuations handled), other inline code worth copying (identifiers, versions, hashes), file
paths (including ones with spaces written in parentheses), and URLs (templated ones like
`http://127.0.0.1:<port>/x` are skipped). Lines that only introduce what follows ("Run this:") are
not pieces of their own.

**How it ranks.** The picker opens at once in recency order, then [Jev](https://docs.typesafe.ai),
called through Pi's own classifier models (`ctx.modelRegistry.classify`), judges up to 120 of the
newest pieces in one request (about 100-300 ms): how likely you want to copy each one now, given
your last messages, and whether each prose piece is something worth pasting elsewhere rather than
explanation. Suggested is ordered by `0.6·(likelihood/3) + 0.4·recency`; prose Jev judges not
worth pasting is left out of Suggested (it stays in All). The cursor stays on the same piece while
the list reorders. Judgments are cached for the session. Without Jev, Suggested is recency order.

**Keys.** ↑/↓ or ctrl+j/ctrl+k move, PageUp/PageDown page, typing filters (fuzzy), Tab switches
between Suggested and All (everything, newest first), → (or Space with an empty filter) expands the
preview, Enter copies and closes, Esc clears the filter or closes.

Pi's built-in `/copy` (the last reply) and ctrl+x stay as they are: Pi's interactive editor handles
`/copy` before extension commands and reports an extension `/copy` as a conflict, so this extension
uses its own name. Interactive terminal only.

**herdr.** While the picker is open it holds `herdr:blocked` on pi's event bus
(`{ active: true, label: "Yank picker" }`, then `{ active: false }` when it closes), so
[herdr](https://herdr.dev) shows the pane as blocked. Outside herdr nothing listens and the events
do nothing.

## Settings

`~/.pi/agent/copy.json`, with `<project>/.pi/copy.json` merged on top:

```json
{
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 3000 },
  "rank": { "maxPieces": 120, "pieceChars": 600, "copyableThreshold": 0.3, "wantWeight": 0.6 },
  "maxTurns": 30,
  "shortcut": "ctrl+shift+x"
}
```

`shortcut` is read from the global file at startup. Requires Pi 0.99 or newer for classifier
models.

## Development

```sh
npm run check   # typecheck and unit tests
npm run eval    # five sessions against live Jev through the installed Pi (needs TYPESAFE_API_KEY)
```
