# pi-pressure

A footer row that appears only while the machine is under CPU or memory pressure, and goes away once it eases.

```
 Pressure cpu ⣀⣀⣀⣠⣤⣴⣶⣾⣿⣿ 97 · load 1.6 · mem warn · swap-in 40MB/s · top vitest
```

(Example, not a screenshot.) With [pi-status-footer](../pi-status-footer) the row sits under the context and background rows, led by a microchip icon. Values are colored by level (muted ok, warning, error). Without it, the same text shows in Pi's status row as `pressure: cpu ⣀⣀⣀⣠⣤⣴⣶⣾⣿⣿ 97 hot · …`.

- **When it shows:** after a signal stays at warn or above for 10 s. It lingers 30 s after every signal is back to ok, so a busy build does not make it flicker. A level drops only once its value is a margin below the threshold (5 points for CPU).
- **Signals:**
  - **CPU:** busy share of all cores, from `os.cpus()` deltas (warn 85, hot 95), and the one-minute load per core (warn 1.5, hot 2.5).
  - **Memory, on macOS:** the kernel's memory pressure level (`kern.memorystatus_vm_pressure_level`: 2 warn, 4 critical) and swap-ins from `vm_stat`.
  - **Memory, on Linux:** pressure stall information (`/proc/pressure/memory`: `some` avg10 warn 10, hot 40; `full` avg10 warn 2, hot 5) and `pswpin` from `/proc/vmstat`.
  - **Swap-ins:** warn 10 MB/s, hot 50 MB/s.
  - **Other platforms:** CPU only.
- **What the row lists:** the signals that rose during the episode, a braille trace of CPU over the last 20 minutes (the mean of each minute, one dot column per minute, so two minutes per character; collected from Pi's start, so it shows how the load built up), and the busiest process. The process is ranked by memory when only memory is under pressure; `ps` runs only while the row shows, at most every 10 s.
- `/pressure` reports the current readings, levels, thresholds and the top five processes by CPU and by memory. `/pressure on|off` toggles watching for this Pi process.

Settings (optional) in `~/.pi/agent/pi-pressure.json`, overridden by `.pi/pi-pressure.json`. Defaults:

```json
{
  "enabled": true, "intervalMs": 2000, "showAfterMs": 10000, "hideAfterMs": 30000, "historyMinutes": 20,
  "cpu": { "warn": 85, "hot": 95 }, "loadPerCore": { "warn": 1.5, "hot": 2.5 },
  "memorySome": { "warn": 10, "hot": 40 }, "memoryFull": { "warn": 2, "hot": 5 },
  "swapInMBps": { "warn": 10, "hot": 50 }
}
```

No dependencies or inference calls. It samples every 2 s, in sessions with a UI only. On macOS each sample runs `sysctl` and `vm_stat`.

Docs: https://pi-plugins.vercel.app/plugins/pi-pressure/
