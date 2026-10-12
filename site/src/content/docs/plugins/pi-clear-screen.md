---
title: pi-clear-screen
description: Clear the fullscreen transcript viewport with Ctrl+L while preserving session history and context.
plugin: pi-clear-screen
---

## Purpose and selection

`pi-clear-screen` makes **Ctrl+L** move the visible transcript out of the way, giving you a fresh area for subsequent output. Use it when a long exchange or a large tool result makes the current view distracting, but you still want to continue the same conversation. Scroll upward to read the earlier content again. This is a presentation operation, not a conversation reset.

Nothing is removed from the session or from the model's context. In particular, clearing the screen does not reduce token usage, redact sensitive text, undo a tool call, or create a new branch. The agent still has the same conversation after you press the shortcut. Choose a context-management operation separately if your goal is to change what the model receives.

Entry: `packages/pi-clear-screen/src/index.ts`.

Use [Install & select](/guides/install/) to enable the entry from the suite. Every suite entry loads by default, and all selected components use one Git pin. You do not need a separate package source for this feature.

The extension provides a keyboard shortcut, not a slash command or model-callable tool. Because nothing is submitted, clearing adds no entry to the prompt history, and the handler does not touch the editor: a half-written draft stays exactly as it was. Its behavior is intentionally close to clearing a shell's visible screen while retaining scrollback, but it operates on Pi's application-owned fullscreen transcript rather than issuing a general terminal scrollback-erasure command.

## Requirements and shortcut setup

The clear action requires Pi's **fullscreen** TUI. Regular mode leaves scrollback under terminal control, so the extension cannot apply the same transcript-layout operation there. Merge the relevant field into your existing Pi settings:

```json
{
  "tuiMode": "fullscreen"
}
```

There are no external executables, API keys, network services, or paid classifier calls involved. The extension performs local layout work inside Pi. It does not depend on Herdr or on another suite component. It is not a screen-clearing service for RPC, JSON, or print-mode clients; its useful surface is the interactive fullscreen terminal interface.

Resolve the shortcut conflict before using it. Pi binds **Ctrl+L** to the model selector (`app.model.select`) by default. At the start of an interactive TUI session, the extension checks Pi's effective bindings and shows a warning while `app.model.select` still includes `ctrl+l`. Move that built-in action elsewhere in `~/.pi/agent/keybindings.json`, merging with your existing bindings, then `/reload`. The warning suggests:

```json
{
  "app.model.select": ["alt+p", "alt+m"]
}
```

On Windows and WSL, Pi's default `app.model.cycleBackward` also uses Alt+P; keep only keys that are free in your setup.

The extension's own shortcut is fixed to `ctrl+l` in source; there is no separate plugin configuration file for changing it. If Ctrl+L opens a model picker rather than clearing the transcript, inspect the effective application bindings first. Also check whether your terminal or multiplexer intercepts the key before Pi sees it. A successful package load alone cannot resolve either kind of input conflict. No operating-system-specific helper is required, but the host's fullscreen layout must match the structures the implementation expects.

## What clearing changes

On each clear, the extension appends an invisible marker to the chat container. Its patched document renderer finds that marker, removes the marker's sentinel line from rendered output, and supplies enough blank rows to place that point at the top of the transcript viewport. It then scrolls the transcript to the end and requests a render. Earlier messages remain above that point.

As new content arrives, the renderer needs fewer blank rows. Eventually the padding disappears entirely. The effect is therefore not a permanent page of empty transcript lines stored between old and new messages. Repeating Ctrl+L removes the previous marker and creates a new one at the current end; it does not accumulate an unlimited series of clear markers in the chat container.

The viewport height comes from the transcript's last frame, with terminal rows and then 24 rows as fallbacks. This explains why the implementation needs access to the fullscreen layout rather than merely knowing the terminal width. It is aligning a position within Pi's transcript viewport, not moving the whole application header or editor off screen.

The marker is ephemeral. `/new`, `/resume`, and `/reload` rebuild the chat and drop it. On session shutdown the extension removes its marker and restores the document renderer it wrapped, unless another extension has since replaced that renderer. When Pi renders the transcript outside the fullscreen layout, including its exit transcript, the renderer removes the sentinel without adding fullscreen padding. Do not use the marker as a durable bookmark or expect a resumed session to preserve the cleared view.

## Interactions and troubleshooting

Two notifications identify different problems. `clear-screen: only fullscreen mode (tuiMode) has a clearable transcript` means the required fullscreen layout is absent. Check the active TUI mode instead of trying to clear repeatedly. `clear-screen: pi's transcript layout changed; extension needs updating` means the extension found a layout but could not locate the expected chat and scroll components. That is a compatibility issue, not a request to delete session data.

The implementation reaches into Pi's transcript containers, which are not a public extension contract. Its checks catch missing expected structures, but they do not establish compatibility with every future layout change. If behavior becomes incorrect after a Pi update, disable this entry and reproduce with the same transcript and fullscreen settings. A reload that removes the marker is expected lifecycle behavior, not evidence that history was lost.

Other rendering features have different jobs. `pi-prose-width` changes Markdown wrapping, while this entry changes which transcript rows are initially visible. `pi-herdr-scrollbar-width` adjusts a Herdr-specific exit width; it is not needed to use Ctrl+L. None of these display adjustments should be treated as session compaction or content redaction.

For an interaction report, record whether Ctrl+L reached Pi, which notification appeared, the active TUI mode, and whether scrolling upward still reveals the earlier transcript. The component's development check runs typechecking and a small [Node test file](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-clear-screen/test/clear.test.mjs) covering renderer release, teardown order and the conflict diagnostic. It does not prove every live fullscreen interaction.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-clear-screen)
