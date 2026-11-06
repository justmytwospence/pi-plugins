---
title: Model waterfall
description: Starts new Pi sessions on the first subscription model under quota, with strict quota checks and no pay-as-you-go fallback.
plugin: pi-model-waterfall
---

## Quick reference

- **Use it for:** Starting each new interactive session on the first subscription model that is under quota, instead of always on Pi's default.
- **Enable:** Select `packages/pi-model-waterfall/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset). This is separate from the [status footer](/plugins/pi-status-footer/).
- **Controls:** `/waterfall` shows the startup choice and each rung's state, without a quota read or model request. `/model` remains independent.
- **Settings:** None. The order is fixed, and a window at **95% used or above** disqualifies its rung.
- **Requirements, cost & privacy:** Account-bound, read-only quota checks. Missing or stale data, invalid OAuth, a reset-due window or an unknown model-specific limit disqualifies a rung. No credentials cross the presentation event.
- **Integrations & limits:** Optional footer and startup-splash snapshot. It acts only on `startup` and `new` interactive sessions without `--model`, `-m` or `--provider`.

## How it works

This [suite component](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-model-waterfall) is not a provider or virtual model. When an interactive session starts, it checks the rungs in order and switches the session to the first one under quota with a single session-only model change. It does not switch if you changed model or sent a turn while quotas were being read, and it never switches mid-session. If no rung qualifies, it warns and keeps Pi's default. The footer shows the session's actual model and can read a synchronous `pi-plugins.model-waterfall.v1` snapshot listing every rung in order with its state (available, exhausted with its reset, disabled or unknown); the startup splash orders and marks providers by it.

Candidates, in order:

1. `anthropic/claude-opus-5-5` with Pi's own Anthropic subscription OAuth. The all-models weekly window must be known; a 5h window binds whenever the plan reports one, and a weekly limit scoped to another model (such as Fable) is ignored, while one naming Opus binds.
2. `openai/gpt-6.1-sol`, gated on the signed-in Codex account's windows (Pi's separate `openai-codex` login). A blocked account is skipped even below 95%. That token is used only to read quota, never for inference.
3. `google/antigravity-gemini-4-argon` with the local Antigravity OAuth subscription. Eligibility needs the exact low/medium/high quota variant for the session's thinking level, Argon's weekly bucket and the shared Gemini windows.
4. `muse-code/muse-wonder-1.0` from pi-muse-bridge, gated on the signed-in Muse CLI's usage. A window with no usage yet counts as available. The bridge is accepted despite its lossy history handoff; a separately billed Meta API key is not a substitute.

A valid account-bound observation must cover every applicable window, with known utilization below 95%, a future reset and a recent observation time. There is no wraparound to an API-key model, and no quota read is proof of billing or guaranteed entitlement.
