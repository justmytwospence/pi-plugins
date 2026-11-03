# pi-worktree

`/worktree` gives each task its own git worktree under `<repo>/.worktrees/<branch>` and moves the current conversation into it with Pi's own session switch: same terminal, new folder, and project trust, settings and `AGENTS.md` follow. No terminal multiplexer is involved.

- `/worktree new <branch> [--fresh]` fetches `origin`, creates the worktree from `origin/HEAD` without an upstream, and forks this conversation there (`--fresh`: an empty session).
- `/worktree open <branch>` switches to the newest session of an existing worktree.
- `/worktree done [--force]` (inside a worktree) checks that its pull request merged at the branch's current commit, moves the conversation back to the main checkout and removes the worktree and branch.
- `/worktree rm <branch> [--force]`, `/worktree prune` and `/worktree ls` manage the others.

A session holds `git worktree lock` on the worktree it runs in, so nothing removes a checkout in use. Clean, merged, unused worktrees are also pruned in the background when a session starts, at most every ten minutes per repository. Merge detection needs a signed-in GitHub CLI (`gh`).

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
