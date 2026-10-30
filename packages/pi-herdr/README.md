# pi-herdr

Pi's own [Herdr](https://herdr.dev) integration, beside the one Herdr installs (`herdr integration install pi`, which reports the pane's working/blocked/idle state and the session for resume). It shows pending background work, the session's title and model, and the branch's pull request in Herdr's sidebar; gives the agent one `herdr` tool to message, read and wait on any agent in Herdr (here or on a saved Herdr machine) and to start interactive Pi children in Herdr tabs, splits or worktree spaces; coordinates a repository's worktree sessions as a crew (shared directives, a coordinator that sees each one's progress); delivers messages from other Pi sessions without touching the editor's draft; and runs an event-bus bridge that other extensions use instead of talking to Herdr themselves.

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

- **`$bg` pane token**: background work that will wake the agent or runs outside its turn, from `herdr:background` and `herdr:working` holds on Pi's event bus (for example async subagents, pi-bg jobs, plan-mode planner runs, awaited Herdr children and agents): compact icon/count badges such as `⑂ 2 · ↳ 1`. `⑂` counts pending subagents, `≡` planner holds, `↳` awaited replies (children, and other agents sent to with `await_reply`), and `⌘` background jobs/other holds. Counts of the same kind are combined; names and parentheses stay out of the sidebar. Herdr shows the pane idle or done meanwhile (pi-bg keeps a turn open for its own jobs, but after an interrupted wait, and for the other sources, the agent is idle), since only Herdr's Pi integration reports state; the token is what says the agent is not finished. It has a 90-second TTL, refreshed while held.
- **`$wait` pane token**: while a turn is kept open only to wait (pi-bg's `bg_wait`, or its wait for a job when the agent ends its turn), what it waits on, from `herdr:waiting` holds: the newest hold's label, such as `backfill-watch`. Herdr still shows the pane working, since the turn has not ended; the token says that typing ends the wait, as it does in the terminal. herdr-web-ui (with `HERDR_WEB_WAIT_TOKEN=wait`, in Spencer's fork) types a chat message at once instead of queueing it behind Send now, and its chat says `Waiting on …` instead of `Working…`. It has the same 90-second TTL as `$bg` and is cleared when the last hold ends.
- **`$typing` pane token**: `1` while the user is typing a draft in this pane's editor, set at the start of a burst of typing and cleared 15 seconds after the last edit (a 30-second TTL backs it up). It is what the receiver holds messages for (see presence below); `list` shows it as `typing` on the agent.
- **Pane title and agent name**: the session name you set (pi-recap's automatic name is skipped), else the first prompt's first line (also published as the pane token `$task`), and a displayed agent name such as `pi opus-5-5:xhigh` (model plus thinking level), which Herdr's `agent` row token shows. Both apply only while Herdr's Pi integration holds the pane.
- **`$summary` pane token**: one line (at most 80 characters) on what the last turn did, or what the agent waits on, for notification tools (herdr-native-notify shows it as an alert's body instead of the session title). As a turn settles, a small model (Haiku by default, thinking off) summarizes it from the prompt, the tool calls and the final reply; this runs before Pi reports the turn finished, so the token is set when the done alert fires (about 1-2 seconds; a 4-second cap). A reply that is already one short line is used as is, with no model call; without a model, on an error, a timeout or an interrupted turn, the reply's first sentence stands in. While a dialog holds `herdr:blocked`, the token is its question at once (a pending `ask_user_question`'s first question, else the dialog's label, such as tool-gate's `Allow? …`). It is cleared as each run starts.
- **Tool-row summaries for herdr-web-ui**: each tool call whose arguments herdr-web-ui cannot summarize (no `command`, `path`, `pattern` or `url`, as with `subagent`, `codemode`, `ask_user_question`, `bg_wait`, `web_search`) gets a one-line `intent` field before Pi saves the message: the subagent labels, the comment a script opens with, the question headers, the job id or the query. herdr-web-ui's chat shows it on the call's row instead of the bare tool name. No provider sends the field to the model; `bash`, `read`, `edit`, `write` and `todo` keep herdr-web-ui's own labels.
- **`$pr` space token**: the pull request for the checkout's branch, from `gh pr view`: for example `#123 ✓ approved`, `#123 draft …`, `#123 ✗ changes`, `#123 review`, `#123 merged`, `#123 closed` (`✓` all checks passed, `✗` one failed, `…` some still running). Checked shortly after the session starts, a few seconds after each turn, and every 3 minutes; cleared when the branch has no PR or the session ends. Network failures keep the last value. `PI_HERDR_PR=0` turns it off; it also turns itself off for the session when `gh` is not installed.
- **`$drift` space token**: in a repository with a crew (see [Crews](#crews)), how far a worktree's branch is behind its base on the remote: `↓3 develop`, `↓3 develop · 2 overlap` (2 files it changed also changed upstream) or `↓3 develop ✗ conflict` (a rebase would conflict, git 2.38 or later); cleared when it is not behind. A second, undisplayed token `$crew_base` names the base, for the coordinator. Both come from events, not a timer (see [Drift and overlap](#drift-and-overlap)).

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
| `list` | optional `machine`: every agent with its pane, kind, state, directory, title and last-turn `$summary` (after `|`), marked `this session`, `child <name>`, `awaited` (its reply is awaited), `inbox` (a Pi with pi-herdr, which takes messages without touching its draft), `typing` (its user is typing a draft) and `focused`; then this session's children and awaited agents with any pending reply |
| `send` | `name`, `message`, optional `machine`, `await_reply`. While the agent is working, `delivery` is required: `steer` puts the message into its current turn (Pi delivers it after the current tool call), `queue` delivers it once that turn ends. An idle agent gets it at once. The result says what happened (see below). A child's reply comes back as a message; any other agent's does only with `await_reply` (see below), otherwise use `read`. `names` (several agents) or `cwd_prefix` (every agent working in a directory or below it) instead of `name` broadcasts |
| `read` | `name`, optional `lines` (default 80, 10-400), `machine`: a local Pi's last reply from its session file when it is idle; otherwise its screen, labeled as a screen read |
| `wait` | `name`, optional `timeout_ms` (default 10 minutes, at most an hour), `machine`: blocks until the agent's turn ends, then reads it as `read` does. An agent idle when the wait starts gets 5 seconds to start a turn. Prefer `await_reply` (it blocks nothing); `wait` refuses an agent whose reply is already awaited, as it does a child |
| `spawn` | `task`; optional `name` (lowercase, dashes; otherwise derived from the task and made unique), `where` (`tab` default, `split` beside this pane, or `worktree` with `branch`), `model` and `thinking` (default: this session's), `focus` (default false) |
| `interrupt` | `name` of a child: sends Escape, ending its current turn; that turn still reports back when it settles |
| `close` | `name` of a child: close its pane |
| `crew` | `op`: `status` (default), `claim` or `sync`, optional `takeover`: this repository's worktree sessions, coordinated from this session (see [Crews](#crews)) |

Older sessions' `herdr_child` calls are the same actions on children; the tool was renamed `herdr` when it learned to reach every agent.

### Messages between Pi sessions (the inbox)

`herdr agent prompt` types a message into the target's terminal as a bracketed paste followed by Enter. In a Pi whose editor holds a draft, the paste lands in the draft (mid-draft in pi-vim's Normal mode) and the Enter sends both as one prompt; an open selector or dialog takes the keys instead; a dialog Herdr recognizes rejects the message; and the model cannot tell another agent wrote it.

So each interactive pi-herdr listens for messages of its own:

- **Advertised.** It sets the pane token `$inbox` to `v1:<pid>` (source `pi-herdr-inbox`, 90-second TTL, refreshed). A sender uses the inbox only if the token is there and that pid is in the pane's foreground (`pane.process_info`). If the pane advertises an inbox but its Pi is not in front (suspended with Ctrl+Z, or a program runs on top of it), nothing is sent at all, since typing would reach that program; an expired token (a Pi that exited) gets the fallback.
- **Sent.** The message, its id and the sender (pane, agent name or else session title, host, directory) go as one bracketed paste whose payload starts with an invisible marker and is base64 JSON, written with `pane.send_text` and no Enter. Messages over 256 KB are refused; send a file path instead.
- **Taken before the editor.** pi-tui hands a whole bracketed paste to terminal-input listeners as one string, before the editor, pi-vim or any overlay. pi-herdr consumes the envelope there, so the draft, cursor and Vim mode stay as they were, and delivers it with `pi.sendMessage` as a `herdr-message` that names the sender and says whether the reply goes back (it does for a child's parent).
- **Delivered by the receiver's own state:** idle, it starts a turn (`started`); working, it steers the current turn (`steered`) or follows it (`queued`), as the sender asked; idle with a dialog open (a `herdr:blocked` hold, such as a question or an approval), or with the user typing a draft, it is held (`held`, with the reason `dialog` or `typing`) and the user sees a notice; a sender that has had many messages accepted without the user answering is deferred (`deferred:rate`, see below). Held messages and the ids already delivered are kept process-wide, so `/reload`, `/new` or `/resume` in the receiving Pi delivers them in the next session instead of dropping them; quitting Pi drops them. A message is delivered once even if it arrives twice. A working agent is never steered by default: without `delivery`, `send` refuses and asks for `steer` or `queue`. A message held when the user submits (or a held one released while a turn runs) follows that turn instead of steering it.
- **Acknowledged.** The receiver sets the token `$ack-<id>` to `outcome[:reason]` (`started`, `steered`, `queued`, `held:dialog`, `held:typing`, `held:retry`, `deferred:rate`) for 60 seconds, and the sender's result says it in words, for example "held until the dialog closes". Without an acknowledgement within 3 seconds (6 on another machine), the result says it was sent once and is unconfirmed, so the agent reads before sending again.

Agents without an inbox (another agent kind, or a Pi without this version) get `agent.prompt` as before, and the result says their draft was not protected; a blocked one is refused, and a working one cannot be queued. Children use the inbox too, so typing in a child's pane never collides with the parent's messages. The envelope grants nothing a process that can type into the pane cannot already do.

#### Presence: the user typing

An idle receiver whose user is typing a draft holds an incoming message instead of starting a turn under their hands (`held:typing`; the user sees "waiting until you submit or stop typing"). The listener that sees the keys counts an edit (a character, a delete, a paste) as typing while the editor holds a draft and the last edit was under 15 seconds ago; an Enter that submits a draft counts for 0.4 seconds more, while the turn it starts has not begun. Arrows, focus reports, mouse and key releases are not edits. A held message is rechecked every 0.3 seconds and delivered once the user stops (deleted the draft, or 15 seconds of silence) or submits; if a turn is running by then it follows it. The `$typing` token shows presence to others. A working receiver is never held for typing: its message goes into or after its turn, which does not touch the draft.

#### The rate guard: no loops

Per sender (host and pane), the receiver counts the messages it accepted since the user last wrote to it (an interactive prompt resets every count). Past `PI_HERDR_INBOX_RATE` (default `6/600`: 6 messages in 10 minutes), further messages are `deferred:rate`: they go in with `deliverAs: "nextTurn"`, riding along with the user's next prompt, starting no turn, and the user is told once. The sender's result says to stop messaging and tell the user. `PI_HERDR_INBOX_RATE=0` turns the guard off.

### Hearing back: `await_reply` and `bg_wait`

Only a child's reply came back on its own. `send` with `await_reply` tracks any other agent's answer to that message the same way (a *peer* record, kept as a `pi-herdr:child` session entry, polled every 2 seconds; every 5 seconds, and through ssh, on a saved machine): when its turn settles, its reply is delivered as a `herdr-child` message that starts a turn, and the `$bg` token counts it (`↳`). A local Pi's reply is read from its session file; a remote or non-Pi agent's is a labeled screen read (it can cut a long reply short; ask the agent to write it to a file when you need all of it). A pane that closes first, or a machine unreachable for about four minutes, is reported instead. A peer is tracked for one reply: once delivered, its record is retired. It is never interrupted or closed from here, and `list` marks it `awaited`.

Every awaited reply (a child's too) is also outside work for [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/) (`bg:external`): `bg_wait herdr:<name>` (a saved machine's is `herdr:<machine>/<name>`) waits for it, and `bg_wait herdr:a herdr:b` for several at once; typing ends the wait like any `bg_wait`. When `bg_wait` hands the model the reply, it is not delivered again as a message. A closed child, or the end of the session or branch, ends the outside work as failed. Without pi-bg nothing changes: the message arrives as before.

### Broadcast

`send` with `names` (agent names or pane ids) or `cwd_prefix` (every agent whose directory is that one or below it, `~` allowed on this machine) instead of `name` sends one message to up to 20 agents at once, never this pane, on this machine or one `machine`. If any target is working or blocked and no `delivery` was given, nothing is sent and the result names them. Each target goes through the normal path (inbox, or `agent.prompt` with the draft warning), with `await_reply` if asked; the result is one line per agent, and an agent that failed or does not exist is a line, not an error.

### Prompts other programs type (the draft guard)

Prompts typed into the pane without an envelope (herdr-web-ui, Collie, a Codex or Claude agent running `herdr agent prompt`, a script) still arrive as a paste and, about 300 ms later, Enter. When that would send your draft along with them, pi-herdr steps in, and only then: the editor held a draft before the paste that had no keystroke for 3 seconds (pasting a URL onto what you just typed and pressing Enter is your own), Enter came within 0.7 seconds with only focus reports between, and the paste landed in the main editor (not an overlay or Sidebar). It then takes that Enter, submits the pasted text itself (`pi.sendUserMessage`: a new turn when idle, a steer while working, as Enter would) and leaves your draft in the editor as it was, with a notice; if Pi refuses the prompt, Enter goes through as it would have without the guard. An injected command (`/...`, `!...`) is not run at all, since a command clears the editor late and some need it empty: your draft is kept and a warning names the command. `PI_HERDR_DRAFT_GUARD=0` turns the guard off.

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

## Fork the current session

`/fork-here [name]` forks the exact persisted current leaf at invocation, without a history picker. It includes trailing hidden entries such as compaction, labels and custom context, not just the last visible answer. A saved, nonempty session with a current leaf is required. The source must be idle both when invoked and before the fork file is created; otherwise it warns `Wait for the current turn to finish before using /fork-here.` It never aborts the source or silently rewinds an interrupted session.

It immediately asks **Open fork in Herdr?** with the same **New tab** (default), **Split beside this pane** and **New space** choices as `/tree-fork`. For example, `/fork-here API design review` uses `API design review` as the display/session title and skips the naming loader and model request. The optional name is trimmed, preserves spaces and case, and must be one line without control characters, at most 60 characters. Without a name, it uses the existing semantic topic naming after destination confirmation, with the model, timeout and fallbacks described below. Cancelling creates no file or pane.

The fork starts idle with an empty editor and no task or prompt sent, using the current model and thinking level. It is an independent interactive session, not a report-back child. The original session and draft are unaffected, and focus stays in the original pane. All three destinations share the same checkout and working directory, with no file isolation: no worktree or branch is created. **New space** creates an ordinary Herdr workspace labelled with the fork's title; tabs and splits stay in the existing workspace. The display title is separate from the unique Herdr handle, which may gain a collision suffix. The startup recovery rules below apply to both commands. Pi's built-in `/fork` is unchanged; use `/tree-fork` to choose an earlier point.

## Fork a tree point

`/tree-fork` opens Pi's native session-tree picker, then asks **Open fork in Herdr?**: **New tab** (default), **Split beside this pane** or **New space**. The picker shows nonempty user prompts (including image-only prompts) and completed text answers. It hides tool calls and results, commentary, thinking-only or empty answers, interrupted or incomplete responses, and other internal records. Its initial selection is the nearest visible ancestor of the current point, when one exists. Native search, folding and filters operate on these visible points; label editing is disabled. `/tree` keeps its usual behavior. A saved session with a visible fork point is required.

A selected tree label becomes the new fork's title. Otherwise, after you confirm the destination, at most one small model request generates a semantic topic title from the selected ancestry. It uses the summary model and credentials (`PI_HERDR_SUMMARY_MODEL`; `PI_HERDR_SUMMARY=0` disables both summary and fork-naming calls). The request has a four-second limit. If it is unavailable, fails or returns an invalid title, the fallback is the existing session title, then a prompt-based title, then `Session fork`. Cancelling the picker, destination or naming creates no file or pane. The visible title is separate from the unique Herdr agent handle, which may have a numeric collision suffix. Existing panes keep their names; new forks receive the new titles after reload.

The fork includes the selected entry and its original ancestry, including hidden tool and context entries: every selection means **continue after this entry**. A selected user message stays in the history and is not resubmitted. The new session inherits the current model and thinking level and normal conversation/extension context, but starts idle with an empty editor; no task is automatically sent to it. The ancillary naming request is not a turn in the fork. It is independent, not a child or subagent: it does not automatically report back or inherit ownership of the original session's children.

The original conversation, editor draft and running response stay untouched, and focus stays in the original pane. Tabs and splits use the existing Herdr workspace; **New space** creates an ordinary workspace labelled with the fork's title. All three use the same working directory: **both sessions share checkout files**, with no file isolation, new worktree or branch.

If startup is blocked on a dialog, answer it in the new pane; a new space is retained too. An uncertain startup (such as a transport timeout) keeps the pane and any new space rather than risking closing a running Pi; check the retained destination before retrying. Launch failures retain the new session file and report its path for recovery with `pi --session <path>`, along with any known space and pane IDs. A definitive failed start may close only the newly created pane or space, never a pre-existing workspace or group, and never deletes that file. Cleanup failures are reported; a space is never closed after its agent has successfully started.

## Crews

A crew is one repository's worktree sessions, coordinated from one Pi session, usually in the main checkout: the pattern where you run a coordinator in the repository's main Herdr space and a Pi in each worktree's child space. Without it they only stay in step through messages you prompt by hand; with it, standing rules reach every session on their own, the coordinator sees what each one did without asking, and a restarted coordinator gets its crew back with one call.

A crew's state lives in `<git-common-dir>/pi-crew/` (for a normal checkout, `.git/pi-crew/`), which every worktree of the repository shares and Git never commits:

- `coordinator.json`: the pane, session and Herdr name of the coordinating session, written by a claim.
- `directives.md`: standing rules for every session in the repository, plain Markdown that you or the coordinator edit (it has no tool of its own: the coordinator uses `edit` or `write`).

Everything else comes from Herdr's `session.snapshot`: each space's checkout and `$pr` token, each agent's state, completion count and `$summary` line. Members run nothing extra.

**The `crew` prompt section.** Every Pi with pi-herdr whose checkout belongs to a repository with a `pi-crew/` directory gets a `crew` section in its system prompt on every run, so it survives compaction and restarts, and Pi records a changed section in the transcript:

- the directives, when the file has any;
- in a member (any other session in the repository, while the coordinator's pane still runs Pi there): who coordinates it and when to message it: only for a decision outside its branch, a finding that changes other branches' work, or another branch blocking it; never for routine progress, which the coordinator sees on its own;
- in the coordinator: its role, that crew updates are status rather than requests, and that rules for every session go into the directives file instead of messages.

**The coordinator's crew update.** Each prompt you send the coordinator (not runs started by a child's reply or a message) compares the crew with what the coordinator last saw: each linked worktree's agent state, completion count, `$summary` and PR, worktrees without a space or agent, worktrees that went away. If anything changed, one `herdr-crew` message goes in with that prompt, one line per worktree (at most 12, each at most 160 characters), for example:

```text
[Crew since your last turn, from pi-herdr, not the user: worktree sessions whose state, last turn, PR or base drift changed, and new overlaps between branches]
- feature/1396-contract-windows (contract-windows w9D:p1, idle, #1442 ✓ approved): Rebased onto develop, checks green
- feature/1429-coverage: no space and no agent; herdr action=crew op=sync starts its pi
```

Nothing is added when nothing changed, and it never starts a turn. The first update after a claim lists every worktree. What the coordinator has seen is a `pi-herdr:crew-seen` session entry, so `/resume` does not repeat it. Turns you run by hand in a worktree show up here through their `$summary` line, though their replies are still not sent back.

**`crew` actions.**

- `status`: every worktree (from `git worktree list`) with its space, agents (marked `[this session]` or `[child]`), PR and last-turn summary, then the directives.
- `claim`: makes this session the coordinator. Another session whose pane still runs Pi in the repository keeps the role unless `takeover` is set, which the agent sets only when you said so. A coordinator without a Herdr name is named `<repo>-coord`, so members can message it by name.
- `sync`: claims, then for each linked worktree: a Pi already there becomes this session's child (named after its branch if it had no name); a worktree with no agent gets its space opened (without focus, or a tab in its open space) and `pi --continue` started there, which resumes its latest session (a fresh one if it has none), with no task sent, and becomes a child too. Worktrees running another agent are left alone. Running it again changes nothing that is already in place.

**`/crew`.** The same operations without asking the agent, and without a model turn. The output goes into the conversation as a displayed message that starts no turn, so the agent sees what you did on your next prompt (while a turn runs, it waits for the next one). Subcommands tab-complete.

| command | |
|---|---|
| `/crew` | the board, as `status` |
| `/crew sync [--takeover]` | `sync` |
| `/crew claim [--takeover]` | `claim` |
| `/crew rule <text>` | appends `- <text>` to the directives (creating the file); works in any session of the repository |
| `/crew rules` | opens the directives in `$VISUAL` or `$EDITOR` (else `vi`) in a split beside the pane, which closes when the editor exits; every pi rereads the file on its next run |
| `/crew fetch` | the coordinator's remote check now, instead of at its next trigger |

A coordinator restarted in the same pane keeps the role; one resumed in another pane takes it back on its first run (its file names its session). Members do not see a moved coordinator until then.

### Drift and overlap

Each worktree session learns on its own when its base branch moves under it, and the coordinator sees it, with no timers in the sessions: everything runs on events.

- **One fetcher.** Only the coordinator fetches (`git fetch origin <bases>`), so worktrees never fetch at once and fight over ref locks. It fetches when Herdr's `workspace.metadata_updated` event shows a crew space's `$pr` turning `merged` (one long-lived `events.subscribe` connection, reconnected with backoff and reconciled after `events_lost`), and when a cheap `git ls-remote origin <bases>` finds a base's sha changed: after each of its turns, and every `PI_HERDR_CREW_REMOTE_MS` (default 5 minutes, `0` never) for merges outside the crew. At most one fetch in 30 seconds.
- **Every session watches the shared refs.** `fs.watch` on the repository's shared `refs/` and `packed-refs` sees any fetch, pull, commit, rebase or push in any checkout (yours in a terminal too). A worktree session then recomputes its drift, as it does after each of its own turns: its base is its PR's `baseRefName`, else `origin/HEAD`; `behind` counts `HEAD..origin/<base>`; overlap is the files changed on both sides since the merge base; and with git 2.38 or later, `git merge-tree --write-tree` predicts conflicts without touching the checkout.
- **What it shows.** The `$drift` space token always. When the drift touches the session's own files (overlap or conflict) and the upstream sha is new, one passive `herdr-drift` note naming the newest upstream commits and the files, delivered with the next prompt (it starts no turn) and saying to rebase only if you or a directive says so. The coordinator's crew update carries each worktree's drift, and a line for each new or changed pair of crew branches that change the same files (`- overlap: feature/a ↔ feature/b: would conflict in cube/x.js`), recomputed whenever a branch or base ref changes; `crew status` lists them too.

Nothing rebases on its own: a directive such as "rebase onto the base when it moves and nothing conflicts" does that.

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
| `PI_HERDR_CREW_REMOTE_MS` | how often a crew's coordinator compares its bases with the remote with `git ls-remote` (default `300000`, 5 minutes; at least 10 seconds; `0` never) |
| `PI_HERDR_SUMMARY` | `0` disables summary and fork-naming model calls; `$summary` uses the reply's first sentence |
| `PI_HERDR_INBOX_RATE` | `<messages>/<seconds>`: how many messages one sender may have accepted without the user writing before the next ones are deferred to the user's next prompt (default `6/600`; `0` turns the guard off) |
| `PI_HERDR_DRAFT_GUARD` | `0` turns the draft guard off (prompts other programs type join your draft, as without pi-herdr) |
| `PI_HERDR_SUMMARY_MODEL` | `provider/id` for turn summaries and fork naming; default the first of `anthropic/claude-haiku-5-5`, `anthropic/claude-haiku-4-5` with credentials |
| `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` | set by Herdr; pi-herdr is active only when `HERDR_ENV=1` and both others are set |

There is no settings file.

## Requirements and costs

- [Herdr](https://herdr.dev), with Pi running in a Herdr pane. pi-herdr talks to Herdr over its socket (`HERDR_SOCKET_PATH`).
- Herdr's own Pi integration (`herdr integration install pi`) for reading children's replies (it reports their session files) and for the pane title and agent name to apply.
- `gh`, authenticated for the repository, for the `$pr` token (optional).
- `git` for `where: "worktree"`.
- A saved Herdr machine (`herdr machine add`, with API forwarding) for `machine`; pi-herdr runs `herdr --machine <label> ...` for it.
- Each Herdr child is a full interactive Pi session using your configured model and credentials, billed like any session. pi-herdr also makes a bounded fork-naming request when needed (see [Fork a tree point](#fork-a-tree-point)). Its `$summary` model call is one small request per settled turn whose reply is longer than a line (Haiku, roughly 300 input and 20 output tokens, a few thousandths of a cent), through your configured credentials. `PI_HERDR_SUMMARY=0` disables both kinds of call. With pi-recap loaded, pi-recap makes that one request instead.
- It saves coordination entries in Pi sessions, writes crew state under `<git-common-dir>/pi-crew/`, and `/fork-here` and `/tree-fork` create separate ordinary Pi session files without changing the source session file.

## Optional integrations

All optional; each sibling works without pi-herdr, and pi-herdr works without them.

- **[pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/)** holds `herdr:background` for agent jobs and `herdr:waiting` while a turn waits on one, sends notifications, and uses `herdr:split` to follow a task's log. pi-herdr tells it about every awaited reply over `bg:external` (id `herdr:<name>`), so `bg_wait` can wait on children and awaited agents; pi-bg's answer `bg:external-consumed` keeps a reply it handed over from arriving twice.
- **[pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/)** holds `herdr:background` while async runs work.
- **[pi-plan-mode](https://pi-plugins.vercel.app/plugins/pi-plan-mode/)** holds `herdr:working` for its planner runs.
- **[pi-recap](https://pi-plugins.vercel.app/plugins/pi-recap/)** supplies a settled turn's `$summary` line: pi-herdr asks it over `recap:summary { reply(promise) }` and uses its recap (which also lists the session's earlier prompts to the model) instead of making its own call, so the notification and pi-recap's idle recap line are the same text. Blocked dialogs still get their question from pi-herdr.
- **[pi-marimo](https://github.com/justmytwospence/pi-marimo)** sets the `$marimo` token and a notification while a notebook the agent started keeps running after its turn.

Plan-mode planners, Herdr children and awaited agents are not pi-bg tasks; they only send holds (and, for awaited replies, `bg:external` outside work), and are stopped from their own interfaces (children with `interrupt` or `close`; an awaited agent that is not a child is never stopped from here). Children and awaited agents also show in `/tasks` through the activity source, awaited agents as `peer` rows without a stop.

## Limitations

- Display only: pi-herdr never changes the pane's working/blocked/idle state, which Herdr's Pi integration owns.
- The tool exists only in an interactive Pi in Herdr; RPC and print sessions (subagents) do not get it, and only an interactive Pi has an inbox.
- Replies from another machine or a non-Pi agent, awaited or not, are screen reads (Herdr's `agent.read`), which can cut a long reply short; the result says so. Messages to another machine are draft-safe, but a remote agent's reply never comes back on its own, even from a child (children start on this machine only).
- Messages held behind a dialog or the user's typing live in the receiving Pi's process: they survive `/reload` and session switches, not quitting Pi. The rate counts live there too.
- Presence and the rate guard are the receiver's: they work for any sender with an inbox. Presence is a timing heuristic on the keys the extension's input listener sees; a draft left for 15 seconds is no longer "typing". Typing in a Pi that has a dialog open (or a `/tree` selector) still counts, and the dialog's own hold applies as before.
- A peer on another machine is polled with `herdr --machine`, an ssh round trip every 5 seconds; a slow or down machine delays only that peer's reply.
- An awaited peer's record is a session entry: a restart or `/resume` restores it if its turn is still running, and a reply that finished meanwhile is delivered once.
- The sender's identity in a message is what the sender says it is: anything that can type into the pane can claim to be another agent, just as it could type a prompt.
- The draft guard tells an injected prompt from your own paste by timing alone: a paste into a draft untouched for 3 seconds, then Enter within 0.7 seconds, is taken as injected.
- A child's reply is read from its session file; if Herdr does not report the session, the parent is told to use `read`.
- A crew is this machine's sessions only, and Herdr does not keep tokens across a server restart, so a crew update may show `no turn summary yet` for a worktree until its next turn. Directives are trusted like `AGENTS.md`: anything that can write the repository's `.git` directory can change them.
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
