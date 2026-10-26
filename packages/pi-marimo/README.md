# pi-marimo

Pi follows the [marimo](https://marimo.io) notebooks you are working in, so it knows what they look like and what they are doing without being asked. It shows what each notebook's kernel is running in the footer, places the notebooks' current state in the model's context when you send a prompt, and, in the TUI, offers a pill and a full-screen notebook view while a notebook is busy.

It only reads. It pairs with the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill, which is how the agent inspects and changes a notebook. It also follows [marimo-lens](https://marimo-team.github.io/marimo-lens/) selections, the results you point at in the browser, and offers to address them.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-marimo/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-marimo/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-marimo
```

Add `-ne` to disable your other discovered and configured extensions for that run (an explicit `-e` still loads). No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## Usage

### Footer

Example: `marimo: fit.py · running Data loading › Model fit (12s) · 2 queued · 1 error · also prep.py, plots.py`.

It names every followed notebook. The first is the current one, with what its kernel is doing: the running part is the markdown heading path the running cell sits under (or `cell <name>`), so you can tell roughly what is running. `also` names the others. The status is published with `ctx.ui.setStatus("marimo", text)`, so it appears in Pi's built-in footer and in any footer that shows extension statuses.

The shape is stable for footers that lay it out themselves: `marimo: <file>`, then ` · `-separated parts about the current notebook (a connection note such as `connecting`, `disconnected` or `not open`; `running <a › b> (<elapsed>)`; `<n> queued`; `<n> error(s)`), and last `also <file>, <file>`. [pi-status-footer](https://pi-plugins.vercel.app/plugins/pi-status-footer/) gives it a row of its own.

### Context

When you send a prompt, the state of every connected, followed notebook is taken once and placed right after that prompt for every model request of the turn. The current notebook comes first and in full: its outline (markdown headings), one line per code cell with what it defines, and what needs attention (running, queued, errors, stale, edited but not rerun, changed in the browser since Pi's last turn). The others follow as short outlines (headings down to `##`) with only the cells that need attention. When pi-bg is loaded and a notebook is running, the block also names the `bg_wait` ids, so the agent can wait inside its turn instead of ending it.

The block is never stored in the session, so the model sees only the current turn's copy and old copies never pile up. It is taken once per prompt and kept in the same place through the turn so that the model's thinking written after it stays valid: Anthropic drops a thinking block when anything before it changes. At the next prompt the old copy is gone, which drops that earlier turn's thinking once. The state can be a turn old while the agent runs cells; the agent sees their results through marimo-pair.

### Pill and notebook view (TUI)

While a notebook runs a cell or has cells queued, a pill under the prompt reads `1 notebook`, plus `1 failed` in the error color when a run broke cells, until your next typed message. Idle notebooks show no pill. When pi-subagents or pi-bg is loaded, the pill joins theirs instead of being drawn on its own (see below).

| pill key | action |
|---|---|
| `↓` (prompt empty, or cursor at the end of its last line) | select the pill; also `j` in pi-vim's idle Normal mode |
| Enter, `l`, `→`, or a mouse click | open the busiest notebook (running, else failed, else the current one) |
| Esc, `↑`, `k`, `h`, `←` | back to the prompt |

The notebook view (also `/marimo view`) is full screen under a banner that says it is not your main session: the notebook's outline, one line per code cell with its status, what it defines and its error, updated live. It keeps the running cell in view until you scroll.

| view key | action |
|---|---|
| `↑`/`↓`, `k`/`j` | scroll one line |
| PgUp, PgDn or Space | scroll one page |
| Home/`g`, End/`G` | top; end (End resumes following the running cell) |
| `x` twice | interrupt the kernel, as the stop button in the browser does; only while a cell runs or is queued |
| `o` | open the notebook in the browser (`open` on macOS, otherwise `xdg-open`) |
| Tab | next followed notebook |
| Esc, `q`, `h`, `←`, Ctrl+C | back |

Interrupting stops the running cell; marimo drops the queue behind it.

### `/marimo`

| command | |
|---|---|
| `/marimo` | a checklist of open notebooks (any number, from anywhere) to pin; pick to toggle, then Done; also offers Auto and Off |
| `/marimo auto` | follow every notebook open under Pi's working directory (the default) |
| `/marimo off` | follow nothing |
| `/marimo view` | open the busiest notebook in the notebook view |
| `/marimo show` | print the state block the model sees |
| `/marimo lens` | print the open Lens selections and the recently addressed ones |

The chosen mode is saved as a `pi-marimo` session entry and restored with the session.

### marimo-lens

[marimo-lens](https://marimo-team.github.io/marimo-lens/) is a widget that lets you mark part of a rendered result (a bar, a row, a region) and attach a note, as selection `S1`, `S2`, ... When a notebook has a Lens mounted, pi-marimo follows its selections from the same stream. It runs nothing in the kernel.

- **Context:** the state block lists each notebook's open selections: label, note, the producing cell and the heading it sits under, what was marked, and the image status. The latest addressed selections follow with their summaries. The block tells the agent to work through the marimo-lens skill that ships with the notebook's package (`import marimo_lens; help(marimo_lens.agent)` through marimo-pair), which reads the images and resolves the selections.
- **Footer:** open selections get a status of their own, key `marimo-lens`, so the `marimo` line does not grow: `lens: fit.py · S1 "make this blue" · S2 · also prep.py 1`. pi-status-footer draws it as a separate row. It is cleared when nothing is open.
- **Next prompt:** with [pi-next-prompt](https://pi-plugins.vercel.app/plugins/pi-next-prompt/), a selection you make while Pi is idle offers `Use Lens to address S1 in fit.py` (or `... my open selections in fit.py`) as ghost text. Tab fills it in; it is not sent. A selection made during a turn is offered when the turn ends, unless the turn addressed it. The offer goes out over Pi's event bus (`prompt:offer`); without pi-next-prompt nothing happens.
- **Pill and view:** selections made since your last message add `2 selections` to the pill. Enter opens that notebook. The notebook view lists open selections (`*` marks the current one) and the latest addressed ones above the outline, and tags each selected cell's row with its labels. pi-bg's `/tasks` row counts open selections.

Lens keeps its selections in a synced widget trait, which marimo sends to every frontend (`model-lifecycle` messages) and replays to late joiners. Selection images, agent activity and reveals do not travel there and are not read.

## How it works

marimo streams every kernel message to the browser over `/ws`, and the same stream over `/sse`. pi-marimo subscribes to each notebook session's `/sse` stream as a *kiosk* consumer: a read-only viewer that cannot run or edit code and never takes the notebook over from your browser. On connect marimo replays the session, and from then on pi-marimo receives the cell document, each cell's status and errors, and the dataflow graph. Outputs are dropped. Nothing runs in the kernel. It follows notebooks across page reloads (which change the session id) and server restarts.

**Which notebooks.** In `auto` mode it follows every notebook open under Pi's working directory, up to eight, found through marimo's server registry (`$XDG_STATE_HOME/marimo/servers`, default `~/.local/state/marimo/servers`, written by servers started with `--no-token`) and each server's `/api/sessions`. Notebooks inside a hidden directory under the working directory (`.worktrees/`, `.claude/worktrees/`: other checkouts) are left out. Token-protected servers are reached with `MARIMO_TOKEN`. `/marimo` pins a set instead.

**Which notebooks are this session's.** Following a notebook is not the same as showing it. The footer, the Lens line and offer, and the state in each turn's context cover only the notebooks this session uses: the pinned ones, or the ones its agent has worked in through marimo-pair (remembered in the session, so they survive a resume). A fresh session in a checkout where another session works in a notebook shows no footer; its context only names the other open notebooks, so the agent can pick one up when asked.

**The current notebook.** The current one, first in the footer and in full in context, is the one this session's agent last worked in: Pi's tool calls are read for marimo-pair commands (`execute-code.sh` or `marimo pair execute`, by `--file`, `--session`, or `--url` when only one followed notebook is on that server), including calls made from codemode scripts. Two Pi sessions in two notebooks therefore each keep their own current notebook. Before the agent has touched any, it is the one used most recently by anyone: a running cell first, then the latest cell run (replayed on connect, so history counts) or edit.

**Browser edits.** marimo does not echo an edit back to the consumer whose session id sent it, so pi-marimo connects under its own id and lets marimo find the session by file. When several sessions hold the same file (a closed tab's session can linger), that lookup would take the oldest, so it connects by the exact session id instead and does not see edits typed in the browser until they run.

## Configuration

| variable | |
|---|---|
| `MARIMO_TOKEN` | access token for token-protected marimo servers (sent as a bearer token; also used to interrupt) |
| `XDG_STATE_HOME` | where marimo's server registry is read (`$XDG_STATE_HOME/marimo/servers`) |

The follow mode (`auto`, pinned paths, `off`) is set with `/marimo` and stored per session. There is no settings file.

## Requirements and costs

- Running marimo servers listed in marimo's server registry (servers started with `--no-token` write it). `MARIMO_TOKEN` is sent to servers that need an access token.
- No model or classifier calls of its own; the state block adds tokens to each prompt's context while notebooks are followed (`/marimo off` stops that).
- It writes nothing to disk except the `pi-marimo` session entry.

## Optional integrations

Each is optional and goes through Pi's event bus; without the sibling nothing happens.

### pi-bg and pi-subagents

The notebooks are one more source in the activity protocol (`src/activity.ts`, copied verbatim into pi-bg, pi-subagents, pi-marimo, pi-herdr and pi-plan-mode).

- **[pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/)'s `/tasks`** lists followed notebooks beside the tasks and agents, tagged `notebook`: running while a cell runs or is queued, failed when its last run broke cells. Enter opens the notebook view, `x` twice interrupts the kernel, and `x` on an idle notebook clears its failure alert.
- **Pills.** With [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/), the pill ends its FleetView list (Enter opens the busiest notebook); with only pi-bg, it joins pi-bg's pill (`2 tasks · 1 notebook`, Enter opens `/tasks`). pi-marimo draws its own pill only when no host shows it.

### pi-bg's `bg_wait` and tasks

- **Waiting on a notebook.** While a followed notebook has a cell running or queued, it is outside work that `bg_wait` can wait on, under the id `marimo:` plus its path from the cwd (`marimo:nb.py`, `marimo:notebooks/fit.py`; absolute outside the cwd). pi-bg also accepts `marimo:fit.py` when only one notebook matches. The run ends as `done`, or `failed` when cells broke during it (errors already there when it began do not count), when the notebook stays disconnected for 8 seconds (a browser reload reconnects sooner and the run goes on), or when it is no longer followed; the summary says what the run took (`ran 4m12s · 1 error`).
- **Tasks that are notebooks.** A pi-bg task tied to a followed notebook gets its kernel state (`bg:annotate`): a `marimo edit nb.py` (or `marimo run`) service by the notebook it serves, resolved from the task's directory, and a job by the notebook its marimo-pair calls target. pi-bg shows the state in the task's row (`nb.py: running Model fit · 2 queued`, `nb.py: idle · 1 error`), lists the notebook under the task in `bg_logs`, and `bg_wait` on a server that is up waits for its running cells.
- **One notice per run.** When every notebook of a kernel hold (below) is driven by a pi-bg job that will wake the agent, the hold keeps its token but skips its "finished" notification: the wake-up already says so. If you stop that job, it wakes no one, so the notification comes back.

### pi-herdr

Inside a [Herdr](https://herdr.dev) pane with [pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/) (it does the Herdr work through its event-bus bridge, and only in an interactive Pi), a turn that ends while a notebook the agent worked in during that turn is still running or has cells queued starts a *kernel hold*. It lasts until every such notebook is quiet, disconnected or no longer followed, or until the next prompt. During it the pane token `marimo` names the file and what runs (`fit.py: Model fit`, or `fit.py: 3 queued`); add `$marimo` to a row in Herdr's `[ui.sidebar.agents]` to show it. At the end the token is cleared and a Herdr notification (for example `fit.py finished`, `ran 4m12s · 1 error`) plays the done sound, unless the pane is focused. The pane's state stays Herdr's own: pi-marimo only sets the token and sends the notification.

## Limitations

- Read-only: it never runs or edits cells or resolves Lens selections (the notebook view's interrupt is the one exception, on your keypress).
- In `auto` mode, at most eight notebooks are followed, only those under Pi's working directory and outside hidden directories.
- Only servers listed in marimo's server registry are followed.
- The context block can be a turn old while the agent runs cells.
- The pill and notebook view exist only in the TUI.
- `src/core/` is plain ECMAScript behind a small `Io` interface (`node-io.ts` for Node and Bun), shared with the opencode and Claude Code ports.

## Development

```sh
cd packages/pi-marimo
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and then `vitest run`, including an end-to-end test that starts `marimo edit --headless --no-token` on a scratch notebook; it is skipped when `marimo` is not on `PATH`. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
