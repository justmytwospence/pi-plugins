# pi-herdr-scrollbar-width

Keeps Pi's fullscreen exit transcript from wrapping inside [Herdr](https://herdr.dev) panes with scrollbars. It acts only inside Herdr, at the moment fullscreen Pi leaves the alternate screen.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-herdr-scrollbar-width/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-herdr-scrollbar-width/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-herdr-scrollbar-width
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## The problem

With `ui.pane_scrollbars` on (Herdr's default), Herdr gives a pane's main screen one column less than its alternate screen: the scrollbar gutter is reserved only outside the alternate screen. When fullscreen Pi exits, it leaves the alternate screen and at once prints its transcript at the width it last saw. Herdr's `SIGWINCH` for the narrower main screen arrives too late, so every full-width line wraps.

## How it works

When the extension loads, it wraps `process.stdout.write` (once per process). After each string write that contains an alternate-screen sequence, it checks whether the last one is the exit (`CSI ? 1049 l`) rather than the enter (`CSI ? 1049 h`). On an exit from the alternate screen it narrows `process.stdout.columns` by one column right away, so the transcript Pi prints next fits the main screen. When Herdr's `SIGWINCH` arrives it reports the same width, so Node emits no resize.

Entering the alternate screen needs nothing: Herdr widens the pane and the normal resize path re-renders. The extension assumes Pi is already in the alternate screen when it loads, since Pi may enter it before extensions load. Panes of 4 columns or fewer are not narrowed, matching Herdr, which keeps the full width there.

## Configuration

No settings of its own. It does nothing when any of these holds at load:

- `HERDR_ENV` is not `1` (Pi is not running inside Herdr);
- stdout is not a TTY;
- Herdr's config contains a line `pane_scrollbars = false`. The file is `$HERDR_CONFIG_PATH`, else `~/.config/herdr/config.toml`. If it cannot be read, scrollbars are assumed on. Herdr reads its config on the server, which is the host the pane runs on, so this is the same host as Pi.

## Requirements and costs

Herdr. It reads Herdr's config file once at load and writes no files.

## Limitations

- It patches `process.stdout.write` and `process.stdout.columns`, not a Pi API. The patch stays for the life of the process.
- The config check is a line match for `pane_scrollbars = false` anywhere in the file; it does not parse TOML sections.
- It is a workaround: remove it once Herdr reserves the gutter consistently.

## Development

```sh
cd packages/pi-herdr-scrollbar-width
npm ci
npm run check
```

`check` runs `tsc --noEmit`; this component has no tests. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
