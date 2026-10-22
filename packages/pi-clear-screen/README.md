# pi-clear-screen

`ctrl+l` clears Pi's screen the way a shell does: the transcript is pushed up out of view, new output starts at the top, and scrolling up still shows everything. It acts only in fullscreen TUI mode (`"tuiMode": "fullscreen"`).

Clearing only pads the transcript. Nothing is removed from the session or the model context, the editor draft is left as it is, and prompt history is not cleared.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-clear-screen/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-clear-screen/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-clear-screen
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## Keys

| Key | Effect |
|---|---|
| `ctrl+l` | Clear the screen (keeps history; scroll up to see it) |
| `ctrl+c` while the agent works | Stop the turn, as Esc does (Claude Code's Ctrl+C). Idle, Pi's own Ctrl+C is unchanged: clear the draft, a second press exits. |

Ctrl+C is Pi's `app.clear` key, which extensions cannot bind, so the extension watches raw terminal input instead. It acts only while main's prompt editor has focus and the agent is busy; dialogs, pickers and pi-sidebar keep their own Ctrl+C. It follows your `app.clear` binding.

## Commands

`/clear` starts a fresh session while keeping the active provider, model and thinking level. Unlike Ctrl+L, it clears model context. `/new` retains Pi's normal startup-selection behavior. `/exit` exits Pi.

This component supplies both `/clear` and `/exit`. Do not enable pi-cc-extensions alongside it: that package, now superseded by suite components such as pi-cc-render, registers the same aliases. pi-cc-render does not.

## How it works

Pi has no clear action, so the extension works on the fullscreen transcript directly:

- It appends an invisible marker component to the chat container.
- It wraps the document container's `render()`: the marker's line is removed and blank lines are padded at the end until the marker position is the first visible row, like a terminal's cleared screen. As new output arrives the padding shrinks to nothing, so no blank page is left in the history.
- It scrolls the transcript to the end and requests a render.

Pressing `ctrl+l` again moves the marker to the current end. Only the chat container and the document renderer are touched; the editor is not.

The marker is ephemeral: `/new`, `/resume` and `/reload` rebuild the chat and drop it. On `session_start` and `session_shutdown` the extension removes its marker and restores the original renderer, unless another wrapper has replaced it since. When the transcript is printed in regular mode (for example on leaving fullscreen), no padding is added.

## Configuration

Pi binds `ctrl+l` to `app.model.select` by default. At session start in TUI mode, if `app.model.select` still includes `ctrl+l`, the extension shows a warning:

> clear-screen: Ctrl+L conflicts with Pi model selection. Set "app.model.select": ["alt+p", "alt+m"] in keybindings.json, then reload.

Move model selection off `ctrl+l` in `~/.pi/agent/keybindings.json`, for example:

```json
{ "app.model.select": ["alt+p", "alt+m"] }
```

Then run `/reload`. There are no other settings.

## Requirements and costs

Pi in fullscreen TUI mode (`"tuiMode": "fullscreen"`). Nothing external; it reads and writes no files.

## Limitations

- Only fullscreen mode has an application-owned transcript. In regular mode the terminal owns scrollback, and `ctrl+l` only shows "clear-screen: only fullscreen mode (tuiMode) has a clearable transcript".
- Outside TUI mode the extension does nothing at session start.
- It reaches into Pi's transcript layout (the TUI's `layoutRoot`, the document container and its scroll viewport), which is not public API. If a Pi release changes that layout, `ctrl+l` shows "clear-screen: pi's transcript layout changed; extension needs updating" instead of misbehaving.

## Development

```sh
cd packages/pi-clear-screen
npm ci
npm run check
```

`check` runs `tsc --noEmit` and then `node --test test/*.test.mjs`. The test imports Pi's keybindings manager from the repository root's `node_modules`, so run `npm ci` at the root as well. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
