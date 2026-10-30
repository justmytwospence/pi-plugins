---
title: Background work & subagents
description: Keep long shell jobs and bounded delegated tasks visible, and wait without abandoning the turn.
---
**Use:** [pi-bg](/plugins/pi-bg/) and [pi-subagents](/plugins/pi-subagents/). Neither requires the other. Herdr and the status footer are optional.

## Choose the right unit of work

| Work | Use |
| --- | --- |
| Tests, a build, an export | A pi-bg `job` |
| A dev server, tunnel or watcher | A pi-bg `service` |
| A command you need to interact with directly | Explicit `!i <command>` with [pi-interactive-shell](/plugins/pi-interactive-shell/) |
| A bounded code review or research question | A headless subagent |
| A Pi session a person will take over | An interactive [Herdr child](/plugins/pi-herdr/) |

A longer task does not automatically need an interactive pane. A normal subagent can report back without opening one.

## When you need the terminal yourself

With optional [pi-interactive-shell](/plugins/pi-interactive-shell/), submit `!i git add -p` at an idle real terminal TUI prompt. A focused inline terminal sits in the chat transcript at roughly half the terminal height, rather than overlaying the conversation. It is not pinned to the viewport and does not force-scroll your view. The handoff temporarily replaces the editor while running, then restores its text and focus immediately on exit. There is no auto-detection or agent tool. If [pi-next-prompt](/plugins/pi-next-prompt/) offers an `!i` ghost, press Tab, review it, then press Enter yourself; accepting a suggestion never executes it.

While the command runs, program keys—including Tab, Esc, Ctrl+C and Ctrl+D—reach the program. Panel controls use Ctrl+] followed by `f` to toggle compact/expanded, `q` to confirm stop/close, `u`/`d` to scroll half a page or `g`/`G` for top/end. Ctrl+] twice sends a literal Ctrl+]. Scrolling is live-only. On exit, a static head-and-tail frame remains in chat, with `… N rows omitted …` when needed; no Enter/Esc dismissal is required. The count is screen rows, including blanks, not logical lines. The head is the earliest row still in xterm's bounded 1,000-line scrollback, not necessarily the original beginning. Very short panels show only the bottom viewport. Revisit snapshots with Pi's transcript navigation, not per-panel scrolling. Teardown stops the process group with escalation when needed and disposes terminal emulation.

Pi's event processing and background monitoring can continue, and existing background OS processes keep running. New agent requests wait for the live handoff to finish; retained snapshots do not block them. Manual, edited, externally offered and `!!i` commands do not automatically resume the agent: send another prompt to continue. Only an accepted model-suggested `!i` draft submitted exactly unchanged triggers automatic continuation after success, failure or cancellation, using status only.

Only the command and completion/error status enter session history. The live screen and up to 1,000 scrollback lines are memory-only; after exit, the bounded static snapshot remains in process memory and may contain sensitive text. A transcript clear/rebuild, reload, session switch or exit can remove it. The extension does not write output or keystrokes to tool results, session history, model context or its own debug logs. Host screen-capture diagnostics, external recording and commands echoing secrets remain possible. `!!i` applies Pi's normal context exclusion, not history deletion.

If Pi's private transcript layout is not recognized, the command falls back to the existing focused overlay without an inline snapshot. Manual fallback panels require Enter or Esc to dismiss exited output; exact accepted suggestions still close automatically and continue with status only.

