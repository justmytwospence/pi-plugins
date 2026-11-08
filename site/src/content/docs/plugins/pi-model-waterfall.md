---
title: Model waterfall
description: Starts new Pi sessions on the first subscription model under quota, with strict quota checks and no pay-as-you-go fallback.
plugin: pi-model-waterfall
---

## Quick reference

- **Use it for:** Starting a new interactive session on the first eligible subscription model instead of always on Pi's default.
- **Enable:** Select `packages/pi-model-waterfall/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset). The [status footer](/plugins/pi-status-footer/) is optional.
- **Controls:** `/waterfall` shows the startup choice and each active rung's state without a quota read or model request. `/model` remains independent.
- **Settings:** Configure the active order in `~/.pi/agent/model-waterfall.json` or `<cwd>/.pi/model-waterfall.json`. A window at **95% used or above** disqualifies its rung.
- **Requirements, cost & privacy:** Account-bound, read-only quota checks. Missing, invalid, stale or reset-due data disqualifies a rung. No credentials cross the presentation event.
- **Integrations & limits:** Optional footer and startup-splash snapshot. It acts only on `startup` and `new` interactive sessions without `--model`, `-m` or `--provider`; it never switches mid-session.

## How it works

This [suite component](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-model-waterfall) is not a provider or virtual model. At startup it checks the active rungs in order and switches to the first eligible model with a single session-only change. It does not switch if you changed model or sent a turn while quotas were being read. If no rung qualifies, it warns and keeps Pi's default. Resumed, forked, reloaded and headless sessions are not switched, and manual model selection remains available.

The default order is:

1. `anthropic/claude-opus-5-5` with Pi's own Anthropic subscription OAuth. The all-models weekly window must be known; a 5h window binds whenever reported, and a weekly limit scoped to another model (such as Fable) is ignored, while one naming Opus binds.
2. `openai/gpt-6.1-sol`, gated on the signed-in Codex account's windows (Pi's separate `openai-codex` login). A blocked account is skipped even below 95%. That token is used only to read quota, never for inference.
3. `google/antigravity-gemini-4-argon` with the local Antigravity OAuth subscription. The shared Gemini 5h and weekly windows, Argon weekly window and exact low/medium/high variant for the physical model's thinking level must all be known and below the threshold. Argon is the only automatic Google candidate: healthy shared quota cannot rescue missing or exhausted Argon quota, and another Google model or lower reasoning level is not substituted.

`muse-code/muse-wonder-1.0` from pi-muse-bridge remains supported for manual selection, favorites and explicit opt-in. When enabled as a rung it uses the signed-in Muse CLI's usage; a window with no usage yet counts as available. The bridge is accepted despite its lossy history handoff; a separately billed Meta API key is not a substitute.

A valid account-bound observation must cover every applicable window, with known utilization below 95%, a future reset and a recent observation time. **95% is a waterfall safety threshold**, not a claim that the provider has rejected inference or that the allowance is actually 100% used. There is no wraparound to an API-key model, and no quota read proves billing or guaranteed entitlement.

The optional credential-free snapshot exposes the configured order and states (`available`, `exhausted`, `disabled` or `unknown`) to the footer and startup splash. An exhausted Google rung can identify its blocking shared, model or variant quota and reset; invalid or stale observations remain unknown.

## Configure the order

For example, to opt Muse in after the default three, put this JSON in `~/.pi/agent/model-waterfall.json` or `<cwd>/.pi/model-waterfall.json`:

```json
{ "order": ["anthropic", "openai", "google", "muse-code"] }
```

The project order replaces the global order; a missing file or `order` retains the lower-precedence setting. Entries must be unique supported provider IDs. An empty `order` disables automatic checks and selection. Malformed or unreadable configuration, duplicate or unknown IDs, and invalid orders fail closed with no quota checks or selection; a valid explicit project order can override a global error. The order is resolved at session start and stays fixed for that session; a new or reloaded session reads configuration again.
