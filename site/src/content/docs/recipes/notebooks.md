---
title: Notebook sessions
description: Start a marimo notebook from Pi, pair with the agent on it from the terminal, distinguish server readiness from kernel completion, and wait safely.
---
**Use:** [pi-marimo](/plugins/pi-marimo/). Add [pi-bg](/plugins/pi-bg/) for process management and waiting. Use the separate [marimo-pair](https://github.com/marimo-team/marimo-pair) workflow to inspect and edit notebooks.

Pi-marimo observes notebook state. Its kiosk SSE connection does not run or edit code and does not take the browser’s editing session over. The notebook view's actions (run, interrupt, widgets, the scratchpad, Lens marks) are separate kernel requests you make on purpose.

## Start the notebook from Pi

```text
/marimo new notebooks/fit.py
```

This writes an empty notebook, starts `marimo edit --headless --no-token` on it (through `uv run marimo` in a uv project), opens its session without a browser and shows the notebook view. `/marimo edit notebooks/fit.py` does the same for an existing notebook. The server lives as long as Pi, or until `/marimo stop`.

## Or start a local notebook server yourself

If marimo is already installed in your Python environment, ask Pi to start a service:

```json
{
  "command": "marimo edit --no-token notebooks/fit.py",
  "kind": "service",
  "name": "fit notebook"
}
```

This is a `bg_run` example. Use the command that actually selects your project’s environment, such as `uv run marimo edit`, if needed. Pi-bg recognizes common marimo server commands and can detect readiness from their URL output.

:::caution[Local example, not a public server recipe]
`--no-token` enables registry-based discovery for these local servers but disables marimo token authentication. Do not expose an unauthenticated notebook server publicly. Token-protected servers need the appropriate `MARIMO_TOKEN` in Pi’s environment.
:::

## Confirm what Pi is following

```text
/marimo
/marimo show
```

The first opens a checklist to pin notebooks. The second prints the state block the model sees. Automatic discovery follows up to eight open notebooks under the current working directory, excluding hidden directories such as other worktree checkouts.

- `/marimo auto` returns to automatic following.
- `/marimo off` stops following.
- `/marimo view` opens the full-screen notebook view.
- Tab cycles followed notebooks in that view; `o` opens one in the browser.

A notebook outside the current directory may need pinning. “Not open” means there is no matching open session; starting a server and opening the notebook are distinct from having a busy kernel. A server you started that serves one notebook under the working directory shows a dimmed `not open` footer line; click its name (or run `/marimo open`) to open the notebook in your browser.

## Make a change through the editing workflow

Ask the agent to use marimo-pair, not to treat pi-marimo as an editing tool:

> Use marimo-pair to inspect the notebook. Add one small section, run it, and wait for its cells to finish. Tell me about errors before doing more.

Pi-marimo detects supported marimo-pair tool calls to identify the current notebook. It follows kernel events continuously, but inserts a **single state snapshot per user prompt**, held stable for the rest of the turn. That avoids rewriting the prefix under the model’s existing thinking on every request.

For the latest output during a turn, the agent should use marimo-pair’s results. The observation block is intentionally not a substitute for them. Outputs are dropped from the SSE observer; outlines, state, variables and errors are what matter.

## Pair from the view

Open the notebook view (`/marimo view`, or Enter on its row under the prompt) and keep it open while the agent works:

- `a` asks the agent about the cell under the cursor; the message names the cell and the marimo-pair flags.
- `c` jumps to the cells the agent changed since your last message; `d` shows a change as a diff.
- `w` drives the cell's widgets (`h`/`l` change a slider, Space a checkbox); dependent cells rerun.
- `:` runs Python against the notebook's globals without touching a cell, for a quick look at a value.
- `m` marks a result for the agent through marimo-lens, as pointing at it in the browser would.
- `O` shows every cell's output (tables as grids, charts inline on Kitty-graphics terminals), `v` the variables, `?` every key.

## Wait for cells, not just the server

When cells run or queue, a followed notebook can be waited on through pi-bg:

```json
{ "id": "marimo:notebooks/fit.py" }
```

This is a `bg_wait` call. The ID uses the notebook’s path relative to Pi’s cwd (absolute for notebooks outside it). The basename form, such as `marimo:fit.py`, is accepted only when unambiguous.

With both plugins enabled, a recognized server row is annotated with its notebook state. Once the server is up, waiting on that server task can wait for the running cells rather than immediately returning “ready.”

Long marimo-pair execute calls may themselves run as background jobs. Those calls block until their cells finish; other execute calls against the same notebook can queue behind them. Do not launch concurrent edits as a way around a running cell.

## Stop the right thing

- Stopping a marimo-pair **client job** stops that command, not the cells it already requested.
- Double-`x` in the notebook view explicitly interrupts the kernel, like the browser stop button.
- Killing the **server service** stops the server process group.
- Esc from `bg_wait` only stops waiting.

New cell errors make the observed run fail; old errors present before the run are not counted as new failures. A disconnection longer than eight seconds can also end the observed run as failed.

## Add UI integrations only if useful

Pi-subagents can host the notebook pill. Pi-bg can include notebook entries in its task view. Status-footer gives the notebook a dedicated row. Inside Herdr, pi-herdr can show a notebook token and completion notice without claiming ownership of the pane’s state.

None of those siblings is required for the basic notebook observer. See [requirements](/guides/requirements/) for external tools and the [reference](/plugins/pi-marimo/) for connection limitations.
