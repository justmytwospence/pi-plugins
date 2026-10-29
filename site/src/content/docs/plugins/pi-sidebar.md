---
title: pi-sidebar
description: A live, read-only side chat beside a working Pi session, in the same Pi process, built on the main session's prompt cache so a question costs little, or on another model for a second opinion.
plugin: pi-sidebar
---

## Quick reference

- **Use it for:** Ask what the main agent is doing, why, or how the code works, without interrupting it. Switch it to another model (`/model`) for a second opinion. Quiz mode (`/quiz`) also quizzes you on main's changes and tracks what you know. Heads-up mode, on by default, notes one thing worth knowing in Sidebar or above main's editor during longer runs (or only in Sidebar).
- **Enable:** Select `packages/pi-sidebar/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Ctrl+' opens or closes Sidebar. In Herdr, `prefix+h/l` moves between main and Sidebar as if Sidebar were a pane (with the bundled Herdr plugin). In Sidebar, your own keybindings apply: pi-vim's Ctrl+U/D and your transcript scroll keys (such as Ctrl+G) scroll it, Esc or Ctrl+C stops an answer, Ctrl+O expands tools and collapsed reasoning, and your thinking toggle shows or hides reasoning.
- **Settings:** `PI_SIDEBAR_KEYS` replaces the key. `PI_SIDEBAR_RATIO` sets Sidebar's share (default 0.5) until you drag the divider, which is remembered. `PI_SIDEBAR_MIN_COLUMNS` is the narrowest half for a side-by-side split (default 80). `PI_SIDEBAR_MODELS` lists favorite models for Sidebar (default: Pi's `enabledModels`), and `PI_SIDEBAR_MODEL` sets the one new sessions start with (default `same`, main's).
- **Requirements, cost & privacy:** Requires Pi's fullscreen mode. On main's model, each question reads main's context from main's cache, plus a small new part, and Sidebar asks first when that cache has probably expired. On another model, the first question reads main's transcript uncached once, and later ones read it from that model's own cache. The thread is stored as hidden entries in main's session.
- **Integrations & limits:** Works with Anthropic Messages, OpenAI Responses (including Codex) and Chat Completions. Sidebar uses main's tools, skills and templates; a guard refuses calls that would change anything, but it is not a sandbox. An optional pi-vim composer is supported. Sidebar steps aside while a dialog waits in main.

`pi-sidebar` splits Pi's fullscreen layout in two. Main's transcript, editor and footer reflow into one half, and Sidebar fills the other: side by side when each half keeps 80 columns, otherwise below main. Sidebar shares the right-hand side with pi-marimo's docked notebook view: opening one closes the other (event `pi-plugins.side-panel.v1`).

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
| Click | Clicking anywhere in a half focuses it. Clicks on dialogs and the divider do not. |
| Drag the divider | Resizes the halves, remembered per orientation. A double-click goes back to the default. |
| `/sidebar`, `/close` in Sidebar | Open or close Sidebar. |
| Ctrl+S | With pi-stash enabled, stashes Sidebar's draft in a stash of its own, apart from main's: the hint row shows `stashed`. Ctrl+S in an empty composer restores it, with text in both it swaps them, and it comes back on its own after a `/` command such as `/new`. It is kept while Sidebar is closed. |
| `/sidebar new`, `/new` in Sidebar | Starts a fresh thread. |
| `/sidebar model`, `/model` in Sidebar | Picks Sidebar's model: `Same as main` (the default) or a favorite, in Sidebar while it is open. `/model sol` or `/model provider/id` switches directly, `/model same` goes back. |

While Sidebar has focus, your keys do what they do in main, through Pi's keybindings:
- **Scrolling and search.** The focused half is Pi's primary scroll view, so these act on Sidebar while it has focus: your transcript scroll actions (such as Ctrl+G to the end), pi-vim's Ctrl+U/D in idle Normal mode, transcript search (Ctrl+Shift+F) and pi-copy's copy mode. The mouse wheel scrolls only the half under the pointer.
- **Editing.** Editor keys, history and autocomplete work as in main, including your list keys such as Ctrl+J/K.
- **Skills and prompt templates.** `/skill:name` and your templates run in Sidebar.
- **App actions.** Esc or Ctrl+C stops an answer, Ctrl+O expands tools and collapsed reasoning, your thinking toggle shows or hides reasoning, Ctrl+C clears an idle composer, and Ctrl+D never quits Pi.
- **Model keys.** Your model picker key (Ctrl+L by default) picks Sidebar's model, and your model cycling keys (Ctrl+P, Shift+Ctrl+P) step through `same` and your favorites.

Ctrl+' needs a terminal that reports it (the kitty keyboard protocol). Set `PI_SIDEBAR_KEYS=ctrl+.` (or a comma-separated list) to use other keys.

Herdr reads its prefix keys first, so `prefix+h/l` into Sidebar needs the Herdr plugin in `packages/pi-sidebar/herdr-plugin`.
- **The plugin:** bind its `pi-sidebar-nav.focus-left/down/up/right` actions in place of Herdr's `focus_pane_*` keys (the package README has the config).
- **In a Pi pane:** it hands the move to Pi as a reserved key (Ctrl+Alt+Shift+H/J/K/L). Pi moves between main and Sidebar when it can, and otherwise asks Herdr for the normal pane move.

How it looks:
- **Focus:** the half without focus is drawn faint, and an arrow in the middle of the divider (`◂`/`▸` beside main, `▴`/`▾` below it) points at the focused half. The focused Sidebar has a filled title bar and an accent composer border; while it has focus, main's editor borders (and pi-status-footer's gauge on them) turn muted. When main has focus, the title bar shows `● new answer` when an answer finished meanwhile. Dialogs, overlays and search highlights are never dimmed.
- **Pinned prompt:** once your latest question scrolls above the top, with pi-sticky-last-prompt enabled it is pinned on Sidebar's top row by the same bar main shows; click it to jump back. Clicks in the transcript (a tool card's "click to show more") work as in main.
- **Working row:** while Sidebar answers, Pi's own spinner row reads `Working`; with pi-status-footer showing main's working stats, it reads like main's: `Working (↓ 120 tokens · 4s)`.
- **Rendering:** messages, tool cards and reasoning use Pi's components, so pi-cc-render's styling applies. Reasoning follows main's `hideThinkingBlock` setting.

Sidebar's thread is stored as hidden entries in main's session. It follows `/tree` and comes back after resume and `/reload`.

## Quiz mode

Quiz mode is a voluntary tutor for main's work. It never blocks main or git.
- **Commands:** `/quiz` in Sidebar (or `/sidebar quiz` in main) switches it on and asks a question, or switches it off. `/quiz next` asks about main's latest changes. `/quiz progress` lists what you have shown you know in this repository, without a model call.
- **Questions:** each is about behaviour, failures or design reasons in the changed code, and asks for a prediction with a reason. Sidebar reads the diff before asking.
- **Adapting:** a correct answer gets a harder scenario. A wrong one gets a short explanation and a fresh scenario on the same concept. You can ask it to explain, or dispute a question.
- **Knowledge profile:** grades build a per-repository profile in `~/.pi/agent/pi-sidebar/knowledge/` (or `PI_SIDEBAR_KNOWLEDGE`). Harder questions count more and old evidence fades, so a concept is *proven*, *shaky* or *due* for review. Questions aim at your gaps.
- **Nudges:** when main finishes a run that changed files, Sidebar's notice says so. Nothing is sent until you ask.
- **Cost and privacy:** questions keep main's cache sharing intact. Rubrics and grades are hidden blocks in Sidebar's replies, never displayed. Answers stay in Sidebar's hidden thread and never reach main's model.

## Heads-up mode

During main's longer runs, heads-up mode occasionally checks for one thing you should know but might have missed: an unstated tradeoff, a result that looks off, or a risk. When Sidebar is open, the note becomes part of its thread, after any answer in progress. Ask about it there, or type `/known` if you knew it. When Sidebar is closed, the note appears above main's editor, and opening Sidebar moves it into Sidebar's thread. With notes set to show only in Sidebar, a note found while Sidebar is closed goes straight into its thread and waits there. The example below is an illustration:

```
✦ heads up · risk: Main skipped the failing integration tests.
  1: Learn more   2: Knew this already   0: Dismiss
