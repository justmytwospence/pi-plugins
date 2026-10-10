---
title: pi-bg
description: Run shell jobs and services with lifecycle management, searchable logs, and waits that keep the agent working.
plugin: pi-bg
---

Use pi-bg when a command needs to continue while the agent does something else. It distinguishes finite **jobs**, whose outcomes matter, from persistent **services**, whose readiness matters. Waiting is an explicit tool call, not repeated log polling.

## Enable and requirements

Follow the [suite installation guide](/guides/install/) and select `packages/pi-bg/src/index.ts`. The suite loads all 19 extensions by default; every selected extension shares one Git pin.

Commands run through `bash -c` in separate process groups. Bash and the programs named in your commands must be available, and the process needs permission to write its logs. This is process management, not a sandbox: commands inherit Pi's operating-system access.

**Costs:** pi-bg makes no classifier or model requests itself. Commands can consume compute or call paid services, and a completion wake-up can start another normal agent turn. No sibling plugin or Herdr installation is required.

## Tools and examples

| Tool | Arguments and behavior |
| --- | --- |
| `bg_run` | Required `command` and `kind` (`job` or `service`); optional `name`, `cwd`, service `ready` and `keep`, job `timeout` in seconds. |
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

## Completion and cancellation

Jobs wake the agent on exit; services can wake it when ready and again when they exit. Notifications wait until the agent is idle, and accumulated outcomes are combined. Results already consumed through waiting, log inspection, or stopping are not owed again. A command failing within 1.5 seconds is reported directly in `bg_run`'s result.

Typing a message, pressing Esc, or reaching the wait timeout stops **waiting**, not the task. Call `bg_kill` to stop the process. Service lifetime is not bounded by the job-only `timeout` argument.

Tasks survive `/reload`. Quitting or changing sessions through `/new`, `/resume`, or `/fork` stops ordinary tasks, including descendants in their process group. Use `keep: true` only for services you intend to keep using outside this session. A later Pi started in or above the service directory can adopt them.

## Commands, views, and storage

`/tasks` opens the background-task view; `/bashes`, `/ps`, and `/bg` are aliases. Useful command forms are:

```text
/tasks run npm test
/tasks kill tests
/tasks clear
/stop
```

A manually started task notifies you on completion rather than waking the agent. `/tasks clear` hides ended tasks; `/stop` stops tasks this Pi started.

In the view, use arrows or `j`/`k`, Enter for logs, `x` twice to stop running work, `x` once to dismiss ended work, and `r` to rerun. The prompt pill opens the same view. RPC hosts receive a footer status instead of the TUI controls.

There is no JSON settings file. Logs normally live at `~/.pi/agent/bg/<session>/<id>.log`; `PI_BG_DIR` changes the storage root. Logs exceeding 64 MB are reduced to their final megabyte, and logs older than a week are removed. Do not treat them as a durable archive or print secrets unnecessarily.

## Optional integrations and limitations

With pi-subagents, `/tasks` also lists agent runs and the prompt UI is shared. `bg_wait` can await `subagent:<id>`, but the subagent's result still arrives separately. With pi-marimo, notebook runs become waitable as `marimo:<path>`, and an already-ready server can wait for its active cells rather than immediately returning.

Stopping a marimo-pair client job does **not** stop the notebook's cells. Interrupt the kernel through the notebook controls instead. With pi-herdr active, `f` follows a log in a split and pending work can appear in the `$bg` token; this does not replace Herdr's own pane-state reporting.

See [background workflows](/recipes/background-work/), the [activity protocol](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/). The [package source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-bg) define lifecycle and notification behavior.
