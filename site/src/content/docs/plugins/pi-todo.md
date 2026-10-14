---
title: pi-todo
description: Track logical tasks with dependencies, a live checklist widget and session replay that survives reload and compaction.
plugin: pi-todo
---

## Quick reference

- **Use it for:** Track multi-step work, task status and dependencies separately from running processes.
- **Enable:** Select `packages/pi-todo/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Model-callable `todo` tool; `/todos` shows tasks grouped by status. Ctrl+Shift+T collapses/expands the widget by default; stock Ctrl+T still toggles thinking.
- **Settings:** Optional `~/.pi/agent/pi-todo.json` and project `.pi/pi-todo.json`; `collapseKey` defaults to `"ctrl+shift+t"` (`"off"` disables), `maxWidgetLines` to `12` with a floor of `3`, and `guidance` customizes tool prompt copy. Legacy rpiv-todo config remains a fallback.
- **Requirements, cost & privacy:** Task management is local, with no classifier, network, credentials or external executable required. The widget needs an interactive UI. Snapshots live in Pi session tool results; task text is visible to the model and stored with the session.
- **Integrations & limits:** Optional pi-select-nav forwards eligible todo toggle keys in dialogs; optional `@juicesharp/rpiv-i18n` localizes UI with English fallback. No rpiv-config dependency or required sibling. `/todos` is not pi-bg's `/tasks`, and completing a todo does not stop a process.

## Enable and provenance

Select `packages/pi-todo/index.ts` from the suite using [Install & select](/guides/install/). The suite loads all 27 entries by default; every selected component shares one Git pin.

This component imports [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f/packages/rpiv-todo) **2.12.0**, at original commit `7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f`, with upstream history and MIT attribution preserved. The `todo` tool, `/todos` command, `rpiv-todos` widget key and upstream replay/localization identities stay intact. Do not enable the upstream npm package alongside the suite entry: Pi does not deduplicate different packages with the same registrations.

## Manage logical tasks

The agent uses `todo` to create and update the list. `/todos` displays the full non-deleted list grouped into pending, in-progress and completed tasks, independently of the widget's row budget or completed-row hiding. It reports an empty list when there are no todos; without a UI, the command reports that interactive mode is required. The tool itself remains usable without the widget.

| Tool action | Required fields | Behavior |
| --- | --- | --- |
| `create` | `subject` | Creates a pending task and assigns an id; optional `blockedBy` records initial dependencies. |
| `update` | `id` and a mutable field | Sets `status`, subject, description, `activeForm`, owner, metadata or dependency changes. |
| `list` | None | Lists tasks; optional `status` filters and `includeDeleted: true` includes tombstones. |
| `get` | `id` | Returns a task, its dependencies and reverse `blocks` edges. |
| `delete` | `id` | Tombstones the task rather than removing its historical identity. |
| `clear` | None | Removes all tasks and resets the id counter. |

Status values are `pending`, `in_progress`, `completed` and `deleted`. Completed tasks cannot return to in-progress; deleted tasks are terminal. Use `addBlockedBy` and `removeBlockedBy` for additive dependency updates rather than resending the whole set. Unknown or deleted dependencies, self-dependencies and cycles are rejected without changing state. Metadata merges by key; an update value of `null` removes that key.

Built-in model guidance asks for a list on complex work, exactly one task in progress, and immediate status updates—not batched completions or completion while tests fail. `activeForm` is a present-continuous label such as `writing tests`; it is not the status field.

Logical todos describe intended work. [pi-bg](/plugins/pi-bg/)'s `/tasks` lists actual process/session activity and has owner-specific stop controls. Neither view automatically creates, completes or stops entries in the other.

## Widget and collapse behavior

The widget appears above the prompt only while overlay-visible tasks exist. The expanded layout retains the upstream heading, tree rows, status glyphs, active-form labels and dependency indicators. Long lines are truncated safely to the available terminal width.

**Collapsed example** (English UI, default key):

```text
● Todos (2/5)  ctrl+shift+t to expand

