---
title: pi-worktree
description: Start a task in its own git worktree, carry this conversation there, and remove the checkout once its branch has merged.
plugin: pi-worktree
---

## Quick reference

- **Use it for:** Starting a task in its own git worktree under `.worktrees/`, continuing this conversation there, and removing the checkout once its branch has merged into origin's default branch (or by pull request).
- **Enable:** Select `packages/pi-worktree/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/worktree new <branch> [--base <ref>] [--fresh]`, `/worktree move <branch>`, `/worktree open <branch>`, `/worktree done [--force]`, `/worktree ls`, and the model-callable `worktree` tool (`new`, `move`, `done`, `list`). No shortcut.
- **Settings:** None. New branches start from `--base`, else `origin/HEAD` (else `origin/main`, else `HEAD`), without an upstream.
- **Requirements, cost & privacy:** Git, and a signed-in GitHub CLI (`gh`) to recognise merged pull requests. `git fetch` and `gh pr list` contact the remote; no inference.
- **Integrations & limits:** [pi-herdr](/plugins/pi-herdr/) places a moved session in the worktree's Herdr space and closes the old pane (closing a space's last pane may close the space). Without a provider, an interactive Pi switches the session in place. A session run by Switchyard is not switched in place: the worktree is created and a session is started there from Switchyard. A move is refused while background work holds (async subagents, planners, awaited children) are active. "Merged" means a merged pull request whose head is the branch's current commit, so without `gh` `done` needs `--force`.

## How it works

`/worktree new <branch>` fetches `origin` and creates `<repo>/.worktrees/<branch>` (slashes become dashes) with `git worktree add --no-track`, so `git push` never targets the default branch by accident. An existing local branch is checked out rather than recreated. It then forks the current conversation into a session file whose working folder is the worktree (`--fresh`: an empty one) and asks a placement provider to start it. The provider answers the `worktree:place` event on Pi's event bus: pi-herdr opens a new pane in the worktree's grouped space and, once Pi runs there, closes the pane this conversation left. With no provider, Pi's own session switch moves the terminal. If placement fails, the worktree and session file are kept and reported.

The `worktree` tool defers the move until the turn has settled: the agent ends its turn with a short line, the move runs, and the moved session starts with a note that the conversation moved and the task continues. A turn that is aborted cancels the pending move.

`/worktree done` runs inside a worktree whose branch has merged. It refuses uncommitted changes, fetches `origin`, and accepts the branch when its current commit is contained in `origin/HEAD` (else `origin/main`): a local merge, fast-forward or rebase landing such as `bin/land`, or a merge-commit pull request. Otherwise it asks `gh` for a merged pull request whose head is that commit (squash merges). It then continues the conversation in the main checkout, and then removes the worktree and its local branch (`git branch -D`, since squash merges are not ancestors). `--force` discards an unmerged branch after a confirmation; the tool never forces.

## Development

The component's check runs typechecking and Node tests for porcelain parsing, merge detection, a real-git lifecycle (create without upstream, existing branch, remove), session-file forking, the placement contract, hold tracking, and the command and tool flows with a fake provider. It does not drive a live TUI session switch or a real Herdr.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-worktree)
