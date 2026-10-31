---
title: Plan, implement, review
description: Compare plans deliberately, implement with a chosen context, then send precise diff feedback.
---
**Use:** [pi-plan-mode](/plugins/pi-plan-mode/) and [pi-diff-review](/plugins/pi-diff-review/). [Pi-rewind](/plugins/pi-rewind/) is an optional checkpoint companion, not a requirement.

## Plan the change

```text
/plan Add rate limiting to the public API
```

For a focused problem, plan mode in your own conversation is enough: your agent researches read-only, writes a plan file and asks you to approve it. Implement here with the current model, explicitly compact to the plan in the same session, or hand off to a distinct model while retaining the conversation. Workflow and approvals are independent: with [pi-tool-gate](/plugins/pi-tool-gate/), Alt+A toggles auto/yolo approvals, and Shift+Tab cycles workflows after remapping Pi's stock thinking shortcut.

When another approach is worth a second model session, use the planners screen instead:

```text
/planners Add rate limiting to the public API
```

On the Settings screen, choose the two real models available to your Pi installation and their effort levels.

On the Tools screen, review what planners may access. Jev can suggest a selection, but your choices win. Tools selected because of `alwaysOffer` remain preselected; “a classifier chose it” is not the same as an authorization review.

Planners have a read-only policy: ordinary file edits and writes are blocked, shell commands are checked, and MCP/tool access is narrowed. Explicit command grants and trusted tool choices widen that policy, so keep them deliberate.

## Compare before implementing

On the planners screen, **M is your existing main agent**, not a third independent planner. Each plan arrives in the main conversation, and M's pane joins the screen once both plans are in. You can ask M to compare trade-offs or question a planner using the active run’s tools.

Choose **Write plan M** to request a merged plan, then discuss and revise it. The main agent is instructed not to edit during planning, but is not forced into the planners’ read-only policy. If you need hard isolation, do not treat that instruction as an enforcement boundary.

Esc offers Hide, Stop planning or Back. Hiding keeps planners running. Reopen with `/planners`; do not assume a closed screen has cancelled paid work.

## Choose the implementation context

**Implement…** opens a page where you choose:

- The plan: M (first, once there is one), A or B.
- The mode and effort: **Here** uses the main session's current model; **Handoff** offers available distinct-model targets.
- For **Here**, **keep conversation** or explicitly **compact to plan (same session)**. Both use ordinary chat execution, without a consultant or completion review.
- For **Handoff**, **keep conversation** or an explicitly selected **fresh child** with only the implementation brief and plan. Handoffs enter exec mode with consultation and completion review; A or B stays on call for its plan, and plan M gets a seeded main-agent consultant even with keep-conversation context.

Current-session handoffs retain planning and implementation history, including consultations and review. On completion, the original main model is restored in place and the workflow returns to work, not plan, without changing approvals, compacting history or navigating back to a planning branch. `/plan-back` is explicit-only compatibility navigation for legacy saved return targets, not the normal completion path.

Only explicit compact/fresh choices replace context or create a child session. Normal manual and automatic compaction still apply; plan mode does not substitute a plan-only summary for them. Anything essential for compact or fresh context must be in the plan. Exporting a plan writes a Markdown file; configured completion hooks can also run at implementation/export time.

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

A suggestion is feedback for the agent, not an immediate patch application. If the agent is busy, the message is queued as a follow-up.

Marking is explicit. The review baseline, which decides where the next unreviewed diff starts, moves only when you type `:mark`. It records the snapshot on screen (not a fresh one, so changes made since the diff loaded stay unreviewed) and stays in the viewer with a confirmation. `:mark` works only in the live unreviewed and session scopes; elsewhere it explains why and stays open.

Closing never marks. `q`, Esc, `Q`, `ZQ`, `:q` and `:q!` close and keep drafts and file checks; `:wq`, `:x` and `ZZ` send drafts first, then close, also without marking.

Per-file `r` is separate from the baseline. It checks one file as reviewed, folds it and moves on. Checks are saved in the session and keyed to the diff you saw, so a check disappears when that file's changes change.

## Undo thoughtfully

Pi-rewind offers file restoration when you navigate to checkpointed entries with `/tree` or `/fork`. It does not create a separate checkout. Restoration rewrites differing files and deletes files created since the checkpoint; `/rewind-undo` can restore the state saved immediately before the last restore.

Both diff review and rewind use Git tree snapshots without altering HEAD, the real index or stash. With rewind enabled, diff review reuses its turn checkpoints; otherwise it creates its own. Git can eventually prune unreferenced tree objects, so keep commits or backups for durable recovery.
