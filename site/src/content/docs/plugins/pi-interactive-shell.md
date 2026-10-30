---
title: Interactive shell
description: Run an explicitly submitted command inline in Pi's chat and retain a memory-only static snapshot.
plugin: pi-interactive-shell
---

## Quick reference

- **Use it for:** Run a command you need to interact with directly in Pi's embedded terminal panel.
- **Enable:** Select `packages/pi-interactive-shell/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Submit `!i <command>` yourself; `!!i <command>` also excludes it from model context. Ctrl+] prefixes panel controls; fullscreen supports live wheel scrolling. `/interactive-shell status` inspects availability without running a command.
- **Settings:** No plugin-specific settings; uses `$SHELL` (fallback `/bin/sh`) and the session working directory.
- **Requirements, cost & privacy:** Real, idle terminal TUI; native PTY dependencies; no model/classifier calls of its own. Session history contains the command and status, not terminal output or interactive keystrokes; external recording remains possible.
- **Integrations & limits:** Optional next-prompt capability probe; exact, accepted and submitted model suggestions resume the agent with status only; manual commands return focus without resuming. No agent tool, detach, multiple terminals or background-job adoption. pi-bg is unchanged.

## Enable and requirements

Use [Install & select](/guides/install/) to enable `packages/pi-interactive-shell/src/index.ts`. Components are independently selectable and share one suite Git pin. Neither [pi-next-prompt](/plugins/pi-next-prompt/) nor [pi-bg](/plugins/pi-bg/) is required; optional integrations do not import sibling components.

The panel uses `node-pty` 1.1.0 and `@xterm/headless` 6.0.0. The native PTY runtime loads lazily when a command starts, not when the optional component is merely registered. Linux native compilation may require `make`, `g++` and Python. On macOS, the published `node-pty` spawn-helper requires executable permission, fixed by the package's reviewed postinstall script.

Only a real terminal TUI in an idle session can open the panel. RPC clients, print/headless modes and a busy agent cannot use this path. Support is keyboard-first VT terminal interaction, not a promise of universal mouse, graphics or remote/phone-client compatibility. There is no OSC 52/clipboard passthrough.

## Open and close a panel

At an idle Pi terminal prompt, explicitly submit a command such as:

```text
!i git add -p
```

Pi opens a focused inline terminal in the chat transcript, roughly half the terminal height. It is in the conversation's flow, not an overlay or a panel pinned to the viewport, and does not force-scroll your view. The handoff temporarily replaces the editor while the command runs. On exit, Pi restores the editor text and focus immediately for **every inline command**, leaving a static final frame in chat. No Enter or Esc dismissal is needed. Manual commands do not automatically resume the agent; send another prompt to continue.

The snapshot shows the earliest and latest retained buffer rows with a dim, centered `N rows omitted` divider between them when needed. The divider is UI, not program output. The count includes blank screen rows, not logical lines. The head is the earliest row still in xterm's bounded 1,000-line scrollback, not necessarily the command's original beginning. The exited frame shrinks to occupied output rows instead of retaining unprinted viewport padding; meaningful interior blanks, explicit spaces and styled cells remain. With no omission, or a very short preview, it shows the last occupied rows. This frame has no independent scrolling or input; use Pi's normal transcript navigation to revisit it.

Inline insertion uses a guarded lookup of Pi's private transcript layout. It is **inline-only**: if the layout is not recognized, the result is `inline terminal unavailable: <reason>; command was not run`. No process starts, no overlay substitutes for the panel, and this failure does not automatically continue the agent.

Use `/interactive-shell status` to inspect availability, renderer mode, inline/unsupported layout, lookup source or reason, bounded layout diagnostics and the most recent actual handoff path. Inspection starts no process. Layout diagnostics contain component names/counts and lookup metadata, never document text, commands, terminal output or editor drafts.

Only `!i <command>` selects this path. Plain `!<command>` retains Pi's normal behavior, including for programs that happen to need a terminal. There is no auto-detection, allowlist or interactive-command environment configuration. Do not load Pi's shipped interactive-shell example alongside this component: it handles the same user shell input and has different auto-detection behavior.

`!!i <command>` opens the same panel with Pi's normal `!!` exclusion from model context. Exclusion does not erase the command or status from session history.

## Program keys and panel controls

While the command runs, keys including Tab, Esc, Ctrl+C and Ctrl+D go to the program. Esc does not close a running panel, and Ctrl+C is sent to the program rather than handled as Pi's abort key.

To control the panel, press **Ctrl+]**, then one of:

| Key after Ctrl+] | Action |
| --- | --- |
| `f` | Toggle half-height / expanded inline view |
| `q` | Confirm stopping the command and closing the panel |
| `u` / `d` | Scroll up / down half a page |
| `g` / `G` | Scroll to top / end |
| Ctrl+] | Send a literal Ctrl+] to the program |

Scroll controls work while the command runs, not on the static final frame. In fullscreen mode, wheel/trackpad events inside the live panel scroll its terminal rows rather than the outer chat, even at the scrollback bounds. In regular mode use the keyboard controls; the terminal emulator owns wheel events. Wheel events are never forwarded to the child program. Expanded inline mode remains in transcript flow. Closing or tearing down the panel stops its process group, escalates termination when needed and disposes the terminal emulation.

## Optional next-prompt suggestion

When [pi-next-prompt](/plugins/pi-next-prompt/) is enabled, the model uses `offer_terminal` with a complete raw shell command to offer an editable `!i <command>` next step. The tool checks interactive-shell support and inline layout, and returns a concrete blocker if unavailable. Its `displayed` status acknowledges inclusion in Pi's ghost/widget component output within one second, not that you saw or accepted it. It never runs a command. There is no dependency requirement in either direction.

Next-prompt owns the ghost text, acceptance keys and suggestion lifecycle. An explicit offer can be visible while the agent is busy, but acceptance is disabled until the response finishes successfully; an aborted or failed response clears it. Press Tab or Right to copy a suggestion into the editor, review it, then press Enter yourself. Acceptance never executes the command, and a model-authored suggestion is not authorization. If you submit an accepted model-suggested `!i` draft exactly unchanged, the agent continues automatically on success, failure or cancellation using only the recorded status. It does not receive terminal output or keystrokes, including the retained snapshot. Manual, edited, externally offered and `!!i` commands also return focus immediately in inline mode, but do not automatically resume the agent. The interactive-shell component adds no separate suggestion UI.

## Foreground execution, not a background task

The foreground command runs through your `$SHELL` (or `/bin/sh` when unset), with `-c`, the session working directory and a pseudoterminal. It has your normal OS permissions. The invoked program must be available in your environment.

Pi's event processing and background monitoring can continue, and existing background OS processes keep running. **New agent requests are gated until the live handoff finishes**. A retained inline snapshot does not block requests.

This component provides no model-callable tool, detach, multiple terminals or adoption of existing background jobs. [pi-bg](/plugins/pi-bg/) remains unchanged and owns its existing logged jobs, services and waiting behavior. Choose it when the agent needs captured output or asynchronous progress; choose `!i` when you need direct interaction. See [Background work & subagents](/recipes/background-work/).

## History and privacy

Only the submitted command and completion/error status enter Pi's session history; the result is status-only. Terminal output and interactive keystrokes are not recorded as conversation messages. The live terminal screen and up to 1,000 scrollback lines are memory-only. After exit, the bounded static snapshot remains in process memory and can contain sensitive displayed text. A transcript clear/rebuild, reload, session switch or exit can remove it; it is not durable history. The extension does not write terminal output or keystrokes to tool results, session history, model context or its own debug logs. The normal `!i` command/status can reach later model context; use `!!i` for Pi's context exclusion, not as a history-deletion mechanism.

`!i` is an explicitly human-submitted shell command, not an agent tool call. [pi-tool-gate](/plugins/pi-tool-gate/)'s tool-call approvals do not apply; review the command before pressing Enter.

There is **no guarantee against external terminal recording or commands echoing secrets**. Terminal scrollback, multiplexers, Pi screen-capture diagnostics (such as `PI_TUI_WRITE_LOG`) and external recorders may retain displayed output; external input recorders may also capture keystrokes, and the invoked command can write its own files or contact external services. Avoid secrets in the submitted command itself: that text is recorded.

The extension makes no model or classifier requests. Optional next-prompt behavior and the invoked command have their own costs and data handling; this panel is not a sandbox or a redaction system.

## Source and license

[Suite source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-interactive-shell). Adapted from Pi's shipped `examples/extensions/interactive-shell.ts`, MIT by Mario Zechner / earendil-works, with its MIT notice retained in the component's `LICENSE`. Unlike the shipped example, this component requires an explicit prefix and does not auto-detect commands.
