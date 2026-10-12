# pi-diff-review

Review what the agent changed without leaving Pi, the way you would review a pull request: `/diff` opens a full-screen diff with vim keys, comments and suggested edits on lines, sent back to the agent as one message, with the agent's answer to each comment shown under it. It also records a review baseline, so the next `/diff` shows only what you have not reviewed yet.

It acts only when you run `/diff`, apart from recording working-tree snapshots around each agent run (when pi-rewind is not loaded) and attaching the agent's tagged replies when a run ends.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-diff-review/>.

Example (illustrative, not a real screenshot):

```
 diff  unreviewed, since your review 4m ago             2 files +2 -1  unified  ? help
 ▾ M app.py  +1 -1  ● 1 ──────────────────────────────────────────────────────────────
 @@ -3,4 +3,4 @@ def add(a: int, b: int) -> int:
 5 5   X = 2
 6   - Y = 4
●  6 + Y = 5
    ┃ you L6 answered
    ┃ make this 5 instead
    ┃ agent
    ┃ Changed `Y = 4` to `Y = 5` in `app.py`.
```

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-diff-review/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-diff-review
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## Scopes

`/diff [scope]` opens the review in Pi's terminal UI. With no argument it opens `unreviewed` when the session has recorded turns or a review mark, otherwise `head`. Other scopes, as an argument, with `:scope <scope>` inside the review, or from the `S` picker:

| Scope (aliases) | Compares |
|---|---|
| `unreviewed` (`new`) | your last review mark with the working tree; without a mark, the start of the first recorded turn; without turns, HEAD |
| `turn [n]` (`last`) | the files before and after one agent run (1 is the latest, whose "after" is the live working tree; `<` `>` step) |
| `session` (`all`) | the start of the first recorded turn with the working tree |
| `head` (`uncommitted`) | HEAD with the working tree |
| `staged` (`cached`, `--cached`, `--staged`) | HEAD with the index |
| `branch [ref]` | the merge base of HEAD and `ref` (default: `origin/HEAD`, else the first of `origin/main`, `origin/master`, `main`, `master` that exists) with the working tree |
| any other word | that commit or ref with the working tree |

Untracked files are included and ignored files never are. Every scope compares two git tree objects; the working tree is snapshotted through a temporary index, so HEAD, the staged contents and the stash are never changed, and commits made in between do not matter. A diff over 32 MB is refused.

Turn boundaries come from pi-rewind's `rewind-checkpoint` entries when pi-rewind is loaded (detected by its `/rewind-undo` command); without it, this extension records the same snapshots itself as `diff-review-checkpoint` entries, before each user message and when each agent run ends, only in sessions with a UI (pi-rewind likewise, unless `PI_REWIND_ALWAYS=1`).

## Marking reviewed

