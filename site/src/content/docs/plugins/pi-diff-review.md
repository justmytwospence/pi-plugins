---
title: pi-diff-review
description: Review working-tree changes in Pi, leave line comments and suggested edits, and follow the agent's per-comment replies.
plugin: pi-diff-review
---

pi-diff-review adds `/diff`, a full-screen review surface for inspecting changes before asking the agent to revise them. Comments and suggested replacements remain drafts until you send them together. The resulting conversation is attached to review threads, so you can revisit both the changed lines and the agent's response.

## Enable, requirements, and costs

Select `packages/pi-diff-review/src/index.ts` using [suite installation](/guides/install/). The suite loads every entry by default; every selected entry shares one Git pin.

Review requires Git, a working directory inside a Git repository, and Pi's interactive terminal UI. RPC and print sessions cannot open the viewer. `$EDITOR` and an active pi-herdr bridge are needed only for opening a file in a separate editor pane, not for the review itself.

**Costs:** opening, navigating, and annotating a diff makes no model or classifier calls. Sending comments creates a normal user message and therefore consumes ordinary model usage when the agent responds. Local snapshots also consume filesystem and Git-object storage.

pi-rewind and pi-herdr are optional. The reviewer records its own checkpoints if pi-rewind is not loaded.

## Select the comparison

```text
/diff
/diff turn 2
/diff branch main
```

| Scope | Comparison |
| --- | --- |
| `unreviewed` | Last review mark, or first recorded session checkpoint, against the current working tree. |
| `turn [n]` | The selected turn's pre-checkpoint against its target; 1 is latest. |
| `session` | First recorded session pre-checkpoint against the working tree. |
| `head` | HEAD against the working tree. |
| `staged` | HEAD against the current index. |
| `branch [ref]` | Merge base with the supplied or discovered default branch against the working tree. |
| Another commit or ref | That revision's tree against the working tree. |

With recorded turns or a review mark, bare `/diff` selects unreviewed changes. With neither, it falls back to HEAD. Session and turn scopes need recorded checkpoints. Default-branch discovery uses `origin/HEAD`, then available main/master refs; it does not fetch a remote.

The latest turn uses the **current working tree** as its target, so changes made after that run can appear too. Older turns use their post-checkpoint, or the next pre-checkpoint when necessary. This is not per-author attribution: edits from a person or another process can be included in the same comparison.

Working-tree snapshots include untracked files while respecting Git ignore behavior for untracked content. The staged scope is specifically an index comparison; it does not add otherwise untracked files. Snapshots use Git tree objects and a temporary index for working-tree capture, without staging your changes into the real index, moving HEAD, or creating a stash.

## Navigate and annotate

| Keys | Action |
| --- | --- |
| `j` / `k`, Ctrl+D / Ctrl+U, `gg` / `G` | Move through the diff; counts such as `5j` work. |
| `]c` / `[c` | Next or previous hunk. |
| `]f` / `[f`, `}` / `{` | Next or previous file. |
| `/`, `n` / `N` | Search and move between matches. |
| `v` / `V` | Select lines. |
| `c` | Comment on a line, selection, hunk, or file header. |
| `s` | Rewrite selected lines into a suggested edit. |
| `e`, `x` or `dd` | Edit or delete the comment under the cursor. |
| `S`, `<` / `>` | Pick a scope or step through turns. |
| `t`, `w`, `b`, Tab | Toggle split/unified layout, wrapping, file list, or file-list focus. |
| `R`, `?` | Reload or show the full key reference. |

Use `za` or Enter to fold a file; Enter also expands an initially collapsed large file. `r` folds a file as reviewed for the current view and advances. `y` copies `path:line`; `:N` jumps to a new-side line number. Suggestions are review requests, not immediately applied patches.

## Send drafts and track replies

`:w` sends drafts and keeps the viewer open; `:wq`, `:x` or `ZZ` sends them and closes it. One user message contains the relevant hunks or replacement pairs and asks the agent to include a `[[dr:<id>]]` reply line per comment. If the agent is already working, this message is queued as a follow-up.

At the end of the agent's run, matching tagged replies attach to the corresponding threads as answered. An answer is not independent verification that the requested fix is correct; inspect the resulting diff. Missing or malformed reply tags can leave a thread without an attached answer even if the conversation contains prose about it.

Only `:mark` advances the review mark. It records the snapshot on screen, confirms the action and stays open, and it applies only to the live unreviewed and session scopes; in other scopes it reports why and stays open. Closing never marks: `q`, Esc, `Q`, `ZQ`, `:q` and `:q!` close with drafts and file checks kept, and `:wq`, `:x` or `ZZ` send drafts before closing. Per-file `r` is separate: it checks and folds one file, and the check is saved in the session keyed to that file's diff, so it is dropped when the file's changes change. Advancing a review mark resolves answered threads; drafts and unanswered comments remain. These marks describe review progress, not Git commits or approvals on GitHub.

Threads and marks are stored in Pi's session branch, so tree navigation, forks, and resumes retrieve their corresponding state.

## Settings and optional integrations

Settings live in `~/.pi/agent/diff-review.json` by default, or under `PI_CODING_AGENT_DIR` when set. Every key is optional; the defaults are:

```json
{
  "view": "auto",
  "splitMinWidth": 160,
  "wrap": true,
  "fileList": true,
  "maxFileLines": 1500,
  "context": 3,
  "zoom": true
}
```

`view` accepts `auto`, `split`, or `unified`. Auto chooses split at `splitMinWidth`; files exceeding `maxFileLines` diff lines begin collapsed. The file list is shown only when there is enough terminal width, at least 100 columns. Settings are reread when opening a review.

With pi-rewind, the reviewer reuses its turn checkpoints rather than recording duplicates. This does not require using rewind's restore actions. With pi-herdr, the viewer can temporarily zoom the pane and `o` opens the selected file and line in `$EDITOR` in a split. Without that bridge, review still works and the editor action reports its missing requirement.

## Limits and further reading

Patches over 32 MB are refused rather than rendered. A historical snapshot may become unavailable after Git garbage collection; session metadata is not a permanent backup of every Git object. Large-file folding improves navigation but does not override the total patch limit.

This viewer does not replace tests, stage files, publish reviews, or guarantee that an agent follows every suggestion. Use [planning and review](/recipes/plan-review/) for the broader workflow and [troubleshooting](/guides/troubleshooting/) for missing snapshots or host-mode problems.

The [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-diff-review) define comparison targets, review marks, and reply parsing.
