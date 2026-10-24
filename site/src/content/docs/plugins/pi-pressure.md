---
title: pi-pressure
description: A footer row that appears only while the machine is under CPU or memory pressure, with a braille CPU trace and the busiest process.
plugin: pi-pressure
---

## Quick reference

- **Use it for:** Notice when the machine, not the model, is the bottleneck: a build pinning every core, memory pressure, swapping. Nothing is shown otherwise.
- **Enable:** Select `packages/pi-pressure/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/pressure` reports readings, thresholds and top processes; `/pressure on|off` toggles watching.
- **Settings:** Optional `~/.pi/agent/pi-pressure.json` (project `.pi/pi-pressure.json` overrides): `enabled`, `intervalMs` (2000), `showAfterMs` (10000), `hideAfterMs` (30000), and `warn`/`hot` bands for `cpu`, `loadPerCore`, `memorySome`, `memoryFull` and `swapInMBps`.
- **Requirements, cost & privacy:** No dependencies or inference calls. macOS and Linux get memory signals; other platforms get CPU only. Nothing leaves the machine or enters model context.
- **Integrations & limits:** With [pi-status-footer](/plugins/pi-status-footer/) it gets its own footer row; otherwise it shows in Pi's status row. Hidden while a dialog shrinks the footer to one row.

## Purpose

An always-on resource meter is noise most of the time. pi-pressure stays out of the way until a signal has been at its warn level for 10 seconds, then adds one row. It lingers for 30 seconds after every signal is back to normal, so a busy build does not make it flicker.

Example row with pi-status-footer (illustration, not a screenshot):

```
 Pressure cpu ⣴⣿ 97 · load 1.6 · mem warn · swap-in 40MB/s · top vitest
```

Values take the level's color: muted once eased, warning, then error. The braille trace shows the last eight CPU samples, two per cell, so you can see how the load built up. When the terminal is narrow, the busiest process, then eased signals and the trace go first; hot and warn signals stay. Without the footer, the same text appears in Pi's status row with level words: `pressure: cpu ⣴⣿ 97 hot · mem warn · top vitest`.

## Signals

| Signal | Source | Warn | Hot |
| --- | --- | --- | --- |
| CPU | Busy share of all cores, from `os.cpus()` deltas | 85 | 95 |
| Load | One-minute load average per core | 1.5 | 2.5 |
| Memory (macOS) | `kern.memorystatus_vm_pressure_level` | 2 (warn) | 4 (critical) |
| Memory (Linux) | `/proc/pressure/memory` avg10, `some` / `full` | 10 / 2 | 40 / 5 |
| Swap-in | `vm_stat` swap-ins or `/proc/vmstat` `pswpin`, MB/s | 10 | 50 |

A level rises at its threshold and falls only once the value is a margin below it (5 points for CPU), so a value hovering on a threshold does not toggle the row. Free memory is deliberately not a signal: both kernels use spare memory as cache, so pressure and swap-ins are the honest measures.

The busiest process comes from `ps`, which runs only while the row shows (at most every 10 seconds). It is ranked by CPU, or by resident memory when only memory is under pressure. Pi's own process is labeled `pi`.

## Cost

Sampling runs every 2 seconds, only in sessions with a UI. On macOS each sample runs `sysctl` and `vm_stat`; on Linux it reads two `/proc` files.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-pressure)
