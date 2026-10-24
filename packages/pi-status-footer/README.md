# pi-status-footer

A [pi](https://pi.dev) extension that replaces only pi's footer using its public API.
It leaves task widgets and tool rendering alone, and keeps whichever editor is
installed (pi's, pi-vim's), redrawing only its two border lines as the context
gauge. It uses pi's current theme, without background color blocks or animation.
While the agent runs, it adds streamed-output and elapsed-time statistics to
pi's own working indicator message, keeping pi's spinner. Other plugins' working
rows (pi-sidebar's) get the same statistics over `pi.events` (channel
`pi-plugins.working-stats.v1`, `src/working.ts`) while they are on. Views of another
session (pi-subagents' subagent sessions) get this footer and the editor gauge filled
with that session's directory, model, thinking level, context and cost, keeping main's
accounts and statuses (channel `pi-plugins.session-chrome.v1`, `src/session-chrome.ts`).
Every footer row
leads with a dim Nerd Font icon: folder (project), git branch, robot
(model) with a brain before the reasoning level, tachometer (context), book (marimo), cogs (background), microchip (pressure), archive
(stash), and hourglass (limits). On the context row a plug marks MCP and a magic
wand skills. In the notices row, the tool gate's shield marks its own notices; the first notice's icon leads the row, a
bell otherwise. Without a Nerd Font they draw as placeholders;
all labels and readings remain readable. Other status text is preserved.
While a dialog holds `herdr:blocked`, the footer shrinks to one row (project, branch,
model, reasoning and context) so herdr-web-ui can read the dialog, with room
for an activity row such as pi-bg's shells.

## Install

Install the suite and select `packages/pi-status-footer/src/index.ts` with `pi config`:

```sh
pi install git:github.com/justmytwospence/pi-plugins
pi config
```

One Git revision versions every selected component. Never enable a second standalone copy of the footer. From a local suite checkout, `pi -e ./packages/pi-status-footer` loads this component's own manifest without requiring its siblings. See the [public reference](https://pi-plugins.vercel.app/plugins/pi-status-footer/) for exact subset settings and compatibility.

## Controls

Do not enable `pi-cc-extensions` alongside this footer: its footer and working
message replace this one after startup or reload. Its working-row stats and MCP
chip are part of this component now.

- `/status on`: custom footer, limits for the active provider only (default).
- `/status all`: also keep the other subscription account's limits visible
  (Claude acct on Codex, Codex acct on Claude, both on other providers).
- `/status native`: restore Pi's built-in footer immediately.
- `/status` or `/status details`: show detailed measurements and explain sources.
- `/status working on|off`: the working-row statistics (default on).
- `/status mcp on|off`: the built-in MCP chip (default on).

The selections persist in the session without entering model context. New sessions
start with the custom footer and both extras on. Native mode still keeps the cached account
readings fresh; the working row is independent of the footer mode.

## Layout

1. Project and Git summary, `branch * ↑N ↓N !` (example; optional suffix terms):
   single spaces separate the branch and every mark. Yellow `*` appears iff any
   staged, unstaged, untracked or conflicted work exists; green `↑N` and red `↓N` for nonzero commit divergence;
   red `!` last iff conflicts or an unfinished Git operation exist, or Git status is unreadable. Unknown status
   without a known branch shows only `!`; a known branch identity remains visible.
   Clean/zero terms, worktree markers and absent/missing-upstream labels are hidden.
   No path, hunk or staging counts appear in the compact UI. Detailed `/status`
   retains counts, known upstreams and errors. Unborn repositories keep their
   branch name; detached HEAD shows `detached:<sha7>`. Outside a Git repository,
   the Git summary stays quiet and the project remains visible. Model and labeled
   reasoning level get their own left-aligned row immediately below. Waiting/errors
   appear on that model row and take priority.
2. `Context 32% used`. The gauge itself is the editor's border lines, above and
   below the prompt: the used share of the width in heavy rule (accent, then the
   warning and error colors), the rest in the editor's own border color, so pi-vim's
   mode colors still show. Scroll markers (`↑ 3 more`) stay centered on it. An
   editor without pi's border hooks keeps its borders, and the gauge stays in the
   footer. An extension that installs an editor without wrapping the previous one
   (pi-vim) must load before this one; pi-stash wraps, so its order is free.
   The rest of what fills the context follows on the same row: the MCP chip
   (below) and the number of loaded skills. Being lowest priority, they are the
   first to go when the row is narrow.
3. Other extensions' status notices, only when present. Notices wrap rather than
   disappearing at the right edge. Existing task widgets are not duplicated.
4. Provider/account limits explicitly labeled as percent **used**, with reset
   countdowns when supported. Last, since they are usually the longest rows.

### Companion extensions

None are required. When installed, their statuses move into the row they describe
instead of the status row:

| Extension | Status | Shown as |
| --- | --- | --- |
| pi-auto-effort | `effort: high (auto ↑)` | `reasoning high · auto ↑` on the model row (arrow and any `limited:` note kept) |
| pi-cache-guard | `cache 4:12`, `cache cold` | `Cache 4:12` or `Cache ❄` on the context row (warm in green, cold in the warning color) |
| pi-tool-gate (or pi-plan-mode alone) | `⏵⏵ auto mode on (shift+tab to cycle)` | the permission mode on the model row, in Claude Code's color for it, with one same-width pause or fast-forward Nerd Font icon in place of `⏸` / `⏵⏵` (the key hint is dropped first when narrow) |
| pi-cache-guard (Jev trimming, key `lean-context`) | `lean: −12k tok` | `Lean −12k tok` on the context row |
| anthropic-billing-guard | `extra usage x3` | `3 requests billed to extra usage` on the Claude limits row |
| @saadjs/pi-stash | `prompt stashed` | `Stashed · "first line…" +2 lines · ctrl+s to restore` as the top row, just under the editor |
| pi-marimo | `marimo: fit.py · running Data loading › Model fit (12s) · 1 error · also prep.py, plots.py` | `Marimo fit.py · …` on its own row under the context row: the current notebook (bold) and its kernel, then the other notebooks it follows; when narrow, the others become a count and the section its deepest heading |
| pi-marimo (key `marimo-lens`) | `lens: fit.py · S1 "make this blue" · S2` | `Lens fit.py · S1 make this blue · S2` on its own row under the marimo row (eye icon), only while marimo-lens selections are open; when narrow, notes go first |
| pi-bg | `bg: tests 2:14 · vite ready · lint ✗` | `Background tests 2:14 · vite ready · lint ✗` on its own row under that: running jobs with their time, services with their state, then what ended in the last minute; when narrow, what ended fine goes first |
| pi-pressure | `pressure: cpu 97 ↑ hot · mem warn · top vitest` | `Pressure cpu 97 ↑ · mem warn · top vitest` on its own row under that, values in the level's color, `↑`/`↓` while a signal is moving; when narrow, the process and eased signals go first |

Without them nothing changes. A status whose text no longer has the expected shape,
or a billing notice with no Claude limits row to attach to, stays in the status row
unchanged, so a notice is never lost. Planner-run, tool-gate count and MCP statuses
always stay in the status row. The recognized tool-gate status displays as
`Gate 2 auto · 0 pushed back · 1 asked` (example). Recognized planner-run
notices use `Plan A working · /planners` (example). Model-change and
unconfirmed cache states display as `Cache ❄ · model changed` and
`Cache ❄ · unconfirmed`. Background rows shorten their label to `Bg` when
needed, preserve service states, and prioritize failed tasks over routine work.

Estimated session cost, cache reuse, raw token counts, Git line counts, OAuth details, age and compaction
counts are available through `/status details`, not crowded into the footer.

### Working row

While a run streams, pi's working indicator reads `Working (↓ 1,234 tokens · 12s)`
(example) instead of `Working`: pi's spinner, color and base label are kept, and
only the parenthesized statistics are added through `setWorkingMessage`. Tokens
are the streamed text and thinking at four characters per token until the
provider's stream reports `usage.output`, which then replaces the estimate.
Elapsed time counts from the agent's start, across the run's turns, and shows
once the run has lasted three seconds or as soon as there are tokens to show;
before that pi's message is left alone. The message refreshes once a second
only while a turn is in progress, and pi's default is restored the moment a
turn or run ends, on shutdown or reload, and when the row is turned off. The
count starts over with each turn. `/status working off` disables it.

With pi-bg enabled, a `bg_wait` message takes priority over these statistics through the optional `pi-plugins.working-message.v1` event. Its `{ owner, message? }` payload claims priority when a message exists and releases that owner when omitted. The newest active claim wins; updating it preserves priority, and releasing an older wait cannot clear a newer one. The footer merges the override above its normal message, so timer refreshes do not alternate `Waiting on…` and `Working…` (example labels). After the final release, normal decoration resumes if a turn is active. Neither plugin requires the other; pi-bg also paints its native message directly when standalone. Contract copies in both packages' `src/working-message.ts` stay identical.

### MCP chip

Pi's built-in MCP extension publishes no status: its connections are only
visible in `/mcp`. The footer approximates them as `MCP 2/3` on the context
row: servers whose tools (from `builtin:mcp`, exposure not `hidden`) are
registered, over those plus the servers enabled in `mcp.json` (the user file,
and the project's `.pi/mcp.json` when the project is trusted). A shortfall
takes the warning color. It is an approximation: a dropped connection keeps
its tools, a server with no tools is invisible, and needs-auth, failed and
connecting are not told apart; `/mcp` remains the source of truth. The chip
is absent when no built-in `/mcp` command exists, when another extension
registers `/mcp`, and whenever any extension publishes an `mcp` status
(pi-mcp-adapter), whose text is shown unchanged in its place. Tools are reread
from memory and `mcp.json` by modification time every five seconds, on
`mcp_servers_change` and after each turn; rendering still reads nothing.
`/status mcp off` disables it.

At 60 columns and up, all rows have a one-cell inset. Narrower terminals omit
that padding. Labels use natural single-space spacing, not aligned columns.
Project and model anchor the display with accent color; section labels and
ordinary readings stay neutral. Each row's leading icon identifies it at a glance; wrapped notice lines indent under the first.
Reasoning levels use Pi's native thinking colors. Context and quota percentages
are bold; warm caches and ready services are green, while warnings and errors
retain their semantic colors. Distinct pieces of information use a dim `·`;
auto reasoning and reset countdowns have no parentheses. Quota windows are
text-only, labeled `Claude` or `Codex`, with quiet reset countdowns. The model row is separate from the project row;
no background blocks are added.

Rows shorten and drop lower-priority segments to fit actual terminal cell width.
Model/context and the most-used quota win over secondary statistics. At extremely
small widths any remaining text is safely truncated. Colors come from the active
Pi theme, except that the accent (project, model, gauges) is lifted halfway toward the
theme's body text so it stands out from muted text (same hue; pi >= 1.1). Warnings
start at 70% used, errors at 90%. Stale account readings are muted and explicitly
labeled.

## What the numbers mean

- **Context:** Pi's `getContextUsage()` estimate, including its actual model window.
  `unknown` is not zero; this can occur immediately after compaction.
- **Cache reuse (details):** the last measured assistant prompt on the current branch/model:
  `cacheRead / (input + cacheRead + cacheWrite)`. It does not promise that the next
  request will hit a cache. Switching models clears the reading until measured.
- **Estimated session cost (details):** reported token-price estimate, not a subscription charge or invoice.
  Whole-session totals include assistant, tool, compaction, branch-summary and
  standalone usage records (including warming). Like Pi's native footer, the
  totals include recorded abandoned branches. Unreported external-agent usage
  cannot be counted. OAuth describes authentication, not billing.
- **Git measurements:** the detailed `changed` count measures unique uncommitted paths, including staged,
  unstaged, untracked and conflicted paths. A staged-and-unstaged path counts once;
  a rename counts once. Untracked directories are expanded to individual files
  (`--untracked-files=all`); ignored files are excluded. Status explicitly requests
  `--ahead-behind` to compare against the cached upstream; no fetch is performed.
  Status uses `--no-optional-locks` so polling does not take the index lock.
- **Git details:** staged, unstaged, untracked and conflict counts remain available
  in `/status details`; these categories can overlap. Tracked line counts cover
  all uncommitted tracked changes against HEAD, not edits attributed to this
  agent. Untracked files affect the summary but not line counts.
- **Claude acct:** subscription limits from `GET https://api.anthropic.com/api/oauth/usage`,
  the endpoint Claude Code's `/status` uses. Authenticated with Pi's own `anthropic`
  subscription login (via `modelRegistry.getApiKeyForProvider`, so Pi handles refresh),
  so it describes the account Pi bills; cached in `pi-oauth-usage.json` (below).
  Each Anthropic response's `anthropic-ratelimit-unified-*` headers update the 5h and
  week windows in between, as in Claude Code. When Pi has no Anthropic subscription
  login (an API key), it falls back to the shared Claude Code OAuth usage cache at
  `${CLAUDE_STATUSLINE_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/claude-statusline}/oauth-usage.json`,
  whose Claude Code account may differ from Pi's account. Model-scoped weekly limits
  use their API labels, not a hardcoded model list. Percentages are percentage
  points; 0.5 is 0.5%, not 50%.
- **Codex acct:** ChatGPT-plan limits from `GET https://chatgpt.com/backend-api/wham/usage`,
  the endpoint Codex CLI's `/status` uses. Authenticated with Pi's own `openai-codex`
  OAuth login (via `modelRegistry.getApiKeyForProvider`, so Pi handles refresh) and
  the account id in that token, so it always describes the account Pi bills.
  The URL is fixed; the token is never sent anywhere else. Named pools in
  `additional_rate_limits` (for example a reserve model) keep their API names.
  Polled at most every 5 minutes, and at most every minute after a turn or model
  switch; only while a Codex model is active (or `/status all`). The reading is
  shared by every Pi session on the account through
  `${XDG_CACHE_HOME:-~/.cache}/pi-status-footer/codex-usage-<account>.json` (one
  fetches under a lock; a reading under a minute old is never refetched). Between
  polls, the `codex.rate_limits` event Codex streams before each response on Pi's
  default WebSocket transport (seen through `provider_stream_event`), or the
  `x-codex-*` headers on the SSE transport, update the main windows. No model call is made. Failures keep the
  last reading, which then shows as stale.
- **stale:** cache/header snapshot is at least ten minutes old or its reset time
  has passed. Never assume the provider reset a quota to zero without fresh data.
- **extra:** shared Claude account extra usage enabled/disabled state. An old spent
  pool is not an active warning when extra usage is off.

Other providers get the common session rows, without invented quota information.

## Performance and lifecycle

Rendering performs no filesystem, subprocess or network operations. Git is read
asynchronously on startup, settlement and branch changes, with a three-second
minimum ordinary refresh interval. A 15-second clock refreshes idle state; shared
quota reads/refreshes run at most once per minute ordinarily. The Claude reading
is cached for five minutes in the status line's cache directory: with Pi's
subscription login in `pi-oauth-usage.json` under a `.pi-fetch.lock` directory,
so however many Pi sessions are open, one fetches. Without one, it uses the cache
Claude Code's status line keeps (`oauth-usage.json`), refreshing it when stale
with Claude Code's OAuth token from the Keychain (or `~/.claude/.credentials.json`)
under the status line's own `.fetch.lock`. Either token is sent only to
Anthropic's OAuth usage endpoint. Both usage requests are in-process `fetch` calls with a
five-second timeout. Where there is no Claude Code login at all (a
[herdr-machine0](https://github.com/justmytwospence/herdr-machine0) spoke, which
only holds a long-lived setup-token), set `PI_STATUS_FOOTER_CLAUDE_USAGE_CMD` to a
command that prints the usage JSON, such as `spoke usage claude`; its output fills
the same cache.

Timers (including the working row's one-second refresh and the MCP poll), Git
subscriptions and direct child processes are cleaned up on shutdown, reload and
session replacement, and pi's working message is restored. Generation checks
reject late asynchronous work.
Print, JSON and RPC modes do not start footer work. tmux window-tab state comes
from the [tmux-agents](https://github.com/justmytwospence/tmux-agents) plugin, not from this footer.

## Development

```sh
npm ci
npm run check   # tsc against pi's real types, then vitest
```

Tests cover usage accounting, provider switches, unknown/stale data, the Codex usage
response and header merging (with `fetch` and credentials stubbed), Git porcelain,
ANSI/CJK display widths 1–240 in both built-in themes, status preservation, native
fallback, reload/resume, cleanup, the working row's token estimate, provider
usage switch, timer threshold and restoration, the MCP chip's counting, `mcp.json`
reading, yielding and persistence, and loading with pi's actual extension loader.

The working row and MCP chip are ported from
[pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) (MIT, see LICENSE). They
make no model or network requests and touch no real credentials. The lifecycle
fixture uses a temporary home and a non-Anthropic model to avoid invoking the real
account refresher.

Set `STATUS_PREVIEW=1` for sample layouts at 40, 60, 80, 120 and 160 columns.
