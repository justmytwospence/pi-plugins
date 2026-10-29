---
title: pi-marimo
description: Follow and steer marimo notebooks from the terminal, with live kernel status, turn-scoped context, a notebook view of outputs, variables, widgets, a scratchpad and the agent's changes, and notebooks started without a browser.
plugin: pi-marimo
---

## Quick reference

- **Use it for:** Keep notebook state visible, give the model a fixed notebook snapshot each turn, and read and steer an agent-edited notebook from the terminal instead of the browser.
- **Enable:** Select `packages/pi-marimo/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/marimo` view/edit/new/stop/open/auto/off/show/lens/chart/inspect and notebook pinning. No global shortcut; the notebook view's keys below (`?` lists them).
- **Settings:** `marimo.json` shared/user/project layers: `maxNotebooks` (8), `context`, `liveCharts`, `view.outputs`, `server.command`. The follow mode is session state.
- **Requirements, cost & privacy:** Running compatible marimo server; `MARIMO_TOKEN` for protected connections. No inference or execution for observation; summaries enter model input. Notebook execution has its own costs.
- **Integrations & limits:** Optional background waits, FleetView, footer, Herdr, pi-next-prompt and pi-vim (the docked prompts). Cells are edited by the agent only, through marimo-pair; the view runs cells, interrupts, sets widgets, runs scratch code and makes Lens selections. Stopping a client job pi-marimo follows interrupts its cells.

pi-marimo makes notebook state visible to Pi without asking the model to inspect it repeatedly. It follows open notebooks, adds an outline and attention summary to each turn, and gives you a live notebook view where you read the notebook (prose, tables, charts, variables, what the agent changed) and steer it (run cells, drive widgets, run Python in the kernel, mark results, ask the agent about a cell). It can start a notebook's server itself, so the browser is not needed even to begin. It provides no editing tools: the agent changes cells through marimo-pair.

## Enable, requirements, and costs

Select `packages/pi-marimo/src/index.ts` through [suite installation](/guides/install/). The suite loads every entry by default, with one Git pin shared by whichever entries you select.

You need marimo (the actions are verified with 0.25). Automatic discovery reads `$XDG_STATE_HOME/marimo/servers`, populated by servers started with `--no-token` (as `/marimo edit` starts them), then queries their sessions. Token-protected connections use `MARIMO_TOKEN`; a token alone does not establish that a server will be discovered. Lens marks need marimo-lens with its command protocol 6 (marimo-lens 0.2).

**Costs:** the watcher makes no model or classifier calls and does not run notebook code to collect state. Its injected summaries consume normal model input tokens. What you run from the view (cells, widgets, scratch code) runs in your kernel. Notebook execution may independently incur compute or API costs. Replacing the context snapshot at the next prompt can also require the model to reread later conversation content without the earlier cache prefix. `/marimo new` writes the new notebook file; otherwise only session entries are written.

No sibling extension is required. A custom footer, background manager, and Herdr are optional presentation and coordination integrations.

## Choose notebooks and inspect state

| Command | Purpose |
| --- | --- |
| `/marimo` | Checklist for pinning open notebooks, including notebooks outside the current directory. |
| `/marimo auto` | Follow open notebooks under Pi's working directory automatically. |
| `/marimo off` | Stop following notebooks for this session. |
| `/marimo show` | Print the current notebook-state snapshot for inspection. |
| `/marimo view [file]` | Open the live full-screen notebook view (the busiest notebook, or the one named). |
| `/marimo edit [file]` | Open a notebook in the view, starting its server when none serves it (a picker without a file). |
| `/marimo new <file.py>` | Create a notebook, start it and open it. |
| `/marimo stop [file]` | Stop a notebook server Pi started. |
| `/marimo open` | Open a notebook whose server waits in no browser, in the browser. |
| `/marimo lens` | Print the open marimo-lens selections and recently addressed ones. |
| `/marimo chart <cell>`, `/marimo inspect` | Put a cell's chart in the transcript; drive the newest one from the keyboard. |

An unknown subcommand gets a warning listing these.

Auto mode follows up to eight notebooks (`maxNotebooks`) and excludes hidden directories (including nested worktree directories) and other Git repositories below the working directory, so starting Pi in a directory of projects follows none of theirs. Notebooks opened with `/marimo edit` or `/marimo new` are followed wherever they are. Pinned paths are remembered in the Pi session across reloads and server restarts; pinning a closed notebook does not start its server (`/marimo edit` does). The mode is session state.

## Start notebooks from Pi

