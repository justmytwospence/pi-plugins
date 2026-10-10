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
| A bounded code review or research question | A headless subagent |
| A Pi session a person will take over | An interactive [Herdr child](/plugins/pi-herdr/) |

A longer task does not automatically need an interactive pane. A normal subagent can report back without opening one.

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

This example deliberately uses the same checkout for a read-only review. Parallel writers share files unless you arrange isolation. The optional `worktree: true` feature creates checkouts through an external CLI; it is not required for delegation.

## Wait in the turn

When no other useful work remains, the agent calls:

```json
{ "id": "tests" }
```

with `bg_wait`. For the async child, use the ID returned by `subagent`:

```json
{ "id": "subagent:RETURNED_ID" }
```

Replace `RETURNED_ID` with the actual run ID. The child’s result still arrives as its own message; waiting keeps the parent’s turn working rather than ending it with unfinished work.

Do not poll with `sleep` and repeated `bg_logs`. A user message, Esc or timeout can stop the wait without stopping the task.

## Inspect or intervene

- `/tasks` opens the combined shell/agent list when both plugins are enabled.
- Enter opens a shell log or a child conversation.
- Double-`x` stops a running entry. A single `x` dismisses an ended one.
- `bg_logs` reads a shell task’s log; `subagent` with `action: "status"` inspects runs.
- `subagent` with `action: "steer"`, an `id` and a `message` changes the child’s direction.
- `bg_kill` stops a shell process group; it is not the command for stopping a subagent.

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

With both plugins enabled, FleetView hosts the background pill and `/tasks` can show both kinds of work. Without a host, pi-bg draws its own pill. This is a UI composition protocol, not one plugin spawning the other.

Inside Herdr, background holds can show a `$bg` token after the turn ends. Herdr’s native Pi integration still owns working/idle state. [Activity architecture](/architecture/activity/) explains the boundary.
