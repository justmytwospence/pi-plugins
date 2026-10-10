---
title: pi-herdr
description: Connect interactive Pi sessions to Herdr metadata, notifications, pane actions, and persistent child conversations.
plugin: pi-herdr
---

pi-herdr adds Pi-specific metadata and an event-bus bridge inside Herdr. It complements Herdr's own Pi integration rather than replacing it: Herdr's integration owns working, blocked, and idle state, while this plugin adds background labels, presentation, pull-request status, and interactive children.

## Enable, requirements, and costs

Follow [suite installation](/guides/install/) and select `packages/pi-herdr/src/index.ts`. All 19 suite extensions load by default; selected entries share one Git pin.

The bridge requires an interactive Pi terminal session inside Herdr with a reachable Herdr socket and pane identity. Herdr's own Pi integration supplies pane state and session paths used for child replies. Outside Herdr, the extension registers nothing. RPC and print sessions do not report metadata or expose the child tool, even when they inherit a parent's pane environment.

Additional requirements depend on the feature:

- Pull-request metadata uses `gh pr view`, so it needs GitHub CLI access and appropriate authentication. Missing `gh` disables that reporting.
- Interactive children need a runnable Pi and credentials for their chosen provider.
- Worktree children need the `worktree` helper and a Git checkout.

**Costs:** metadata and event bridging do not call a model. Children are normal Pi sessions with their own model usage, and delivered replies can start parent turns. PR refreshes also make GitHub API requests.

## Pane and space metadata

The `$bg` pane token summarizes background holds such as async subagents or pending child replies. Its 90-second TTL is refreshed while held. A pane may correctly show idle while `$bg` names unfinished work; the token is not a replacement working-state flag.

The session name, or the first prompt's first line, becomes the pane title and `$task`. The displayed agent name includes model and effort. `$pr` is a space token describing the checkout branch's PR, refreshed at session start, after turns, and every three minutes. Set `PI_HERDR_PR=0` to disable PR reporting.

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

The default location is a new tab; `split` places it beside the parent. Both share the checkout. `worktree` requires `branch`, runs `worktree new <branch> --no-open`, and opens the checkout in its grouped Herdr space, reusing an existing space when available. Closing that child does not remove its checkout or branch.

Model and thinking default to the parent's choices, and focus defaults to false. Give a complete task: the child cannot see the parent conversation.

## Replies and persistence

Each reply to a parent-sent task or `send` message arrives as a `herdr-child` message, read from the child's session file and triggering a parent turn. Do not poll the screen to discover completion. Messages the user types directly into the child's pane do not produce automatic parent replies.

Pending replies hold `herdr:background`. Child records are saved in the parent session, allowing listing, sending, and pending-reply tracking after restart or resume. This is coordination state, not a guarantee that an externally closed pane can be recovered automatically.

## Optional bridge integrations

Sibling plugins communicate through `pi.events`; they need no direct Herdr client. The bridge accepts `herdr:background` and `herdr:working` holds, `herdr:token`, `herdr:notify`, `herdr:zoom`, `herdr:split`, and `herdr:probe`. It emits `herdr:ready` so earlier token publishers can resend state.

pi-bg uses notifications and log-follow splits; pi-diff-review uses zoom and editor splits; pi-marimo publishes notebook tokens; pi-plan-mode publishes planner holds. These integrations are optional. Without an active bridge, those plugins retain their non-Herdr behavior. `herdr:blocked` is handled by Herdr's own Pi integration, not by this bridge.

For shared activity semantics, see [activity architecture](/architecture/activity/) and [background work](/recipes/background-work/). For missing tokens, check host mode, sidebar rows, and [troubleshooting](/guides/troubleshooting/) before assuming the underlying task stopped.

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-herdr) include the bridge, identity reporting, and child-session handling.
