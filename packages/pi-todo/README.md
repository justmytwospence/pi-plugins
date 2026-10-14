# pi-todo

`@justmytwospence/pi-todo` adds the `todo` tool, `/todos`, and a live task widget above Pi's editor. Tasks replay from session history across `/reload` and compaction; each session keeps its own state. No task-state files are written.

## Install

Enable **pi-todo** from the [Pi Plugins suite](https://github.com/justmytwospence/pi-plugins) with `pi config`, or load this component independently:

```sh
pi -e ./packages/pi-todo/index.ts
```

For a persistent local install, use `pi install /absolute/path/to/packages/pi-todo`. Do not enable the upstream and suite copies together.

## Widget

`ctrl+shift+t` collapses or expands the widget. The collapsed view is one heading plus a blank spacer, for example:

```text
● Todos (1/3)  ctrl+shift+t to expand
```

Expanded tasks retain the configurable row budget, status glyphs, dependencies, and overflow summary. Completed tasks hide on the next agent turn. `/todos` prints the full list grouped by status. The tool also works without an interactive UI.

## Config

User settings: `~/.pi/agent/pi-todo.json` (or `$PI_CODING_AGENT_DIR/pi-todo.json`). Project overrides: `.pi/pi-todo.json` under the working directory.

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+o",
  "guidance": {
    "promptSnippet": "Track multi-step work",
    "promptGuidelines": ["Update tasks as work progresses."]
  }
}
```

- `maxWidgetLines`: content rows including the heading; default `12`, minimum `3`. Updates on repaint. Pi's expanded-tool mode shows all tasks.
- `collapseKey`: Pi key spec; default `"ctrl+shift+t"`. `"off"` disables the shortcut. Reload to rebind. The hint reads the resolved key on repaint.
- `guidance`: valid nonempty `promptSnippet` and nonempty arrays of nonempty `promptGuidelines` replace the built-ins individually. Reload to apply. Project guidance merges by field; arrays replace rather than append.

When native user config is absent, the old `$XDG_CONFIG_HOME/rpiv-todo/config.json` or `~/.config/rpiv-todo/config.json` is still read. A present XDG file wins over the old home path; a present native file wins over both, even if invalid. Existing `"collapseKey": "ctrl+t"` remains honored. No config files are rewritten. Missing, malformed, and non-object JSON fail soft; project values overlay user values.

Localization is optional: `@juicesharp/rpiv-i18n` activates the bundled locales; without it the UI uses English. No sibling extension is required.

## Development and attribution

```sh
npm ci
npm run check
```

Checks include typechecking and all component tests, with isolated temporary home/project directories.

Adapted from [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono/tree/7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f/packages/rpiv-todo), `@juicesharp/rpiv-todo` 2.12.0, imported with package history preserved by git subtree split. The upstream tool, widget, replay, and localization identities remain compatible. Config helpers and test fixtures are adapted from the same repository. See [UPSTREAM.json](UPSTREAM.json) and the unchanged upstream [MIT license](LICENSE).
