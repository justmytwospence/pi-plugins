---
title: Auto effort
description: Adjust reasoning effort and the model tier to the task, within your bounds and subscription pressure.
plugin: pi-auto-effort
---

## Quick reference

- **Use it for:** Adapt reasoning to task difficulty within a fixed range or your manual ceiling, and pick a model tier of the same provider: cheaper only while the cache is cold, back up to your own model whenever the work needs it.
- **Enable:** Select `packages/pi-auto-effort/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/auto-effort` status/limits/on/off, `bounds free|ceiling`, `models off|auto`. No global shortcut; stock thinking controls remain Pi's.
- **Settings:** `auto-effort.json` shared/user/project layers; low floor, free bounds up to xhigh, threshold 0.5 to 0.85 with pressure, 1500 ms Jev timeout, mid-run checks normally every 3 tool turns, model choice on with Sonnet/Opus and Terra/Sol presets.
- **Requirements, cost & privacy:** Optional paid Jev sees request/activity excerpts; unavailable judgments keep the level. Provider quota reads use credentials; reasoning and model changes affect cost/latency.
- **Integrations & limits:** Optional footer; optional pi-cache-guard `cache:state` input and model offers in its cold-cache dialog; publishes `quota:pressure`. `--thinking` disables assessment. Explicit effort-update rewriting has its own switch; `/auto-effort off` does not disable it.

Auto effort changes the thinking level, and by default the model within the same provider: a cheaper tier only while a switch is cheap, and back up to the model you chose whenever the work needs it (never above it automatically). Use it when a session alternates between routine edits and difficult reasoning. Set `models.mode` to `off` to keep the model you selected, and `policy.bounds` to `ceiling` to keep a manual upper bound on effort.

## Enable and requirements

Follow [Install & select](/guides/install/) and select `packages/pi-auto-effort/src/index.ts`. The suite loads every entry by default and uses one Git pin for every selected entry.

Jev classification requires Pi 0.99 or newer and classifier credentials managed by Pi. The default is `typesafe/jev-latest`, using `TYPESAFE_API_KEY`. The suite's tested Pi version is documented in the installation guide; this component's classifier minimum is not a suite-wide compatibility promise.

**Jev requests are paid external model calls**, separate from your main model's work. Expect one assessment before a nonempty prompt and additional assessments during supported long runs. The configured timeout is 1,500 ms, not a promised response time. Reasoning changes can also change main-model cost and latency; savings are not guaranteed.

## How decisions work

Jev answers which of `low`, `medium`, `high` and `xhigh` the request needs, as a probability for each. `need(L)` is the probability that the work needs at least L. The level is the highest one within the bounds whose need is at least the threshold θ, else the floor. θ is `policy.threshold.relaxed` (0.5, the median of Jev's distribution, biased neither up nor down) with no subscription pressure, `tight` (0.85) at critical pressure, and halfway between at caution, so under pressure only work Jev is surer about gets higher levels. The level goes up as soon as a higher level clears θ, but goes down only once the current level's need is below θ minus `policy.hysteresis` (0.1), which keeps borderline answers from flip-flopping. Short acknowledgements keep the existing level.

`policy.bounds` sets the range. With `free` (the default), any level from the floor to `policy.max` (`xhigh`) is allowed, and a manual selection sets the level now without capping later ones. With `ceiling` (or `/auto-effort bounds ceiling` for one session), your latest manual thinking selection is the ceiling. The default floor is `low`; selections below it, such as `off` and `minimal`, are left alone, and the policy never picks `max`. Starting Pi with `--thinking` disables automatic assessment, including for explicitly configured subagents. Turning auto effort off restores your manual level.

The smoothing settings of earlier versions (`policy.mode`, `alpha`, `margin`, `jump`, `jumpConfidence`, `minDwell`, `minConfidence`) and `limits.steps` are ignored.

Mid-run checks normally happen every three tool turns, or after a turn containing a failed tool call. They require Pi's `compat.supportsMidConvoEffort` capability or an explicitly allowed model. Other models change only at new prompts, avoiding effort changes on tool follow-ups that could invalidate the cached prefix.

The current `effortUpdates.models` defaults are `openai-codex/gpt-6-astra`, `openai-codex/gpt-6.1-sol` and `openai-codex/gpt-6.1-terra`. For those entries, the extension keeps request-level effort stable and inserts `configuration_update` items for later changes. This rewriting remains active even with `/auto-effort off`; disable `effortUpdates.enabled` separately to stop it. Treat the list as implementation configuration, not a guarantee about every provider exposing similarly named models.

## Model choice

Model choice is on by default (`models.mode` `auto`; `off`, or `/auto-effort models off` for one session, keeps your model). The same Jev request also chooses a tier of the current provider, by the same threshold rule; the provider never changes. A provider without a `models.tiers` entry gets a built-in preset, resolved from the models Pi has credentials for:

| Provider | balanced | strong |
| --- | --- | --- |
| `anthropic` | newest `claude-sonnet-*` | newest `claude-opus-*` |
| `openai-codex` | newest `*-terra` | newest `*-sol` |

Newest is a numeric-aware sort of the id, skipping dated snapshots (`-20250929`) when an undated alias exists. There is no `fast` tier in the presets. A `models.tiers` entry for a provider replaces its preset, and an empty entry turns model choice off for that provider.

A switch re-sends the conversation without a cached prefix, so the two directions differ, and both happen only before a message you send:

- **Down** to a cheaper tier only while a switch is cheap: the session's first message, a cold prompt cache (from pi-cache-guard's `cache:state` event when it is loaded, otherwise estimated from the last answer or Pi cache-warming refresh and the model's cache lifetime), or a context under `models.maxSwitchTokens` (30,000 tokens).
- **Up** to a stronger tier, including back to your own model, on any message where the rule picks it, accepting one cache rewrite.

An auto switch marks the status with `≈` and the model's short id. The model you pick by hand is remembered and never replaced by an auto pick: auto returns to it when its tier is picked, `/auto-effort off` returns to it, and no automatic pick goes above it, whatever the effort bounds (a model another extension set, such as plan mode's implementation model, counts as yours). Model choice is off when Pi was started with `--model`.

