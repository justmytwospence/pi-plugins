# pi-subagents

Delegates tasks to Pi subagents. Each subagent is a separate headless `pi --mode rpc` process with its own context window, started by the `subagent` tool: a single task, up to eight parallel tasks, or a chain whose steps receive the previous step's output, in the foreground or async, with fresh or forked context, optionally each in a new worktree. When choices are left open, the classifier (through Pi's classifier models) picks a role and independently judges the delegated task's model capability and reasoning effort in one request per task. Built-in roles such as `explorer`, `worker` and `reviewer` provide fallback baselines, not fixed assignments or ceilings; a task can warrant a cheaper or more capable model, including an available premium model. Explicit call arguments and user/project agent-file pins remain fixed.

In the TUI, FleetView under the prompt lists the running subagents, and any run opens as its own session, drawn the way Pi draws main's, with Tab switching between main and the subagents as in Claude Code.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-subagents/>.

**System 1 backend.** `/system1` configures an ordered chain of Jev and native OpenAI Decisions for the suite (Jev only by default); `/system1 jev` and `/system1 openai` select singleton chains. Newly including OpenAI requires billing confirmation. The selection is shared by sessions using the same agent directory. Jev works standalone; Decisions requires the `pi-system1` component and its isolated `/login system1-openai` API key (or `SYSTEM1_OPENAI_API_KEY`), not subscription OAuth or the ordinary OpenAI credential. Before selecting Decisions, claim eligible [ChatGPT Pro API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) in an API organization with no purchased balance, auto-recharge or paid continuation. Pi cannot verify entitlement or which funds pay for a request. Classifier requests may be billed. Operational failures can advance to the next configured backend with a notification; valid judgments and safety refusals do not trigger failover. Legacy `jev` settings remain: the local enable flag, thresholds and timeouts apply to either backend, while provider/model overrides apply only to Jev.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-subagents/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-subagents
```

Add `-ne` to disable your other discovered and configured extensions for that run (an explicit `-e` still loads). Its subscription-usage library is a local runtime dependency.

## Sidebar integration

With pi-sidebar enabled, explicitly enrolled subagents join the current session's family, including descendants; sharing a working directory does not enroll other sessions. The same read-only Sidebar thread, draft and model follow the family across `/tree`, `/reload` and an explicit fresh implementation handoff. Viewing a child changes the question's subject, not its main/implementer cache anchor; both are fixed when the question is submitted. Older running children and disconnected observers can have partial or unavailable coverage.

The child view composes with Sidebar rather than replacing it. Human steering and stop controls remain in the primary view; Sidebar itself cannot steer or stop a child. In Sidebar, `/agents` lists the family, `/transcript [agent-id]` views a transcript, and `/context [agent-id]` attaches it to the next question (also the fallback without codemode). See the pi-sidebar README for limits and family isolation.

## The `subagent` tool

`action: "run"` (the default) takes one of:

- `task` (with optional `label`, `agent`, `model`, `thinking`): a single task;
- `tasks: [{ label?, agent?, task, cwd?, model?, thinking? }]`: parallel tasks, at most `maxParallel` (8) per call, `concurrency` (4) at a time, regardless of quota pressure;
- `chain: [...]`: steps in order; `{previous}` in a step's task is replaced by the previous step's output, and the chain stops at the first step that does not succeed.

Options:

| option | |
|---|---|
| `async` | default false. Return the run ids at once and deliver the results later as one `subagent-result` message that starts a turn; its first line names the runs and how they ended (herdr-web-ui labels the message's card with it) |
| `context` | `fresh` (default) or `fork`: start each child from this conversation (`--fork` of the session file; needs a saved session) |
| `worktree` | run each task in a new checkout, `git worktree add <repo>/.worktrees/subagent-<slug>-<id>` on branch `subagent/<slug>-<id>` from the current HEAD. Set it only when the user requests a worktree or branch isolation; otherwise ask first. The child stays headless |
| `cwd` | working directory (default: the session's); each task item may set its own |

`action: "status" | "steer" | "stop" | "result" | "resume"` take an `id` (or a unique prefix). `steer` also takes `message`, delivered to the running child as a steering message. `status` without an id lists this session's runs, live and recorded. `status` and `result` also work on a run known only from its record (after a `/resume`, or one that ended with an earlier pi): `result` returns its saved output (`output.md`, else the last assistant text in `messages.jsonl`), with a note when it was stopped or lost that the output may be partial. `steer` and `stop` need a live run; on a recorded one they fail and point to `resume`.

`action: "resume"` continues a `stopped` or `lost` run, or one that failed on the account's rate limit, as a new run with the same agent, model, thinking level, working directory (the session's, for records saved before records kept it) and mode (async or foreground), labelled `<label> (resumed)`. Its task is the original task, then `You were interrupted before finishing. What you already did:` with a compact transcript of the old run (the same one `@run:` references use, rebuilt from its `messages.jsonl`), then `Check the working tree and current state before redoing anything; continue from where you left off.` The new run has a fresh context, not the old child's session.

**When to delegate.** The tool's default first prompt guideline (`"delegation": "economical"`) follows Anthropic's measured result for sub-agents: delegate work that runs in parallel, is larger than one context, or is routine with a long tail (a settled change across files, tests to a given spec, mechanical refactors, running checks and fixing what fails), with a precise, self-contained spec and no `model` or `thinking`, so those choices can be calibrated to the task; then review the result instead of redoing it. Keep other work in the main session; cheaper subagents can trade cost for pass rate. Avoid redundant audits, and use headless subagents for report-back work. With `"delegation": "conservative"` that guideline instead tells the model to prefer direct work for routine investigation, diagnosis and verification, and to delegate only genuinely independent tasks with a clear payoff or when requested. Both settings add a one-line guide to choosing a role ([Agents](#agents)). The setting is read when the extension loads and at each session start (the tool is registered again when it changes), not per call. An interactive Herdr child ([pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/)) is for an explicit request or a clearly persistent, human-led session or handoff.

**Labels.** `label` is a short task name, not an agent role (for example `"Audit cache invalidation"` with `agent: "reviewer"`). Lists and headings show the task label first and the role second. Labels are whitespace-normalized and stripped of terminal control characters, without a fixed length cap. A missing or blank label uses the task's first nonempty line (without a Markdown heading or list prefix), with no model call. Each chain step gets its label before `{previous}` is expanded. The full task is still sent to the child and saved in run records.

**Results.** A foreground call returns each child's final reply, cut to 2,000 lines or 50 KB, with the full text in `~/.pi/agent/subagents/<id>/output.md`; each finished message of the child's conversation is appended to `messages.jsonl` beside it. A foreground result also reports the children's combined token usage and cost. The tool row shows each run's task label, agent role, model and thinking level (each marked `(auto)` where it was chosen automatically, or `(auto, p=0.5)` for a model or effort picked under quota pressure, and the Haiku guard's reason when it applied), status, time, turns, cost and current activity. A run that ends on the account's rate limit (`rate_limit_error` or HTTP 429, after Pi's own retries) is `failed` with the error `account rate limit reached; resume it after the window resets`, and its result names the `resume` action; nothing retries it automatically. Run records are saved as `subagents:run` session entries.

**Delivery.** Ending the turn with an async call still running keeps the turn open (Herdr, tmux and Pi keep showing it working, with a `Waiting on …` message, a `herdr:waiting` hold and the `$wait` pane token); typing, a queued message or Esc ends the wait, and the result then arrives as a message. The wait has no timeout and applies in the TUI only. A result already due when the turn ends goes into the same run. With pi-bg loaded, pi-bg's single turn-end wait does this instead. Otherwise an unread async result that comes due while the agent is working waits for the turn to settle before it is sent; several go out as one message. Reading a completed run with `subagent result` or `bg_wait subagent:<id>` consumes that result and suppresses its pending announcement. Running snapshots do not consume future results. Partially read batches announce only unread members. A run that ends after its session is gone calls nothing in Pi.

**Reload.** `/reload` does not stop running subagents. The old runtime parks every call whose result is still owed (its running children, its runs that already ended, and results queued while the agent was busy) in a process-wide registry keyed by the session file (an unsaved session's id), and the reloaded extension adopts them at its session start: they are listed, steerable and stoppable again, `bg_wait subagent:<id>` works on them, and each call's result arrives once, as a `subagent-result` message, from the new runtime (a result that came due during the reload is sent once the session is up). A foreground call cannot outlive its runtime: if one is in flight at the reload, its tool call returns at once and its runs continue as background runs whose results arrive as messages. Queued tasks of a parallel call and later steps of a chain do not start after a reload; the result says how many never started. Parked runs that no runtime adopts within 30 seconds are stopped.

**Headless boundary.** Workers cannot use `enter_plan_mode`, `exit_plan_mode`, `ask_user_question`, or `herdr`, even through codemode. Their role instructions require reporting decisions and permission blockers to the parent. Any extension dialog (including a safety approval) is cancelled and marks the run failed with a blocker; it is never forwarded to your UI and never automatically approved.

**Stopping.** Stopping a run sends the child an abort, closes its input, and sends SIGTERM if it has not exited after 3 seconds. Ending the session other than by `/reload` (`/new`, `/resume`, `/fork`, quitting) stops every running child, and first records each as `stopped` with the reason (for example `stopped: session replaced (/new)`), so the record does not claim it is still running. A record that still says running while no runtime owns the run (its pi crashed, or a reload was never picked up) reads as `lost`. Both can be continued with `resume`. A foreground run also stops when its tool call is aborted, unless it was moved to the background. A foreground call aborted before or during the classifier's picks starts no child, and once it is aborted (or the session has ended) its queued tasks never start; the result says how many were skipped. An `async` call is not affected by the abort.

## `@subagent:<name>` mentions

In a prompt, `@subagent:<name>` names an agent role. In the TUI, Pi's autocomplete lists the discovered agents after `@subagent:` (when the running Pi supports autocomplete providers). A prompt that mentions one gets a hidden message telling the model which agent that is (its description, tools, model and thinking level) and to delegate the relevant part of the task to it with the `subagent` tool; an unknown name is reported along with the agents that exist. A mention never starts a run by itself.

## `@run:<label-or-id>` references

In a prompt, `@run:<label-or-id>` references one of this session's earlier subagent runs, live or known only from its `subagents:run` record (after a reload or `/resume`). In the TUI, Pi's autocomplete lists the runs after `@run:`, newest first, filtered by what is typed against the run's id, task label or agent role; completing one inserts the label as a slug (`@run:audit-cache-invalidation`) when no other run shares it, else the id (`@run:k3j2x1`). A token resolves by id, by unique id prefix, or by label slug (case-insensitive).

A prompt that references a run gets a hidden message (not shown in the conversation) with, for each referenced run: its label, agent role, id, status, model and thinking level; its task; its final output (from memory or `output.md`); and a compact transcript rebuilt from `messages.jsonl` (user and assistant text, tool calls as `tool: bash: npm test`, tool results on one line; thinking is dropped and the task is not repeated). A run still running has no result yet and says so. The message calls the content untrusted background and tells the model not to repeat the run unless asked. An unknown token is reported along with the runs that exist; a token several runs share (two runs with the same label) lists their ids instead.

Sizes are capped: 4,000 characters of task, 12,000 of output and 8,000 of transcript per run (400 per transcript line; a longer transcript keeps its start and its end, about a third and two thirds of the budget, with the middle left out), and 48,000 for all references in one prompt, after which further runs are left out and named as such. A reference never starts or repeats a run; only subagent runs can be referenced, not other Pi sessions.

## Watching subagents (TUI)

### FleetView

Claude Code's subagent panel, below the prompt: `main` and every running subagent with elapsed time, tokens and cost, then the pills of other sources it hosts (see below). A run that succeeds leaves the list at once, and a dim `/subagents to see subagents` (`/tasks to see subagents` when it hosts pi-bg) shows for 30 seconds after an async run succeeds. A failed or stopped run stays until your next typed message (a message another extension sends does not count), or until `x` dismisses it. A run whose session is open stays until you leave it. Selection and stop arming follow the row, not its position. When Pi passes mouse events to widgets (fullscreen mode), clicking a row does what Enter does on it: a run opens its session, a pill its dialog, a notebook row its view; in a subagent's session, clicking a row in its list switches to that session, and `main` goes back.

| key | action |
|---|---|
| `↓` (prompt empty, or cursor at the end of its last line), or `←` at an empty prompt | move into the list; `j` in pi-vim's idle Normal mode also works |
| `↑`/`↓`, `k`/`j` | select |
| Enter, `l` | open the selected run's session, or a pill's own view |
| `x` twice | stop the selected running run |
| `x` | dismiss the selected ended run |
| `b` | move a foreground run to the background: the tool call returns and the result arrives later as a message, as with `async` |
| Esc, `h`, or `↑`/`k` past the first row | back to the prompt |

`↓` does not leave the prompt while autocomplete is showing or a history entry is being browsed. With pi-select-nav, Tab selects this panel when no next-prompt is accepted, preserving any draft. Repeated Tab cycles runs and hosted pills, wrapping through the main row. Once the panel is selected (Tab or `↓`), Ctrl+J and Ctrl+K move to the next or previous row, wrapping the same way; from the prompt they stay the editor's newline and kill-line. Enter opens the selection (on main, returns to the editor) and Esc returns to the editor. The session shown (main here) is marked ◉ and bold, as in a subagent's view. Other editing keys return to the editor.

### Subagent sessions

When exactly one subagent is running across all calls, its conversation opens automatically while main awaits a foreground subagent call, is idle, or holds a pi-bg wait (`herdr:waiting`). Only active workers count: finished history and queued future tasks do not, so a queued chain or concurrency-one batch follows each running step. FleetView must be enabled, with main's editor focused, its draft empty, and no autocomplete or unfinished modal command; existing viewers and dialogs are never interrupted. Parallel startup is checked after the roster settles. A wait in one parallel tool branch does not hide another tool still working in main. Main's model requests always keep the screen, including the wait for their first token; a nested wait still cleaning up after its parent tool returned cannot override that.

An automatic view returns to main when the run ends (including failure or stopping), another worker becomes active, or main resumes work. Scrolling, typing and steering do not pin it. Unsent worker drafts stay with that worker, never main. Esc returns to main and prevents automatic reopening of that run until it ends. Explicitly opening a view or switching to another worker makes it manual: it stays open on completion.

Main's questions and approvals always take priority. A standalone manual viewer temporarily hides while a dialog owns the screen and keyboard, then restores the same view, draft and scroll position; a Sidebar-hosted view uses the family host's suspension. Fleet and the independent background-task pill navigate only from the positively identified main editor, never an answer, note, approval-message or diff-comment field.

A run opens as a session of its own (in the primary pane when Sidebar is open), drawn as Pi draws main: its conversation in Pi's own message and tool components (Markdown, thinking as your `hideThinkingBlock` setting says, tool cards with Pi's renderers, including edit diffs), Pi's working row while it works, steering messages it has not read yet as `Steering: …`, your editor (pi-vim's when loaded, with your `editorPaddingX`), the subagent list main shows under its prompt with this session marked `◉`, and your footer. With pi-status-footer, the footer and the context gauge on the editor's borders describe the child (its model, thinking level, context share and cost); otherwise a footer in Pi's own layout does. Tool results keep up to 16,000 characters, and their details up to 16,000 characters of JSON.

Pi runs one live session per process and every subagent is a separate process, so this is the same thing Claude Code's and Codex's subagent views are: main's screen drawn for another thread, which you switch to and from.

| key | action |
|---|---|
| typing, Enter | steer the running child (pi-vim: Enter, `:w`, `:wq` or `:x`) |
| Tab, Shift+Tab; Ctrl+J, Ctrl+K | next or previous session in the list's order (main, then the runs); past the ends is main. While autocomplete, EX, a pending Vim command or Visual mode owns the composer, these keys go to it. Ctrl+J and Ctrl+K replace the editor's newline and kill-line here (Shift+Enter still adds a line) |
| Esc | back to main. With pi-vim, Esc leaves Insert mode first if you have typed something, then goes back from Normal mode. A dim `esc back to main · tab/shift+tab switch · ↓ list` line over the list says so |
| `↓` at the editor's end | into the list: `↑`/`↓` or `k`/`j` select, Enter or `l` switches (main goes back), `x` twice stops, `x` dismisses an ended run, `b` moves a foreground run to the background, Esc, `h` or `↑` past the top return to the editor |
| Ctrl+C | clear the editor; on an empty editor, twice stops the child |
| your `tui.altScreen.*` scroll keys (half page, page, top, bottom), PageUp/PageDown, mouse wheel | scroll the conversation; pi-vim's Ctrl+U/Ctrl+D in idle Normal mode scroll half a page |
| your `app.tools.expand` (Ctrl+O) and `app.thinking.toggle` | expand tool output, show or hide thinking |

A run that has ended has no editor: a line says how it ended (`✗ failed: …`), `↑`/`↓`, `j`/`k`, Ctrl+U/Ctrl+D, Home/End scroll, `↓` at the end enters the list, and Esc or `q` goes back. A draft you leave in one session is still there when you come back to it. The view follows new output until you scroll up. Configured viewport bindings respect rebinding and disabling; Ctrl+U/Ctrl+D stay with the composer outside idle Normal mode. Paging a Sidebar-hosted worker scrolls that worker, not main's hidden transcript. Stop confirmation belongs to the selected row and its current worker: a changing roster never transfers an armed stop to another target.

### Widget

An optional widget above the editor, off by default (`"widget": "background"` for async runs, or `"all"`): one row per running subagent with a spinner, task label and role, model and thinking level (automatic picks marked `(auto)`), turns, tokens, cost and elapsed time, with its current tool or text beneath; queued tasks; a successful run for 8 seconds, and the latest failed or stopped run until your next message (several share one row). Double-clicking a row opens that run's session when Pi passes mouse events to widgets.

### `/subagents`

| command | |
|---|---|
| `/subagents` | pick one of this session's runs, live or recorded, and open its session; outside the TUI, a plain list |
| `/subagents <id>` | open one run directly (id or unique prefix) |
| `/subagents stop <id>` | stop a running run (with no id, the only running one) |
| `/subagents stop all` | stop every running run |
| `/subagents stats [all]` | delegation stats for this session, or with `all` (or `--all`) for every session under `~/.pi/agent/sessions` (`$PI_CODING_AGENT_DIR/sessions`), the latest record per run id |

`stats` shows the number of runs, the share of runs by where the model came from (`explicit`: the call's `model`; `profile`: the role's profile or agent file; `tier`: the automatic tier pick; `default`: the parent's model; `unknown`: records from before the source was kept), per role the runs with median and total cost, per model the runs and median cost per turn, the failed runs (and how many hit the rate limit) and the total cost. Each run's record carries `source: { model, thinking }` (thinking is `explicit`, `profile`, `jev` or `default`). The tool asks the main agent to pass a role and leave `model` and `thinking` empty unless the user pins them or the task requires a deliberate override; `stats` shows each model's provenance.

Runs from a resumed session, or that ended before an earlier `/reload`, open from their `messages.jsonl` (or their saved output). Runs still running at a `/reload` stay live.

## Agents

Built-in roles work without agent files. Roles determine task and tool scope; their per-provider model/effort entries are **fallback baselines**, used when the classifier has no usable task answer. They do not limit task-calibrated picks. OpenAI and legacy `openai-codex` share the policy but keep distinct provider IDs. See [Choosing subagent models](https://pi-plugins.vercel.app/guides/subagent-models/) for the complete baseline table and evidence.

| role | for | Anthropic fallback | OpenAI / Codex fallback | tools |
|---|---|---|---|---|
| `general` | anything no other role fits | balanced / medium | balanced / medium | read, edit, bash, codemode, bg |
| `explorer` | recon, search, tracing code | Sonnet 5.5 / low | Luna 6 / high | read-only |
| `worker` | implementing a clear spec, running checks | Sonnet 5.5 / medium | Terra 6.1 / medium | read, edit, bash, codemode, bg |
| `reviewer` | independent review of changes | Opus 5.5 / high | Sol 6.1 / high | read-only |
| `researcher` | web and documentation questions | Sonnet 5.5 / medium | Terra 6.1 / medium | default |
| `writer` | docs, summaries, write-ups | Sonnet 5.5 / medium | Terra 6.1 / medium | read, edit, bash, codemode, bg |
| `planner` | design and hard analysis without edits | Opus 5.5 / high | Sol 6.1 / high | read-only |

`worker`, `general` and `writer` get a fixed tool list (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`, `bg_*`); MCP tools stay reachable through codemode.

