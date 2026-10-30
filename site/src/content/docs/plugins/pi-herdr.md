---
title: pi-herdr
description: Connect interactive Pi sessions to Herdr metadata, notifications, pane actions, draft-safe messaging between agents, and persistent child conversations.
plugin: pi-herdr
---

## Quick reference

- **Use it for:** Add pane metadata, message any agent in Herdr without touching its draft, and start deliberate human-accessible child sessions.
- **Enable:** Select `packages/pi-herdr/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/fork-here [name]` (exact current point → new tab or split, idle source required), `/tree-fork` (tree point → new tab or split), `/crew` (board, sync, claim, rule, rules, fetch) and the `herdr` tool: list/send/read/wait for any agent (optionally on a saved Herdr `machine`), `await_reply` and `bg_wait herdr:<name>` to hear back, broadcast with `names`/`cwd_prefix`; spawn/interrupt/close for children; `crew` to coordinate a repository's worktree sessions (directives, crew updates, sync). No global shortcut; child activities offer read-only inspection.
- **Settings:** No plugin JSON settings. Child location: tab; focus: false; model/effort inherit the parent. `PI_HERDR_PR=0` disables PR polling; `PI_HERDR_SUMMARY=0` disables summary and fork-naming model calls, `PI_HERDR_SUMMARY_MODEL` picks their model; `PI_HERDR_DRAFT_GUARD=0` turns off the draft guard; `PI_HERDR_INBOX_RATE` sets the loop guard (default `6/600`, `0` off); `PI_HERDR_CREW_REMOTE_MS` sets how often a crew's coordinator checks the remote (default 5 minutes, `0` never).
- **Requirements, cost & privacy:** Interactive Herdr socket/pane, Pi/provider access for children; Git for worktrees, `gh` for PRs. Herdr socket operations create/open checkouts; no external worktree CLI. The `$summary` line can use a small Haiku request per settled turn; fork naming can make one small request after destination confirmation; children are paid sessions.
- **Integrations & limits:** Optional event-bus bridge, `/tasks`/FleetView child entries (awaited agents as `peer` rows, never stoppable), and pi-bg `bg:external` for awaited replies. An activity stop interrupts an awaited turn, never closes the pane. Herdr itself owns pane state.

pi-herdr adds Pi-specific metadata and an event-bus bridge inside Herdr. It complements Herdr's own Pi integration rather than replacing it: Herdr's integration owns working, blocked, and idle state, while this plugin adds background labels, presentation, pull-request status, messaging between agents, and interactive children.

## Enable, requirements, and costs

Follow [suite installation](/guides/install/) and select `packages/pi-herdr/src/index.ts`. Every suite entry loads by default; selected entries share one Git pin.

The bridge requires an interactive Pi terminal session inside Herdr with a reachable Herdr socket and pane identity. Herdr's own Pi integration supplies pane state and session paths used for child replies. Outside Herdr, the extension registers nothing. RPC and print sessions do not report metadata or expose the child tool, even when they inherit a parent's pane environment.

Additional requirements depend on the feature:

- Pull-request metadata uses `gh pr view`, so it needs GitHub CLI access and appropriate authentication. Missing `gh` disables that reporting.
- Interactive children need a runnable Pi and credentials for their chosen provider.
- Worktree children need Git and a checkout. The plugin calls Herdr's socket `worktree.create`/`worktree.open` operations; no external worktree helper or CLI is required.

**Costs:** the `$summary` token makes one small model request per settled turn whose reply is longer than a line (Haiku by default, a few thousandths of a cent); other metadata and event bridging do not call a model. Children are normal Pi sessions with their own model usage, and delivered replies can start parent turns. PR refreshes also make GitHub API requests.

## Pane and space metadata

The `$bg` pane token uses compact icon/count badges: `⑂ 2` for pending subagents, `≡ 1` for planner holds, `↳ 1` for awaited child replies, and `⌘ 1` for jobs/other background holds (examples). Counts of the same kind are combined, without task names or parentheses. Its 90-second TTL is refreshed while held. A pane may correctly show idle while `$bg` counts unfinished work; the token is not a replacement working-state flag.