The review baseline (the `unreviewed` scope's starting point) is a `diff-review-mark` session entry holding the tree you last finished reviewing.

- Closing with `q`, `Esc`, `:q`, `Q`, `:q!` or `ZQ` never records a review mark. Drafts are preserved.
- `:wq`, `:x` and `ZZ` send drafts and close without recording a review mark; `:w` sends without closing.
- `:mark` explicitly records the displayed target snapshot in live `unreviewed` or `session` scopes, confirms the action and stays open. Historical, staged and branch views cannot advance the live review baseline.
- Recording a mark also turns comments the agent has answered into resolved ones, which are no longer shown. Drafts and unanswered comments stay.
- Per-file `r` is separate: it toggles a reviewed flag on one file in this viewer (a check mark in the file list), folds the file and moves to the next file not yet flagged; `r` again clears the flag and unfolds it. The flags are saved against the displayed file diff and invalidate when its content changes. They do not record a session-wide mark or change the baseline.

`Esc` first cancels a visual selection, then clears search highlights; only an `Esc` with neither closes the review.

## Keys

Keys inside the review, as the viewer implements them (`?` shows them; any key closes the help):

| Keys | |
|---|---|
| `j` `k`, Down Up | next / previous line (counts work: `5j`) |
| Ctrl+D Ctrl+U | half page down / up |
| Ctrl+F Ctrl+B, PageDown PageUp | page down / up |
| `gg` `G` | first / last line |
| `zz` | scroll so the cursor line sits a third of the way down |
| `]c` `[c` | next / previous hunk |
| `]f` `[f`, `}` `{` | next / previous file |
| `/`, `n` `N` | search (smart case), next / previous match |
| `v` `V` | start or end a line selection |
| `c` | comment on the line, the selection, a hunk header (the whole hunk) or a file header (the whole file) |
| `s` | suggest an edit: the selected lines open in an editor to rewrite |
| `e` (or Enter on a comment), `x` or `dd` | edit / delete the comment under the cursor |
| `:w` | send the drafts to the agent |
| `:wq`, `:x`, `ZZ` | send the drafts and close |
| `q`, `Esc`, `:q` | close (see [Marking reviewed](#marking-reviewed)) |
| `Q`, `:q!`, `ZQ` | close without marking |
| `r` | toggle the persisted, content-keyed file checklist item |
| `za` (or Enter on a file header), `zo`, `zc`, `zM`, `zR` | toggle, open, close the file's fold; fold or unfold all |
| Enter on a "large file" note | show a file kept collapsed because it is over `maxFileLines` |
| `S`, `<` `>` | pick the scope; one turn older / newer (newer than turn 1 is `unreviewed`) |
| `t`, `:split`, `:unified` | toggle or set split / unified view |
| `w`, `b` | toggle wrap, toggle the file list |
| Tab | focus the file list (`j` `k`, `g` `G`, Enter/`l`/`o` to jump, `r` to flag, Tab/Esc/`h`/`q` to leave) |
| `o` | open the file at the line in `$VISUAL`/`$EDITOR` (default `vi`) in a Herdr split |
| `y` | copy `path:line` |
| `R` | reload the current scope |
| `:N` | go to new-side line N in the current file |
| `:scope <scope>` | switch scope |
| `:mark` | mark the displayed eligible live snapshot and stay open |

The mouse wheel scrolls, and clicking a file in the file list jumps to it. In the `/` and `:` prompts, Enter runs, Esc cancels, Backspace on an empty prompt cancels and Ctrl+U clears the text. Comment editors use the optional suite editor factory, with native Pi fallback. Enter saves and the editor's newline bindings insert a new line. With Vim, the first Escape leaves Insert/Visual mode and a subsequent Escape returns to the viewer. Ctrl+U/D in text-entry states keep their editing meaning rather than scrolling the parent view. In the scope picker, `j` `k` move and `q` or Esc cancels.

## Comments and replies

Comments are drafts until you send them. Sending writes one user message that quotes each commented hunk as a diff (or the replace/with pair for a suggested edit) and asks the agent to end its reply with one `[[dr:<id>]] ...` line per comment. If the agent is idle the message is sent at once; if it is busy, it is queued as a follow-up. When the run ends, those tagged lines are attached to their comments, which show as `answered`; recording your next review mark resolves them. Editing a sent or answered comment makes it a draft again and drops the reply. A comment whose lines can no longer be found in the diff is shown as outdated.

Comments (`diff-review-threads`), review marks and checkpoints are stored in the session for the repository root, so `/tree`, `/fork` and resumes see the matching state.

## Configuration

`~/.pi/agent/diff-review.json` (`$PI_CODING_AGENT_DIR` honored), every key optional; invalid values are ignored. The defaults:

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

- `view`: `auto`, `split` or `unified`. `auto` uses side-by-side when the terminal is at least `splitMinWidth` columns wide.
- `wrap`: wrap long lines.
- `fileList`: show the file list beside the diff, on terminals 100 columns or wider.
- `maxFileLines`: files with more diff lines start collapsed.
- `context`: lines of context around each change.
- `zoom`: inside Herdr, zoom the pane while the review is open.

The file is re-read at session start and each time `/diff` opens.

## Requirements and costs

- `git` on `PATH`, and a working directory inside a git repository; `/diff` reports an error otherwise.
- Pi's interactive terminal UI for `/diff`; in other modes it only warns.
- No network access and no model calls of its own. Sending comments submits an ordinary user message to the agent.
- Snapshots write blob and tree objects into the repository's object database, including untracked, non-ignored files; temporary index files go in the system temp directory. Snapshots are unreferenced, so `git gc` can prune them after `gc.pruneExpire`; a scope whose snapshot is gone reports it.
- `y` uses Pi's clipboard helper.

## Optional integrations

- **pi-rewind**: when loaded, its checkpoints provide the turn boundaries and this extension stops writing its own.
- **Herdr with pi-herdr**: while the review is open it emits `herdr:zoom` (`{ active: true }`, then `{ active: false }`) so pi-herdr zooms Pi's pane (unless `zoom` is `false`). `o` sends `herdr:split` with the editor command; pi-herdr opens it beside Pi's pane when the pane is wide enough, otherwise below, and lifts the zoom while you edit. Whether pi-herdr is present is checked with `herdr:probe`; without it the review does not zoom and `o` says what it needs.

## Limitations

- One repository per session: the one containing Pi's working directory.
- Turns exist only for runs that were snapshotted, by this extension or pi-rewind.
- Replies are attached only when the agent ends its reply with the tagged lines.
- Only one review can be open at a time.

## Development

```sh
cd packages/pi-diff-review
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the vitest tests. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
