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
| Drag the divider | Resizes the halves. The size is remembered per orientation (beside or below) in `~/.pi/agent/pi-sidebar.json`; double-click the divider to go back to the default. |
| `/sidebar`, `/close` in Sidebar | Open or close Sidebar. |
| `/sidebar new` (or `/new` in Sidebar) | Starts a fresh thread. |
| Enter | Asks. |
| `/sidebar headsup [on\|off]` | Heads-up mode's state and cost, or switches it on or off for the session. |
| `/sidebar model` | Explains why Sidebar always uses main's model. |

While Sidebar has focus, your keys do what they do in main. They are resolved through Pi's keybindings, so changes in `~/.pi/agent/keybindings.json` apply in both halves:
- **Scrolling and search.** While Sidebar has focus, its transcript is Pi's primary scroll view, so everything Pi aims at the transcript acts on Sidebar:
  - Pi's scroll actions (`tui.altScreen.*`, for example `tui.altScreen.bottom` on Ctrl+G or Ctrl+End);
  - pi-vim's Ctrl+U/D in idle Normal mode (in Insert mode they edit);
  - transcript search (`tui.altScreen.search`, Ctrl+Shift+F);
  - the scroll-to-end indicator and pi-copy's copy mode.

  With main focused, they act on main again. The mouse wheel scrolls only the half under the pointer, and never spills into the other half at a transcript's top or end. The hint row shows your keys.
- **Editing.** The composer is Pi's editor, or pi-vim's embedded editor when pi-vim is installed, so editor keys, history and autocomplete follow your bindings. Your `tui.select.*` keys (such as Ctrl+J/K) move through autocomplete lists.
- **Skills and prompt templates.** `/skill:name` and your prompt templates run in Sidebar as in main. Other slash commands are main's.
- **App actions.**
  - `app.interrupt` (Esc) stops Sidebar's answer.
  - `app.tools.expand` (Ctrl+O) expands tool output, and with pi-cc-render collapsed reasoning too, as in main.
  - `app.thinking.toggle` shows or hides reasoning.
  - `app.clear` (Ctrl+C) stops Sidebar's answer while it runs, as in Claude Code, and otherwise clears the composer.
  - `app.exit` (Ctrl+D) never quits Pi from Sidebar.

