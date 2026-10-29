---
title: pi-subagents
description: Delegate bounded tasks to separate Pi processes, inspect their conversations, and control parallel or chained runs.
plugin: pi-subagents
---

## Quick reference

- **Use it for:** Delegate independent report-back work to headless Pi processes, with fresh or forked context.
- **Enable:** Select `packages/pi-subagents/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `subagent` run/status/result/steer/stop/resume; `/subagents`. No global shortcut; fleet and conversation controls below.
- **Settings:** `pi-subagents.json`: 8 tasks, concurrency 4, depth 2; async off, fresh context, short child cache retention; FleetView on.
- **Requirements, cost & privacy:** Runnable Pi and provider access; Git only for worktrees, created directly without a helper CLI. Each child uses model tokens; optional paid Jev sees task text. Transcripts/results and native Pi child sessions are stored locally. Optional `sessionFile` in run details names the actual native session, separate from the compact viewer transcript; it does not imply full tracking by external clients. See [remote client compatibility](/guides/clients/).
- **Integrations & limits:** Optional `/tasks`, consumed result waits, notebooks, planners and Herdr-child pills. Shared cwd is not isolation; headless workers cannot approve dialogs.

pi-subagents gives the agent a `subagent` tool for work that should return a result to the main conversation. Each child is a separate `pi --mode rpc` process with its own context window. Parallel execution does not imply separate files: children share the selected working directory unless you explicitly request checkout isolation.

## Enable, requirements, and costs

Select `packages/pi-subagents/src/index.ts` using the [suite installation guide](/guides/install/). The suite enables every entry by default and uses one Git pin for every selected component.

Children need a working Pi runtime and access to their selected model providers. The component documents Pi 0.99 or newer for classifier support; consult the installation guide for the suite's tested host version. Optional `worktree: true` requires Git and a suitable repository; it calls Git directly, not an external worktree helper.

**Costs:** each child consumes model tokens independently. Usage and model cost are included in tool results and session totals. When agent, model, or effort choices remain open, optional Jev selection can make a paid classifier request per task through Pi's model registry. Missing classifier access falls back to defaults; it does not make child model execution free. Disable selection with `jev.enabled: false` if you do not want those classifier calls.

## Run, chain, and control tasks

`action: "run"` is the default. Choose one task shape:

- `task`: one self-contained assignment, with optional `label`, `agent`, `model`, and `thinking`.
- `tasks`: parallel task objects, each accepting `task`, `label`, `agent`, `cwd`, `model`, and `thinking`. Defaults allow eight tasks with four executing concurrently; while the parent's provider is under `critical` quota pressure ([pi-auto-effort](/plugins/pi-auto-effort/)), they run one at a time and the result says so.
- `chain`: sequential task objects. `{previous}` inserts the preceding output; the chain stops on its first failed step.

Example arguments for independent read-only reconnaissance:

```json
{
  "action": "run",
  "tasks": [
    {
      "agent": "general",
      "task": "Read the authentication code and report its entry points. Do not edit files."
    },
    {
      "agent": "general",
      "task": "Read the authentication tests and report coverage gaps. Do not edit files."
    }
  ],
  "async": true,
  "context": "fresh"
}
```

`async` defaults to false. When true, the call returns IDs immediately and later delivers `subagent-result` messages that start a turn; the first line names the runs and how they ended, which is what herdr-web-ui's chat shows on the collapsed message. Results due during a main-agent turn wait until it settles. Use `context: "fork"` to seed children from the current conversation rather than fresh context.

Control an existing run with `action: "status"`, `"result"`, `"stop"`, `"steer"`, or `"resume"`. These take an `id` or unique prefix; status without an ID lists live and recorded runs. Status and result also read a run known only from its record, and result notes when a stopped or lost run's output may be partial; steer and stop need a live run. Steering additionally requires `message`:

```json
{
  "action": "steer",
  "id": "RUN_ID_FROM_RESULT",
  "message": "Prioritize missing authorization checks; keep this read-only."
}
```

`resume` continues a `stopped` or `lost` run, or one that failed on the account's rate limit, as a new run with the same agent, model, thinking level, working directory and mode, labelled `<label> (resumed)`. Its task is the original task, a section headed "You were interrupted before finishing. What you already did:" holding a compact transcript of the old run, and an instruction to check the working tree before redoing anything and to continue from where it left off. The new run starts from fresh context.

A run that ends on the account's rate limit (`rate_limit_error` or HTTP 429, after Pi's own retries) is recorded as `failed` with the error `account rate limit reached; resume it after the window resets`, and its result names `resume`. Nothing retries it automatically.

`cwd` changes the working directory. `worktree: true` runs `git worktree add` into `<repo>/.worktrees/subagent-<slug>-<id>` (branch `subagent/<slug>-<id>`) for isolated task checkouts. Request that deliberately; a separate context alone is not an editing boundary.

## Agent definitions and settings

Built-in roles work without agent files. Every role but `general` has a profile: a model and a fixed thinking level per provider, so Jev is not asked for a tier or effort. The reasoning behind these choices, with vendor sources, is in [Choosing subagent models](/guides/subagent-models/).

| Role | For | Anthropic | Codex | Tools |
|---|---|---|---|---|
| `general` | anything no other role fits | Jev's tier and effort | Jev's tier and effort | default |
| `explorer` | recon, search, tracing code | Sonnet 5.5, low | `gpt-6-luna`, high | read-only |
| `worker` | implementing a clear spec, running checks | Sonnet 5.5, medium | `gpt-6.1-sol`, medium | default |
| `reviewer` | independent review of changes | Opus 5.5, high | `gpt-6.1-sol`, high | read-only |
| `researcher` | web and documentation questions | Sonnet 5.5, medium | `gpt-6.1-terra`, medium | default |
| `writer` | docs, summaries, write-ups | Sonnet 5.5, medium | `gpt-6.1-terra`, medium | default |
| `planner` | design and hard analysis without edits | Opus 5.5, high | `gpt-6.1-sol`, high | read-only |

Read-only roles get `read`, `grep`, `find`, `ls`, and `bash`; their no-edit policies are instructions, not filesystem sandboxes. Astra and Fable are never chosen automatically; pass `model` to use them. A profile model missing from Pi's registry becomes the newest registered model of its family (`claude-sonnet-*`, `claude-opus-*`, `*-luna`, `*-terra`, `*-sol`); with none, or on a provider the profile does not name, the role falls back to Jev's tier and effort like `general`. Fixed thinking levels are clamped to what the model supports.

Agent definitions live in `~/.pi/agent/agents/*.md` and the nearest project's `.pi/agents/*.md`; project definitions win, and a definition replaces a built-in of the same name whole. Frontmatter takes `name`, `description`, optional `tools`, `models`, `model`, `thinking`, and `maxTurns` (also `max_turns`); the body extends the child's system prompt. `models` maps providers to `provider/id`, optionally suffixed with a thinking level:

```yaml
models:
  anthropic: anthropic/claude-sonnet-5-5:low
  openai-codex: openai-codex/gpt-6-luna:high
```

Each choice resolves separately: explicit call arguments, then the agent (its profile for the parent's provider, else its `model` and `thinking`), then Jev, then defaults. Implicit models never leave the parent's provider, so a Codex parent never gets an Anthropic child unless the call passes `model`. When the role itself is left open, one Jev request asks for role, tier, and effort, and a profiled role ignores the last two.

At a turn limit, the child is asked to finish without further tools. If it continues calling tools, it is stopped with potentially partial output. A role description calling an agent read-only is not an operating-system sandbox.

Global settings are `~/.pi/agent/pi-subagents.json`, overlaid by `.pi/pi-subagents.json` in the working directory. This example disables classifier selection and reduces concurrency:

```json
{
  "jev": { "enabled": false },
  "maxParallel": 8,
  "concurrency": 2,
  "widget": "off",
  "fleetView": true,
  "maxDepth": 2,
  "childCacheRetention": "short"
}
```

Optional `providerTiers` maps provider names to `fast`, `balanced`, and `strong` tier maps of `provider/model` identifiers. The legacy `tiers` map is still supported. Provider-specific entries win, and only models matching the parent's provider apply to implicit choices (including agent-file models). Explicit `model` call arguments may cross providers. A tier with nothing configured for the parent's provider uses a built-in preset, the newest matching model in Pi's registry: for `anthropic`, `claude-haiku-*` (fast), `claude-sonnet-*` (balanced) and `claude-opus-*` (strong); for `openai-codex`, `*-luna`, `*-terra` and `*-sol`, preferring the parent's own generation when it is registered. Newest is a numeric-aware id sort, with an undated alias ahead of its 8-digit dated snapshots. Presets only name registered models; configured tiers still win per tier, and a tier with neither (or any tier on another provider) inherits the parent's model. Without Jev, children take the balanced tier, so an Anthropic parent's children run on Sonnet rather than the parent's model. Because Haiku's price steps up past 100,000 prompt tokens, a `fast` pick on Haiku becomes `balanced` when the run forks the parent's context or the parent's context already exceeds 100,000 tokens; the tool row shows the reason (`not Haiku: forked context`). Explicit call arguments take priority over agent-file choices, then classifier choices, then defaults. `tierDescriptions` changes the descriptions used for classification; the built-in ones steer `strong` to costly, genuinely hard work only (fast: lookups, searches, reading and summarizing, mechanical edits, running checks; balanced: specified or ordinary implementation, debugging with clear symptoms, code reviews, multi-source research). Jev defaults are provider `typesafe`, model `jev-latest`, and a 3000 ms timeout.

Jev answers the tier (`fast`, `balanced`, `strong`) and the effort (`low`, `medium`, `high`, `xhigh`) as probabilities over the options. Both use one rule: the highest option whose probability, counting it and every stronger option, reaches the bar theta, else the lowest option. theta = `relaxed + (tight - relaxed) * p`, set by `jev.threshold` (default `{ "relaxed": 0.5, "tight": 0.85 }`; 0.5 picks the median of Jev's distribution, and a lower bar biases picks upward), where p (0 to 1) is the latest `quota:pressure` that [pi-auto-effort](/plugins/pi-auto-effort/) emitted for the parent's provider. Near a usage limit picks therefore drift toward cheaper tiers and lower efforts; rows mark such picks `(Jev, p=0.5)`, and run records keep p. Without pi-auto-effort, p is 0.

`delegation` sets the tool's first prompt guideline. `economical` (the default) follows Anthropic's measured result: delegate work that runs in parallel, exceeds one context, or is routine with a long tail, with a precise spec and no `model` so the role's cheaper model is picked, then review the result; keep everything else in the main session at lower effort, since cheaper subagents trade cost for a few points of pass rate. `conservative` prefers direct work and delegates only clear wins. Both add a one-line guide to choosing a role. The setting applies at extension load and session start, not per call.

`widget` accepts `off`, `background`, or `all`; `fleetView: false` disables the list below the prompt. `maxDepth: 2` allows children to delegate once more, but removes the tool from grandchildren. `childCacheRetention` sets each child's `PI_CACHE_RETENTION`: `short` (the default; 5 minutes on Anthropic), `long` (1 hour), or `inherit` to keep the parent's. Children run quick turns and are discarded when done, so the 1-hour tier's higher cache-write price rarely pays off for them even when the main session uses it.

## Prompt mentions and run references

In a prompt, `@subagent:<name>` names an agent role. Where the running Pi supports autocomplete providers, the TUI lists discovered agents after `@subagent:`. A mention adds a hidden message describing that agent (description, tools, model, thinking level) and asking the model to delegate the relevant part with the `subagent` tool. An unknown name is reported with the agents that exist. A mention never starts a run by itself.

`@run:<label-or-id>` references one of this session's earlier runs, live or known only from its recorded run entry after a reload or `/resume`. Autocomplete after `@run:` lists runs newest first, filtered by id, task label or agent role. Completion inserts the label as a slug (`@run:audit-cache-invalidation`, example) when no other run shares it, otherwise the id. A token resolves by id, unique id prefix, or case-insensitive label slug.

A referenced run is delivered as a hidden message, not shown in the conversation: its label, agent, id, status, model and thinking level; its task; its final output (from memory or `output.md`); and a compact transcript rebuilt from `messages.jsonl`, with thinking dropped and tool calls on one line. A still-running run says it has no result yet. The message marks the content as untrusted background and tells the model not to repeat the run unless asked. Unknown tokens list the runs that exist; a label shared by several runs lists their ids instead.

Sizes are capped per run at 4,000 characters of task, 12,000 of output and 8,000 of transcript (400 per transcript line; a longer transcript keeps its start and end), and at 48,000 characters for all references in one prompt, after which further runs are named as left out. These characters do enter the model context of that prompt. A reference never starts or repeats a run, and only subagent runs can be referenced, not other Pi sessions.

## Inspect results and conversations

`/subagents` lists live and recorded runs. `/subagents <id>` opens a run's session, `/subagents stop <id>` stops a run, and `/subagents stop all` stops running children.

`/subagents stats` summarizes this session's delegation; `/subagents stats all` covers every session under `~/.pi/agent/sessions` (`$PI_CODING_AGENT_DIR/sessions`), using the latest record of each run. It shows the run count, the share of runs by where the model came from (`explicit`, `profile`, `tier`, `default`, or `unknown` for records from before the source was kept), runs with median and total cost per role, runs and median cost per turn per model, failed and rate-limited runs, and total cost. The tool tells the main agent to pass a role and leave `model` and `thinking` empty unless you named one or the task needs something other than the role's; the source breakdown shows whether that holds. Each run record carries `source: { model, thinking }`.

With [pi-select-nav](/plugins/pi-select-nav/), Tab selects the fleet panel when no next-prompt is accepted, then cycles runs, hosted pills and main while preserving drafts. Once the panel is selected, Ctrl+J and Ctrl+K cycle the same rows, forward and back; from the prompt they stay the editor's. Esc returns to the editor. In the TUI fleet list, Enter opens a child, `x` twice stops it, and `b` moves a foreground run to the background.

A child opens as a session of its own, drawn the way Pi draws main: Pi's own message and tool components, Pi's working row, queued steers, your editor (pi-vim's when loaded), the same subagent list with that session marked `◉`, and your footer. With [pi-status-footer](/plugins/pi-status-footer/), the footer and the editor's context gauge describe the child. Pi runs one live session per process and children are separate processes, so, as in Claude Code and Codex, this is main's screen drawn for another thread. Type and press Enter to steer it; Tab and Shift+Tab, or Ctrl+J and Ctrl+K, switch to the next or previous session (past the ends is main); Esc goes back to main (with pi-vim and a draft, Esc first leaves Insert mode), as a dim line over the list reminds you; `↓` at the editor's end enters the list, where Enter switches; Ctrl+C clears the editor and, on an empty one, twice stops the child. Your scroll keys, the mouse wheel, `app.tools.expand` and `app.thinking.toggle` work as in main. An ended run has no editor; a line says how it ended. Optional `label` names a task in lists and headings; when omitted, a short label is derived from the task text. Headless workers cannot use planning, user-question, or interactive-child tools. Extension dialogs are cancelled and returned as blockers, never forwarded to your UI or automatically approved.

Returned replies are capped at 2000 lines or 50 KB. Full output is saved under `~/.pi/agent/subagents/<id>/output.md`, alongside `messages.jsonl`. Recorded transcripts remain inspectable after reload or resume.

## Reloads and session ends

`/reload` keeps running children. The old runtime parks every call whose result is still owed in a process-wide registry keyed by the session file, and the reloaded extension adopts them: they are listed, steerable and stoppable again, `bg_wait subagent:<id>` works on them, and each call's result is delivered once, as a message, by the new runtime, including a result that came due during the reload. A foreground call in flight at the reload returns at once; its runs continue in the background and their results arrive as messages. Queued parallel tasks and later chain steps do not start after a reload, and the result says how many never started. Parked runs that no runtime adopts within 30 seconds are stopped.

Any other session end (`/new`, `/resume`, `/fork`, quitting) stops running children, after recording each as `stopped` with the reason, such as `stopped: session replaced (/new)`. A record that still says running while no runtime owns the run, for example after a crash, reads as `lost`. Either can be continued with `resume`.

## Optional integrations and boundaries

With pi-bg, `/tasks` includes children and `bg_wait` accepts `subagent:<id>` for async work. Waiting returns the bounded worker output and consumes it, suppressing a duplicate completion message. Reading a completed run with `subagent result` also consumes it; running snapshots do not. pi-marimo, pi-plan-mode and pi-herdr can contribute notebook, planner/scout and interactive-child activities. `/tasks` lists all enabled sources; FleetView hosts their pills. Stop is owner-specific: a Herdr-child stop interrupts an awaited turn, never closes its pane; `/stop` remains shell-only. pi-herdr can display pending async work through `$bg`; no Herdr pane is needed for ordinary subagents. Before each child starts, pi-subagents asks the `pi-plugins.subagent-env.v1` event channel for extra environment; [pi-sidebar](/plugins/pi-sidebar/) uses it so the subagents Sidebar starts run under its read-only guard.

By default (`delegation: "economical"`), delegate parallel, larger-than-one-context, or routine long-tail work to a subagent with a precise spec and no `model`, then review the result; keep the rest in the main session. With `delegation: "conservative"`, prefer direct work for routine investigation, diagnosis, and verification, and delegate only genuinely independent tasks with a clear payoff or when requested. Either way, avoid redundant audits, and prefer these headless children for report-back tasks. Choose pi-herdr's interactive children when a person needs an ongoing session to take over. See [background work](/recipes/background-work/), [activity integration](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/).

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-subagents) cover RPC children, turn limits, result delivery, reload handoff, and the TUI views.
