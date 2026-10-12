# pi-prose-width

Wraps prose in Pi's transcript at a readable measure, 80 columns by default, while fenced code blocks and tables keep the full width of the terminal. It applies to every Markdown Pi draws: assistant and user messages, thinking, and extensions' Markdown.

Example of the result (illustration, not a screenshot):

~~~
Line length matters because the eye has to travel back to the start of
the next line after every line it reads, and the longer that journey,
the more likely it is to land on the wrong line.

```sh
  echo "a long command line keeps the whole width of the pane, as code should, instead of wrapping at the measure"
```
~~~

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-prose-width/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-prose-width/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-prose-width
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## How it works

Pi's `Markdown` component (pi-tui) renders a message one top-level token at a time and then wraps every line at the full width. The extension patches `renderToken` on that class, which extensions share with the host:

- A paragraph, heading, list or blockquote is rendered and wrapped at the measure.
- Every other token (code, tables, rules, LaTeX) is rendered at the width it was given.
- A list or quote that holds a table, or a code block with a line longer than the measure minus 6 columns, keeps the full width.
- When the terminal is no wider than the measure, nothing changes.

The patch is installed once per process; a `/reload` re-reads the configuration and only updates the measure. Changing the measure makes every `Markdown` component drop its cached lines, so existing messages rewrap the next time they are drawn.

## Commands

| Command | Effect |
|---|---|
| `/prose-width` | Show the current measure |
| `/prose-width <columns>` | Set the measure for this Pi process |
| `/prose-width off` (or `0`) | Turn wrapping at the measure off |

The command does not write any file; the configured value applies again on the next start.

## Configuration

The measure is taken from, in order:

1. the `PROSE_WIDTH` environment variable;
2. `width` in `~/.config/agents/prose-width.json`, a file shared with the opencode and Claude Code prose-width ports;
3. the default, 80.

`0` or `off` turns it off. A value that is not a non-negative number is ignored and the next source is used; an unreadable or invalid file falls back to 80.

```json
{ "width": 80 }
```

## Requirements and costs

Nothing external. It reads `~/.config/agents/prose-width.json` at load and writes nothing.

## Limitations

`renderToken` is private to pi-tui. If a Pi release removes it, the extension throws at load ("pi-tui's Markdown has no renderToken to patch") rather than misdraw.

## Development

```sh
cd packages/pi-prose-width
npm ci
npm run check
```

`check` runs `tsc --noEmit` and then the Vitest suite (`vitest run`, `test/**/*.test.ts`). For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
