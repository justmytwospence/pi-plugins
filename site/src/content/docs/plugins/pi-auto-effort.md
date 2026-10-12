---
title: Auto effort
description: Adjust reasoning effort to the task while respecting your manual ceiling and subscription pressure.
plugin: pi-auto-effort
---

Auto effort changes the thinking level on the model you selected; it does not choose a different model. Use it when a session alternates between routine edits and difficult reasoning, but you still want a manual upper bound.

## Enable and requirements

Follow [Install & select](/guides/install/) and select `packages/pi-auto-effort/src/index.ts`. The suite loads every entry by default and uses one Git pin for every selected entry.

Jev classification requires Pi 0.99 or newer and classifier credentials managed by Pi. The default is `typesafe/jev-latest`, using `TYPESAFE_API_KEY`. The suite's tested Pi version is documented in the installation guide; this component's classifier minimum is not a suite-wide compatibility promise.

**Jev requests are paid external model calls**, separate from your main model's work. Expect one assessment before a nonempty prompt and additional assessments during supported long runs. The configured timeout is 1,500 ms, not a promised response time. Reasoning changes can also change main-model cost and latency; savings are not guaranteed.

## How decisions work

Jev rates difficulty from zero to three, corresponding to `low`, `medium`, `high` and `xhigh`. A running average, movement margin and minimum dwell keep small differences from constantly changing the level. A confident large increase can bypass gradual movement. Short acknowledgements keep the existing policy level.

Your latest manual thinking selection becomes the ceiling. The default floor is `low`; selections below it, such as `off` and `minimal`, are left alone. Starting Pi with `--thinking` disables automatic assessment, including for explicitly configured subagents. Turning auto effort off restores the manual ceiling.

Mid-run checks normally happen every three tool turns, or after a turn containing a failed tool call. They require Pi's `compat.supportsMidConvoEffort` capability or an explicitly allowed model. Other models change only at new prompts, avoiding effort changes on tool follow-ups that could invalidate the cached prefix.

The current `effortUpdates.models` defaults are `openai-codex/gpt-6-astra` and `openai-codex/gpt-6.1-sol`. For those entries, the extension keeps request-level effort stable and inserts `configuration_update` items for later changes. This rewriting remains active even with `/auto-effort off`; disable `effortUpdates.enabled` separately to stop it. Treat the list as implementation configuration, not a guarantee about every provider exposing similarly named models.

## Commands and configuration

| Command | Effect |
| --- | --- |
| `/auto-effort` or `/auto-effort status` | Show level, ceiling, average, last decision and limits. |
| `/auto-effort limits` | Inspect usage windows and forecasts. |
| `/auto-effort on` | Enable automatic effort for this session, subject to settings and `--thinking`. |
| `/auto-effort off` | Disable it for this session and restore the ceiling. |

Configuration merges in this order: `~/.config/agents/auto-effort.json`, `~/.pi/agent/auto-effort.json`, `<project>/.agents/auto-effort.json`, then `<project>/.pi/auto-effort.json`. `$XDG_CONFIG_HOME` relocates the shared user directory. Objects merge; other values replace earlier ones.

For example, this project `.pi/auto-effort.json` keeps prompt assessments but disables mid-run assessments and subscription-pressure reductions:

```json
{
  "enabled": true,
  "jev": {
    "enabled": true,
    "provider": "typesafe",
    "model": "jev-latest",
    "timeoutMs": 1500
  },
  "midRun": { "enabled": false },
  "limits": { "enabled": false }
}
```

Adding `provider/id` globs to `midRun.models` opts extra models into mid-run changes; do not assume those overrides preserve caching. See [Cache and cost](/recipes/cache-cost/).

## Data sent and subscription limits

Prompt assessments send Jev clipped text from the current request, two earlier requests, the previous answer, and counts of tool calls, edits and errors. Mid-run assessments send the starting request, the last six assistant steps by default, abbreviated tool arguments and failure text. These excerpts can contain private project information.

Limits use Anthropic subscription response headers or a background request to `https://chatgpt.com/backend-api/wham/usage` authenticated with Pi's Codex credential. Quota readings stay in memory and are not sent to Jev or the main model. Anthropic API-key token-bucket headers do not trigger subscription reductions.

A caution tier reduces the policy choice by one level; critical reduces it by two, without going below the floor. Absolute utilization and forecasts contribute, with confirmation and recovery hysteresis. The underlying policy baseline is retained so pressure does not permanently lower it.

## Fallbacks and optional integrations

Missing credentials, timeouts or unusable classifier answers provide no new difficulty judgment. The policy keeps its baseline; the separate limits stage can still apply available quota pressure. `/auto-effort status` helps distinguish those cases. Decision records are custom session entries, excluded from model context.

No sibling is required. [Status footer](/plugins/pi-status-footer/) folds effort status into its model row. Manual changes from another extension, such as plan mode, also establish a ceiling. Unsupported model levels remain subject to Pi's own model capabilities.

For configuration or interaction problems, use [Troubleshooting](/guides/troubleshooting/). Review the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-auto-effort) for the exact policy and capability checks.
