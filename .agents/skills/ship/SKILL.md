---
name: ship
description: Ship the current pi-plugins task branch: rebase, check, open a squash auto-merge pull request, wait for the merge, roll the suite pin forward for runtime changes, then hand back /worktree done. Use only when the user asks to ship.
---

# Ship a pi-plugins task branch

GitHub merges; this session only prepares, waits and rolls out. Never push to `main`, merge by hand, or touch another session's worktree.

1. **Preconditions.** You are in `<repo>/.worktrees/<branch>` (not the main checkout, not `main`), and the user asked to ship. Commit any remaining task changes with conventional commits. If unrelated files are dirty, stop and ask.
2. **Rebase.** `git fetch origin && git rebase origin/main`. Resolve conflicts here, never in the main checkout.
3. **Checks.**
   - Root: `npm test`.
   - Each component touched by `git diff --name-only origin/main...HEAD` under `packages/<name>/`: `npm ci && npm run check` in that directory.
   - When `site/`, a README or component docs changed: `npm --prefix site ci && npm --prefix site run check && npm --prefix site run build`.
   - When dialogs, the footer, below-editor widgets or Sidebar layout changed: `npm run check:clients` (AGENTS.md, "Remote clients").
4. **Push** the task branch: `git push --force-with-lease -u origin HEAD`.
5. **Pull request.** Reuse an open one (`gh pr view --json number,state`). Otherwise: `gh pr create --base main --title "<conventional commit subject for the whole task>" --body "<what changed, checks run, footer assessment>"`. The title becomes the squash commit's subject, so it must be a conventional commit.
6. **Auto-merge:** `gh pr merge --auto --squash`.
7. **Wait for the merge.** In Pi, start a `bg_run` job (`timeout` 2700) and `bg_wait` on it; in other harnesses run the same command in the foreground:

   ```sh
   gh pr checks <n> --watch --fail-fast --interval 20 && while :; do s=$(gh pr view <n> --json state --jq .state); [ "$s" = MERGED ] && exit 0; [ "$s" = CLOSED ] && exit 2; sleep 15; done
   ```

   Failing checks: fix, commit, return to step 3. A merge conflict: return to step 2.
8. **Rollout.**
   - `git fetch origin`; `SHA=$(git rev-parse origin/main)`.
   - `P` is the commit in the `git:github.com/justmytwospence/pi-plugins@<P>` spec in `~/Projects/dotfiles/home/private_dot_pi/private_agent/settings.managed.json`.
   - If `P` equals `SHA`, or `git merge-base --is-ancestor SHA P` holds, the pin is already current: skip the rest of this step. The pin only ever moves forward.
   - It is a runtime change if `git diff --name-only P SHA` lists any file outside `site/`, `.github/`, `.agents/`, `.claude/` and `*.md`. Documentation-only changes need no pin bump.
   - For a runtime change, read `~/Projects/dotfiles/AGENTS.md` and its chezmoi skill and follow its landing policy: create a dotfiles worktree from `main` (for example `git -C ~/Projects/dotfiles worktree add -b pi-pin-<sha7> ~/Projects/dotfiles/.worktrees/pi-pin-<sha7> main`), set the spec to `SHA` there (preserve every other change in that file), commit only that change as `chore(pi): bump pi-plugins to <sha7>`, then run `bin/land --remove` from that worktree. It checks, pushes, applies and syncs the NUC.
   - Verify `git -C ~/.pi/agent/git/github.com/justmytwospence/pi-plugins rev-parse HEAD` equals `SHA` here and over `ssh spencer@nuc`.
   - Report reloads as AGENTS.md describes (the converge script's reload request; sessions with drafts stay pending).
9. **Finish.** Report the pull request URL, the merged commit, the checks run and the rollout state. End with `<next>/worktree done</next>`.
