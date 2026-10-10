---
title: Activity ownership and lifecycle
description: How optional extensions share activity views, background waits and Herdr indicators without sharing process ownership.
---

The suite uses Pi's in-process `pi.events` bus for optional integrations. Three concerns stay separate: displaying work, waiting for work, and reporting work to Herdr. Sharing a row or a pill does not transfer ownership of the underlying process.

For usage, see [background work and subagents](/recipes/background-work/) and [notebook sessions](/recipes/notebooks/). For the limits of automated coverage, see [development and testing](/development/).

## Sources own work; hosts own presentation

The `ActivitySection` contract is copied into [pi-bg](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/activity.ts), [pi-subagents](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/src/activity.ts) and [pi-marimo](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/activity.ts). Its source comment requires changes to stay synchronized across all three copies; there is no shared runtime package to import.

A section supplies `id`, `title`, `entries(now)` and `open(key, ui)`. Optional methods provide `stop`, `dismiss`, `pill`, `openDialog` and `setHosted`. Entries carry a source-local key, label, detail, status, statistics and timestamps. The source decides which finished entries remain visible and what stopping or dismissing means.

| Extension | Work it owns or observes | Presentation responsibility |
| --- | --- | --- |
| pi-bg | Shell jobs and services in its registry | Its own pill and the combined `/tasks` dialog |
| pi-subagents | Child Pi runs and their results | FleetView below the prompt, including other sources' pills |
| pi-marimo | State of followed notebook kernels | Notebook entries, detail views and an unhosted notebook pill |
| pi-herdr | Herdr reporting and interactive child coordination | Pane tokens and bridge operations, not the shared activity list |

Calling a section's `stop` delegates to its owner. For example, the [notebook source](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/ui/source.ts) interrupts a kernel; it does not terminate the shell service that launched the notebook.

## Request and offer handshake

These are event names, not model-callable tools:

| Event | Payload | Meaning |
| --- | --- | --- |
| `activity:host` | `{}` | A host is ready; sources should offer themselves again. |
| `activity:section` | `{ section }` | Offer the source object and its callbacks. |
| `activity:changed` | `{ id }` | Notify a displaying host that the source changed. |
| `activity:gone` | `{ id }` | Remove a departing source from host views. |

The current [pi-subagents implementation](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/src/index.ts) announces `activity:host` at session start only when it has a TUI bound and FleetView is enabled. pi-bg and pi-marimo offer their sections at their own TUI session start and re-offer on that announcement. pi-subagents also offers its runs for pi-bg's dialog at session start.

An offer received before FleetView starts hosting is ignored there; the later announcement requests another offer. Re-offering the same object is not another hosting claim. Replacing a section with the same ID releases the previous object before accepting the new one. [Activity tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/test/activity.test.ts) exercise offers before and after startup, repeated offers, removal, shutdown and the RPC no-host case.

Hosting is an explicit callback, not an election service:

1. FleetView calls `setHosted(true)` on sources whose pills it displays. Those sources suppress their own pills.
2. When pi-bg is not itself hosted, it can aggregate other pill-bearing sources, calling `setHosted(true, "pi-bg")` on them.
3. When FleetView takes over pi-bg's pill, pi-bg releases its guests so their pills can appear directly in FleetView.
4. A host leaving calls `setHosted(false)` with the corresponding host identity. pi-marimo tracks host identities separately, so releasing one host does not erase another's claim.

The fallback aggregation and return to an independent pill are covered by [pi-bg extension tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/test/extension.test.ts). These integrations remain optional: pi-bg and pi-marimo have their own pills, and subagent execution does not require either sibling.

## Background waits are a separate protocol

