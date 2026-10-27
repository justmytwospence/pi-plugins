---
title: pi-pressure
description: A footer row that appears only while the machine is under CPU, memory or thermal pressure, with arrows on signals that are moving. No polling.
plugin: pi-pressure
---

## Quick reference

- **Use it for:** Notice when the machine, not the model, is the bottleneck: a build pinning every core, memory pressure, swapping, thermal throttling. Nothing is shown otherwise.
- **Enable:** Select `packages/pi-pressure/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Shows on its own when thresholds are hit. `/pressure` toggles it by hand; `/pressure show` pins it, `/pressure hide` dismisses it until the episode ends, `/pressure auto` hands it back; `/pressure details` reports readings, thresholds and top processes.
- **Settings:** Optional `~/.pi/agent/pi-pressure.json` (project `.pi/pi-pressure.json` overrides): `enabled` (`false`: show only by hand), `minGapMs` (2000), `showAfterMs` (10000), `hideAfterMs` (30000), `refreshMs` (10000), and `warn`/`hot` bands for `cpu`, `loadPerCore`, `memorySome`, `memoryFull` and `swapInMBps`.
- **Requirements, cost & privacy:** No dependencies or inference calls, and no polling. On macOS, memory and thermal signals use a small Swift helper compiled once with the Xcode command line tools (sysctl fallback without them). Nothing leaves the machine or enters model context.
- **Integrations & limits:** With [pi-status-footer](/plugins/pi-status-footer/) it gets its own footer row; otherwise it shows in Pi's status row. Hidden while a dialog shrinks the footer to one row. A CPU hog that starts while Pi is idle shows at your next interaction.

## Purpose

An always-on resource meter is noise most of the time. pi-pressure stays out of the way until a signal has been at its warn level for 10 seconds, then adds one row. It lingers for 30 seconds after every signal is back to normal, so a busy build does not make it flicker.

Example row with pi-status-footer (illustration, not a screenshot):

```
 Pressure cpu 97 ↑ · load 1.6 · mem 83% used · thermal warn ↑ · top vitest
```

Values take the level's color: muted once eased, warning, then error. A signal gets an arrow, `↑` or `↓`, only while it is moving significantly: its time-weighted mean over the last 15 seconds differs from the minute before by at least a step (15 points of CPU, 0.3 load per core, one macOS memory or thermal level, 5 points of Linux memory stall, 5 MB/s of swap-ins). Reads too sparse to compare, as when Pi is idle, give no arrow. When the terminal is narrow, the busiest process and eased signals go first; hot and warn signals stay. Without the footer, the same text appears in Pi's status row with level words: `pressure: cpu 97 ↑ hot · mem warn · top vitest`.

## Showing and hiding by hand

The thresholds decide by default, and you can override them either way. `/pressure` alone toggles the row. `/pressure show` pins it until you hide it, listing every signal's current reading even when nothing is under pressure; the pin lasts across sessions in the same Pi process. `/pressure hide` dismisses it for the rest of the current episode: once pressure has eased, at the moment the row would have gone by itself, the next episode shows it again. `/pressure auto` hands it back to the thresholds.

## Without polling

- **Counters, read on Pi activity.** CPU time per core, Linux PSI stall time and swap-ins are cumulative kernel counters, so two reads any distance apart give the exact average between them. pi-pressure reads them when Pi does something (input, turns, tool calls, streamed output; activity within 2 seconds shares one read) and spreads each interval over the minutes it covers. An interval that was busy for at least 10 seconds shows the row at once.
- **States, pushed by the kernel (macOS).** Memory pressure and thermal state are not counters. A Swift helper of a few dozen lines blocks until the kernel wakes it (a memory-pressure dispatch source and ProcessInfo's thermal-state notification) and prints one line per change. It is compiled once per version into `~/.cache/pi-pressure/`, uses no CPU while nothing changes, and exits when Pi closes its stdin.
- **One-shot timers, only during an episode:** to confirm pressure has lasted 10 seconds, to keep the row current every 10 seconds while it shows and Pi is idle, and to hide it 30 seconds after it eases. In the steady state nothing runs.

No OS sends an event for CPU load, and Linux pressure triggers need root on older kernels (5.10 here), so a CPU hog that starts while Pi sits idle shows at your next interaction. macOS memory and thermal changes show at once.

## Signals

| Signal | Source | Warn | Hot |
| --- | --- | --- | --- |
| CPU | Busy share of all cores over the interval, from `os.cpus()` counters | 85 | 95 |
| Load | The kernel's one-minute load average per core | 1.5 | 2.5 |
| Memory (macOS) | Memory pressure level, pushed by the helper | 2 (warn) | 4 (critical) |
| Memory (Linux) | `/proc/pressure/memory` stall share over the interval, `some` / `full` | 10 / 2 | 40 / 5 |
| Swap-in (Linux) | `/proc/vmstat` `pswpin`, MB/s | 10 | 50 |
| Thermal (macOS) | Thermal state, pushed by the helper | serious (throttling) | critical |

On macOS the row also shows memory used, as Activity Monitor counts it (app memory, wired and the compressor's physical pages, as a share of RAM), from one `vm_stat` per read at most every 10 seconds: `mem 83% used`. `/pressure details` adds the compressor's size. These explain the level without setting it. The kernel decides the level from compressor occupancy and uncompressed headroom, with hysteresis, so warn can hold at a used share that looks moderate.

A level rises at its threshold and falls only once the value is a margin below it (5 points for CPU), so a value hovering on a threshold does not toggle the row. Free memory is deliberately not a signal: both kernels use spare memory as cache, so pressure and swap-ins are the honest measures.

The busiest process comes from `ps`, which runs only while the row shows (at most every 10 seconds). It is ranked by CPU, or by resident memory when only memory is under pressure. When two or three stand well above the rest, all of them show (`top vitest, node`): the cut among the first three with the largest drop to the next, if that drop is at least twofold and each one kept is at least a quarter of the busiest. Otherwise only the busiest shows. Pi's own process is labeled `pi`. When other processes share the busiest one's name (many Pi sessions, `node`, `python`), its working directory's base name tells it apart: `top pi (groundcover)`, or `pi (this)` for the current session. Only the processes shown get that lookup (`lsof` on macOS, `/proc/<pid>/cwd` on Linux), and a working directory of `/` or home adds nothing.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-pressure)