`$wait` names what a turn kept open only to wait is waiting on (pi-bg's `bg_wait`, or its wait for a job at the turn's end), from `herdr:waiting` holds. The pane stays working, but typing ends the wait, so a client that reads the token can send a message at once instead of queueing it; herdr-web-ui's fork does with `HERDR_WEB_WAIT_TOKEN=wait`, and shows `Waiting on …` in its chat. Same TTL as `$bg`.

The session name you set (not Recap's automatic one), or the first prompt's first line, becomes the pane title and `$task`. The displayed agent name includes model and effort. `$pr` is a space token describing the checkout branch's PR, refreshed at session start, after turns, and every three minutes. Set `PI_HERDR_PR=0` to disable PR reporting.

`$summary` is one line (at most 80 characters) on what the last turn did or what the agent waits on, for notification tools such as herdr-native-notify. As a turn settles, a small model summarizes the prompt, tool calls, and final reply, before Pi reports the turn finished (about 1-2 seconds, capped at 4). A one-line reply is used as is; without a model, or on an error, timeout, or interrupted turn, the reply's first sentence stands in. While a dialog holds `herdr:blocked`, the token is its question (a pending `ask_user_question`'s first question, else the dialog's label). It is cleared as each run starts. With [Recap](/plugins/pi-recap/) loaded, a settled turn's line is Recap's recap instead (one shared request), so the notification matches Recap's idle line above the editor.

For herdr-web-ui's chat, each tool call without an argument it can summarize by (`command`, `path`, `pattern`, `url`) gets a one-line `intent` before Pi saves the message, such as the subagent labels, the comment a script opens with, the question headers, a job id or the search query; its row shows that instead of the bare tool name. Providers never send the field to the model.

Herdr must render these tokens in its sidebar configuration. For example, in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", { token = "$bg", dim = true }],
  [{ token = "agent", dim = true }, "$task"]
]