```

- **Switch:** on by default. `/sidebar headsup off`, `on` or `sidebar` (notes only in Sidebar) sets it per session (stored in main's session), `/sidebar headsup` shows its cost so far, and `PI_SIDEBAR_HEADSUP` sets the default: `0` off, `sidebar` notes only in Sidebar.
- **When:** at main's turn boundaries, once a run has 5 replies or has gone on for 2 minutes. Checks are at most 3 minutes apart, with one more at the end of a long run. A check is skipped when main's cache has probably expired.
- **Answering above the editor:** type the digit on its own into main's empty editor.
  - **Learn more** shows an explanation the check already wrote. From there you can mark it understood, quote it into main's editor (**Ask main**), or ask Sidebar about it.
  - **Knew this already** marks the topic as known.
  - **Dismiss** closes it, and for 20 seconds `9` turns the mode off.
  
  Main never sees a note unless you send it there.
- **Memory:** known topics and recent notes go into quiz mode's per-repository knowledge profile. Each check lists them, along with the concepts proven in quiz mode, so it does not repeat itself across sessions.
- **Model:** checks run on Sidebar's model. On another model, a check reads main's session as a transcript with a cache of its own, so it pays for what main did since the last check; the first check after a pause longer than the cache's lifetime reads the whole transcript uncached.
- **Cost:** on main's model, a check is one request built from main's last request, so main's prompt cache serves almost all of it. You pay for main's activity since, about 600 tokens of instructions, the reply, and main's thinking setting. Checks pause after two in a row miss the cache. `PI_SIDEBAR_HEADSUP_DEBUG=1` logs each check to `~/.pi/agent/pi-sidebar/headsup.log`.

### Share notes

Checks can also suggest something worth sharing, as a drafted short post, a blog post, or both. The default bar is high: a specific claim someone could disagree with, a measurement that explains something, a named pattern recognizable beyond your setup, or a reversal learned the hard way, and it must matter to people who use none of your tools. Plumbing (how something was wired, configured, migrated or fixed), release notes and tool announcements never qualify, and an unsure check stays quiet. They are off until a destination is configured, a real heads-up always wins, and the check is told never to include secrets, private names or internal details. The example below is an illustration:

```
✦ heads up · worth sharing: Splicing a side request onto the agent's prompt cache.
  1: Review post   2: Blog draft   3: Blog outline   4: Not interested   0: Dismiss
