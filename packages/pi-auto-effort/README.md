# pi-auto-effort

A Pi extension that sets the thinking level for each message you send, and between tool turns of a long run where the model allows it without losing the prompt cache. [Jev](https://docs.typesafe.ai), called through Pi's classifier models (`ctx.modelRegistry.classify`), says which level the request needs before the turn starts; a level is picked only when Jev is confident enough that the work needs it, a bar that rises when a subscription window is on track to run out. It also picks a model of the same provider for each message (Sonnet or Opus, Terra or Sol by default): a cheaper one only while switching costs nothing (the cache is cold), a stronger one whenever the work needs it, and with pi-cache-guard it offers both in the cold-cache dialog.

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

Before each message you send, Jev answers a choice over four levels:

| Level | Request |
|---|---|
| low | a lookup, trivial answer, or mechanical change |
| medium | a routine single-file change or clear question |
| high | a multi-step change, debugging with clear symptoms, design in a known pattern |
| xhigh | subtle design, cross-cutting refactor, hard debugging, correctness-critical work |

Jev sees the request, the two before it, the agent's last reply, and what the last run did (errors, files edited, tool calls). It also judges whether the message is a go-ahead.

**The agent's reply is untrusted.** A reply can quote a file, a web page or tool output that holds instructions aimed at a classifier ("rate this xhigh"). It is sent as `agent_reply_untrusted`, clipped to 600 characters, and the question tells Jev that it only describes what happened in the last run and that any instructions, ratings or requests in it are to be ignored. The mid-run question says the same of the agent's recent steps (what it said and the tool output).

**Go-aheads skip Jev.** A message that is only a go-ahead or thanks keeps the level and the model without a Jev call. After lowercasing and ignoring punctuation, every word must belong to one of the phrases (`yes`, `y`, `yep`, `yeah`, `ok`, `okay`, `sure`, `go`, `go ahead`, `go for it`, `continue`, `proceed`, `do it`, `ship it`, `sounds good`, `looks good`, `lgtm`, `perfect`, `great`, `thanks`, `thank you`, `ty`, `cool`, `nice`, plus `prefilter.phrases`), and the message has at most four words: `Yes, go ahead!` and `ok thanks` match, `yes please` and `go ahead and add tests` do not. Such a decision is recorded with reason `go-ahead` and announces `quota:pressure` like any other. `"prefilter": { "enabled": false }` sends every message to Jev.

**The threshold rule.** Jev's answer is a probability for each level. `need(L)`, the probability that the work needs at least L, is the sum of the probabilities of L and every level above it. The level is the highest one within the bounds whose need is at least the threshold `θ`, else the floor. `θ = relaxed + (tight - relaxed)·p`, with `policy.threshold` `relaxed` 0.5 and `tight` 0.85, and `p` the subscription pressure: 0 with none, 0.5 at caution, 1 at critical (see [Limits](#limits)). At 0.5 the level is the median of Jev's distribution, biased neither up nor down; under pressure only work Jev is surer about gets the higher levels.

**No flip-flopping.** The level goes up as soon as a higher level clears `θ`, but goes down only once the current level's need is below `θ - policy.hysteresis` (0.1). A go-ahead keeps the level: one of the listed phrases without asking Jev (above), any other when Jev rates it a go-ahead above `ackThreshold` 0.7 ("okay then, carry on").

**Bounds.** `policy.bounds` sets the range:

- `free` (default): from `policy.floor` (`low`) up to `policy.max` (`xhigh`; never `max`). A manual change sets the level now, and the next assessment moves on from it either way.
- `ceiling`: from `policy.floor` up to your latest manual level, any thinking-level change auto-effort did not make itself (`/thinking`, Pi's shortcut, a model switch that changes the level, or another extension such as plan mode).

Levels outside the managed range (`off`, `minimal`) are left alone, as is everything in `ceiling` bounds when the ceiling is below the floor. The policy never picks `max`; a `max` ceiling only caps it.

**Mid-run.** A long run can change what it needs: mechanical edits after a hard design step, or a debugging stretch in the middle of a routine change. On models that take an effort change mid-conversation without losing the prompt cache (those Pi marks with `compat.supportsMidConvoEffort`, the effort-update models below, and any `midRun.models` globs), Jev re-rates the work between tool turns: every `midRun.everyTurns` (3) tool turns, or at once after a turn with `midRun.errorTurns` (1) or more failed tool calls. It sees the request that started the run, the agent's last `midRun.steps` (6) steps (what it said, the tools it called, what failed; untrusted, as above) and counts for the run so far. The same rule, bounds and pressure apply. The check runs after the tools finish and before the next request, adding one Jev call every few turns.

**Cache-safe.** On every other model the level changes only before a message you send, never on tool follow-ups, since changing the thinking settings there invalidates the cached conversation. `midRun.models` adds models by `provider/id` glob if you accept that cost.

Auto-effort is off when Pi was started with `--thinking` (so a subagent's explicit effort stays fixed). When Jev is unavailable it keeps the level.

**Older settings.** The smoothing policy's keys (`policy.mode`, `alpha`, `margin`, `jump`, `jumpConfidence`, `minDwell`, `minConfidence`) and `limits.steps` are ignored, as are the running average and dwell saved in older sessions (their ceiling is kept).

## Model choice

With `models.mode` `auto` (the default; `/auto-effort models off|auto` for the session) and tiers for the current provider, auto-effort picks a model for each message you send by the same rule. The same Jev request gets a `tier` choice over the provider's tiers (`fast` < `balanced` < `strong`), and the tier is the highest within the bounds whose need clears `θ`. The provider is kept: tiers are looked up for the current provider, and an entry naming another provider is skipped.

**Tiers.** `models.tiers` maps a provider to its tier models. A provider without an entry gets a built-in preset, resolved from the models Pi has credentials for (`ctx.modelRegistry.getAvailable()`):

| Provider | balanced | strong |
|---|---|---|
| `anthropic` | newest `claude-sonnet-*` | newest `claude-opus-*` |
| `openai-codex` | newest `*-terra` | newest `*-sol` |

Newest is a numeric-aware sort of the id (`claude-sonnet-5-5` after `claude-sonnet-5`, `gpt-6.1-sol` after `gpt-6-sol`), skipping an id with an 8-digit date suffix when its undated alias exists. The presets have no `fast` tier: a small model is too weak for the main session. With a preset, your own model keeps its family's tier, so an older Sonnet you picked is your balanced model. An explicit `models.tiers[provider]` replaces the preset for that provider.

**When it switches.** A model switch re-sends the whole conversation without a cached prefix, so it is considered only before a message you send, and the two directions differ:

- **Down** (to a cheaper tier than the current model's) only when switching is cheap:
  - the session's first message;
  - the prompt cache is cold: pi-cache-guard's `cache:state` event says so when it is loaded; else the last cache activity (the last answer, or a later Pi cache-warming refresh) is older than the model's cache lifetime (its `promptCache` metadata, else 5 minutes, or an hour with `PI_CACHE_RETENTION=long`);
  - or the context is below `models.maxSwitchTokens` (30000) tokens.
- **Up** (to a stronger tier, including back to your own model after an auto downshift) on any message the rule picks it, even with a warm cache, accepting one cache rewrite. With a warm cache the `tier` question is asked only when a stronger tier, up to your own model, exists.

It switches with `pi.setModel`, notifies (`auto-effort: Claude Sonnet 5.5 for this request; first message`, `auto-effort: back to Claude Opus 5.5; harder request, one cache rewrite`), and adds `≈sonnet-5-5` to the status while an auto pick is in use.

The model you pick by hand is remembered as yours; an auto pick never changes it. When its tier is picked, auto returns to it. Automatic picks never go above your model's tier, whatever the effort bounds: the model you (or another extension, such as plan mode's implementation model) chose is the ceiling. Stronger models are only offered in pi-cache-guard's cold-cache dialog, where you choose. Model choice is off when Pi was started with `--model` (a Herdr child, a script). A model that is neither in the tier map nor of a preset family counts as `strong` (and stands in for `strong` when there is none). A go-ahead keeps the model, and `/auto-effort off` returns to yours.

**pi-cache-guard's cold-cache dialog.** When pi-cache-guard holds a prompt because the cache is cold, it asks loaded extensions for models to offer, and auto-effort answers when it is on, `models.mode` is `auto` and the provider has two or more tiers. Two events on Pi's extension event bus carry this:

```ts
// pi-cache-guard, before the dialog: listeners push promises; it awaits them (about 2.5 s at most).
pi.events.emit("cache:model-offers", { text, tokens, offers: [] as Array<Promise<ModelOffer[] | undefined>> });
// pi-cache-guard, after the dialog: the chosen offer's provider/id, or null (send on the current model, compact, fresh or keep).
pi.events.emit("cache:model-choice", { text, model: "anthropic/claude-sonnet-5-5" });

interface ModelOffer {
  model: string; // provider/id, never the current model
  label: string; // the registry name, like "Claude Sonnet 5.5"
  recommended?: boolean;
  note?: string; // short, like "routine work"
}
```

For `cache:model-offers` auto-effort runs the assessment it would run for the prompt (`depth`, `ack` and `tier` questions against the current branch), picks a tier by the rule over every tier (either direction: the cache is cold anyway, and you choose), and returns one offer per other tier model, lowest tier first, with `recommended` on its pick when that differs from the current model. The assessment is kept for the prompt with the same text, so the prompt does not ask Jev again. A `cache:model-choice` for the same text is applied before that prompt: a model is switched to as an auto pick (your own model stays yours), and `null` keeps the current model; either way auto-effort makes no model choice of its own for that prompt, but still sets the level. A choice or assessment for another text is discarded. The event names and types are exported (`MODEL_OFFERS_EVENT`, `MODEL_CHOICE_EVENT`, `ModelOffersEvent`, `ModelChoiceEvent`, `ModelOffer`).

## Effort updates (Codex)

On OpenAI Responses models whose backend accepts a `configuration_update` input item, a change to the request's `reasoning.effort` starts a separate prompt cache, while the item changes effort from that point in the conversation. On the `effortUpdates.models` (default `openai-codex/gpt-6-astra`, `openai-codex/gpt-6.1-sol` and `openai-codex/gpt-6.1-terra`, which the source records as verified live through the Codex subscription backend), auto-effort keeps the request's effort at the conversation's first value and turns every later change (its own, `/thinking`, or another extension's) into an item at the point it happened: after the latest tool result, or before your new message. Each item is replayed in place on later requests.

- An item is never added for a change back to the effort already in force there, and there is at most one item per position (the backend rejects adjacent items).
- A history rewritten under an item (compaction, a branch switch) starts a new baseline.
- Payloads that already carry `configuration_update` items, or whose effort is not `low` to `max`, are left alone.
- The positions are saved as an `auto-effort:effort-updates` session entry, so a resumed session keeps its cache.
- This works whether auto-effort is on or off (including with `--thinking`); only `effortUpdates.enabled` turns it off.

## Commands

- `/auto-effort` or `/auto-effort status`: current level, bounds, the last judgment (for example `Assessment: need(medium)=0.90 need(high)=0.55 need(xhigh)=0.10, θ=0.68 (5h caution) → medium, last decision: hold.`), this session's counts (for example `Session: 14 assessments (avg 212 ms): 3 raised, 2 lowered, 8 held, 1 failed; 6 settled without a call (go-ahead).`: Jev assessments at prompts and mid-run, a held count that includes go-aheads Jev recognized, failures with no usable answer, the average latency of answered calls, and go-aheads settled without a call), model choice (for example `Models: auto (settings): balanced claude-sonnet-5-5, strong claude-opus-5-5 (preset); your model anthropic/claude-opus-5-5.`), and the limits lines.
- `/auto-effort limits`: for each window of the current provider: use, elapsed share, projection, time to run out, reading age and tier.
- `/auto-effort on`, `/auto-effort off`: for this session. Off restores your manual level (and model) and turns off limits too.
- `/auto-effort bounds free|ceiling`: the bounds for this session, over `policy.bounds`.
- `/auto-effort models off|auto`: model choice for this session, over `models.mode`.

The status shows `effort: medium (auto ↑ free)` in `free` bounds and `effort: medium (auto ↑ ≤high)` in `ceiling` bounds (`≤` your manual level), then `≈<model>` while auto picked a model and `, limited: 5h 84%` while a subscription window is under pressure, for example `effort: medium (auto → free ≈sonnet-5-5, limited: 5h 84%)`. The detail never contains parentheses, so pi-status-footer can parse it. The arrow is where the level is heading after the last judgment: ↑ when the next level's need is within the hysteresis of `θ` and the bounds leave room, ↓ when the level holds only through the hysteresis, → otherwise.

Each decision is an `auto-effort:state` session entry (never sent to the model; `phase` is `prompt` or `run`), with `need` per level, `theta`, `p`, `bounds`, the ceiling, the level before and after, the reason, any limit, your model, and the model choice when one was considered (`action` `keep`, `switched`, `chosen` for your pick in pi-cache-guard's dialog, `missing` or `failed`). When a session starts or resumes, the state is restored from the latest such entry on the current branch, and the session counts from all of them (entries of older versions with other reasons are not counted); a `/tree` move recounts them for the new branch. The counts are kept in memory only.

## Limits

When an Anthropic or Codex subscription window (5h, weekly) is filling up or on track to run out before it resets, auto-effort raises the threshold `θ`, so only work Jev is surer about gets the higher levels (and the stronger tiers). Pressure never forces a step down by itself, so caution starts early and gently.

**Sources.** Anthropic subscription (OAuth) responses carry `anthropic-ratelimit-unified-5h-*` and `-7d-*` headers (utilization, reset, status), read in `after_provider_response`; an API key gets token-bucket headers instead, which are ignored, so it is never limited. Codex windows are read from `x-codex-primary-*` / `x-codex-secondary-*` response headers when present, and from `GET https://chatgpt.com/backend-api/wham/usage` (Pi's default WebSocket transport carries no `x-codex-*` headers). That endpoint is polled only while limits are on and a Codex model is in use, with the token and account Pi itself sends: at most every 5 minutes, one request at a time, 5 s timeout, in the background (a prompt never waits for it). A 429 waits for `Retry-After`, else 15 minutes doubling to an hour; other failures wait 5 minutes doubling to an hour; a 401/403 stops polling until the token changes. A change of Codex account drops the old account's readings.

**Privacy.** Only response headers and Pi's own Codex credential are used; no auth files are read, and the readings stay in process memory (nothing is shared between processes or written to disk). Quota data never reaches Jev or the model.

**When it raises the bar.** Each window gets a tier:

| Tier | Pressure `p` | `θ` (defaults) | At once when | After a second assessment 5 minutes later when |
|---|---|---|---|---|
| caution | 0.5 | 0.675 | 60% used | the forecast reaches 90% used before 90% of the time to reset (warming up: projected 90% at reset) |
| critical | 1 | 0.85 | 80% used, the provider reports it exceeded, or the forecast runs out within 60 minutes | projected 120% at reset |

The worst window wins. The level never goes below `policy.floor`. A tier lifts after two assessments 5 minutes apart with the projection at most 95% at reset (for critical, at most 115%) and use 5 points under the tier's threshold. A window that resets clears its tier at once. Assessments happen at your prompts (and mid-run checks), so an idle session changes nothing. A tier change is announced with a notification.

**The forecast.** Two rates from the window's history of readings: a recent one (the last hour, half-life 15 minutes; gaps over 30 minutes do not count) and a sustained one (the last 24 hours, half-life 6 hours), each weighting an interval by its length and recency. The recent burst decays toward the sustained rate over `tau = min(1 h, window / 5)`, and the forecast integrates that up to the reset: near a 5h reset a burst dominates, across a week it fades. Until a window has 3 readings spanning `min(1 h, window / 10)`, the linear pace (used divided by the fraction of the window elapsed, as in CodexBar) stands in, from 10% elapsed and 20% used. A reading older than 15 minutes still counts as a minimum (use only grows within a window) but not for the weighted forecast. A spend limit has no length, so only its absolute thresholds apply.

**Not feeding back.** Pressure only moves `θ`; each assessment starts from Jev's answer, so the level returns at the next assessment once the pressure clears.

**The `quota:pressure` event.** After each assessment, and when `/auto-effort off` drops a pressure in force, auto-effort emits on Pi's extension event bus:

```ts
pi.events.emit("quota:pressure", { provider: "anthropic", tier: "caution", p: 0.5, label: "5h caution" });
```

`provider` is the current model's provider, `tier` is `none`, `caution` or `critical`, `p` is 0, 0.5 or 1, and `label` (absent at `none`) names the limiting window and tier. Other extensions can read it, for example to pick cheaper subagent models under pressure (pi-subagents does). It carries no usage figures or credentials.

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
  "policy": { "floor": "low", "bounds": "free", "max": "xhigh", "threshold": { "relaxed": 0.5, "tight": 0.85 }, "hysteresis": 0.1, "ackThreshold": 0.7 },
  "midRun": { "enabled": true, "everyTurns": 3, "errorTurns": 1, "steps": 6, "models": [] },
  "effortUpdates": { "enabled": true, "models": ["openai-codex/gpt-6-astra", "openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-terra"] },
  "models": { "mode": "auto", "maxSwitchTokens": 30000, "tiers": {} },
  "prefilter": { "enabled": true, "phrases": [] },
  "limits": {
    "enabled": true,
    "caution":  { "used": 0.6, "projected": 0.9 },
    "critical": { "used": 0.8, "projected": 1.2, "exhaustMinutes": 60 },
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

- `policy.bounds` is `free` or `ceiling`; `policy.floor` and `policy.max` are `low` to `xhigh`; the thresholds, `hysteresis` and `ackThreshold` are 0 to 1. An invalid value keeps its default.
- `models.mode` is `off` or `auto`; any other value (including the retired `suggest`) means `auto`.
- `models.tiers` maps a provider to the `provider/id` (or bare id) of its `fast`, `balanced` and `strong` models; any subset works, and an entry replaces the provider's preset. For example `"tiers": { "anthropic": { "fast": "anthropic/claude-haiku-4-5", "balanced": "anthropic/claude-sonnet-4-5", "strong": "anthropic/claude-opus-4-5" } }`; `"tiers": { "anthropic": {} }` turns model choice off for one provider.
- `prefilter.phrases` adds go-ahead phrases to the built-in ones (matched the same way: case and punctuation ignored, at most four words per message), for example `["yes please", "carry on"]`.
- `midRun.errorTurns` is how many failed tool calls in one turn trigger an early check (0 = never). `midRun.models` and `effortUpdates.models` are `provider/id` globs (`*` matches anything).
- An invalid `limits`, `midRun`, `effortUpdates` or `models` value falls back to its default.
- `"limits": { "enabled": false }` in the shared file turns limits off for every port; `/auto-effort off` turns them off with the rest for the session.

## Requirements and costs

- Pi 0.99 or newer for classifier models, and a configured classifier model; Pi resolves the credentials (`TYPESAFE_API_KEY` for its `typesafe` provider). Without Jev the level is never raised or lowered by score.
- Each message you send makes one classifier request, except a go-ahead the pre-filter recognizes (model choice adds a question to it, not a request; a prompt held by pi-cache-guard's cold-cache dialog makes it while the dialog opens and reuses it), and mid-run checks add one every few tool turns on supported models, each awaited before the next model request. These requests can be billed. Set `"enabled": false` or `"jev": { "enabled": false }` to stop them.
- With limits on and a Codex model in use, it makes background requests to `chatgpt.com/backend-api/wham/usage` with Pi's Codex credential.
- With `models.mode` `auto` (the default) it switches the session's model within the provider (never the configured default for new sessions); a step up with a warm cache re-writes the cache once. Set `"models": { "mode": "off" }` to keep your model.
- On disk it reads only the settings files above and writes nothing. In the session it appends `auto-effort:state` and `auto-effort:effort-updates` custom entries (never sent to the model).

## Optional integrations

- pi-status-footer renders the `auto-effort` status as `reasoning high · auto ↑ free`. Optional; without it Pi shows the status as usual.
- pi-cache-guard's `cache:state` event (`{ cold, tokens?, model? }`) tells model choice whether the cache is cold and how large the context is. Optional; without it auto-effort estimates from the time since the last cache activity (an answer or a Pi cache-warming refresh) and Pi's context usage.
- pi-cache-guard's cold-cache dialog offers auto-effort's models through `cache:model-offers` and reports your pick through `cache:model-choice` (see [Model choice](#model-choice)). Optional; without it the dialog offers no models and auto-effort chooses on its own.
- Other extensions can listen for `quota:pressure` (see [Limits](#limits)).
- Plan mode or any other extension that sets the thinking level counts as a manual change (the ceiling in `ceiling` bounds).

## Limitations

- On models without mid-conversation effort support, the level only changes before your messages.
- Limits read only Anthropic subscription headers and Codex windows; other providers are never limited.

## Development

```sh
cd packages/pi-auto-effort
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` (sources, tests, evals and the shared eval helpers) and the Vitest unit tests (`vitest run`). `npm run eval` makes live, paid classifier requests; run it only with explicit authorization. It runs the evals in `eval/` (helpers in the repository's `evals/shared/`) with live Jev through the Pi installation on `PATH` (or `PI_PACKAGE_DIR`), and they are skipped without `TYPESAFE_API_KEY`:

- `effort.eval.ts` rates 20 requests and `midrun.eval.ts` several mid-run stretches.
- `replay.eval.ts` replays your own recent Pi sessions. It samples session files under `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`, without `subagents` directories), assesses every user message on each one's current branch as auto-effort would now (the pre-filter, else Jev with 8 calls at a time and a 20 s timeout), and walks the prompts through the default policy (free bounds, the pressure each prompt's state entry recorded). It compares the replayed levels with the levels you picked by hand after a prompt (a level change auto-effort did not make, nor Pi after a model switch; see `eval/replay.ts`) and prints one row per session and the totals: overrides, exact and within-one matches, misses above and below, levels, level changes per session, prompts settled by the pre-filter, Jev failures, latency p50 and p95, and agreement with the levels set live. It asserts only that fewer than 20% of the Jev calls fail. Run it alone with `npm run eval -- eval/replay.eval.ts`. Every eval prints `spend: $X over N calls`; this one also appends a record (commit, seed, `EVAL_*` parameters, spend, calls and the numbers above, plus the old behaviour's with `EVAL_COMPARE=1`) to `evals/results/auto-effort.jsonl` in the repository (git-ignored). From the repository root, `npm run -s eval:last -- auto-effort` prints the last record with its difference from the one before, and `npm run -s eval:dry -- auto-effort` counts the Jev calls a run would make (`countCalls` in `eval/replay.ts`) without making any.

| Variable | Default | Meaning |
|---|---|---|
| `EVAL_RECENT` | 50 | how many of the newest session files (by modification time) to consider |
| `EVAL_MIN_PROMPTS` | 5 | keep sessions whose branch has at least this many user messages |
| `EVAL_MIN_TOOLS` | 30 | and at least this many tool results |
| `EVAL_SAMPLE` | 20 | how many qualifying sessions to replay |
| `EVAL_SEED` | random | seed of the shuffle that picks them; always printed, so a run can be repeated |
| `EVAL_COMPARE` | off | `1` also replays the old behaviour (no pre-filter, the agent's reply as `last_outcome` at 1,500 characters) side by side, which doubles the calls |

`evals/shared/sessions.ts`, the session sampler, is shared with pi-tool-gate's evals and has its own unit tests there (`node --test`, run by the repository root's `npm test`). For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
