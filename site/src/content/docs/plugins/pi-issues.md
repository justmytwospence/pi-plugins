---
title: pi-issues
description: Start GitHub issues in linked-branch worktrees and set issue statuses, by sequencing gh, git and pi-herdr; GitHub's own links carry the issue after that.
plugin: pi-issues
---

## Quick reference

- **Use it for:** Seeing issue and pull request titles next to their numbers in the agent's replies; picking up a GitHub issue in its own branch and worktree, with the branch linked to the issue on GitHub and the issue marked In progress, and setting issue statuses without Projects field IDs.
- **Enable:** Select `packages/pi-issues/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/issue [number...]` (no number: pick an open issue; Tab completes numbers) asks for the branch and asks the agent to start it. The agent's `issue` tool: `action=start` (issues, optional branch) and `action=status` (issues, status name, optional `repo`).
- **Settings:** Optional `.pi/issues.json` in a checkout: `base` (default: GitHub's default branch), `land` (`"merge"`, the default, or `"push"`), `task` (text appended to every issue session's task).
- **Requirements, cost & privacy:** `gh` signed in with the `repo` scope, `git` and network access to GitHub. No model calls of its own; it reads issues (and the titles of those the agent mentions) and writes linked branches and issue statuses through `gh`.
- **Integrations & limits:** pi-herdr is optional: with it the agent opens the worktree session with `herdr action=spawn where=worktree`; without it, open a session in the checkout yourself. pi-tool-gate is optional: the `issue` tool is a write, so plan and chat workflows block it. pi-issues does not open pull requests, land branches, wait for CI or create cross-repository sub-issues; the session does those with `gh` and git as its task says.

## Enable

Choose `packages/pi-issues/src/index.ts` from the suite using [Install & select](/guides/install/). Installing the suite loads every entry by default; `pi config` narrows the selection, then `/reload` applies it. Do not load another copy of the component alongside the suite.

From a local suite checkout, try only this component for one run:

```sh
pi --no-extensions -e ./packages/pi-issues
```

## What happens

| Step | Who does it | Status |
|---|---|---|
| `issue action=start`: `gh issue develop <n> --base <base> --name <branch>`, then `git worktree add` in `<repo>/.worktrees/<branch>` | pi-issues | In progress (`setIssueStatus`) |
| The session works there, then opens a pull request whose body says `Closes #N` | the session, with `gh pr create` | In review (GitHub) |
| The branch lands in the default branch, by `gh pr merge` or a fast-forward push | the session, when you ask | Done, issue closed (GitHub) |

The branch is the one given, else the issue's linked branch (or the head branch of its open pull request), else one the issue body's first lines name (``Branch `trip-day` ``), else a short slug of the title. An existing worktree at that path is reused. A branch that already exists on GitHub but is not linked to the issue is refused, so a name is never taken over by accident.

When `base` is not the default branch, GitHub does not close issues on merge, and the task tells the session to set them Done with the `issue` tool. Repositories without issue statuses skip the status steps.

## Titles

Issue and pull request numbers in the agent's replies get their titles. When a reply finishes, the first mention of each reference is followed by its title: `#76` becomes `#76 (Library panel)`. It covers bare `#N` (this checkout's repository), `owner/repo#N` and bare github.com issue and pull request URLs, and skips code, `<next>` tags, mentions whose title is already nearby, and numbers GitHub does not know. Titles come from one batched GraphQL query through `gh` (5-second limit) and are cached for the session. The message is rewritten before Pi saves or sends it, so the model sees the titled text too and the prompt cache is unaffected. While a reply streams, numbers show without titles. A bare `#N` in prose that is not an issue ("the #1 cause") is annotated too when this repository has an issue with that number.

## Workflows

The defaults fit a repository whose pull requests merge into its default branch. A repository that integrates in a `dev` branch, made the default branch on GitHub, and lands by fast-forwarding it needs only:

```json
{ "land": "push" }
```

Repository-specific steps (checks, preview URLs, e2e rules) stay in its AGENTS.md, which the task tells the session to read; `task` adds a line every session should see.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-issues)