```

- **Review post:** shows the draft and its length, then **Post to Bluesky**, **Edit** (Pi's editor), **Back** or **Discard**. Nothing is published until you choose Post.
- **Blog draft / outline:** one more request (built like a check, or run through Sidebar's own agent when an examples tool is set) writes a full draft (700 to 1500 words, an argument that opens with its thesis and uses claim-style headings only in long pieces) or a beat-based outline (claim, written-out hook, three to five beats with their evidence, strongest objection, written-out ending), saves it as markdown with front matter (title, date, status, source, topic and tags), and adds it to Sidebar's thread for revisions.
- **Not ready:** if the claim or beats cannot honestly be written from the session, the writer says so; nothing is saved and Sidebar reports why. With an examples tool (below), it also says so when your own earlier writing already makes the point: `already made by "<title>" (<url>)`.
- **Memory:** posting, drafting, Not interested and Discard mark the topic as known.
- **In Sidebar:** `/post` (with a confirm dialog), `/post edit`, `/post <text>`, `/draft`, `/draft outline`.
- **Configuration:** `PI_SIDEBAR_BLUESKY_HANDLE` + `PI_SIDEBAR_BLUESKY_APP_PASSWORD` (sign-in goes straight to the account's PDS, resolved from the handle, so self-hosted PDSes work; `PI_SIDEBAR_BLUESKY_SERVICE` names it instead, `PI_SIDEBAR_BLUESKY_WEB` sets the post links' web app, default `https://bsky.app`, or `none`), and `PI_SIDEBAR_DRAFTS_DIR` or `PI_SIDEBAR_DRAFTS_COMMAND` (markdown on stdin, `PI_SIDEBAR_DRAFT_TITLE`, `_SLUG`, `_KIND`, `_DATE`, `_REPO` in the environment; its first output line is reported). `PI_SIDEBAR_SHARE=0` keeps share notes off.
- **Guides:** `PI_SIDEBAR_SHARE_TASTE` and `PI_SIDEBAR_SHARE_STYLE` name markdown files (`~` expanded, read once at startup). The taste guide (cut at 4,000 characters) replaces the default bar for raising ideas and is applied strictly; confidentiality rules and the reply format stay. The style guide (cut at 12,000) is added to every draft and outline request and overrides the default style where they differ. Missing, empty or cut guides are reported by `/sidebar headsup`, which also lists the guides in use. Guides alone do not turn share notes on.
- **Examples tool:** `PI_SIDEBAR_SHARE_EXAMPLES_TOOL` names a read-only tool that finds example pieces for a text, such as an MCP tool that searches your own saved reading; Sidebar names no particular tool, and `PI_SIDEBAR_SHARE_EXAMPLES_TOOL=mcp__reader__similar_saved` is only an illustration. A side request cannot call tools, so with the tool set, drafts and outlines run through Sidebar's own agent instead: a normal Sidebar request on Sidebar's model (not the cheap side request), asked without the cost confirm because you asked for the draft, refused while Sidebar is answering, and given up after ten minutes. Sidebar need not be open; if it is, the exchange shows in its thread with the long instructions hidden and a line saying where the draft was saved. The tool must pass Sidebar's read-only guard (a read-only MCP tool, or a call from a codemode script, which the writer is told to use when the tool is only reachable there). `PI_SIDEBAR_SHARE_EXAMPLES_ARGS` adds a JSON object of extra arguments the writer passes to the tool exactly (filters, a tier, a result count; an illustration: `{"prefer":"archive","min_words":600}`); a value that is not a JSON object is ignored and reported in `/sidebar headsup`.
  - **Models of form only:** before writing, the writer calls the tool with the idea's claim and angle, and reads what comes back only as models of how pieces open, how the argument moves, length, headings and endings. It never copies their content or wording.
  - **Already made:** if the closest piece makes essentially the same point (judged from what it says: a similarity score or a "close" verdict is only a hint), the writer takes a clearly different angle the session supports, or replies `already made by "<title>" (<url>)`. Nothing is saved, and the topic is not marked as known.
  - **Front matter:** the pieces the writer used are listed as `examples:`, a list of `"title | url"` strings, and left out when it used none.

