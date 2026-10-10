---
title: Plan, implement, review
description: Compare plans deliberately, implement with a chosen context, then send precise diff feedback.
---
**Use:** [pi-plan-mode](/plugins/pi-plan-mode/) and [pi-diff-review](/plugins/pi-diff-review/). [Pi-rewind](/plugins/pi-rewind/) is an optional checkpoint companion, not a requirement.

## Plan the change

```text
/plan Add rate limiting to the public API
```

Start with one planner for a focused problem. Add a second only if another approach is worth another model session. On the Settings screen, choose the real models available to your Pi installation and their effort levels.

On the Tools screen, review what planners may access. Jev can suggest a selection, but your choices win. Tools selected because of `alwaysOffer` remain preselected; “a classifier chose it” is not the same as an authorization review.

Planners have a read-only policy: ordinary file edits and writes are blocked, shell commands are checked, and MCP/tool access is narrowed. Explicit command grants and trusted tool choices widen that policy, so keep them deliberate.

## Compare before implementing

With two planners, **M is your existing main agent**, not a third independent planner. Each plan arrives in the main conversation. You can ask M to compare trade-offs or question a planner using the active run’s tools.

Choose **Write plan M** to request a merged plan, then discuss and revise it. The main agent is instructed not to edit during planning, but is not forced into the planners’ read-only policy. If you need hard isolation, do not treat that instruction as an enforcement boundary.

Esc offers Hide, Stop planning or Back. Hiding keeps planners running. Reopen with `/plan`; do not assume a closed screen has cancelled paid work.

## Choose the implementation context

When selecting Implement A, B or M, choose:

- The model and effort for implementation.
- **Keep:** the current conversation plus the chosen plan.
- **Fresh:** a new session with the plan as its starting context.

Keeping the conversation preserves the discussion. Fresh context avoids carrying the entire exploration, but anything essential must be in the plan. Exporting a plan writes a Markdown file; configured completion hooks can also run at implementation/export time.

## Review actual files

After implementation, use:

```text
/diff
```

The default is unreviewed changes: since the last review, or session start. More explicit scopes:

```text
/diff turn
/diff session
/diff staged
/diff branch main
```

`branch main` compares the working tree to the merge base with `main`; it is not limited to staged changes. Untracked, non-ignored files are included even when reviewing other scopes.

Inside the viewer:

1. Move between hunks with `]c`/`[c` and files with `]f`/`[f`.
2. Press `c` to leave a comment, or select lines and use `s` for a suggested edit.
3. Send all drafts together with `:w`, `:wq` or `ZZ`.
4. Read the agent’s attached replies in the next review.

A suggestion is feedback for the agent, not an immediate patch application. If the agent is busy, the message is queued as a follow-up. Ordinary `q`/Esc marks what you saw as reviewed in unreviewed/session scopes; `Q` or `:q!` leaves without doing so.

## Undo thoughtfully

Pi-rewind offers file restoration when you navigate to checkpointed entries with `/tree` or `/fork`. It does not create a separate checkout. Restoration rewrites differing files and deletes files created since the checkpoint; `/rewind-undo` can restore the state saved immediately before the last restore.

Both diff review and rewind use Git tree snapshots without altering HEAD, the real index or stash. With rewind enabled, diff review reuses its turn checkpoints; otherwise it creates its own. Git can eventually prune unreferenced tree objects, so keep commits or backups for durable recovery.