[pi-bg's entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/index.ts) implements the wait bridge independently of activity rendering:

| Event | Direction and purpose |
| --- | --- |
| `bg:probe` | A consumer sends `{ reply }`; pi-bg invokes `reply()` when loaded. |
| `bg:external` | A producer reports `{ id, label, state, summary? }`, with state `running`, `done` or `failed`. pi-bg records it for `bg_wait`. |
| `bg:tasks` | pi-bg publishes `{ tasks }` snapshots, including readiness, origin and `willWake`. |
| `bg:annotate` | A sibling supplies `{ task, by, detail?, wait? }` for a known shell task. Missing detail clears the annotation. |
| `bg:killed` | pi-bg reports `{ id, command, cwd }` after explicitly stopping a task. |

Async subagents publish external IDs as `subagent:<id>`; their owner still delivers their results. A background wait does not take over subagent result delivery. pi-marimo publishes `marimo:<path>` IDs while cells run or queue. Its [background bridge](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/bg.ts) ends them when the run completes, fails, disconnects beyond its grace period or is no longer followed.

Notebook annotations connect a shell server or job to its kernel state. Once a server is ready, `bg_wait` can wait for its annotated notebook runs rather than merely reporting server readiness. Annotation updates redraw activity but deliberately do not emit another `bg:tasks` snapshot, avoiding a feedback loop.

The same bridge uses `willWake` snapshots to suppress a second notebook-finished notification when waking pi-bg jobs cover every held notebook. [Bridge tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/test/bg.test.ts) cover completion, disconnect grace, stable IDs, annotations and notification coverage. Without pi-bg, no sibling listener provides its wait tools; the producers retain their own behavior.

## Herdr holds are not agent state

[pi-herdr's activity collector](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/core/activity.ts) consumes two channels:

- `herdr:background`: work expected to wake the agent, such as async subagents or awaited interactive children.
- `herdr:working`: work outside the main turn, such as planner runs.

Acquire with `{ active: true, label, id? }`; release with `{ active: false, id? }`. A release with an ID removes the matching hold on that channel. Without an ID it removes the oldest hold on that channel, so producers should use their own IDs. Repeated acquisitions count separately rather than behaving as an idempotent boolean. [Collector tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/test/core/core.test.ts) cover counting and both release forms.

pi-bg uses `bg:<id>` holds for running agent jobs and outcomes still owed; it does not hold every long-lived service merely because it exists. pi-subagents uses `subagents:<counter>` per async call and releases on success or failure. pi-herdr's children use `child:<name>`.

The collector produces the `bg` pane token. Herdr's own agent integration remains responsible for idle, working and done state; this extension does not redefine those states. [pi-herdr's entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/index.ts) registers nothing without a Herdr target and activates reporting only for TUI sessions. RPC/print children must not report as the parent's pane.

Optional bridge events include `herdr:probe` with a reply callback, the `herdr:ready` startup announcement, and `herdr:token`, `herdr:notify`, `herdr:zoom` and `herdr:split`. pi-bg probes before offering its follow-in-a-split action. pi-marimo uses a separate `marimo` token and resends it on `herdr:ready`; this is not a `herdr:background` hold. See the [bridge implementation](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/bridge.ts) and [notebook Herdr tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/test/herdr.test.ts).

## Cleanup follows ownership

`activity:gone` removes a source from presentation; it is not a process-kill instruction. Shutdown behavior differs deliberately:

- **pi-bg** disposes its pill and timer, releases guest sources and Herdr holds, aborts waiters and unsubscribes from registry updates. Reload preserves tasks. Other session shutdowns kill non-kept tasks; kept services are exempt and can remain for later adoption. The process-level [registry](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/registry.ts) preserves task state across reloads.
- **pi-subagents** stops its children, releases hosted sources, announces its departure and disposes its views. It marks the runtime no longer live so late child completions cannot call stale Pi APIs. A [shutdown regression test](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/test/index.test.ts) checks that late completion produces no result message.
- **pi-marimo** clears render timers, releases its kernel hold, marks outstanding external runs failed through `stopAll()`, withdraws its source, disposes its pill and stops watching. This stops observation, not the notebook server. See its [lifecycle handlers](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/index.ts).
- **pi-herdr** stops child polling, releases child holds, resets bridge state and clears its reported tokens and timers. [Child shutdown](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/core/children.ts) retains saved records; it does not close the interactive child panes.

These are source-level contracts with targeted tests, not proof of every extension combination in a live terminal. Changes to hosting or cleanup still need interactive checks for startup order, reload, session replacement and shutdown; the root loader test does not exercise that lifecycle.
