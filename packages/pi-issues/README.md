# pi-issues

Start GitHub issues in linked-branch worktrees, and set issue statuses, by sequencing standard tools: `gh issue develop` links the branch to the issue on GitHub, `git worktree add` checks it out in `<repo>/.worktrees/<branch>`, one `setIssueStatus` call sets the issues In progress, and the agent opens the session there (with pi-herdr's `spawn` when Herdr runs). From then on GitHub's own links carry the issue: a pull request whose body says `Closes #N` moves it to In review, and its merge into the default branch closes it (Done). pi-issues keeps no state of its own.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-issues/>.

## Enable

Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`), preserving other entries:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-issues/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite entry; run `pi config` to keep only what you want, then `/reload`. Do not load a second copy alongside the suite.

## Use

- `/issue` picks an open issue (or `/issue 76 81` names them; Tab completes numbers), asks for the branch (Enter takes the suggestion), and asks the agent to start it.
- The `issue` tool: `action=start` with `issues` (and optional `branch`) links the branch, makes the worktree, sets In progress and returns the task for the worktree session; `action=status` sets a status by name (`Backlog`, `Todo`, `In progress`, `In review`, `Done`, `Not planned`), optionally in another `repo`.

The branch is the one given, else the issue's linked branch (or its open pull request's), else one the issue body's first lines name (``Branch `trip-day` ``), else a short slug of the title.

### Titles

Issue and pull request numbers in the agent's replies get their titles. When a reply finishes, the first mention of each reference is followed by its title: `#76` becomes `#76 (Library panel)`. It covers bare `#N` (this checkout's repository), `owner/repo#N` and bare github.com issue and pull request URLs, and skips code, `<next>` tags, mentions whose title is already nearby, and numbers GitHub does not know. Titles come from one batched GraphQL query through `gh` (5-second limit) and are cached for the session. The message is rewritten before Pi saves or sends it, so the model sees the titled text too and the prompt cache is unaffected. While a reply streams, numbers show without titles.

## Configure

Each repository's workflow comes from GitHub: new work starts from the default branch, and lands with `gh pr merge` using the first allowed method of rebase, merge and squash. A checkout's optional `.pi/issues.json` overrides it:

```json
{ "base": "dev", "land": "push", "task": "Run one e2e at a time on this machine." }
```

- `base`: the branch work starts from and pull requests target. When it is not the default branch, GitHub does not close issues on merge, and the task says to set them Done.
- `land`: `"merge"` (default) or `"push"`, a fast-forward of the base (`git push origin <branch>:<base>`), which GitHub records as the pull request's merge.
- `task`: text appended to every issue session's task; the session also reads the repository's AGENTS.md.

## Requirements

`gh` signed in with the `repo` scope, `git`, and network access. pi-herdr is optional; pi-tool-gate is optional (with it, the `issue` tool is a write: blocked in plan and chat workflows, judged in auto approval). No model calls of its own.
