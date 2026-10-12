# pi-herdr

Pi's own [Herdr](https://herdr.dev) integration, beside the one Herdr installs (`herdr integration install pi`, which reports the pane's working/blocked/idle state and the session for resume). It shows pending background work, the session's title and model, and the branch's pull request in Herdr's sidebar; starts interactive Pi children in Herdr tabs, splits or worktree spaces with the `herdr_child` tool; and runs an event-bus bridge that other extensions use instead of talking to Herdr themselves.

It acts only in an interactive (TUI) Pi inside Herdr. Outside Herdr nothing is registered. RPC and print sessions inside Herdr (subagents inherit their parent's `HERDR_PANE_ID`) report nothing and drop the tool.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-herdr/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-herdr/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run (inside a Herdr pane):

```sh
pi -e ./packages/pi-herdr
```

Add `-ne` to disable your other discovered and configured extensions for that run (an explicit `-e` still loads). No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## What it shows

- **`$bg` pane token**: background work that will wake the agent or runs outside its turn, from `herdr:background` and `herdr:working` holds on Pi's event bus (for example async subagents, pi-bg jobs, plan-mode planner runs, awaited Herdr children): `subagents (2) · child auth-fix`, with repeated labels counted (`×2`). Herdr still shows the pane idle or done meanwhile, since only Herdr's Pi integration reports state; the token is what says the agent is not finished. It has a 90-second TTL, refreshed while held.
- **Pane title and agent name**: the session name, else the first prompt's first line (also published as the pane token `$task`), and a displayed agent name such as `pi opus-5-5:xhigh` (model plus thinking level), which Herdr's `agent` row token shows. Both apply only while Herdr's Pi integration holds the pane.
- **`$pr` space token**: the pull request for the checkout's branch, from `gh pr view`: for example `#123 ✓ approved`, `#123 draft …`, `#123 ✗ changes`, `#123 review`, `#123 merged`, `#123 closed` (`✓` all checks passed, `✗` one failed, `…` some still running). Checked shortly after the session starts, a few seconds after each turn, and every 3 minutes; cleared when the branch has no PR or the session ends. Network failures keep the last value. `PI_HERDR_PR=0` turns it off; it also turns itself off for the session when `gh` is not installed.

Example sidebar rows that render them, in Herdr's `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", { token = "$bg", dim = true }]]
# or, with a second line per agent for its model and task:
# rows = [["state_icon", "workspace", { token = "$bg", dim = true }], [{ token = "agent", dim = true }, "$task"]]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status", "$pr"],
]
```

## Herdr children

The `herdr_child` tool starts an interactive Pi in its own Herdr pane and gives it a task.

| action | parameters |
|---|---|
| `spawn` | `task`; optional `name` (lowercase, dashes; otherwise derived from the task and made unique), `where` (`tab` default, `split` beside this pane, or `worktree` with `branch`), `model` and `thinking` (default: this session's), `focus` (default false) |
| `send` | `name`, `message`: ask it something more |
| `read` | `name`, optional `lines` (default 80, 10-400): its last reply when idle, or its screen while it works |
| `list` | this session's children: state, pending reply, layout, pane, task |
| `interrupt` | `name`: sends Escape, ending its current turn; that turn still reports back when it settles |
| `close` | `name`: close its pane |

**Starting.** A child runs `pi --name <name> [--model ...] [--thinking ...]` through Herdr. pi-herdr waits up to 90 seconds for it to accept input, then sends the task with a preamble telling it that it is a child and that its final reply to each parent message is sent back. If the child is blocked on a dialog, or never becomes ready, the task is not sent; the child is still recorded, so `send` works once the user has dealt with it.

**Worktrees.** `where: "worktree"` runs `worktree new <branch> --no-open` and `worktree path <branch>`, then opens the checkout through Herdr as the repository's grouped child space, with the child in it; if that space is already open, the child gets a tab there.

**Replies.** pi-herdr polls Herdr every 2 seconds for each child it is awaiting. When a turn the parent asked for (the task, or a `send`) settles, it reads the last assistant message from the child's session file, whose path Herdr's Pi integration reports, drops a trailing `<next>` suggestion, keeps the last 2,000 lines or 50 KB, and delivers it as a `herdr-child` message that starts a turn. Turns the user starts by typing in the child's pane are not sent back. While a reply is pending the parent holds `herdr:background`, so its `$bg` token names the child. If the pane closes or Pi exits before replying, the parent is told so instead.

**Lifecycle.** Children are ordinary Pi sessions that outlive the parent's turn. Records are saved as `pi-herdr:child` session entries, so `list`, `send` and pending replies survive a restart or `/resume`. When the parent session ends, pi-herdr releases its holds but does not stop or close the children: their panes keep running. A child's pane closes only with `close` (or when you close it in Herdr). `close` keeps the child's session file; a worktree's checkout and branch also stay (`worktree rm <branch>` removes the checkout).

### Choose delegation, then layout

Use [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/) for delegated work that reports back to the parent. Its headless `pi --mode rpc` children create no panes. Long, multistep and parallel tasks are still subagent work; duration and a hypothetical desire to watch are not reasons to open interactive sessions.

Use a Herdr child only for an explicit interactive-session request or a clear persistent, human-led handoff that the user will continue independently. It is an ordinary Pi session, not a disposable worker. Its ability to send replies back is coordination support, not a reason to choose it over a subagent.

Once an interactive session is appropriate:

| layout | when to use it |
|---|---|
| `tab` (default) | a persistent session sharing the current checkout and branch, in the existing Herdr space |
| `split` | deliberate side-by-side interaction, or a requested split |
| `worktree` | a user-requested independent branch and checkout, in that checkout's own space; an already-open space gets a tab |

Tabs and splits share files and are not isolated parallel editors. A separate feature or PR may benefit from a worktree, but ask first unless the user requested a worktree or branch isolation. Never create a new space or checkout merely because work is delegated, long or parallel. Keep the user's focus unchanged unless asked to switch.

## The event-bus bridge

Other extensions emit these on `pi.events` and pi-herdr does the Herdr work, so they need no Herdr code. Without pi-herdr, or outside an interactive Pi in Herdr, nothing listens and the events do nothing.

| channel | payload | |
|---|---|---|
| `herdr:background` | `{ active, label?, id? }` | background work that will wake the agent (shown in `$bg`) |
| `herdr:working` | `{ active, label?, id? }` | work running outside the agent's turn (shown in `$bg`) |
| `herdr:token` | `{ key, value?, ttlMs? }` | set (`value`) or clear (no `value`) the pane token `$key`: 1-32 letters, digits, `_` or `-`; values cut to 80 characters; TTL default and maximum one day, minimum one second. Tokens sent before the session starts are applied when it does |
| `herdr:notify` | `{ title, body?, sound?, unlessFocused? }` | a Herdr notification (`sound`: `none` default, `done`, `request`); `unlessFocused` skips it while the pane is focused |
| `herdr:zoom` | `{ active }` | zoom the pane while any zoom hold is active (restored afterwards, unless it was zoomed already) |
| `herdr:split` | `{ command, cwd?, done? }` | run `command` in a focused split beside the pane (right when the pane is wide, else below); the split closes when the command exits; `done(ok, message)` reports back, also when pi-herdr is not active |
| `herdr:probe` | `{ reply }` | `reply()` runs synchronously when pi-herdr is active |

Holds pair `{ active: true }` with `{ active: false }`; a release without `id` ends the oldest hold on that channel. pi-herdr emits `herdr:ready` when it becomes active, so an extension can re-send state. `herdr:blocked` (waiting on the user) is not handled here: Herdr's own Pi integration reads it.

## Configuration

| variable | |
|---|---|
| `PI_HERDR_PR` | `0` turns the `$pr` token off |
| `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` | set by Herdr; pi-herdr is active only when `HERDR_ENV=1` and both others are set |

There is no settings file.

## Requirements and costs

- [Herdr](https://herdr.dev), with Pi running in a Herdr pane. pi-herdr talks to Herdr over its socket (`HERDR_SOCKET_PATH`).
- Herdr's own Pi integration (`herdr integration install pi`) for reading children's replies (it reports their session files) and for the pane title and agent name to apply.
- `gh`, authenticated for the repository, for the `$pr` token (optional).
- The `worktree` command on `PATH` for `where: "worktree"`.
- Each Herdr child is a full interactive Pi session using your configured model and credentials, billed like any session. pi-herdr itself makes no model or classifier calls.
- It writes nothing to disk except session entries (`pi-herdr:child`) in the current session.

## Optional integrations

All optional; each sibling works without pi-herdr, and pi-herdr works without them.

- **[pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/)** holds `herdr:background` for agent jobs, sends notifications, and uses `herdr:split` to follow a task's log.
- **[pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/)** holds `herdr:background` while async runs work.
- **[pi-plan-mode](https://pi-plugins.vercel.app/plugins/pi-plan-mode/)** holds `herdr:working` for its planner runs.
- **[pi-marimo](https://pi-plugins.vercel.app/plugins/pi-marimo/)** sets the `$marimo` token and a notification while a notebook the agent started keeps running after its turn.

Plan-mode planners and Herdr children are not entries in pi-bg's `/tasks` list; they only send holds, and are stopped from their own interfaces (children with `interrupt` or `close`).

## Limitations

- Display only: pi-herdr never changes the pane's working/blocked/idle state, which Herdr's Pi integration owns.
- Children are started only from an interactive Pi in Herdr; RPC and print sessions do not get the tool.
- A child's reply is read from its session file; if Herdr does not report the session, the parent is told to use `read`.
- `src/core` (and `test/core`) is shared verbatim with opencode-herdr: the Herdr socket client, metadata reporters, children, PR status and text helpers. A host supplies a `ChildAgent` (which agent Herdr starts, its arguments, how its reply is read); `src/session.ts` is Pi's.

## Development

```sh
cd packages/pi-herdr
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and then `vitest run`. A manual end-to-end check, not part of `npm test`, runs inside Herdr and starts a real child that is asked to reply `PONG`; it makes a live model request with your credentials:

```sh
node --experimental-strip-types test/live-child.mts tab   # or split
```

For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
