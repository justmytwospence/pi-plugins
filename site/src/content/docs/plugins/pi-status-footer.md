---
title: Status footer
description: Read context, Git changes and provider usage without replacing your editor or hiding extension notices.
plugin: pi-status-footer
---

Status footer replaces Pi's footer, not its task widgets or tool rendering. It keeps Pi's working indicator and only appends run statistics to its message. It emphasizes the current project, model, context usage and account limits, leaving detailed accounting available on demand.

## Enable and requirements

Select `packages/pi-status-footer/src/index.ts` using [Install & select](/guides/install/). All 26 suite entries load by default, and one Git pin versions the selected components together.

The footer runs in Pi's terminal UI; print, JSON and RPC sessions do not start its background work. Git supplies repository measurements. Each footer row leads with a Nerd Font icon (folder, git branch, robot with a brain before the reasoning level, tachometer, book, cogs, archive, hourglass; in the notices row a plug for MCP, a shield for the tool gate, or a bell); without Nerd Font symbol support they draw as placeholders, and the status text stays readable. Use the suite's tested Pi version from the installation guide rather than assuming an older component minimum covers its current UI hooks.

**No Jev or other model calls are made by this extension.** It does perform local Git work, read usage caches and, when credentials are available, make authenticated account-usage requests. Those requests are distinct from paid inference. It does not need a subscription to show ordinary model and context information.

## Controls and layout

| Command | Effect |
| --- | --- |
| `/status` or `/status details` | Show measurements and explain their sources. |
| `/status on` | Show the custom footer with active-provider limits only. |
| `/status all` | Also show the other subscription account's limits. |
| `/status native` | Immediately restore Pi's built-in footer. |
| `/status working on` or `off` | Toggle the working-row statistics (default on). |
| `/status mcp on` or `off` | Toggle the built-in MCP chip (default on). |

The selections are stored in session metadata, excluded from model context, and survive reload/resume. New sessions start with the custom footer and both extras on. Native mode restores the display but still keeps cached account readings fresh; the working row is independent of the footer mode. Unload the extension if you do not want its background work.

The first row shows project and Git state. Model and reasoning level have their own left-aligned row immediately below. At 60 columns and up, a one-cell inset gives every row breathing room without imposing aligned columns. Labels use natural single-space spacing. Project and model anchor the display with accent color; section labels, ordinary readings and reset countdowns stay subdued. A dim leading icon identifies every row, and a git-branch icon marks the branch. Bold readings and Pi's native thinking-level colors distinguish the model's reasoning setting. Warm caches and ready services are green; warnings and errors keep their semantic colors. Distinct pieces of information share a dim `·` separator; auto reasoning and reset countdowns have no parentheses. Quota windows use concise `Claude` or `Codex` labels, and stale readings are muted and explicitly labeled. Recognized companion notices use sentence-case labels without colons: `Gate`, `Plan`, `Marimo`, and `Background` (`Bg` when narrow). The permission mode from pi-tool-gate (or pi-plan-mode alone) joins the model row with Claude Code's label and color (for example `auto mode on (shift+tab to cycle)`; the key hint goes first when narrow). Plan's `/planners` hint and cache qualifiers also use dot separators. Background rows preserve service states and prioritize failed tasks over routine work. Unfamiliar publisher formats and third-party notices remain unchanged. Narrow terminals omit the decorative padding. Context follows. Where supported, the editor's top and bottom borders become the usage gauge while retaining its mode colors and scroll markers. An editor without compatible border hooks keeps its borders and gets a footer gauge instead.

Git uses `branch * ↑N ↓N !` (example; suffix terms are optional), with single
spaces between the branch and each mark. `*` appears iff any staged, unstaged,
untracked or conflicted work exists. `↑N`/`↓N` show nonzero commit divergence;
`!` comes last iff conflicts or an unfinished Git operation exist, or status
is unreadable. Unknown status without a known branch shows only `!`;
a known branch identity remains visible. Clean/zero terms, worktree markers,
no-upstream and upstream-missing labels are hidden. No file, hunk or staging
counts appear in the compact UI.

Detailed `/status` retains unique changed-path and staged/unstaged/untracked/conflict
counts, known upstreams and errors. Staged-and-unstaged paths and renames each
count once. Untracked directories expand to individual files
(`--untracked-files=all`), excluding ignored files. Ahead/behind use the cached
upstream without fetching, with explicit `--ahead-behind`; a missing cached ref
does not imply zero divergence. Detached HEAD uses `detached:<sha7>`; unborn
repositories retain their branch name. Outside a Git repository, the project
remains without a Git segment. Polling retains `--no-optional-locks`.

Extension notices wrap onto their own row. Account limits appear last and explicitly show percent **used**. Narrow terminals shorten secondary segments rather than treating display width as a character count. Warning and error colors begin at 70% and 90% used.

A useful inspection sequence is `/status all`, followed by `/status details` to check where each account reading came from, then `/status on` to return to the compact active-provider view.

## Working row and MCP chip

