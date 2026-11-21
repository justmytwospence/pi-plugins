---
title: pi-plan-mode
description: Claude Code-style plan mode in your conversation, or two constrained planners side by side whose plans you compare, merge and implement.
plugin: pi-plan-mode
---

The global [System 1](/plugins/pi-system1/) configuration (`/system1`) sets an ordered chain of Jev and native OpenAI Decisions for tool preselection and effort recommendations (Jev only by default). The legacy `jevToolSelection` switch disables tool preselection only; Jev provider/model settings apply to both uses only when Jev answers. Decisions requires pi-system1 and its isolated API credential; it uses API billing, not subscription OAuth. Pi does not verify credit funding. Operational failures can advance to the next configured backend with a notification; valid judgments and safety refusals do not trigger failover. Manual tool selection remains available.

## Switchyard

The optional package-local adapter shows the latest reviewed plan in a **Plan** session panel: a desktop panel tab and portable phone Details content. The original plan text and supplied changes-since-last-version remain visible. A noninteractive composer pill reflects Pi's published workflow status; plan text by itself never implies approval or execution.

Approval stays in the existing Pi interaction, including revision, saving for later, cancellation and acceptance. The terminal and remote dialog race uses the first answer and closes both owners on completion or failure; a failed dialog is not silently reopened. Reloading adapters restores only persisted display state, not historical approvals, notifications or tool execution. Older Switchyard hosts retain the legacy plan/status panels, without duplicate panels on newer hosts. The terminal layout and footer geometry are unchanged.

See the [Switchyard integration contract](/architecture/switchyard/).

## Quick reference

