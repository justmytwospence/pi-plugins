---
title: Auto effort
description: Adjust reasoning effort to the task while respecting your manual ceiling and subscription pressure.
plugin: pi-auto-effort
---

## Quick reference

- **Use it for:** Adapt reasoning to task difficulty within your manual ceiling or a fixed range; optionally pick a model tier while the cache is cold.
- **Enable:** Select `packages/pi-auto-effort/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/auto-effort` status/limits/on/off, `bounds ceiling|free`, `models off|suggest|auto`. No global shortcut; stock thinking controls remain Pi's.
- **Settings:** `auto-effort.json` shared/user/project layers; low floor, ceiling bounds, threshold 0.35 to 0.85 with pressure, 1500 ms Jev timeout, mid-run checks normally every 3 tool turns, model choice off.
- **Requirements, cost & privacy:** Optional paid Jev sees request/activity excerpts; unavailable judgments keep the level. Provider quota reads use credentials; reasoning and model changes affect cost/latency.
- **Integrations & limits:** Optional footer; optional pi-cache-guard `cache:state` input; publishes `quota:pressure`. `--thinking` disables assessment. Explicit effort-update rewriting has its own switch; `/auto-effort off` does not disable it.

Auto effort changes the thinking level on the model you selected. It chooses a different model only if you turn model choice on, and then only within the same provider and while a switch is cheap. Use it when a session alternates between routine edits and difficult reasoning, but you still want a manual upper bound.

## Enable and requirements

Follow [Install & select](/guides/install/) and select `packages/pi-auto-effort/src/index.ts`. The suite loads every entry by default and uses one Git pin for every selected entry.

Jev classification requires Pi 0.99 or newer and classifier credentials managed by Pi. The default is `typesafe/jev-latest`, using `TYPESAFE_API_KEY`. The suite's tested Pi version is documented in the installation guide; this component's classifier minimum is not a suite-wide compatibility promise.

**Jev requests are paid external model calls**, separate from your main model's work. Expect one assessment before a nonempty prompt and additional assessments during supported long runs. The configured timeout is 1,500 ms, not a promised response time. Reasoning changes can also change main-model cost and latency; savings are not guaranteed.

## How decisions work

Jev answers which of `low`, `medium`, `high` and `xhigh` the request needs, as a probability for each. `need(L)` is the probability that the work needs at least L. The level is the highest one within the bounds whose need is at least the threshold θ, else the floor. θ is `policy.threshold.relaxed` (0.35) with no subscription pressure, `tight` (0.85) at critical pressure, and halfway between at caution, so under pressure only work Jev is surer about gets higher levels. The level goes up as soon as a higher level clears θ, but goes down only once the current level's need is below θ minus `policy.hysteresis` (0.1), which keeps borderline answers from flip-flopping. Short acknowledgements keep the existing level.

`policy.bounds` sets the range. With `ceiling` (the default), your latest manual thinking selection is the ceiling. With `free` (or `/auto-effort bounds free` for one session), any level from the floor to `policy.max` (`xhigh`) is allowed, and a manual selection sets the level now without capping later ones. The default floor is `low`; selections below it, such as `off` and `minimal`, are left alone, and the policy never picks `max`. Starting Pi with `--thinking` disables automatic assessment, including for explicitly configured subagents. Turning auto effort off restores your manual level.

The smoothing settings of earlier versions (`policy.mode`, `alpha`, `margin`, `jump`, `jumpConfidence`, `minDwell`, `minConfidence`) and `limits.steps` are ignored.

Mid-run checks normally happen every three tool turns, or after a turn containing a failed tool call. They require Pi's `compat.supportsMidConvoEffort` capability or an explicitly allowed model. Other models change only at new prompts, avoiding effort changes on tool follow-ups that could invalidate the cached prefix.

The current `effortUpdates.models` defaults are `openai-codex/gpt-6-astra` and `openai-codex/gpt-6.1-sol`. For those entries, the extension keeps request-level effort stable and inserts `configuration_update` items for later changes. This rewriting remains active even with `/auto-effort off`; disable `effortUpdates.enabled` separately to stop it. Treat the list as implementation configuration, not a guarantee about every provider exposing similarly named models.

## Model choice

Model choice is off by default. With `models.mode` set to `suggest` or `auto` (or `/auto-effort models suggest|auto` for one session) and `models.tiers` mapping the current provider to `fast`, `balanced` and `strong` models, the same Jev request also chooses a tier, by the same threshold rule. It is considered only before a message you send and only when a switch is cheap: the session's first message, a cold prompt cache (from pi-cache-guard's `cache:state` event when it is loaded, otherwise estimated from the time since the last answer and the model's cache lifetime), or a context under `models.maxSwitchTokens` (30,000 tokens). The provider never changes.

`suggest` shows a notice with the `/model` command to run; `auto` switches the session's model and marks the status with `≈` and the model's short id. The model you pick by hand is remembered: `auto` returns to it when its tier is picked with the cache cold, and with ceiling bounds never picks a tier above it (a model outside the tier map counts as strong). `/auto-effort off` returns to it.

```json
{
  "models": {
    "mode": "suggest",
    "tiers": {
      "anthropic": {
        "fast": "anthropic/claude-haiku-4-5",
        "balanced": "anthropic/claude-sonnet-4-5",
        "strong": "anthropic/claude-opus-4-5"
      }
    }
  }
}
```

## Commands and configuration

| Command | Effect |
| --- | --- |
| `/auto-effort` or `/auto-effort status` | Show level, bounds, the last need and θ, model choice and limits. |
| `/auto-effort limits` | Inspect usage windows and forecasts. |
| `/auto-effort on` | Enable automatic effort for this session, subject to settings and `--thinking`. |
| `/auto-effort off` | Disable it for this session and restore your manual level and model. |
| `/auto-effort bounds ceiling` / `free` | Set the bounds for this session. |
| `/auto-effort models off` / `suggest` / `auto` | Set model choice for this session. |

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

A caution tier raises θ halfway toward its tight value; critical raises it all the way. The level never goes below the floor. Absolute utilization and forecasts contribute, with confirmation and recovery hysteresis. Pressure only moves θ, so the level recovers at the next assessment once it clears.

After each assessment auto effort emits a `quota:pressure` event on Pi's extension event bus with `{ provider, tier, p, label? }` (`p` is 0, 0.5 or 1; `label` like `5h caution`). Other extensions, such as [Subagents](/plugins/pi-subagents/), can use it to economize under pressure. It carries no usage figures or credentials.

## Fallbacks and optional integrations

Missing credentials, timeouts or unusable classifier answers provide no new difficulty judgment, and the level and model stay as they are. `/auto-effort status` helps distinguish those cases. Decision records are custom session entries, excluded from model context.

No sibling is required. [Status footer](/plugins/pi-status-footer/) folds effort status into its model row; the status reads like `effort: medium (auto ↑ ≤high)`, with an up-down arrow instead of `≤high` in free bounds. [Cache guard](/plugins/pi-cache-guard/) tells model choice when the cache is cold. Manual changes from another extension, such as plan mode, also establish a ceiling. Unsupported model levels remain subject to Pi's own model capabilities.

For configuration or interaction problems, use [Troubleshooting](/guides/troubleshooting/). Review the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-auto-effort) for the exact policy and capability checks.
