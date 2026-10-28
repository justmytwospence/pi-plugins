---
title: Activity ownership and lifecycle
description: How optional extensions share activity views, background waits and Herdr indicators without sharing process ownership.
---

The suite uses Pi's in-process `pi.events` bus for optional integrations. Four concerns stay separate: displaying work, waiting for work, choosing the working-indicator message, and reporting work to Herdr. Sharing a row or a pill does not transfer ownership of the underlying process.

For usage, see [background work and subagents](/recipes/background-work/) and [notebook sessions](/recipes/notebooks/). For the limits of automated coverage, see [development and testing](/development/).

## Sources own work; hosts own presentation

The `ActivitySection` contract has **five identical copies**: [pi-bg](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/activity.ts), [pi-subagents](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/src/activity.ts), [pi-marimo](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/activity.ts), [pi-plan-mode](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-plan-mode/src/activity.ts) and [pi-herdr](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/activity.ts). Keep all five synchronized; there is no shared runtime package or required sibling import.

A section supplies `id`, `title`, `entries(now)` and `open(key, ui)`. Optional methods provide `stop`, `canStop`, `dismiss`, `pill`, `openDialog` and `setHosted`. Entries carry a source-local key, label, detail, status, statistics and timestamps. The source decides which finished entries remain visible and what stopping or dismissing means.

| Extension | Work it owns or observes | Presentation responsibility |
| --- | --- | --- |
| pi-bg | Shell jobs and services in its registry | Its own pill and the combined `/tasks` dialog |
| pi-subagents | Child Pi runs and their results | FleetView below the prompt, including other sources' pills |
| pi-marimo | State of followed notebook kernels | Notebook entries, detail views and an unhosted notebook pill |
| pi-plan-mode | Planner turns and their research scouts | Planner/scout entries and a planner pill; opens the planning screen |
| pi-herdr | Interactive children and pending replies | Child entries, a read-only detail view and a pill, plus pane tokens |

All five sources can appear in `/tasks`; FleetView hosts their pills. [Planner activity](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-plan-mode/src/planner-activity.ts) includes research scouts, whose work belongs to their planner. [Herdr child activity](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/children-activity.ts) is a coordination view, not a replacement interactive pane.

## Stopping is per item and owner-specific