Read-only roles get the tools `read`, `grep`, `find`, `ls` and `bash`; their no-change instructions are not a sandbox: `bash` can still modify files. A stale built-in profile can use the newest registered model of the same routed family; the task judgment can independently choose `fast`, `balanced`, `strong` or, when registered, `premium` (Astra/Fable). Higher capability or effort is appropriate for real unresolved difficulty, not for a role name or long specification alone. A user/project file replacing a built-in role still replaces its definition whole; its model and effort remain fixed defaults, not adaptive hints.

Agent files in `~/.pi/agent/agents/*.md` and in the nearest `.pi/agents/` directory at or above the working directory add or override roles (project files win over user files, which win over built-ins). Example:

```markdown
---
name: scout
description: "Fast read-only recon: returns the relevant files, types, and functions"
tools: read, grep, find, ls, bash
models:
  anthropic: anthropic/claude-haiku-5:low
  openai-codex: openai-codex/gpt-6-luna:high
---
You are a scout. ...
```

`name` and `description` are required; `tools`, `models`, `model`, `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and `maxTurns` (also `max_turns`) are optional. `models` maps a provider to `provider/id`, optionally with `:thinking`; a parent on that provider uses it, a parent on another provider falls back to the tier rules. `model` is one model for every provider (used only when the parent is on its provider). A file overrides a built-in role of the same name whole, profile included. The body is appended to the child's system prompt. At `maxTurns` turns the child is told to stop calling tools and answer; if it calls tools again, it is stopped with its output so far, marked as possibly partial. Quote descriptions that contain a colon.

## How each choice is made

For model and thinking **independently**: explicit call argument > user/project agent-file pin > usable the classifier task judgment > built-in role fallback > balanced model / medium effort > parent model if no usable mapping exists. A fixed field suppresses classification only for that field; even a named built-in role can be promoted or demoted for the delegated task. The classifier sees `task`, with `parent_request` only as context, and does not escalate just because the specification is long, tests are required, or the parent project is important. If no tier candidate is registered, that dimension is not classified; one candidate is used without a tier question. An effort pick can still be made when model selection cannot be. Missing/unusable the classifier answers use the fallback baselines. When the parent model must be kept because no usable role or tier mapping exists, the run shows `(parent)` and a `parent fallback` reason in its results; an intentional premium selection equal to the parent is not marked as fallback.

- **Provider.** Implicit model choices always stay on the parent's provider: a profile, agent-file model or tier model from another provider is ignored, so a Codex parent never gets an Anthropic child unless you pass `model`.
- **Haiku guard.** Haiku's price steps up past 100,000 prompt tokens. When the classifier's tier for a run is `fast` on Haiku and the run forks the parent's context, or the parent's context is already past 100,000 tokens, the pick becomes `balanced`; the row says why (`not Haiku: forked context`).
- **The classifier's picks.** The classifier picks the agent when its confidence is at least 0.5. It answers an available model tier (`fast`, `balanced`, `strong`, `premium`; asked only when more than one usable candidate exists, configured or from the registered presets below) and a thinking level (`low`, `medium`, `high`, `xhigh`) as probabilities over the options, and both are read by one rule: the highest option whose probability of being needed, counting it and every stronger option, reaches the bar theta, else the lowest option. theta = `relaxed + (tight - relaxed) * p` (`jev.threshold`, default 0.5 and 0.85), where p is the selection snapshot's quota pressure (below). The relaxed default, 0.5, picks the median of the classifier's distribution over the options; a lower bar biases picks upward. Without the classifier, or when its request fails, role baselines then balanced/medium apply; unknown/local providers with no mapping retain the parent model with a visible notice. Neither zero-price routes nor prices supply a capability ranking.
- **Quota pressure.** At selection, the shared quota reader captures the execution target's account-scoped pressure; automatic tier selection uses shared windows and fixed-model effort uses matching target windows. Unavailable, disabled and unsupported quota use neutral pressure, not a healthy reading. Higher pressure raises the bar for automatic choices, without changing concurrency. See [Choosing effort](https://pi-plugins.vercel.app/guides/effort/).
- **Thinking.** Children receive their selected `--thinking` level; queued launches, resumes and steering retain the selected tuple.

## Configuration

`~/.pi/agent/pi-subagents.json` (or `$PI_CODING_AGENT_DIR/pi-subagents.json`), with `<cwd>/.pi/pi-subagents.json` merged on top; objects merge, other values replace, and invalid files or mistyped values are ignored. Example (model names are placeholders for your own):

```json
{
  "tiers": {
    "fast": "anthropic/claude-haiku-5",
    "balanced": "anthropic/claude-sonnet-5-5",
    "strong": "anthropic/claude-opus-5-5"
  },
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 3000, "threshold": { "relaxed": 0.5, "tight": 0.85 } },
  "delegation": "economical",
  "maxParallel": 8,
  "concurrency": 4,
  "widget": "off",
  "fleetView": true,
  "maxDepth": 2,
  "childCacheRetention": "short"
}
```

| key | default | |
|---|---|---|
| `tiers` | `{}` | legacy `fast`/`balanced`/`strong`/`premium` tier models; only entries on the parent's provider apply |
| `providerTiers` | `{}` | tier models per provider (below), including optional `premium`; take precedence over matching `tiers` |
| `tierDescriptions` | built in (below) | what the classifier reads for each tier |
| `jev` | as above | `enabled`, classifier `provider` and `model`, `timeoutMs`; `threshold`: the bar for a stronger tier or effort, `relaxed` without quota pressure, `tight` at full pressure (each 0 to 1) |
| `delegation` | `"economical"` | the tool's first prompt guideline: `"economical"` delegates parallel, larger-than-one-context and routine long-tail work; `"conservative"` delegates only clear wins (see [The `subagent` tool](#the-subagent-tool)) |
| `maxParallel` | 8 | most parallel tasks per call |
| `concurrency` | 4 | parallel tasks running at once |
| `widget` | `"off"` | `"off"`, `"background"` (async runs only) or `"all"` |
| `fleetView` | true | `false` turns the list below the editor off |
| `maxDepth` | 2 | levels of subagents below the main session: with 2, a subagent can start subagents of its own, but theirs get no `subagent` tool |
| `childCacheRetention` | `"short"` | prompt-cache TTL for children: `"short"` (5 minutes on Anthropic), `"long"` (1 hour) or `"inherit"` the parent's `PI_CACHE_RETENTION` |

`providerTiers` configures several subscriptions without editing settings when you switch the parent's provider:

```json
{
  "providerTiers": {
    "anthropic": {
      "fast": "anthropic/claude-haiku-5",
      "balanced": "anthropic/claude-sonnet-5-5",
      "strong": "anthropic/claude-opus-5-5"
    },
    "openai-codex": {
      "fast": "openai-codex/gpt-6-luna",
      "balanced": "openai-codex/gpt-6-terra",
      "strong": "openai-codex/gpt-6.1-sol"
    }
  }
}
```

Unconfigured tiers use the newest registered physical-chat model matching their provider route. The routing table, full fallback profiles, and limitations are in [Choosing subagent models](https://pi-plugins.vercel.app/guides/subagent-models/). Anthropic routes Haiku/Sonnet/Opus/Fable across `fast`/`balanced`/`strong`/`premium`; `openai` and `openai-codex` route Luna/Terra/Sol/Astra with their respective provider strings. Plain Google Gemini and subscription Antigravity Gemini/Claude retain distinct `google` ID prefixes; Muse Code automatically uses versioned Standard Spark/Wonder IDs, not the bare Spark alias or Contributor mode. An unregistered family contributes no tier, so `premium` is optional and some tiers intentionally share one model. MTPLX and LM Studio have no inferred model hierarchy. Newest uses numeric-aware IDs, with an undated alias before its 8-digit dated snapshots; Luna/Terra/Sol prefer the parent's generation when registered. Configured `providerTiers` overrides a matching legacy `tiers` entry, then registered presets. Unknown provider fallback is shown, not silently treated as a tier.

The built-in `tierDescriptions`, which the classifier reads to pick capability within the task:

- `fast`: Lookups, extraction, concise summaries, scripted or mechanical changes, and running prescribed checks; little unresolved judgment.
- `balanced`: Specified implementation, ordinary debugging with clear symptoms, documentation, focused review, and multi-source research with a clear question.
- `strong`: Substantial unresolved reasoning within this task: interacting changes, difficult review, nontrivial design, or debugging whose cause is not yet known.
- `premium`: Exceptional unresolved difficulty where the flagship model's extra capability is justified: subtle cross-system correctness, unusually hard debugging, or consequential architecture with unresolved trade-offs. Not merely a lengthy specification or routine implementation in a critical project.

Children run with `PI_SUBAGENT=1` and `PI_SUBAGENT_DEPTH` set, which is how `maxDepth` is enforced, and with `PI_CACHE_RETENTION` set from `childCacheRetention`. Children work in quick turns and are discarded when done, so the 1-hour tier's higher cache-write price (2x input instead of 1.25x on Anthropic) rarely pays off for them even when the main session uses it.

## Requirements and costs

- Each subagent is a full Pi session using your configured models and credentials; its tokens and cost are billed like any other session's. Children run with `--no-session` unless forked (forked sessions go to `~/.pi/agent/subagents/sessions`).
- Classifier picks are optional classifier requests through Pi's classifier model API (Pi 0.99 or newer). The default `typesafe` provider needs Pi to have credentials for it (for example `TYPESAFE_API_KEY`); these requests can be billed. Set `"jev": { "enabled": false }` to turn them off; the defaults then apply.
- `worktree: true` needs `git`.
- On disk: run output and transcripts under `~/.pi/agent/subagents/<id>/`, and a temporary file for an agent's system prompt.

## Optional integrations

Each works alone; with a sibling loaded they work together through Pi's event bus and the activity protocol in `src/activity.ts` (copied verbatim into pi-bg, pi-subagents, pi-marimo, pi-herdr and pi-plan-mode).

- **[pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/).** FleetView ends with pi-bg's pill (`2 tasks`, `· 1 failed`); `↓` moves through the subagents to it, and Enter opens pi-bg's `/tasks` view, which lists this session's runs mixed in with its shells, tagged `agent` (Enter opens a run's conversation, `x` twice stops it, `x` on an ended one dismisses it). pi-bg then draws no pill of its own; with `"fleetView": false` it does. Each async run is outside work that pi-bg's `bg_wait subagent:<id>` can wait on inside the turn; the async result names the ids, and a chain's intermediate steps say the chain goes on. The wait returns the bounded worker output and consumes it, so no duplicate result message follows. Each async call is also published to pi-bg as one `subagent-call:<n>` outside work with `settle: true` (its `result` is the result message), which pi-bg's turn-end wait takes and acknowledges with `bg:external-consumed`.
- **[pi-marimo](https://github.com/justmytwospence/pi-marimo).** FleetView ends with its pill (`1 notebook`) too; Enter on it opens the busiest notebook full screen.
- **[pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/).** With the optional `pi-plugins.agent-family.v1` service, each child is explicitly enrolled before spawning; its observer extension and member environment propagate to descendants, including children at the delegation depth limit. Family/agent UUIDs persist in run records and survive parked adoption across `/reload`. No directory scanning enrolls unrelated sessions in the same checkout. Ordinary workers are observed, not made read-only: the separate `pi-plugins.subagent-env.v1` contract still propagates Sidebar's guard only for its research launches (`{ version: 1, env: {} }`, uppercase names/string values; probes receive `supported: true`).

  Subagent sessions use Sidebar's primary-pane view host when available, so one Sidebar conversation, draft and model remain beside the viewed child. Switching children changes the subject, not the main/implementer anchor or family conversation; a submitted question retains its captured subject. Returning to main preserves Sidebar's requested-open state. Views use their allocated height without changing terminal dimensions; steering, stopping and per-run drafts stay in the primary view. Without the service, the existing fullscreen overlay and standalone delegation behavior remain available.

  Sidebar family history survives `/tree` and explicit implementation handoff; unrelated `/new`, resume/fork/clone sessions are separate families. Observation of pre-existing or disconnected children can be partial or unavailable. Sidebar's `/agents`, `/transcript [agent-id]` and `/context [agent-id]` inspect only enrolled members (omitted ID means the viewed agent); `/context` also works without codemode. Transcript pages are capped at 64 KiB, automatic reads at 32 KiB per question; clipped content is marked and image payloads/provider signatures are omitted. This integration adds no Sidebar control authority over workers.
- **Quota snapshots.** Selection reads quota directly when an automatic tier or effort needs it; no separate extension or pressure event is required.
- **[pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/).** Async (or backgrounded) calls hold `herdr:background` while they run, which pi-herdr shows in the pane's `$bg` token.
- **[pi-plan-mode](https://pi-plugins.vercel.app/plugins/pi-plan-mode/).** It asks which model and effort a role gets by emitting `subagents:role-model` with `{ role, parent, thinking? }` (`parent` is `provider/id`). Without a delegated task, pi-subagents answers synchronously in `reply: { model, thinking, source }`, with no classifier call: the role baseline, else balanced/medium, else the parent's model with fallback provenance. Plan mode uses it to pick the `explorer` model for planner scouts when no `scoutModelMap` entry applies; there is no reply before a session starts or for an unknown role.

## Limitations

- FleetView, subagent sessions and the widget exist only in the TUI; other modes get the tool and `/subagents` lists.
- The tool row updates only while its call is open; async runs are followed through FleetView, the widget or `/subagents`.
- Children are RPC processes; the views are rebuilt from their RPC event streams.
- Agent roles' no-change instructions are instructions, not a filesystem sandbox.

## Development

```sh
cd packages/pi-subagents
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and then `vitest run` (unit tests use a fake RPC child in place of Pi). Live evals make paid classifier requests; run them only with explicit authorization. From the repository root, `npm run -s eval -- routing --dry` plans the routing target's 24 delegated-task cases across Anthropic, OpenAI, Antigravity Gemini and Muse without classifier calls (default three repeats: 72 planned requests). The target compares resolved model tier and effort against fixture expectations, including over- and under-escalation; it does **not** execute the selected coding models, measure task completion, or establish actual savings. The first live Jev fixture run made 72 classifier requests (these results do not establish Decisions calibration): 68/72 joint tier-and-effort matches (94.4%), 72/72 effort matches, 24/24 hard-task matches, zero call failures and zero defined over-/under-escalations. Four specified-implementation cases were routed fast instead of balanced/strong. The recorded spend estimate was $0.0000 (no nonzero cost reported), not evidence that the calls were free. `pick` checks 19 role cases; `profiles` replays role baselines when classification is unavailable, estimates cost using observed median cost per turn, and cannot predict adaptive choices or answer quality. The runner uses the configured System 1 order and skips live targets when no configured backend has local authentication and capability; it reports calls and catalog-estimated spend (not an invoice or verified credit debit), and keeps records under git-ignored `evals/results/`. For the full suite, root `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).

The widget, FleetView and the session view are adapted from [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) by tintinweb (MIT), ported to this extension's RPC children, run records and the classifier picks.
