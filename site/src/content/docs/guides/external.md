---
title: External integrations
description: Which capabilities the suite owns, which specialist packages remain separate, and their permission boundaries.
---

The suite owns its core editor interactions: **Vim editing, prompt stash, sticky last prompt and side conversations**. Their upstream MIT attribution and import provenance remain with each component. Owning the integration does not mean replacing the mature Vim motion engine with a handful of mappings.

Six previously used third-party packages remain external. They are optional, not bundled suite requirements. The versions below are the audit baseline, not upgrade instructions.

| Package | Baseline | Why it stays separate |
| --- | --- | --- |
| `pi-cc-extensions` | 0.9.7 | Broad native-tool rendering, inline diffs, Markdown, thinking presentation, references and `/context` |
| `@juicesharp/rpiv-todo` | 2.12.0 | A persistent logical task state machine with dependencies, checklist UI and `todo` tool |
| `pi-web-access` | 0.33.0 | Search providers, extraction, browser credentials, media, SSRF protection and stored results |
| `@gotgenes/pi-anthropic-auth` | 3.3.2 | Billing-sensitive authentication and request compatibility |
| `pi-autoresearch` | 1.8.1 | Specialized experiments, benchmarks, checks, rollback and dashboards |
| `@earendil-works/pi-radius` | 0.1.19 | A deprecated connector; migration to native/MCP routing is a separate task |

## Rendering and agent mentions

When using CC extensions, keep its custom footer disabled and exclude suite-owned tool renderers plus `todo`. This preserves the suite's interaction-specific rendering while retaining CC's native-tool and Markdown features. Merge these settings into the existing `pi-cc-extensions.json`:

```json
{
  "enableCustomFooter": false,
  "enableSubagentAutocomplete": false,
  "excludeRenderers": [
    "ask_user_question", "subagent", "herdr_child",
    "bg_run", "bg_wait", "bg_logs", "bg_kill",
    "plan_mode_complete", "plan_subagents", "plan_ask_planner",
    "plan_mode_question", "plan_submit_merged", "todo"
  ]
}
```

Use the actual registered tool names for your selected revision; do not interpret a renderer exclusion as disabling a tool. The managed personal profile checks this list against the suite source.

CC's subagent reference feature produces guidance for an `Agent` tool with `subagent_type`. The suite uses `subagent({agent: ...})` instead. Its own agent mention/completion integration uses built-in, user and project agent discovery and does not require CC. Logical `/todos` remain distinct from the process activity inventory in `/tasks`.

## Credentials and permission boundaries

Provider authentication is not a quota service. Footer quota readings can use different accounts or credentials from effort control; do not combine them or imply they identify the same account.

Planner extension selections are explicit capability grants, not a guarantee that every granted tool is read-only. Parent/planner extension isolation must be tested with fixtures, especially packages with module-level state. A side conversation does not silently inherit every parent extension or its tool-gate protection. BTW ask mode has a structurally restricted toolset; normal side sessions have their own permission boundary.

Tool-gate is approval assistance, **not a sandbox**. Ambiguous shell commands leave the read-only fast path for its normal judgment/approval policy. The existing classifier-unavailable headless behavior fails open; do not rely on it to enforce a security boundary.

## Autoresearch and deprecated routing

Autoresearch can stage all working-tree changes when keeping an experiment and revert or clean unrelated changes when discarding one. Do not run experiments casually in a shared dirty checkout. Routine suite verification does not run live experiments or paid evaluations.

The installed Radius connector announces deprecation in favor of Radius MCP. This change does not remove it, rewrite routing, or assume equivalent search/API behavior. That migration requires separate parity checks and authorization.

Vendor-generated Herdr and Orca hooks remain vendor-owned. Separately maintained tmux-agent and billing-guard projects, local plugins and non-Pi ports also remain outside the suite. Consolidation is not a reason to absorb them or silently upgrade packages.
