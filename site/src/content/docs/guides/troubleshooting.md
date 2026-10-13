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
| Two copies of a tool or registration warnings | Keep either the suite entry or the standalone component, never both. This includes `npm:pi-vim`, `npm:@saadjs/pi-stash`, `npm:pi-sticky-last-prompt` and `npm:pi-btw`, which the suite now contains |
| Duplicate `/ccstyle`, `/context`, `/clear` or doubled diagram rendering | Remove `npm:pi-cc-extensions`. Its parts now live in pi-cc-render, pi-markdown-extras, pi-context, pi-status-footer and pi-subagents, and it patches the same renderer |
| `ask_user_question` collision | Disable any other extension registering the same tool, such as `@juicesharp/rpiv-ask-user-question` |
| Unexpected background UI | Check whether another background-task extension is enabled alongside pi-bg |
| `/copy` behaves differently than expected | It is Pi’s built-in last-reply command. Pi Plugins’ picker is `/yank` |
| Nothing to ask in print mode | Ask-user-question removes its tool without UI; a surviving call returns an error |

Do not “fix” collisions by enabling more copies. Select the smallest useful set first.

## Footer and editor order

[Status footer](/plugins/pi-status-footer/) replaces Pi’s footer and wraps the existing editor’s border hooks. It does not provide a vim editor.

- **pi-vim** replaces the prompt editor and must load before pi-status-footer. A replacement editor loaded afterward can remove the wrapped border hooks. Selection filters do not change the suite's entry order.
- **pi-stash** wraps the preceding editor; its order is not constrained in the same way.
- Keep one editor replacement. Do not load an upstream vim package next to the suite's pi-vim.
- Disable any other footer or working-message extension. Another footer can replace this one on startup or reload. Do not enable pi-cc-extensions: it is superseded by [pi-cc-render](/plugins/pi-cc-render/), [pi-markdown-extras](/plugins/pi-markdown-extras/), [pi-context](/plugins/pi-context/) and this footer's working row and MCP chip, and pi-cc-render leaves the footer alone.
- Run `/status native` to compare against Pi’s built-in footer without uninstalling.
- Missing footer icons (such as the MCP plug) usually mean your terminal font lacks Nerd Font symbols, not that anything is disconnected.

Resource filters select from a manifest; do not assume reordering strings in the filter reorders extensions. For separately configured editor packages, arrange their load before the suite and verify on startup. For a difficult order-dependent reproduction, use explicit `-e` entries in the desired order.

## Shortcuts and vim keys

### Ctrl+L opens the model picker

Clear-screen registers Ctrl+L, which Pi also binds to `app.model.select` by default. In an interactive session, clear-screen warns at startup when that conflict is present. Move Pi’s default model selector in `~/.pi/agent/keybindings.json`:

```json
{
  "app.model.select": ["alt+p", "alt+m"]
}
```

This is the binding the startup warning suggests; merge it with your existing bindings and `/reload`. On Windows and WSL, Pi's default `app.model.cycleBackward` also uses Alt+P, so keep only the keys that are free in your setup.

Clear-screen only clears the application-owned transcript in fullscreen mode. It never deletes conversation context, adds nothing to prompt history and leaves the editor draft untouched. See [keyboard & focus](/guides/keyboard/) for every suite shortcut.

### Ctrl+J and Ctrl+K do not reach autocomplete

Select-nav rewrites keys in pickers. Pi’s autocomplete also needs the normal list bindings:

```json
{
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

Plain `j`/`k` deliberately remain letters in search fields. Ctrl+J and Ctrl+K retain their editor meanings in the main editor and in any active editor nested in a dialog. Components that declare their own input context, such as the copy picker, are left alone by select-nav and implement their bindings themselves. Task viewers have their own key maps; do not assume every `x` or `k` does the same thing.

### Ctrl+U or Ctrl+D edits text instead of scrolling

That is intended. Ctrl+U and Ctrl+D scroll half a page only in read-only viewers and in pi-vim's idle Normal mode. In a text field they keep their editing meaning: in the copy picker's filter, Ctrl+U clears the query and Ctrl+D deletes forward. They are not global scrolling shortcuts. See [keyboard & focus](/guides/keyboard/#ctrlu-and-ctrld).

### Tab accepts a suggestion instead of completing

Next-prompt takes Tab/Right only while a suggestion is shown in the empty, focused main editor, outside autocomplete and outside dialogs. Change its `acceptKeys`, use `/next-prompt off`, or type normally to dismiss the ghost text. Accepting fills the editor; it does not submit.

Shift+Tab belongs to pi-tool-gate's permission-mode cycle when the gate is selected; Pi warns that it overrides the built-in thinking cycle until you rebind `app.thinking.cycle`. Plan mode registers no shortcut of its own unless you set `toggleShortcut`, which toggles plan mode (or, with the gate, cycles its modes), takes effect after `/reload`, and must not reuse the gate's key.

## Background and notebook work

- **No result yet:** use `bg_wait` while the agent still owns the turn, not a loop of log polls. An async completion that arrives mid-turn is held until settlement.
- **Esc stopped the wait but not the task:** expected. Use `bg_kill` to stop a shell process group, or the relevant subagent stop action.
- **`/stop` left a subagent, planner or notebook running:** expected. `/stop` stops only pi-bg's running shell tasks from this Pi process. Stop one listed entry with double-`x` in `/tasks`. Planners and Herdr children are not `/tasks` entries: stop planners from the plan screen (Esc, then Stop planning), and interrupt or close a Herdr child in its pane or through the `herdr_child` tool.
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

Prose-width patches a private Markdown method and fails at load if the method disappears. Clear-screen reaches into transcript layout and reports incompatibility. Appearance-resync uses non-public color hooks and becomes a no-op if they disappear. Herdr scrollbar-width depends on the current main/alternate-screen gutter behavior. CC render patches private tool, message and render members; a renamed member disables the affected feature rather than the whole extension. `/ccstyle off` restores Pi's native tool rendering for comparison.

Disable the specific patch and retest on the same Pi version. Appearance-resync cannot help when no terminal appearance report arrives; a Herdr detach/reattach may restore forwarding.

## Isolate a conflict

In a development checkout with component dependencies installed, load a single entry:

```sh
pi -ne -e ./packages/pi-prose-width/src/index.ts
```

`-ne` disables discovered/configured extensions; explicit `-e` entries still load. If your model needs a provider extension, add that explicit entry too. Add other components back one at a time. See [development](/development/) for test setup.

When reporting a problem, include Pi version, terminal/multiplexer, TUI or RPC mode, selected entry paths, load order, and a minimal reproduction. Redact prompts, logs, notebook contents and credentials before sharing.
