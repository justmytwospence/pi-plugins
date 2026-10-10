# pi-select-nav

A [pi](https://pi.dev) extension for uniform list navigation in every picker, built
in or from any plugin, without forking them:

| Keys | Where |
|---|---|
| `ctrl+j` / `ctrl+k` | down / up in every list, including ones with a search box or text field |
| `j` / `k` | down / up in lists without text entry |

pi's `tui.select.up`/`tui.select.down` keybindings only reach components that read
pi's keybindings, and many plugins hardcode the arrow keys. So this extension listens
to raw terminal input and rewrites those keys into arrow keys before the focused
component sees them.

It leaves alone:

- the main editor and any focused multi-line editor, where `ctrl+j` is a newline and
  `ctrl+k` deletes to the end of the line;
- `j`/`k` in anything with a text field (an `Input`, an `Editor`, a component with a
  `focused` cursor, or a search/query/filter string), so search boxes still type
  letters;
- `j`/`k` in components whose own methods compare input against `"j"` or `"k"`: they
  bind those keys themselves (pi-background-tasks uses `k` to stop a task);
- components named in `J_K_DENYLIST`, for letter bindings the source check cannot see.

## Install

```sh
pi install git:github.com/justmytwospence/pi-select-nav
```

Also add the keys to pi's own list bindings in `~/.pi/agent/keybindings.json`, so the
editor's autocomplete popup and other keybinding-aware lists see them directly:

```json
{
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

## Development

```sh
npm install
npm run check   # tsc against pi's types
```
