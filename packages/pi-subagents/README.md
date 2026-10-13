# pi-subagents

Delegates tasks to Pi subagents. Each subagent is a separate headless `pi --mode rpc` process with its own context window, started by the `subagent` tool: a single task, up to eight parallel tasks, or a chain whose steps receive the previous step's output, in the foreground or async, with fresh or forked context, optionally each in a new worktree. When a call leaves the agent role, model or thinking level open, Jev (through Pi's classifier models) picks them, one request per task.

In the TUI, FleetView under the prompt lists the running subagents, and a full-screen viewer streams any run's conversation, laid out after Claude Code's subagent panel.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-subagents/>.

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

Add `-ne` to disable your other discovered and configured extensions for that run (an explicit `-e` still loads). No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## The `subagent` tool

`action: "run"` (the default) takes one of:

- `task` (with optional `label`, `agent`, `model`, `thinking`): a single task;
- `tasks: [{ label?, agent?, task, cwd?, model?, thinking? }]`: parallel tasks, at most `maxParallel` (8) per call, `concurrency` (4) at a time;
- `chain: [...]`: steps in order; `{previous}` in a step's task is replaced by the previous step's output, and the chain stops at the first step that does not succeed.

Options:

| option | |
|---|---|
| `async` | default false. Return the run ids at once and deliver the results later as one `subagent-result` message that starts a turn |
| `context` | `fresh` (default) or `fork`: start each child from this conversation (`--fork` of the session file; needs a saved session) |
| `worktree` | run each task in a new checkout from `worktree new subagent/<slug>-<id> --no-open`. Set it only when the user requests a worktree or branch isolation; otherwise ask first. The child stays headless |
| `cwd` | working directory (default: the session's); each task item may set its own |

`action: "status" | "steer" | "stop" | "result"` take an `id` (or a unique prefix). `steer` also takes `message`, delivered to the running child as a steering message. `status` without an id lists this session's runs.

Prefer direct work for routine investigation, diagnosis, and verification. Delegate only genuinely independent tasks with a clear payoff or when requested, not merely because work is long or multistep, and avoid redundant audits. When delegating report-back work, use headless subagents. An interactive Herdr child ([pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/)) is for an explicit request or a clearly persistent, human-led session or handoff.

**Labels.** `label` is a short task name, not an agent role (for example `"Audit cache invalidation"` with `agent: "reviewer"`). Lists, headings and forwarded dialogs show the task label first and the role second. Labels are whitespace-normalized and stripped of terminal control characters, without a fixed length cap. A missing or blank label uses the task's first nonempty line (without a Markdown heading or list prefix), with no model call. Each chain step gets its label before `{previous}` is expanded. The full task is still sent to the child and saved in run records.

**Results.** A foreground call returns each child's final reply, cut to 2,000 lines or 50 KB, with the full text in `~/.pi/agent/subagents/<id>/output.md`; each finished message of the child's conversation is appended to `messages.jsonl` beside it. A foreground result also reports the children's combined token usage and cost. The tool row shows each run's task label, agent role, model and thinking level (each marked `(Jev)` where Jev chose it), status, time, turns, cost and current activity. Run records are saved as `subagents:run` session entries.

**Delivery.** An async result that comes due while the agent is working waits for the turn to settle before it is sent (a follow-up queued mid-turn would be dropped by Esc); several go out as one message. A run that ends after its session is gone (`/reload`, `/new`) calls nothing in Pi.

**Dialogs.** Dialogs a child's extensions open (`select`, `confirm`, `input`; for example a tool gate asking for approval) are forwarded to your UI, titled `[subagent <label> · <role>]`. Without a UI they are cancelled.

**Stopping.** Stopping a run sends the child an abort, closes its input, and sends SIGTERM if it has not exited after 3 seconds. Ending the session stops every running child. A foreground run also stops when its tool call is aborted, unless it was moved to the background. A foreground call aborted before or during Jev's picks starts no child, and once it is aborted (or the session has ended) its queued tasks never start; the result says how many were skipped. An `async` call is not affected by the abort.

## `@subagent:<name>` mentions

In a prompt, `@subagent:<name>` names an agent role. In the TUI, Pi's autocomplete lists the discovered agents after `@subagent:` (when the running Pi supports autocomplete providers). A prompt that mentions one gets a hidden message telling the model which agent that is (its description, tools, model and thinking level) and to delegate the relevant part of the task to it with the `subagent` tool; an unknown name is reported along with the agents that exist. A mention never starts a run by itself.

## `@run:<label-or-id>` references

In a prompt, `@run:<label-or-id>` references one of this session's earlier subagent runs, live or known only from its `subagents:run` record (after a reload or `/resume`). In the TUI, Pi's autocomplete lists the runs after `@run:`, newest first, filtered by what is typed against the run's id, task label or agent role; completing one inserts the label as a slug (`@run:audit-cache-invalidation`) when no other run shares it, else the id (`@run:k3j2x1`). A token resolves by id, by unique id prefix, or by label slug (case-insensitive).

A prompt that references a run gets a hidden message (not shown in the conversation) with, for each referenced run: its label, agent role, id, status, model and thinking level; its task; its final output (from memory or `output.md`); and a compact transcript rebuilt from `messages.jsonl` (user and assistant text, tool calls as `tool: bash: npm test`, tool results on one line; thinking is dropped and the task is not repeated). A run still running has no result yet and says so. The message calls the content untrusted background and tells the model not to repeat the run unless asked. An unknown token is reported along with the runs that exist; a token several runs share (two runs with the same label) lists their ids instead.

Sizes are capped: 4,000 characters of task, 12,000 of output and 8,000 of transcript per run (400 per transcript line; a longer transcript keeps its start and its end, about a third and two thirds of the budget, with the middle left out), and 48,000 for all references in one prompt, after which further runs are left out and named as such. A reference never starts or repeats a run; only subagent runs can be referenced, not other Pi sessions.

## Watching subagents (TUI)

### FleetView

Claude Code's subagent panel, below the prompt: `main` and every running subagent with elapsed time, tokens and cost, then the pills of other sources it hosts (see below). A run that succeeds leaves the list at once, and a dim `/subagents to see subagents` (`/tasks to see subagents` when it hosts pi-bg) shows for 30 seconds after an async run succeeds. A failed or stopped run stays until your next typed message (a message another extension sends does not count), or until `x` dismisses it. A run whose conversation is open stays until you close it. Selection and stop arming follow the row, not its position.

| key | action |
|---|---|
| `↓` (prompt empty, or cursor at the end of its last line), or `←` at an empty prompt | move into the list; `j` in pi-vim's idle Normal mode also works |
| `↑`/`↓`, `k`/`j` | select |
| Enter, `l` | open the selected run's conversation, or a pill's own view |
| `x` twice | stop the selected running run |
| `x` | dismiss the selected ended run |
| `b` | move a foreground run to the background: the tool call returns and the result arrives later as a message, as with `async` |
| Esc, `h`, or `↑`/`k` past the first row | back to the prompt |

`↓` does not leave the prompt while autocomplete is showing or a history entry is being browsed. With pi-select-nav, Tab selects this panel when no next-prompt is accepted, preserving any draft. Repeated Tab cycles runs and hosted pills, skipping the main row and wrapping at the end. Enter opens the selection and Esc returns to the editor. Other editing keys return to the editor.

### Conversation viewer

Full screen under an accent-colored banner (for example `◀ esc · Find config · scout · not your main session`): the child's conversation as it streams, with tool calls, results (each kept up to 16,000 characters), the last lines of a running tool's output, queued steering messages and current activity. It follows new output until you scroll up, and stays open when the run ends.

| key | action |
|---|---|
| `↑`/`↓`, `k`/`j` | scroll one line |
| PgUp/PgDn, Shift+↑/Shift+↓ | scroll one page |
| Ctrl+U/Ctrl+D | scroll half a page (this read-only viewer only) |
| Home, End | top, end |
| Enter | open a composer that steers the running child |
| `x` twice | stop the run |
| `b` | move a foreground run to the background |
| `m` | cycle Markdown rendering: assistant text (default), tool results too, or none; the choice holds for every viewer in this Pi process |
| Esc, `q`, `h`, Ctrl+C | close |

The steering composer is the suite's editor when a provider such as pi-vim is loaded: it opens in Insert mode; Enter, `:w`, `:wq` or `:x` sends; `:q` or Esc in idle Normal mode cancels; and Ctrl+U/Ctrl+D in idle Normal mode scroll the conversation by half a page. Otherwise it is Pi's one-line input (Enter sends, Esc cancels). While the composer is open it owns every key.

### Widget

An optional widget above the editor, off by default (`"widget": "background"` for async runs, or `"all"`): one row per running subagent with a spinner, task label and role, model and thinking level (Jev's picks marked `(Jev)`), turns, tokens, cost and elapsed time, with its current tool or text beneath; queued tasks; a successful run for 8 seconds, and the latest failed or stopped run until your next message (several share one row). Double-clicking a row opens that run's conversation when Pi passes mouse events to widgets.

### `/subagents`

| command | |
|---|---|
| `/subagents` | pick one of this session's runs, live or recorded, and open it in the viewer; outside the TUI, a plain list |
| `/subagents <id>` | open one run directly (id or unique prefix) |
| `/subagents stop <id>` | stop a running run (with no id, the only running one) |
| `/subagents stop all` | stop every running run |

Runs from before a `/reload` or from a resumed session open from their `messages.jsonl` (or their saved output).

## Agents

Built-in roles work without any agent files:

- `general`: Pi's default tools, for any self-contained task;
- `explorer`: codebase exploration without changes, returning findings with file and line references;
- `reviewer`: independent review without changes for bugs, regressions, security risks and missing tests.

`explorer` and `reviewer` get the tools `read`, `grep`, `find`, `ls` and `bash`, and no pinned model or thinking level. Their no-change instructions are not a sandbox: `bash` can still modify files.

Agent files in `~/.pi/agent/agents/*.md` and in the nearest `.pi/agents/` directory at or above the working directory add or override roles (project files win over user files, which win over built-ins). Example:

```markdown
---
name: scout
description: "Fast read-only recon: returns the relevant files, types, and functions"
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-5
thinking: low
---
You are a scout. ...
```

`name` and `description` are required; `tools`, `model`, `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and `maxTurns` (also `max_turns`) are optional. The body is appended to the child's system prompt. At `maxTurns` turns the child is told to stop calling tools and answer; if it calls tools again, it is stopped with its output so far, marked as possibly partial. Quote descriptions that contain a colon.

## How each choice is made

For the agent, the model and the thinking level separately: explicit arguments, then the agent file, then Jev, then the defaults (`general`, the `balanced` tier, the parent's model and thinking level).

- **Provider.** Implicit model choices always stay on the parent's provider: an agent-file model or tier model from another provider is ignored. Pass an explicit `model` argument to cross providers.
- **Jev's picks.** Jev picks the agent when its confidence is at least 0.5; a model tier (`fast`, `balanced`, `strong`) when the parent's provider has at least one tier model, configured or from the `openai-codex` defaults below (below 0.4 confidence: `balanced`); and the thinking level from a 0-3 score mapped to `low`, `medium`, `high`, `xhigh`. Without Jev, or when its request fails, the defaults apply.
- **Thinking.** Children always get an explicit `--thinking`, so [pi-auto-effort](https://pi-plugins.vercel.app/plugins/pi-auto-effort/) stays off in them.

## Configuration

`~/.pi/agent/pi-subagents.json` (or `$PI_CODING_AGENT_DIR/pi-subagents.json`), with `<cwd>/.pi/pi-subagents.json` merged on top; objects merge, other values replace, and invalid files or mistyped values are ignored. Example (model names are placeholders for your own):

```json
{
  "tiers": {
    "fast": "anthropic/claude-haiku-5",
    "balanced": "anthropic/claude-sonnet-5-5",
    "strong": "anthropic/claude-opus-5-5"
  },
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 3000 },
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
| `tiers` | `{}` | legacy tier models; only entries on the parent's provider apply |
| `providerTiers` | `{}` | tier models per provider (below); take precedence over matching `tiers` |
| `tierDescriptions` | built in | what Jev reads for each tier |
| `jev` | as above | `enabled`, classifier `provider` and `model`, `timeoutMs` |
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
      "balanced": "openai-codex/gpt-6.1-sol",
      "strong": "openai-codex/gpt-6.1-sol"
    }
  }
}
```

For `openai-codex`, missing tiers use registered models whose ids end in `-luna` (fast) or `-sol` (balanced and strong), preferring the parent's matching generation, otherwise the newest registered one. These defaults use only models present in Pi's registry. Other providers use the parent's model for any tier not configured.

Children run with `PI_SUBAGENT=1` and `PI_SUBAGENT_DEPTH` set, which is how `maxDepth` is enforced, and with `PI_CACHE_RETENTION` set from `childCacheRetention`. Children work in quick turns and are discarded when done, so the 1-hour tier's higher cache-write price (2x input instead of 1.25x on Anthropic) rarely pays off for them even when the main session uses it.

## Requirements and costs

- Each subagent is a full Pi session using your configured models and credentials; its tokens and cost are billed like any other session's. Children run with `--no-session` unless forked (forked sessions go to `~/.pi/agent/subagents/sessions`).
- Jev picks are optional classifier requests through Pi's classifier model API (Pi 0.99 or newer). The default `typesafe` provider needs Pi to have credentials for it (for example `TYPESAFE_API_KEY`); these requests can be billed. Set `"jev": { "enabled": false }` to turn them off; the defaults then apply.
- `worktree: true` needs the `worktree` command on `PATH`.
- On disk: run output and transcripts under `~/.pi/agent/subagents/<id>/`, and a temporary file for an agent's system prompt.

## Optional integrations

Each works alone; with a sibling loaded they work together through Pi's event bus and the activity protocol in `src/activity.ts` (copied verbatim into pi-bg, pi-subagents, pi-marimo, pi-herdr and pi-plan-mode).

- **[pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/).** FleetView ends with pi-bg's pill (`2 shells`, `· 1 failed`); `↓` moves through the subagents to it, and Enter opens pi-bg's `/tasks` view, which lists this session's runs mixed in with its shells, tagged `agent` (Enter opens a run's conversation, `x` twice stops it, `x` on an ended one dismisses it). pi-bg then draws no pill of its own; with `"fleetView": false` it does. Each async run is outside work that pi-bg's `bg_wait subagent:<id>` can wait on inside the turn; the async result names the ids, and a chain's intermediate steps say the chain goes on. The result still arrives as its own message.
- **[pi-marimo](https://pi-plugins.vercel.app/plugins/pi-marimo/).** FleetView ends with its pill (`1 notebook`) too; Enter on it opens the busiest notebook full screen.
- **[pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/).** Async (or backgrounded) calls hold `herdr:background` while they run, which pi-herdr shows in the pane's `$bg` token.

## Limitations

- FleetView, the viewer and the widget exist only in the TUI; other modes get the tool and `/subagents` lists.
- The tool row updates only while its call is open; async runs are followed through FleetView, the widget or `/subagents`.
- Children are RPC processes; the views are rebuilt from their RPC event streams.
- Agent roles' no-change instructions are instructions, not a filesystem sandbox.

## Development

```sh
cd packages/pi-subagents
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and then `vitest run` (unit tests use a fake RPC child in place of Pi). `npm run eval` routes 15 tasks across six agents through live Jev via the installed Pi (skipped without `TYPESAFE_API_KEY`); it makes live, paid classifier requests, so run it only with explicit authorization. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).

The widget, FleetView and conversation viewer are adapted from [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) by tintinweb (MIT), ported to this extension's RPC children, run records and Jev picks.
