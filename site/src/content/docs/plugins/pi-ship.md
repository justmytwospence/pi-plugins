---
title: pi-ship
description: Watch CI after pushes and run /ship (check, tidy, review, human gate, publish) as fixed steps; findings come from pi-subagents reviewers, verified by System 1 and shown as draft comments in /diff.
plugin: pi-ship
---

## Quick reference

- **Use it for:** Knowing that a push went red without watching it, and publishing a change through the same steps every time: your check, a review of the risky parts, a stop for the files that need your eyes, then the publish command.
- **Enable:** Select `packages/pi-ship/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/ship` (and `/ship --dry` to print the steps). Watching has no command: it starts on its own after a successful `git push` through `bash`, shows as `N CI runs` in the activity views and in `/tasks` (`x` stops a watch), and `bg_wait ci:<sha>` waits for it.
- **Settings:** `~/.pi/agent/pi-ship.json`, overlaid by a repository's `.pi/pi-ship.json`: `check`, `publish`, `base`, `review` (`always`, `paths`, `lenses`, `threshold`, `maxFindings`), `humanPaths`, `ci` (`watch`, `ignore`, `maxRounds`), `system1`.
- **Requirements, cost & privacy:** `gh` signed in with access to the repository's Actions, `git`, network access. Reviewers are pi-subagents runs on your subscription models; each verified finding is one billed System 1 call. The diff hunks of findings go to the System 1 provider. `/ship` runs the repository's `check` and `publish` commands outside the tool gate.
- **Integrations & limits:** pi-subagents, pi-diff-review, pi-system1, pi-bg and the activity hosts are optional; see below. GitHub only. It never reruns or cancels a GitHub run and never fixes anything itself: a red CI wakes the agent with the failing logs.

## Enable

Choose `packages/pi-ship/src/index.ts` from the suite using [Install & select](/guides/install/). Installing the suite loads every entry by default; `pi config` narrows the selection, then `/reload` applies it. Do not load another copy of the component alongside the suite.

## After a push

When a `bash` call that ran `git push` succeeds and printed GitHub refs, pi-ship finds the commit's workflow runs (`gh run list --commit`) and follows them: it waits up to three minutes for runs to appear, polls every 30 seconds, and gives up after 90 minutes of CI still running.

| Outcome | What happens |
|---|---|
| Green (success, skipped, neutral or cancelled runs) | Nothing is sent. The red count for the branch resets. |
| Red | One message wakes the agent: the failing workflows, the last 60 lines of each failed-step log, and `git revert --no-edit <old>..<new>` (left out for a forced push). |
| Third red push in a row on a branch (`ci.maxRounds`) | The message says the agent is no longer woken for this branch until CI is green, and does not wake it. |
| No runs, or the 90-minute limit | Quiet; the entry in `/tasks` says why. |

A newer push to the same branch replaces the older watch. `ci.ignore` skips named workflows. Messages wait until the agent's turn has ended and are dropped when `bg_wait` already returned them.

## `/ship`

The steps run in this order and the stops are code:

1. **Base.** The range is the merge base with `base` (default: the upstream, else `origin/HEAD`) to `HEAD`. An empty range with the default publish stops.
2. **Check.** `check` runs; a failure wakes the agent with the output tail.
3. **Tidy.** `git tidy` runs when the range has `fixup!`, `amend!` or `squash!` commits.
4. **Review.** Runs with `review.always` or when the range touches a `review.paths` glob. One `reviewer` subagent per lens answers with JSON findings; they are de-duplicated, then judged against their diff hunk by one System 1 bool question each (kept at `review.threshold`, default 0.6; kept and marked unverified when System 1 cannot judge).
5. **Human gate.** With findings or files matching `humanPaths`, `/diff` opens on the range with the findings as draft comments, then you confirm the publish. Sending comments to the agent pauses the ship.
6. **Publish.** `publish` (default `git push`); a failure is reported without waking the agent.
7. **Watch.** The refs it pushed are watched as above.

`/ship --dry` prints the steps for the current configuration and runs nothing.

## Integrations

- **pi-subagents** starts the reviewers through `pi-plugins.subagents-run.v1`; without it the review is skipped with a note.
- **pi-diff-review** receives the findings through `pi-plugins.diff-review-comments.v1`; without it (or outside the TUI) they are listed in the confirmation.
- **pi-system1** supplies the verification transport; `system1.enabled: false` skips it.
- **[pi-bg](/plugins/pi-bg/)** and the activity hosts show each watch and let `bg_wait ci:<sha>` wait for it.

Both contract files are package-local copies, checked for byte identity by the suite's contract test.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-ship)