While a run streams, Pi's working indicator reads `Working (↓ 1,234 tokens · 12s)` (example) instead of `Working`. Pi's spinner, color and base label stay; only the parenthesized statistics are added through `setWorkingMessage`. Tokens are the streamed text and thinking at four characters per token until the provider's stream reports `usage.output`, which then replaces the estimate. Elapsed time counts from the agent's start across the run's turns and appears once the run has lasted three seconds, or as soon as there are tokens to show. The message refreshes once a second only while a turn is in progress. Pi's default message is restored when a turn or run ends, on shutdown or reload, and when the row is turned off. The token count starts over with each turn.

Pi's built-in MCP extension publishes no status; its connections are only visible in `/mcp`. The footer approximates them as `MCP 2/3` (example) at the start of the status row: servers whose tools (from `builtin:mcp`, exposure not `hidden`) are registered, over those plus the servers enabled in `mcp.json` (the user file, and the project's `.pi/mcp.json` when the project is trusted). A shortfall uses the warning color. It is an approximation: a dropped connection keeps its tools, a server with no tools is invisible, and needs-auth, failed and connecting are not told apart, so `/mcp` remains the source of truth. The chip is absent when there is no built-in `/mcp` command, when another extension registers `/mcp`, and whenever an extension publishes an `mcp` status (such as pi-mcp-adapter), whose text is then shown unchanged. Tools and `mcp.json` (by modification time) are reread every five seconds, on `mcp_servers_change` and after each turn; rendering itself still reads nothing.

Both features are ported from [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) by minuque (MIT); the component's `LICENSE` carries that notice.

## Understand the measurements

Context is Pi's estimate against the actual model window. An unknown value, including immediately after compaction, is not zero usage. Cache reuse in details measures the last assistant prompt on the current branch/model; it does not predict the next cache hit. See [Cache and cost](/recipes/cache-cost/).

Estimated session cost uses recorded token-price usage, including tool, summary and warming records and abandoned branches. It is not an invoice or proof of subscription billing. Unreported external-agent work cannot be counted. Git line counts cover all uncommitted tracked changes against HEAD, not only this agent's edits; untracked files affect the changed-path summary but not those counts.

Quota data becomes stale after ten minutes or when its reset time passes. Failed refreshes preserve the last reading and do not invent a reset to zero. Other providers retain ordinary session rows without fabricated quota information.

## Account data and configuration

Claude account readings come from `https://api.anthropic.com/api/oauth/usage` using Pi's own Anthropic subscription login (through Pi's model registry, which handles refresh), so they describe the account Pi bills. They are cached for five minutes in `${CLAUDE_STATUSLINE_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/claude-statusline}/pi-oauth-usage.json`, coordinated through a `.pi-fetch.lock` directory, and the `anthropic-ratelimit-unified-*` headers on each Anthropic response update the 5h and week windows in between. When Pi has no Anthropic subscription login, readings come from Claude Code's shared `oauth-usage.json` in the same directory instead. That is the Claude Code account, which may differ from Pi's account; when refreshing it, the extension reads Claude Code's OAuth token from macOS Keychain or its credentials file, sends it only to the same endpoint, and coordinates through a `.fetch.lock` directory.

Codex readings use Pi's own `openai-codex` OAuth login and its token's account identifier for `https://chatgpt.com/backend-api/wham/usage`. Polling ordinarily runs at most every five minutes, with a one-minute minimum around turns and model switches, only while Codex is active or `/status all` is selected. Pi sessions on the same account share one reading in `${XDG_CACHE_HOME:-~/.cache}/pi-status-footer/codex-usage-<account>.json`, fetched by one session at a time. Between polls, the rate-limit event Codex streams before each response (WebSocket transport) or its response headers (SSE transport) update the reading. Both usage requests have five-second timeouts and send authentication/account information, not conversation text or file contents.

There is no plugin JSON settings file for the footer modes; use the commands above. Without a local Claude Code login, `PI_STATUS_FOOTER_CLAUDE_USAGE_CMD` can name an available command that prints usage JSON. That is an optional external integration, not a bundled command or an automatic remote connection.

## Optional integrations and limitations

No companion is required. Auto effort contributes reasoning status; cache guard contributes its clock and trimming estimate. Background work and notebook statuses receive dedicated rows. Stash can show a restoration hint, and anthropic-billing-guard can annotate the Claude limits row. Unrecognized status shapes remain unchanged rather than disappearing; the permission mode moves to the model row; tool-gate counts, planner-run and MCP notices stay in the general status row.

Load an editor replacement that does not wrap its predecessor, such as pi-vim, before this footer. A wrapping editor integration such as pi-stash does not have that ordering restriction. Disable any other extension that owns the footer or sets the working message before using `/reload`; otherwise it can replace this footer or working row after startup. pi-cc-extensions in particular is superseded by the suite and should not be enabled; [pi-cc-render](/plugins/pi-cc-render/) leaves the footer to this component.

Rendering itself performs no filesystem, subprocess or network work; asynchronous refreshes supply its data. This separation does not make the whole extension offline. For conflicts and missing readings, see [Troubleshooting](/guides/troubleshooting/) and the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-status-footer).