How it looks:
- **Layout:** main's pane splits into equal halves. They sit side by side when each half keeps at least 80 columns, and Sidebar goes below main otherwise. This is decided again on every resize. Main's transcript, editor and footer reflow into their half; nothing is drawn over them.
- **Focus:** the half without focus is drawn faint, and an arrow in the middle of the divider (`◂`/`▸` beside main, `▴`/`▾` below it) points at the focused half. The focused Sidebar has a filled title bar and an accent composer border; while it has focus, main's editor borders (and pi-status-footer's gauge on them) turn muted. When main has focus, the title bar shows `● new answer` when an answer finished meanwhile. Dialogs, overlays and search highlights are never dimmed.
- **Pinned prompt:** once your latest question scrolls above the top, it is pinned on Sidebar's top row as main's pi-sticky-last-prompt bar is; click it to jump back. Clicks in the transcript (a tool card's "click to show more") work as in main.
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

The header shows, live, what main is doing and how much of Sidebar's last answer came from the cache. While a dialog waits in main (one that holds `herdr:blocked`, such as a question from main, or any Pi select, confirm, input or extension dialog), Sidebar steps aside so the dialog renders full width. That is what herdr-web-ui's and Collie's phone readers read. Sidebar comes back once the dialog is answered. Collie does not yet find main's editor while Sidebar is open (it takes Sidebar's composer for it, or finds none when Sidebar is beside main), so a phone send through Collie may be refused or misread until Sidebar is closed; `npm run check:clients` tracks this.

**Thread storage**
- Sidebar's thread lives in main's session as hidden entries (never sent to main's model).
- `/sidebar new` and `/new` mark a fresh thread.
- The thread follows `/tree` in main, comes back after resume and `/reload`, and long tool results are cut before they are stored.

Settings, read from the environment Pi starts with:

- `PI_SIDEBAR_KEYS`: a comma-separated list of keys that replaces `ctrl+'`, for example `ctrl+.`. `Ctrl+'` reaches Pi only through terminals that report it (kitty keyboard protocol).
- `PI_SIDEBAR_FOCUS_KEYS`: optional keys that switch focus between main and Sidebar directly, for use outside Herdr.
- `PI_SIDEBAR_RATIO`: Sidebar's share, from 0.15 to 0.85 (default 0.5), until you drag the divider.
- `PI_SIDEBAR_PREFS`: where the dragged size is kept (default `~/.pi/agent/pi-sidebar.json`).
- `PI_SIDEBAR_MIN_COLUMNS`: the narrowest half for a side-by-side split (default 80).
- `PI_SIDEBAR_KNOWLEDGE`: where quiz mode and heads-up mode keep their knowledge profiles (default `~/.pi/agent/pi-sidebar/knowledge`).
- `PI_SIDEBAR_HEADSUP`: `0` starts sessions with heads-up mode off; `sidebar` keeps it on but shows notes only in Sidebar. `PI_SIDEBAR_HEADSUP_DEBUG=1` logs its checks.

## Quiz mode

Quiz mode turns Sidebar into a tutor for main's work. You switch it on when you want to learn what main changed and show that you understand it. It never blocks main, git or anything else.

- **`/quiz`** (in Sidebar's composer, or `/sidebar quiz` in main) switches it on and asks the first question, or switches it off. The setting is stored in main's session, so it follows `/tree` and comes back after resume and `/reload`.
- **`/quiz next`** asks about what main changed most recently. **`/quiz progress`** lists what you have shown you know in this repository, without a model call.
- **Questions** are about what the code does: a concrete scenario, a failure, why main chose a design, what an invariant protects. Each asks for a prediction and a short reason, never for a file or function name. Sidebar reads the change (`git diff`, the code) before it asks, rather than trusting main's description.
- **Answering** is ordinary chat. After a correct answer comes a harder question, often a new scenario. After a partial or wrong one, Sidebar explains the gap briefly and asks a fresh scenario on the same concept. Ask it to explain, say you don't know, or dispute a question (it checks the code and corrects itself). Side questions get normal answers.
- **Nudges:** while quiz mode is on and main finishes a run that changed files, Sidebar's notice says so (`Main changed 3 files: /quiz next asks about them`). Nothing is sent until you ask.
- **Header:** `quiz · 3 proven · 1 shaky` while it is on.

**What it learns about you.** Each graded answer updates a knowledge profile kept per repository (by git root) in `~/.pi/agent/pi-sidebar/knowledge/`, so it carries across sessions.
- **Evidence:** each concept keeps weighted evidence for and against. Harder questions count more, and old evidence fades with a 14-day half-life.
- **Standing:** a concept is *proven* at 80% mastery with at least two correct answers, which takes harder than recall-level questions. It is *shaky* below 50%, and *due* when it has gone unpractised for longer than the half-life.
- **Steering:** every question carries the concepts that matter now (on the changed files, then the weakest), so Sidebar aims at your gaps and does not re-ask what you have proven.

**How it works.**
- **Cache:** quiz mode keeps Sidebar's cache sharing intact. Its fixed rules join Sidebar's role note and change only when you toggle the mode. What changes per question (the changed files, your profile) rides in the live status at the end.
- **Hidden blocks:** the model has no tool of its own, so it ends each question with a hidden rubric (`<quiz-key>`) and each graded answer with a hidden grade (`<quiz-update>`, JSON). Sidebar never displays them, even while they stream. The model reads its own rubric when it grades, so grading stays consistent. A grade that cannot be read is not counted, and Sidebar says so.
- **Privacy:** your answers stay in Sidebar's hidden thread and never reach main's model.

## Heads-up mode

Heads-up mode watches main's longer runs for one thing you should know but might have missed. Examples are a tradeoff main chose without saying so, a result that looks off, or a risk in what it did. When a check finds one and Sidebar is open, the note arrives in Sidebar's thread. If Sidebar is answering at that moment, the note waits until the answer ends. Ask about it by typing in Sidebar, which knows what it raised, or type `/known` if you already knew it. With Sidebar closed, a short note appears above main's editor instead, and opening Sidebar moves it into Sidebar's thread. With notes set to show only in Sidebar (below), nothing appears above main's editor: a note found while Sidebar is closed goes into its thread and waits there.

```
✦ heads up · check this result: sum.py's "total" covers only north; it excludes every
  south row.
  1: Learn more   2: Knew this already   0: Dismiss
```
*Illustration, not a screenshot.*

The note is laid out like pi-recap's `※ recap:` line (mark, lowercase label, text hanging under it, same wrap), so the two read as a pair when both show; the note keeps the accent color because it asks for an answer.

It is on by default. `/sidebar headsup off` switches it off for the session, `/sidebar headsup on` switches it back on, and `/sidebar headsup sidebar` keeps it on with notes only in Sidebar. The setting is stored in main's session, so it follows `/tree` and comes back after resume and `/reload`. Set `PI_SIDEBAR_HEADSUP=0` to start every session with it off, or `PI_SIDEBAR_HEADSUP=sidebar` to start them with notes only in Sidebar.

**When it checks.** Checks happen at main's turn boundaries, once a run is long (5 replies or 2 minutes). They are at most 3 minutes apart, and a long run gets one more check when it ends. There is never a check while one is running or while a note is showing. A check is skipped, with nothing sent, when main's prompt cache has probably expired, when Sidebar cannot share main's API, or when no copy of main's last request is in memory (after `/reload`, until main sends again).

**In Sidebar.** The note is part of Sidebar's conversation: an answer that carries the note and its explanation, preceded by a hidden marker that tells the model it raised the note unasked. `/known` marks the last note as known. `/headsup` in Sidebar works like `/sidebar headsup`.

**Answering a note above the editor.** Type a digit on its own into main's empty editor. Digits typed anywhere else, or while a dialog is open, go where they always go.
- **Learn more** shows the short explanation the same check wrote, with no further request. It then offers:
  - **Understood**: closes the note and marks the topic as known.
  - **Ask main**: puts the note, quoted, in main's editor, so you can add a question and send it.
  - **Ask Sidebar**: opens Sidebar and asks it about the note. Outside fullscreen mode it falls back to Ask main.
  - **Dismiss**
- **Knew this already** closes the note and marks the topic as known.
- **Dismiss** closes it. For 20 seconds afterwards, `9` turns heads-up mode off for the session.

Main never sees a note unless you send it to main.

**Memory.** Topics you mark as known, and the last 20 notes, go into the repository's knowledge profile that quiz mode uses (`~/.pi/agent/pi-sidebar/knowledge/`). Every check lists them, together with the concepts you have proven in quiz mode, as things not to raise again, in this session and later ones.

**Cost.** A check is one request on main's model, outside any Pi session, so no extension in main sees it.
- **Cache sharing:** it starts with main's last request byte for byte, the way Sidebar's requests do, so main's prompt cache serves almost all of it.
- **Newly paid:** what main committed since, a fixed instruction block of about 600 tokens, the reply, and main's thinking setting.
- **No breakpoint:** it adds no cache breakpoint of its own, since nothing reuses it.
- **Misses:** after two checks in a row that miss main's cache, checks pause until you run `/sidebar headsup on`.
- **Totals:** `/sidebar headsup` shows the checks, notes and tokens for this session.
- **Debug log:** `PI_SIDEBAR_HEADSUP_DEBUG=1` logs every check (trigger, usage and raw reply) to `~/.pi/agent/pi-sidebar/headsup.log`.

**No tools.** The check keeps main's tool declarations, because removing them would break the cache. A reply that calls a tool counts as having no note.

## How it stays current and cheap

Main keeps its last provider request in memory, together with the session entry it was built from. It also tracks a live status: running tools and how long they have run, results of parallel calls that have finished but are not yet committed, and the tail of the reply it is streaming.

Sidebar's agent is an in-process Pi session. It loads the extensions behind main's tools (and Pi's built-in codemode, tool search and MCP), main's skills and prompt templates, and Sidebar's guard. Main's other extension hooks (footers, cache prompts and so on) do not run twice. Each of its requests is built from four parts:

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

## What Sidebar can use

Everything main can, except changing anything. Read-only does not change the tool list: removing tools would change the request and lose the cache. Instead, every call passes one guard (`src/guard.ts`):
- **Refused:** `edit`, `write`, `todo`, `ask_user_question`, plan mode's tools, `herdr_child`, and any tool marked destructive.
- **Allowed:** reading and search tools, web search and fetch (including `web_enable`), `codemode` (each nested call passes the guard too), `tool_search`, pi-bg's `bg_wait`/`bg_logs`/`bg_kill`, and any tool marked read-only (MCP's `readOnlyHint`).
- **Shell commands** (`bash`, `powershell`, pi-bg's `bg_run`): run when they only read. The policy is plan mode's, loosened for reading: flags such as `rg -i`, globs, `2>/dev/null` and `2>&1`, input redirection, `cd`, and `$VAR` set earlier in the same command or from `HOME`, `PWD`, `USER` and `TMPDIR`. Writes, `sed -i`, command substitution and unknown variables are never cleared by the policy.
- **Anything else** (an unfamiliar command, a tool without hints): one Jev judgment (`typesafe/jev-latest` through Pi's classifier models, 3 s timeout) of whether the call would change anything. It is refused at 50% or more, or when Jev is unavailable.
- **Subagents:** Sidebar may start them with pi-subagents, and they run under the same guard. pi-subagents asks the `pi-plugins.subagent-env.v1` event channel for extra environment, and Sidebar adds `PI_SIDEBAR_GUARD=1`. With that set, pi-sidebar in the subagent installs only the guard. An older pi-subagents that does not answer the channel's probe gets no subagents from Sidebar.

A refusal comes back to the model with its reason, and Sidebar tells you what to ask main instead. The guard judges calls; it is not a sandbox.

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

**Keys while Sidebar has focus:** typing goes only to Sidebar, except a prompt another program types into the pane (`herdr agent prompt`, pi-herdr's `send`, a phone client): a paste into Sidebar's empty composer followed by Enter within 0.7 s is sent to main instead (steering main's turn if it is working), with a notice in Sidebar. Main-only actions (stopping main, model shortcuts) work again once main has focus. Transcript search and previous/next prompt jumps act on the focused half.

## Prior art

- Claude Code's `/btw` and Codex's `/side` showed that a side question should share the main conversation's cache.
- [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) (MIT, Oscar Gabriel) replays a parent's exact prompt and messages.
- Plan mode's planner sessions and chat rendering in this suite are the model for the in-process agent and its transcript. `src/pi-chat.ts` is copied from plan mode.
- [pi-stereo-view](https://github.com/alexshpunt/pi-stereo-view) (MIT, Alex Shpunt) splits Pi's fullscreen history into two panels. Sidebar takes three of its techniques:
  - the focused panel's scroll view acts as Pi's primary;
  - the wheel is consumed per half;
  - the divider can be dragged and its size is remembered.

## Development

```sh
cd packages/pi-sidebar
npm ci
npm run check
```
