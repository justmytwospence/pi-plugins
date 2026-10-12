---
title: pi-appearance-resync
description: Retry terminal appearance reports so Pi can recover from delayed background-color updates.
plugin: pi-appearance-resync
---

## Purpose and selection

Use this extension when Pi's automatic light/dark theme appears to lag behind the terminal's appearance. The characteristic symptom is a reversal: after switching the system to dark, Pi still looks light; after switching back, Pi looks dark. This can happen when a multiplexer forwards an appearance notification before it has obtained the terminal's updated colors. Pi receives the notification, asks for colors immediately, and gets the previous background.

The extension gives Pi several later opportunities to query those colors. It does not choose a palette, replace your theme, or inspect the operating system's appearance preference. The terminal remains the source of appearance information. If the initial color response was already correct, subsequent queries should find the same background rather than introduce another theme choice.

Entry: `packages/pi-appearance-resync/src/index.ts`.

Follow [Install & select](/guides/install/) to select this entry from the suite. The suite loads every entry by default; selected entries share one Git pin, rather than separate component versions.

The package README identifies the notification-ordering problem in Herdr 0.9.3. That is the documented motivating case, not a claim that every later Herdr version needs this workaround or that every other multiplexer has been tested. The extension itself does not require a Herdr environment flag.

## Requirements and costs

This is a local terminal-UI adjustment. It makes no model or classifier requests, needs no API credentials, and has no paid service requirement. There is no external executable to install for the extension itself. Its work consists of listening for appearance reports and scheduling delayed replays inside the running Pi process.

For the intended automatic switching behavior, configure Pi to use its `light/dark` theme setting. Merge this field into your Pi settings rather than replacing unrelated configuration:

```json
{
  "theme": "light/dark"
}
```

The terminal and any multiplexer between it and Pi must deliver appearance reports. The relevant protocol is mode 2031, with light/dark reports encoded as `CSI ? 997 ; n`. The extension cannot manufacture a missing notification from an operating-system event, nor can it repair a multiplexer that never forwards the reports. A fixed theme is not made automatic merely by enabling this entry.

There is also a Pi compatibility requirement beyond ordinary extension loading. The implementation obtains the live TUI through an invisible widget and checks for both `onTerminalColorSchemeChange` and `consumeTerminalColorSchemeReport`. These are outside the public extension API. If either hook is absent, the extension does nothing instead of throwing. No blanket operating-system or terminal compatibility matrix is established by the package tests; protocol delivery and those TUI hooks are the meaningful requirements.

## Timing and diagnostics

There are no slash commands, keyboard shortcuts, model-callable tools, or persistent plugin settings. After receiving a real appearance report, the extension schedules replays at **250 milliseconds, one second, and three seconds**. These are delays measured from that report, not three successive waiting periods. Each replay passes the same light/dark report back into Pi's color-report consumer so Pi can query the terminal again.

A newer appearance report cancels the old report's pending replays. This matters when you switch appearance repeatedly: an earlier light notification must not keep replaying after a newer dark notification arrives. The implementation also ignores callbacks caused by its own replays, avoiding an unbounded cycle of timers. When the widget is disposed, its listener is removed and pending replays are canceled.

For diagnostics, set `PI_APPEARANCE_RESYNC_LOG` to a writable file path before starting Pi. For example:

```sh
PI_APPEARANCE_RESYNC_LOG=/tmp/pi-appearance-resync.log pi
```

Log lines contain a timestamp, process ID, and a message such as `listening`, `report dark`, or `replay dark after 250 ms`. Missing hooks produce a diagnostic saying that the color-scheme hooks are unavailable. Logging is best effort: append failures are silently ignored, and the extension does not create a missing parent directory. Therefore, an empty log is not by itself proof that no appearance reports arrived. First check that the path is writable and that the environment variable reached Pi.

## Interactions and troubleshooting

Distinguish three failure cases before changing themes. If the log never reaches `listening`, check that the selected suite entry is enabled and that the running Pi exposes the required hooks. If it reaches `listening` but records no reports when appearance changes, investigate terminal or multiplexer forwarding. If reports and all three replays appear but colors remain wrong, the terminal's color responses or Pi's theme configuration need investigation; this extension only retries the existing mechanism.

For the documented Herdr case where forwarding has stopped entirely, the package README suggests detaching and reattaching the client. A replay cannot help until an initial report arrives. This is different from the delayed-colors case, where reports arrive normally but the first response is stale. Do not treat repeated reloads as a substitute for diagnosing which path is failing.

The extension installs a widget below the editor that renders no lines. It does not replace the footer, modify message text, or reserve a visible status area. Its role is separate from `pi-herdr-scrollbar-width`, which addresses transcript width when leaving the alternate screen. Enabling one is not a prerequisite for the other.

Unit tests cover replay timing, cancellation, recursion prevention, cleanup, and hook detection using stand-ins. They do not establish live behavior across terminal and multiplexer versions. When reporting a problem, include Pi, terminal, and multiplexer versions alongside the diagnostic sequence, rather than assuming a tested terminal combination.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-appearance-resync)
