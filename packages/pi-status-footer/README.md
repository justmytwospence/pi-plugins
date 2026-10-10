# pi-status-footer

A [pi](https://pi.dev) extension that replaces only pi's footer using its public API.
It leaves the working indicator, task widgets and tool rendering alone, and keeps
whichever editor is installed (pi's, pi-vim's), redrawing only its two border lines
as the context gauge. It uses pi's current theme, without background color blocks or animation.
The MCP status uses a flat Nerd Font plug (U+F1E6), inheriting the status text color;
it needs Nerd Font symbol support in the terminal. Other status text is preserved.

## Install

```sh
pi install git:github.com/justmytwospence/pi-status-footer
```

or add a checkout's path to `packages` in `~/.pi/agent/settings.json`.

## Controls

If `pi-cc-extensions` is installed, disable its competing footer in
`~/.pi/agent/pi-cc-extensions.json`, or it can replace this one after startup or
reload. Edits take effect with `/reload`.

- `/status on`: custom footer, limits for the active provider only (default).
- `/status all`: also keep the other subscription account's limits visible
  (Claude acct on Codex, Codex acct on Claude, both on other providers).
- `/status native`: restore Pi's built-in footer immediately.
- `/status` or `/status details`: show detailed measurements and explain sources.

The selection persists in the session without entering model context. New sessions
start with the custom footer. Native mode still keeps the cached account
readings fresh.

## Layout

1. Project and git status, `[wt ]<branch> ✖N ● ↑N ↓N`: `wt` in a linked
   worktree, then red `✖N` unmerged paths, yellow `●` any staged, modified or
   untracked file, green `↑N` ahead and red `↓N` behind upstream. Model and
   labeled reasoning level on the right. Waiting/errors take priority.
2. `Context 32% used`. The gauge itself is the editor's border lines, above and
   below the prompt: the used share of the width in heavy rule (accent, then the
   warning and error colors), the rest in the editor's own border color, so pi-vim's
   mode colors still show. Scroll markers (`↑ 3 more`) stay centered on it. An
   editor without pi's border hooks keeps its borders, and the gauge stays in the
   footer. An extension that installs an editor without wrapping the previous one
   (pi-vim) must load before this one; pi-stash wraps, so its order is free.
3. Other extensions' status notices, only when present. Notices wrap rather than
   disappearing at the right edge. Existing task widgets are not duplicated.
4. Provider/account limits explicitly labeled as percent **used**, with reset
   countdowns when supported. Last, since they are usually the longest rows.

### Companion extensions

None are required. When installed, their statuses move into the row they describe
instead of the status row:

| Extension | Status | Shown as |
| --- | --- | --- |
| pi-auto-effort | `effort: high (auto ↑)` | `reasoning high (auto ↑)` on the model row (arrow and any `limited:` note kept) |
| pi-cache-guard | `cache 4:12`, `cache cold` | `cache 4:12` on the context row (cold in the warning color) |
| pi-cache-guard (Jev trimming, key `lean-context`) | `lean: −12k tok` | `lean −12k tok` on the context row |
| anthropic-billing-guard | `extra usage x3` | `3 requests billed to extra usage` on the Claude limits row |
| @saadjs/pi-stash | `prompt stashed` | `› Stashed · "first line…" +2 lines · ctrl+s to restore` as the top row, just under the editor |
| pi-marimo | `marimo: fit.py · running Data loading › Model fit (12s) · 1 error · also prep.py, plots.py` | its own row under the context row: the current notebook (bold) and its kernel, then the other notebooks it follows; when narrow, the others become a count and the section its deepest heading |
| pi-bg | `bg: tests 2:14 · vite ready · lint ✗` | its own row under that: running jobs with their time, services with their state, then what ended in the last minute; when narrow, what ended fine goes first |

Without them nothing changes. A status whose text no longer has the expected shape,
or a billing notice with no Claude limits row to attach to, stays in the status row
unchanged, so a notice is never lost. pi-plan-mode, pi-tool-gate and MCP statuses
always stay in the status row.

Estimated session cost, cache reuse, raw token counts, Git line counts, OAuth details, age and compaction
counts are available through `/status details`, not crowded into the footer.

Rows shorten and drop lower-priority segments to fit actual terminal cell width.
Model/context and the most-used quota win over secondary statistics. At extremely
small widths any remaining text is safely truncated. Colors come from the active
Pi theme, except that the accent (project, model, gauges) is lifted halfway toward the
theme's body text so it stands out from muted text (same hue; pi >= 1.1). Warnings
start at 70% used, errors at 90%. No fresh-looking gauge is drawn
for stale account data.

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
- **Tracked Git changes (details):** all uncommitted tracked changes against HEAD, not edits attributed to
  this agent. Untracked files affect the dirty mark but not line counts.
- **Claude acct:** reads the shared Claude Code OAuth usage cache at
  `${CLAUDE_STATUSLINE_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/claude-statusline}/oauth-usage.json`.
  The Claude Code account may differ from Pi's account. Model-scoped weekly limits
  use their API labels, not a hardcoded model list. Percentages are percentage
  points; 0.5 is 0.5%, not 50%.
- **Codex acct:** ChatGPT-plan limits from `GET https://chatgpt.com/backend-api/wham/usage`,
  the endpoint Codex CLI's `/status` uses. Authenticated with Pi's own `openai-codex`
  OAuth login (via `modelRegistry.getApiKeyForProvider`, so Pi handles refresh) and
  the account id in that token, so it always describes the account Pi bills.
  The URL is fixed; the token is never sent anywhere else. Named pools in
  `additional_rate_limits` (for example a reserve model) keep their API names.
  Polled at most every 5 minutes, and at most every minute after a turn or model
  switch; only while a Codex model is active (or `/status all`). `x-codex-*`
  response headers, exposed only on the SSE transport (Pi defaults to WebSocket),
  update the main windows in between. No model call is made. Failures keep the
  last reading, which then shows as stale.
- **stale:** cache/header snapshot is at least ten minutes old or its reset time
  has passed. Never assume the provider reset a quota to zero without fresh data.
- **extra:** shared Claude account extra usage enabled/disabled state. An old spent
  pool is not an active warning when extra usage is off.

Other providers get the common session rows, without invented quota information.

## Performance and lifecycle

Rendering performs no filesystem, subprocess or network operations. Git is fetched
asynchronously on startup, settlement and branch changes, with a three-second
minimum ordinary refresh interval. A 15-second clock refreshes idle state; shared
quota reads/refreshes run at most once per minute ordinarily. The Claude reading
comes from the cache Claude Code's status line keeps
(`~/.cache/claude-statusline/oauth-usage.json`): when it is more than five minutes
old the footer refreshes it itself, reading Claude Code's OAuth token from the
Keychain (or `~/.claude/.credentials.json`) and sending it only to Anthropic's
OAuth usage endpoint, under the status line's `.fetch.lock` directory so only one
process fetches. Both usage requests are in-process `fetch` calls with a
five-second timeout. Where there is no Claude Code login at all (a
[herdr-machine0](https://github.com/justmytwospence/herdr-machine0) spoke, which
only holds a long-lived setup-token), set `PI_STATUS_FOOTER_CLAUDE_USAGE_CMD` to a
command that prints the usage JSON, such as `spoke usage claude`; its output fills
the same cache.

Timers, Git subscriptions and direct child processes are cleaned up on shutdown,
reload and session replacement. Generation checks reject late asynchronous work.
Print, JSON and RPC modes do not start footer work. tmux window-tab state comes
from the [tmux-agents](https://github.com/justmytwospence/tmux-agents) plugin, not from this footer.

## Development

```sh
npm install
npm run check   # tsc against pi's real types, then vitest
```

Tests cover usage accounting, provider switches, unknown/stale data, the Codex usage
response and header merging (with `fetch` and credentials stubbed), Git porcelain,
ANSI/CJK display widths 1–240 in both built-in themes, status preservation, native
fallback, reload/resume, cleanup, and loading with pi's actual extension loader. They
make no model or network requests and touch no real credentials. The lifecycle
fixture uses a temporary home and a non-Anthropic model to avoid invoking the real
account refresher.

Set `STATUS_PREVIEW=1` for sample layouts at 40, 60, 80, 120 and 160 columns.
