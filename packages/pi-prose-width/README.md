# pi-prose-width

A [pi](https://pi.dev) extension that wraps prose in the transcript at a readable measure, 80
columns by default, while fenced code blocks and tables keep the full width of the terminal.

~~~
Line length matters because the eye has to travel back to the start of
the next line after every line it reads, and the longer that journey,
the more likely it is to land on the wrong line.

```sh
  echo "a long command line keeps the whole width of the pane, as code should, instead of wrapping at the measure"
```
~~~

## How it works

pi's `Markdown` component (pi-tui) renders a message one top-level token at a time and then wraps
every line at the full width. The extension patches `renderToken` on that class, which extensions
share with the host: a paragraph, heading, list or blockquote is rendered and wrapped at the
measure, every other token (code, tables, rules, LaTeX) at the width it was given. A list or quote
that holds a table, or a code line longer than the measure, keeps the full width.

It applies to every Markdown pi draws: assistant and user messages, thinking, and extensions'
Markdown. `renderToken` is private to pi-tui, so a pi release that renames it makes the extension
fail loudly at load rather than misdraw. Tested with pi 1.1.0.

## Settings

The measure is `PROSE_WIDTH`, else `width` in `~/.config/agents/prose-width.json` (shared with
opencode-prose-width and claude-prose-width), else 80. `0` or `off` turns it off.

```json
{ "width": 80 }
```

`/prose-width <columns>` or `/prose-width off` changes it for the session and redraws;
`/prose-width` shows it.

## Development

```sh
npm ci && npm run check
pi -e ./src/index.ts
```