`/marimo new notebooks/fit.py` writes an empty notebook; `/marimo edit notebooks/fit.py` opens an existing one. pi-marimo uses a session that already holds the notebook, opens one on a server that waits for it, or starts `marimo edit <file> --headless --no-token --skip-update-check` on a free port, opens the notebook's session without a browser and shows the notebook view. The command is `uv run marimo` when the working directory has `uv.lock`, else `marimo`; `server.command` names another (for example `["uvx", "--with", "pandas", "marimo"]`).

These servers belong to the Pi process: they survive `/reload` and session switches, and stop when Pi exits, with `/marimo stop`, or with `S` twice in the notebook view.

The current notebook is the one this Pi agent most recently targeted through recognized marimo-pair calls. Targets can be identified by file, session, or an unambiguous server URL, including calls nested in codemode. Before this agent has touched a notebook, recent running, execution, or edit activity determines the current one.

A practical inspection sequence is:

```text
/marimo auto
/marimo show
/marimo view
```

If the notebook is outside the current directory, use `/marimo` to pin it instead of expecting auto mode to include it.

## What enters model context

At each prompt, pi-marimo captures followed notebooks once. The current notebook receives the full outline and code-cell summaries; other notebooks receive shorter outlines and cells needing attention. Summaries identify definitions, running or queued work, errors, stale cells, edits not rerun, detected browser changes since the preceding turn, and widget values you set from the view. The watcher keeps a cell's output, console and variable values only for the notebook view; none of it reaches the model's context. `"context": false` in `marimo.json` leaves the block out.

That block stays immediately after the prompt for every model request in the turn. It is not saved as permanent session history. Keeping it fixed avoids changing the prefix before newly generated thinking blocks during the same turn.

The trade-off is deliberate: the footer and view update live, but the model's injected snapshot can become stale during a long turn. Use marimo-pair's execution results or fresh inspection for decisions that require the latest values. This extension does not replace those results with continuous model messages.

## marimo-lens selections

