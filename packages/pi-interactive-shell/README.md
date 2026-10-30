# pi-interactive-shell

Run a command you explicitly submit with `!i <command>` in a focused inline terminal in Pi's chat. The live panel is roughly half the terminal height and stays in the transcript's flow, not over the conversation. On exit, a static head-and-tail snapshot remains in chat and focus returns immediately to the editor. No command auto-detection and no agent-callable tool.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-interactive-shell/>.

## Enable

Install the suite and select `packages/pi-interactive-shell/src/index.ts` with `pi config`, then `/reload`. Every component can be enabled independently; one Git ref versions the suite. See [Install & select](https://pi-plugins.vercel.app/guides/install/).

To try just this component from a suite checkout:

```sh
pi -ne -e ./packages/pi-interactive-shell
```

The terminal uses `node-pty` 1.1.0 and `@xterm/headless` 6.0.0. The native PTY runtime loads lazily when a command starts. Native compilation on Linux may require `make`, `g++` and Python. On macOS, the published `node-pty` spawn-helper needs executable permission; the package's reviewed postinstall script fixes that permission.

Do not also load Pi's shipped interactive-shell example: it intercepts the same user shell commands and includes auto-detection that this component deliberately omits.

## Use

At an idle Pi terminal prompt, type and submit, for example:

```text
!i git add -p
```

Interact directly with the command in the focused inline panel. While it runs, the terminal temporarily replaces the editor's input handling; Pi restores the editor text and focus on completion. Every inline command returns focus immediately on exit, without Enter or Esc. Its static final frame remains in chat; it is not an independently scrollable terminal. Plain `!<command>` retains Pi's normal behavior, even for editors and other interactive programs. Only the explicit `!i` prefix selects the panel. `!!i <command>` uses the same panel with Pi's normal `!!` exclusion from model context.

With optional [pi-next-prompt](https://pi-plugins.vercel.app/plugins/pi-next-prompt/), the model can call `offer_terminal` with a complete raw shell command to display an editable `!i <command>` next step. The tool never executes it. Its `displayed` result acknowledges that the ghost or widget was included in Pi's component output, not that you saw or accepted it. An offer can be visible while the agent is busy, but acceptance waits until the response finishes successfully. Next-prompt owns the suggestion UI: press Tab or Right to copy it into the editor, review it, then press Enter yourself. Acceptance never executes it. If you submit an accepted model-suggested `!i` draft exactly unchanged, the agent continues automatically after success, failure or cancellation using only the recorded status, never terminal output or keystrokes. Manual, edited, externally offered and `!!i` commands also return editor focus immediately in inline mode, but do not automatically resume the agent: send another prompt to continue. Neither component requires the other, and neither imports the sibling to integrate.

## Keys

While the command runs, program keys including Tab, Esc, Ctrl+C and Ctrl+D go to the program, not Pi. Panel controls use a **Ctrl+] prefix**, followed by:

| Key after Ctrl+] | Action |
| --- | --- |
| `f` | Toggle half-height / expanded inline view |
| `q` | Confirm stopping the command and closing the panel |
| `u` / `d` | Scroll up / down half a page |
| `g` / `G` | Scroll to top / end |
| Ctrl+] | Send a literal Ctrl+] to the program |

Scrolling controls apply only while the command runs. The final snapshot shows the earliest and latest retained buffer rows, separated by `… N rows omitted …` when needed. These are screen rows, including blanks, not logical lines. The head is the earliest row still available in xterm's bounded 1,000-line scrollback, not necessarily the command's original beginning. Very short panels show only the bottom viewport. Use Pi's normal transcript navigation to revisit snapshots; the live panel is not pinned and does not force-scroll your view.

In fullscreen mode, wheel/trackpad scrolling inside the live panel scrolls terminal rows, including at the scrollback bounds, rather than the outer chat. In regular mode use the keyboard controls above; the terminal emulator owns wheel events. Wheel events are not forwarded to the child program. Retained snapshots remain static in both modes.

The terminal is **inline-only**. If Pi's private transcript layout is not recognized, it returns `inline terminal unavailable: <reason>; command was not run` before starting a process. There is no overlay fallback and no automatic agent continuation for this failure. Run `/interactive-shell status` to inspect availability, renderer mode, inline/unsupported layout, lookup source or reason, bounded layout diagnostics and the most recent actual handoff path. Inspection starts no process; layout diagnostics contain component names/counts, not document text, commands, output or editor drafts. Closing/teardown stops a running process group with escalation when needed and disposes the terminal emulation.

## Execution and limits

- Requires a real terminal TUI and an idle session. RPC, print/headless modes and a busy agent cannot open the panel.
- Runs a foreground command through the user's `$SHELL` (fallback `/bin/sh`) with `-c`, the session working directory and a pseudoterminal. Commands retain your ordinary OS permissions.
- Pi's event processing and background monitoring can continue, and existing background OS processes keep running. New agent requests are gated until the live handoff finishes. A retained inline snapshot does not block requests.
- Keyboard-first VT terminal support with live fullscreen wheel scrolling, not universal mouse, graphics or remote/phone-client support. There is no OSC 52/clipboard passthrough.
- There is no detach, multiple-terminal management, background-job adoption or agent tool. After a manual inline command finishes, send another prompt if you want the agent to continue.
- [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/) is unchanged: use it for logged jobs and services rather than direct terminal interaction.

## History, privacy and cost

Only the submitted command and completion/error status enter session history; the result is status-only, not captured terminal output or interactive keystrokes. The live screen and up to 1,000 scrollback lines are memory-only. After exit, only the bounded static snapshot remains in process memory; it can contain sensitive displayed text. A transcript clear/rebuild, reload, session switch or exit can remove it: this is not durable history. The extension does not write terminal output or keystrokes to tool results, session history, model context or its own debug logs. The `!!i` form excludes the command/result from model context; it is not deletion from session history.

`!i` is an explicitly human-submitted shell command, not an agent tool call. pi-tool-gate's tool-call approvals do not apply; review the command before pressing Enter.

This is not a secret-entry guarantee. Commands may echo secrets, and terminals, multiplexers, Pi screen-capture diagnostics (such as `PI_TUI_WRITE_LOG`) or external recorders may record displayed output. External input recorders may also capture keystrokes. Do not put secrets in the command itself if you do not want them in history. Commands can write files or access the network.

The extension makes no model or classifier calls of its own. The invoked command and optional next-prompt features have their own requirements and costs. There are no plugin-specific settings or auto-detection lists.

## License and provenance

MIT. Adapted from Pi's shipped `examples/extensions/interactive-shell.ts` by Mario Zechner / earendil-works. See [LICENSE](./LICENSE) for the retained MIT notice.
