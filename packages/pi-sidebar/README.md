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
| `Ctrl+'` | Opens Sidebar, focused, or closes it from either half. The thread is kept. |
| Herdr `prefix+h/l` (or `j/k` when Sidebar is below main) | Move between main and Sidebar as if Sidebar were a Herdr pane. Any other move is Herdr's normal pane move. Needs the bundled Herdr plugin (below). |
| Click | Clicking Sidebar's title, notice or composer focuses it, and clicking main's editor focuses main. |
| `/sidebar`, `/close` in Sidebar | Open or close Sidebar. |
| `/sidebar new` (or `/new` in Sidebar) | Starts a fresh thread. |
| Enter | Asks. |
| `/sidebar model` | Explains why Sidebar always uses main's model. |

While Sidebar has focus, your keys do what they do in main. They are resolved through Pi's keybindings, so changes in `~/.pi/agent/keybindings.json` apply in both halves:
- **Scrolling.** Pi's transcript scroll actions (`tui.altScreen.pageUp/pageDown/halfPageUp/halfPageDown/lineUp/lineDown/top/bottom`: PgUp/PgDn, Ctrl+Home and Ctrl+End by default, plus anything you added, such as Ctrl+G) scroll Sidebar instead of main. The mouse wheel scrolls whichever half it is over.
- **Editing.** The composer is Pi's editor, or pi-vim's embedded editor when pi-vim is installed, so editor keys, history and autocomplete follow your bindings. With pi-vim, Ctrl+U/D in idle Normal mode half-page scroll Sidebar, as they do in main.
- **App actions.**
  - `app.interrupt` (Esc) stops Sidebar's answer.
  - `app.tools.expand` (Ctrl+O) expands tool output.
  - `app.thinking.toggle` shows or hides reasoning.
  - `app.clear` (Ctrl+C) clears the composer.
  - `app.exit` (Ctrl+D) never quits Pi from Sidebar.

How it looks:
- **Layout:** main's pane splits into equal halves. They sit side by side when each half keeps at least 80 columns, and Sidebar goes below main otherwise. This is decided again on every resize. Main's transcript, editor and footer reflow into their half; nothing is drawn over them.
- **Focus:** the focused Sidebar has a filled title bar and an accent divider and composer border. When main has focus, Sidebar is drawn faint, except for `● new answer` when an answer finished meanwhile.
- **Working row:** while Sidebar answers, Pi's own spinner row reads `Working (↓ 120 tokens · 4s)`, the same message pi-status-footer gives main, or `Retrying…`.
- **Rendering:** messages, tool cards and reasoning use Pi's components, so pi-cc-render's styling applies too. Reasoning follows main's `hideThinkingBlock` setting (pi-cc-render's compact "Thought for…" title when hidden). Sidebar's own thinking toggle lasts until main's setting changes.

### Herdr navigation

Herdr reads its prefix keys before Pi sees them, so moving into Sidebar with `prefix+h/l` needs the small Herdr plugin in `herdr-plugin/`. Its `focus-left/down/up/right` actions work like this:
- **Pi panes:** the plugin sends the pane a reserved key, Ctrl+Alt+Shift+H/J/K/L. Pi moves between main and Sidebar when it can, and otherwise asks Herdr for the normal pane move.
- **Other panes:** they get the normal pane move right away.

```sh
herdr plugin install justmytwospence/pi-plugins/packages/pi-sidebar/herdr-plugin --ref <commit> --yes
```

```toml
# ~/.config/herdr/config.toml: replace Herdr's own pane focus keys
[keys]
focus_pane_left = ""
focus_pane_down = ""
focus_pane_up = ""
focus_pane_right = ""

[[keys.command]]
key = "prefix+h"
type = "plugin_action"
command = "pi-sidebar-nav.focus-left"
# ...and prefix+j/k/l -> focus-down/focus-up/focus-right
```

Bind these only where your Pi sessions load pi-sidebar. A Pi without it ignores the reserved keys, so `prefix+h/l` would do nothing from that pane.

The header shows, live, what main is doing and how much of Sidebar's last answer came from the cache. While another dialog holds `herdr:blocked` (for example a question from main), Sidebar steps aside so the dialog renders full width. That is what herdr-web-ui's phone parser reads. Sidebar comes back once the dialog is answered.

