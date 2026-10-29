# pi-marimo

Pi follows the [marimo](https://marimo.io) notebooks you work in with an agent, and gives you a terminal view of them that you read and steer in, so you need the browser much less. The agent edits cells through the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill; pi-marimo shows what each notebook's kernel is doing, puts the notebooks' state in the model's context when you send a prompt, and in the TUI lets you read the notebook (prose, tables, charts, variables, the agent's changes), run cells, drive widgets, run Python in the kernel, mark results for the agent, ask the agent about a cell, and start notebooks without a browser at all.

Cells are only ever changed by the agent. What you do in the view (running cells, interrupting, setting widgets, the scratchpad, Lens marks) goes through marimo's own kernel endpoints, as the browser's buttons do. pi-marimo also follows [marimo-lens](https://marimo-team.github.io/marimo-lens/) selections, the results you point at, whether you make them in the browser or in the view.

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

## Start a notebook from Pi

```text
/marimo new notebooks/fit.py
/marimo edit notebooks/prep.py
```

`/marimo new` writes an empty notebook and `/marimo edit` opens an existing one (without a file, `/marimo edit` offers the notebooks under the working directory; completion lists them too). Either way pi-marimo uses a session that already holds the notebook, opens one on a server that waits for it, or starts `marimo edit <file> --headless --no-token --skip-update-check` on a free port, then opens the notebook's session without a browser and shows it in the notebook view. The marimo command is `uv run marimo` when the working directory has a `uv.lock`, else `marimo` on the PATH; `server.command` in the settings names another.

A server Pi starts belongs to the Pi process: it keeps running across `/reload` and session switches and stops when Pi exits, with `/marimo stop` (a picker when there are several), or with `S` twice in its notebook view. A notebook opened this way is followed wherever it is (also outside the working directory, or in pinned mode) and counts as this session's.

## Usage

### Rows under the prompt (TUI) and footer lines (elsewhere)

In the TUI every notebook this session uses is a row under the prompt, in file-path order, as are running servers whose notebook is open in no browser and pinned files that are not open. Example:

```text
 ○ prep.py:2718 · idle
 ● fit.py:2718 · running Data loading › Model fit 0:12 · 2 queued
```

`↓` at the bottom of the prompt selects the rows (`j` in pi-vim's normal mode); `↑`/`↓` move, Enter opens the notebook view (a server open in no browser is opened here first), `x` twice interrupts a running notebook, Esc goes back. A row reads `✗` after a run broke cells, until your next message. With [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/) or [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/) the rows share the space with their tasks and agents, and `/tasks` lists the notebooks too.

Outside the TUI (RPC, print) the same is a footer line per notebook, through `ctx.ui.setStatus` under the keys `marimo`, `marimo-2`, ... in file-path order, for example:

```text
marimo: fit.py · :2718 · running Data loading › Model fit (12s) · 2 queued · 1 error: Model fit (KeyError)
marimo: prep.py · :2718 · not open
```

The shape is stable for footers that lay it out themselves: `marimo: <file>`, then ` · `-separated parts: its server (`:port` when local, else `host[/path]`), a connection note (`connecting`, `disconnected`, `not open`), `running <a › b> (<elapsed>)`, `<n> queued`, `<n> error(s)`. A waiting server's name is an OSC 8 link to it where the terminal shows links; `/marimo open` is the keyboard path. Open Lens selections get a status of their own, key `marimo-lens` (`lens: fit.py · S1 "make this blue" · S2`).

### Context

When you send a prompt, the state of every connected notebook this session uses is taken once and placed right after that prompt for every model request of the turn. The current notebook comes first and in full: its outline (markdown headings), one line per code cell with what it defines, and what needs attention (running, queued, errors, stale, edited but not rerun, changed in the browser since Pi's last turn, a widget you set from Pi). Every other notebook the agent worked in during the last three prompts is in full too; the rest are short outlines. Each notebook comes with its `marimo-pair: --url <server> --file <path>` line, the flags that name exactly that notebook, and its open Lens selections. Notebooks open under the working directory that this session does not use are only named, so the agent can pick one up when asked.

The block is never stored in the session and stays in the same place through the turn, so the model's thinking after it stays valid (Anthropic drops a thinking block when anything before it changes). It can be a turn old while the agent runs cells; the agent sees their results through marimo-pair. `"context": false` in the settings leaves it out.

A marimo-pair call that could mean more than one followed notebook (only `--url`, with several notebooks on that server) counts as work in none of them; pi-marimo adds a note to the tool's result with the flags for each candidate. With pi-bg, the block names the `bg_wait` ids of running notebooks.

### The notebook view (TUI)

`/marimo view` (or Enter on a row) opens a notebook full screen, under a banner that says it is not your main session, with a one-line header (kernel state, what the agent changed, when it last ran, the server's port) and two panes: an outline on the left and the selected cell on the right. It follows the running cell until you move.

The outline is the headings and one short line per code cell: its status, a title (its name, else what it defines that other cells use, else what it shows: `imports`, `daily, smooth`, `chart`, `controls`), and one badge at the end: how long it has run, `queued`, the error's type (`KeyError`), `blocked`, `stale`, `new` or `changed` (by the agent), else the output's shape (`1,204×8`, `chart`, `4 inputs`). Cell ids are never shown. The selected cell has an accent bar and Pi's selection background. The detail shows the cell as a reader wants it: prose rendered, the output large (tables are grids of the first page marimo sends; PNG figures, Vega-Lite and Plotly charts are drawn inline on terminals with Kitty graphics (Ghostty, herdr, Kitty), and Plotly figures run live there, see Optional integrations), an error with its traceback, the cell's widgets, its Lens selections, the code folded to `▸ code · 12 lines` (Enter opens it), and its dataflow by name (`uses df · used by plot`). `O` stacks the whole section in the detail, the way the notebook reads in a browser (`view.outputs` in the settings starts there); `O` again shows the cell alone. Variable values are in the `v` pane.

From 100 columns the panes sit side by side. Narrower (as when docked beside the chat), they stack like a mail app's list above its reading pane: a few outline rows with the selected cell in the middle, a rule, and the detail under it. An example of the side-by-side layout (not a real screenshot):

```text
╭─ ◀ esc · Notebook coffee.py · not your main session ─────────────────────────╮
│ coffee.py  idle                           ran 12s · 1 error · 2m ago · :2742 │
│ ──────────────────────────────────────────────────────────────────────────── │
│    imports                     │ drinks, sales · Coffee shop explorer › Data │
│    Coffee shop explorer        │                                             │
│      Data                      │ ▍ day         drink      cups  weekend      │
│ ▌    drinks, sales       450×4 │ ▍ 2026-01-01  latte        63  false        │
│      Controls                  │ ▍ 10 of 450 rows · 4 columns                │
│       drink, title +2 4 inputs │   sales = load_sales()  ⋯ +7                │
│     ✗ forecast        KeyError │                                             │
│ ──────────────────────────────────────────────────────────────────────────── │
│ ↑↓ cells · enter code · e next error                       ? keys · esc back │
╰──────────────────────────────────────────────────────────────────────────────╯
```


| key | |
|---|---|
| `j`/`k`, `↑`/`↓` | the next or previous cell |
| `ctrl+j`/`ctrl+k` (or `]` `[`) | the next or previous section |
| `n`/`p` | the next or previous part of the cell: error, printed output, output, controls, code (each markdown cell of a section); nothing is labeled: each part has a bar in its first column, and the focused one's turns into the accent `▌` |
| `^U`/`^D`, PgUp/PgDn, Space | scroll the detail; `g`/`G` the first or last cell |
| Enter, `l` | act on the focused part: open a table, a live chart or the controls, fold the code; with no part focused, open or fold the code, or edit a markdown cell |
| `t` | drive the cell's marimo table (below) |
| `O` | the whole section in the detail, or the cell alone |
| Tab (`z`) / Shift+Tab (`Z`) | fold the section the cursor is in / fold every section (again: unfold all) |
| `e`/`E` | the next or previous failed cell |
| `c`/`C`, `d` | the next or previous cell the agent changed; its diff |
| `<` / `>` | a cell this one uses (upstream), one that uses it (downstream) |
| `v` | the variables: name, type, value, defining cell, uses (Enter goes to the cell, `>` to the first use) |
| `/` | find a cell (or variable) by name, variable, code or error: the list narrows as you type, `ctrl+j`/`ctrl+k` move through the matches, Enter goes to one and shows everything again, Esc goes back |
| `f` | follow the running cell again |
| `r`, `R`, `A` | run the cell; every stale cell; every cell (the last two need a second press) |
| `x` | twice: interrupt the kernel, as the stop button does |
| `w` | drive the cell's widgets (below) |
| `:` | run Python in the kernel (below) |
| `a` | ask the agent about the cell (below) |
| `m`, `M` | mark the cell for the agent through Lens; `M` twice removes its mark |
| `i` | drive the selected cell's live chart from the keyboard |
| `o` | open the notebook in the browser |
| `S` | twice: stop the server (pi-bg's, or one Pi started) |
| `}`, `{` | the next or previous notebook |
| `?` | every key |
| `\|` | dock beside the chat, or back to full screen |
| `ctrl+]` | docked: switch between the chat and the notebook |
| `ctrl+'` | anywhere: dock the notebook this session uses, or close the docked one (pi-sidebar's key; with no notebook, or Sidebar open, it stays Sidebar's) |
| Esc, `q`, `h`, `←`, Ctrl+C | back to Pi (docked: Esc goes to the chat, `q` closes) |

The mouse wheel scrolls the pane under it, a click selects a cell (or a widget, or a part), a second click or a double click acts on it, and a click on the code folds or opens it.

A cell's code is a block on Pi's pending-tool background (a `│` gutter where the theme has none): folded, it is its first line, dimmed, with `⋯ +N` for the rest; Enter or a click opens it. Nothing in the detail is labeled; the parts read by their design: an error's red bar, a printed line's dim bar, an output's bar, the widgets' `◆`, the code's background.

#### Tables

`t` (or Enter on the `table` part) drives a `mo.ui.table` through the table's own kernel functions, as the browser does: paging, sorting, search and filters happen in marimo, so they work on tables of any size. The grid shows frozen, hidden, justified and wrapped columns, data types, cell styles, and a footer with the rows shown, the page, the sorts and the selection. Each table keeps its state (page, sort, search, filters, cursor) until its cell reruns.

| key | |
|---|---|
| `h`/`j`/`k`/`l` | move; past the page's edge the page turns |
| `[` `]`, `g`/`G`, `+`/`-` | previous or next page; first or last page; page size |
| `s`/`S` | sort by the column (off, ascending, descending); `S` adds it to the sorts |
| `/` | search; empty clears |
| `f`, `F` | filter the column (`> 5`, `1..10`, `in a, b`, `null`, `!null`, `~regex`, `^start`, `end$`, `!text` negates); clear filters and search |
| Space, `x` | select the row (or cell); the selection goes to the kernel, so cells that read the table rerun |
| Enter, `i` | the row as a card; the column's statistics, distribution and top values |
| `c` | column summaries with sparklines |
| `y`/`Y` | copy the cell or the row (OSC 52, needs a terminal that allows it) |
| `D` | save the whole table as CSV in Pi's working directory (never overwrites) |
| `r`, Esc | refresh; close the card, then leave |

#### Markdown

Markdown cells show only as rendered markdown. Enter edits one in the suite's editor (pi-vim when loaded); Enter saves, `esc` cancels. The edit is saved through marimo's code mode (as marimo-pair does), so the browser shows it at once, and it is not counted as an agent change. Markdown built in Python (`mo.md(f"...")`) cannot be edited here: Enter shows its code instead.

#### Docked beside the chat

`ctrl+'` docks the notebook this session uses (focused, back where you left it) and closes it again, from the chat or the notebook. `|` in the full-screen view docks the notebook beside the chat instead (and `|` again goes back to full screen), keeping your place. `/marimo split [file]` docks the busiest notebook, or the one named; with no file while docked it closes the split. With `view.split` set, Enter on a row and `/marimo view` open docked. When the agent starts running a notebook's cells while it works, the notebook docks by itself without taking focus (`view.autoSplit`); it does not when the split is already open, a full-screen view is open, pi-sidebar is open, or you closed the split since your last message. Runs you start from the browser never move your screen.

The chat reflows into its half, so you keep typing while the notebook runs. `ctrl+]` (or Herdr's `prefix+h`/`prefix+l`, with pi-sidebar's Herdr plugin) moves focus between the chat and the notebook, a click in a half focuses it, Esc in the notebook goes back to the chat and `q` closes the split. The notebook gets 55% of the width; drag the divider to resize (for the rest of the Pi process, not saved). While a Pi dialog is up the split collapses and the chat has the full width. [pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/) uses the same right-hand side: opening one closes the other. Docking needs Pi's fullscreen mode (`"tuiMode": "fullscreen"` in Pi's settings); otherwise the view opens full screen.

### Pairing from the view

- **Ask the agent (`a`).** A prompt docks at the bottom of the view (pi-vim's editor when it is loaded, else Pi's). Enter sends your message to the main agent with where you were looking: `(From pi-marimo's notebook view: about cell Hbol "fit" under "Model fit" in notebooks/fit.py. marimo-pair: --url … --file …)`. It goes in as a follow-up when the agent is working. The view stays open, so you watch the agent work through the notebook; the header says `agent working`.
- **The agent's changes.** Cells the agent changed through marimo-pair since your last message are marked (`changed by the agent`, `new from the agent`), counted in the header (`agent: 2 changed · 1 new · 1 removed`) and listed at the end when removed. `c`/`C` go to them, `d` shows a change as a diff. Any agent using marimo-pair counts, as marimo cannot tell sessions apart. They clear with your next prompt.
- **Widgets (`w`).** Sliders, numbers, range sliders, dropdowns, radios, multiselects, checkboxes, switches, text, dates and buttons can be driven from the view: `j`/`k` (or Tab) pick one, `h`/`l` change it (`H`/`L` ten steps), Space toggles or presses, Enter types a value; Esc is done. The mouse works too: press on a slider's bar sets it there and dragging moves it, a click toggles a checkbox or switch, presses a button, steps a number or a choice on its `‹` `›`, toggles a multiselect's option, and opens the prompt for a text or date; the wheel over the focused widget steps it. Each change reaches the kernel as moving it in the browser does (`set_ui_element_value`), so the cells that read it rerun, and the next context tells the agent what you set. Other widgets are named, with `o` to open the browser.
- **Scratchpad (`:`).** Python against the notebook's globals, in marimo's scratchpad (the endpoint `marimo pair execute` uses): nothing is saved and no cell changes. What it prints streams above the prompt, then its result (a table as a grid). Enter runs, the prompt stays for the next line; Esc while it runs cancels it, which makes marimo interrupt the kernel.
- **Lens marks (`m`).** With a Lens in the notebook (marimo-lens mounts one when it is installed), `m` asks for a note and makes a real Lens selection on the cell, with its picture when Pi has one (a PNG, or a chart Pi drew). It is Lens's like one made in the browser: it shows in the footer, the context and the browser, the agent's Lens skill reads and resolves it, and pi-next-prompt offers `Use Lens to address S3 in fit.py`. `M` twice removes the cell's latest selection. Without a Lens, `m` says so; `a` then asks about the cell instead.

### `/marimo`

| command | |
|---|---|
| `/marimo` | a checklist of open notebooks (any number, from anywhere) to pin; pick to toggle, then Done; also offers Auto and Off |
| `/marimo view [file]` | the busiest notebook (running, else failed, else the current one), or the one named, in the notebook view |
| `/marimo split [file]` | dock the busiest notebook, or the one named, beside the chat; again with no file: close it |
| `/marimo edit [file]` | open a notebook here, starting its server when none serves it |
| `/marimo new <file.py>` | create a notebook, start it and open it |
| `/marimo stop [file]` | stop a notebook server Pi started |
| `/marimo open` | open a notebook whose server waits in no browser, in the browser |
| `/marimo auto` | follow every notebook open under Pi's working directory (the default) |
| `/marimo off` | follow nothing |
| `/marimo show` | print the state block the model sees |
| `/marimo lens` | print the open Lens selections and the recently addressed ones |
| `/marimo chart <cell>` | put a cell's chart in the transcript |
| `/marimo inspect` | drive the newest transcript chart from the keyboard |

An unknown subcommand is named with the list. The follow mode is saved as a `pi-marimo` session entry and restored with the session, as are the notebooks this session works in and the ones it opened itself.

## How it works

marimo streams every kernel message to the browser over `/ws`, and the same stream over `/sse`. pi-marimo subscribes to each notebook session's `/sse` stream as a *kiosk* consumer: a read-only viewer that never takes the notebook over from your browser. On connect marimo replays the session; from then on pi-marimo receives the cell document, each cell's status, errors, console and output, the dataflow graph and the variable values. It follows notebooks across page reloads (which change the session id) and server restarts.

The view's actions are separate requests to the session's kernel endpoints, as the browser's buttons make them: `/api/kernel/run`, `/interrupt`, `/set_ui_element_value`, `/set_model_value` (a Lens command) and `/execute` (the scratchpad), with marimo's server token.

**Which notebooks.** In `auto` mode it follows every notebook open under Pi's working directory, up to eight (`maxNotebooks`), found through marimo's server registry (`$XDG_STATE_HOME/marimo/servers`, default `~/.local/state/marimo/servers`, written by servers started with `--no-token`) and each server's `/api/sessions`. Notebooks inside a hidden directory under the working directory (`.worktrees/`, `.claude/worktrees/`) or inside another Git repository below it (a directory of projects such as `~/Projects`, a submodule) are left out. Notebooks opened with `/marimo edit` or `/marimo new` are followed wherever they are. Token-protected servers are reached with `MARIMO_TOKEN`. `/marimo` pins a set instead.

**Which notebooks are this session's.** The rows, footer, Lens line and context cover only the notebooks this session uses: the pinned ones, the ones it opened, and the ones its agent has worked in through marimo-pair (remembered in the session). The current one, first in context, is the one this session's agent last worked in, read from its marimo-pair calls (`execute-code.sh` or `marimo pair execute`, by `--file`, `--session`, or `--url` when only one followed notebook is on that server), including calls from codemode scripts. A marimo-pair call at a server whose notebook is open in no browser opens it first, without a browser.

**Browser edits.** marimo does not echo an edit back to the consumer whose session id sent it, so pi-marimo connects under its own id and lets marimo find the session by file. When several sessions hold the same file (a closed tab's session can linger), it connects by the exact session id and does not see edits typed in the browser until they run.

## Configuration

`marimo.json`, read in this order, each on top of the last (objects merge, other values replace, a value of the wrong type is ignored): `~/.config/agents/marimo.json` (`$XDG_CONFIG_HOME`), `~/.pi/agent/marimo.json`, then the project's `.agents/marimo.json` and `.pi/marimo.json`. Read at each session start; the view's settings when a view opens.

```json
{
  "maxNotebooks": 8,
  "context": true,
  "liveCharts": true,
  "view": { "outputs": false },
  "server": { "command": [] }
}
```

| key | default | |
|---|---|---|
| `maxNotebooks` | `8` | notebooks followed at once in `auto` mode (1 to 32) |
| `context` | `true` | put the notebooks' state in the model's context at each prompt |
| `liveCharts` | `true` | run Plotly figures live in the view and the transcript; `false` draws pictures |
| `view.outputs` | `false` | start the notebook view with the whole section in the detail (`O` toggles it) |
| `view.code` | `"open"` | cells' code in the detail: `"open"`, or `"folded"` to its first line; Enter flips one cell |
| `view.split` | `false` | open the notebook view docked beside the chat (Pi's fullscreen mode) |
| `view.autoSplit` | `true` | dock a notebook beside the chat when the agent starts running its cells |
| `server.command` | `[]` | how `/marimo edit` and `/marimo new` start marimo, e.g. `["uvx", "--with", "pandas", "marimo"]`; empty: `uv run marimo` in a uv project, else `marimo` |

| variable | |
|---|---|
| `MARIMO_TOKEN` | access token for token-protected marimo servers (sent as a bearer token, also for the view's actions) |
| `XDG_STATE_HOME` | where marimo's server registry is read (`$XDG_STATE_HOME/marimo/servers`) |

The follow mode (`auto`, pinned paths, `off`) is set with `/marimo` and stored per session.

## Requirements and costs

- marimo (verified with 0.25), with servers listed in its registry (`--no-token`; `/marimo edit` starts them so). `MARIMO_TOKEN` is sent to servers that need an access token.
- No model or classifier calls of its own; the state block adds tokens to each prompt's context (`"context": false` or `/marimo off` stops that).
- `/marimo new` writes the new notebook file; otherwise pi-marimo writes only its `pi-marimo` session entries. What you run in the view (cells, widgets, the scratchpad) runs in your kernel and costs what it costs there.
- Lens marks need marimo-lens with its command protocol 6 (marimo-lens 0.2); a Lens on another version answers with an error, which the view shows.

## Optional integrations

Each is optional and goes through Pi's event bus; without the sibling nothing happens.

### pi-bg and pi-subagents

The notebooks are one more source in the activity protocol (`src/activity.ts`, copied verbatim into pi-bg, pi-subagents, pi-marimo, pi-herdr and pi-plan-mode).

- **[pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/)'s `/tasks`** lists followed notebooks beside the tasks and agents, tagged `notebook`: running while a cell runs or is queued, failed when its last run broke cells. Enter opens the notebook view, `x` twice interrupts the kernel, and `x` on an idle notebook clears its failure alert.
- **Rows.** With [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/), the notebook rows end its list; with only pi-bg, they join pi-bg's pill. pi-marimo draws its own rows only when no host shows them.

### pi-bg's `bg_wait` and tasks

- **Waiting on a notebook.** While a followed notebook has a cell running or queued, it is outside work that `bg_wait` can wait on, under the id `marimo:` plus its path from the cwd (`marimo:nb.py`, `marimo:notebooks/fit.py`; absolute outside the cwd). pi-bg also accepts `marimo:fit.py` when only one notebook matches. The run ends as `done`, or `failed` when cells broke during it (errors already there when it began do not count), when the notebook stays disconnected for 8 seconds, or when it is no longer followed; the summary says what the run took (`ran 4m12s · 1 error`).
- **Tasks that are notebooks.** A pi-bg task tied to a followed notebook gets its kernel state (`bg:annotate`): a `marimo edit nb.py` (or `marimo run`) service by the notebook it serves, and a job by the notebook its marimo-pair calls target. pi-bg shows the state in the task's row (`nb.py: running Model fit · 2 queued`), lists the notebook under the task in `bg_logs`, and `bg_wait` on a server that is up waits for its running cells.
- **One row per run.** While a pi-bg job's marimo-pair calls keep a notebook busy, in the TUI the notebook's row stands for the job (`running Model fit · bg fit`), and `bg_wait marimo:<file>` waits on the job, whose result carries the call's output. Stopping the job (`bg_kill`, `/stop`) interrupts the kernels it was running cells in, since killing the marimo-pair client alone leaves them running.
- **One notice per run.** When every notebook of a kernel hold (below) is driven by a pi-bg job that will wake the agent, the hold skips its "finished" notification: the wake-up already says so.

### Charts

- **Inline images.** A cell whose output is a PNG (a matplotlib or PIL figure, bare or as an `<img>` data URL, up to about 1.5 MB) is drawn through the terminal's Kitty graphics, in herdr and Ghostty as well as plain Kitty. The picture shows only when its whole block fits on screen. Altair and other Vega-Lite charts are drawn by `uv run --with vl-convert-python` (needs `uv`), cached per spec. Plotly figures are drawn by a sandboxed headless Chrome (Chrome for Testing, downloaded once into `~/.cache/pi-marimo/chrome`; `PI_MARIMO_CHROME_DIR` moves it, `BROWSER_PATH` uses one you name), never the Chrome you use. The agent's snapshot never carries images.
- **Live Plotly charts.** On a Kitty-graphics terminal, a Plotly figure in the view is a running chart: the mouse over it goes to its page (hover tooltips, drag to zoom or pan, the wheel zooms), and `i` drives it from the keyboard (arrows or `hjkl` move a pointer, space drags, `+`/`-` zoom, `0` resets, Esc hands the keys back). `"liveCharts": false` draws pictures instead. Clicks and selections do not flow back to `mo.ui.plotly`.
- **Charts in the chat.** `/marimo chart <cell>` (and the `marimo_chart` tool, which the agent uses to show you a chart) puts a cell's chart into the transcript, a Plotly figure live as in the view, and `/marimo inspect` drives the newest one from the keyboard. The entry keeps the figure, so the chart comes back after a restart or resume.
- **No flicker.** In Pi's fullscreen mode pi-marimo places chart frames itself (`src/ui/painter.ts`), a new frame above the old one before the old one goes, and transcript pictures are taken off the screen while an overlay covers them.

### pi-herdr

Inside a [Herdr](https://herdr.dev) pane with [pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/), a turn that ends while a notebook the agent worked in during that turn is still running starts a *kernel hold*: the pane token `marimo` names the file and what runs (`fit.py: Model fit`) until every such notebook is quiet, then a Herdr notification (`fit.py finished`, `ran 4m12s · 1 error`) plays the done sound, unless the pane is focused. Add `$marimo` to a row in Herdr's `[ui.sidebar.agents]` to show it.

### pi-next-prompt

A Lens selection you make while Pi is idle offers `Use Lens to address S1 in fit.py` (or `... my open selections in fit.py`) as ghost text through `prompt:offer`. A selection made during a turn is offered when the turn ends, unless the turn addressed it.

## Limitations

- Cells are changed by the agent only (through marimo-pair); the view runs, interrupts, sets widgets, runs scratch code and makes Lens selections, and never edits code.
- Widget values changed in a browser show in the view after a reconnect (marimo sends kiosk viewers no live widget values); the ones set from Pi show at once.
- The agent's changes are any code-mode change, whichever agent made it.
- In `auto` mode, at most `maxNotebooks` notebooks are followed, only those under Pi's working directory, outside hidden directories and other Git repositories below it, plus the ones opened with `/marimo edit|new`.
- Only servers listed in marimo's server registry are followed. Waiting servers are shown only when they serve one notebook.
- The context block can be a turn old while the agent runs cells.
- The rows and the notebook view exist only in the TUI.
- `src/core/` is plain ECMAScript behind a small `Io` interface (`node-io.ts` for Node and Bun), shared with the opencode and Claude Code ports.

## Development

```sh
cd packages/pi-marimo
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and then `vitest run`. Two end-to-end tests run against a real marimo only with `PI_MARIMO_LIVE_TEST=1` and `marimo` on `PATH` (`PI_MARIMO_LIVE_TEST=1 npx vitest run test/e2e.test.ts test/e2e-actions.test.ts`): one follows notebooks on a scratch server, the other has Pi start a server and runs cells, sets a widget, runs the scratchpad and, when marimo-lens is installed, makes and removes a Lens selection. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
