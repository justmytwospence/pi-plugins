# pi-worktree

Start a task in its own git worktree under `<repo>/.worktrees/<branch>` and carry this conversation there. It is a `/worktree` command for you and a `worktree` tool for the agent.

- `/worktree new <branch> [--base <ref>] [--fresh]` fetches `origin`, creates the worktree from `--base` (default `origin/HEAD`, else `origin/main`, else `HEAD`) without an upstream, and continues this conversation there. `--fresh` starts an empty session instead of forking the conversation.
- `/worktree move <branch>` continues it in an existing worktree; `/worktree open <branch>` shows a worktree's latest session.
- `/worktree done [--force]` (inside a worktree) checks that the branch is merged (below), returns the conversation to the main checkout, and removes the worktree and branch.
- `/worktree ls` lists them.
- The `worktree` tool (`action`: `new`, `move`, `done`, `list`) does the same for an agent. A move the agent starts happens when its turn ends, and the moved session gets a one-line note to continue the task.

## Where the moved session runs

The conversation is forked into a session file whose working folder is the worktree. Where that session starts depends on who answers the `worktree:place` event:

- **pi-herdr** (inside Herdr) opens the worktree's grouped space, starts the forked session in a new pane there and closes this pane. Closing the last pane of a space may close that space.
- **No provider** and an interactive Pi: this terminal switches to the forked session in place, and project trust, settings and `AGENTS.md` follow the new folder.
- **Switchyard**: a session there stays in the workspace it started in, so an in-place switch is refused. `new` still creates the worktree; start a session in it from Switchyard.

A move is refused while background work (`herdr:background` or `herdr:working` holds: async subagents, planners, awaited children) is running, because closing the pane would end it. If placement fails, the session file is kept and its path is reported.

"Merged" means the branch's current commit is contained in `origin/HEAD` (origin's default branch, such as `main` or `dev`; else `origin/main`) after a fetch, which covers local merges, fast-forwards and merge-commit pull requests, or else a merged pull request whose head is that commit (squash merges), checked with a signed-in GitHub CLI (`gh`). `done` refuses uncommitted changes and, without `--force`, unmerged work.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-worktree/>.

## Install

Merge this object into the `packages` array of `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-worktree/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

To try it from a checkout: `pi -e ./packages/pi-worktree`.

## Development

```sh
npm ci
npm run check
```
