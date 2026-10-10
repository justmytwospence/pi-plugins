---
title: Troubleshooting & conflicts
description: Resolve duplicate tools, footer and editor ordering, shortcuts, missing integrations and compatibility failures.
---
## Start with the loaded resources

Run `pi list` in your shell and inspect `pi config`. Check both personal and project scopes. A project can replace a personal package declaration; a selected suite entry does not disable a standalone copy from another source.

After changing extension selection, restart Pi or use `/reload`. If an extension patches terminal internals, a clean restart is a useful control when diagnosing persistent state.

## Duplicate tools or commands

| Symptom | Check |
| --- | --- |
| Two copies of a tool or registration warnings | Keep either the suite entry or the standalone component, never both |
| `ask_user_question` collision | Disable any other extension registering the same tool, such as `@juicesharp/rpiv-ask-user-question` |
| Unexpected background UI | Check whether another background-task extension is enabled alongside pi-bg |
| `/copy` behaves differently than expected | It is Pi’s built-in last-reply command. Pi Plugins’ picker is `/yank` |
| Nothing to ask in print mode | Ask-user-question removes its tool without UI; a surviving call returns an error |

Do not “fix” collisions by enabling more copies. Select the smallest useful set first.

## Footer and editor order

[Status footer](/plugins/pi-status-footer/) replaces Pi’s footer and wraps the existing editor’s border hooks. It does not provide a vim editor.

- If you use **pi-vim**, load it before pi-status-footer. A replacement editor loaded afterward can remove the wrapped border hooks.
- **pi-stash** wraps the preceding editor; its order is not constrained in the same way.
- Disable the competing footer in `~/.pi/agent/pi-cc-extensions.json` if you use that package. Another footer can replace this one on startup or reload.
- Run `/status native` to compare against Pi’s built-in footer without uninstalling.
- A missing plug glyph usually means your terminal font lacks Nerd Font symbols, not that MCP is disconnected.

Resource filters select from a manifest; do not assume reordering strings in the filter reorders extensions. For separately configured editor packages, arrange their load before the suite and verify on startup. For a difficult order-dependent reproduction, use explicit `-e` entries in the desired order.

## Shortcuts and vim keys

### Ctrl+L opens the model picker

Clear-screen registers Ctrl+L. Move Pi’s default model selector in `~/.pi/agent/keybindings.json`:

```json
{
  "app.model.select": "alt+m"
}
```

It only clears the application-owned transcript in fullscreen mode. It never deletes conversation context.

### Ctrl+J and Ctrl+K do not reach autocomplete

Select-nav rewrites keys in pickers. Pi’s autocomplete also needs the normal list bindings:

```json
{
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

Plain `j`/`k` deliberately remain letters in search fields. Ctrl+J and Ctrl+K retain their editor meanings in the main/multiline editor. Task viewers have their own key maps; do not assume every `x` or `k` does the same thing.

### Tab accepts a suggestion instead of completing

Next-prompt takes Tab/Right only while a suggestion is shown in an empty editor. Change its `acceptKeys`, use `/next-prompt off`, or type normally to dismiss the ghost text. Accepting fills the editor; it does not submit.

Plan mode’s configured toggle shortcut takes effect after `/reload`. Its default is Shift+Tab, which may compete with a shortcut in your setup.

## Background and notebook work

- **No result yet:** use `bg_wait` while the agent still owns the turn, not a loop of log polls. An async completion that arrives mid-turn is held until settlement.
- **Esc stopped the wait but not the task:** expected. Use `bg_kill` to stop a shell process group, or the relevant subagent stop action.
- **A service disappeared on exit:** only services explicitly started with `keep: true` are intended to outlive the session.
- **A notebook is missing:** check its server is running, registry discovery, cwd scope, hidden directories, and token access. `/marimo` pins notebooks outside automatic discovery’s set.
- **The server is ready but a fit is still running:** readiness and kernel completion are different. With pi-marimo enabled, waiting on a recognized ready server can wait for its cells.
- **Killing a marimo-pair job did not stop the cell:** stopping the client does not interrupt the kernel. Use the notebook view’s double-`x` interrupt or the browser stop control.
- **Browser edits appear late:** the exact-session connection does not see some browser edits until they run. The model’s notebook block is also intentionally fixed during a turn.

See [background work](/recipes/background-work/) and [notebook sessions](/recipes/notebooks/) for correct waiting patterns.

## Missing Herdr or quota information

Herdr integration is intentionally inactive outside an interactive Herdr pane. Headless RPC children must not inherit responsibility for the parent’s pane metadata. Herdr’s own Pi integration reports pane state; pi-herdr supplies additional tokens and children. A `$bg` token is not a claim that the pane remains in working state.

Use `/status details` to inspect quota sources. Unknown or stale data is not zero usage. Missing credentials should not be “fixed” by pasting secrets into a bug report. Use `PI_HERDR_PR=0` to disable PR polling when it is not useful.

## Compatibility patches

Prose-width patches a private Markdown method and fails at load if the method disappears. Clear-screen reaches into transcript layout and reports incompatibility. Appearance-resync uses non-public color hooks and becomes a no-op if they disappear. Herdr scrollbar-width depends on the current main/alternate-screen gutter behavior.

Disable the specific patch and retest on the same Pi version. Appearance-resync cannot help when no terminal appearance report arrives; a Herdr detach/reattach may restore forwarding.

## Isolate a conflict

In a development checkout with component dependencies installed, load a single entry:

```sh
pi -ne -e ./packages/pi-prose-width/src/index.ts
```

`-ne` disables discovered/configured extensions; explicit `-e` entries still load. If your model needs a provider extension, add that explicit entry too. Add other components back one at a time. See [development](/development/) for test setup.

When reporting a problem, include Pi version, terminal/multiplexer, TUI or RPC mode, selected entry paths, load order, and a minimal reproduction. Redact prompts, logs, notebook contents and credentials before sharing.