- **Use it for:** Research before implementation in the main conversation, or compare two constrained planners.
- **Enable:** Select `packages/pi-plan-mode/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/plan`, `/planners`; enter/exit and active-run tools below. Approval offers implementing here or compacting the plan first; a [worker](#choosing-who-implements) builds the plan in the same loop, then the session returns to your model; `ask_planner` is available during that build. No standalone shortcut by default; gate Shift+Tab needs an explicit stock remap.
- **Settings:** `pi-plan-mode.json`; `toggleShortcut` unset, implementation context keep, export `PLAN.md`; optional classifier tool selection on.
- **Requirements, cost & privacy:** TUI and provider access for `/planners`; normal plan mode uses the main session. Planners/helpers each consume model usage; selected tools can send repository data externally.
- **Integrations & limits:** Optional gate, activity views, footer and Herdr. Planner/scout entries join `/tasks` and FleetView; `/stop` remains shell-only. Read-only policies are not a sandbox.

pi-plan-mode separates researching a change from implementing it, in two ways:

- **Plan mode** (`/plan`, or Shift+Tab with [pi-tool-gate](/plugins/pi-tool-gate/) after an [explicit stock-key remap](/guides/keyboard/#resolve-the-two-stock-conflicts)) works in your own conversation, as Claude Code's does: your agent researches (and may spike in a scratch directory), keeps the repository unchanged, writes a plan file, and asks you to approve it and who implements it.
- **`/planners`** opens a full-screen workflow with Settings, Tools, Planning, Review, and Implement steps. Two planner sessions investigate the same task; you can steer them, answer questions, compare proposals, and explicitly choose the plan to implement.

## Plan mode

```text
/plan Add rate limiting to the public API
```

`/plan` turns plan mode on and sends the task, if given, as your next message. With pi-tool-gate, plan is one of its [workflows](/plugins/pi-tool-gate/#workflow-and-approvals), independent of approvals; its cycle key reaches plan once the stock thinking-key conflict is resolved. Without the gate, `toggleShortcut` toggles it. Your agent can also enter plan mode itself through `enter_plan_mode` when a task deserves a plan first.

In the interactive UI, the configured standalone shortcut previews work/plan; with the gate it delegates to the gate's workflow cycle, sharing its timer and journal rather than starting another. Supported workflow, reasoning and approval cycles share a preview and one combined, immediately updated settings line. `pending` is not effective Plan protection: current guards remain in force until the final selection applies. Previewing Plan does not allocate a plan path or directory; a round trip returning every touched setting to its original value is a true no-op. An ordinary prompt flushes the preview first, and is not sent if application fails. Dialogs/selectors, leaving main focus, session or branch navigation, compaction, reload/shutdown and external changes to touched settings cancel a pending preview. Explicit commands, picker selections, and Plan tools remain immediate; neither hovering nor waiting approves a plan or tool call.

Keyboard cycles commit when all participating modifiers are released if release reporting is negotiated through the actual terminal path and the current held state is confirmed. SSH, Herdr and tmux paths are negotiated, not assumed to support it. Otherwise, including first or fast interactions while negotiation or held state is unconfirmed, unmodified keys, pointer and programmatic cycles, the final choice applies after 1000 ms of inactivity; each accepted cycle restarts that fallback. A confirmed hold has no unconditional timeout: if a release is lost with no later input, it cannot be distinguished from a continuing hold. Each batch has its own transaction; consecutive completed successful or unchanged batches reuse one UI-only history row until a boundary such as submit, an explicit choice, unrelated output or navigation. The row shows the latest batch, not an aggregate of earlier changes.

While it is on, your agent writes its plan to a unique temporary draft, by default `~/.pi/agent/plans/draft-<timestamp>-<uuid>.md` (`plansDirectory`), allocated before its title is known. The draft stays at that path while the agent writes, and the agent is asked for a concise, descriptive first Markdown heading. The repository does not change: `edit` and `write` are blocked except for that file and a scratch directory beside it (`<draft>.spike/`, for spikes and prototypes, which the agent creates when it needs it), and shell commands that would change tracked files, add files git would not ignore, or change git state are blocked. With pi-tool-gate, the gate's plan scope applies under either approval setting: commands that leave the repository unchanged run and then go through approvals like any other call. Without it, only read-only commands run, by the read-only shell policy (`bg_run` and `powershell` too). Other extension and MCP tools are not blocked by plan itself (with the gate, its approval setting decides about them, and subagents started while planning inherit plan and its scratch directory); your agent is instructed not to change anything with them.

When the plan is complete, your agent calls `exit_plan_mode` directly. Plan tools are model-only: calling them inside `codemode` is prohibited because nested calls have no inline plan renderer. The plan appears in the conversation. You choose:

- **Yes, implement** (first and default): implement with the settings shown above the actions. Three flat lines of the question say what you are choosing, each with its key:
  - **Model** (`tab` cycles, only when there are several; the key shows which of them is selected): who implements. On a premium or strong model (Fable, Opus, Astra, Sol, Carbon, Neon) the first model is the one a tier down, the next is two tiers down, and the last is your own model; see [Choosing who implements](#choosing-who-implements). A worker's line says who answers its questions and that the session returns to your model when the build ends. Other models implement on themselves.
  - **Effort** (`←/→`): the selected model's effort, separate for each model. It starts from System 1's recommendation, your planning level or the model's default.
  - **Context** (`c`): keep this conversation, or compact to the approved plan and implement in the same session, without creating a child session. It starts compacted when another model implements (it reads the conversation without a prompt cache), when the prompt cache is cold, or when the conversation is large (a miss would reach [pi-cache-guard](/plugins/pi-cache-guard/)'s warning threshold, else 100k tokens), and keeps the conversation otherwise. A `defaultImplementationContext` of `keep` or `clear` replaces that rule. The line shows the conversation's size and why it is compacted, and the default is decided when the dialog opens, never while you read it.
  Phone clients that read the dialog off the screen approve with the settings shown. An RPC dialog, where buttons are all it has, lists the same choices as **Yes, implement here**, **Yes, compact plan and implement here** and, for each other model, **Yes, implement with <model>** and **Yes, compact and implement with <model>**, with the default first.
- **Edit the plan**: revise it in Pi's editor, then choose again.
- **Save for later**: edit the hyphenated name suggested from the plan title; `.md` is added automatically. The snapshot goes under `plansDirectory` (default `~/.pi/agent/plans/`) and collisions get `-2`, `-3`, etc. The original working draft stays at its path for historical references, but the next planning task gets a fresh draft. Saving ends the turn without approving implementation. Continue later with `/plan Continue from @/absolute/path/descriptive-plan.md` as a planning prompt, not an import command or automatic approval.
- **No, keep planning**: the turn ends and you say what should change in the chat. The agent answers there, and the next review starts with the lines that changed since the plan you declined.

Approving a newly allocated temporary draft copies the exact final reviewed text (including your edits) to a title-derived file such as `add-api-rate-limiting.md`; implementation uses that copy. The original draft stays intact for historical references and recovery. Names use the first usable title, normalized to a hyphenated slug of at most 80 characters; missing, generic (`Plan` or `The Plan`) and non-ASCII-only titles fall back to `untitled-plan`. Collisions add `-2`, `-3`, etc. without overwriting files. Reapproval keeps the approved path; existing, restored legacy and user-provided paths are not renamed or replaced. **Save for later** honors the name you enter rather than forcing the title-derived suggestion.

Up/Down navigates, Left/Right adjusts effort on the implement rows, Enter confirms, and Esc/Ctrl+C cancels. Rows that implement on the same model share one effort selection. Before approval, System 1 can recommend effort once; authored effort pins and manual adjustments take precedence, and configured defaults and existing fallbacks apply when appropriate. With a pair selected, the worker rows' effort targets the worker and the planner rows' the planner, and the question's note says what happens after the build. The approved level is applied without another judgment. Unsupported levels are clamped to the model's supported levels; nonreasoning models have no effort adjustment. Changes apply only to this approval, not saved defaults; RPC offers action and effort separately. See [Choosing effort](/guides/effort/).

Approval returns the workflow to work without changing approvals. Plans use a handoff standard (Summary, Decisions, Changes, Steps, Verification, Out of scope, Handoff notes) so a cheaper worker that reads the conversation needs no new design decisions.

When you decline and the agent revises a plan, approval shows a short **What changed** bullet summary followed by the full current plan in normal styling, not a red/green prose diff. Without a supplied summary it says **Plan revised since your last review.** First or identical submissions show no revision summary. Editing the plan in the approval dialog clears any stale agent summary; the full current plan is always authoritative.

Implementation is ordinary chat: implementation, verification and a normal final reply. Optional compaction does not change that.

### Choosing who implements

You plan on the model you are on and choose the implementer at approval, as Claude Code's `opusplan` does, without a separate model in `/model`. A premium or strong session model offers workers from the shared model-family table (see [Model families](/plugins/pi-model-families/)): one tier down (the default), two tiers down, then your own model. Fable offers Opus and Sonnet, Opus offers Sonnet and Haiku, Astra offers Sol and Terra, Sol offers Terra and Luna, Carbon offers Neon and Hydrogen. Each family resolves to the newest available generation on your model's provider and route, and a tier with no available model is skipped. Provisional families never take part; Sonnet, Terra and other balanced or fast models implement on themselves.

Approving with a worker switches the session to it for the run that implements the plan. When that run ends, however it ends (finished, stopped with Esc, failed, reloaded), the session is back on your model and its level. Nothing stays on the worker and there is no resume command. Choosing a model yourself with `/model` during a build wins: the build continues on it and nothing switches back. Entering plan mode during a build returns to your model. With pi-status-footer, the model row shows the worker while it builds. The earlier plan model pairs (`opusplan`, `fableplan`, `astraplan`, ...) and the `modelPairs` setting were removed; a session left on one moves to its planner family's newest model.

Effort: when plan mode starts on a model that offers workers, System 1 judges effort once for your model (skipped if you changed the level since), and at approval each row's effort targets its own model. Consultations use the level you planned at.

Each switch changes which model reads the conversation, and a provider caches per model, so a build costs one cold read on the worker; the approval defaults to compacting to the plan when a worker implements to keep that small. Nothing rewrites earlier messages of a request.

**Consulting the planner.** While a worker builds it has `ask_planner` and `planner_answer`. When the plan does not fit what it finds, the worker calls `ask_planner`; the next requests of the same conversation go to your model, which reads everything, including the worker's changes, may amend the plan file (a dated line under `## Amendments`), asks you with `ask_user_question` when the decision is yours, and finishes with `planner_answer`. If it replies without calling `planner_answer`, its reply is taken as the answer. Both tools are off outside a build.

During a consultation, `edit` and `write` are blocked except for the plan file, `bash` is limited to read-only commands (pi-tool-gate's analysis when it is loaded, otherwise the read-only policy and `safeSubcommands`), and `bg_run` is blocked. During a build, the first edit or write of each file the plan does not list (paths in backticks) gets a note appended to the tool result: call `ask_planner` if the change departs from the plan. Nothing else is blocked, and a plan that names no paths gets no notes.

Exec mode, `finish_plan`, completion review, model handoffs and `/plan-exec` were removed. A session saved with an unfinished exec implementation continues as ordinary work, with a one-time notice.

In Pi's fullscreen terminal mode, **Plan review** scrolls the main chat to the beginning of the plan when the approval picker opens, including for short plans. Scroll the chat to read the rest; ordinary redraws do not move you back. Editing the plan returns to its beginning, and closing review restores following the latest message. Regular terminal mode and RPC keep their usual presentation because Pi does not own their chat scrollback. Once you decide, a plan longer than 12 lines folds in the transcript (`… N more lines (ctrl+o to expand)`). [Compaction plan](/plugins/pi-compact-plan/) draws its compaction focus with the same review card.

Your agent plans on the session's model; a worker build is billed to the worker as its provider bills.

## Enable, requirements, and costs

Select `packages/pi-plan-mode/src/index.ts` through [suite installation](/guides/install/). The suite loads every entry by default, and all selected components share one Git pin.

`/planners` requires Pi's interactive terminal UI and authenticated access to the chosen model providers. The component documents Pi 0.99 or newer; the installation guide identifies the suite's tested host version. Planners use providers registered in the main session. Their optional research helpers are separate Pi subprocesses and need the provider extensions required by their models; `providerExtensions` can override automatic provider-extension discovery.

**Costs:** planners, helper agents, main-agent synthesis, and implementation all consume model usage. `/planners` always runs two planner sessions; use plan mode for a single plan. Tool preselection and effort recommendations use the selected Pi classifier and can incur charges; selected research tools may also call paid services. Set `jevToolSelection: false` to choose tools manually without that classifier step. No pi-subagents or pi-ask-user-question installation is required for the planner's own helper and question tools.

## Start the planners

Start with a specific outcome:

```text
/planners Add rate limiting to the public API, including tests and failure behavior
```

With no task text, planning uses the conversation so far. The Settings step selects planners A and B (B defaults to a different model), each planner's effort and helper model, and a per-turn time limit. A planner is asked to wrap up at 80% of its limit and stopped at the limit.

The Tools step exposes Shell, Subagents, configured toolsets, MCP servers, and other extension tools. Select only what the investigation needs. The classifier can preselect tools, but your manual choices take precedence. `alwaysOffer` keeps specified tools preselected regardless of their scores; unavailable names are ignored.

During planning, type into a planner's lane to steer its active turn or start a follow-up turn when idle. Its questions appear in that lane as a picker (arrows or `j`/`k`, digits jump, Enter picks; `Type something.` opens an answer line, Esc returns to the options). Tab moves between panes and actions, Ctrl+U/Ctrl+D scroll, Left/Right on an empty line switch a lane between its plan and its chat (shown as tabs under the lane), Ctrl+O expands tool output, Ctrl+T hides thinking and Ctrl+G edits the lane's message in your external editor (`externalEditor`, `$VISUAL` or `$EDITOR`), as in Pi.

Lane commands act on that planner's session: `/login`, `/model`, `/thinking` (or `/effort`), `/compact`, `/context` (or `/usage`), `/copy`, and `/help`. Model and effort changes wait until it is idle. Start a message with `//` when you want literal leading-slash text instead of a lane command.

## Review and implement

**M is your existing main agent**, not a third isolated planner. Every submitted plan and revision is delivered to the main conversation. That delivery does not itself start a main-agent turn. M's pane joins the screen once both plans are in (or one is in and the other planner failed); until then the lanes have the whole screen, and M's chat and a notification say when it is there.

While the run is active, M has two tools:

- `plan_ask_planner` asks A or B about its research.
- `plan_submit_merged` records a combined or adjusted proposal as plan M.

The **Write plan M** and **Revise plan M** actions request that synthesis for you. Planner-internal tools are separate: `plan_mode_question` asks in-lane questions, `plan_mode_complete` submits plan versions, and `plan_subagents` starts research helpers.

In the transcript, planner questions show their headers and prompts; results show selected or custom answers and notes, or the cancellation or validation message. Main-agent planner calls show the planner and a short question preview. Merged-plan calls show a line count instead of dumping the plan, and replies distinguish working, waiting for your answers, completed, aborted and failed outcomes. Ctrl+O expands the original question, options, answers or plan prose. These tool-owned presentations also remain in use with pi-cc-render enabled. Only the display changes: tool arguments, JSON results, structured details and transcript checkpoints remain unchanged.

Choose **Implement…** to pick the plan (M first, once there is one), the context and the effort. Implementation uses the main session's current model regardless of whether M, A or B wrote the plan. Context is **keep conversation** or **compact to plan (same session)**. Either is ordinary chat execution with a normal final reply and no child session. Left/Right adjusts each row; defaults and supported-level normalization match inline approval.

Implementing M, A or B writes the selected plan's current text under `plansDirectory` using the same title-derived names, fallback and collision suffixes as inline approval.

**Export…** picks a plan and an explicit path and writes it to Markdown without initiating implementation. Title-derived naming does not change that path; an existing destination still reports a collision rather than being overwritten. **Discard** stops the planners and drops the plans; Esc hides the screen and keeps them.

## Settings and trusted capabilities

Settings normally live at `~/.pi/agent/pi-plan-mode.json`. Common options are editable in the `/planners` Settings step, including the default implementation context. This example chooses manual tool selection and a shorter planner-turn limit without assuming particular model IDs:

```json
{
  "plannerTimeoutSeconds": 900,
  "jevToolSelection": false,
  "alwaysOffer": [],
  "defaultImplementationContext": "keep",
  "defaultPlanExportPath": "PLAN.md",
  "plansDirectory": "~/notes/plans"
}
```

Choose available models in the UI, or configure `planners` and `scoutModelMap` using `provider/modelId` specifications with optional effort suffixes. A configured model of a known family (`claude-fable-5-1`, `gpt-6-sol`) names that family, not a release: it resolves to the family's newest registered generation on the same provider and route, so a new release needs no settings change.

The earlier `modelPairs`, `implementationModelMap`, `defaultImplementationThinkingLevel`, `completionReview` and `completionMaxRevisions` keys are ignored. `plannerToolsets` groups extension tools, `commandGrants` permits specified extra commands with associated skills, and `providerExtensions` controls helper authentication support. `toggleShortcut` toggles plan mode when pi-tool-gate is absent (with the gate it cycles the gate's modes; do not bind it to the gate's key); it takes effect after `/reload`. `plansDirectory` moves plan mode's plan files.

Jev defaults to provider `typesafe`, model `jev-latest`, and selection threshold `0.5`. Default `alwaysOffer` names are `web`, `web_search`, `fetch_content`, `context7`, `jev`, and `system1_judge`; this neither installs those tools nor provides their credentials.

`planCompleteCommand` is an optional command argument array invoked on implementation or export. It receives hook-shaped JSON on stdin including `tool_input.plan`, `tool_response.filePath`, and `model`. Treat it as executable automation, not passive configuration.

Invalid settings fall back to defaults and are not overwritten. Saves support symlinked settings and preserve unknown fields. The [detailed settings reference](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-plan-mode/docs/settings.md) explains advanced shell-policy configuration.

## Safety boundaries and persistence

Planner sessions omit edit/write tools, restrict shell commands through a reviewed policy, and limit MCP access to selected tools. This reduces accidental mutation; it is not an operating-system sandbox. Selected extension tools and configured commands still run with Pi's permissions, and reading repository files can expose sensitive data to the chosen provider.

In particular, `safeSubcommands` fully trusts matching command prefixes and bypasses checking of the **entire submitted shell command**, including trailing chains and redirects. Do not use it as a harmless read-only allowlist. Even default Git inspection can invoke configured helpers unless the relevant negative flags suppress them.

During a consultation, the pair's planner works in your conversation under the consult guard above; it may write only the plan file and run read-only commands.

M is only instructed to leave files alone during planning; it is not constrained by the planners' read-only tool policy. Implementation and exports intentionally write files.

Esc offers Hide, Stop planning, or Back. Hiding leaves planners running; `/planners` reopens the screen. Sessions under `~/.pi/agent/plan-mode/planners/` retain research across reload or resume, and interrupted or failed turns can resume automatically. Remember that resumed work can incur further usage.

## Optional integrations and next checks

Planners and their research scouts offer activity entries to `/tasks` and pills to FleetView (or the pi-bg fallback host). Enter on an entry opens `/planners`; double-`x` stops a working planner row. Scout rows are observational, not independently stoppable from the list; stop their owning planner or use the planning screen. `/stop` still stops only pi-bg shell tasks. The planning screen remains available without any activity host.

With pi-tool-gate, plan approval returns to work without changing approvals. Without the gate, plan mode retains its local work/plan behavior and does not enforce approvals. With pi-subagents, scout-model integration remains optional through `subagents:role-model` (the `explorer` role); its worker is not an implementation fallback. Web tools, MCP servers, classifier selection, and completion hooks are optional. With pi-herdr, planner work emits `herdr:working` holds for background visibility; without it, planning still works. Use pi-diff-review after implementation to inspect the actual changes rather than treating an accepted plan as proof of correct execution.

See [planning and review](/recipes/plan-review/), [activity architecture](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/). [Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-plan-mode) cover planner flow, shell policy, persistence, and worker builds.
