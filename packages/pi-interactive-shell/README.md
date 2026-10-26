# pi-interactive-shell

Hand Pi's terminal to a command you explicitly submit with `!i <command>`, then restore Pi when it exits. No command auto-detection and no agent-callable tool.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-interactive-shell/>.

## Enable

Install the suite and select `packages/pi-interactive-shell/src/index.ts` with `pi config`, then `/reload`. Every component can be enabled independently; one Git ref versions the suite. See [Install & select](https://pi-plugins.vercel.app/guides/install/).

To try just this component from a suite checkout:

```sh
pi -ne -e ./packages/pi-interactive-shell
```

Do not also load Pi's shipped interactive-shell example: it intercepts the same user shell commands and includes auto-detection that this component deliberately omits.

## Use

At an idle Pi terminal prompt, type and submit, for example:

```text
!i git add -p
```

Pi releases the terminal; interact directly with the command and exit it normally to return to Pi. Plain `!<command>` retains Pi's normal behavior, even for editors and other interactive programs. Only the explicit `!i` prefix selects this handoff. `!!i <command>` uses the same handoff with Pi's normal `!!` exclusion from model context.

With optional [pi-next-prompt](https://pi-plugins.vercel.app/plugins/pi-next-prompt/), a capability probe lets it suggest an explicit `!i <command>` next step. Next-prompt owns all suggestion UI and acceptance behavior: press Tab to copy the ghost into the editor, review or edit it, then press Enter yourself. Accepting never executes it. Neither component requires the other.

## Execution and limits

- Requires a real terminal TUI and an idle session. RPC, print/headless modes and a busy agent cannot hand off the terminal.
- Runs a foreground command through the user's `$SHELL` (fallback `/bin/sh`) with `-c`, the session working directory and inherited stdin/stdout/stderr.
- Pi's event processing and background monitoring can continue, and existing background OS processes keep running. The terminal remains occupied and Pi's TUI suspended until the command exits; no agent run starts during the handoff.
- There is no attach/detach, background-job adoption, agent tool or automatic agent continuation. Return to the editor and send another prompt if you want the agent to continue.
- [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/) is unchanged: use it for logged jobs and services rather than interactive terminal ownership.

## History, privacy and cost

Pi records only the command and completion/error status for this handoff, not captured command output or interactive keystrokes. The `!!i` form excludes the command/result from model context; it is not deletion from session history.

`!i` is an explicitly human-submitted shell command, not an agent tool call. pi-tool-gate's tool-call approvals do not apply; review the command before pressing Enter.

This is not a secret-entry guarantee. Commands may echo secrets, and terminals, multiplexers or external recorders may record the screen or keystrokes. Do not put secrets in the command itself if you do not want them in history. Commands retain your ordinary OS permissions and can write files or access the network.

The extension makes no model or classifier calls of its own. The invoked command and optional next-prompt features have their own requirements and costs. There are no plugin-specific settings or auto-detection lists.

## License and provenance

MIT. Adapted from Pi's shipped `examples/extensions/interactive-shell.ts` by Mario Zechner / earendil-works. See [LICENSE](./LICENSE) for the retained MIT notice.
