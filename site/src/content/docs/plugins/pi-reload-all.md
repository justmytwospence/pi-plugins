---
title: pi-reload-all
description: Reload every interactive Pi session on this machine and on Herdr's saved machines, each once its turn ends and its editor is empty.
plugin: pi-reload-all
---

## Quick reference

- **Use it for:** Picking up a new suite pin, settings, skills or keybindings in every running Pi at once, instead of `/reload` pane by pane.
- **Enable:** Select `packages/pi-reload-all/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset). Every session that should be reloaded needs it.
- **Controls:** `/reload-all` signals this machine and every enabled `herdr machine`; `/reload-all --local` only this machine. `/reload-when-idle` is the command each session runs on itself. No model tool.
- **Settings:** None. The signal is `reload-request` in Pi's agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`).
- **Requirements, cost & privacy:** Other machines are reached with `ssh -o BatchMode=yes <target>`, using the targets from `herdr machine list`, so key-based SSH must already work. No network otherwise, no inference.
- **Integrations & limits:** Herdr is optional: without it only this machine is signalled. Interactive (TUI) sessions only; print and RPC sessions ignore the signal.

## How it works

Nothing is typed into other panes. Typing `/reload` with `herdr agent prompt` would append to a half-written draft, and Pi ignores `/reload` while a turn runs. Instead `/reload-all` writes a small request file, atomically, on each machine, and every session running this entry watches that file (with a 30-second poll as a fallback) and reloads itself:

1. A request written after the session started shows `reload pending` in the footer.
2. The session waits, rechecking every two seconds, until nothing a reload would break is in progress. The footer names what it waits on (for example `reload pending: subagents (2)`):
   - a running turn, a queued message, or a draft in the editor;
   - a keystroke anywhere in the terminal within the last five seconds;
   - async subagents or plan-mode planner runs (their `herdr:background` and `herdr:working` holds), which a reload would abort; pi-bg jobs and awaited Herdr children survive a reload and do not delay it;
   - an open question or permission dialog, or any open overlay (todo list, pickers);
   - anything that answers the `reload-all:probe` event with a hold: [pi-sidebar](/plugins/pi-sidebar/) does while it is open or replying.
3. It then runs Pi's own reload, the same as `/reload`.

The session that ran `/reload-all` reloads too, right after the command. Its report, one line per machine with the number of Pi panes Herdr sees there, is kept in the transcript across that reload:

```text
/reload-all: sessions reload when their turn ends and the editor is empty
  this machine: signalled (9 Pi sessions in Herdr)
  NUC: signalled (3 Pi sessions in Herdr)
```

(Example output.)

Anything else that writes the file triggers the same reload. For example, a package-update script can write it after installing a new pin, so sessions pick the pin up without a manual step.

## Limits

- A session that never becomes safe stays pending; the footer says why. Clear the draft or close what is open, or run `/reload` yourself.
- Only the work listed above is detected. An extension that keeps unsaved in-memory state while Pi is idle, and does not answer `reload-all:probe`, loses it on reload, exactly as with a manual `/reload`.
- If Pi is compacting at that moment, Pi skips the reload and the session stays on its old code. Run `/reload` afterwards.
- A machine that cannot be reached over SSH is reported as failed. Its sessions are not signalled.

## Development

The component's check runs typechecking and a [Node test file](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-reload-all/test/reload.test.mjs) covering the request file, the remote shell write, freshness by local mtime, the wait for an idle, empty session, and the self-dispatched reload. It does not drive a live TUI.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-reload-all)
