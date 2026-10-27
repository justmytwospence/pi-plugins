# pi-auto-effort

A Pi extension that sets the thinking level for each message you send, on the model you chose, and between tool turns of a long run where the model allows it without losing the prompt cache. [Jev](https://docs.typesafe.ai), called through Pi's classifier models (`ctx.modelRegistry.classify`), rates how much careful reasoning the request needs before the turn starts; a running average keeps the level from flip-flopping, and your latest manual level is the ceiling. When a subscription window is on track to run out before it resets, it lowers the level one or two steps.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-auto-effort/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-auto-effort/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-auto-effort
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## How it works

Before each message you send, Jev scores the request:

| Score | Request | Level |
|---|---|---|
| 0 | a lookup, trivial answer, or mechanical change | low |
| 1 | a routine single-file change or clear question | medium |
| 2 | a multi-step change, debugging with clear symptoms, design in a known pattern | high |
| 3 | subtle design, cross-cutting refactor, hard debugging, correctness-critical work | xhigh |

Jev sees the request, the two before it, the last answer, and what the last run did (errors, files edited, tool calls). It also judges whether the message is a go-ahead.

**Smoothing.** A running average `e = alpha·score + (1 - alpha)·e_prev` (default alpha 0.5) moves the level up when it is at least `margin` (0.6) above it, and down when at least 0.6 below and the level has held for `minDwell` (2) assessments. A confident (`jumpConfidence` >= 0.6) score `jump` (1.5) or more above the level jumps straight to it. A go-ahead ("yes", "continue", "do it", above `ackThreshold` 0.7) keeps the level and leaves the average alone.

**Direct mode.** With `policy.mode` set to `direct` (or `/auto-effort direct` for the session), each assessment's score, rounded, is the level, with no running average, margin or dwell. A go-ahead keeps the level, as does a score Jev is less than `minConfidence` (0.45) sure of. On mid-run models (below) it re-rates after every tool turn instead of every `midRun.everyTurns`. The average exists to stop the level flip-flopping, which costs something only where a change loses the prompt cache, so on every other model `direct` stays `smoothed`. Each state entry records the mode in force, so a stretch of each can be compared (for example with pi-trends' per-call effort and token counts).

