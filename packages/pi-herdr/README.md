# pi-herdr

Pi's own [Herdr](https://herdr.dev) integration, beside the one Herdr installs (`herdr integration install pi`, which reports the pane's working/blocked/idle state and the session for resume). It shows pending background work, the session's title and model, and the branch's pull request in Herdr's sidebar; gives the agent one `herdr` tool to message, read and wait on any agent in Herdr (here or on a saved Herdr machine) and to start interactive Pi children in Herdr tabs, splits or worktree spaces; delivers messages from other Pi sessions without touching the editor's draft; and runs an event-bus bridge that other extensions use instead of talking to Herdr themselves.

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

- **`$bg` pane token**: background work that will wake the agent or runs outside its turn, from `herdr:background` and `herdr:working` holds on Pi's event bus (for example async subagents, pi-bg jobs, plan-mode planner runs, awaited Herdr children): compact icon/count badges such as `⑂ 2 · ↳ 1`. `⑂` counts pending subagents, `≡` planner holds, `↳` awaited child replies, and `⌘` background jobs/other holds. Counts of the same kind are combined; names and parentheses stay out of the sidebar. Herdr shows the pane idle or done meanwhile (pi-bg keeps a turn open for its own jobs, but after an interrupted wait, and for the other sources, the agent is idle), since only Herdr's Pi integration reports state; the token is what says the agent is not finished. It has a 90-second TTL, refreshed while held.
- **`$wait` pane token**: while a turn is kept open only to wait (pi-bg's `bg_wait`, or its wait for a job when the agent ends its turn), what it waits on, from `herdr:waiting` holds: the newest hold's label, such as `backfill-watch`. Herdr still shows the pane working, since the turn has not ended; the token says that typing ends the wait, as it does in the terminal. herdr-web-ui (with `HERDR_WEB_WAIT_TOKEN=wait`, in Spencer's fork) types a chat message at once instead of queueing it behind Send now, and its chat says `Waiting on …` instead of `Working…`. It has the same 90-second TTL as `$bg` and is cleared when the last hold ends.
- **Pane title and agent name**: the session name you set (pi-recap's automatic name is skipped), else the first prompt's first line (also published as the pane token `$task`), and a displayed agent name such as `pi opus-5-5:xhigh` (model plus thinking level), which Herdr's `agent` row token shows. Both apply only while Herdr's Pi integration holds the pane.
- **`$summary` pane token**: one line (at most 80 characters) on what the last turn did, or what the agent waits on, for notification tools (herdr-native-notify shows it as an alert's body instead of the session title). As a turn settles, a small model (Haiku by default, thinking off) summarizes it from the prompt, the tool calls and the final reply; this runs before Pi reports the turn finished, so the token is set when the done alert fires (about 1-2 seconds; a 4-second cap). A reply that is already one short line is used as is, with no model call; without a model, on an error, a timeout or an interrupted turn, the reply's first sentence stands in. While a dialog holds `herdr:blocked`, the token is its question at once (a pending `ask_user_question`'s first question, else the dialog's label, such as tool-gate's `Allow? …`). It is cleared as each run starts.
- **Tool-row summaries for herdr-web-ui**: each tool call whose arguments herdr-web-ui cannot summarize (no `command`, `path`, `pattern` or `url`, as with `subagent`, `codemode`, `ask_user_question`, `bg_wait`, `web_search`) gets a one-line `intent` field before Pi saves the message: the subagent labels, the comment a script opens with, the question headers, the job id or the query. herdr-web-ui's chat shows it on the call's row instead of the bare tool name. No provider sends the field to the model; `bash`, `read`, `edit`, `write` and `todo` keep herdr-web-ui's own labels.
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

## The `herdr` tool

One tool for every agent in Herdr: this machine's, or a saved Herdr machine's with `machine` (the label `herdr --machine` takes). `name` is an agent's Herdr name or pane id; this session's children go by their names.

| action | parameters |
|---|---|
| `list` | optional `machine`: every agent with its pane, kind, state, directory and title, marked `this session`, `child <name>`, `inbox` (a Pi with pi-herdr, which takes messages without touching its draft) and `focused`; then this session's children with any pending reply |
| `send` | `name`, `message`, optional `machine`. While the agent is working, `delivery` is required: `steer` puts the message into its current turn (Pi delivers it after the current tool call), `queue` delivers it once that turn ends. An idle agent gets it at once. The result says what happened (see below). A child's reply comes back as a message; any other agent's does not: use `wait` or `read` |
| `read` | `name`, optional `lines` (default 80, 10-400), `machine`: a local Pi's last reply from its session file when it is idle; otherwise its screen, labeled as a screen read |
| `wait` | `name`, optional `timeout_ms` (default 10 minutes, at most an hour), `machine`: waits for the agent's turn to end, then reads it as `read` does. An agent idle when the wait starts gets 5 seconds to start a turn. Not for children: their replies arrive by themselves |
| `spawn` | `task`; optional `name` (lowercase, dashes; otherwise derived from the task and made unique), `where` (`tab` default, `split` beside this pane, or `worktree` with `branch`), `model` and `thinking` (default: this session's), `focus` (default false) |
| `interrupt` | `name` of a child: sends Escape, ending its current turn; that turn still reports back when it settles |
| `close` | `name` of a child: close its pane |

Older sessions' `herdr_child` calls are the same actions on children; the tool was renamed `herdr` when it learned to reach every agent.

### Messages between Pi sessions (the inbox)

`herdr agent prompt` types a message into the target's terminal as a bracketed paste followed by Enter. In a Pi whose editor holds a draft, the paste lands in the draft (mid-draft in pi-vim's Normal mode) and the Enter sends both as one prompt; an open selector or dialog takes the keys instead; a dialog Herdr recognizes rejects the message; and the model cannot tell another agent wrote it.

So each interactive pi-herdr listens for messages of its own:

- **Advertised.** It sets the pane token `$inbox` to `v1:<pid>` (source `pi-herdr-inbox`, 90-second TTL, refreshed). A sender uses the inbox only if the token is there and that pid is in the pane's foreground (`pane.process_info`), so a stale token, a suspended Pi or a shell on top of it gets the fallback instead.
- **Sent.** The message, its id and the sender (pane, agent name, host, directory) go as one bracketed paste whose payload starts with an invisible marker and is base64 JSON, written with `pane.send_text` and no Enter. Messages over 256 KB are refused; send a file path instead.
- **Taken before the editor.** pi-tui hands a whole bracketed paste to terminal-input listeners as one string, before the editor, pi-vim or any overlay. pi-herdr consumes the envelope there, so the draft, cursor and Vim mode stay as they were, and delivers it with `pi.sendMessage` as a `herdr-message` that names the sender and says whether the reply goes back (it does for a child's parent).
- **Delivered by the receiver's own state:** idle, it starts a turn (`started`); working, it steers the current turn (`steered`) or follows it (`queued`), as the sender asked; idle with a dialog open (a `herdr:blocked` hold, such as a question or an approval), it is held until the dialog closes (`held`), and the user sees a notice. A message is delivered once even if it arrives twice.
- **Acknowledged.** The receiver sets the token `$ack-<id>` to that outcome for 60 seconds, and the sender's result says it, for example "held until the dialog closes". Without an acknowledgement within 3 seconds (6 on another machine), the result says it was sent once and is unconfirmed, so the agent reads before sending again.

Agents without an inbox (another agent kind, or a Pi without this version) get `agent.prompt` as before, and the result says their draft was not protected; a blocked one is refused, and a working one cannot be queued. Children use the inbox too, so typing in a child's pane never collides with the parent's messages. The envelope grants nothing a process that can type into the pane cannot already do.

### Prompts other programs type (the draft guard)

Prompts typed into the pane without an envelope (herdr-web-ui, Collie, a Codex or Claude agent running `herdr agent prompt`, a script) still arrive as a paste and, about 300 ms later, Enter. When that would send your draft along with them, pi-herdr steps in, and only then: the editor held a draft before the paste that had no keystroke for 3 seconds (pasting a URL onto what you just typed and pressing Enter is your own), Enter came within 0.7 seconds with only focus reports between, and the paste landed in the main editor (not an overlay or Sidebar). It then sends the pasted text on its own and puts your draft back, with a notice. An injected command (`/...`, `!...`) is not run at all, since a command clears the editor late and some need it empty: your draft is kept and a warning names the command. `PI_HERDR_DRAFT_GUARD=0` turns the guard off.

### Children

A child is an interactive Pi in its own Herdr pane, started with `spawn` and given a task.

**Starting.** A child runs `pi --name <name> [--model ...] [--thinking ...]` through Herdr. pi-herdr waits up to 90 seconds for it to accept input, then sends the task with a preamble telling it that it is a child and that its final reply to each parent message is sent back. If the child is blocked on a dialog, or never becomes ready, the task is not sent; the child is still recorded, so `send` works once the user has dealt with it.

**Worktrees.** `where: "worktree"` uses `<repo>/.worktrees/<branch>` (slashes as dashes): Herdr's `worktree.create` makes it (checking out an existing branch or branching from the repository's HEAD) and opens it as the repository's grouped child space, with the child in it. An existing checkout there is opened with `worktree.open` instead; if its space is already open, the child gets a tab there.

**Replies.** pi-herdr polls Herdr every 2 seconds for each child it is awaiting. When a turn the parent asked for (the task, or a `send`) settles, it reads the last assistant message from the child's session file, whose path Herdr's Pi integration reports, drops a trailing `<next>` suggestion, keeps the last 2,000 lines or 50 KB, and delivers it as a `herdr-child` message that starts a turn. Turns the user starts by typing in the child's pane are not sent back. While a reply is pending the parent holds `herdr:background`, so its `$bg` token counts the pending child reply. If the pane closes or Pi exits before replying, the parent is told so instead.

**Lifecycle.** Children are ordinary Pi sessions that outlive the parent's turn. Records are saved as `pi-herdr:child` session entries, so `list`, `send` and pending replies survive a restart or `/resume`. When the parent session ends, pi-herdr releases its holds but does not stop or close the children: their panes keep running. A child's pane closes only with `close` (or when you close it in Herdr). `close` keeps the child's session file; a worktree's checkout and branch also stay (`git worktree remove <path>` removes the checkout).

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
| `herdr:waiting` | `{ active, label?, id? }` | the turn is kept open only to wait on `label`; input ends the wait (shown in `$wait`) |
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
| `PI_HERDR_SUMMARY` | `0` keeps `$summary` but makes no model call (first sentence of the reply only) |
| `PI_HERDR_DRAFT_GUARD` | `0` turns the draft guard off (prompts other programs type join your draft, as without pi-herdr) |
| `PI_HERDR_SUMMARY_MODEL` | `provider/id` for the turn summary; default the first of `anthropic/claude-haiku-5-5`, `anthropic/claude-haiku-4-5` with credentials |
| `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` | set by Herdr; pi-herdr is active only when `HERDR_ENV=1` and both others are set |

There is no settings file.

## Requirements and costs

- [Herdr](https://herdr.dev), with Pi running in a Herdr pane. pi-herdr talks to Herdr over its socket (`HERDR_SOCKET_PATH`).
- Herdr's own Pi integration (`herdr integration install pi`) for reading children's replies (it reports their session files) and for the pane title and agent name to apply.
- `gh`, authenticated for the repository, for the `$pr` token (optional).
- `git` for `where: "worktree"`.
- A saved Herdr machine (`herdr machine add`, with API forwarding) for `machine`; pi-herdr runs `herdr --machine <label> ...` for it.
- Each Herdr child is a full interactive Pi session using your configured model and credentials, billed like any session. pi-herdr's own model call is the `$summary` line: one small request per settled turn whose reply is longer than a line (Haiku, roughly 300 input and 20 output tokens, a few thousandths of a cent), through your configured credentials. `PI_HERDR_SUMMARY=0` turns it off. With pi-recap loaded, pi-recap makes that one request instead.
- It writes nothing to disk except session entries (`pi-herdr:child`) in the current session.

## Optional integrations

All optional; each sibling works without pi-herdr, and pi-herdr works without them.

- **[pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/)** holds `herdr:background` for agent jobs and `herdr:waiting` while a turn waits on one, sends notifications, and uses `herdr:split` to follow a task's log.
- **[pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/)** holds `herdr:background` while async runs work.
- **[pi-plan-mode](https://pi-plugins.vercel.app/plugins/pi-plan-mode/)** holds `herdr:working` for its planner runs.
- **[pi-recap](https://pi-plugins.vercel.app/plugins/pi-recap/)** supplies a settled turn's `$summary` line: pi-herdr asks it over `recap:summary { reply(promise) }` and uses its recap (which also lists the session's earlier prompts to the model) instead of making its own call, so the notification and pi-recap's idle recap line are the same text. Blocked dialogs still get their question from pi-herdr.
- **[pi-marimo](https://pi-plugins.vercel.app/plugins/pi-marimo/)** sets the `$marimo` token and a notification while a notebook the agent started keeps running after its turn.

Plan-mode planners and Herdr children are not entries in pi-bg's `/tasks` list; they only send holds, and are stopped from their own interfaces (children with `interrupt` or `close`).

## Limitations

- Display only: pi-herdr never changes the pane's working/blocked/idle state, which Herdr's Pi integration owns.
- The tool exists only in an interactive Pi in Herdr; RPC and print sessions (subagents) do not get it, and only an interactive Pi has an inbox.
- Replies from another machine or a non-Pi agent are screen reads (Herdr's `agent.read`), which can cut a long reply short; the result says so. Messages to another machine are draft-safe, but a remote agent's reply never comes back on its own, even from a child (children start on this machine only).
- Messages held behind a dialog live in memory: a `/reload` or a restart of the receiving Pi while one is held drops it.
- The draft guard tells an injected prompt from your own paste by timing alone: a paste into a draft untouched for 3 seconds, then Enter within 0.7 seconds, is taken as injected.
- A child's reply is read from its session file; if Herdr does not report the session, the parent is told to use `read`.
- `src/core` (and `test/core`) is shared verbatim with opencode-herdr: the Herdr socket client, metadata reporters, children, PR status and text helpers. A host supplies a `ChildAgent` (which agent Herdr starts, its arguments, how its reply is read) and optionally a `transport` (pi-herdr's inbox; opencode-herdr has none and types with `agent.prompt`); `src/session.ts` is Pi's.

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
