---
title: pi-plan-mode
description: Claude Code-style plan mode in your conversation, or two constrained planners side by side whose plans you compare, merge and implement.
plugin: pi-plan-mode
---

## Quick reference

- **Use it for:** Research before implementation in the main conversation, or compare two constrained planners.
- **Enable:** Select `packages/pi-plan-mode/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/plan`, `/planners`; enter/exit and active-run tools below; approving a plan chooses ordinary execution here or a distinct-model handoff with exec mode (`ask_planner`, `finish_plan`). No standalone shortcut by default; gate Shift+Tab needs an explicit stock remap.
- **Settings:** `pi-plan-mode.json`; `toggleShortcut` unset, implementation context keep, export `PLAN.md`; optional paid Jev tool selection on.
- **Requirements, cost & privacy:** TUI and provider access for `/planners`; normal plan mode uses the main session. Planners/helpers each consume model usage; selected tools can send repository data externally.
- **Integrations & limits:** Optional gate, activity views, footer and Herdr. Planner/scout entries join `/tasks` and FleetView; `/stop` remains shell-only. Read-only policies are not a sandbox.

pi-plan-mode separates researching a change from implementing it, in two ways:

- **Plan mode** (`/plan`, or Shift+Tab with [pi-tool-gate](/plugins/pi-tool-gate/) after an [explicit stock-key remap](/guides/keyboard/#resolve-the-two-stock-conflicts)) works in your own conversation, as Claude Code's does: your agent researches read-only, writes a plan file, and asks you to approve it and who implements it.
- **`/planners`** opens a full-screen workflow with Settings, Tools, Planning, Review, and Implement steps. Two planner sessions investigate the same task; you can steer them, answer questions, compare proposals, and explicitly choose the plan to implement.

## Plan mode

```text
/plan Add rate limiting to the public API
```

`/plan` turns plan mode on and sends the task, if given, as your next message. With pi-tool-gate, plan mode is one of the gate's [permission modes](/plugins/pi-tool-gate/#permission-modes) and its configured cycle key reaches it once the stock thinking-key conflict is resolved; the footer shows `plan mode on`. Without the gate, `toggleShortcut` toggles it. Your agent can also enter plan mode itself through `enter_plan_mode` when a task deserves a plan first.

While it is on, your agent writes its plan to a plan file, by default `~/.pi/agent/plans/<two-words>.md` (`plansDirectory`), one per session. `edit` and `write` are blocked except for that file. With pi-tool-gate, shell commands are judged as in auto mode; without it, only the read-only shell policy runs. Other extension and MCP tools are not blocked; your agent is only instructed not to change anything with them.

When the plan is complete, your agent calls `exit_plan_mode` directly. Plan tools are model-only: calling them inside `codemode` is prohibited because nested calls have no inline plan renderer. The plan appears in the conversation and you choose:

- **Yes, implement here** (first and default): the current model implements with the whole conversation.
- **Yes, compact plan and implement here**: compact to the approved plan, then implement with the same model in the same session, not a child.
- `Yes, hand off to <model> (<effort>)`: a distinct available model implements the plan in this session. Once the current turn ends, the context is compacted down to the plan, the model is switched, and a collapsed handoff message (`ctrl+o` expands it) carries the plan and how to implement it; implementation starts at once.
- **Edit the plan first**: revise it in Pi's editor, then choose again.
- **No, keep planning**: the turn ends and you say what should change in the chat. The agent answers there, and the next review starts with the lines that changed since the plan you declined.

Up/Down navigates, Left/Right adjusts effort for every execution option (including both direct rows), Enter confirms, and Esc/Ctrl+C cancels. Both direct rows share the current model's effort selection. Direct effort defaults to the current effort; handoffs use a configured target suffix, then `defaultImplementationThinkingLevel`, then `medium`. Unsupported levels use the greatest supported level no higher than requested, else the first supported level. Nonreasoning models have no effort adjustment. Changes apply only to this approval, not saved defaults; RPC offers action and effort separately. Changing effort alone is not a handoff: model identity is provider plus model ID.

The approval returns the permission mode to what it was before planning (with pi-tool-gate; auto when that is unknown and in the cycle, else manual approval). `implementationModelMap` supplies ordered handoff choices; absent entries use the provider-local defaults below, never pi-subagents' worker model or a same-model pseudo-handoff. The direct choices are always available. Plans use a handoff standard (Summary, Decisions, Changes, Steps, Verification, Out of scope, Handoff notes) so an actual handoff needs no new design decisions.

Direct execution is ordinary chat: implementation, verification and a normal final reply, without exec mode, a seeded consultant, `ask_planner`, `finish_plan`, completion card/review or return to a planning branch. Optional compaction does not change that workflow.

### Exec mode

Approving a distinct-model handoff puts your chat in exec mode, a mode like the permission modes except that Shift+Tab never enters it: only an approved handoff does, and it lasts until `finish_plan` ends it or a newer approved plan replaces it. The permission mode underneath (the one you were in before planning) still decides what runs, and Shift+Tab still changes it. With [pi-status-footer](/plugins/pi-status-footer/) the footer shows it in the mode's place on the permission-mode row, for example `exec mode on · auto · Claude Opus 5.5 on call · 2 asks · $0.31`. Plans are named by their first heading wherever you see them, never by their file name.

- **Planner on call.** After a handoff, the model that planned stays on call and your implementing agent gets `ask_planner`: it asks when the plan does not fit what it finds, and waits for a decision. The planner is a copy of the planning conversation, opened the first time it is asked, so it keeps its research context. It reads the current files, including the implementer's changes, and runs read-only commands, and it gets every tool a `/planners` planner can be given: your `plannerToolsets` (web research, MCP servers), command grants and read-only subagents. The only file it may write is the plan file. When its answer changes the plan it edits the file and adds a dated line under `## Amendments`, and the tool row shows the diff. Each ask is a planning-model turn over the planning context; its cost counts in the footer and the session totals.
- **Unplanned files.** The first edit or write of each file the plan does not list (paths in backticks) gets a note appended to the tool result: ask the planner, or record the departure under `## Amendments` when there is none. Nothing is blocked, and a plan that names no paths gets no notes.
- **`finish_plan`.** When implementation is finished, the agent supplies three required nonempty fields: `report` (what changed), `verification` (checks and results, including checks not run), and `concerns` (deviations, failures and remaining work; `None` only when accurate). The colored **Implementation complete** card separates What changed, Verification, Outstanding issues and Planner assessment, followed by the plan, implementer and consultation count. Verification, outstanding issues, verdict and count remain visible even collapsed; Ctrl+O expands only the longer implementation and assessment narratives. By default, an on-call planner makes a targeted review in an additional model turn, with its cost shown separately from implementation consultations. It inspects relevant evidence, including files, working-tree changes and commit history, and distinguishes inspected evidence from reported checks. It is instructed not to run tests or mutate files; its tool policy is not a sandbox. With no planner on call, or with `completionReview` disabled, there is no assessment. Failed or unavailable reviews are reported honestly rather than treated as success. The assessment is informational, not user approval: `finish_plan` ends exec mode without asking you, and findings do not automatically trigger more implementation. It switches back to the planning model when the session is still on the one the handoff switched to. After an in-place handoff, a `/plan-back` command then runs by itself once the turn settles: it returns the session to the planning conversation (no model summary; the implementer's report is added there as a message the planner reads, drawn as the same card, headed by [pi-recap](https://pi-plugins.vercel.app/plugins/pi-recap/)'s one-line recap when that is loaded). If it cannot, it says so and `/tree` still reaches the planning branch.

Approving a newer plan replaces exec mode. `enter_plan_mode` is refused while it is on; `/plan` and Shift+Tab still plan. A reload or resume restores it from the session.

In Pi's fullscreen terminal mode, **Plan review** scrolls the main chat to the beginning of the plan when the approval picker opens, including for short plans. Scroll the chat to read the rest; ordinary redraws do not move you back. Editing the plan returns to its beginning, and closing review restores following the latest message. Regular terminal mode and RPC keep their usual presentation because Pi does not own their chat scrollback. Once you decide, a plan longer than 12 lines folds in the transcript (`… N more lines (ctrl+o to expand)`). [Compaction plan](/plugins/pi-compact-plan/) draws its compaction focus with the same review card.

Your agent plans on the session's model. An enabled completion review with a planner on call adds a separate model request.

## Enable, requirements, and costs

Select `packages/pi-plan-mode/src/index.ts` through [suite installation](/guides/install/). The suite loads every entry by default, and all selected components share one Git pin.

`/planners` requires Pi's interactive terminal UI and authenticated access to the chosen model providers. The component documents Pi 0.99 or newer; the installation guide identifies the suite's tested host version. Planners use providers registered in the main session. Their optional research helpers are separate Pi subprocesses and need the provider extensions required by their models; `providerExtensions` can override automatic provider-extension discovery.

**Costs:** planners, helper agents, main-agent synthesis, and implementation all consume model usage. `/planners` always runs two planner sessions; use plan mode for a single plan. Optional Jev tool selection uses Pi classifier models and can incur TypeSafe charges; selected research tools may also call paid services. Set `jevToolSelection: false` to choose tools manually without that classifier step. No pi-subagents or pi-ask-user-question installation is required for the planner's own helper and question tools.

## Start the planners

Start with a specific outcome:

```text
/planners Add rate limiting to the public API, including tests and failure behavior
```

With no task text, planning uses the conversation so far. The Settings step selects planners A and B (B defaults to a different model), each planner's effort and helper model, and a per-turn time limit. A planner is asked to wrap up at 80% of its limit and stopped at the limit.

The Tools step exposes Shell, Subagents, configured toolsets, MCP servers, and other extension tools. Select only what the investigation needs. Jev can preselect tools, but your manual choices take precedence. `alwaysOffer` keeps specified tools preselected regardless of their scores; unavailable names are ignored.

During planning, type into a planner's lane to steer its active turn or start a follow-up turn when idle. Its questions appear in that lane as a picker (arrows or `j`/`k`, digits jump, Enter picks; `Type something.` opens an answer line, Esc returns to the options). Tab moves between panes and actions, Ctrl+U/Ctrl+D scroll, Left/Right on an empty line switch a lane between its plan and its chat (shown as tabs under the lane), Ctrl+O expands tool output, Ctrl+T hides thinking and Ctrl+G edits the lane's message in your external editor (`externalEditor`, `$VISUAL` or `$EDITOR`), as in Pi.

Lane commands act on that planner's session: `/login`, `/model`, `/thinking` (or `/effort`), `/compact`, `/context` (or `/usage`), `/copy`, and `/help`. Model and effort changes wait until it is idle. Start a message with `//` when you want literal leading-slash text instead of a lane command.

## Review and implement

**M is your existing main agent**, not a third isolated planner. Every submitted plan and revision is delivered to the main conversation. That delivery does not itself start a main-agent turn. M's pane joins the screen once both plans are in (or one is in and the other planner failed); until then the lanes have the whole screen, and M's chat and a notification say when it is there.

While the run is active, M has two tools:

- `plan_ask_planner` asks A or B about its research.
- `plan_submit_merged` records a combined or adjusted proposal as plan M.

The **Write plan M** and **Revise plan M** actions request that synthesis for you. Planner-internal tools are separate: `plan_mode_question` asks in-lane questions, `plan_mode_complete` submits plan versions, and `plan_subagents` starts research helpers.

Choose **Implement…** to pick the plan (M first, once there is one), mode, effort and context. **Here** is the default: it uses the main session's current model and effort regardless of whether M, A or B wrote the plan. Context is **keep conversation** or **compact to plan (same session)**. Either is ordinary chat execution with a normal final reply, no consultant or exec/completion workflow, and no child session.

**Handoff** appears only when the plan author's configured list or provider-local defaults offer a target distinct from the current session model. The model row cycles only those targets. Handoff retains keep-conversation and fresh-child choices; a fresh child starts with only the brief and plan. Actual handoffs start exec mode; the author planner (A or B) stays on call, and plan M only with a fresh child. Consultation, `finish_plan` and completion review remain on these paths.

Left/Right adjusts the effort row in both modes. Defaults and supported-level normalization match inline approval; switching modes preserves per-model effort selections.

**Export…** picks a plan and a path and writes it to Markdown without initiating implementation. **Discard** stops the planners and drops the plans; Esc hides the screen and keeps them.

## Settings and trusted capabilities

Settings normally live at `~/.pi/agent/pi-plan-mode.json`. Common options are editable in the `/planners` Settings step, including the **Completion review** toggle (`completionReview`, default `true`). Turning it off skips the automatic review but keeps the completion card. This example chooses manual tool selection and a shorter planner-turn limit without assuming particular model IDs:

```json
{
  "plannerTimeoutSeconds": 900,
  "jevToolSelection": false,
  "completionReview": true,
  "alwaysOffer": [],
  "defaultImplementationContext": "keep",
  "defaultPlanExportPath": "PLAN.md",
  "plansDirectory": "~/notes/plans"
}
```

Choose available models in the UI, or configure `planners`, `scoutModelMap`, and `implementationModelMap` using `provider/modelId` specifications with optional effort suffixes.

`implementationModelMap` values are ordered lists; legacy scalar specs remain accepted as one-element lists. An explicit empty array disables automatic handoff defaults for that exact planning model, not direct execution. `scoutModelMap` remains scalar. For example (model IDs are illustrative):

```json
{
  "implementationModelMap": {
    "anthropic/claude-fable-5-1": ["anthropic/claude-opus-5-5:high", "anthropic/claude-sonnet-5-1:medium"],
    "openai-codex/gpt-6-astra": []
  },
  "defaultImplementationThinkingLevel": "medium"
}
```

Missing map entries use provider-local defaults, nearest tier first: **Astra → Sol, Terra; Sol → Terra; Fable → Opus, Sonnet; Opus → Sonnet**. Sonnet, Terra and unrecognized families have no defaults. OpenAI family IDs are recognized on `openai` and `openai-codex`, Anthropic families on `anthropic`; defaults stay within the exact provider and available/scoped models. They prefer a same-generation sibling, otherwise the highest available numeric generation. Unrecognized aliases/snapshots do not generate defaults. Explicit mappings may cross providers; unavailable, duplicate and same-model targets are removed. There is no worker fallback.

`defaultImplementationThinkingLevel` supplies handoff effort only when the target has no suffix; without either, it is `medium`. Direct execution retains the current effort. `plannerToolsets` groups extension tools, `commandGrants` permits specified extra commands with associated skills, and `providerExtensions` controls helper authentication support. `toggleShortcut` toggles plan mode when pi-tool-gate is absent (with the gate it cycles the gate's modes; do not bind it to the gate's key); it takes effect after `/reload`. `plansDirectory` moves plan mode's plan files.

Jev defaults to provider `typesafe`, model `jev-latest`, and selection threshold `0.5`. Default `alwaysOffer` names are `web`, `web_search`, `fetch_content`, `context7`, and `jev`; this neither installs those tools nor provides their credentials.

`planCompleteCommand` is an optional command argument array invoked on implementation or export. It receives hook-shaped JSON on stdin including `tool_input.plan`, `tool_response.filePath`, and `model`. Treat it as executable automation, not passive configuration.

Invalid settings fall back to defaults and are not overwritten. Saves support symlinked settings and preserve unknown fields. The [detailed settings reference](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-plan-mode/docs/settings.md) explains advanced shell-policy configuration.

## Safety boundaries and persistence

Planner sessions omit edit/write tools, restrict shell commands through a reviewed policy, and limit MCP access to selected tools. This reduces accidental mutation; it is not an operating-system sandbox. Selected extension tools and configured commands still run with Pi's permissions, and reading repository files can expose sensitive data to the chosen provider.

In particular, `safeSubcommands` fully trusts matching command prefixes and bypasses checking of the **entire submitted shell command**, including trailing chains and redirects. Do not use it as a harmless read-only allowlist. Even default Git inspection can invoke configured helpers unless the relevant negative flags suppress them.

The planner on call gets every toolset, MCP server and command grant a `/planners` planner can be given, plus read-only subagents, but not your other extensions' tools; it cannot run tests and may write only the plan file. Its session is a seeded copy under `~/.pi/agent/plan-mode/planners/`.

M is only instructed to leave files alone during planning; it is not constrained by the planners' read-only tool policy. Implementation and exports intentionally write files.

Esc offers Hide, Stop planning, or Back. Hiding leaves planners running; `/planners` reopens the screen. Sessions under `~/.pi/agent/plan-mode/planners/` retain research across reload or resume, and interrupted or failed turns can resume automatically. Remember that resumed work can incur further usage.

## Optional integrations and next checks

Planners and their research scouts offer activity entries to `/tasks` and pills to FleetView (or the pi-bg fallback host). Enter on an entry opens `/planners`; double-`x` stops a working planner row. Scout rows are observational, not independently stoppable from the list; stop their owning planner or use the planning screen. `/stop` still stops only pi-bg shell tasks. The planning screen remains available without any activity host.

With pi-tool-gate, approving a plan returns to the permission mode you were in before planning (auto when unknown). With pi-subagents, scout-model integration remains optional through `subagents:role-model` (the `explorer` role); its worker model is not an implementation fallback. Web tools, MCP servers, classifier selection, and completion hooks are optional. With pi-herdr, planner work emits `herdr:working` holds for background visibility; without it, planning still works. Use pi-diff-review after implementation to inspect the actual changes rather than treating an accepted plan as proof of correct execution.

See [planning and review](/recipes/plan-review/), [activity architecture](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/). [Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-plan-mode) cover planner flow, shell policy, persistence, and implementation handoff.
