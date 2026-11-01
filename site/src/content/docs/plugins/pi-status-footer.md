---
title: Status footer
description: Read session state and control models, workflow and approvals from a compact, provider-aware footer.
plugin: pi-status-footer
---

## Quick reference

- **Use it for:** See project, Git, model, context, notices and account usage without replacing the editor.
- **Enable:** Select `packages/pi-status-footer/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/status` details/on/all/native/working/mcp; existing configured model/workflow/approval keys; visible value clicks in fullscreen Pi, subject to focus and input routing. No new global footer shortcut.
- **Settings:** No JSON settings for modes; custom footer, active-provider limits, working stats and MCP chip on by default; selections persist in the session.
- **Requirements, cost & privacy:** TUI; Git/quota sources optional, Nerd Font for icons. No inference calls. Authenticated usage requests send account credentials, not conversation text.
- **Integrations & limits:** Optional companion actions, Linked workflow display and wait-message priority. Missing providers leave their controls absent. Load Vim before the footer. Regular terminals remain keyboard-operated; quota/cost estimates are not invoices and MCP is an approximation.

Status footer replaces Pi's footer, not its task widgets or tool rendering. It keeps Pi's working indicator and only appends run statistics to its message. It emphasizes the current project, model, context usage and account limits, leaving detailed accounting available on demand.

## Enable and requirements

Select `packages/pi-status-footer/src/index.ts` using [Install & select](/guides/install/). All 35 suite entries load by default, and one Git pin versions the selected components together.

The footer runs in Pi's terminal UI; print, JSON and RPC sessions do not start its background work. Git supplies repository measurements. Each footer row leads with a Nerd Font icon (folder, git branch, robot with a brain before the reasoning level, sitemap for workflow, shield for approvals, tachometer, book, cogs, microchip, archive, hourglass; on the context row a plug for MCP and a magic wand for skills; in the notices row a shield for the tool gate, or a bell); without Nerd Font symbol support they draw as placeholders, and the status text stays readable. Use the suite's tested Pi version from the installation guide rather than assuming an older component minimum covers its current UI hooks.

**No Jev or other model calls are made by this extension.** It does perform local Git work, read usage caches and, when credentials are available, make authenticated account-usage requests. Those requests are distinct from paid inference. It does not need a subscription to show ordinary model and context information.

## Controls and layout

| Command | Effect |
| --- | --- |
| `/status` or `/status details` | Show measurements, sources and unavailable reasons, plus controls diagnostics. |
| `/status on` | Show the custom footer with active-provider limits only. |
| `/status all` | Also show other configured remote-provider readings within the footer's row budget. |
| `/status native` | Immediately restore Pi's built-in footer. |
| `/status working on` or `off` | Toggle the working-row statistics (default on). |
| `/status mcp on` or `off` | Toggle the built-in MCP chip (default on). |

The selections are stored in session metadata, excluded from model context, and survive reload/resume. New sessions start with the custom footer and both extras on. Native mode restores the display but still keeps cached account readings fresh; the working row is independent of the footer mode. Unload the extension if you do not want its background work.

