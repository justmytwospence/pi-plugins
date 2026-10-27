---
title: pi-bg
description: Run shell jobs and services with lifecycle management, searchable logs, and waits that keep the agent working.
plugin: pi-bg
---

## Quick reference

- **Use it for:** Run a long command while the agent continues other work; distinguish finite jobs from ready services.
- **Enable:** Select `packages/pi-bg/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `bg_run`, `bg_wait`, `bg_logs`, `bg_kill`; `/tasks` (aliases `/bg`, `/bashes`, `/ps`), `/stop`. No global shortcut; dialog keys below.
- **Settings:** No JSON settings. Wait: 1800 s (max 3600); logs: 60 lines (max 400). `PI_BG_DIR` relocates logs.
- **Requirements, cost & privacy:** Bash and your command's own dependencies. No inference calls itself; commands and wake-up turns can cost money. Logs remain on disk.
- **Integrations & limits:** Optional shared activities, notebook waits, Herdr log splits and footer wait priority. `/stop` stops only pi-bg's tasks; Esc ends a wait, not a process.

Use pi-bg when a command needs to continue while the agent does something else. It distinguishes finite **jobs**, whose outcomes matter, from persistent **services**, whose readiness matters. Waiting is an explicit tool call, not repeated log polling.

## Enable and requirements

Follow the [suite installation guide](/guides/install/) and select `packages/pi-bg/src/index.ts`. The suite loads every entry by default; every selected extension shares one Git pin.

Commands run through `bash -c` in separate process groups. Bash and the programs named in your commands must be available, and the process needs permission to write its logs. This is process management, not a sandbox: commands inherit Pi's operating-system access.

**Costs:** pi-bg makes no classifier or model requests itself. Commands can consume compute or call paid services, and a completion wake-up can start another normal agent turn. No sibling plugin or Herdr installation is required.

## Tools and examples

| Tool | Arguments and behavior |
| --- | --- |
| `bg_run` | Required `command` and `kind` (`job` or `service`); optional `name`, `cwd`, service `ready` and `keep`, job `timeout` in seconds, and `progress` (see [Progress](#progress)). |
| `bg_wait` | Optional `id` and `timeout`; waits inside the turn, default 1800 seconds, maximum 3600. Without an ID, waits for the next running agent-started job to finish. |
| `bg_logs` | Optional `id`, `lines`, `grep`, `head`. Omit the ID to list tasks; log reads default to 60 lines, maximum 400. |
| `bg_kill` | Required `id`; sends SIGTERM to the process group, then SIGKILL after three seconds if necessary. |

IDs may also be task names or unique ID prefixes. For example, give `bg_run` these arguments in a project with a test script:

```json
{
  "command": "npm test",
  "kind": "job",
  "name": "tests",
  "timeout": 600
}
```

Continue independent work, then call `bg_wait`:

```json
{
  "id": "tests",
  "timeout": 600
}
```

For a development server, use a pattern matching its actual readiness output:

```json
{
  "command": "npm run dev",
  "kind": "service",
  "name": "dev",
  "ready": "Local:",
  "keep": false
}
```

Plain readiness patterns are case-insensitive; `/pattern/flags` supplies explicit regex flags. A service without a readiness pattern has no readiness event to wait for. Recognized marimo server commands receive an automatic name and readiness pattern unless overridden.

## Progress

A task shows a progress bar only when pi-bg knows its progress from one of three sources, highest priority first:

1. **The progress file.** Every task gets `PI_BG_PROGRESS`, a file path. A command or script writes `450/1000`, `45%`, or either followed by a note (`3/5 fitting fold 3`); the last line counts.
2. **A declared format.** `bg_run`'s `progress` names a format below, a generic `percent` or `fraction`, or a regex: one capture group is a percent, two are done and total, or use named groups `pct`, or `done` and `total`. A regex without a group is rejected. `"none"` turns detection off.
3. **Detection.** Standard output pi-bg recognizes without being asked: `tqdm`, `pytest`, `cargo`, `keras`, `rich` (pip), `wget` (dot progress) and `rsync`. A detected bar shows only once it looks live: a line redrawn in place with `\r`, or three matches whose value never went down. A drop hides it until it qualifies again, interleaved bars hide it, and a finished bar that goes quiet for 30 seconds is hidden.

Many tools draw bars only on a terminal; in a log file, tqdm, pytest, wget and rsync still report. For example, a job driven by a script the agent wrote:

```json
{
  "command": "python fit.py  # writes \"$i/$n fold $k\" to $PI_BG_PROGRESS",
  "kind": "job",
  "name": "fit"
}
```

Progress appears as a bar, percent and ETA in the `/tasks` row (`45% · ~3m · 2:14 ████░░░░░░`, bar flush right, example), in the pill when exactly one task has progress (`2 tasks · fit 45%`), in the `Waiting on fit ███░░░░░ 45% · 2:14…` message, and in the agent's text (`45% (450/1000, ~3m left, detected: tqdm)`). A task that ends short of done reports `last progress 87%`.

## Transcript rows

A task reads as a Bash call that runs in the background (example):

```text
✓ Bash npm run fit · background job
   ↳ fit running · 45% ████░░░░ · 2:14