**Thread storage**
- Sidebar's thread lives in main's session as hidden entries (never sent to main's model).
- `/sidebar new` and `/new` mark a fresh thread.
- The thread follows `/tree` in main, comes back after resume and `/reload`, and long tool results are cut before they are stored.

Settings, read from the environment Pi starts with:

- `PI_SIDEBAR_KEYS`: a comma-separated list of keys that replaces `ctrl+'`, for example `ctrl+.`. `Ctrl+'` reaches Pi only through terminals that report it (kitty keyboard protocol).
- `PI_SIDEBAR_FOCUS_KEYS`: optional keys that switch focus between main and Sidebar directly, for use outside Herdr.
- `PI_SIDEBAR_RATIO`: Sidebar's share, from 0.15 to 0.85 (default 0.5).
- `PI_SIDEBAR_MIN_COLUMNS`: the narrowest half for a side-by-side split (default 80).

## How it stays current and cheap

Main keeps its last provider request in memory, together with the session entry it was built from. It also tracks a live status: running tools and how long they have run, results of parallel calls that have finished but are not yet committed, and the tail of the reply it is streaming.

Sidebar's agent is an in-process Pi session with none of main's extensions, only Sidebar's own policy. Each of its requests is built from four parts:

1. **Main's last request, unchanged.** The model, system prompt, tool declarations, thinking and effort settings, cache keys and every message all come from main's request.
2. **What main committed since.** A tool call that is still running is described rather than replayed.
3. **Sidebar's instructions and its conversation**, including this answer's tool calls so far.
4. **The live status**, last, because it changes on every request.

The provider serves part 1 from the cache main already wrote. In your own sessions (contexts of 17k to 845k tokens), Sidebar read main's whole prefix from the cache every time, with 500–2,000 uncached tokens per question and no cache writes for main's part.

**Cache breakpoints.** Anthropic allows four per request.
- **Main's:** Sidebar keeps the one at the end of main's conversation, where main's cache entry is.
- **Sidebar's own (5-minute):** sits on Sidebar's last block before the status note, so the next step of an answer, or the next question while main is idle, reads Sidebar's own thread from the cache too.
- **When main's request already uses all four** (a Claude subscription login marks both system blocks), Sidebar takes the slot of the first one. The second covers more of the same prefix, and moving a breakpoint does not change what reads from the cache. In a live test, main's prefix still read 27,606 of 27,608 tokens. Later steps and follow-ups read Sidebar's earlier turns, and only about 60 tokens per request went uncached.
- **The trade-off:** Sidebar's new tokens are written at 1.25× instead of sent at 1×. That costs a few hundred tokens' worth on a one-off question and pays off as soon as an answer takes a tool step or you ask a follow-up.
- **Caveat:** like main, a follow-up re-reads an earlier answer's reasoning uncached, as finished turns' thinking does not stay in the same form.

Read-only does not change the tool list: removing tools would change the request and lose the cache. Calls are blocked instead.
- **Allowed:** Sidebar's agent has `read`, `grep`, `find`, `ls` and `bash`. Shell commands are allowed only when they just read (plan mode's policy).
- **Web tools:** main's web search and fetch tools run too, loaded from the extension that provides them in main.
- **Blocked:** everything else, with a reason the model can relay.

## When it asks first

Sidebar works from any point in the conversation. When main has no request in memory, Sidebar rebuilds main's request from its session and puts the cache breakpoint where main's last request ended, so a warm cache is still hit. This happens after a restart, resume, `/reload`, `/tree` or a compaction. In a live test after a restart it answered 97% from the cache.

Sidebar never quietly re-reads main's context uncached. It asks inline (Enter sends, Esc keeps the question) when:

- main's cache has probably expired: main's last request (or, without one in memory, its last answer) is older than the cache TTL, which is 5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`;
- the last answer read less than half of main's context from the cache.

Sidebar refuses outright on an API it cannot share a cache with. It aborts a request without sending it when main's request vanishes while one is being built, the API or model differs, or Anthropic's limit of four cache breakpoints would be exceeded.

It always uses main's model and thinking settings: a cache belongs to one model and one set of settings. It never keeps its own cache warm.

Supported APIs: Anthropic Messages, OpenAI Responses (including Codex and Azure) and OpenAI Chat Completions. It has been tested live on Anthropic.

## Requirements and limits

**Fullscreen only.** Sidebar re-roots Pi's fullscreen layout. Pi does not publish that layout as an API; pi-clear-screen, pi-copy, pi-sticky-last-prompt and plan mode read it the same way. In regular mode, Sidebar does not open.

**Model behavior.** On models that drop earlier thinking when a new user message arrives (Claude models before Opus 4.5 and Sonnet 4.6), a question asked during main's tool calls can miss the cache. The miss check catches this.

**Keys while Sidebar has focus:** typing goes only to Sidebar. Main-only actions (stopping main, model shortcuts) work again once main has focus. Transcript search and previous/next prompt jumps still act on main.

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