The first row shows project and Git state. **Independent**, the default, puts model/reasoning and workflow on separate rows. **Linked** combines workflow, provider, physical model and reasoning into one row; approvals always remain separate. [Tool gate](/plugins/pi-tool-gate/#independent-and-linked-operating-modes) owns that choice and its state, not the footer. At 60 columns and up, a one-cell inset gives every row breathing room without imposing aligned columns. Labels use natural single-space spacing. Project and model anchor the display with accent color; section labels, ordinary readings and reset countdowns stay subdued. A dim leading icon identifies every row, and a git-branch icon marks the branch. Bold readings and Pi's native thinking-level colors distinguish the model's reasoning setting. Warm caches and ready services are green; warnings and errors keep their semantic colors. Distinct pieces of information share a dim `·` separator; auto reasoning and reset countdowns have no parentheses. Quota windows use concise `Claude` or `Codex` labels, and stale readings are muted and explicitly labeled. Recognized companion notices use sentence-case labels without colons: `Gate`, `Plan`, `Marimo`, `Background` (`Bg` when narrow) and `Pressure`. The gate's tally joins Approvals. Exec appears on the workflow row (the combined row in Linked) with its phase, counts and costs, without replacing or dimming Approvals. Standalone plan mode supplies workflow but not approvals. Plan's `/planners` hint and cache qualifiers also use dot separators. Background rows preserve service states and prioritize failed tasks over routine work. Unfamiliar publisher formats and third-party notices remain unchanged. Narrow terminals omit the decorative padding. Context follows. Where supported, the editor's top and bottom borders become the usage gauge while retaining its mode colors and scroll markers. An editor without compatible border hooks keeps its borders and gets a footer gauge instead. A [pi-subagents](/plugins/pi-subagents/) session draws this footer and editor gauge for the child: its directory, model, reasoning level, context and cost, with main's account limits and notices. Other-session chrome is read-only: it does not inherit main's Linked selection, control hints or clickable actions.

Workflow is a bold landmark: `WORK`, `CHAT`, `PLAN` or `EXEC`. Their theme roles are respectively `success`, `thinkingLow`, `customMessageLabel` and `warning`; actual hues depend on the theme. The badge also marks workflow transitions in the transcript, while explanations, key hints and other secondary details remain quiet. Approvals are a separate axis, not part of the badge.

While a dialog waits on you (an extension holds `herdr:blocked` on Pi's event bus, as the questionnaire, the tool gate and plan approval do), the footer shrinks to one row with no active controls or primary key hints: workflow badge when available, project, branch, model, reasoning and context percentage, plus any active phase. At narrow widths it prioritizes the badge and phase; other details can shorten or disappear. herdr-web-ui reads a Pi dialog off the screen only when no more than two lines follow its key hint, and an activity row (pi-bg's shells, subagents) may take the other. Everything else returns when the dialog closes. The event is the trigger; the footer does not require Herdr itself to be installed. A blocked Linked flow is a separate error state, not a healthy combined selection: use `/flow status`, a valid `/flow linked <provider>` or `/flow independent` for recovery.

Terminal labels and rows on this page are examples, not screenshots.

### Control rows and key hints

Each control row has one primary hint immediately after its content, as a dim ` · <key>` suffix without alignment padding: the first effective configured `app.model.select` key for the model/combined row, the provider's workflow key for Independent workflow, and its approval key for Approvals. An Independent Exec row uses `/plan-exec`, not a workflow-cycle key. The layout reserves space for the hint before fitting content, but drops hints at very narrow widths to retain critical state; core control rows never wrap. Context and other telemetry rows gain no invented global keys.

Simplified examples, omitting icons and other rows, with the [optional personal keymap](/guides/keyboard/#optional-personal-profile) (`alt+p` is not a suite default):

**Independent — two model/workflow rows:**

```text
gpt-6-sol · reasoning high · auto off · alt+p
WORK · shift+tab
```

**Linked — one combined row:**

```text
WORK · openai-codex · gpt-6-sol · reasoning auto → high · alt+p
```

Both modes retain a separate Approvals row, for example:

```text
Approvals · auto · alt+a
```

Linked uses one flow per available provider: Work/Chat use `general`, Plan uses `planner`, and approved Exec uses `worker`. Assignments are captured when selected; reselecting the same provider explicitly refreshes them. Reasoning stays independent: `reasoning auto → high` means auto effort is active; `reasoning high` is the manual form. When a toggle provider is available but off, `auto off` stays visible so it can be enabled again. A pinned or absent auto-effort provider supplies no toggle.

With the custom footer enabled, the configured model-selection action opens the native picker in Independent and the combined workflow/flow picker in Linked. Native `/model` and cycle attempts outside that picker remain centrally guarded; they do not silently unlink. Use `/flow independent` to regain free model selection. Exec is approved-plan execution, including when planner and worker are the same physical model—not an item the picker or cycle can start.

### Fullscreen clicks

With the actual main editor focused in fullscreen Pi, a plain single left click on a visible value invokes its owner action:

| Visible value | Action |
| --- | --- |
| Model or provider; model-row trailing hint | Native model picker in Independent; combined flow/workflow picker in Linked. |
| Reasoning level | Native reasoning cycle, in either operating mode. |
| `auto` or `auto off` | Toggle auto effort, when its provider offers the action. |
| Work/Chat/Plan badge | Cycle base workflow; in Linked, stay in the selected provider. |
| Exec badge or `/plan-exec` hint | Inspect execution status/recovery, never launch, stop or silently complete it. |
| Approval value (`auto`, `yolo`, etc.) or its trailing hint | Open the approvals picker; do not silently enable Yolo. |
| Context percentage | Open the context breakdown. |
| `S1 Jev`, `S1 Decisions` or `S1 unavailable` | Open the System 1 picker when its provider offers the action. |
| Skills | Open the skills preview. |
| Cache | Read-only cache status; no warming, compaction or spending. |
| MCP | Open Pi's native MCP manager when pi-cc-render supplies the bridge. |

Only the visible value and its applicable trailing hint are hit targets. Padding, separators, omitted/truncated labels and row whitespace are inert. Resize or stale session state invalidates old targets. Dialogs, native selectors, overlays, blocked holds and another opening action suspend footer clicks; model/picker mutations also require idle. Selection, dragging, wheel and double-click gestures retain their existing owners. **Regular terminal mode stays keyboard-operated.**

If a click does not work, inspect `/status details` for the current controls state, available layout widths and the last mouse event or refusal reason. Diagnostics retain only the latest event in memory, not draft text or credentials. Check focus, overlays and busy state, then verify in your actual fullscreen terminal: idle with Sidebar closed first, after `/reload`, and with Sidebar open. Isolated component tests alone cannot establish that the complete input path works in a particular terminal.

Actions are optional capabilities, not synthetic prompts or draft replacements. Without the owner, information can remain visible but its action is absent: use `/context`, `/cache-guard status`, `/mcp`, `/mode`, `/approvals` or native controls as applicable. Context and Skills clicks require pi-context plus pi-cc-render's narrow read-only context-metadata bridge, because accurate prompt options are exposed only on the SDK's command context. Without that bridge, `/context` remains available and those click actions are omitted rather than showing an empty breakdown. Neither this metadata bridge nor pi-cc-render's MCP bridge requires its startup splash to be visible. Notebook names keep their existing terminal hyperlinks; this is not a new general mouse layer.

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

A useful inspection sequence is `/status all`, followed by `/status details` to check every discovered source, window and unavailable reason, then `/status on` to return to the compact active-provider view. The compact footer keeps at most two account rows; additional sources are counted rather than expanding the client row budget.

## Settings-cycle preview

Workflow (including standalone Plan), reasoning, auto effort and approval cycles share a trailing **400 ms** pause. Repeated or mixed cycles update one combined, UI-only transcript line, with hidden append-only snapshots; preview text does not enter model context. For example, `Settings pending · Workflow plan · Effort high` shows targets, not effective settings. A pending restrictive mode is **not yet protection**. The footer labels targets `pending` or `applying` on their existing semantic rows, without adding rows or increasing the client budget. Only final changed settings apply; a round trip to all original values finishes `Settings unchanged` without invoking setters.

With the custom footer active, the native reasoning key and footer click share staging in Independent and Linked. Without an active footer, native reasoning retains stock behavior; native model cycling is unchanged. Explicit picker, command and tool choices remain immediate, and plan/tool approvals still require confirmation.

An ordinary prompt flushes the pending selection before it proceeds. If application fails, the message is not sent; recover interactive text from native prompt history. The footer does not replace a newer editor draft. Leaving main focus, opening a dialog or selector, external model or relevant setting changes, session/branch navigation, compaction and shutdown/reload cancel pending previews. Restored interrupted history is never reapplied; compaction does not guarantee retention of old lines. `/status details` includes sanitized preview diagnostics.

## Working row and MCP chip

While a run streams, Pi's working indicator reads `Working (↓ 1,234 tokens · 12s)` (example) instead of `Working`. Pi's spinner, color and base label stay; only the parenthesized statistics are added through `setWorkingMessage`. Tokens are the streamed text and thinking at four characters per token until the provider's stream reports `usage.output`, which then replaces the estimate. Elapsed time counts from the agent's start across the run's turns and appears once the run has lasted three seconds, or as soon as there are tokens to show. The message refreshes once a second only while a turn is in progress. Normally Pi's default message is restored when a turn or run ends, on shutdown or reload, and when the row is turned off. An active wait override keeps priority until its owner releases. The token count starts over with each turn.

With pi-bg enabled, `bg_wait` claims working-message priority through the optional `pi-plugins.working-message.v1` event. Its `Waiting on…` text (example) stays above token/time decoration, so the two timers do not alternate messages. The newest active claim wins, updates preserve its priority, and releases are owner-specific. On the final release, normal decoration resumes if a turn is still active. Both plugins work alone; no companion or new setting is required.

Pi's built-in MCP extension publishes no status; its connections are only visible in `/mcp`. The footer approximates them as `MCP 2/3` (example) on the context row, followed by the number of loaded skills: servers whose tools (from `builtin:mcp`, exposure not `hidden`) are registered, over those plus the servers enabled in `mcp.json` (the user file, and the project's `.pi/mcp.json` when the project is trusted). A shortfall uses the warning color. It is an approximation: a dropped connection keeps its tools, a server with no tools is invisible, and needs-auth, failed and connecting are not told apart, so `/mcp` remains the source of truth. The chip is absent when there is no built-in `/mcp` command, when another extension registers `/mcp`, and whenever an extension publishes an `mcp` status (such as pi-mcp-adapter), whose text then takes the chip's place, unchanged. Tools and `mcp.json` (by modification time) are reread every five seconds, on `mcp_servers_change` and after each turn; rendering itself still reads nothing.

Both features are ported from [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) by minuque (MIT); the component's `LICENSE` carries that notice.

## Understand the measurements

The optional [System 1](/plugins/pi-system1/) chip shows the selected backend or unavailable state on the existing Context row, not a new row. Its availability describes local configuration, not verified credits or entitlement; compact, blocked and other-session read-only views do not offer the control. The footer makes no classifier request to display it.

Context is Pi's estimate against the actual model window. An unknown value, including immediately after compaction, is not zero usage. Cache state/timer, MCP and skills belong on this row, not the model row. `Cache cold` and `Cache unknown` name those states explicitly; `model changed` is a lower-priority qualifier. Estimated timers retain their `~` marker (for example, `Cache ~4:12`) on the same Context row, never as a separate notice. The cache-guard provider still owns timer semantics. Cache reuse in details measures the last assistant prompt on the current branch/model; it does not predict the next cache hit. See [Cache and cost](/recipes/cache-cost/).

Estimated session cost uses recorded token-price usage, including tool, summary and warming records and abandoned branches. It is not an invoice or proof of subscription billing. Unreported external-agent work cannot be counted. Git line counts cover all uncommitted tracked changes against HEAD, not only this agent's edits; untracked files affect the changed-path summary but not those counts.

Quota data becomes stale after ten minutes or when its reset time passes. Failed refreshes preserve the last reading and do not invent a reset to zero. Missing percentages remain unknown; subscription allowances, API throttles, balances and session cost are different measurements.

## Account data and configuration

Claude account readings come from `https://api.anthropic.com/api/oauth/usage` using Pi's own Anthropic subscription login (through Pi's model registry, which handles refresh), so they describe the account Pi bills. They are cached for five minutes in `${CLAUDE_STATUSLINE_CACHE_DIR:-${XDG_CACHE_HOME:-~/.cache}/claude-statusline}/pi-oauth-usage.json`, coordinated through a `.pi-fetch.lock` directory, and the `anthropic-ratelimit-unified-*` headers on each Anthropic response update the 5h and week windows in between. When Pi has no Anthropic subscription login, readings come from Claude Code's shared `oauth-usage.json` in the same directory instead. That is the Claude Code account, which may differ from Pi's account; when refreshing it, the extension reads Claude Code's OAuth token from macOS Keychain or its credentials file, sends it only to the same endpoint, and coordinates through a `.fetch.lock` directory.

