---
title: pi-herdr-scrollbar-width
description: Correct the one-column Herdr scrollbar width change when Pi prints its fullscreen exit transcript.
plugin: pi-herdr-scrollbar-width
---

## Quick reference

- **Use it for:** Fix one-column wrapping when Pi leaves fullscreen inside a Herdr pane with scrollbars.
- **Enable:** Select `packages/pi-herdr-scrollbar-width/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Automatic; no command, tool or shortcut.
- **Settings:** No plugin settings. Reads `HERDR_CONFIG_PATH` or `~/.config/herdr/config.toml`; explicit `pane_scrollbars = false` disables.
- **Requirements, cost & privacy:** `HERDR_ENV=1`, TTY stdout and enabled pane scrollbars. No credentials, network, inference or CLI helper; reads local Herdr config.
- **Integrations & limits:** No pi-herdr dependency. Exit-transition fix only; process-wide stdout wrapper needs a fresh restart to remove.

## Purpose and selection

This entry addresses a specific display problem: Pi looks correctly sized while running fullscreen inside Herdr, but its transcript wraps unexpectedly when Pi exits fullscreen. The cause described by the package is a one-column difference between Herdr's alternate screen and main screen when pane scrollbars are enabled. The scrollbar gutter is reserved on the main screen, not the alternate screen.

Pi leaves the alternate screen and immediately prints its transcript using the terminal width it last knew. Herdr's subsequent resize notification arrives too late for that output. A line that filled the alternate screen is then one column too wide for the main screen and wraps. The extension corrects Pi's recorded stdout width at the transition, before the exit transcript is rendered.

Entry: `packages/pi-herdr-scrollbar-width/src/index.ts`.

Select it through [Install & select](/guides/install/). The suite loads every entry by default, with one Git pin shared by every selected component. This feature has no separate installation requirement beyond selecting its suite entry.

Use it for the fullscreen-exit symptom, not as a general text-wrapping preference. It does not set a prose measure, alter Markdown parsing, or remove a scrollbar. If wrapping is already wrong during normal fullscreen use, or differs by more than the single reserved column, the described workaround may not address the underlying problem.

## Requirements and activation

The implementation activates only when **`HERDR_ENV=1`**, stdout is a TTY, and its scrollbar check considers pane scrollbars enabled. It does nothing outside that environment or when output is redirected to a non-TTY destination. Herdr is the relevant external application, but the extension does not spawn its CLI, require a Herdr API client, or depend on the separate `pi-herdr` suite entry.

There are no credentials, model calls, classifier requests, or paid service costs associated with this extension. Its operations are local: read one configuration file and wrap writes to the existing stdout stream. It does not add a background process. No additional platform executable is used for the width correction.

The meaningful limitation is Herdr's screen-width behavior, not an explicit operating-system allowlist. The implementation checks environment and stream properties rather than claiming that all terminal or operating-system combinations have been validated. A terminal multiplexer with a superficially similar symptom is not automatically supported; the guard specifically requires the Herdr environment value.

The code also avoids reducing widths of four columns or fewer, matching the documented Herdr behavior for very narrow panes. This is a conditional workaround, not an unconditional subtraction from every rendered line. Do not set `HERDR_ENV` manually outside Herdr just to force activation: that would assert the very screen-width behavior the adjustment depends on, without evidence that the host actually has it.

## Configuration and transition behavior

There is no slash command, shortcut, model-callable tool, or plugin JSON settings file. The extension reads Herdr configuration from `HERDR_CONFIG_PATH` when that variable is nonempty; otherwise it uses `~/.config/herdr/config.toml`. This is the configuration on the host where the Pi process and pane run, which matters when the Herdr client is attached from another machine.

The disabling setting belongs to Herdr:

```toml
[ui]
pane_scrollbars = false
```

The extension's reader is deliberately narrow: it searches the file for a line assigning `pane_scrollbars = false`. It is not a full TOML parser and does not validate section membership or query effective server state. An unreadable or missing file is treated as scrollbars enabled. Configuration is checked when the extension factory runs, not continuously watched for changes.

Once active, it wraps `process.stdout.write`. For string chunks containing alternate-screen control sequences, it determines whether the last transition is entry or exit. On a transition out of the alternate screen, it subtracts one column when the previous state was alternate and the width exceeds four. The internal state starts as alternate because Pi may already have entered fullscreen before extensions load.

Re-entering the alternate screen does not add a column directly; Herdr's normal resize path handles the wider screen. A process-wide symbol prevents duplicate wrapping. Because that wrapper is not dynamically uninstalled, use a fresh Pi process when testing changed activation settings or disabling the entry rather than relying on a reload to restore stdout.

## Interactions and troubleshooting

First verify the shape of the failure. The intended case has correct fullscreen output followed by extra wrapping in the transcript printed after leaving the alternate screen. Confirm that the pane actually runs under Herdr, that stdout remains a TTY, and that the configuration file read by Pi corresponds to the server-side pane host. A client-side configuration file elsewhere is not inspected.

If you disabled pane scrollbars but still see the adjustment, inspect `HERDR_CONFIG_PATH`, file readability, and whether Pi was restarted after the change. The parser recognizes the unqualified `pane_scrollbars = false` line shown above; alternative configuration representations or runtime server overrides are not proven equivalent by this code. Missing configuration does not disable the workaround, because the reader assumes the default enabled state.

If the extension appears inactive despite satisfying those conditions, note that it recognizes complete alternate-screen sequences inside string writes. It does not implement a general streaming escape parser for split sequences or Buffer chunks. Future changes in Pi's output path or Herdr's gutter handling therefore require a fresh compatibility check. The package's development check is typechecking, not a terminal-emulation test suite.

`pi-prose-width` is separate: it narrows prose while allowing code and tables their available width. `pi-clear-screen` changes the fullscreen viewport without changing retained history. Neither is required by this entry, and neither replaces its exit-transition correction. When reporting an interaction, include whether the problem occurs inside fullscreen, at exit, or both, along with the effective scrollbar configuration and the Pi and Herdr versions.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-herdr-scrollbar-width)
