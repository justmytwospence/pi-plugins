---
title: External integrations
description: Which capabilities the suite owns, which specialist packages remain separate, and their permission boundaries.
---

The suite owns its core editor interactions: **Vim editing, prompt stash, sticky last prompt and side conversations**. It also owns Claude Code-style transcript rendering, Markdown extras, `/context` and [logical task tracking](/plugins/pi-todo/) through `todo` and `/todos`. Their upstream MIT attribution and import provenance remain with each component. Owning the integration does not mean replacing the mature Vim motion engine with a handful of mappings.

Four previously used third-party packages remain external. They are optional, not bundled suite requirements. The versions below are the audit baseline, not upgrade instructions.

| Package | Baseline | Why it stays separate |
| --- | --- | --- |
| `pi-web-access` | 0.33.0 | Search providers, extraction, browser credentials, media, SSRF protection and stored results |
| `@gotgenes/pi-anthropic-auth` | 3.3.2 | Billing-sensitive authentication and request compatibility |
| `pi-autoresearch` | 1.8.1 | Specialized experiments, benchmarks, checks, rollback and dashboards |
| `@earendil-works/pi-radius` | 0.1.19 | A deprecated connector; migration to native/MCP routing is a separate task |

## Absorbed: rpiv-todo

`@juicesharp/rpiv-todo` 2.12.0 is now [pi-todo](/plugins/pi-todo/), imported with upstream history and MIT attribution at original commit `7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f`. Disable the upstream npm entry before selecting `packages/pi-todo/index.ts`. The `todo` tool, `/todos` command and upstream session identities stay compatible; global/project `pi-todo.json` settings take over with legacy rpiv-todo config fallbacks. The hard rpiv-config dependency is removed; rpiv-i18n is still optional, with English fallback. No private keyboard profile is required.

## Superseded: pi-cc-extensions

`pi-cc-extensions` (MIT, minuque) is no longer recommended. Its useful parts from version 0.9.10 were ported into suite components, with upstream attribution kept in each ported component's `LICENSE`; a few features map to existing or newly written suite features instead:

| Former feature | Suite component |
| --- | --- |
| Tool cards, grouping, rich diffs, compact thinking, turn summary, startup header, mouse support, `/ccstyle`, `cc-dark`/`cc-light` themes | [pi-cc-render](/plugins/pi-cc-render/) |
| Mermaid dialects, admonitions, circled numbers, multi-line link cleanup | [pi-markdown-extras](/plugins/pi-markdown-extras/) |
| `/context` | [pi-context](/plugins/pi-context/) |
| Working message statistics and MCP status | [pi-status-footer](/plugins/pi-status-footer/) |
| Subagent `@` references | `@subagent:` mentions and `@run:` references in [pi-subagents](/plugins/pi-subagents/) |
| `/clear` and `/exit` aliases | [pi-clear-screen](/plugins/pi-clear-screen/) |

**Do not enable pi-cc-extensions alongside pi-cc-render.** Both patch the same Pi components and register `/ccstyle`, and Pi does not deduplicate different packages. Remove it rather than disabling its features one by one. Its custom footer, bare-URL linkifier and references to other Pi sessions are deliberately not carried over; pi-subagents' mentions target its `subagent` tool rather than an `Agent` tool. pi-cc-render reads its own `~/.pi/agent/pi-cc-render.json`, not the old `pi-cc-extensions.json`.

To keep suite-owned interactive tool renderers, including pi-todo's `todo`, out of the Claude Code-style restyling, list them in `excludeRenderers` in `pi-cc-render.json`:

```json
{
  "excludeRenderers": [
    "ask_user_question", "subagent", "herdr_child",
    "bg_run", "bg_wait", "bg_logs", "bg_kill",
    "plan_mode_complete", "plan_subagents", "plan_ask_planner",
    "plan_mode_question", "plan_submit_merged", "exit_plan_mode", "todo"
  ]
}
```

Use the actual registered tool names for your selected revision; do not interpret a renderer exclusion as disabling a tool. [Logical `/todos`](/plugins/pi-todo/) remain distinct from the process activity inventory in `/tasks`.

## Credentials and permission boundaries

Provider authentication is not a quota service. Footer quota readings can use different accounts or credentials from effort control; do not combine them or imply they identify the same account.

Planner extension selections are explicit capability grants, not a guarantee that every granted tool is read-only. Parent/planner extension isolation must be tested with fixtures, especially packages with module-level state. A side conversation does not silently inherit every parent extension or its tool-gate protection. BTW ask mode has a structurally restricted toolset; normal side sessions have their own permission boundary.

Tool-gate is approval assistance, **not a sandbox**. Ambiguous shell commands leave the read-only fast path for its normal judgment/approval policy. The existing classifier-unavailable headless behavior fails open; do not rely on it to enforce a security boundary.

## Autoresearch and deprecated routing

Autoresearch can stage all working-tree changes when keeping an experiment and revert or clean unrelated changes when discarding one. Do not run experiments casually in a shared dirty checkout. Routine suite verification does not run live experiments or paid evaluations.

The installed Radius connector announces deprecation in favor of Radius MCP. This change does not remove it, rewrite routing, or assume equivalent search/API behavior. That migration requires separate parity checks and authorization.

Vendor-generated Herdr and Orca hooks remain vendor-owned. Separately maintained tmux-agent and billing-guard projects, local plugins and non-Pi ports also remain outside the suite. Consolidation is not a reason to absorb them or silently upgrade packages.