[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status", "$pr"]]
```

These are Herdr settings, not a pi-herdr JSON settings file. Token visibility depends on sidebar layout as well as extension loading.

## The herdr tool

One tool reaches every agent in Herdr, on this machine or, with `machine`, on a saved Herdr machine (the label `herdr --machine` takes). `name` is an agent's Herdr name or pane id; this session's children go by their names.

| Action | Arguments |
| --- | --- |
| `list` | Optional `machine`. Every agent with pane, kind, state, directory, title, last-turn summary (after `|`), and marks: `this session`, `child <name>`, `awaited`, `inbox`, `typing`, `focused`. |
| `send` | `name` and `message`, optional `machine` and `await_reply`. While the agent is working, `delivery` is required: `steer` (into its current turn) or `queue` (after it). The result says whether the message started a turn, was steered in, queued, held (a dialog is open, or its user is typing) or deferred (a loop guard). A child's reply is delivered automatically; any other agent's only with `await_reply`. `names` or `cwd_prefix` instead of `name` broadcasts. |
| `read` | `name`; optional `lines` (default 80), `machine`. A local Pi's last reply from its session file when idle, otherwise its screen, labeled as a screen read. |
| `wait` | `name`; optional `timeout_ms` (default 10 minutes), `machine`. Blocks until the agent's turn ends, then reads it. Prefer `await_reply`; refused for an agent whose reply is already awaited, and for children. |
| `spawn` | Required `task`; optional `name`, `where`, `branch`, `model`, `thinking`, `focus`. |
| `interrupt` | A child's `name`; sends Escape to end its current turn. |
| `close` | A child's `name`; closes the pane, retaining the session file. |
| `crew` | `op`: `status` (default), `claim` or `sync`; optional `takeover`. The repository's worktree sessions, coordinated from this session; see [Crews](#crews). |

The tool was called `herdr_child` before it reached agents other than children.

## Messages between agents

`herdr agent prompt` types a message as a bracketed paste and Enter. In a Pi with a draft, the message joins the draft and both are sent as one prompt; an open overlay takes the keys; a recognized dialog rejects the message; and the receiving model sees an ordinary user prompt.

Each interactive pi-herdr therefore has an **inbox**. It advertises the pane token `$inbox` (`v1:<pid>`); a sender also checks that the pid is in the pane's foreground, and sends nothing at all when the pane's Pi is suspended or covered by another program. The sender writes one bracketed paste whose payload starts with an invisible marker (base64 JSON with the message, its id and the sender), with no Enter. pi-tui hands a whole paste to terminal-input listeners before the editor, pi-vim or any overlay, so pi-herdr consumes it there, leaving the draft, cursor and Vim mode as they were, and delivers it with `pi.sendMessage` as a `herdr-message` naming the sender.

The receiver decides delivery from its own state: idle starts a turn; working steers or queues, as the sender asked; idle with a dialog open (`herdr:blocked`) or with its user typing a draft holds the message (`held:dialog`, `held:typing`) and tells the user; a sender past the loop guard is deferred (`deferred:rate`). Held messages survive `/reload` and session switches in the receiving Pi. A working agent is never steered by default: `send` without `delivery` refuses. It acknowledges with a 60-second `$ack-<id>` token (`outcome[:reason]`), which the sender's result reports in words. Without an acknowledgement in a few seconds, the result says the message was sent once and is unconfirmed.

Agents without an inbox (other agent kinds, older Pi) get `agent.prompt`, and the result says their draft was not protected. Replies from another machine or a non-Pi agent are screen reads that can cut a long reply short; the result says so, and the agent can ask for a file instead.

**Presence.** The receiver counts the user as typing while the editor holds a draft and the last edit (a character, a delete or a paste, not an arrow or focus report) was under 15 seconds ago; an Enter that submits a draft counts for 0.4 seconds more. A message arriving then is held, rechecked every 0.3 seconds, and delivered once the user submits (it then follows their turn) or stops. The pane token `$typing` shows it, and `list` marks the agent `typing`. A working receiver is not held: the message goes into or after its turn, which leaves the draft alone.

**Loop guard.** Per sender, the receiver counts messages accepted since the user last wrote to it. Past `PI_HERDR_INBOX_RATE` (default 6 in 10 minutes), further messages are deferred: they ride along with the user's next prompt and start no turn, the user is told once, and the sender's result says to stop and tell the user. An interactive prompt resets the counts.

**Draft guard.** Prompts other programs type without an envelope (herdr-web-ui, Collie, other agent kinds, scripts) are handled on the receiving side. Only when the editor held a draft untouched for 3 seconds, Enter followed the paste within 0.7 seconds, and the paste landed in the main editor, pi-herdr takes the Enter, submits the pasted text itself (a new turn when idle, a steer while working) and leaves the draft in the editor, with a notice. An injected `/` or `!` command is not run over a draft; the draft is kept and a warning names it. `PI_HERDR_DRAFT_GUARD=0` disables the guard.

## Hearing back, and broadcasting

`send` with `await_reply` tracks any agent's answer to that message like a child's: when its turn settles, the reply arrives as a message that starts a turn, and `$bg` counts it (`↳`). A local Pi's reply is read from its session file; a remote or non-Pi agent's is a labeled screen read. The record is kept as a session entry until the reply is delivered, then retired; the agent is never interrupted or closed from here, and `list` marks it `awaited`. A saved machine's agents are polled over ssh every 5 seconds; one unreachable for about four minutes is reported instead.

Every awaited reply is also outside work for [pi-bg](/plugins/pi-bg/): `bg_wait herdr:<name>` (a saved machine's is `herdr:<machine>/<name>`) waits for it, alone or with others, and a reply `bg_wait` hands over is not delivered again as a message. Typing ends the wait like any `bg_wait`.

`send` with `names` or `cwd_prefix` (every agent in that directory or below it) broadcasts to at most 20 agents, never this pane. If any target is working or blocked and no `delivery` was given, nothing is sent and the result names them. The result is one line per agent.

## Fork the current session

`/fork-here [name]` forks the exact persisted current leaf at invocation, without a history picker. It includes trailing hidden entries such as compaction, labels and custom context, not just the last visible answer. A saved, nonempty session with a current leaf is required. The source must be idle both when invoked and before the fork file is created; otherwise it warns `Wait for the current turn to finish before using /fork-here.` It never aborts the source or silently rewinds an interrupted session.

It immediately asks **Open fork in Herdr?** with the same **New tab** (default) and **Split beside this pane** choices as `/tree-fork`. For example, `/fork-here API design review` uses `API design review` as the display/session title and skips the naming loader and model request. The optional name is trimmed, preserves spaces and case, and must be one line without control characters, at most 60 characters. Without a name, it uses the existing semantic topic naming after destination confirmation, with the model, timeout and fallbacks described below. Cancelling creates no file or pane.

The fork starts idle with an empty editor and no task or prompt sent, using the current model and thinking level. It is an independent interactive session, not a report-back child. The original session and draft are unaffected, and focus stays in the original pane. Both sessions share the same checkout and working directory; no workspace, worktree or branch is created. The display title is separate from the unique Herdr handle, which may gain a collision suffix. The startup recovery rules below apply to both commands. Pi's built-in `/fork` is unchanged; use `/tree-fork` to choose an earlier point.

## Fork a tree point

Run `/tree-fork` in interactive Pi inside Herdr. The native session-tree picker shows nonempty user prompts (including image-only prompts) and completed text answers. Tool calls and results, commentary, thinking-only or empty answers, interrupted or incomplete responses, and other internal records are hidden. The initial selection is the nearest visible ancestor of the current point, when one exists. Native search, folding and filters operate on these visible points; label editing is disabled. Then **Open fork in Herdr?** offers **New tab** (default) or **Split beside this pane**. `/tree` is unchanged. The session must be saved and have a visible fork point.

A selected tree label becomes the fork's title. Otherwise, only after destination confirmation, at most one small model request generates a semantic topic title from the selected ancestry. It uses the summary model and credentials (`PI_HERDR_SUMMARY_MODEL`; `PI_HERDR_SUMMARY=0` disables both summary and fork-naming calls), with a four-second limit. If the model is unavailable, fails or returns an invalid title, the fallback is the existing session title, then a prompt-based title, then `Session fork`. Cancelling the picker, destination or naming creates no file or pane. The visible title is separate from the unique Herdr agent handle, which may have a numeric collision suffix. Existing panes keep their names; new forks receive the new titles after reload.

Every choice means **continue after this entry**: the fork includes the selected entry and its original ancestry, including hidden tool and context entries, without later descendants or sibling branches. Selecting a user message keeps it in history, not as an automatically resubmitted prompt.

The fork is a separate ordinary Pi session file, inheriting normal conversation/extension context and the current model and thinking level. It starts idle with an empty editor; no task is automatically sent to it. The ancillary naming request is not a turn in the fork. It is an independent human-led session, not a subagent or tracked child: there is no automatic reporting back, and it does not take ownership of the original's children.

The original conversation, draft and running response stay untouched, and focus stays in the original pane. The fork opens in the same Herdr workspace and working directory. **Tabs and splits share checkout files**; this does not create an isolated worktree or branch.

If a startup dialog blocks the new session, answer it in its pane. An uncertain startup, such as a transport timeout, retains the pane: check it before retrying. Launch errors report the retained session file path, recoverable with `pi --session <path>`. A definitive failed start may close only the new pane; the file remains.

## Interactive children

A child is a persistent, human-accessible session. Use one for a deliberate handoff that someone can continue, not merely because a report-back task is lengthy. Headless pi-subagents are the simpler choice for bounded delegated work. Messages to a child go through its inbox, so typing in the child's pane never collides with the parent's messages.

For a requested interactive handoff in the same checkout:

```json
{
  "action": "spawn",
  "name": "api-review",
  "where": "tab",
  "focus": false,
  "task": "Review the API design with the user. Start by reading the API documentation and asking which endpoint to discuss. Do not edit files until requested."
}
```

The default location is a new tab; `split` places it beside the parent. Both share the checkout. `worktree` requires `branch`: Herdr creates `<repo>/.worktrees/<branch>` (slashes as dashes) and opens it in its grouped space, reusing an existing checkout or space when available. Closing that child does not remove its checkout or branch.

Model and thinking default to the parent's choices, and focus defaults to false. Give a complete task: the child cannot see the parent conversation.

## Replies and persistence

Each reply to a parent-sent task or `send` message arrives as a `herdr-child` message, read from the child's session file and triggering a parent turn. Do not poll the screen to discover completion. Messages the user types directly into the child's pane do not produce automatic parent replies.

Pending replies hold `herdr:background`. Child records are saved in the parent session, allowing listing, sending, and pending-reply tracking after restart or resume. This is coordination state, not a guarantee that an externally closed pane can be recovered automatically.

## Crews

A crew is one repository's worktree sessions, coordinated from one Pi session, usually in the main checkout's Herdr space, with a Pi in each worktree's child space. Its state lives in `<git-common-dir>/pi-crew/`, shared by every worktree and never committed: `coordinator.json` names the coordinating session, and `directives.md` holds standing rules in plain Markdown. Everything else comes from Herdr's snapshot: each space's checkout and PR token, and each agent's state, completion count, and last-turn summary.

- **Directives everywhere.** Every Pi with pi-herdr in the repository gets a `crew` system prompt section on every run, so the rules survive compaction and restarts. Members also learn who coordinates them and when to message it: a decision outside their branch, a finding that changes other branches' work, or a blocking branch. They are told not to report routine progress.
- **Crew updates.** Each prompt you send the coordinator carries one compact block listing the worktrees whose state, last turn, or PR changed since its last turn. That includes turns you ran in a worktree yourself. It has at most 12 lines, is added only when something changed, and never starts a turn.
- **Sync.** `crew` with `op: "sync"` claims the role, makes the Pi already running in each worktree a child, and opens a space for each worktree without an agent, where it runs `pi --continue` to resume that worktree's latest session. It is idempotent. `op: "status"` shows the whole board and the directives. A claim never takes the role from another live coordinator without `takeover`.

- **Drift and overlap.** Each worktree session learns when its base moves under it, on events rather than timers. Only the coordinator fetches: when Herdr's `workspace.metadata_updated` event shows a crew PR turning merged, or when a cheap `git ls-remote` (after each of its turns and every `PI_HERDR_CREW_REMOTE_MS`, default 5 minutes) finds a base's sha changed. Every session watches the repository's shared refs, so any fetch, commit or rebase makes worktree sessions recompute how far they are behind, which of their files also changed upstream, and (git 2.38 or later) whether a rebase would conflict. That shows as a `$drift` space token, as one passive note when it touches the session's own files, and in the coordinator's crew update together with pairs of branches that change the same files. Nothing rebases unless a directive says so.

- **`/crew`.** The same without a model turn: `/crew` (board), `/crew sync [--takeover]`, `/crew claim [--takeover]`, `/crew rule <text>` (append a directive), `/crew rules` (edit them in `$EDITOR` in a split), `/crew fetch` (check the remote now). Output is a displayed message that starts no turn, so the agent sees it on your next prompt.

Example update (illustrative):

```text
[Crew since your last turn, from pi-herdr, not the user: worktree sessions whose state, last turn, PR or base drift changed, and new overlaps between branches]
- feature/1396-contract-windows (contract-windows w9D:p1, idle, #1442 ✓ approved): Rebased onto develop, checks green
```

## Shared activity views

Interactive children are also an activity source for `/tasks` and FleetView (or pi-bg's fallback pill). Enter opens a read-only detail view without focusing or raising the child's pane. Double-`x` is available only for a child with an awaited turn: it sends an interrupt, **never closes the pane**. `herdr` `close` is the explicit pane-closing action. `/stop` remains pi-bg's shell-only command. Metadata and coordination continue to work without an activity host.

## Optional bridge integrations

Sibling plugins communicate through `pi.events`; they need no direct Herdr client. The bridge accepts `herdr:background`, `herdr:working` and `herdr:waiting` holds, `herdr:token`, `herdr:notify`, `herdr:zoom`, `herdr:split`, and `herdr:probe`. It emits `herdr:ready` so earlier token publishers can resend state.

pi-bg uses notifications and log-follow splits; pi-diff-review uses zoom and editor splits; pi-marimo publishes notebook tokens; pi-plan-mode publishes planner holds. These integrations are optional. Without an active bridge, those plugins retain their non-Herdr behavior. `herdr:blocked` is handled by Herdr's own Pi integration, not by this bridge.

For shared activity semantics, see [activity architecture](/architecture/activity/) and [background work](/recipes/background-work/). For missing tokens, check host mode, sidebar rows, and [troubleshooting](/guides/troubleshooting/) before assuming the underlying task stopped.

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-herdr) include the bridge, identity reporting, and child-session handling.
