# pi-herdr

Pi's own [herdr](https://herdr.dev) integration, beside the one herdr installs
(`herdr integration install pi`, which reports the pane's working/blocked/idle state and the
session for resume). Only an interactive pi inside herdr does anything: outside herdr nothing is
registered, and RPC or print sessions (subagents, which inherit their parent's `HERDR_PANE_ID`)
report nothing and drop the tool.

## What it shows

- **`$bg` pane token**: background work that will wake the agent, from `herdr:background` and
  `herdr:working` holds on pi's event bus (async subagents, plan-mode planner runs, awaited herdr
  children): `subagents (2) · child auth-fix`. herdr still shows the pane idle or done meanwhile,
  since only herdr's pi integration reports state; the token is what says the agent is not
  finished. 90 s TTL, refreshed while held.
- **The pane's title** (the session name, else the first prompt's first line), also as the token
  `$task`, and its **displayed agent name**, `pi opus-5-5:xhigh`, which the `agent` row token
  shows. Both apply only while herdr's pi integration holds the pane.
- **`$pr` space token**: the pull request for the checkout's branch, from `gh pr view`:
  `#123 ✓ approved`, `#123 draft …`, `#123 ✗ changes`, `#123 merged`. Checked when the session
  starts, after each turn and every 3 minutes; cleared when the branch has no PR. A space shows it
  only while a pi runs in it. `PI_HERDR_PR=0` turns it off.

Sidebar rows that render them (`~/.config/herdr/config.toml`):

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

The `herdr_child` tool starts an interactive pi in its own herdr pane and gives it a task:

| action | |
|---|---|
| `spawn` | `task`, optional `name`, `where` (`tab` default, `split` beside this pane, or `worktree` with `branch`), `model`, `thinking` (default: this session's), `focus` |
| `send` | `name`, `message`: ask it something more |
| `read` | `name`: its last reply, or its screen while it works |
| `list` | this session's children and their state |
| `interrupt` | `name`: Escape, ending its current turn |
| `close` | `name`: close its pane (the session file stays; a worktree's checkout and branch stay) |

`where: "worktree"` runs `worktree new <branch> --no-open` (checkouts in `<project>/.worktrees/`)
and opens the checkout through herdr as the repo's grouped child space, with the child in it; if
the space is already open the child gets a tab there.

The child is told it is a child and that its final reply goes back. Each reply to a message the
parent sent (the task, or `send`) arrives as a `herdr-child` message that starts a turn, read from
the last assistant message of the child's session file, whose path herdr's pi integration
reports. Turns the user starts by typing in the child's pane are not sent back. While a reply is
pending the parent holds `herdr:background`, so its `$bg` token names the child. Children are
saved as session entries, so `list`, `send` and pending replies survive a restart or `/resume`.

Herdr children vs [pi-subagents](https://github.com/justmytwospence/pi-subagents): a subagent is a
headless `pi --mode rpc` child that lives for one call and returns a result, which suits bounded
tasks. A herdr child is an ordinary pi you can watch, type to and take over, that keeps going after
the parent's turn, and can have a branch of its own: long or open-ended work, or anything the user
may want to steer.

## The event-bus bridge

Other extensions emit these on `pi.events` and pi-herdr does the herdr work, so they need no herdr
code. Without pi-herdr, or outside herdr, nothing listens and the events do nothing.

| channel | payload | |
|---|---|---|
| `herdr:background` | `{ active, label?, id? }` | background work that will wake the agent |
| `herdr:working` | `{ active, label?, id? }` | work outside the agent's turn |
| `herdr:token` | `{ key, value?, ttlMs? }` | set (value) or clear (no value) the pane token `$key`; default TTL a day |
| `herdr:notify` | `{ title, body?, sound?, unlessFocused? }` | a herdr notification (`sound`: `none`, `done`, `request`) |
| `herdr:zoom` | `{ active }` | zoom the pane while any hold is active (restored after, unless it was zoomed already) |
| `herdr:split` | `{ command, cwd?, done? }` | run `command` in a split beside the pane (right when wide, else below); it closes when the command exits; `done(ok, message)` reports back |
| `herdr:probe` | `{ reply }` | `reply()` runs synchronously when pi-herdr is active |

Holds pair `{ active: true }` with `{ active: false }`; a release without `id` ends the oldest hold
on that channel. pi-herdr emits `herdr:ready` when it becomes active, so an extension that set a
token before pi-herdr loaded can send it again. `herdr:blocked` (waiting on the user) is not
handled here: herdr's own pi integration reads it.

## Layout

`src/core` (and `test/core`) is shared verbatim with
[opencode-herdr](https://github.com/justmytwospence/opencode-herdr): the herdr socket client,
metadata reporters, children, PR status and text helpers. A host supplies a `ChildAgent` (which
agent herdr starts, its arguments, how its reply is read); `src/session.ts` is pi's.

## Development

```sh
npm install
npm run check                                              # typecheck + unit tests
node --experimental-strip-types test/live-child.mts tab    # inside herdr: a real child, PONG
```

MIT licensed.