```json
{
  "models": {
    "mode": "auto",
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

### In pi-cache-guard's cold-cache dialog

When [Cache guard](/plugins/pi-cache-guard/) holds a prompt because the cache is cold, it emits `cache:model-offers` with `{ text, tokens, offers }` and awaits the promises listeners push onto `offers`. Auto effort, when it is on with model choice `auto` and two or more tiers, assesses the prompt, and offers every other tier's model, stronger ones too since you choose, as `{ model, label, recommended?, note? }`, recommending Jev's pick (either direction, since the cache is cold anyway) when it differs from the current model. After the dialog, cache guard emits `cache:model-choice` with `{ text, model }`: the chosen `provider/id`, or `null` when you send on the current model, compact, start fresh or keep the prompt. Auto effort applies that choice to the prompt with the same text, switching as an auto pick or staying, and makes no model choice of its own for it; the effort level is still set, from the dialog's assessment rather than a second Jev request. A choice for another text is discarded.

## Commands and configuration

| Command | Effect |
| --- | --- |
| `/auto-effort` or `/auto-effort status` | Show level, bounds, the last need and θ, model choice and limits. |
| `/auto-effort limits` | Inspect usage windows and forecasts. |
| `/auto-effort on` | Enable automatic effort for this session, subject to settings and `--thinking`. |
| `/auto-effort off` | Disable it for this session and restore your manual level and model. |
| `/auto-effort bounds free` / `ceiling` | Set the bounds for this session. |
| `/auto-effort models off` / `auto` | Set model choice for this session. |

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

A caution tier raises θ halfway toward its tight value; critical raises it all the way. Caution starts at 60% used or a forecast of 90% used within 90% of the time to reset; critical at 80% used, a forecast of 120% at the reset, or an hour before the window runs out. The level never goes below the floor. Absolute utilization and forecasts contribute, with confirmation and recovery hysteresis. Pressure only moves θ, never forcing a step down by itself, so the level recovers at the next assessment once it clears.

After each assessment auto effort emits a `quota:pressure` event on Pi's extension event bus with `{ provider, tier, p, label? }` (`p` is 0, 0.5 or 1; `label` like `5h caution`). Other extensions, such as [Subagents](/plugins/pi-subagents/), can use it to economize under pressure. It carries no usage figures or credentials.

## Fallbacks and optional integrations

Missing credentials, timeouts or unusable classifier answers provide no new difficulty judgment, and the level and model stay as they are. `/auto-effort status` helps distinguish those cases. Decision records are custom session entries, excluded from model context.

No sibling is required. [Status footer](/plugins/pi-status-footer/) folds effort status into its model row; the status reads like `effort: medium (auto ↑ free)`, with `≤high` (your manual level) instead of `free` in ceiling bounds. [Cache guard](/plugins/pi-cache-guard/) tells model choice when the cache is cold and offers its models in the cold-cache dialog. Manual changes from another extension, such as plan mode, count like your own (a ceiling in ceiling bounds, and always the model ceiling). Unsupported model levels remain subject to Pi's own model capabilities.

For configuration or interaction problems, use [Troubleshooting](/guides/troubleshooting/). Review the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-auto-effort) for the exact policy and capability checks.