```

The heading and configured-key hint share **one content row**, followed by the usual blank spacer. This saves one row compared with the upstream two-line collapsed view; the expanded layout is unchanged. Narrow widths truncate the combined line without overrunning the terminal. The heading uses a dim `○` when no visible task is active. If `collapseKey` is set to `"off"` while already collapsed, the hint becomes a static `collapsed` label instead of advertising a disabled key.

The expanded widget's `maxWidgetLines` budget includes the heading and any overflow summary, but excludes the trailing spacer: the default `12` uses up to 13 terminal rows. Overflow drops completed rows before truncating unfinished work and shows a `+N more` summary. Pi's tool-output expansion (stock Ctrl+O) temporarily shows all task rows; it does not replace the dedicated collapse toggle.

Displayed completed tasks stay through the current agent run and are hidden on the next agent start. This is presentation state, not deletion; `/todos` still includes them, and replay/reload/compaction resets that hiding.

## Configuration

Create either file only if you want overrides:

- **Global:** `~/.pi/agent/pi-todo.json`; `PI_CODING_AGENT_DIR` relocates the agent directory.
- **Project:** `.pi/pi-todo.json` in Pi's working directory, overriding global settings.
- **Legacy fallback:** when the new global file is absent, read `$XDG_CONFIG_HOME/rpiv-todo/config.json` (absolute XDG path) or `~/.config/rpiv-todo/config.json`, then apply project overrides. A missing XDG file falls back to `~/.config`; an existing malformed file does not fall through to another file. Keep legacy files for rollback; migration does not rewrite them.

Project values override the global or legacy base. Guidance fields merge individually, while `promptGuidelines` arrays replace rather than concatenate. A present global file wins over legacy configuration even if malformed. Missing or non-object JSON yields defaults; malformed JSON warns and is treated as an empty object.

An example global or project configuration:

```json
{
  "collapseKey": "ctrl+shift+t",
  "maxWidgetLines": 12,
  "guidance": {
    "promptSnippet": "Use todo to track multi-step work.",
    "promptGuidelines": [
      "Keep exactly one task in progress.",
      "Mark work completed only after its checks pass."
    ]
  }
}
```

- `collapseKey` accepts Pi-style key specs, such as `alt+o`, or `"off"` to register no collapse shortcut. Missing, blank or invalid values fall back to `"ctrl+shift+t"`. **Run `/reload` after changing the binding**; the rendered hint may update before the shortcut is rebound.
- `maxWidgetLines` defaults to `12`; a non-number or a number below `3` falls back to `12`, not to `3`. There is no ceiling. It is read on repaint, without requiring a reload.
- `guidance.promptSnippet` must be a non-empty string; `guidance.promptGuidelines` must be a non-empty array of non-empty strings. Valid values replace the corresponding built-in copy; invalid fields fall back to defaults. Run `/reload` after editing guidance.

The suite reads this configuration itself; `@juicesharp/rpiv-config` is not required. `@juicesharp/rpiv-i18n` remains a soft optional integration: UI labels can localize when available, otherwise English labels work without it. Model-facing schema and responses remain English.

## Keyboard ownership and conflicts

**Stock Pi:** Ctrl+T toggles thinking blocks. **Suite default:** Ctrl+Shift+T toggles the todo widget. Installing pi-todo does not relocate any native action.

If you choose `"collapseKey": "ctrl+t"`, first move or disable Pi's `app.thinking.toggle` in `~/.pi/agent/keybindings.json`. Current Pi skips extension shortcuts conflicting with reserved native bindings; the suite does not override them automatically. Choose a free replacement or use `[]`, then `/reload` and inspect `/hotkeys` plus startup diagnostics. A user-bound native action on Ctrl+Shift+T likewise conflicts with the suite default.

[pi-select-nav](/plugins/pi-select-nav/#todo-toggle-in-dialogs) optionally forwards Ctrl+Shift+T and the common Ctrl+T rebind to an eligible registered shortcut while a dialog has focus. It consumes the key only when a handler runs, preserves text-entry/list-navigation safeguards and does not forward arbitrary custom collapse keys. The [optional personal profile](/guides/keyboard/#optional-personal-profile) uses Ctrl+T for todos and explicitly relocates native thinking; that profile is not required for the plugin.

## Persistence and boundaries

Each tool result includes the complete task snapshot and next id in `details`. On session start/resume, reload, compaction and session-tree changes, the last matching `todo` result on the active branch rebuilds the list. Pi's session storage supplies persistence; there is no separate todo database or task-file write. Existing upstream session snapshots remain replayable because the tool identity and details format stay unchanged.

State is partitioned by session id. A detached or child session cannot overwrite or repaint the foreground session's checklist, and its shutdown does not dispose that widget. Compaction and branch replay preserve logical task state, not running subprocesses or a guarantee of restoring UI collapse state.

The [component tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-todo) cover reducer/dependency behavior, session replay and isolation, shortcut and widget rendering paths. They are not a live-terminal compatibility matrix. If the widget is missing, check that tasks are visible, this entry is selected, no upstream duplicate is loaded and the collapse key is free; `/todos` is the unbudgeted view.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-todo)
