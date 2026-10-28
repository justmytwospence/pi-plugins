---
title: pi-herdr
description: Connect interactive Pi sessions to Herdr metadata, notifications, pane actions, draft-safe messaging between agents, and persistent child conversations.
plugin: pi-herdr
---

## Quick reference

- **Use it for:** Add pane metadata, message any agent in Herdr without touching its draft, and start deliberate human-accessible child sessions.
- **Enable:** Select `packages/pi-herdr/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** the `herdr` tool: list/send/read/wait for any agent (optionally on a saved Herdr `machine`); spawn/interrupt/close for children. No global shortcut; child activities offer read-only inspection.
- **Settings:** No plugin JSON settings. Child location: tab; focus: false; model/effort inherit the parent. `PI_HERDR_PR=0` disables PR polling; `PI_HERDR_SUMMARY=0` disables the summary model call, `PI_HERDR_SUMMARY_MODEL` picks its model; `PI_HERDR_DRAFT_GUARD=0` turns off the draft guard.
- **Requirements, cost & privacy:** Interactive Herdr socket/pane, Pi/provider access for children; Git for worktrees, `gh` for PRs. Herdr socket operations create/open checkouts; no external worktree CLI. The `$summary` line is one small Haiku request per settled turn; children are paid sessions.
- **Integrations & limits:** Optional event-bus bridge and `/tasks`/FleetView child entries. An activity stop interrupts an awaited turn, never closes the pane. Herdr itself owns pane state.

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
| `list` | Optional `machine`. Every agent with pane, kind, state, directory, title, and marks: `this session`, `child <name>`, `inbox`, `focused`. |
| `send` | `name` and `message`, optional `machine`. While the agent is working, `delivery` is required: `steer` (into its current turn) or `queue` (after it). The result says whether the message started a turn, was steered in, queued, or held behind a dialog. A child's reply is delivered automatically; any other agent's is not. |
| `read` | `name`; optional `lines` (default 80), `machine`. A local Pi's last reply from its session file when idle, otherwise its screen, labeled as a screen read. |
| `wait` | `name`; optional `timeout_ms` (default 10 minutes), `machine`. Waits for the agent's turn to end, then reads it. Not for children. |
| `spawn` | Required `task`; optional `name`, `where`, `branch`, `model`, `thinking`, `focus`. |
| `interrupt` | A child's `name`; sends Escape to end its current turn. |
| `close` | A child's `name`; closes the pane, retaining the session file. |

The tool was called `herdr_child` before it reached agents other than children.

## Messages between agents

`herdr agent prompt` types a message as a bracketed paste and Enter. In a Pi with a draft, the message joins the draft and both are sent as one prompt; an open overlay takes the keys; a recognized dialog rejects the message; and the receiving model sees an ordinary user prompt.

Each interactive pi-herdr therefore has an **inbox**. It advertises the pane token `$inbox` (`v1:<pid>`); a sender also checks that the pid is in the pane's foreground, and sends nothing at all when the pane's Pi is suspended or covered by another program. The sender writes one bracketed paste whose payload starts with an invisible marker (base64 JSON with the message, its id and the sender), with no Enter. pi-tui hands a whole paste to terminal-input listeners before the editor, pi-vim or any overlay, so pi-herdr consumes it there, leaving the draft, cursor and Vim mode as they were, and delivers it with `pi.sendMessage` as a `herdr-message` naming the sender.

The receiver decides delivery from its own state: idle starts a turn; working steers or queues, as the sender asked; idle with a dialog open (`herdr:blocked`) holds the message until the dialog closes and tells the user. Held messages survive `/reload` and session switches in the receiving Pi. A working agent is never steered by default: `send` without `delivery` refuses. It acknowledges with a 60-second `$ack-<id>` token, which the sender's result reports. Without an acknowledgement in a few seconds, the result says the message was sent once and is unconfirmed.

Agents without an inbox (other agent kinds, older Pi) get `agent.prompt`, and the result says their draft was not protected. Replies from another machine or a non-Pi agent are screen reads that can cut a long reply short; the result says so, and the agent can ask for a file instead.

**Draft guard.** Prompts other programs type without an envelope (herdr-web-ui, Collie, other agent kinds, scripts) are handled on the receiving side. Only when the editor held a draft untouched for 3 seconds, Enter followed the paste within 0.7 seconds, and the paste landed in the main editor, pi-herdr takes the Enter, submits the pasted text itself (a new turn when idle, a steer while working) and leaves the draft in the editor, with a notice. An injected `/` or `!` command is not run over a draft; the draft is kept and a warning names it. `PI_HERDR_DRAFT_GUARD=0` disables the guard.

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

## Shared activity views

Interactive children are also an activity source for `/tasks` and FleetView (or pi-bg's fallback pill). Enter opens a read-only detail view without focusing or raising the child's pane. Double-`x` is available only for a child with an awaited turn: it sends an interrupt, **never closes the pane**. `herdr` `close` is the explicit pane-closing action. `/stop` remains pi-bg's shell-only command. Metadata and coordination continue to work without an activity host.

## Optional bridge integrations

Sibling plugins communicate through `pi.events`; they need no direct Herdr client. The bridge accepts `herdr:background`, `herdr:working` and `herdr:waiting` holds, `herdr:token`, `herdr:notify`, `herdr:zoom`, `herdr:split`, and `herdr:probe`. It emits `herdr:ready` so earlier token publishers can resend state.

pi-bg uses notifications and log-follow splits; pi-diff-review uses zoom and editor splits; pi-marimo publishes notebook tokens; pi-plan-mode publishes planner holds. These integrations are optional. Without an active bridge, those plugins retain their non-Herdr behavior. `herdr:blocked` is handled by Herdr's own Pi integration, not by this bridge.

For shared activity semantics, see [activity architecture](/architecture/activity/) and [background work](/recipes/background-work/). For missing tokens, check host mode, sidebar rows, and [troubleshooting](/guides/troubleshooting/) before assuming the underlying task stopped.

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-herdr) include the bridge, identity reporting, and child-session handling.
