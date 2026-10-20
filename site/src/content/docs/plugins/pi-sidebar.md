---
title: pi-sidebar
description: A live, read-only side chat in a Herdr pane beside a working Pi session, built on the main session's prompt cache so a question costs little.
plugin: pi-sidebar
---

## Quick reference

- **Use it for:** Ask what the main agent is doing, why, or how the code works while it keeps working, without interrupting it.
- **Enable:** Select `packages/pi-sidebar/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Ctrl+' opens Sidebar beside main, and hides or shows it from either pane. `/sidebar` does the same; `/sidebar new` starts a fresh thread.
- **Settings:** `PI_SIDEBAR_KEYS` replaces the key; `PI_SIDEBAR_RATIO` sets Sidebar's share of main's pane (default 0.5); `PI_SIDEBAR_MIN_COLUMNS` (default 80) is the narrowest half for a side-by-side split. The model and thinking always match main.
- **Requirements, cost & privacy:** Pi inside [Herdr](https://herdr.dev). Each question reads main's context from the cache, plus a small new part. Sidebar asks before sending when main's cache has probably expired. Main's last request (the whole conversation) is shared through owner-only files in the temp directory and removed when the session ends.
- **Integrations & limits:** Anthropic Messages, OpenAI Responses (including Codex) and Chat Completions. Read-only blocks tool calls; it is not a sandbox. A hidden Sidebar waits in a `sidebar-parked` tab.

`pi-sidebar` opens a second Pi session in a Herdr pane beside the main one (or below it, when main's pane is narrow), for talking about the work while it runs. Sidebar sees main's latest state: everything main has committed, plus what it is doing this second (the running tool and how long it has run, results of parallel calls that have finished, and the reply it is writing). It cannot change anything.

## Enable and requirements

Entry: `packages/pi-sidebar/src/index.ts`. To load it alone, merge this object into your `packages` array:

```json
{
  "packages": [
    {
      "source": "git:github.com/justmytwospence/pi-plugins",
      "extensions": ["packages/pi-sidebar/src/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Run Pi inside a Herdr pane. Outside Herdr, the key and command explain that Herdr is required. The Sidebar pane runs Pi with the same model, thinking level and extension flags as main, so the component needs no separate setup there.

## Controls

| Control | What it does |
| --- | --- |
| Ctrl+' in main | The first press splits main's pane into equal halves and opens Sidebar in the new one, focused: side by side when both halves keep 80 columns, otherwise one above the other. After that, it hides Sidebar when it is showing and brings it back when it is hidden. |
| Ctrl+' in Sidebar | Hides Sidebar and returns to main. The process keeps running in a `sidebar-parked` tab, so the thread is kept. |
| `/sidebar` | Same as the key. |
| `/sidebar new` | Opens Sidebar on a fresh thread. Inside Sidebar, `/new` does the same. |
| `/sidebar model` | Explains why there is no model override. |

Ctrl+' needs a terminal that reports it (the kitty keyboard protocol, passed through by Herdr). Set `PI_SIDEBAR_KEYS=ctrl+.` (or a comma-separated list) where main starts to use other keys.

Sidebar is a normal Pi session saved under `~/.pi/agent/sidebar-sessions/<main session id>/`, so `/tree`, branching and `/resume` work there. Opening Sidebar again for the same main session continues the latest thread.

## Why it costs little

Before each request, main keeps a copy of the request it is sending. Each Sidebar request is built in four layers:

1. **Main's last request, unchanged.** The model, system prompt, tool declarations, thinking and effort settings, cache keys, every message and every cache breakpoint all come from it.
2. **What main committed since.** Sidebar reads these entries from main's session file.
3. **Sidebar's instructions and the live status.**
4. **Sidebar's conversation.**

The provider serves the first layer from the cache main already wrote. Example from a live run against a ~22k-token context: Sidebar read 95% to 97% from the cache, with under 1k new input tokens and no cache writes.

To keep that prefix identical, Sidebar declares the same tools as main and blocks calls instead of removing tools. Reading tools, the web search and fetch tools, and shell commands that only read (plan mode's policy) run. Everything else gets a reason the model relays.

Sidebar never quietly re-reads main's context uncached:

- **Expired cache.** It asks before sending when main's last request is older than the cache TTL main asked for (5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`). Declining puts the prompt back in the editor.
- **Unexpected request.** It aborts without sending when main's request is missing, the API or model differs, or the request would exceed Anthropic's four cache breakpoints.
- **Missed cache.** It warns after an answer that read less than half of main's context from the cache, and asks before the next one.
- **No model override.** A cache belongs to one model and one set of thinking settings.
- **No warming.** It never keeps its own cache warm.

Its questions hold `herdr:blocked`, so Herdr and phone cards show Sidebar as waiting.

## Limits

- Models that drop earlier thinking when a new user message arrives (Claude models before Opus 4.5 and Sonnet 4.6) can miss the cache when asked during main's tool calls; the miss warning catches it.
- When main quits or switches sessions, Sidebar's pane closes and the shared files are removed. A `/reload` keeps both.
- Other suite components also run in Sidebar's Pi. [pi-tool-gate](/plugins/pi-tool-gate/) may still ask before reads outside the project.
- [pi-btw](/plugins/pi-btw/) is the in-process overlay alternative: it works outside Herdr, but its threads do not follow main and do not share main's cache.

Claude Code's `/btw` and Codex's `/side` showed that a side question should reuse the main conversation's cache. Two Herdr projects inspired the rest, with no code copied:

- [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw), for exact prompt replay in a pane.
- [herdr-sidekick](https://github.com/qapquiz/herdr-sidekick), for parking a pane in a tab.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-sidebar)
