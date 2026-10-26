# pi-bg

Background jobs and services for Pi. The agent starts a long command with `bg_run` and keeps working; a **job** (tests, builds, model fits, exports) wakes the agent with its outcome when it exits, and a **service** (a dev or notebook server, a tunnel, a watcher) wakes it once when a `ready` pattern matches a log line, or if it exits. When nothing is left but a job's result, the agent calls `bg_wait`, or simply ends its turn: a running job keeps the turn open until it ends, so the session stays "working" and the outcome continues the same turn; typing a message, Esc or the wait's timeout ends the wait, while the job keeps running and still wakes the agent.

In the TUI, a pill under the prompt counts running shells and a full-screen `/tasks` view lists every task, laid out after Claude Code's background-tasks panel. It works alone, and integrates with pi-subagents, pi-marimo, pi-plan-mode, pi-herdr and pi-status-footer when they are loaded.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-bg/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-bg/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-bg
```

Add `-ne` to disable your other discovered and configured extensions for that run (an explicit `-e` still loads). No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## Tools

| tool | parameters |
|---|---|
| `bg_run` | `command`, `kind` (`job` or `service`, required), `name`, `ready` (service only: a regex matched case-insensitively, or `/src/flags`), `timeout` (job only: seconds before it is killed), `keep` (service only: outlive this Pi session), `progress` (a format name, `none`, or a regex; see Progress below), `cwd` |
| `bg_wait` | `id` (a task, or outside work another extension reports; default: whichever running agent job ends first), `timeout` (seconds, default 1800, max 3600) |
| `bg_logs` | `id` (omit to list every task), `lines` (default 60, max 400), `grep`, `head` |
| `bg_kill` | `id`: SIGTERM to the task's process group, SIGKILL after 3 seconds |

Ids also accept a task's name (the most recent task with it) or a unique id prefix. `bg_run` waits 1.5 seconds before returning, so a command that fails at once (a typo, a missing file) is reported in its own result instead of as a wake-up. `bg_wait` returns at once, without waiting, when messages are already queued for the agent. `bg_wait` on a service without a `ready` pattern is an error: there is nothing to wait for until it exits.

**Ending the turn with a job running.** When the agent ends its turn while a job it started is still running, pi-bg waits for it at Pi's `agent_before_settle` boundary, with the same `Waiting on…` message, timeout, and interruptions as `bg_wait` (type a message or press Esc). The session never goes idle meanwhile, so Pi, Herdr and tmux keep showing it working, and the job's outcome continues the run instead of waking an idle agent. Interrupted, the turn settles and the job wakes the agent later as below. Only jobs the agent started are waited for; services and outside work are not.

**Wake-ups.** A wake-up is sent only while Pi is idle: one that comes due during a turn waits for the turn to settle (a follow-up queued mid-turn would be dropped by Esc), and several that pile up go out as one message. Whatever `bg_wait`, `bg_logs` or `bg_kill` has already shown the agent is no longer owed. A task that ends during `/reload` wakes the agent once the new session is up. A task you stop yourself does not wake the agent; it is told on its next turn instead.

## Progress

A task shows a progress bar only when pi-bg knows its progress, from one of three sources (highest priority first). Nothing is guessed from arbitrary numbers in the output.

1. **Progress file.** Each task's environment has `PI_BG_PROGRESS`, a file beside its log. A command writes `450/1000`, `45%`, or either followed by a note (`3/5 fitting fold 3`) to it; its last line counts. This is the way for scripts the agent writes itself.
2. **Declared format.** `bg_run`'s `progress` is a catalogue name (below), a generic `percent` or `fraction`, or a regex (`/src/flags`, or plain and case-insensitive): one capture group is a percent, two are done and total, or named groups `pct`, or `done` and `total`. A regex without a group is rejected before the command starts. The agent vouched for it, so it shows at once. `none` turns detection off.
3. **Detection.** A catalogue of standard progress output, recognized without being asked:

| name | example line |
|---|---|
| `tqdm` | ` 45%\|████▌     \| 450/1000 [00:12<00:15, 36it/s]` (also `1.2k/10.0k`) |
| `pytest` | `tests/test_x.py ....  [ 45%]`, `[gw0] [ 45%] PASSED tests/a.py::t` |
| `cargo` | `    Building [=====>      ] 45/120: serde` |
| `keras` | `120/500 [=====>.......] - ETA: 3s`, `120/500 ━━━━━━━━ 3s 6ms/step` |
| `rich` (pip) | `━━━━━━━━╸━━━━━━━ 1.2/3.4 MB 5.0 MB/s` |
| `wget` | `  4500K .......... .......... 45% 1.23M 3s` (dot progress) |
| `rsync` | `  1,234,567  45%  1.23MB/s    0:00:12` |

A detected bar shows only once it looks live: a line redrawn in place with `\r` (read from the unfinished last line too), or three matches whose value never went down. A drop hides it until it qualifies again, three drops within 10 seconds (interleaved or nested bars) hide it, and a bar that reached 100% and stays quiet for 30 seconds is hidden. Many tools draw bars only on a terminal; in a log file tqdm, pytest, wget and rsync still report.

Where it shows: the `/tasks` row (`45% · ~3m · 2:14 ████░░░░░░`, bar flush right, the ETA once 10 seconds and 5 points of movement give a rate; a file note leads the row's detail), the pill when exactly one running task has progress (`1 shell · 45%`, `2 shells · fit 45%`), the waiting message (`Waiting on fit ███░░░░░ 45% · 2:14…`), the RPC footer status (`fit 45% 2:14`), and the agent's text: `bg_logs`, reports, wake-ups and `bg_wait` say `45% (450/1000, ~3m left, detected: tqdm)`, and a task that ended short of done `last progress 87%`. Adopted kept services keep their declared format. After a `/reload`, detection starts again near the log's end.

## Processes and files

Each task runs `bash -c <command>` (`/bin/sh` when `/bin/bash` is missing) in its own process group, with `PI_BG_TASK_ID` set to its id, `PI_BG_PROGRESS` to its progress file, and stdout and stderr appended to `~/.pi/agent/bg/<session-id>/<id>.log`. Nothing is written into the project. `PI_BG_DIR` moves the whole directory. A running task's log is cut back to its last megabyte once it passes 64 MB.

- **Reload.** Tasks survive `/reload`: the reloaded code takes the running tasks over.
- **Several sessions in one process.** An in-process session that loads pi-bg too (a pi-plan-mode planner given its tools) gets its own view: it lists, waits on, wakes and, when it ends, kills only the tasks it started. Only a session with a UI adopts kept services. Kept services of a session that is gone pass to the next session that starts in the process, as the user's.
- **Session end.** Quitting, `/new`, `/resume` and `/fork` stop every task, along with anything a task left running in its process group (`npm run dev &`), except services started with `keep: true`.
- **Kept services.** When Pi quits, kept services keep running and are recorded for later. The next Pi started in, above or below their directory, in the same Git checkout, adopts them at startup: it lists them and can stop them, and it notifies you when one ends. A worktree is its own checkout, so a Pi in `<project>/.worktrees/<branch>` never adopts the main checkout's services, nor the other way round.
- **Crash cleanup.** Each Pi process records its running tasks in `~/.pi/agent/bg/state/<pid>.json`. At startup, a Pi kills the leftovers of a Pi process that is no longer running. A pid is signalled or adopted only while `ps` shows it still running the task's command, never after it has been reused.
- **Old logs.** Session log directories older than seven days that no live task references are deleted at startup.

## Usage

### Pill under the prompt

In the TUI the pill reads `1 shell`, `2 shells` (with one task's progress when exactly one running task has any: `2 shells · fit 45%`), plus `· 1 failed` in the error color while a failure you have not seen is there (until your next typed message, or until you dismiss it with `x` in `/tasks`). Nothing is drawn above the prompt.

| key | action |
|---|---|
| `↓` (prompt empty, or cursor at the end of its last line) | select the pill; also `j` in pi-vim's idle Normal mode |
| Enter, `l`, `→`, or a mouse click | open the background-tasks view |
| Esc, `↑`, `k`, `h`, `←` | back to the prompt |

`↓` does not leave the prompt while autocomplete is showing or a history entry is being browsed. With pi-select-nav, Tab selects this pill when no next-prompt is accepted; a draft stays untouched. Repeated Tab keeps the pill selected. Enter opens the view and Esc returns to the editor. Other editing keys return to the editor.

### Background-tasks view

`/tasks` (aliases `/bashes`, `/ps`, `/bg`), or Enter on the pill, opens a full-screen view under an accent-colored banner (`◀ esc · Background tasks · not your main session`). It lists every task in one list, running first (oldest first), then ended (newest first), each with its command, state and runtime: `waiting` while a `bg_wait` is on it, and for services `starting`, `ready` or `service`. With other activity sources loaded (pi-subagents runs, pi-marimo notebooks, pi-plan-mode planners/scouts and pi-herdr children) their entries are mixed in, and while the list mixes sources each row is tagged with its kind (`shell`, `agent`, `notebook`).

| key | action |
|---|---|
| `↑`/`↓`, `k`/`j` | select |
| Enter, `→`, `l` | open the entry: a shell's live log, a run's conversation, a notebook; closing it returns here on the same entry |
| `x` twice | stop a running entry whose source supports stopping (the second `x` must hit the same entry) |
| `x` | dismiss an ended entry |
| `r` | rerun a shell task as a new user task |
| `f` | follow a shell task's log in a Herdr split (`tail -F`); offered only when pi-herdr is active |
| Esc, `q`, `←`, `h`, Ctrl+C | back to the session |

### Log viewer

A shell task's log, full screen, refreshed every second. It follows new output until you scroll up; scrolling back to the end follows again.

| key | action |
|---|---|
| `↑`/`↓`, `k`/`j` | scroll one line |
| Ctrl+U/Ctrl+D | scroll half a page (this read-only viewer only) |
| PgUp/PgDn | optional full-page scrolling aliases |
| Home/`g`, End/`G` | top, end |
| `x` twice | stop the task, while it runs |
| Esc, `q`, `h`, `←`, Ctrl+C | back |

### Commands

| command | |
|---|---|
| `/tasks` (`/bashes`, `/ps`, `/bg`) | the view above; outside the TUI, a plain list |
| `/tasks run <command>` | start a job yourself; it notifies you when it ends and does not wake the agent |
| `/tasks kill <id>` | stop a running task |
| `/tasks clear` | hide ended tasks |
| `/stop` | stop every running shell task this Pi process started. It leaves alone kept services adopted from earlier Pi processes, subagent runs, plan-mode planners, marimo notebooks and Herdr children; stop those from `/tasks` or their own commands |

### Outside the TUI

When a UI exists but is not the TUI (RPC mode), pi-bg shows no pill and sets a footer status instead, for example `bg: tests 2:14 · vite ready · lint ✗` (running jobs, services, and tasks that ended in the last minute; up to four items, then `+N`). [pi-status-footer](https://pi-plugins.vercel.app/plugins/pi-status-footer/) gives it a row of its own.

## Configuration

There is no settings file. Environment:

| variable | |
|---|---|
| `PI_BG_DIR` | base directory for logs and state files (default `~/.pi/agent/bg`) |
| `PI_BG_TASK_ID` | set by pi-bg in each task's environment to its id |
| `PI_BG_PROGRESS` | set by pi-bg in each task's environment: the file the task may write its progress to |

## Requirements and costs

pi-bg needs no external service, credentials or network access, and makes no model or classifier calls of its own (wake-ups start ordinary agent turns). It runs commands through `bash` (or `/bin/sh`), signals POSIX process groups, and runs `ps` to confirm that a recorded pid still belongs to its task. It writes logs and state files under `~/.pi/agent/bg` (or `PI_BG_DIR`), never into the project.

## Optional integrations

Everything below goes through `pi.events`; each sibling is optional, and with nothing listening nothing happens.

### pi-subagents

- **One list under the prompt.** [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/)' FleetView (`main` and the subagents) ends with this pill; `↓` moves through the subagents to the pill, and Enter on it opens `/tasks`. pi-bg draws no pill of its own then.
- **One list in the view.** `/tasks` lists the subagent runs too, tagged `agent`: Enter opens a run's conversation, `x` twice stops it, `x` on an ended one dismisses it.
- **Waiting on subagents.** Async subagent runs are outside work: `bg_wait subagent:<id>` waits on one inside the turn; the `subagent` tool's async result names the ids. The wait returns the bounded worker output and acknowledges it, suppressing its duplicate result message.

### pi-marimo and marimo

- **Pills.** Without pi-subagents, pi-bg's pill also counts other sources' work, such as [pi-marimo](https://pi-plugins.vercel.app/plugins/pi-marimo/)'s busy notebooks: `2 shells · 1 notebook`; those sources then draw no pill of their own.
- **marimo servers without pi-marimo.** A `bg_run` service whose command starts a marimo server (`marimo edit nb.py`, `uv run marimo edit --no-token nb.py`, `uvx marimo run app.py`, ...) is named `marimo nb.py` and is ready when marimo prints its URL, unless you give a `name` or a `ready` pattern.
- **marimo-pair calls.** A marimo-pair `execute-code` call blocks until the cells it ran finish, so a long run fits a job (`bg_run` the call, then `bg_wait`). Stopping that job stops the client, not the cells; `bg_kill` says so for marimo-pair commands.
- **With pi-marimo.** pi-marimo annotates tasks tied to a followed notebook: the server's row, and the row of a job whose marimo-pair calls target that notebook, show its kernel state (`nb.py: running Model fit · 2 queued`); `bg_logs` lists the notebook under that task; and `bg_wait` on a server that is up waits for the notebook's running cells instead of returning at once. A notebook's own `bg_wait` id is `marimo:` plus its path from the cwd; `marimo:<file>` also finds it when only one followed notebook has that name.

### pi-herdr

Inside Herdr with [pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/), pi-bg holds `herdr:background` while an agent job that will wake the agent runs, which pi-herdr shows as the pane token `$bg` once the agent is idle with the job still running (after an interrupted wait). A task you started with `/tasks run`, or a kept service, sends a Herdr notification when it ends (skipped while the pane is focused), and `f` in `/tasks` follows a log in a split. Herdr's own Pi integration still owns the pane's working/idle state.

### Event-bus channels

| channel | direction | payload | |
|---|---|---|---|
| `herdr:background` | emits | `{ active, label, id }` | held while an agent job that will wake the agent runs (and while its wake-up is owed) |
| `herdr:notify` | emits | `{ title, body, sound, unlessFocused }` | a `/tasks run` task or a kept service ended |
| `herdr:split` | emits | `{ command, cwd, done }` | `f` in `/tasks`: `tail -n 200 -F` on the log |
| `herdr:probe`, `herdr:ready` | emits / reads | `{ reply }`, `{}` | whether pi-herdr is active (enables `f`) |
| `bg:tasks` | emits | `{ tasks }` | a snapshot after every change: `id`, `name`, `kind`, `command`, `cwd`, `status`, `ready`, `origin`, `keep`, `willWake`, `logPath`, and `progress` (`fraction`, `source`, `count?`, `note?`) when known |
| `bg:killed` | emits | `{ id, command, cwd }` | after a task is stopped |
| `bg:external` | reads | `{ id, label, state, summary?, result? }` | outside work `bg_wait <id>` can wait on (`state`: `running`, `done`, `failed`); `result` is Markdown, which `bg_wait` renders as such; ended entries are kept 10 minutes for a late `bg_wait` |
| `bg:external-consumed` | emits | `{ id }` | a completed external's optional `result` was returned by `bg_wait`; its owner can suppress a duplicate announcement. Summary-only waits do not emit this acknowledgment |
| `bg:annotate` | reads | `{ task, by, detail?, wait? }` | what another extension knows about a running task: `detail` shows in its row and under it in `bg_logs`; `wait` names outside work that `bg_wait <task>` waits for once the task is up. No `detail` clears it |
| `bg:probe` | reads | `{ reply }` | `reply()` when pi-bg is loaded |
| `activity:section`, `activity:changed`, `activity:gone`, `activity:host` | both | `{ section }`, `{ id }`, `{ id }`, `{ host, priority }` | the activity protocol below |

### Activity protocol

`src/activity.ts` is the activity protocol, copied verbatim into pi-bg, pi-subagents, pi-marimo, pi-herdr and pi-plan-mode; no sibling imports another's copy. Each extension offers its background work as a *source* (`activity:section { section }`) with entries keyed by a stable id, optional `stop`, `canStop` and `dismiss`, an optional pill, and `setHosted(on, host)`. A *host* draws the other sources' pills: pi-subagents' FleetView (priority 20) outranks pi-bg's pill (priority 10, host id `bg`; an `activity:host` payload of `{}` counts as the FleetView host), and a host that hears a higher-ranked `activity:host` releases its guests until `activity:gone` names that host. A source draws its own pill only while no host shows it. Hosts key selection and `x`-twice stop arming by `${section.id}\0${key}`, so rows coming and going never move either onto another entry. The `/tasks` view lists every offered source's entries; today those are pi-bg shells, pi-subagents runs, pi-marimo notebooks, pi-plan-mode planners/scouts and pi-herdr children. Per-entry stopping is owner-specific; a Herdr-child stop only interrupts an awaited turn and never closes the pane. `/stop` remains shell-only.

### Working-message priority

During `bg_wait`, the optional event `pi-plugins.working-message.v1` publishes `{ owner, message? }`. A message claims priority; omitting it releases that owner. pi-status-footer merges the newest active claim above its token/time decoration, so `Waiting on…` never alternates with `Working…` (example labels). Updating an existing claim preserves its priority; an older release cannot clear a newer wait. Claims release on completion, timeout, interruption, pending input, errors, shutdown and reload. pi-bg still paints Pi's native message directly without the footer, and both plugins work independently. The identical contract copies live in `src/working-message.ts` in each component.

## Limitations

- The pill, `/tasks` view and log viewer exist only in the TUI.
- Herdr's pane state stays Herdr's own: a turn kept open by `bg_wait` or by a running job shows "working"; once the user interrupts that wait, the pane shows idle or done, and only the `$bg` token says a job will wake it.
- Kept services are adopted only by a Pi started in, above or below their directory in the same Git checkout (outside Git, by directory alone), and only at startup.

## Development

```sh
cd packages/pi-bg
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and then `vitest run`. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