This requires a real, idle terminal, not RPC or print/headless mode. Support is keyboard-first VT, not universal mouse, graphics or remote/phone-client support; no OSC 52/clipboard passthrough. The [component reference](/plugins/pi-interactive-shell/#enable-and-requirements) covers its lazily loaded native PTY dependencies and platform requirements.

There is no detach, multiple-terminal management or adoption of a pi-bg job. **pi-bg is unchanged**; keep using its jobs and services when the agent needs logs, progress and asynchronous results.

## Start the shell job, then do useful work

Ask Pi:

> Run the project’s tests in a background job. While they run, have a read-only subagent review the changed code for edge cases. Do not create a worktree or edit files in the review. Wait for both results before concluding.

A pi-bg tool call for a project whose test command is `npm test` looks like this:

```json
{
  "command": "npm test",
  "kind": "job",
  "name": "tests",
  "timeout": 600
}
```

Subagent arguments for the independent review:

```json
{
  "task": "Review the current Git diff and relevant tests for edge cases. Do not edit files. Return concrete findings with paths.",
  "async": true
}
```

These are **tool arguments**, not shell commands. The child starts fresh unless `context: "fork"` is requested, so include the task’s constraints and success criteria. Omitting agent/model/thinking lets configuration and potentially Jev select them. Model and classifier use can be paid; see [requirements](/guides/requirements/).

This example deliberately uses the same checkout for a read-only review. Parallel writers share files unless you arrange isolation. The optional `worktree: true` feature creates checkouts with Git directly; no external worktree helper is required. Herdr interactive worktree children instead use Herdr's socket create/open operations. Request isolation deliberately; ordinary delegation needs neither.

## Wait in the turn

When no other useful work remains, the agent calls:

```json
{ "id": "tests" }
```

with `bg_wait`. For the async child, use the ID returned by `subagent`:

```json
{ "id": "subagent:RETURNED_ID" }
```

Replace `RETURNED_ID` with the actual run ID. `bg_wait` returns the completed child's bounded output and consumes it, suppressing a duplicate completion message. Without a consuming wait or completed-result read, the child's normal result message still arrives. Inspect that returned result before concluding.

Do not poll with `sleep` and repeated `bg_logs`. A user message, Esc or timeout can stop the wait without stopping the task. With pi-status-footer, the wait's message takes priority over token/time decoration until it releases; `Waiting on…` should not flicker back to `Working…` (example labels). Neither plugin requires the other.

## Inspect or intervene

- `/tasks` opens a combined activity list: pi-bg tasks, subagents, followed notebooks, planners/scouts and Herdr children, according to the plugins enabled.
- Enter opens a task's log or a child conversation.
- Double-`x` stops a stoppable selected running entry through its owner. A notebook interrupts its kernel; a working planner can be stopped (scouts are observed, not independently stoppable); a Herdr-child stop interrupts an awaited turn and **never closes the pane**. A single `x` dismisses an ended one.
- `/stop` stops only pi-bg's tasks from this Pi process. It does not stop subagents, notebooks, planners or Herdr children.
- `bg_logs` reads a task’s log; `subagent` with `action: "status"` inspects runs.
- `subagent` with `action: "steer"`, an `id` and a `message` changes the child’s direction.
- `bg_kill` stops a task's process group; it is not the command for stopping a subagent.

The agent should report failures rather than treating “the wait returned” as “the tests passed.”

## Services have a different finish line

For a dev server, use a readiness pattern appropriate to that server:

```json
{
  "command": "npm run dev",
  "kind": "service",
  "name": "dev",
  "ready": "Local:"
}
```

A matching log line says the service is ready, not that it has exited. Set `keep: true` only if the user needs it to survive the Pi session. By default jobs and services stop on session exit/replacement; pi-bg can take them over across `/reload`.

Readiness regexes are case-insensitive unless explicit `/pattern/flags` specify otherwise. Pick a real startup message, not a substring that also appears in a failure.

## What the optional integration changes

With both plugins enabled, FleetView hosts the background pill and `/tasks` can show both kinds of work. Without FleetView, pi-bg can aggregate other sources' pills; without either host, sources keep their own presentation. Planners/scouts and Herdr children participate too. This is a UI composition protocol, not one plugin spawning the other.

Inside Herdr, background holds can show a `$bg` token after the turn ends. Herdr’s native Pi integration still owns working/idle state. [Activity architecture](/architecture/activity/) explains the boundary.
