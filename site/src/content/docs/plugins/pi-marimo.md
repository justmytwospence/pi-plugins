---
title: pi-marimo
description: Follow open marimo notebooks with live kernel status, turn-scoped context, and optional background-work integration.
plugin: pi-marimo
---

## Quick reference

- **Use it for:** Keep followed notebook state visible and provide a fixed notebook-context snapshot for each turn.
- **Enable:** Select `packages/pi-marimo/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/marimo` auto/off/show/view and notebook pinning. No global shortcut; viewer keys and explicit kernel interrupt below.
- **Settings:** Session state, no JSON settings; auto follows up to 8 notebooks under cwd, excluding hidden directories.
- **Requirements, cost & privacy:** Running compatible marimo server; `MARIMO_TOKEN` for protected connections. No inference or execution for observation; summaries enter model input. Notebook execution has its own costs.
- **Integrations & limits:** Optional background waits, FleetView, footer and Herdr. Observation does not edit notebooks; marimo-pair is separate. Stopping a client job pi-marimo follows interrupts its cells.

pi-marimo makes notebook state visible to Pi without asking the model to inspect it repeatedly. It follows open notebooks, adds an outline and attention summary to each turn, and exposes a live notebook view. It does not provide notebook editing tools; marimo-pair remains the separate workflow for inspecting and changing notebook content.

## Enable, requirements, and costs

Select `packages/pi-marimo/src/index.ts` through [suite installation](/guides/install/). The suite loads every entry by default, with one Git pin shared by whichever entries you select.

You need a running marimo server with open notebook sessions and compatible session, registry, and SSE endpoints. Automatic discovery reads `$XDG_STATE_HOME/marimo/servers`, populated by servers started with `--no-token`, then queries their sessions. Token-protected connections use `MARIMO_TOKEN`; a token alone does not establish that a server will be discovered. No minimum marimo version is specified in the package reference, so verify attachment with your installed release rather than assuming universal compatibility.

**Costs:** the watcher makes no model or classifier calls and does not run notebook code to collect state. Its injected summaries consume normal model input tokens. Notebook execution may independently incur compute or API costs. Replacing the context snapshot at the next prompt can also require the model to reread later conversation content without the earlier cache prefix.

No sibling extension is required. A custom footer, background manager, and Herdr are optional presentation and coordination integrations.

## Choose notebooks and inspect state

| Command | Purpose |
| --- | --- |
| `/marimo` | Checklist for pinning open notebooks, including notebooks outside the current directory. |
| `/marimo auto` | Follow open notebooks under Pi's working directory automatically. |
| `/marimo off` | Stop following notebooks for this session. |
| `/marimo show` | Print the current notebook-state snapshot for inspection. |
| `/marimo view` | Open the live full-screen notebook view. |
| `/marimo open` | Open a notebook whose server waits in no browser. |
| `/marimo lens` | Print the open marimo-lens selections and recently addressed ones. |

Auto mode follows up to eight notebooks and excludes hidden directories, including nested worktree directories. Pinned paths are remembered in the Pi session across reloads and server restarts; pinning a closed notebook does not start its server. These modes are session state, not a separate JSON settings file.

The current notebook is the one this Pi agent most recently targeted through recognized marimo-pair calls. Targets can be identified by file, session, or an unambiguous server URL, including calls nested in codemode. Before this agent has touched a notebook, recent running, execution, or edit activity determines the current one.

A practical inspection sequence is:

```text
/marimo auto
/marimo show
/marimo view
```

If the notebook is outside the current directory, use `/marimo` to pin it instead of expecting auto mode to include it.

## What enters model context

At each prompt, pi-marimo captures followed notebooks once. The current notebook receives the full outline and code-cell summaries; other notebooks receive shorter outlines and cells needing attention. Summaries identify definitions, running or queued work, errors, stale cells, edits not rerun, and detected browser changes since the preceding turn. Cell outputs are discarded by the watcher.

That block stays immediately after the prompt for every model request in the turn. It is not saved as permanent session history. Keeping it fixed avoids changing the prefix before newly generated thinking blocks during the same turn.

The trade-off is deliberate: the footer and view update live, but the model's injected snapshot can become stale during a long turn. Use marimo-pair's execution results or fresh inspection for decisions that require the latest values. This extension does not replace those results with continuous model messages.

## marimo-lens selections

[marimo-lens](https://marimo-team.github.io/marimo-lens/) lets you point at part of a rendered result (a bar, a row, a region) and attach a note. pi-marimo reads Lens's selection state from the same read-only stream. Lens publishes that state as a synced widget trait, so pi-marimo needs no kernel call and no extra setup beyond a mounted Lens.

- **Context:** each followed notebook's open selections (`S<n>`, the note, the producing cell and its heading path, and the image status) plus the latest addressed summaries. The block also tells the agent to follow the marimo-lens skill shipped with the notebook's package (`help(marimo_lens.agent)` through marimo-pair) to read images and resolve.
- **Footer:** a separate `marimo-lens` status, `lens: fit.py · S1 "make this blue" · S2`, published only while selections are open. pi-status-footer gives it a row of its own.
- **Next prompt:** with pi-next-prompt, a selection you make while Pi is idle offers `Use Lens to address S1 in fit.py` as ghost text. Tab fills it in; nothing is sent. A selection made during a turn waits until the turn ends.
- **Pill and view:** new selections add `2 selections` to the pill until your next message. The notebook view lists open and addressed selections at the top and tags each selected cell's row with its labels.

Selection images, agent activity and reveals are not read. pi-marimo never resolves a selection; the agent does that through marimo-pair.

## Live view and kernel control

The footer gives every notebook this session uses a line of its own (status keys `marimo`, `marimo-2`, ... in file-path order), with its file, running heading path, elapsed time, queued cells, and errors. In the turn's context, the current notebook and any other the agent worked in during the last three prompts are in full; the rest are outlines. Each notebook comes with the marimo-pair flags that name it, and a marimo-pair call that could mean several followed notebooks gets a note on its result listing them, since pi-marimo cannot count it as work in any. A running server whose notebook is open in no browser gets a `not open` line too (`marimo: 0_kcore.py · :2718 · not open`, for servers under the working directory that serve one notebook; pinned ones when pinned). Its name is a terminal hyperlink to the server: in Pi's fullscreen TUI a click opens it (`open` on macOS, `xdg-open` elsewhere), and `/marimo open` does the same from the keyboard. A prompt pill appears during running or queued work, with a failure indicator retained until your next message.

In the notebook view, `j`/`k` scroll, Tab switches notebooks, `o` opens the notebook in a browser, and Esc or `h` returns to Pi. Press `x` twice to interrupt the kernel.

The observation connection is a read-only kiosk SSE consumer: it neither edits cells nor takes over the browser session. The explicit interrupt action is a separate kernel-control request, so “read-only observation” does not mean every UI action is passive. Browser opening uses the platform's `open` or `xdg-open` utility.

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
