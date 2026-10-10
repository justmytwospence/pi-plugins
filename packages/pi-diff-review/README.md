# pi-diff-review

Review what the agent changed without leaving [pi](https://pi.dev), the way you
would review a pull request: a full-screen diff with vim keys, comments and
suggested edits on lines, sent back to the agent as one message, with the agent's
answer to each comment shown under it.

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

```sh
pi install git:github.com/justmytwospence/pi-diff-review
```

## Use

`/diff` opens the review. With no argument it shows everything you have not
reviewed yet: the changes since you last closed a review, or since the session
began. Other scopes, as an argument or from the `S` picker inside the review:

| Scope | Compares |
|---|---|
| `unreviewed` | your last review (or the session start) with the working tree |
| `turn [n]` | the files before and after one agent run (1 is the latest; `<` `>` step) |
| `session` | the session start with the working tree |
| `head` | HEAD with the working tree |
| `staged` | HEAD with the index |
| `branch [ref]` | the merge base with the default branch (or `ref`) with the working tree |
| any other word | that commit or ref with the working tree |

Untracked files are always included and ignored files never are. Every scope
compares two git tree snapshots, so HEAD, the index and the stash are never
touched, and commits made in between do not matter.

Turn boundaries come from [pi-rewind](https://github.com/justmytwospence/pi-rewind)'s
checkpoints when it is installed (it already snapshots the working tree before
each prompt and after each run); without it, this extension records the same
snapshots itself.

### Keys

| Keys | |
|---|---|
| `j` `k`, `ctrl+d` `ctrl+u`, `ctrl+f` `ctrl+b`, `gg` `G` | move (counts work: `5j`) |
| `]c` `[c` | next / previous hunk |
| `]f` `[f`, `}` `{` | next / previous file |
| `/`, `n` `N` | search |
| `v` `V` | select lines |
| `c` | comment on the line, the selection, a hunk header or a file header |
| `s` | suggest an edit: the selected lines open in an editor to rewrite |
| `e`, `x` (or `dd`) | edit / delete the comment under the cursor |
| `:w`, `:wq` or `ZZ` | send the drafts to the agent (and close) |
| `q`, `esc` | close; in the unreviewed and session scopes this marks what you saw as reviewed |
| `Q`, `:q!`, `ZQ` | close without marking anything reviewed |
| `r` | mark a file reviewed for now: it folds and the cursor moves to the next file |
| `za`, `enter`, `zM` `zR` | fold files; `enter` also shows a large file kept collapsed |
| `S`, `<` `>` | pick the scope; step one turn older / newer |
| `t`, `w`, `b`, `tab` | split or unified, wrap, the file list, focus the file list |
| `o` | open the file at the line in `$EDITOR`, in a herdr split |
| `y` | copy `path:line` |
| `R` | reload |
| `:N`, `:scope <scope>`, `:mark` | go to new-side line N, switch scope, mark reviewed now |
| `?` | all keys |

### Comments and replies

Comments are drafts until you send them. Sending writes one user message that
quotes each commented hunk (or the replace/with pair for a suggested edit) and
asks the agent to end its reply with one `[[dr:<id>]] ...` line per comment. When
the run ends, those lines are attached to their comments, which show as
`answered`; closing your next review marks the answers resolved. If the agent is
busy, the message is queued as a follow-up. Comments and review marks are stored
in the session, so `/tree`, `/fork` and resumes see the matching state.

### herdr

Inside [herdr](https://herdr.dev), with
[pi-herdr](https://github.com/justmytwospence/pi-herdr) installed, the review
zooms pi's pane while it is open (the zoom is lifted again on close). `o` opens
the file in `$EDITOR` in a split beside pi when the pane is wide (at least 2.2
times as many columns as rows and 161 columns), else below it. Both go through
pi-herdr's event-bus bridge (`herdr:zoom`, `herdr:split`); without it the review
does not zoom and `o` says what it needs.

## Settings

`~/.pi/agent/diff-review.json`, every key optional:

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

`view: "auto"` uses side-by-side when the terminal is at least `splitMinWidth`
columns wide. Files with more than `maxFileLines` diff lines start collapsed.

## Develop

```sh
npm ci
npm run check   # typecheck and tests
pi -e ./src/index.ts
```
