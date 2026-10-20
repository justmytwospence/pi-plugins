# pi-sidebar

Sidebar is a read-only side chat that runs beside a working Pi session, inside the same Pi process. Ask it what the main agent is doing, why, or how the code works, while the main run keeps going.

Sidebar always sees main's latest state. Every request it sends starts with main's last request, byte for byte, so the provider serves almost all of it from the prompt cache main already wrote.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-sidebar/>.

## Install

Install the suite and select this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-sidebar/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Sidebar needs Pi's fullscreen mode (`"tuiMode": "fullscreen"`). In regular mode, the key and the command say so. To try it from a checkout for one run:

```sh
pi -e ./packages/pi-sidebar
```

## Use

```
┌────────── main (reflows) ──────────│────────── Sidebar ───────────┐
│ transcript                         │ ◧ Sidebar · read-only · main: bash 21s · 95% cached
│                                    │ you  what is it doing?       │
│                                    │ Sidebar's answer, in Pi's own rendering
│ ──────────────                     │ ──────────────               │
│ > main editor                      │ > ask about the work         │
│ footer                             │ enter ask · ctrl+' main · …  │
└────────────────────────────────────┴──────────────────────────────┘
```
*Illustration, not a screenshot.*

| Control | What it does |
| --- | --- |
| `Ctrl+'` in main | Opens Sidebar if it is closed, otherwise moves focus to it. |
| `Ctrl+'` in Sidebar | Moves focus back to main. Clicking Sidebar's header, notice or composer also focuses it. |
| `/sidebar` | Opens Sidebar, or hides it when it is open. |
| `/close` in Sidebar | Hides Sidebar. |
| `/sidebar new` (or `/new` in Sidebar) | Starts a fresh thread. |
| Enter | Asks. |
| Esc | Stops an answer while it streams. When idle, Esc returns to main; with pi-vim, that takes Esc in Normal mode. |
| Shift+↑/↓, Shift+PgUp/PgDn, mouse wheel | Scroll Sidebar's conversation. Plain PgUp/PgDn keep scrolling main's transcript. |
| `Ctrl+O` | Expands or collapses tool output in Sidebar. |
| `/sidebar model` | Explains why Sidebar always uses main's model. |

When Sidebar opens:
- **Layout:** main's pane splits into equal halves. They sit side by side when each half keeps at least 80 columns, and Sidebar goes below main otherwise. This is decided again on every resize.
- **Main:** main's transcript, editor and footer reflow into their half. Nothing is drawn over them.
- **Focus marker:** the divider and Sidebar's header turn to the accent color while Sidebar has focus.
- **Unread marker:** an answer that finishes while you are in main shows `● new answer`.

The composer is Pi's editor, or pi-vim's embedded editor when pi-vim is installed.

The header shows, live, what main is doing and how much of Sidebar's last answer came from the cache. While another dialog holds `herdr:blocked` (for example a question from main), Sidebar steps aside so the dialog renders full width. That is what herdr-web-ui's phone parser reads. Sidebar comes back once the dialog is answered.

**Thread storage**
- Sidebar's thread lives in main's session as hidden entries (never sent to main's model).
- `/sidebar new` and `/new` mark a fresh thread.
- The thread follows `/tree` in main, comes back after resume and `/reload`, and long tool results are cut before they are stored.

Settings, read from the environment Pi starts with:

- `PI_SIDEBAR_KEYS`: a comma-separated list of keys that replaces `ctrl+'`, for example `ctrl+.`. `Ctrl+'` reaches Pi only through terminals that report it (kitty keyboard protocol).
- `PI_SIDEBAR_RATIO`: Sidebar's share, from 0.15 to 0.85 (default 0.5).
- `PI_SIDEBAR_MIN_COLUMNS`: the narrowest half for a side-by-side split (default 80).

## How it stays current and cheap

Main keeps its last provider request in memory, together with the session entry it was built from. It also tracks a live status: running tools and how long they have run, results of parallel calls that have finished but are not yet committed, and the tail of the reply it is streaming.

Sidebar's agent is an in-process Pi session with none of main's extensions, only Sidebar's own policy. Each of its requests is built from four parts:

1. **Main's last request, unchanged.** The model, system prompt, tool declarations, thinking and effort settings, cache keys, every message and every cache breakpoint all come from main's request.
2. **What main committed since.** A tool call that is still running is described rather than replayed.
3. **Sidebar's instructions**, then Sidebar's earlier exchanges.
4. **The live status**, just before your newest question.

Only parts 2 to 4 are new to the provider. In live runs against a ~20k-token main context, answers read 88–96% from the cache, with 1–2k new tokens and no cache writes.

Read-only does not change the tool list: removing tools would change the request and lose the cache. Calls are blocked instead.
- **Allowed:** Sidebar's agent has `read`, `grep`, `find`, `ls` and `bash`. Shell commands are allowed only when they just read (plan mode's policy).
- **Web tools:** main's web search and fetch tools run too, loaded from the extension that provides them in main.
- **Blocked:** everything else, with a reason the model can relay.

## When it asks first

Sidebar never quietly re-reads main's context uncached. It asks inline (Enter sends, Esc keeps the question) when:

- main has not sent a request since Pi started (Sidebar would build one from main's transcript);
- main's cache has probably expired: main's last request is older than the TTL it asked for, which is 5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`;
- the last answer read less than half of main's context from the cache.

Sidebar refuses outright on an API it cannot share a cache with. It aborts a request without sending it when main's request is missing, the API or model differs, or Anthropic's limit of four cache breakpoints would be exceeded.

It always uses main's model and thinking settings: a cache belongs to one model and one set of settings. It never keeps its own cache warm.

Supported APIs: Anthropic Messages, OpenAI Responses (including Codex and Azure) and OpenAI Chat Completions. It has been tested live on Anthropic.

## Requirements and limits

**Fullscreen only.** Sidebar re-roots Pi's fullscreen layout. Pi does not publish that layout as an API; pi-clear-screen, pi-copy, pi-sticky-last-prompt and plan mode read it the same way. In regular mode, Sidebar does not open.

**Model behavior.** On models that drop earlier thinking when a new user message arrives (Claude models before Opus 4.5 and Sonnet 4.6), a question asked during main's tool calls can miss the cache. The miss check catches this.

**Keys while Sidebar has focus**
- Typing goes only to Sidebar.
- Main's own keys (Esc to stop main, model and thinking shortcuts) work again after `Ctrl+'`.
- Plain PgUp/PgDn always scroll main.

## Prior art

- Claude Code's `/btw` and Codex's `/side` showed that a side question should share the main conversation's cache.
- [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) (MIT, Oscar Gabriel) replays a parent's exact prompt and messages.
- Plan mode's planner sessions and chat rendering in this suite are the model for the in-process agent and its transcript. `src/pi-chat.ts` is copied from plan mode.

## Development

```sh
cd packages/pi-sidebar
npm ci
npm run check
```
