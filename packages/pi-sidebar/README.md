# pi-sidebar

Sidebar is a read-only side chat in a Herdr pane beside a Pi session that is working. Ask it what the main agent is doing, why, or how the code works, while the main run keeps going. Sidebar always sees main's latest state. Every request it sends starts with main's last request, byte for byte, so the provider serves almost all of it from the prompt cache main already wrote.

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

To try it from a checkout for one run, inside a Herdr pane:

```sh
pi -e ./packages/pi-sidebar
```

The Sidebar pane starts with main's extension flags (`-e`, `-ne`, `--no-mcp`, `--no-skills`), so it loads this extension even when main loaded it with `-e`.

## Use

| Control | What it does |
| --- | --- |
| `Ctrl+'` in main | Splits main's pane into equal halves and opens Sidebar in the new half, focused. The split is side by side when both halves keep at least 80 columns, and one above the other when main is narrower. If Sidebar is hidden, it comes back the same way, sized to main's pane at that moment; if it is showing, it is hidden. |
| `Ctrl+'` in Sidebar | Hides Sidebar in a `sidebar-parked` tab. Its process keeps running, so the thread is still there next time. |
| `/sidebar` | Same as the key, in either pane. |
| `/sidebar new` | Closes Sidebar and opens it again on a fresh thread. Inside Sidebar, `/new` does the same. |
| `/sidebar model` | Explains why Sidebar always uses main's model. |

Sidebar is an ordinary Pi session with its own history. `/tree`, branching and `/resume` all work there, and the session is saved under `~/.pi/agent/sidebar-sessions/<main session id>/`. Reopening Sidebar for the same main session continues the latest thread. Only Sidebar's own conversation is saved; main's conversation is added to each request and never copied into Sidebar's history.

A status line above Sidebar's editor shows what main is doing and how much of the last answer came from the cache. Example: `◧ Sidebar · read-only · main: bash 21s · last answer 95% cached · 1k new`.

Settings, set in the environment main starts with:

- `PI_SIDEBAR_KEYS`: a comma-separated list of keys that replaces `ctrl+'`, for example `ctrl+.`. `Ctrl+'` only reaches Pi through terminals that report it (kitty keyboard protocol).
- `PI_SIDEBAR_RATIO`: Sidebar's share of main's pane, from 0.15 to 0.85 (default 0.5, equal halves).
- `PI_SIDEBAR_MIN_COLUMNS`: the narrowest a half may be for a side-by-side split (default 80). Narrower panes split one above the other.

## How it stays current and cheap

Before each request it sends to its provider, main keeps that request in memory. Once a Sidebar is attached, main also writes it to `$TMPDIR/pi-sidebar/<session id>/`, together with the session entry it was built from and a live status. The live status records the running tool and how long it has run, results of parallel calls that have finished but are not yet committed, and the tail of the reply main is streaming.

Each Sidebar request is built in four layers:

1. **Main's last request, unchanged.** The model, system prompt, tool declarations, thinking and effort settings, cache keys, every message and every cache breakpoint all come from main's request.
2. **What main committed since.** Sidebar reads these entries from main's session file. A tool call that is still running is described rather than replayed.
3. **Sidebar's own instructions and the live status.** The status goes just before the user's newest question.
4. **Sidebar's conversation.**

Only the last three layers are new to the provider. Example from a live run against a ~22k-token main context (Claude Opus):

| Answer | Read from cache | Uncached input | Cache write |
| --- | --- | --- | --- |
| "What is main doing right now?" while main ran a 60-second command | 95% | ~1k | 0 |
| "Did it finish?" after main finished | 97% | 648 | 0 |

Read-only does not change the tool list, since removing tools would change the request and lose the cache. Calls are blocked instead. `read`, `grep`, `find`, `ls`, the web search and fetch tools, `codemode` (its nested calls are checked one by one) and shell commands that only read are allowed. The shell policy is the one plan mode uses. Everything else is blocked, with a reason the model can relay.

## When it refuses to send

Sidebar never quietly re-reads main's context uncached:

- **Before a prompt.** Sidebar checks that main has sent a request it can build on, on an API it supports. If main's cache has probably expired (main's last request is older than the TTL it asked for: 5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`), Sidebar asks first and shows how many tokens a send would re-read. Declining puts the prompt back in the editor.
- **While building the request.** If main's request is missing, the API or model differs, or Anthropic's limit of four cache breakpoints would be exceeded, Sidebar aborts the request with a reason and sends nothing.
- **After an answer.** If an answer read less than half of main's context from the cache, Sidebar warns and asks before the next question.

Sidebar always uses main's model and thinking settings. A cache belongs to one model and one set of settings, so a cheaper model would re-read everything on every question. It never keeps its own cache warm.

Supported APIs: Anthropic Messages, OpenAI Responses (including Codex and Azure) and OpenAI Chat Completions. Live-tested on Anthropic.

## Requirements and limits

- Pi must run inside Herdr. Tested with Herdr 0.9.5, which has `pane move` and labels.
- While Sidebar is hidden, a `sidebar-parked` tab holds it, and that tab appears in Herdr's tab bar.
- When main quits or switches to another session, Sidebar's pane is closed and the shared files are removed. A `/reload` keeps both.
- The shared files contain main's full last request, including the conversation. They are created with owner-only permissions and removed when main's session ends.
- On models that drop earlier thinking when a new user message arrives (Claude models before Opus 4.5 and Sonnet 4.6), a question asked during main's tool calls can miss the cache. The miss check catches this.
- Other suite components also run in Sidebar's Pi. pi-tool-gate may still ask before reads outside the project, and pi-cache-guard may ask about Sidebar's own cache.

## Prior art

- Claude Code's `/btw` and Codex's `/side` showed that a side question should share the main conversation's cache.
- [pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw) (MIT, Oscar Gabriel) replays a parent's exact prompt and messages in a Herdr pane, as a static snapshot.
- [herdr-sidekick](https://github.com/qapquiz/herdr-sidekick) parks a toggled agent pane in a background tab.

No code was copied from these projects.

## Development

```sh
cd packages/pi-sidebar
npm ci
npm run check
```
