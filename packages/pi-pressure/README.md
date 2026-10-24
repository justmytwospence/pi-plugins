# pi-pressure

A footer row that appears only while the machine is under CPU, memory or thermal pressure, and goes away once it eases. It does not poll.

```
 Pressure cpu 97 ↑ · load 1.6 · mem warn · thermal warn ↑ · top vitest
```

(Example, not a screenshot.) With [pi-status-footer](../pi-status-footer) the row sits under the context and background rows, led by a microchip icon. Values are colored by level (muted ok, warning, error). Without it, the same text shows in Pi's status row as `pressure: cpu 97 ↑ hot · …`.

## How it reads without polling

- **CPU, load, Linux memory, swap-ins: on Pi activity.** The kernel keeps cumulative counters (CPU time per core, PSI stall time, pages swapped in), so two reads any distance apart give the exact average between them. pi-pressure reads them when Pi does something (your input, turns, tool calls, streamed output; activity closer than 2 s shares one read) and spreads each interval's average over the minutes it covers.
- **macOS memory pressure and thermal state: pushed by the kernel.** A small Swift helper blocks until the kernel wakes it (a memory-pressure dispatch source and the thermal-state notification) and prints one line per change. It is compiled once per version with the Xcode command line tools into `~/.cache/pi-pressure/`, uses no CPU while nothing changes, and exits when Pi closes its stdin. Without the Swift compiler, memory falls back to one `sysctl` per read (at most every 10 s) and there is no thermal signal.
- **Timers only during an episode.** One-shot: to confirm pressure has lasted 10 s, to refresh the row every 10 s while it shows and Pi is idle, and to hide it 30 s after it eases. In the steady state nothing runs.
- **Trade-off:** no OS sends an event for CPU load, and Linux PSI triggers need root on the NUC's kernel (5.10). A CPU hog that starts while Pi sits idle shows at your next interaction; macOS memory and thermal changes show at once.

## Signals

- **CPU:** busy share of all cores over the interval (warn 85, hot 95), and the kernel's one-minute load per core (warn 1.5, hot 2.5).
- **Memory, macOS:** the kernel's memory pressure level (2 warn, 4 critical).
- **Memory, Linux:** PSI stall share (`/proc/pressure/memory`: `some` warn 10, hot 40; `full` warn 2, hot 5) and swap-ins from `/proc/vmstat` (warn 10 MB/s, hot 50 MB/s).
- **Thermal, macOS:** `serious` (the system is throttling) is warn, `critical` is hot.
- **Other platforms:** CPU only.

A signal must stay at warn or above for 10 s before the row shows; an interval that was busy for at least that long counts at once. A level drops only once its value is a margin below the threshold (5 points for CPU), so a value hovering on it does not flicker.

## The row

The signals that rose during the episode, then the busiest process (by memory when only memory is under pressure; `ps` runs only while the row shows, at most every 10 s). A signal gets an arrow, `↑` or `↓`, only while it is moving significantly: its time-weighted mean over the last 15 s differs from the minute before by at least a step (15 points of CPU, 0.3 load per core, one macOS memory or thermal level, 5 points of Linux memory stall, 5 MB/s of swap-ins). Reads that are too sparse to compare (Pi idle) give no arrow.

## Controls

It shows on its own when thresholds are hit, and you can override it either way:

- `/pressure` toggles the row: hides it if it is showing, shows it if not.
- `/pressure show` pins it, with every signal's current reading even when nothing is under pressure, until you hide it. A pin lasts across sessions in this Pi process.
- `/pressure hide` dismisses it for the rest of the current episode; once pressure has eased (the moment the row would have gone by itself), the next episode shows it again.
- `/pressure auto` hands it back to the thresholds.
- `/pressure details` reports the current readings, levels, thresholds, where memory comes from, and the top five processes by CPU and by memory.

Settings (optional) in `~/.pi/agent/pi-pressure.json`, overridden by `.pi/pi-pressure.json`. Defaults:

```json
{
  "enabled": true, "minGapMs": 2000, "showAfterMs": 10000, "hideAfterMs": 30000, "refreshMs": 10000,
  "cpu": { "warn": 85, "hot": 95 }, "loadPerCore": { "warn": 1.5, "hot": 2.5 },
  "memorySome": { "warn": 10, "hot": 40 }, "memoryFull": { "warn": 2, "hot": 5 },
  "swapInMBps": { "warn": 10, "hot": 50 }
}
```

`enabled: false` stops it showing on its own; `/pressure show` still works. No dependencies or inference calls; sessions with a UI only.

Docs: https://pi-plugins.vercel.app/plugins/pi-pressure/