## Why it costs little

Main keeps its last provider request in memory. Each Sidebar request is built from four parts:

1. **Main's last request, unchanged.** The model, system prompt, tool declarations, thinking and effort settings, cache keys and every message all come from it.
2. **What main committed since.**
3. **Sidebar's instructions and conversation**, including this answer's tool calls.
4. **The live status**, last.

The provider serves the first part from the cache main already wrote. In real sessions of 17k to 845k tokens, Sidebar read main's whole prefix from the cache every time, with 500–2,000 uncached tokens per question.

Sidebar also caches its own part. It puts a 5-minute breakpoint on its last block before the status note. With a Claude subscription login, whose request already uses all four breakpoints, it takes the slot of the redundant first system one; main's prefix still reads fully from the cache. Later steps of an answer and follow-ups while main is idle then read Sidebar's earlier turns from the cache too. Its new tokens are written at 1.25× instead of sent at 1×.

To keep that prefix identical, Sidebar keeps main's tool declarations and refuses calls instead of removing tools.

## Another model

A second opinion is worth more from a model that did not write the work. `/model` in Sidebar (or `/sidebar model`) offers `Same as main` and your favorites that you are logged in to; the header names the model while it is not main's, and heads-up checks follow it. The choice is stored in main's session.
- **Favorites:** `PI_SIDEBAR_MODELS`, comma-separated, else Pi's `enabledModels`. Each is `provider/id`, a bare id, or a glob whose newest match counts (`anthropic/claude-opus-*` is always the latest Opus); `:level` sets the thinking level. A favorite that is main's own model counts as `same`.
- **What it reads:** its own system prompt (with the project's context files) and tools, its role note, then main's session as user-side `<main-transcript>` parts: the user's messages, main's replies, reasoning and tool calls, and tool results clipped to their first 1,200 and last 600 characters. It is told the work is another agent's, to read it critically and check claims against the code.
- **Its own cache:** each request adds main's activity since the last as a new part, placed among Sidebar's exchanges in the order things happened, so every request extends the previous one and the model's cache serves everything but the end. On Anthropic, the breakpoint takes the system prompt's style, so `PI_CACHE_RETENTION=long` keeps it for an hour; on OpenAI, a session id derived from main's routes it. In a live test on Anthropic, a second question after main had moved on read 96% from the cache.
- **When it asks first:** before reading 8k tokens or more into a cold cache, and after an answer that missed its own cache.
- **Size:** past 60% of the model's context window, the oldest messages are left out, with a note saying how many.

## What it can use

Everything main can, except changing anything. Sidebar loads the extensions behind main's tools, Pi's codemode, tool search and MCP, and main's skills and templates. One guard judges every call:
- **Refused:** `edit`, `write`, `todo`, `ask_user_question`, plan mode's tools, `herdr`, and tools marked destructive.
- **Allowed:** reading, search and web tools, codemode (its nested calls are judged one by one), tool search, pi-bg's job readers, and tools marked read-only.
- **Shell commands** (including pi-bg's `bg_run`): run when they only read. Plan mode's policy, loosened for flags like `rg -i`, globs, `2>/dev/null`, `cd` and variables set in the same command.
- **Anything else:** a Jev judgment of whether the call would change anything, refused at 50% or more, or when Jev is unavailable.
- **Subagents:** allowed, and they run under the same guard. [pi-subagents](/plugins/pi-subagents/) passes `PI_SIDEBAR_GUARD=1` to them through its subagent-environment channel.

It works from any point in the conversation. With no request of main's in memory, Sidebar rebuilds it from main's session and still lands on main's warm cache. This happens after a restart, resume, `/reload`, `/tree` or a compaction.

Sidebar never quietly re-reads main's context uncached. It asks inline (Enter sends, Esc keeps the question) when:
- main's cache has probably expired;
- the last answer missed the cache.

It aborts, sending nothing, if main's request vanishes mid-build, on an API or model mismatch, or too many cache breakpoints. It never keeps a cache warm with requests of its own. On [another model](#another-model), the questions it asks first are about that model's own cache.

## Limits

- Sidebar uses Pi's fullscreen layout, which Pi does not publish as an API. [pi-clear-screen](/plugins/pi-clear-screen/), [pi-copy](/plugins/pi-copy/) and [pi-sticky-last-prompt](/plugins/pi-sticky-last-prompt/) read it the same way and work with Sidebar open.
- While a dialog waits in main (one that holds `herdr:blocked`, such as a question from main, or any Pi select, confirm, input or extension dialog), Sidebar steps aside so the dialog renders full width for Herdr and its phone cards (herdr-web-ui, Collie).
- With Sidebar open, Collie reads only main's side of the split once `frames.toml` declares Sidebar's dividers (`panel_below` and `panel_beside`; see [remote clients](/guides/clients/)). A phone send types into whichever side holds the keys; when Sidebar does, Collie withholds Enter.
- Models that drop earlier thinking when a new user message arrives (Claude models before Opus 4.5 and Sonnet 4.6) can miss the cache when asked during main's tool calls. The miss check catches it.

## Checking the guard against your sessions

The repository's `guard` eval compares Jev's judgment with the guard's own rules. It takes shell commands from your saved sessions that the read-only policy settles (cleared as read-only, or plainly writing), asks the guard's question about up to 150 of each kind, and reports how many read-only commands Jev would refuse and how many writing ones it would clear, with the worst examples. It makes live, paid classifier requests, so it runs only on request (`npm run -s eval -- guard` from a checkout; `--dry` counts the requests first).

Claude Code's `/btw` and Codex's `/side` showed that a side question should reuse the main conversation's cache. [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) showed exact prompt replay; no code was copied from it.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-sidebar)
