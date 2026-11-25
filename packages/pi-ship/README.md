# pi-ship

What happens after a change is written, as fixed code instead of agent guidance, in the spirit of Claude Ship's review, fix and approve loop:

- **CI follow-through.** After a `git push` the agent runs through `bash`, pi-ship follows that commit's GitHub Actions runs. Green is silent. Red wakes the agent once with a fixed message: the failing workflows, the tail of their failed-step logs and the exact `git revert --no-edit <old>..<new>` for the push. After three red pushes in a row on a branch it stops waking the agent and says so.
- **`/ship`.** Runs the repository's own publish steps in a fixed order: its check, `git tidy` when there are fixup commits, a review when the change touches paths you name, a human gate, the publish command, then the CI watch.
- **Review.** One pi-subagents `reviewer` per lens (correctness, security, tests, docs) reads the diff and answers with findings as JSON. Each finding is then judged against its diff hunk by a typed System 1 question, and only those at or above the threshold reach you, as draft comments in pi-diff-review's `/diff`.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-ship/>.

## Enable

Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`), preserving other entries:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-ship/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite entry; run `pi config` to keep only what you want, then `/reload`. Do not load a second copy alongside the suite.

## Use

- **Watching** needs no command. A `git push` that succeeded through the `bash` tool and printed GitHub refs starts a watch (`1 CI run` in the activity views under the prompt and in `/tasks`; `bg_wait ci:<sha>` waits for it). A newer push to the same branch replaces the older watch. Pushes that print nothing to read (some wrapper scripts) and pushes through `bg_run` are not seen; `/ship` watches what its own publish command pushed.
- **`/ship`** runs the steps below. `/ship --dry` prints them without running anything.
  1. **Base.** The range is everything since the merge base with `base` (default: the branch's upstream, else `origin/HEAD`). An empty range with the default `git push` publish stops with "nothing to publish". Uncommitted files are not part of the ship and are reported at the end.
  2. **Check.** `check` runs through `bash -c`. A failure wakes the agent with the output tail and stops.
  3. **Tidy.** `git tidy` runs when a commit in the range is a `fixup!`, `amend!` or `squash!`.
  4. **Review.** With `review.always`, or when the range touches a `review.paths` pattern, one reviewer per `review.lenses` runs through pi-subagents. Findings are de-duplicated (same file within two lines), judged by System 1 (kept at `review.threshold` or above; kept and marked unverified when System 1 cannot judge), capped at `review.maxFindings`, and sent to pi-diff-review as draft comments tagged `[ship · lens · severity]`.
  5. **Human gate.** When there are findings or the range touches `humanPaths`, `/diff` opens on the range with the comments, and then you are asked to confirm the publish. Comments you send to the agent pause the ship: run `/ship` again after the fixes. A gate that needs you and has no UI stops.
  6. **Publish.** `publish` runs through `bash -c` (default `git push`). A failure is reported without waking the agent.
  7. **Watch.** The refs the publish command pushed are watched; when it prints none, `HEAD` on the `origin` remote is.

The steps and stops are code. The agent is woken for a red check, a red CI, or review comments you chose to send, and never decides whether to review, ask you or publish.

## Configure

`~/.pi/agent/pi-ship.json`, with a repository's `.pi/pi-ship.json` on top (objects merge). Every key is optional; these are the defaults:

```json
{
  "check": "",
  "publish": "git push",
  "base": "",
  "review": { "always": false, "paths": [], "lenses": ["correctness", "security", "tests", "docs"], "threshold": 0.6, "maxFindings": 20 },
  "humanPaths": [],
  "ci": { "watch": true, "ignore": [], "maxRounds": 3 },
  "system1": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 5000 }
}
```

- `review.paths` and `humanPaths` are git pathspec globs (`:(glob)`): `packages/pi-tool-gate/**`, `packages/*/src/system1.ts`.
- `ci.ignore` names workflows that never count (deploys, releases, docs).
- `system1.enabled: false` skips the verification: every finding is shown, marked unverified.

This repository's own file:

```json
{
  "check": "npm run -s check:changed",
  "review": { "paths": ["packages/pi-tool-gate/**", "packages/*/src/system1.ts", "scripts/test-cache-prefix.mjs", "packages/pi-cache-guard/**"] },
  "humanPaths": ["scripts/release.mjs", ".pi/settings.json"],
  "ci": { "ignore": ["Docs"] }
}
```

## Requirements

`gh` signed in with access to the repository's Actions, `git`, and network access. pi-subagents (reviewers), pi-diff-review (findings as comments) and pi-system1 or a configured Jev key (verification) are optional: without pi-subagents the review is skipped with a note; without pi-diff-review the findings are listed in the confirmation; without System 1 the findings are shown unverified. The reviewers use your subscription models, and each verified finding is one billed System 1 call.

`/ship` runs `check` and `publish` itself, outside tool-gate: typing `/ship` is your consent to that repository's configured commands, and its `.pi/pi-ship.json` decides what they are, so read it before running `/ship` in a repository you did not write.

## Integrations

- **pi-bg and the activity hosts.** Each watch is `bg:external` outside work (`ci:<sha7>`, no `settle`) and an entry in the `ship` activity section: a pill in pi-subagents' list or pi-bg's pill, rows in `/tasks` (`x` stops the watch, never the GitHub run).
- **pi-subagents.** `pi-plugins.subagents-run.v1` (`src/subagents-run-contract.ts`), copied into both packages.
- **pi-diff-review.** `pi-plugins.diff-review-comments.v1` (`src/diff-review-contract.ts`), copied into both packages.
- **pi-system1.** `src/system1.ts` is the suite's package-local transport, byte-identical across packages.

Messages reach the agent as `followUp` messages after its turn ends, so they never change an earlier part of a request.