✓ Background job fit (ab12c) ended: exit 0 after 3:02. · ctrl+o to expand
```

The result line follows the task while it runs and keeps its outcome afterwards. `bg_wait`, `bg_logs` and `bg_kill` show as `Wait`, `Task log` and `Stop` rows with their first line collapsed. With pi-cc-render, call rows take its style and the result line stays pi-bg's.

## Completion and cancellation

When the agent ends its turn with a job it started still running, pi-bg waits for it at Pi's `agent_before_settle` boundary (same message, timeout and interruptions as `bg_wait`), so the session stays working in Pi (its spinner shows the `Waiting on …` message), Herdr and tmux and the outcome continues the run. With pi-herdr, a `$wait` pane token meanwhile tells clients such as herdr-web-ui that typing ends the wait. Typing or Esc ends the wait; the job then wakes the agent later. Jobs wake the agent on exit; services can wake it when ready and again when they exit. Notifications wait until the agent is idle, and accumulated outcomes are combined. Results already consumed through waiting, log inspection, or stopping are not owed again. A command failing within 1.5 seconds is reported directly in `bg_run`'s result.

During `bg_wait`, its `Waiting on…` message (example) takes priority over pi-status-footer's token/time decoration through an optional event-bus claim. The latest active wait wins; updating its text preserves priority, and releasing an older wait cannot clear a newer one. Completion, timeout, interruption, user input, errors and teardown release ownership. pi-bg still paints the native message without the footer; neither requires the other.

Typing a message, pressing Esc, or reaching the wait timeout stops **waiting**, not the task. Call `bg_kill` to stop the process. Service lifetime is not bounded by the job-only `timeout` argument.

Tasks survive `/reload`. Quitting or changing sessions through `/new`, `/resume`, or `/fork` stops ordinary tasks, including descendants in their process group. Use `keep: true` only for services you intend to keep using outside this session. A later Pi started in, above or below the service directory, in the same Git checkout, can adopt them; a worktree counts as its own checkout, so its services and the main checkout's never cross.

## Commands, views, and storage

`/tasks` opens the background-task view; `/bashes`, `/ps`, and `/bg` are aliases. Useful command forms are:

```text
/tasks run npm test
/tasks kill tests
/tasks clear
/stop
```

A manually started task notifies you on completion rather than waking the agent. `/tasks clear` hides ended tasks. `/stop` stops only pi-bg's running tasks that this Pi process started; it leaves kept services adopted from an earlier session alone and never stops subagents, notebooks, planners or Herdr children.

In the view, use arrows or `j`/`k`, Enter for logs, `x` twice to stop the selected running entry, `x` once to dismiss an ended one, and `r` to rerun a task. Double-`x` works per entry for any listed source that supports stopping, such as a subagent run. The prompt pill opens the same view. With [pi-select-nav](/plugins/pi-select-nav/), Tab selects it when no next-prompt is accepted, preserving drafts. Enter opens it, Esc returns to the editor, and repeated Tab keeps the single pill selected. In a log viewer, Ctrl+U/Ctrl+D scroll half a page; PageUp/PageDown remain optional full-page aliases. The viewer has no text field. RPC hosts receive a footer status instead of the TUI controls.

There is no JSON settings file. Logs normally live at `~/.pi/agent/bg/<session>/<id>.log`; `PI_BG_DIR` changes the storage root. Logs exceeding 64 MB are reduced to their final megabyte, and logs older than a week are removed. Do not treat them as a durable archive or print secrets unnecessarily.

## Optional integrations and limitations

`/tasks` combines every offered activity source: pi-bg tasks, subagent runs, followed notebooks, planners/scouts and Herdr children, according to enabled plugins. FleetView can host their pills, or pi-bg can aggregate them without FleetView. Double-`x` delegates to the owner only when the entry can be stopped; a Herdr-child stop interrupts an awaited turn and **never closes the pane**.

With pi-subagents, the prompt UI is shared. `bg_wait` can await `subagent:<id>` and returns its bounded result directly, suppressing a duplicate completion message. With pi-marimo, notebook runs become waitable as `marimo:<path>`, and an already-ready server can wait for its active cells rather than immediately returning.

Stopping a marimo-pair client job does **not** stop the notebook's cells. Interrupt the kernel through the notebook controls instead. With pi-herdr active, `f` follows a log in a split and pending work can appear in the `$bg` token; this does not replace Herdr's own pane-state reporting.

See [background workflows](/recipes/background-work/), the [activity protocol](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/). The [package source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-bg) define lifecycle and notification behavior.
