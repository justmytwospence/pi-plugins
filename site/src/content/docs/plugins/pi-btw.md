---
title: pi-btw
description: Ask a side question in a separate Pi sub-session overlay while the main agent keeps working, then hand the thread back.
plugin: pi-btw
---

`pi-btw` adds `/btw`, a side conversation that runs immediately, even while the main agent is busy. Each question goes to a real Pi agent session in a focused overlay with its own composer and transcript. The thread stays out of the main agent's context until you inject it. It began as [pi-btw](https://github.com/dbachelder/pi-btw) 0.6.1 (MIT, Dan Bachelder) and was adapted for the suite.

## Enable and requirements

Entry: `packages/pi-btw/src/index.ts`. The package also ships an optional skill that teaches the agent when to suggest `/btw`. To load both exactly, merge this object into your `packages` array:

```json
{
  "packages": [
    {
      "source": "git:github.com/justmytwospence/pi-plugins",
      "extensions": ["packages/pi-btw/src/index.ts"],
      "skills": ["packages/pi-btw/skills/btw"],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Use `"skills": []` to leave the skill out. Remove `npm:pi-btw` or a Git copy of pi-btw first; a duplicate `/btw` registration is reported at startup.

**Requirements and costs:** every BTW question is a model request on the main session's model, or on a BTW-only override, so it costs what a normal turn on that model costs. The model needs usable credentials; otherwise BTW reports an error instead of running. The overlay needs Pi's interactive TUI. Outside it, pass the question inline; a composer-only `/btw` warns instead of opening.

**Tool access is real.** `/btw` and `/btw:tangent` threads get Pi's `read`, `bash`, `edit` and `write` tools and work in the same checkout as the main agent, so a side question can change files while the main run is editing them. Use `/btw:ask` when you only want to read. The side session loads no extensions, skills or prompt templates of its own.

## Commands

| Command | What it does |
| --- | --- |
| `/btw [--save] <question>` | Ask in the current thread, which inherits the main conversation. `/side` is an alias. |
| `/btw:tangent [--save] <question>` | A contextless thread that does not inherit the main conversation. |
| `/btw:ask [--save] <question>` | A read-only thread with the main conversation but only `read`, `grep`, `find` and `ls`. |
| `/btw:new [question]` | Clear the thread and start a fresh contextual one. |
| `/btw:clear` | Dismiss the overlay and clear the thread. |
| `/btw:inject [instructions]` | Send the whole thread to the main agent as a user message, then clear it. |
| `/btw:summarize [instructions]` | Summarize the thread with the BTW model (thinking off), inject the summary, then clear it. |
| `/btw:model`, `/btw:thinking` | Show, set or clear a BTW-only model or thinking override. |

Switching between the contextual, tangent and read-only modes clears the previous thread and recreates the sub-session, so one thread never mixes capabilities. Injected messages are queued as follow-ups when the main agent is busy.

`--save` (or `-s`) also saves that one exchange as a visible session note. Notes are displayed in the transcript but filtered out of the main agent's context. Thread state itself is stored as hidden session entries per branch and restored on session start and `/tree` navigation.

## Overlay keys and focus

- **Enter** submits. **Escape** while a reply streams aborts it and keeps the partial transcript; Escape when idle dismisses the overlay without clearing the thread.
- **Alt+/**, **Super+/** or **Ctrl+Alt+W** move focus between the overlay and the main editor without closing it. `PI_BTW_FOCUS_KEYS` replaces these with a comma-separated list of pi-tui key IDs, such as `ctrl+/,ctrl+alt+b`; invalid entries are ignored and the defaults return if none are usable.
- **Alt+W** toggles between a framed window and a full-width layout that is easier to select text from.
- **Ctrl+U/Ctrl+D** scroll the transcript half a page only when nothing has been typed in the native composer; with text, they keep their editing meaning.

With [pi-vim](/plugins/pi-vim/) loaded, the composer is a pi-vim embedded editor: multi-line and modal. Enter or `:w` submits, `:q` or Escape in idle Normal mode dismisses, and Ctrl+U/Ctrl+D scroll in idle Normal mode. Without a provider, it falls back to Pi's single-line input. The overlay declares an editor input context, so [pi-select-nav](/plugins/pi-select-nav/) leaves its keys alone. See [keyboard & focus](/guides/keyboard/).

## Limitations

A side thread is a separate agent with separate cost, not a free scratchpad. It can reach the same files and shell as the main agent unless you use `/btw:ask`, and the read-only boundary is the tool list, not an operating-system sandbox. Session switches, reloads, `/tree` navigation and dismissal invalidate in-flight work so a stale reply cannot reopen the overlay.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-btw), including the [entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-btw/src/index.ts), the [skill](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-btw/skills/btw/SKILL.md) and upstream [license](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-btw/LICENSE).
