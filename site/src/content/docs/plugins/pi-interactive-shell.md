---
title: Interactive shell
description: Run an explicitly submitted command in a focused terminal overlay while keeping Pi's conversation visible.
plugin: pi-interactive-shell
---

## Quick reference

- **Use it for:** Run a command you need to interact with directly in Pi's embedded terminal panel.
- **Enable:** Select `packages/pi-interactive-shell/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Submit `!i <command>` yourself; `!!i <command>` also excludes it from model context. Ctrl+] prefixes panel controls; program keys otherwise reach the command.
- **Settings:** No plugin-specific settings; uses `$SHELL` (fallback `/bin/sh`) and the session working directory.
- **Requirements, cost & privacy:** Real, idle terminal TUI; native PTY dependencies; no model/classifier calls of its own. Session history contains the command and status, not terminal output or interactive keystrokes; external recording remains possible.
- **Integrations & limits:** Optional next-prompt capability probe; exact, submitted model suggestions can close the panel and resume the agent with status only. No agent tool, detach, multiple terminals or background-job adoption. pi-bg is unchanged.

## Enable and requirements

Use [Install & select](/guides/install/) to enable `packages/pi-interactive-shell/src/index.ts`. Components are independently selectable and share one suite Git pin. Neither [pi-next-prompt](/plugins/pi-next-prompt/) nor [pi-bg](/plugins/pi-bg/) is required; optional integrations do not import sibling components.

The panel uses `node-pty` 1.1.0 and `@xterm/headless` 6.0.0. The native PTY runtime loads lazily when a command starts, not when the optional component is merely registered. Linux native compilation may require `make`, `g++` and Python. On macOS, the published `node-pty` spawn-helper requires executable permission, fixed by the package's reviewed postinstall script.

Only a real terminal TUI in an idle session can open the panel. RPC clients, print/headless modes and a busy agent cannot use this path. Support is keyboard-first VT terminal interaction, not a promise of universal mouse, graphics or remote/phone-client compatibility. There is no OSC 52/clipboard passthrough.

## Open and close a panel

At an idle Pi terminal prompt, explicitly submit a command such as:

```text
!i git add -p
```

Pi opens a focused overlay in the lower half of the terminal, keeping the conversation visible. It does not clear the screen or stop Pi's TUI. Interact directly with the command, then exit normally. For manually submitted commands, **exited output stays in the panel until Enter or Esc dismisses it**. Close the panel and send another prompt to continue; these commands do not automatically resume the agent. The exact suggested handoff described below is an exception.

Only `!i <command>` selects this path. Plain `!<command>` retains Pi's normal behavior, including for programs that happen to need a terminal. There is no auto-detection, allowlist or interactive-command environment configuration. Do not load Pi's shipped interactive-shell example alongside this component: it handles the same user shell input and has different auto-detection behavior.

`!!i <command>` opens the same panel with Pi's normal `!!` exclusion from model context. Exclusion does not erase the command or status from session history.

## Program keys and panel controls

While the command runs, keys including Tab, Esc, Ctrl+C and Ctrl+D go to the program. Esc does not close a running panel, and Ctrl+C is sent to the program rather than handled as Pi's abort key.

To control the panel, press **Ctrl+]**, then one of:

| Key after Ctrl+] | Action |
| --- | --- |
| `f` | Toggle compact (lower half) / expanded view |
| `q` | Confirm stopping the command and closing the panel |
| `u` / `d` | Scroll up / down half a page |
| `g` / `G` | Scroll to top / end |
| Ctrl+] | Send a literal Ctrl+] to the program |

For manual panels, Enter or Esc dismisses retained output after command exit. Closing or tearing down the panel stops its process group, escalates termination when needed and disposes the terminal emulation.

## Optional next-prompt suggestion

When [pi-next-prompt](/plugins/pi-next-prompt/) is enabled, it can probe for interactive-shell capability and suggest an explicit `!i <command>` next step. Without that capability, it must not assume the panel is available. There is no dependency requirement in either direction.

Next-prompt owns the ghost text, acceptance keys and suggestion lifecycle. Press Tab or Right to copy a suggestion into the editor, review it, then press Enter yourself. Acceptance never executes the command, and a model-authored suggestion is not authorization. If you submit a model-suggested `!i` draft exactly unchanged, the panel closes automatically on success, failure or cancellation, and the agent continues automatically using only the recorded status. Terminal output and keystrokes remain private and are discarded on close. Manual, edited, externally offered and `!!i` commands retain manual panels and do not automatically resume the agent. The interactive-shell component adds no separate suggestion UI.

## Foreground execution, not a background task

The foreground command runs through your `$SHELL` (or `/bin/sh` when unset), with `-c`, the session working directory and a pseudoterminal. It has your normal OS permissions. The invoked program must be available in your environment.

Pi's event processing and background monitoring can continue, and existing background OS processes keep running. **New agent requests are gated until the panel closes**, including while an exited command's output remains on screen.

This component provides no model-callable tool, detach, multiple terminals or adoption of existing background jobs. [pi-bg](/plugins/pi-bg/) remains unchanged and owns its existing logged jobs, services and waiting behavior. Choose it when the agent needs captured output or asynchronous progress; choose `!i` when you need direct interaction. See [Background work & subagents](/recipes/background-work/).

## History and privacy

Only the submitted command and completion/error status enter Pi's session history; the result is status-only. Terminal output and interactive keystrokes are not captured into the conversation. The terminal screen and up to 1,000 scrollback lines remain in memory only while the panel is open and are discarded on close; the extension does not write them to tool results, session history, model context or its own debug logs. The normal `!i` command/status can reach later model context; use `!!i` for Pi's context exclusion, not as a history-deletion mechanism.

`!i` is an explicitly human-submitted shell command, not an agent tool call. [pi-tool-gate](/plugins/pi-tool-gate/)'s tool-call approvals do not apply; review the command before pressing Enter.

There is **no guarantee against external terminal recording or commands echoing secrets**. Terminal scrollback, multiplexers, Pi screen-capture diagnostics (such as `PI_TUI_WRITE_LOG`) and external recorders may retain displayed output; external input recorders may also capture keystrokes, and the invoked command can write its own files or contact external services. Avoid secrets in the submitted command itself: that text is recorded.

The extension makes no model or classifier requests. Optional next-prompt behavior and the invoked command have their own costs and data handling; this panel is not a sandbox or a redaction system.

## Source and license

[Suite source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-interactive-shell). Adapted from Pi's shipped `examples/extensions/interactive-shell.ts`, MIT by Mario Zechner / earendil-works, with its MIT notice retained in the component's `LICENSE`. Unlike the shipped example, this component requires an explicit prefix and does not auto-detect commands.
