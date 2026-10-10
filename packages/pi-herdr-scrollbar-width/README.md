# pi-herdr-scrollbar-width

A [pi](https://pi.dev) extension that keeps pi's fullscreen exit transcript from
wrapping inside [herdr](https://herdr.dev).

With `ui.pane_scrollbars` on (herdr's default), herdr gives a pane's main screen one
column less than its alt screen: the scrollbar gutter is reserved only outside the
alt screen. When fullscreen pi exits, it leaves the alt screen and at once prints its
transcript at the width it last saw. herdr's `SIGWINCH` for the narrower main screen
arrives too late, so every full-width line wraps.

This watches pi's own stdout for the alt-screen exit and narrows
`process.stdout.columns` by that one column right away. When herdr's `SIGWINCH`
arrives it reports the same width, so Node emits no resize. Entering the alt screen
needs nothing: herdr widens the pane and the normal resize path re-renders.

It does nothing outside herdr (`HERDR_ENV=1`), when stdout is not a TTY, or when
`pane_scrollbars = false` in herdr's config. Remove it once herdr reserves the
gutter consistently.

## Install

```sh
pi install git:github.com/justmytwospence/pi-herdr-scrollbar-width
```

## Development

```sh
npm install
npm run check   # tsc against pi's types
```