In [pi-bg's `/tasks` dialog](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/dialog.ts), `x` on a running entry arms a stop and a second `x` calls that entry's section `stop`; any other key disarms it. A source without `stop`, or whose `canStop(key)` is false, cannot be stopped there. `x` on an ended entry calls `dismiss` when available. Selection and stop arming use the stable pair of section ID and entry key, so a changing row order cannot stop a different task. The dialog guards each call, so one source's exception does not break the list.

Calling a section's `stop` delegates to its owner:

- A pi-bg task stops its process group; a subagent stops its Pi child.
- The [notebook source](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/ui/source.ts) interrupts a kernel, not the shell service that launched it.
- Working planner rows stop that planner. Scout rows are observational and cannot be stopped independently from the activity list; stop their owning planner or use the planning screen. Opening either kind of row returns to `/planners`.
- A stoppable Herdr child receives an interrupt for its awaited turn. **It never closes the pane.** Explicit `herdr` action `close` remains a separate action.

`/stop` is not a stop-everything command. pi-bg's [`/stop`](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/index.ts) stops only pi-bg's own running tasks that this Pi process started; kept services adopted from an earlier session, subagent runs, notebooks, planners and Herdr children are untouched.

## Request and offer handshake

These are event names, not model-callable tools:

| Event | Payload | Meaning |
| --- | --- | --- |
| `activity:host` | `{ host, priority }` | A host is ready; sources re-offer. Legacy `{}` means FleetView. |
| `activity:section` | `{ section }` | Offer the source object and its callbacks. |
| `activity:changed` | `{ id }` | Notify a displaying host that the source changed. |
| `activity:gone` | `{ id }` | Remove a departing source from host views. |

The current [pi-subagents implementation](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/src/index.ts) announces `activity:host` at session start only when it has a TUI bound and FleetView is enabled. pi-bg, pi-marimo, pi-plan-mode and pi-herdr offer their sections at their own TUI session start and re-offer on a host announcement. pi-subagents also offers its runs for pi-bg's dialog at session start.

An offer received before FleetView starts hosting is ignored there; the later announcement requests another offer. Re-offering the same object is not another hosting claim. Replacing a section with the same ID releases the previous object before accepting the new one. [Activity tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/test/activity.test.ts) exercise offers before and after startup, repeated offers, removal, shutdown and the RPC no-host case.

Hosting uses explicit priorities and callbacks:

1. FleetView (`subagents`, priority 20) outranks the pi-bg pill host (`bg`, priority 10). Equal priorities use host-ID order.
2. A host calls `setHosted(true, host)` on the sources whose pills it draws; a source suppresses its independent pill while held.
3. A lower-ranked host releases its guests when a higher-ranked host announces itself. This lets FleetView show the sources directly instead of nesting their pills in pi-bg.
4. `activity:gone` for the winning host allows the fallback host to resume. Releases include host identity, so one host leaving cannot erase another's claim.

The fallback aggregation and return to an independent pill are covered by [pi-bg extension tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/test/extension.test.ts). These integrations remain optional: pi-bg and pi-marimo have their own pills, and subagent execution does not require either sibling.

## Background waits are a separate protocol

[pi-bg's entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/index.ts) implements the wait bridge independently of activity rendering:

| Event | Direction and purpose |
| --- | --- |
| `bg:probe` | A consumer sends `{ reply }`; pi-bg invokes `reply()` when loaded. |
| `bg:external` | A producer reports `{ id, label, state, summary?, result? }`, with state `running`, `done` or `failed`. pi-bg records it for `bg_wait`, which renders a `result` as Markdown. |
| `bg:external-consumed` | `{ id }` acknowledges a completed external result returned through `bg_wait`; the owner suppresses duplicate delivery. Summary-only waits do not acknowledge a result. |
| `bg:tasks` | pi-bg publishes `{ tasks }` snapshots, including readiness, origin and `willWake`. |
| `bg:annotate` | A sibling supplies `{ task, by, detail?, wait? }` for a known pi-bg task. Missing detail clears the annotation. |
| `bg:killed` | pi-bg reports `{ id, command, cwd }` after explicitly stopping a task. |

Async subagents publish external IDs as `subagent:<id>`. `bg_wait` returns a completed child's bounded result directly and acknowledges consumption, so pi-subagents suppresses the duplicate follow-up. Without a consuming wait or explicit completed-result read, pi-subagents delivers its normal result message. A running snapshot or a summary-only wait does not consume the child result. pi-marimo publishes `marimo:<path>` IDs while cells run or queue. Its [background bridge](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/bg.ts) ends them when the run completes, fails, disconnects beyond its grace period or is no longer followed.

Notebook annotations connect a shell server or job to its kernel state. Once a server is ready, `bg_wait` can wait for its annotated notebook runs rather than merely reporting server readiness. Annotation updates redraw activity but deliberately do not emit another `bg:tasks` snapshot, avoiding a feedback loop.

The same bridge uses `willWake` snapshots to suppress a second notebook-finished notification when waking pi-bg jobs cover every held notebook. [Bridge tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/test/bg.test.ts) cover completion, disconnect grace, stable IDs, annotations and notification coverage. Without pi-bg, no sibling listener provides its wait tools; the producers retain their own behavior.

## Wait messages take priority over footer statistics

pi-bg and pi-status-footer each carry the same small [working-message contract](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/working-message.ts). The optional event `pi-plugins.working-message.v1` carries `{ owner, message? }`: a message claims priority; omitting it releases that owner.

The newest active claim wins. Updating an existing claim changes its text without moving it ahead of a newer owner, and releasing an older wait cannot clear a newer wait. The footer applies this override above its own token/time decoration, so its one-second refresh cannot alternate `Waiting on…` with `Working…` (example labels).

pi-bg still paints the native working message directly when the footer is absent. Both plugins remain independently usable. Completion, timeout, interruption, pending user input, errors, shutdown and reload release wait ownership; when the final claim ends, normal footer decoration resumes if a turn remains active. The [fake-timer integration tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/test/working-message.test.ts) exercise both loaded plugins, overlaps and exit paths; this is not live-terminal proof.

## Herdr holds are not agent state

[pi-herdr's activity collector](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/core/activity.ts) consumes two channels:

- `herdr:background`: work expected to wake the agent, such as async subagents or awaited interactive children.
- `herdr:working`: work outside the main turn, such as planner runs.

pi-herdr also takes `herdr:waiting` holds, outside the collector: a turn kept open only to wait (pi-bg's `bg_wait`, or its wait for a job at the turn's end), published as the `wait` token (the newest hold's label). The pane is working, but input ends the wait; a client reading the token can deliver a message at once.

Acquire with `{ active: true, label, id? }`; release with `{ active: false, id? }`. A release with an ID removes the matching hold on that channel. Without an ID it removes the oldest hold on that channel, so producers should use their own IDs. Repeated acquisitions count separately rather than behaving as an idempotent boolean. [Collector tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/test/core/core.test.ts) cover counting and both release forms.

pi-bg uses `bg:<id>` holds for running agent jobs and outcomes still owed; it does not hold every long-lived service merely because it exists. pi-subagents uses `subagents:<counter>` per async call and releases on success or failure. pi-herdr's children use `child:<name>`.

The collector produces the `bg` pane token. Herdr's own agent integration remains responsible for idle, working and done state; this extension does not redefine those states. [pi-herdr's entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/index.ts) registers nothing without a Herdr target and activates reporting only for TUI sessions. RPC/print children must not report as the parent's pane.

Optional bridge events include `herdr:probe` with a reply callback, the `herdr:ready` startup announcement, and `herdr:token`, `herdr:notify`, `herdr:zoom` and `herdr:split`. pi-bg probes before offering its follow-in-a-split action. pi-marimo uses a separate `marimo` token and resends it on `herdr:ready`; this is not a `herdr:background` hold. See the [bridge implementation](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/bridge.ts) and [notebook Herdr tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/test/herdr.test.ts).

## Cleanup follows ownership

`activity:gone` removes a source from presentation; it is not a process-kill instruction. Shutdown behavior differs deliberately:

- **pi-bg** disposes its pill and timer, releases guest sources and Herdr holds, aborts waiters and unsubscribes from registry updates. Reload preserves tasks. Other session shutdowns kill non-kept tasks; kept services are exempt and can remain for later adoption. The process-level [registry](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/src/registry.ts) preserves task state across reloads.
- **pi-subagents** stops its children, releases hosted sources, announces its departure and disposes its views. It marks the runtime no longer live so late child completions cannot call stale Pi APIs. A [shutdown regression test](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/test/index.test.ts) checks that late completion produces no result message.
- **pi-marimo** clears render timers, releases its kernel hold, marks outstanding external runs failed through `stopAll()`, withdraws its source, disposes its pill and stops watching. This stops observation, not the notebook server. See its [lifecycle handlers](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-marimo/src/index.ts).
- **pi-plan-mode** withdraws planner/scout activities and stops planner sessions on teardown; persisted interrupted research can resume when the run is restored.
- **pi-herdr** withdraws its child activity source, stops child polling, releases child holds, resets bridge state and clears its reported tokens and timers. [Child shutdown](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/src/core/children.ts) retains saved records; it does not close the interactive child panes.

These are source-level contracts with targeted tests, not proof of every extension combination in a live terminal. Changes to hosting or cleanup still need interactive checks for startup order, reload, session replacement and shutdown; root tests exercise local session lifecycle and memory TUI paths, but not every combination or a live PTY.
