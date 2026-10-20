---
title: pi-herdr
description: Connect interactive Pi sessions to Herdr metadata, notifications, pane actions, and persistent child conversations.
plugin: pi-herdr
---

## Quick reference

- **Use it for:** Add pane metadata and deliberate human-accessible child sessions inside Herdr.
- **Enable:** Select `packages/pi-herdr/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `herdr_child` spawn/send/read/list/interrupt/close. No global shortcut; child activities offer read-only inspection.
- **Settings:** No plugin JSON settings. Child location: tab; focus: false; model/effort inherit the parent. `PI_HERDR_PR=0` disables PR polling; `PI_HERDR_SUMMARY=0` disables the summary model call, `PI_HERDR_SUMMARY_MODEL` picks its model.
- **Requirements, cost & privacy:** Interactive Herdr socket/pane, Pi/provider access for children; Git for worktrees, `gh` for PRs. Herdr socket operations create/open checkouts; no external worktree CLI. The `$summary` line is one small Haiku request per settled turn; children are paid sessions.
- **Integrations & limits:** Optional event-bus bridge and `/tasks`/FleetView child entries. An activity stop interrupts an awaited turn, never closes the pane. Herdr itself owns pane state.

pi-herdr adds Pi-specific metadata and an event-bus bridge inside Herdr. It complements Herdr's own Pi integration rather than replacing it: Herdr's integration owns working, blocked, and idle state, while this plugin adds background labels, presentation, pull-request status, and interactive children.

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

The session name, or the first prompt's first line, becomes the pane title and `$task`. The displayed agent name includes model and effort. `$pr` is a space token describing the checkout branch's PR, refreshed at session start, after turns, and every three minutes. Set `PI_HERDR_PR=0` to disable PR reporting.

`$summary` is one line (at most 80 characters) on what the last turn did or what the agent waits on, for notification tools such as herdr-native-notify. As a turn settles, a small model summarizes the prompt, tool calls, and final reply, before Pi reports the turn finished (about 1-2 seconds, capped at 4). A one-line reply is used as is; without a model, or on an error, timeout, or interrupted turn, the reply's first sentence stands in. While a dialog holds `herdr:blocked`, the token is its question (a pending `ask_user_question`'s first question, else the dialog's label). It is cleared as each run starts.

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

## Interactive child tool

`herdr_child` manages ongoing, human-accessible sessions. Use it for a deliberate handoff that someone can continue, not merely because a report-back task is lengthy. Headless pi-subagents are the simpler choice for bounded delegated work.

| Action | Arguments |
| --- | --- |
| `spawn` | Required `task`; optional `name`, `where`, `branch`, `model`, `thinking`, `focus`. |
| `send` | `name` and `message`; the reply is delivered automatically. |
| `read` | `name`; optional `lines` controls screen capture while working, default 80. |
| `list` | Lists this session's children and their state. |
| `interrupt` | `name`; sends Escape to end the child's current turn. |
| `close` | `name`; closes the pane, retaining the session file. |

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

Interactive children are also an activity source for `/tasks` and FleetView (or pi-bg's fallback pill). Enter opens a read-only detail view without focusing or raising the child's pane. Double-`x` is available only for a child with an awaited turn: it sends an interrupt, **never closes the pane**. `herdr_child close` is the explicit pane-closing action. `/stop` remains pi-bg's shell-only command. Metadata and coordination continue to work without an activity host.

## Optional bridge integrations

Sibling plugins communicate through `pi.events`; they need no direct Herdr client. The bridge accepts `herdr:background` and `herdr:working` holds, `herdr:token`, `herdr:notify`, `herdr:zoom`, `herdr:split`, and `herdr:probe`. It emits `herdr:ready` so earlier token publishers can resend state.

pi-bg uses notifications and log-follow splits; pi-diff-review uses zoom and editor splits; pi-marimo publishes notebook tokens; pi-plan-mode publishes planner holds. These integrations are optional. Without an active bridge, those plugins retain their non-Herdr behavior. `herdr:blocked` is handled by Herdr's own Pi integration, not by this bridge.

For shared activity semantics, see [activity architecture](/architecture/activity/) and [background work](/recipes/background-work/). For missing tokens, check host mode, sidebar rows, and [troubleshooting](/guides/troubleshooting/) before assuming the underlying task stopped.

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-herdr) include the bridge, identity reporting, and child-session handling.
