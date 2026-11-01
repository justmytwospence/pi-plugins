---
title: System 1
description: Configure a shared native classifier waterfall and request typed judgments without changing chat authentication.
plugin: pi-system1
---

## Quick reference

- **Use it for:** Ordering the suite's classifier backends and making ad-hoc typed judgments.
- **Enable:** Select `packages/pi-system1/src/index.ts` from the suite manifest.
- **Controls:** `/system1 [status|jev|openai|order|retry]`; the Context-row System 1 chip opens the same picker when available.
- **Settings:** One global `$PI_CODING_AGENT_DIR/system1.json` (default `~/.pi/agent/system1.json`); absent means Jev.
- **Requirements, cost & privacy:** Classifier-capable Pi and credentials for configured backends; requests send supplied evidence to attempted providers and can incur API charges. OpenAI requires separate API credentials and the billing precautions below.
- **Integrations & limits:** Applies to the suite's eight classifier integrations and `system1_judge`, not the chat model or arbitrary third-party extensions. Feature-specific switches and failure policies remain in force.

[Source: pi-system1](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-system1)

This page describes the approved waterfall target; commands and behavior require a compatible runtime and are not evidence of installation or rollout.

## Select an order

`/system1` opens the picker and `/system1 status` shows the selection and local capability and authentication status. Opening the picker or checking status makes no model request. The footer chip shares this picker; it adds no footer row. The global configuration has no project override.

For a Jev rung, each feature's existing provider/model selection or discovery remains effective. The Decisions target is `system1-openai/gpt-6-luna`. Existing per-feature disable flags, thresholds and timeouts still apply; changing the order does not enable a disabled feature. Jev remains available to standalone integrations without pi-system1; Decisions requires the isolated provider registered by pi-system1.

## OpenAI setup and billing

OpenAI mode uses the real native `gpt-6-luna` Decisions API, not a chat or Responses imitation. No subscription-OAuth route was verified. Configure the dedicated API credential with `/login system1-openai` or `SYSTEM1_OPENAI_API_KEY`; this does not replace the subscription chat login. Generic `OPENAI_API_KEY` and other providers' credentials are not fallbacks.

