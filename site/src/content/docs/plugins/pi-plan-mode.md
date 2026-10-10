---
title: pi-plan-mode
description: Research with one or two constrained planners, compare their plans, and choose the implementation model and context.
plugin: pi-plan-mode
---

pi-plan-mode separates researching a change from implementing it. `/plan` opens a full-screen workflow with Settings, Tools, Planning, Review, and Implement steps. One or two planner sessions investigate the same task; you can steer them, answer questions, compare proposals, and explicitly choose the plan to implement.

## Enable, requirements, and costs

Select `packages/pi-plan-mode/src/index.ts` through [suite installation](/guides/install/). The suite loads all 19 extensions by default, and all selected components share one Git pin.

The planner requires Pi's interactive terminal UI and authenticated access to the chosen model providers. The component documents Pi 0.99 or newer; the installation guide identifies the suite's tested host version. Planners use providers registered in the main session. Their optional research helpers are separate Pi subprocesses and need the provider extensions required by their models; `providerExtensions` can override automatic provider-extension discovery.

**Costs:** planners, helper agents, main-agent synthesis, and implementation all consume model usage. A second planner is another session, not a free comparison. Optional Jev tool selection uses Pi classifier models and can incur TypeSafe charges; selected research tools may also call paid services. Set `jevToolSelection: false` to choose tools manually without that classifier step. No pi-subagents or pi-ask-user-question installation is required for the planner's own helper and question tools.

## Start and guide research

Start with a specific outcome:

```text
/plan Add rate limiting to the public API, including tests and failure behavior
```

With no task text, planning uses the conversation so far. The Settings step selects planner A, optional planner B, each planner's effort and helper model, and a per-turn time limit. A planner is asked to wrap up at 80% of its limit and stopped at the limit. Choose B as `none` for one planner.

The Tools step exposes Shell, Subagents, configured toolsets, MCP servers, and other extension tools. Select only what the investigation needs. Jev can preselect tools, but your manual choices take precedence. `alwaysOffer` keeps specified tools preselected regardless of their scores; unavailable names are ignored.

During planning, type into a planner's lane to steer its active turn or start a follow-up turn when idle. Its questions appear in that lane, including free-text answers. Tab moves between panes and actions, Ctrl+U/Ctrl+D scroll, Ctrl+O switches plan/chat, and Ctrl+E expands tool output.

Lane commands act on that planner's session: `/login`, `/model`, `/thinking` (or `/effort`), `/compact`, `/context` (or `/usage`), `/copy`, and `/help`. Model and effort changes wait until it is idle. Start a message with `//` when you want literal leading-slash text instead of a lane command.

## Review and implement

With two planners, **M is your existing main agent**, not a third isolated planner. Every submitted plan and revision is delivered to the main conversation. That delivery does not itself start a main-agent turn. You can discuss the plans with M while the planners are still researching.

While the run is active, M has two tools:

- `plan_ask_planner` asks A or B about its research.
- `plan_submit_merged` records a combined or adjusted proposal as plan M.

The **Write plan M** and **Revise plan M** actions request that synthesis for you. Planner-internal tools are separate: `plan_mode_question` asks in-lane questions, `plan_mode_complete` submits plan versions, and `plan_subagents` starts research helpers.

Choose **Implement A**, **Implement B**, or **Implement M** to review the implementation model, effort, and context before starting. Context can keep this conversation plus the plan, or start a fresh session with only the plan. `implementationModelMap` supplies defaults based on the model that authored the plan; otherwise the main session's model is used.

Export actions write the selected plan to Markdown without initiating implementation. **Add a planner** can add the second opinion without discarding the first planner's research.

## Settings and trusted capabilities

Settings normally live at `~/.pi/agent/pi-plan-mode.json`. Common options are editable in the Settings step. This example chooses manual tool selection and a shorter planner-turn limit without assuming particular model IDs:

```json
{
  "plannerTimeoutSeconds": 900,
  "jevToolSelection": false,
  "alwaysOffer": [],
  "defaultImplementationContext": "keep",
  "defaultPlanExportPath": "PLAN.md",
  "toggleShortcut": "shift+tab"
}
```

Choose available models in the UI, or configure `planners`, `scoutModelMap`, and `implementationModelMap` using `provider/modelId` specifications with optional effort suffixes. `plannerToolsets` groups extension tools, `commandGrants` permits specified extra commands with associated skills, and `providerExtensions` controls helper authentication support. Shortcut changes take effect after `/reload`.

Jev defaults to provider `typesafe`, model `jev-latest`, and selection threshold `0.5`. Default `alwaysOffer` names are `web`, `web_search`, `fetch_content`, `context7`, and `jev`; this neither installs those tools nor provides their credentials.

`planCompleteCommand` is an optional command argument array invoked on implementation or export. It receives hook-shaped JSON on stdin including `tool_input.plan`, `tool_response.filePath`, and `model`. Treat it as executable automation, not passive configuration.

Invalid settings fall back to defaults and are not overwritten. Saves support symlinked settings and preserve unknown fields. The [detailed settings reference](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-plan-mode/docs/settings.md) explains advanced shell-policy configuration.

## Safety boundaries and persistence

Planner sessions omit edit/write tools, restrict shell commands through a reviewed policy, and limit MCP access to selected tools. This reduces accidental mutation; it is not an operating-system sandbox. Selected extension tools and configured commands still run with Pi's permissions, and reading repository files can expose sensitive data to the chosen provider.

In particular, `safeSubcommands` fully trusts matching command prefixes and bypasses checking of the **entire submitted shell command**, including trailing chains and redirects. Do not use it as a harmless read-only allowlist. Even default Git inspection can invoke configured helpers unless the relevant negative flags suppress them.

M is only instructed to leave files alone during planning; it is not constrained by the planners' read-only tool policy. Implementation and exports intentionally write files.

Esc offers Hide, Stop planning, or Back. Hiding leaves planners running; `/plan` reopens the screen. Sessions under `~/.pi/agent/plan-mode/planners/` retain research across reload or resume, and interrupted or failed turns can resume automatically. Remember that resumed work can incur further usage.

## Optional integrations and next checks

Web tools, MCP servers, classifier selection, and completion hooks are optional. With pi-herdr, planner work emits `herdr:working` holds for background visibility; without it, planning still works. Use pi-diff-review after implementation to inspect the actual changes rather than treating an accepted plan as proof of correct execution.

See [planning and review](/recipes/plan-review/), [activity architecture](/architecture/activity/), and [troubleshooting](/guides/troubleshooting/). [Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-plan-mode) cover planner flow, shell policy, persistence, and implementation handoff.
