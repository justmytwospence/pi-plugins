---
title: Recap
description: One line on where the session stands when you come back to it, the same line as the turn's Herdr notification.
plugin: pi-recap
---

## Quick reference

- **Use it for:** Seeing at a glance where a session stands after you have been away from it.
- **Enable:** Select `packages/pi-recap/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/recap` shows the latest turn's recap at once; the automatic line clears on your next prompt.
- **Settings:** `PI_RECAP=0` (no automatic line), `PI_RECAP_DELAY_MS` (default 180000), `PI_RECAP_MODEL`, `PI_HERDR_SUMMARY=0` (no model call).
- **Requirements, cost & privacy:** Pi 1.0+ TUI; one small Haiku request per settled turn with a multi-line reply, sending earlier prompts, the turn's prompt, tool calls and reply.
- **Integrations & limits:** With pi-herdr, the same line is its `$summary` notification text, from one shared request. At most 80 characters.

Recap writes one line on where the session stands: what the last turn got done and, if it ended needing you, what you must decide or do. After a turn settles and the session sits idle for 3 minutes, the line appears dimmed above the editor:

```
 ※ recap: Fixed the parser to skip empty lines; tests pass, waiting on your OK to push
```

*Example, not a screenshot.*

## Enable and requirements

Use [Install & select](/guides/install/) and select `packages/pi-recap/src/index.ts`. It works on its own; pi-herdr is optional. Print mode, RPC hosts and subagents stay dormant.

## How the line is written

As a turn settles, a small model (the first of `anthropic/claude-haiku-5-5`, `anthropic/claude-haiku-4-5` with credentials, thinking off, 4-second cap) writes the recap from a condensed transcript: up to 5 earlier prompts as context, then the latest prompt, its tool calls and its final reply. A reply that is already one short line is used as is, with no request. Without a model, on an error, a timeout or an interrupted turn, the reply's first sentence stands in.

The automatic line is skipped after an interrupted run and when the recap is just the reply's own short line, since that is already on screen. A new run, tree navigation or a new session clears it. `/recap` waits for any run to finish and shows the recap at once, even a short one.

## With pi-herdr

pi-herdr's `$summary` pane token is the text notification tools show when a turn ends. With Recap loaded, pi-herdr asks for the recap over Pi's event bus (`recap:summary`) and uses it, so the notification and the recap line match, from one request. Blocked dialogs still get their question from pi-herdr. Without Recap, pi-herdr writes its own last-turn summary.

Source: [packages/pi-recap](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-recap). The idea comes from [pi-away](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-away) (MIT).
