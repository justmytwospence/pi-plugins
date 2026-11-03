---
title: Model waterfall
description: Optional, subscription-only virtual model routing with strict quota checks and no pay-as-you-go fallback.
plugin: pi-model-waterfall
---

## Quick reference

- **Use it for:** Explicitly select the optional `waterfall/auto` virtual model; it checks a verified subscription allowance before inference.
- **Enable:** Select `packages/pi-model-waterfall/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset). This is separate from the [status footer](/plugins/pi-status-footer/).
- **Controls:** `/waterfall` shows the last physical route and skipped reasons, without a quota read or model request. Manual `/model` selections remain independent.
- **Settings:** No automatic default selection and no paid-API fallback. A window at **95% used or above** disqualifies its rung.
- **Requirements, cost & privacy:** Pi 1.4 virtual-model routing; uses account-bound, read-only quota checks. Missing or stale data, invalid OAuth, a reset-due window or an unknown model-specific limit does not authorize inference. No credentials cross the presentation event.
- **Integrations & limits:** Optional footer route snapshot; OpenAI and Muse cannot yet be chosen automatically. Do not treat the four-rung order as an enabled four-provider rollout.

## Route ownership

This [suite component](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-model-waterfall) registers `waterfall/auto` and `/waterfall`; the footer neither registers nor runs either. The footer can optionally read a synchronous `pi-plugins.model-waterfall.v1` snapshot to display the selected physical model, with no additional control or footer row. The router also runs without any TUI or footer: print and RPC requests check quotas before inference. Its verified physical route and thinking level live in Pi's branch-aware virtual-model state. A continuation, retry or pending-tool steer may retain only that checked route and reasoning variant; new turns check again. If no rung qualifies, Pi stops before inference with an explanation. Anthropic needs its all-models weekly window; a 5h window binds whenever the plan reports one, and a weekly limit scoped to another model (such as Fable) is ignored, while one naming Opus binds. The snapshot also lists every rung in order with its state (available, exhausted with its reset, disabled or unknown), assessed in the background from the same cached quota reads; the startup splash orders and marks its providers by it. Explicit physical model picks bypass the router.

Candidates, in order:

1. `anthropic/claude-opus-5-5` with Pi's own Anthropic subscription OAuth and account-bound 5-hour/weekly windows.
2. `openai/gpt-6.1-sol` with modern OpenAI OAuth. **Disabled for automatic routing:** a separate `openai-codex` OAuth login can read Codex-plan limits, but those limits have not been shown to govern modern Sol's app allowance. It is never used for inference. A System 1 Decisions API key is a third, independent credential and is never used here.
3. `google/antigravity-gemini-4-argon` with the local Antigravity OAuth subscription. Eligibility needs the exact low/medium/high quota variant that the physical model's effective thinking level dispatches, Argon's weekly bucket and the shared Gemini windows. If the OAuth account changes during a quota read, the router rejects that observation. Gemini 3.8 Flash is a separate everyday model, not an Argon setting. Carbon is a stronger, limited-rollout model not currently selectable through the Antigravity picker; neither is a waterfall candidate.
4. `muse-sdk/muse-wonder-1.0` with the signed-in Muse Code CLI. **Disabled for automatic routing:** the candidate's handoff replaces historical cross-provider images and image tool results with placeholders. The user has not accepted that information loss. The legacy `muse-code` bridge and a separately billed Meta Model API key are not substitutes.

There is no wraparound to an API-key model. A valid account-bound observation must cover every applicable window, with known utilization below 95%, a future reset and recent observation time. A fresh narrow window cannot make an old weekly window fresh. No quota read is proof of billing or guaranteed subscription entitlement for an unrelated app.

The suite lists the component for explicit selection, but the managed default remains Anthropic. This extraction does not publish, install or enable an automatic four-rung chain; resolving OpenAI's mapping and Muse's history quality requires a separate decision.
