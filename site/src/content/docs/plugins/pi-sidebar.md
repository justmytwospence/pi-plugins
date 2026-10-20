---
title: pi-sidebar
description: A live, read-only side chat beside a working Pi session, in the same Pi process, built on the main session's prompt cache so a question costs little.
plugin: pi-sidebar
---

## Quick reference

- **Use it for:** Ask what the main agent is doing, why, or how the code works, without interrupting it.
- **Enable:** Select `packages/pi-sidebar/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Ctrl+' opens or closes Sidebar. In Herdr, `prefix+h/l` moves between main and Sidebar as if Sidebar were a pane (with the bundled Herdr plugin). In Sidebar, your own keybindings apply: PgUp/PgDn and your other transcript scroll keys scroll it, Esc stops an answer, Ctrl+O expands tools, and your thinking toggle shows or hides reasoning.
- **Settings:** `PI_SIDEBAR_KEYS` replaces the key. `PI_SIDEBAR_RATIO` sets Sidebar's share (default 0.5). `PI_SIDEBAR_MIN_COLUMNS` is the narrowest half for a side-by-side split (default 80). The model and thinking always match main.
- **Requirements, cost & privacy:** Requires Pi's fullscreen mode. Each question reads main's context from the cache, plus a small new part, and Sidebar asks first when that cache has probably expired. The thread is stored as hidden entries in main's session.
- **Integrations & limits:** Works with Anthropic Messages, OpenAI Responses (including Codex) and Chat Completions. Read-only blocks tool calls; it is not a sandbox. An optional pi-vim composer is supported. Sidebar steps aside while a dialog holds `herdr:blocked`.

`pi-sidebar` splits Pi's fullscreen layout in two. Main's transcript, editor and footer reflow into one half, and Sidebar fills the other: side by side when each half keeps 80 columns, otherwise below main.

Sidebar is a second agent inside main's Pi process. It sees main's latest state:
- everything main has committed;
- what main is doing this second: the running tool and how long it has run, results of parallel calls that have finished, and the reply it is writing.

It cannot change anything.

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

Use Pi's fullscreen mode (`"tuiMode": "fullscreen"`). In regular mode, the key and the command explain that Sidebar needs it.

## Controls

| Control | What it does |
| --- | --- |
| Ctrl+' | Opens Sidebar, focused, or closes it from either half. The thread is kept. |
| Herdr `prefix+h/l` (`j/k` when Sidebar is below) | Moves between main and Sidebar as if Sidebar were a Herdr pane. Other moves are Herdr's normal pane moves. |
| Click | Clicking Sidebar focuses it; clicking main's editor focuses main. |
| `/sidebar`, `/close` in Sidebar | Open or close Sidebar. |
| `/sidebar new`, `/new` in Sidebar | Starts a fresh thread. |

While Sidebar has focus, your keys do what they do in main, through Pi's keybindings:
- **Scrolling.** The transcript scroll actions (PgUp/PgDn, Ctrl+Home/End, and anything you bound, such as Ctrl+G) scroll Sidebar.
- **Editing.** Editor keys, history and autocomplete work as in main, and so do pi-vim's Ctrl+U/D.
- **App actions.** Esc stops an answer, Ctrl+O expands tools, your thinking toggle shows or hides reasoning, Ctrl+C clears the composer, and Ctrl+D never quits Pi.

Ctrl+' needs a terminal that reports it (the kitty keyboard protocol). Set `PI_SIDEBAR_KEYS=ctrl+.` (or a comma-separated list) to use other keys.

Herdr reads its prefix keys first, so `prefix+h/l` into Sidebar needs the Herdr plugin in `packages/pi-sidebar/herdr-plugin`.
- **The plugin:** bind its `pi-sidebar-nav.focus-left/down/up/right` actions in place of Herdr's `focus_pane_*` keys (the package README has the config).
- **In a Pi pane:** it hands the move to Pi as a reserved key (Ctrl+Alt+Shift+H/J/K/L). Pi moves between main and Sidebar when it can, and otherwise asks Herdr for the normal pane move.

How it looks:
- **Focus:** the focused Sidebar has a filled title bar and an accent divider and composer border. When main has focus, Sidebar is faint, except for `● new answer`.
- **Working row:** while Sidebar answers, Pi's own spinner row reads `Working (↓ 120 tokens · 4s)`.
- **Rendering:** messages, tool cards and reasoning use Pi's components, so pi-cc-render's styling applies. Reasoning follows main's `hideThinkingBlock` setting.

Sidebar's thread is stored as hidden entries in main's session. It follows `/tree` and comes back after resume and `/reload`.

## Why it costs little

Main keeps its last provider request in memory. Each Sidebar request is built from four parts:

1. **Main's last request, unchanged.** The model, system prompt, tool declarations, thinking and effort settings, cache keys, every message and every cache breakpoint all come from it.
2. **What main committed since.**
3. **Sidebar's instructions and earlier exchanges.**
4. **The live status, then your question.**

The provider serves the first part from the cache main already wrote. In live runs against a ~20k-token context, answers read 88–96% from the cache, with 1–2k new input tokens and no cache writes.

To keep that prefix identical, Sidebar keeps main's tool declarations and blocks calls instead of removing tools.
- **Allowed:** reading tools, main's web search and fetch tools, and shell commands that only read (plan mode's policy).
- **Blocked:** everything else, with a reason the model relays.

It works from any point in the conversation. With no request of main's in memory, Sidebar rebuilds it from main's session and still lands on main's warm cache. This happens after a restart, resume, `/reload`, `/tree` or a compaction.

Sidebar never quietly re-reads main's context uncached. It asks inline (Enter sends, Esc keeps the question) when:
- main's cache has probably expired;
- the last answer missed the cache.

It aborts, sending nothing, if main's request vanishes mid-build, on an API or model mismatch, or too many cache breakpoints. There is no model override, and it never keeps its own cache warm.

## Limits

- Sidebar uses Pi's fullscreen layout, which Pi does not publish as an API. [pi-clear-screen](/plugins/pi-clear-screen/), [pi-copy](/plugins/pi-copy/) and [pi-sticky-last-prompt](/plugins/pi-sticky-last-prompt/) read it the same way and work with Sidebar open.
- While a dialog holds `herdr:blocked` (for example a question from main), Sidebar steps aside so the dialog renders full width for Herdr and its phone cards.
- Models that drop earlier thinking when a new user message arrives (Claude models before Opus 4.5 and Sonnet 4.6) can miss the cache when asked during main's tool calls. The miss check catches it.
- [pi-btw](/plugins/pi-btw/) is the overlay alternative. It works in regular mode, but its threads do not follow main and do not share main's cache.

Claude Code's `/btw` and Codex's `/side` showed that a side question should reuse the main conversation's cache. [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) showed exact prompt replay; no code was copied from it.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-sidebar)
