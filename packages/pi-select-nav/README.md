# pi-select-nav

Uniform list navigation in Pi pickers, built in or from any plugin, without forking them:

| Keys | Where |
|---|---|
| `ctrl+j` / `ctrl+k` | down / up in lists, including ones with a search box or text field |
| `j` / `k` | down / up in lists where you are not typing into a text field |

Pi's `tui.select.up`/`tui.select.down` keybindings only reach components that read Pi's keybindings, and many plugins hardcode the arrow keys. So in the interactive TUI this extension listens to raw terminal input and rewrites those keys into Up/Down arrow keys before the focused component sees them, unless one of the rules below leaves them alone.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-select-nav/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-select-nav/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-select-nav
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## How it works

At `session_start` in TUI mode, the extension borrows Pi's TUI through a probe widget that is removed at once and subscribes to terminal input. For each key it looks at the focused component (`routeInput` in `src/index.ts`) and decides in this order:

1. Key releases (reported separately by kitty-protocol terminals) pass through unchanged; rewriting them would move twice per key.
2. A component that declares an input context, a function at `Symbol.for("pi-plugins.input-context.v1")` (exported as `INPUT_CONTEXT`), is left alone entirely. Such components implement their own bindings; the extension neither rewrites their keys nor renders or inspects their children.
3. If the focused component is itself an editor (the main prompt editor, or a bare editor dialog), or holds an active nested editor, every key passes through: there `ctrl+j` is a newline and `ctrl+k` deletes to the end of the line. A nested editor counts as active unless its `focused` property is explicitly `false`.
4. `ctrl+j` and `ctrl+k` are rewritten to Down and Up.
5. `j` and `k` are rewritten to Down and Up unless:
   - the component's constructor name is in `J_K_DENYLIST` (empty by default), for letter bindings the source check below cannot see;
   - letters would type into a text field: the focused component is an `Input` or `Editor`, has a `focused` property, renders a text cursor (pi-tui's `CURSOR_MARKER`, as in a question's "Type something" row), contains a focused `Input` or `Editor`, or has a string field whose name contains `search`, `query` or `filter`;
   - any method of the component, own or inherited, contains a quoted `"j"` or `"k"` literal, which means it binds those keys itself.

Nested components are found by a breadth-first walk over component-valued fields, at most three levels deep and 400 nodes. The subscription is replaced on each `session_start` and removed on `session_shutdown`.

## Configuration

Also add the keys to Pi's own list bindings in `~/.pi/agent/keybindings.json`, so the editor's autocomplete popup and other keybinding-aware lists see them directly:

```json
{
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

There are no other settings. `J_K_DENYLIST` is a constant in the source.

## Requirements and costs

Nothing external. It reads and writes no files.

## Optional integrations

Suite components that handle their own keys declare the input-context symbol (for example pi-ask-user-question's dialog and pi-copy's picker), so this extension leaves them alone. Any other extension can opt out the same way. Neither side needs the other.

## Limitations

- It acts only in TUI mode.
- It relies on non-public details: the TUI reference obtained through a widget factory, `getFocusedComponent()`, and heuristics over component fields and method source. A component whose letter bindings are not visible in its method source needs a `J_K_DENYLIST` entry.

## Development

```sh
cd packages/pi-select-nav
npm ci
npm run check
```

`check` runs `tsc --noEmit` and then `node --test test/*.test.mjs`. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
