---
title: pi-subagents
description: Delegate bounded tasks to separate Pi processes, inspect their conversations, and control parallel or chained runs.
plugin: pi-subagents
---

pi-subagents gives the agent a `subagent` tool for work that should return a result to the main conversation. Each child is a separate `pi --mode rpc` process with its own context window. Parallel execution does not imply separate files: children share the selected working directory unless you explicitly request checkout isolation.

## Enable, requirements, and costs

Select `packages/pi-subagents/src/index.ts` using the [suite installation guide](/guides/install/). The suite enables all 19 extensions by default and uses one Git pin for every selected component.

Children need a working Pi runtime and access to their selected model providers. The component documents Pi 0.99 or newer for classifier support; consult the installation guide for the suite's tested host version. Optional `worktree: true` additionally requires the `worktree` command and a suitable Git repository.

**Costs:** each child consumes model tokens independently. Usage and model cost are included in tool results and session totals. When agent, model, or effort choices remain open, optional Jev selection can make a paid classifier request per task through Pi's model registry. Missing classifier access falls back to defaults; it does not make child model execution free. Disable selection with `jev.enabled: false` if you do not want those classifier calls.

## Run, chain, and control tasks

`action: "run"` is the default. Choose one task shape:

- `task`: one self-contained assignment, with optional `agent`, `model`, and `thinking`.
- `tasks`: parallel task objects, each accepting `task`, `agent`, `cwd`, `model`, and `thinking`. Defaults allow eight tasks with four executing concurrently.
- `chain`: sequential task objects. `{previous}` inserts the preceding output; the chain stops on its first failed step.

Example arguments for independent read-only reconnaissance:

```json
{
  "action": "run",
  "tasks": [
    {
      "agent": "general",
      "task": "Read the authentication code and report its entry points. Do not edit files."
    },
    {
      "agent": "general",
      "task": "Read the authentication tests and report coverage gaps. Do not edit files."
    }
  ],
  "async": true,
  "context": "fresh"
}
```

`async` defaults to false. When true, the call returns IDs immediately and later delivers `subagent-result` messages that start a turn. Results due during a main-agent turn wait until it settles. Use `context: "fork"` to seed children from the current conversation rather than fresh context.

Control an existing run with `action: "status"`, `"result"`, `"stop"`, or `"steer"`. These take an `id` or unique prefix; status without an ID lists runs. Steering additionally requires `message`:

```json
{
  "action": "steer",
  "id": "RUN_ID_FROM_RESULT",
  "message": "Prioritize missing authorization checks; keep this read-only."
}
```

`cwd` changes the working directory. `worktree: true` invokes `worktree new subagent/<slug>-<id> --no-open` for isolated task checkouts. Request that deliberately; a separate context alone is not an editing boundary.

## Agent definitions and settings

Agent definitions live in `~/.pi/agent/agents/*.md` and the nearest project's `.pi/agents/*.md`; project definitions win. A built-in `general` agent is always available. Definitions use frontmatter for `name`, `description`, optional `tools`, `model`, `thinking`, and `maxTurns` (also `max_turns`); the body extends the child's system prompt.

At a turn limit, the child is asked to finish without further tools. If it continues calling tools, it is stopped with potentially partial output. A role description calling an agent read-only is not an operating-system sandbox.

Global settings are `~/.pi/agent/pi-subagents.json`, overlaid by `.pi/pi-subagents.json` in the working directory. This example disables classifier selection and reduces concurrency:

```json
{
  "jev": { "enabled": false },
  "maxParallel": 8,
  "concurrency": 2,
  "widget": "off",
  "fleetView": true,
  "maxDepth": 2
}
```

Optional `tiers` maps `fast`, `balanced`, and `strong` to configured `provider/model` identifiers. Unset tiers use the parent's model. Explicit call arguments take priority over agent-file choices, then classifier choices, then defaults. `tierDescriptions` changes the descriptions used for classification. Jev defaults are provider `typesafe`, model `jev-latest`, and a 3000 ms timeout.

`widget` accepts `off`, `background`, or `all`; `fleetView: false` disables the list below the prompt. `maxDepth: 2` allows children to delegate once more, but removes the tool from grandchildren.

## Inspect results and conversations

`/subagents` lists live and recorded runs. `/subagents <id>` opens a conversation, `/subagents stop <id>` stops a run, and `/subagents stop all` stops running children.

In the TUI fleet list, Enter opens a child, `x` twice stops it, and `b` moves a foreground run to the background. In its conversation viewer, Enter opens a steering composer, `m` cycles Markdown rendering, and Esc returns to the main session. Child approval dialogs can be forwarded to your UI with an agent-name prefix.

Returned replies are capped at 2000 lines or 50 KB. Full output is saved under `~/.pi/agent/subagents/<id>/output.md`, alongside `messages.jsonl`. Recorded transcripts remain inspectable after reload or resume; this is not a promise that a live child survives session teardown.

## Optional integrations and boundaries

With pi-bg, `/tasks` includes children and `bg_wait` accepts `subagent:<id>` for async work. Waiting keeps the main turn active but does not replace the child's separate result message. pi-marimo can contribute notebook pills to the fleet view. pi-herdr can display pending async work through `$bg`; no Herdr pane is needed for ordinary subagents.

Prefer these headless children for report-back tasks. Choose pi-herdr's interactive children when a person needs an ongoing session to take over. See [background work](/recipes/background-work/), [activity integration](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/).

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-subagents) cover RPC children, turn limits, result delivery, and the TUI views.