[marimo-lens](https://marimo-team.github.io/marimo-lens/) lets you point at part of a rendered result (a bar, a row, a region) and attach a note. pi-marimo reads Lens's selection state from the same read-only stream. Lens publishes that state as a synced widget trait, so pi-marimo needs no kernel call and no extra setup beyond a mounted Lens.

- **Context:** each followed notebook's open selections (`S<n>`, the note, the producing cell and its heading path, and the image status) plus the latest addressed summaries. The block also tells the agent to follow the marimo-lens skill shipped with the notebook's package (`help(marimo_lens.agent)` through marimo-pair) to read images and resolve.
- **Footer:** a separate `marimo-lens` status, `lens: fit.py · S1 "make this blue" · S2`, published only while selections are open. pi-status-footer gives it a row of its own.
- **Next prompt:** with pi-next-prompt, a selection you make while Pi is idle offers `Use Lens to address S1 in fit.py` as ghost text. Tab fills it in; nothing is sent. A selection made during a turn waits until the turn ends.
- **Pill and view:** new selections add `2 selections` to the pill until your next message. The notebook view lists open and addressed selections at the top and tags each selected cell's row with its labels.
- **Marks from the view:** `m` in the notebook view asks for a note and makes a real Lens selection on the cell under the cursor (a `selection.put` command, as the browser sends it), with its picture when Pi has one. It is Lens's like any other: context, footer, browser and the agent's Lens skill all see it. `M` twice removes the cell's latest selection. Without a Lens in the notebook, `m` says so and `a` asks the agent about the cell instead.

Selection images, agent activity and reveals are not read. pi-marimo never resolves a selection; the agent does that through marimo-pair.

## Live view and kernel control

In the TUI every notebook this session uses is a row under the prompt, in file-path order (`○ fit.py  :2718 · idle`, `● fit.py  :2718 · running Data loading › Model fit  0:12`, `✗` after a failed run until your next message), as are running servers whose notebook is open in no browser and pinned files that are not open. Outside the TUI (RPC, print) the same information is a footer line per notebook (status keys `marimo`, `marimo-2`, ... in file-path order), with its file, running heading path, elapsed time, queued cells, and errors. In the turn's context, the current notebook and any other the agent worked in during the last three prompts are in full; the rest are outlines. Each notebook comes with the marimo-pair flags that name it, and a marimo-pair call that could mean several followed notebooks gets a note on its result listing them, since pi-marimo cannot count it as work in any. A running server whose notebook is open in no browser gets a `not open` line too (`marimo: 0_kcore.py · :2718 · not open`, for servers under the working directory that serve one notebook; pinned ones when pinned). In the footer form its name is a terminal hyperlink to the server; in the TUI, Enter on its row starts the notebook's session here, with no browser (see below), and shows its view; `/marimo open` opens it in the browser (`open` on macOS, `xdg-open` elsewhere) from the keyboard, and `o` does the same in the view. `↓` at the bottom of the prompt selects the rows (`j`/`k` in pi-vim's normal mode); `↑`/`↓` move, Enter opens the notebook's view (a server open in no browser is started here first), `x` twice interrupts a running one, Esc goes back to the prompt. With pi-bg or pi-subagents the rows share the panel with `N tasks` and the subagent list, and `/tasks` still lists the notebooks too.

The notebook view opens with a one-line header (kernel state, the agent's changes, the last run, the server's port) above two panes, and follows the running cell until you move. The outline on the left is the headings and one short line per code cell: its status, a title (its name, else what it defines that other cells use, else what it shows: `imports`, `daily, smooth`, `chart`, `controls`) and one badge (how long it has run, `queued`, the error's type, `blocked`, `stale`, `new` or `changed` by the agent, else the output's shape: `1,204×8`, `chart`, `4 inputs`). Cell ids are never shown. The detail on the right is the selected cell as a reader wants it: prose rendered, the output large, an error with its traceback, widgets, Lens selections, the code folded to `▸ code · 12 lines` (Enter opens it) and the dataflow by name. `O` stacks the whole section in the detail (`view.outputs` starts there). Tables are grids of the first page marimo sends, and PNG, Vega-Lite and Plotly charts are drawn inline on Kitty-graphics terminals. From 100 columns the panes sit side by side; narrower, the outline fills the view, Enter opens the detail full width and Esc comes back.

An example (not a real screenshot):

```text
╭─ esc · Notebook coffee.py · not your main session ───────────────────────────╮
│ ○ coffee.py  idle                         ran 12s · 1 error · 2m ago · :2742 │
│ ──────────────────────────────────────────────────────────────────────────── │
│  ○ imports                     │ drinks, sales · Coffee shop explorer › Data │
│    Coffee shop explorer        │                                             │
│      Data                      │ ▍ day         drink      cups  weekend      │
│ ▌  ○ drinks, sales       450×4 │ ▍ 2026-01-01  latte        63  false        │
│      Controls                  │ ▍ 10 of 450 rows · 4 columns                │
│     ○ drink, title +2 4 inputs │ ▸ code · 8 lines                            │
│     ✗ forecast        KeyError │                                             │
│ ──────────────────────────────────────────────────────────────────────────── │
│ ↑↓ cells · enter code · n next error                       ? keys · esc back │
╰──────────────────────────────────────────────────────────────────────────────╯
```

| Key | Action |
| --- | --- |
| `j` / `k`, arrows; `[` / `]` | Move between cells; between sections |
| `Ctrl-U` / `Ctrl-D`, `PgUp` / `PgDn`, `Space` | Scroll the detail |
| `g` / `G` | First and last cell |
| `Enter`, `l` | Open or fold the cell's code (narrow: open its detail) |
| `O` | The whole section in the detail, or the cell alone |
| `z` / `Z` | Fold the section at the cursor; fold every section (again: unfold all) |
| `n` / `N` | The next or previous failed cell |
| `c` / `C`, `d` | The next or previous cell the agent changed since your last message; its diff |
| `<` / `>` | Upstream and downstream cells in the dataflow |
| `v` | The variables pane (Enter goes to the defining cell, `>` to the first use) |
| `f` | Follow the running cell again |
| `/` | Filter cells (or variables); `Esc` clears it |
| `r`, `R` / `A` | Run the cell; every stale cell or every cell (press twice) |
| `x` | Press twice to interrupt the kernel |
| `w` | Drive the cell's widgets |
| `:` | Run Python in the kernel's scratchpad |
| `a` | Ask the agent about the cell |
| `m`, `M` | Mark the cell for the agent through Lens; remove its mark (press twice) |
| `i` | Drive the selected cell's live chart from the keyboard |
| `S` | Press twice to stop the server (pi-bg's, or one Pi started) |
| `Tab`, `Shift+Tab`, `o` | Next and previous notebook; open in the browser |
| `?` | Every key |
| `Esc`, `q`, `h` | Back to Pi |

The mouse wheel scrolls the pane under it, a click selects a cell or a widget, a second click or a double click opens the code, and a click on the `▸ code` line folds or opens it.

The observation connection is a read-only kiosk SSE consumer: it neither edits cells nor takes over the browser session. The view's actions are separate kernel requests (`/api/kernel/run`, `/interrupt`, `/set_ui_element_value`, `/set_model_value` for Lens, `/execute` for the scratchpad), so “read-only observation” does not mean every UI action is passive. Browser opening uses the platform's `open` or `xdg-open` utility.

## Pairing from the view

- **Ask (`a`):** a prompt docked at the bottom of the view (pi-vim's editor when loaded) sends the main agent your message with the notebook, cell, section, Lens selections and marimo-pair flags; as a follow-up while the agent works. The view stays open; the header says `agent working`.
- **The agent's changes:** cells changed through marimo-pair since your last message are marked and counted (`agent: 2 changed · 1 new · 1 removed`); `c`/`C` jump to them, `d` shows the diff, removed cells are listed at the end. Any agent using marimo-pair counts. They clear with your next prompt.
- **Widgets (`w`):** sliders, numbers, ranges, dropdowns, radios, multiselects, checkboxes, switches, text, dates and buttons: `j`/`k` pick, `h`/`l` change (`H`/`L` ten steps), Space toggles or presses, Enter types a value. Changes go to the kernel as in the browser, so dependent cells rerun, and the next context names them. Values changed in a browser show after a reconnect.
- **Scratchpad (`:`):** Python against the notebook's globals in marimo's scratchpad (as `marimo pair execute` runs it); nothing is saved. Output streams above the prompt, then the result. Esc during a run cancels it, and marimo interrupts the kernel.
- **Lens marks (`m`):** see marimo-lens selections above.

## Settings

Files merge in order: `~/.config/agents/marimo.json`, `~/.pi/agent/marimo.json`, `<project>/.agents/marimo.json`, then `<project>/.pi/marimo.json`. Shared user settings honor `$XDG_CONFIG_HOME`. Objects merge, while arrays and scalar values replace earlier values; a value whose type does not match the default is ignored.

| Key | Default | |
| --- | --- | --- |
| `maxNotebooks` | `8` | Notebooks followed at once in auto mode (1 to 32). |
| `context` | `true` | Put the notebooks' state in the model's context at each prompt. |
| `liveCharts` | `true` | Run Plotly figures live; `false` draws pictures. |
| `view.outputs` | `false` | Start the notebook view with the whole section in the detail. |
| `server.command` | `[]` | How `/marimo edit` and `/marimo new` start marimo; empty: `uv run marimo` in a uv project, else `marimo`. |

When multiple marimo sessions hold the same file, attachment uses the exact session ID. In that situation, browser edits may not be visible until they execute. Connection status should therefore be checked before treating an outline as authoritative.

## Optional integrations and waiting

With pi-bg, notebooks join `/tasks`, associated server and execution-job rows show kernel state, and active notebooks are waitable. A marimo-pair job that keeps a notebook busy is shown as that notebook's row alone (named on it), waiting on the notebook returns the job's output, and stopping the job interrupts the kernel. Example `bg_wait` arguments, only after the notebook is followed and running:

```json
{
  "id": "marimo:notebooks/fit.py",
  "timeout": 1800
}
```

IDs use paths relative to Pi's working directory, or absolute paths outside it. A basename such as `marimo:fit.py` works only when unambiguous. New cell errors make the run fail; old errors present at its start do not. A disconnection lasting eight seconds also fails the wait.

Stopping a background marimo-pair job that keeps a followed notebook busy also interrupts that kernel, since killing the client alone would leave its cells running. An already-ready server's `bg_wait` can instead wait for its running notebook cells.

pi-subagents can host the notebook pill in its fleet list. pi-status-footer gives each notebook's status its own row. With pi-herdr, agent-started kernel work that outlasts a turn can populate `$marimo` and produce a completion notification without changing the pane to working. Notifications are suppressed when a covering pi-bg job already supplies the completion wake-up.

See [notebook workflows](/recipes/notebooks/), [background work](/recipes/background-work/), [activity architecture](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/). [Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-marimo) document watcher behavior and the optional integrations.

## Pairing without a browser

marimo-pair talks to a notebook's kernel session, and marimo starts a session when a browser page connects. pi-marimo makes the same connection itself (a WebSocket to the server's `/ws`, as the page does) so you need not open the notebook: when a marimo-pair call names a server whose notebook is open in no browser, pi-marimo opens it first and the call goes through; Enter on a `not open` row does the same. pi-marimo holds the connection while Pi runs, and the server ends the session after its TTL once Pi exits.

Nothing runs on open: the cells wait until you run them (`r`, `R`, `A` in the view) or the agent does through marimo-pair, as in a browser tab that has not run the notebook. A server started with a token needs `MARIMO_TOKEN`.

## Selection

Every list under the prompt, the `/tasks` dialog and the notebook view mark the selected row the same way: the whole row on Pi's selection background.