Codex readings use Pi's own `openai-codex` OAuth login and its token's account identifier for `https://chatgpt.com/backend-api/wham/usage`. Polling ordinarily runs at most every five minutes, with a one-minute minimum around turns and model switches, only while Codex is active or `/status all` is selected. Pi sessions on the same account share one reading in `${XDG_CACHE_HOME:-~/.cache}/pi-status-footer/codex-usage-<account>.json`, fetched by one session at a time. Between polls, the rate-limit event Codex streams before each response (WebSocket transport) or its response headers (SSE transport) update the reading. Both usage requests have five-second timeouts and send authentication/account information, not conversation text or file contents.

Modern `openai` ChatGPT-plan OAuth has no verified subscription-window endpoint here: its limits are unavailable, with [OpenAI usage settings](https://chatgpt.com/settings/usage) linked in details. Its token is not sent to the legacy Codex endpoint. Verified local Ollama or localhost inference shows `Local · no account quota` (example), not zero or unlimited; unknown remote providers and API-key accounts without subscription data show limits unavailable.

For Google Antigravity, local OAuth can supply read-only project and quota information from internal provider endpoints; a missing project, refusal, unsupported response or vault-held credential without a quota capability is explicitly unavailable. The footer does not onboard a project or switch accounts. Muse availability comes from `PI_MUSE_BINARY` or `muse` via `usage --json`, using the CLI's own login and environment; it makes no model call. A missing CLI or null subscription allowance is unavailable. Successful non-null CLI allowance formats are not yet validated and also report unavailable with a reason; displaying Muse windows is deferred, not inferred from the MSP schema. Google and Muse readings are held in memory rather than a new credential-bearing disk cache.

There is no plugin JSON settings file for the footer modes; use the commands above. Without a local Claude Code login, `PI_STATUS_FOOTER_CLAUDE_USAGE_CMD` can name an available command that prints usage JSON. That is an optional external integration, not a bundled command or an automatic remote connection.

## Optional integrations and limitations

No companion is required. Auto effort contributes reasoning status; cache guard contributes its clock and trimming estimate. Background work, machine pressure and notebook statuses receive dedicated rows. Stash can show a restoration hint, and anthropic-billing-guard can annotate the Claude limits row. Unrecognized status shapes remain unchanged rather than disappearing; workflow/model layout follows Independent or Linked, with approvals separate; an extension's `mcp` status joins the context row, and planner-run notices stay in the general status row. Without the gate/role-default provider and supported guard, the footer does not invent a Linked flow. The remote-client status allowance remains 13 rows for the whole below-editor region, including activity pills and separators; Linked's shorter core does not enlarge that budget.

Load an editor replacement that does not wrap its predecessor, such as pi-vim, before this footer. A wrapping editor integration such as pi-stash does not have that ordering restriction. Disable other footer owners or uncoordinated working-message writers before using `/reload`; pi-bg's wait messages are explicitly coordinated, not a conflict; otherwise it can replace this footer or working row after startup. `/reload` is sufficient to replace footer controls; a full Pi restart should not be necessary. pi-cc-extensions in particular is superseded by the suite and should not be enabled; [pi-cc-render](/plugins/pi-cc-render/) leaves the footer to this component.

Rendering itself performs no filesystem, subprocess or network work; asynchronous refreshes supply its data. This separation does not make the whole extension offline. For conflicts and missing readings, see [Troubleshooting](/guides/troubleshooting/) and the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-status-footer).
