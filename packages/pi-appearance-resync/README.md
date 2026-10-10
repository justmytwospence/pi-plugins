# pi-appearance-resync

A Pi extension that keeps a `"light/dark"` theme in step with the terminal when Pi runs inside a
multiplexer that announces an appearance change before it reports the new colors.

## The problem

With `"theme": "light/dark"`, Pi follows the terminal through mode 2031: when the terminal sends a
light/dark report (`CSI ? 997 ; 1 n` or `; 2 n`), Pi queries the terminal's colors at once, and the
reported background decides which theme it uses.

Herdr 0.9.3 forwards that report to its panes before it has fetched the new colors from the host
terminal ([herdrdev/herdr#4183](https://github.com/herdrdev/herdr/issues/4183)). Pi's query gets the
old background, so Pi stays one switch behind: light while the system is dark, and the reverse.

## What it does

When the terminal reports an appearance change, the extension replays the report to Pi 250 ms, 1 s
and 3 s later. Each replay makes Pi query the colors again, and by then the multiplexer reports the
new ones. A newer report cancels the replays still pending for the previous one.

It uses only the escape sequences the terminal already speaks, so it works with any terminal. Where
the first answer was already right, the replays find the same colors and Pi changes nothing.

It has no effect when the multiplexer forwards no reports at all. A herdr client in that state
starts forwarding again after a detach and re-attach.

## Install

```sh
pi install git:github.com/justmytwospence/pi-appearance-resync
```

No configuration. Set `PI_APPEARANCE_RESYNC_LOG=/path/to/file` to log reports and replays.

## Caveat

Pi's extension API has no appearance hooks. The extension reaches the TUI through a widget that
renders nothing and uses two pi-tui methods outside that API, `onTerminalColorSchemeChange` and
`consumeTerminalColorSchemeReport`. If a Pi release removes them, the extension does nothing rather
than fail. Remove it once herdr sends the report after the new colors.

## Development

```sh
npm install
npm run check
```
