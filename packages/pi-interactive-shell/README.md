# pi-interactive-shell

Run a command you explicitly submit with `!i <command>` in a focused terminal overlay inside Pi. The compact panel occupies the lower half, keeping the conversation visible without clearing the screen or stopping Pi's TUI. Both compact and expanded views leave the footer visible, adjusting to its height and terminal resizes. No command auto-detection and no agent-callable tool.

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

Interact directly with the command in the focused overlay. When it exits, its output stays visible until you press Enter or Esc to dismiss the panel. Plain `!<command>` retains Pi's normal behavior, even for editors and other interactive programs. Only the explicit `!i` prefix selects the panel. `!!i <command>` uses the same panel with Pi's normal `!!` exclusion from model context.

With optional [pi-next-prompt](https://pi-plugins.vercel.app/plugins/pi-next-prompt/), a capability probe lets it suggest an explicit `!i <command>` next step. Next-prompt owns all suggestion UI and acceptance behavior: press Tab to copy the ghost into the editor, review or edit it, then press Enter yourself. Accepting never executes it. Neither component requires the other, and neither imports the sibling to integrate.

## Keys

While the command runs, program keys including Tab, Esc, Ctrl+C and Ctrl+D go to the program, not Pi. Panel controls use a **Ctrl+] prefix**, followed by:

| Key after Ctrl+] | Action |
| --- | --- |
| `f` | Toggle compact (lower half) / expanded view |
| `q` | Confirm stopping the command and closing the panel |
| `u` / `d` | Scroll up / down half a page |
| `g` / `G` | Scroll to top / end |
| Ctrl+] | Send a literal Ctrl+] to the program |

After command exit, Enter or Esc dismisses the retained output. Closing/teardown stops the process group with escalation when needed and disposes the terminal emulation.

## Execution and limits

- Requires a real terminal TUI and an idle session. RPC, print/headless modes and a busy agent cannot open the panel.
- Runs a foreground command through the user's `$SHELL` (fallback `/bin/sh`) with `-c`, the session working directory and a pseudoterminal. Commands retain your ordinary OS permissions.
- Pi's event processing and background monitoring can continue, and existing background OS processes keep running. New agent requests are gated until the panel closes, including while exited output is retained.
- Keyboard-first VT terminal support, not universal mouse, graphics or remote/phone-client support. There is no OSC 52/clipboard passthrough.
- There is no detach, multiple-terminal management, background-job adoption, agent tool or automatic agent continuation. Close the panel and send another prompt if you want the agent to continue.
- [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/) is unchanged: use it for logged jobs and services rather than direct terminal interaction.

## History, privacy and cost

Only the submitted command and completion/error status enter session history; the result is status-only, not captured terminal output or interactive keystrokes. The terminal screen and up to 1,000 scrollback lines remain in memory while the panel is open and are discarded on close. The extension does not write them to tool results, session history, model context or its own debug logs. The `!!i` form excludes the command/result from model context; it is not deletion from session history.

`!i` is an explicitly human-submitted shell command, not an agent tool call. pi-tool-gate's tool-call approvals do not apply; review the command before pressing Enter.

This is not a secret-entry guarantee. Commands may echo secrets, and terminals, multiplexers, Pi screen-capture diagnostics (such as `PI_TUI_WRITE_LOG`) or external recorders may record displayed output. External input recorders may also capture keystrokes. Do not put secrets in the command itself if you do not want them in history. Commands can write files or access the network.

The extension makes no model or classifier calls of its own. The invoked command and optional next-prompt features have their own requirements and costs. There are no plugin-specific settings or auto-detection lists.

## License and provenance

MIT. Adapted from Pi's shipped `examples/extensions/interactive-shell.ts` by Mario Zechner / earendil-works. See [LICENSE](./LICENSE) for the retained MIT notice.