**Bounds.** Your latest manual level is the ceiling: any thinking-level change auto-effort did not make itself (`/thinking`, Pi's shortcut, a model switch that changes the level, or another extension such as plan mode). `policy.floor` (`low`) is the floor. Levels outside the managed range (`off`, `minimal`) are left alone, as is everything when the ceiling is below the floor. The policy never picks `max`; a `max` ceiling only caps it.

**Mid-run.** A long run can change what it needs: mechanical edits after a hard design step, or a debugging stretch in the middle of a routine change. On models that take an effort change mid-conversation without losing the prompt cache (those Pi marks with `compat.supportsMidConvoEffort`, the effort-update models below, and any `midRun.models` globs), Jev re-rates the work between tool turns: every `midRun.everyTurns` (3) tool turns, or at once after a turn with `midRun.errorTurns` (1) or more failed tool calls. It sees the request that started the run, the agent's last `midRun.steps` (6) steps (what it said, the tools it called, what failed) and counts for the run so far. The same average, dwell, ceiling, floor and limits apply (dwell counts these assessments too). The check runs after the tools finish and before the next request, adding one Jev call every few turns.

**Cache-safe.** On every other model the level changes only before a message you send, never on tool follow-ups, since changing the thinking settings there invalidates the cached conversation. `midRun.models` adds models by `provider/id` glob if you accept that cost.

Auto-effort is off when Pi was started with `--thinking` (so a subagent's explicit effort stays fixed). When Jev is unavailable it keeps the level (the limits stage still applies).

## Effort updates (Codex)

On OpenAI Responses models whose backend accepts a `configuration_update` input item, a change to the request's `reasoning.effort` starts a separate prompt cache, while the item changes effort from that point in the conversation. On the `effortUpdates.models` (default `openai-codex/gpt-6-astra` and `openai-codex/gpt-6.1-sol`, which the source records as verified live through the Codex subscription backend), auto-effort keeps the request's effort at the conversation's first value and turns every later change (its own, `/thinking`, or another extension's) into an item at the point it happened: after the latest tool result, or before your new message. Each item is replayed in place on later requests.

- An item is never added for a change back to the effort already in force there, and there is at most one item per position (the backend rejects adjacent items).
- A history rewritten under an item (compaction, a branch switch) starts a new baseline.
- Payloads that already carry `configuration_update` items, or whose effort is not `low` to `max`, are left alone.
- The positions are saved as an `auto-effort:effort-updates` session entry, so a resumed session keeps its cache.
- This works whether auto-effort is on or off (including with `--thinking`); only `effortUpdates.enabled` turns it off.

## Commands

- `/auto-effort` or `/auto-effort status`: current level, ceiling, floor, running average, dwell, last decision, the level without the limit when one applies, and the limits lines.
- `/auto-effort limits`: for each window of the current provider: use, elapsed share, projection, time to run out, reading age and tier.
- `/auto-effort on`, `/auto-effort off`: for this session. Off restores the ceiling and turns off limits too.
- `/auto-effort direct`, `/auto-effort smoothed`: the policy mode for this session, over `policy.mode`.

The status shows `effort: high (auto →)`, or `effort: medium (auto ↓, limited: 5h 84%)` while a limit is in force. The arrow is where the level is heading: ↑ or ↓ when the running average sits at least half the margin (0.3) above or below the policy's own level (before any limit cut) and the ceiling or floor leaves room to move that way, → when it is holding. ↑ or ↓ usually appears one assessment before a change, while the average builds toward the margin or a lower level waits out its dwell.

Each decision is an `auto-effort:state` session entry (never sent to the model; `phase` is `prompt` or `run`, `mode` is `smoothed` or `direct`), with the score, confidence, level, baseline and any limit. When a session starts or resumes, the state is restored from the latest such entry on the current branch.

## Limits

When an Anthropic or Codex subscription window (5h, weekly) is on track to run out before it resets, auto-effort lowers the thinking level one or two steps below what the request would otherwise get.

**Sources.** Anthropic subscription (OAuth) responses carry `anthropic-ratelimit-unified-5h-*` and `-7d-*` headers (utilization, reset, status), read in `after_provider_response`; an API key gets token-bucket headers instead, which are ignored, so it is never limited. Codex windows are read from `x-codex-primary-*` / `x-codex-secondary-*` response headers when present, and from `GET https://chatgpt.com/backend-api/wham/usage` (Pi's default WebSocket transport carries no `x-codex-*` headers). That endpoint is polled only while limits are on and a Codex model is in use, with the token and account Pi itself sends: at most every 5 minutes, one request at a time, 5 s timeout, in the background (a prompt never waits for it). A 429 waits for `Retry-After`, else 15 minutes doubling to an hour; other failures wait 5 minutes doubling to an hour; a 401/403 stops polling until the token changes. A change of Codex account drops the old account's readings.

**Privacy.** Only response headers and Pi's own Codex credential are used; no auth files are read, and the readings stay in process memory (nothing is shared between processes or written to disk). Quota data never reaches Jev or the model.

**When it lowers the effort.** Each window gets a tier:

| Tier | Effort | At once when | After a second assessment 5 minutes later when |
|---|---|---|---|
| caution | 1 level down | 75% used | the forecast runs out before 90% of the time to reset (warming up: projected 100% at reset) |
| critical | 2 levels down | 90% used, the provider reports it exceeded, or the forecast runs out within 30 minutes | projected 150% at reset |

The worst window wins, and there is one cut in total. The cut never goes below `policy.floor`. A tier lifts after two assessments 5 minutes apart with the projection at most 95% at reset (for critical, at most 145%) and use 5 points under the tier's threshold. A window that resets clears its tier at once. Assessments happen at your prompts (and mid-run checks), so an idle session changes nothing. A tier change is announced with a notification.

**The forecast.** Two rates from the window's history of readings: a recent one (the last hour, half-life 15 minutes; gaps over 30 minutes do not count) and a sustained one (the last 24 hours, half-life 6 hours), each weighting an interval by its length and recency. The recent burst decays toward the sustained rate over `tau = min(1 h, window / 5)`, and the forecast integrates that up to the reset: near a 5h reset a burst dominates, across a week it fades. Until a window has 3 readings spanning `min(1 h, window / 10)`, the linear pace (used divided by the fraction of the window elapsed, as in CodexBar) stands in, from 10% elapsed and 20% used. A reading older than 15 minutes still counts as a minimum (use only grows within a window) but not for the weighted forecast. A spend limit has no length, so only its absolute thresholds apply.

**Not feeding back.** The policy's own pick (the baseline) is kept apart from the level applied, so a limited stretch never drags the running average or the level down, and the baseline returns at the next assessment once the pressure clears.

## Configuration

Four files, read in this order, each merged on top of the last (objects merge key by key; other values replace only when the type matches, so a malformed field keeps the lower-precedence value; unreadable or invalid files are ignored):

1. `~/.config/agents/auto-effort.json` (`$XDG_CONFIG_HOME/agents/` if set)
2. `~/.pi/agent/auto-effort.json` (`$PI_CODING_AGENT_DIR/` if set)
3. `<project>/.agents/auto-effort.json`
4. `<project>/.pi/auto-effort.json`

The `agents` files are shared with the opencode and Claude Code ports of this plugin; the `.pi` files are Pi-only overrides. Keys a port does not know are ignored. Settings are reread at session start and before each message. Defaults:

```json
{
  "enabled": true,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 1500 },
  "policy": { "mode": "smoothed", "floor": "low", "alpha": 0.5, "margin": 0.6, "jump": 1.5, "jumpConfidence": 0.6, "minDwell": 2, "ackThreshold": 0.7, "minConfidence": 0.45 },
  "midRun": { "enabled": true, "everyTurns": 3, "errorTurns": 1, "steps": 6, "models": [] },
  "effortUpdates": { "enabled": true, "models": ["openai-codex/gpt-6-astra", "openai-codex/gpt-6.1-sol"] },
  "limits": {
    "enabled": true,
    "caution":  { "used": 0.75, "projected": 1.0 },
    "critical": { "used": 0.90, "projected": 1.5, "exhaustMinutes": 30 },
    "steps": { "caution": 1, "critical": 2 },
    "exitProjected": 0.95,
    "hysteresis": 0.05,
    "confirmMinutes": 5,
    "staleMinutes": 15,
    "warmup": { "readings": 3, "spanMinutes": 60, "minElapsed": 0.1, "minUsed": 0.2 },
    "recent": { "lookbackMinutes": 60, "halfLifeMinutes": 15 },
    "sustained": { "lookbackHours": 24, "halfLifeHours": 6 }
  }
}
```

- `policy.mode` is `smoothed` or `direct`; any other value is `smoothed`. `minConfidence` applies only to `direct`; `alpha`, `margin`, `jump`, `jumpConfidence` and `minDwell` only to `smoothed`.
- `midRun.errorTurns` is how many failed tool calls in one turn trigger an early check (0 = never). `midRun.models` and `effortUpdates.models` are `provider/id` globs (`*` matches anything).
- An invalid `limits`, `midRun` or `effortUpdates` value falls back to its default.
- `"limits": { "enabled": false }` in the shared file turns limits off for every port; `/auto-effort off` turns them off with the rest for the session.

## Requirements and costs

- Pi 0.99 or newer for classifier models, and a configured classifier model; Pi resolves the credentials (`TYPESAFE_API_KEY` for its `typesafe` provider). Without Jev the level is never raised or lowered by score.
- Each message you send makes one classifier request, and mid-run checks add one every few tool turns on supported models (every tool turn in `direct` mode: a run of N tool turns makes about 1 + N requests instead of 1 + N/3, each awaited before the next model request). These requests can be billed. Set `"enabled": false` or `"jev": { "enabled": false }` to stop them.
- With limits on and a Codex model in use, it makes background requests to `chatgpt.com/backend-api/wham/usage` with Pi's Codex credential.
- On disk it reads only the settings files above and writes nothing. In the session it appends `auto-effort:state` and `auto-effort:effort-updates` custom entries (never sent to the model).

## Optional integrations

- pi-status-footer renders the `auto-effort` status as `reasoning high (auto ↑)`. Optional; without it Pi shows the status as usual.
- Plan mode or any other extension that sets the thinking level sets the ceiling, like a manual change.

## Limitations

- On models without mid-conversation effort support, the level only changes before your messages.
- Limits read only Anthropic subscription headers and Codex windows; other providers are never limited.

## Development

```sh
cd packages/pi-auto-effort
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the Vitest unit tests (`vitest run`). `npm run eval` rates 20 requests and several mid-run stretches with live Jev through the Pi installation on `PATH`; it is skipped without `TYPESAFE_API_KEY`. `npm run eval` makes live, paid classifier requests; run it only with explicit authorization. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
