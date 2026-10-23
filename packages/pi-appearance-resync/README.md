# pi-appearance-resync

Keeps a `"light/dark"` theme in step with the terminal when Pi runs inside a multiplexer, such as Herdr, that announces an appearance change before it reports the new colors. It acts each time the terminal sends a light/dark report, in sessions with a UI.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-appearance-resync/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-appearance-resync/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-appearance-resync
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## The problem

With `"theme": "light/dark"`, Pi follows the terminal through mode 2031: when the terminal sends a light/dark report (`CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light), Pi queries the terminal's colors at once, and the reported background decides which theme it uses.

Herdr 0.9.3 forwards that report to its panes before it has fetched the new colors from the host terminal ([herdrdev/herdr#4183](https://github.com/herdrdev/herdr/issues/4183)). Pi's query gets the old background, so Pi stays one switch behind: light while the system is dark, and the reverse. Herdr fixed this after 0.9.5 ([herdrdev/herdr#5517](https://github.com/herdrdev/herdr/pull/5517)).

## How it works

At `session_start` (when the session has a UI) the extension registers a widget below the editor that renders nothing; the widget factory is how it receives the TUI. It then subscribes to the TUI's `onTerminalColorSchemeChange`.

When the terminal reports an appearance change, the extension replays the same report to Pi through `consumeTerminalColorSchemeReport` 250 ms, 1 s and 3 s later. Each replay makes Pi query the colors again, and by then the multiplexer reports the new ones. A newer report cancels the replays still pending for the previous one, and the extension ignores the notifications its own replays cause. When the widget is disposed, it unsubscribes and cancels pending replays.

It uses only the escape sequences the terminal already speaks. Where the first answer was already right, the replays find the same colors and Pi changes nothing. It has no effect when the multiplexer forwards no reports at all.

## Standing down on a fixed Herdr

Inside Herdr (`HERDR_ENV=1` or `TERM_PROGRAM=herdr`) the extension asks the running server for its version with `herdr status server` (through `HERDR_BIN_PATH` when set): once at start, then again after each appearance report, so an update handed off to a live session counts from the next switch. Until the first answer it goes by the version Herdr gave the pane (`TERM_PROGRAM_VERSION`). On a server newer than 0.9.5 it lets reports through without replaying them. Up to 0.9.5, including preview builds (which report 0.9.5 whether or not they carry the fix), when the version cannot be read, and outside Herdr, it keeps replaying. A failed read keeps the previous verdict.

## Configuration

No settings. Set `PI_APPEARANCE_RESYNC_LOG=/path/to/file` to append a log of reports and replays (timestamp, process ID, message) to that file. Logging is best effort.

## Requirements and costs

Nothing external. Inside Herdr it runs `herdr status server` at start and after each appearance report. It writes only the optional log file named by `PI_APPEARANCE_RESYNC_LOG`.

## Limitations

- Pi's extension API has no appearance hooks. The extension uses two pi-tui TUI methods outside that API, `onTerminalColorSchemeChange` and `consumeTerminalColorSchemeReport`. If a Pi release removes either, the extension does nothing rather than fail (and logs "pi-tui lacks the color scheme hooks; doing nothing" when logging is on).
- It is a workaround. On Herdr newer than 0.9.5 it already does nothing; remove it once no machine runs an older Herdr.

## Development

```sh
cd packages/pi-appearance-resync
npm ci
npm run check
```

`check` runs `tsc --noEmit` and then the Vitest suite (`vitest run`, `test/**/*.test.ts`). For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
