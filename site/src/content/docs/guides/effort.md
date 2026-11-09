---
title: Choosing effort
description: How task and phase boundaries choose reasoning effort, how quota pressure affects automatic choices, and how manual choices take precedence.
---

Model and reasoning effort are separate choices. Automatic recommendations are made at selection boundaries, not continuously during a conversation. A manual effort choice governs the current phase or run; a later genuine boundary can recommend a new level. Ordinary prompts, tool turns, errors and telemetry refreshes do not trigger effort selection.

## Boundaries

| Boundary | Effort behavior |
| --- | --- |
| New subagent task or batch | Select open model and effort fields before scheduling; queued launches and chain items retain those selections. Resume, steering and retries retain the selected tuple. |
| Enter plan mode with a plan model pair selected | Recommend effort once for the planner and apply it with your next message, unless you changed the level since entering plan mode. |
| Approve a plan | Recommend effort for the worker (the pair's worker model, or the session model without a pair) in the picker's effort row; the approved level is applied without a second judgment. The approval default rates implementation after the settled design; Left/Right overrides it. |
| Restore, reload, tree navigation or reconciliation | Restore native saved effort, without quota reads or effort classification. |

Explicit subagent arguments and authored agent-profile effort pins win for their fields; built-in role levels are suggestions, not pins. A pinned destination skips automatic effort selection. Manual approval changes override recommendations and configured defaults. Approval applies to that execution, not saved defaults. Unsupported levels are clamped to the destination model's capabilities; a non-reasoning model has no effort adjustment. Native thinking controls remain available. See [plan mode](/plugins/pi-plan-mode/) and [subagent models](/guides/subagent-models/).

## Quota at selection time

When an automatic model tier or effort needs a choice, the selection can read a quota snapshot for the execution target. Tier and effort are judged independently. The classifier receives task evidence, not quota evidence. The recommendation uses the highest option whose cumulative probability at that level or above reaches `theta = 0.5 + (0.85 - 0.5) * p` by default; `p` is 0, 0.5 or 1 for none, caution or critical pressure. Higher pressure raises the bar for stronger automatic choices, without changing explicit fields or subagent concurrency. The retained tracker uses usage and forecast thresholds, warmup, reset and confirmation; it is assessed on selection snapshots, not on a timer.

Pressure applies only to verified OAuth physical chat routes for Anthropic at `api.anthropic.com` and legacy `openai-codex` at `chatgpt.com/backend-api`. It is scoped to the account and target: automatic tier selection uses shared windows, while a fixed model's automatic effort can also use matching family windows. A different family's limit does not apply. Physical `openai` models are not treated as Codex. Unsupported routes are not applicable; missing, stale, failed or reset-due readings are unavailable. These cases use neutral numeric pressure, not a claim of healthy or unlimited quota. Footer quota telemetry is observational and separate from selection; the waterfall's eligibility policy is separate too.

Configure the `limits` object in `quota-pressure.json` in these scopes, lowest to highest: `$XDG_CONFIG_HOME/agents` (default `~/.config/agents`), `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`), `<cwd>/.agents`, `<cwd>/.pi`. At each scope the legacy `auto-effort.json` `limits` section is applied first, then `quota-pressure.json`. Invalid or unreadable values leave lower-precedence settings intact. Set `limits.enabled` to `false` to disable pressure reads. Legacy auto-effort classifier, bounds, enable and mid-run controls no longer control selection.

If classification fails or has no usable task evidence, existing configured or role fallbacks apply; unavailable quota does not become a healthy reading. Classifier requests can be billed and can send task and conversation excerpts to the configured [System 1](/plugins/pi-system1/) provider. They follow its configured fallback chain.

## Cache-safe deliberate changes

[Cache guard](/plugins/pi-cache-guard/) owns `configuration_update` transport for supported allowlisted models. It preserves deliberate manual and phase changes in request history; it does not choose effort. The transport works independently of cache-warning state and explicit `--thinking`. Configure `effortUpdates.enabled` and `effortUpdates.models` in `cache-guard.json`; the legacy `auto-effort.json` section is read first at each scope. Existing legacy session entries remain readable. Rewriting is restricted to matching allowlisted physical provider/models; it is not a promise of cache reuse.
