---
title: pi-worktree
description: Start each task in its own git worktree, move the conversation there, and remove the checkout once its pull request has merged.
plugin: pi-worktree
---

## Quick reference

- **Use it for:** Starting each task in its own git worktree under `.worktrees/`, moving this conversation there, and removing the checkout once its pull request has merged.
- **Enable:** Select `packages/pi-worktree/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/worktree new <branch> [--fresh]`, `/worktree open <branch>`, `/worktree done [--force]`, `/worktree rm <branch> [--force]`, `/worktree prune`, `/worktree ls`. No model tool, no shortcut.
- **Settings:** None. New branches start from `origin/HEAD` (else `origin/main`, else `HEAD`) without an upstream.
- **Requirements, cost & privacy:** Git, and a signed-in GitHub CLI (`gh`) to recognise merged pull requests. `git fetch` and `gh pr list` contact the remote; no inference.
- **Integrations & limits:** "Merged" means a merged pull request whose head is the branch's current commit, so without `gh` nothing is pruned and `done` needs `--force`. Worktrees in use by a live Pi session are locked with `git worktree lock` and never removed. pi-subagents' `subagent-*` worktrees are left alone. Moving uses Pi's own session switch, so project trust, settings and `AGENTS.md` follow the new folder.

## How it works

`/worktree new <branch>` fetches `origin`, fast-forwards a clean main checkout that sits on the default branch, and creates `<repo>/.worktrees/<branch>` (slashes become dashes) from `origin/HEAD` with `git worktree add --no-track`, so `git push` never targets the default branch by accident. It then forks the current conversation into a session file whose working folder is the new checkout and switches to it: the same terminal, the same conversation, a new folder. `--fresh` starts an empty session there instead. An existing local branch is checked out rather than recreated. `/worktree open <branch>` switches to the newest session of an existing worktree.

While a session runs in a worktree it holds `git worktree lock` with the reason `pi-worktree pid <pid> host <host>`, and releases it when it quits or moves elsewhere. A lock held by a process that no longer runs on this host counts as stale; any other lock is respected.

`/worktree done` runs inside a worktree once its pull request has merged. It refuses with uncommitted changes, checks the merge with `gh`, forks the conversation back into a session in the main checkout, switches there and then removes the worktree and its local branch (`git branch -D`, since squash merges are not ancestors). `--force` discards an unmerged branch after a confirmation.

`/worktree prune` removes every worktree under `.worktrees/` that is clean, merged and not in use. The same prune runs in the background when an interactive session starts in a repository with worktrees, at most once every ten minutes per repository (`<git-common-dir>/pi-worktree/last-prune`), and reports what it removed.

## Development

The component's check runs typechecking and Node tests for porcelain parsing, lock detection, merge detection, a real-git lifecycle (create without upstream, lock, remove, fast-forward, prune) and session-file forking. It does not drive a live TUI session switch.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-worktree)