Before switching, manually claim and link eligible included ChatGPT Pro API credits to the intended API organization. Verify that it has active included credits, **no purchased balance, no auto-recharge and no paid or postpaid continuation**. See [OpenAI's API credits for ChatGPT subscribers](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) for eligibility, claiming and expiration. Keep Jev selected if those conditions cannot be established. The confirmation is consent, not a spending cap: Pi cannot verify entitlement, quota, remaining credits or which funds pay for a request. Local credential availability is not proof of a working or credit-funded request.

## Manual judgments

Call `system1_judge` with an object containing `state` (an object of evidence) and `questions` (an object keyed by question ID). Each question uses an `instructions` string and one of these native forms:

```json
{
  "state": { "text": "The tests passed." },
  "questions": {
    "passed": { "type": "bool", "instructions": "Did the tests pass?", "criteria": { "true": "Tests passed", "false": "Tests did not pass" } },
    "kind": { "type": "choice", "instructions": "Classify the outcome", "criteria": { "success": "Tests passed", "other": "Any other outcome" } },
    "quality": { "type": "score", "instructions": "Rate the evidence", "criteria": ["weak", "moderate", "strong"] }
  }
}
```

Results contain typed answers, configured order, actual backend/provider/model, latency and reported usage. Bool answers contain a probability; choice answers include the selected label, its confidence and the label distribution; scores can be fractional, with confidence. The tool judges supplied evidence; it does not execute suggested actions. The legacy `jev-ask` shell helper follows the configured order; TypeSafe-specific experimental operations are restricted as described below. The `jev-judgments` skill can use `system1_judge` in Pi.

## Classifier waterfall

The `/system1` picker offers four complete presets: **Jev → OpenAI**, **OpenAI → Jev**, **Jev only**, and **OpenAI only**. `/system1 jev` and `/system1 openai` remain singleton shortcuts. `/system1 order jev openai` and `/system1 order openai jev` set the two orders; singleton forms and the `openai-decisions` alias are accepted too. For example:

```json
{
  "waterfall": ["jev", "openai-decisions"],
  "backend": "jev"
}
```

The nonempty, duplicate-free `waterfall` array is authoritative and supports only `jev` and `openai-decisions`; `backend` mirrors the first rung for old sessions. A missing file still defaults to Jev alone, and a valid legacy `backend` becomes a singleton. An invalid `waterfall` is an error even if `backend` is valid. Writes preserve unrelated fields; the order is shared by sessions in the same agent directory, not automatically across machines.

Only operational failures advance the chain: for example missing or invalid credentials, exhausted quota, throttling, an unavailable model, transport failure, timeout or malformed answers. Valid negative or uncertain judgments, safety refusals, disabled features, invalid input, cancellation and configuration replacement do not. If a batch fails, its partial answers are discarded and the next rung receives the whole question set. Existing feature policies still decide what happens when the chain is exhausted.

Credential, quota and unavailable-model failures cool a physical target for five minutes; rate-limit and transport failures cool it for 30 seconds. Timeouts and malformed answers are request-specific. After expiry one request can retry the target; no background probe runs. `/system1 retry` resets cooldowns and cached failures only in the current Pi process, without probing or changing the order; other processes recover through their own cooldown or retry. Failure, exhaustion and recovery notices are deduplicated for 60 seconds, and repeat notices during the same cooldown are suppressed. Valid judgments and ordinary cancellations do not warn.

Each request has one total deadline divided among runnable rungs, not a separate full timeout per provider. A multi-rung chain attempts each rung once; singleton Jev may use its optional one-time timeout retry within the same budget. Host retries are disabled, and Decisions retains sequential batches of at most 400 questions.

The result identifies the configured order and selection key separately from the actual winning backend, provider, model and target key, including fallback and sanitized attempt metadata. Usage aggregates what all attempts report once; missing usage is unknown, not zero. Status and the Context-row chip distinguish preferred order from the last actual route; fallback does not change the saved order. RPC child notices use the existing notification channel; metadata-only audit entries exclude inputs and answers and do not enter model context.

Newly adding OpenAI to an order requires interactive confirmation of the Pro-credit precautions above; headless configuration cannot approve it. Reordering an already included OpenAI rung needs no new confirmation, but removing and later adding it again does. The dedicated `system1-openai` credential remains separate from subscription OAuth and generic OpenAI keys.

For ordinary requests the shell CLI returns one stdout JSON object with actual winner, order, attempts and aggregate usage; notices go to stderr. Exit 2 means invalid input and exit 1 whole-chain failure. Request-level model overrides require singleton Jev. Experimental TypeSafe `box`, `assets` and `long_context` remain supported only by the legacy helper under an explicit Jev-only chain; mixed chains reject them before calls. For ordinary mixed/OpenAI requests, `jev-ask` delegates to the installed common CLI without requiring a TypeSafe key first, and fails visibly if the CLI is missing.

System 1's classifier API failover is distinct from the subscription chat-model `/waterfall`. API credits, subscription windows, throttles and catalog-estimated costs are not interchangeable.

## Failures and evaluation

Operational failures can advance to the next configured backend; if the order is exhausted, each feature keeps its own policy: tool-gate and Sidebar fail closed; next-prompt vetting fails open; cache trimming keeps the original output, while strict quick compaction cancels and ordinary summary fallback remains available. Other integrations retain their documented fallbacks.

Historical Jev measurements describe Jev only; native Decisions has not thereby established equivalent calibration or latency. Live evaluations use the selected backend and may consume credits or incur charges; run them only with explicit authorization. Reported catalog-estimated usage cost is not an invoice or proof of which credits funded a request.
