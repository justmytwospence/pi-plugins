---
title: Interactive shell
description: Explicitly hand an idle Pi terminal to a foreground command, then return to the editor when it exits.
plugin: pi-interactive-shell
---

## Quick reference

- **Use it for:** Run a command you need to interact with directly in Pi's terminal.
- **Enable:** Select `packages/pi-interactive-shell/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Submit `!i <command>` yourself; `!!i <command>` also excludes it from model context. No automatic command detection.
- **Settings:** No plugin-specific settings; uses `$SHELL` (fallback `/bin/sh`) and the session working directory.
- **Requirements, cost & privacy:** Real, idle terminal TUI; no model/classifier calls of its own. History contains the command and status, not captured output or interactive keystrokes; terminal recording remains possible.
- **Integrations & limits:** Optional next-prompt capability probe; next-prompt owns suggestions. Foreground only: no agent tool, attach/detach, background-job adoption or automatic agent continuation. pi-bg is unchanged.

## Enable and use

Use [Install & select](/guides/install/) to enable `packages/pi-interactive-shell/src/index.ts`. Components are independently selectable and share one suite Git pin. Neither [pi-next-prompt](/plugins/pi-next-prompt/) nor [pi-bg](/plugins/pi-bg/) is required.

At an idle Pi terminal prompt, explicitly submit a command such as:

```text
!i git add -p
```

Pi stops its TUI and hands the terminal to the command. Interact with it directly, then exit normally; Pi restores its terminal UI when the command exits. To continue the conversation, send another prompt yourself. Exiting the command does not automatically resume the agent.

Only `!i <command>` selects this path. Plain `!<command>` retains Pi's normal behavior, including for programs that happen to need a terminal. There is no auto-detection, allowlist or interactive-command environment configuration. Do not load Pi's shipped interactive-shell example alongside this component: it handles the same user shell input and has different auto-detection behavior.

`!!i <command>` performs the same handoff with Pi's normal `!!` exclusion from model context. Exclusion does not erase the command or status from session history.

## Optional next-prompt suggestion

When [pi-next-prompt](/plugins/pi-next-prompt/) is enabled, it can probe for interactive-shell capability and suggest an explicit `!i <command>` next step. Without that capability, it must not assume this handoff is available. There is no dependency requirement in either direction.

Next-prompt owns the ghost text, acceptance keys and suggestion lifecycle. Press Tab to copy a suggestion into the editor, review or edit the command, then press Enter yourself. Tab never executes the command, and a model-authored suggestion is not authorization. The interactive-shell component adds no separate suggestion UI.

## Foreground execution, not a background task

The foreground command runs through your `$SHELL` (or `/bin/sh` when unset), with `-c`, the session working directory and inherited stdin, stdout and stderr. It has your normal OS permissions. The invoked program must be available in your environment.

Only a real terminal TUI in an idle session can hand off the terminal. RPC clients, print/headless modes and a busy agent cannot use this path. While the foreground command runs, Pi's event processing and background monitoring can continue, and existing background OS processes keep running. **The terminal remains occupied and Pi's TUI stays suspended until the command exits.** No agent run starts during the handoff.

This component provides no model-callable tool, attach/detach or adoption of existing background jobs. [pi-bg](/plugins/pi-bg/) remains unchanged and owns its existing logged jobs, services and waiting behavior. Choose it when the agent needs captured output or asynchronous progress; choose `!i` when you need direct interaction. See [Background work & subagents](/recipes/background-work/).

## History and privacy

Only the command and completion/error status enter Pi's history for this handoff. Command output and interactive keystrokes are not captured into the conversation. The normal `!i` command/status can therefore reach later model context; use `!!i` for Pi's context exclusion, not as a history-deletion mechanism.

`!i` is an explicitly human-submitted shell command, not an agent tool call. [pi-tool-gate](/plugins/pi-tool-gate/)'s tool-call approvals do not apply; review the command before pressing Enter.

There is **no guarantee against terminal recording or commands echoing secrets**. Terminal scrollback, multiplexers and external recorders may retain screen contents or keystrokes, and the invoked command can write its own files or contact external services. Avoid secrets in the submitted command itself: that text is recorded.

The extension makes no model or classifier requests. Optional next-prompt behavior and the invoked command have their own costs and data handling; this terminal handoff is not a sandbox or a redaction system.

## Source and license

[Suite source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-interactive-shell). Adapted from Pi's shipped `examples/extensions/interactive-shell.ts`, MIT by Mario Zechner / earendil-works, with its MIT notice retained in the component's `LICENSE`. Unlike the shipped example, this component requires an explicit prefix and does not auto-detect commands.
