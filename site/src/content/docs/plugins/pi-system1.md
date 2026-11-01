---
title: System 1
description: Select a shared native classifier backend and request typed judgments without changing chat authentication.
plugin: pi-system1
---

## Quick reference

- **Use it for:** Selecting the suite's classifier backend and making ad-hoc typed judgments.
- **Enable:** Select `packages/pi-system1/src/index.ts` from the suite manifest.
- **Controls:** `/system1 [status|jev|openai]`; the Context-row System 1 chip opens the same picker when available.
- **Settings:** One global `$PI_CODING_AGENT_DIR/system1.json` (default `~/.pi/agent/system1.json`); absent means Jev.
- **Requirements, cost & privacy:** Classifier-capable Pi and credentials for the selected backend; requests send supplied evidence to that provider and can incur API charges. OpenAI requires separate API credentials and the billing precautions below.
- **Integrations & limits:** Applies to the suite's eight classifier integrations and `system1_judge`, not the chat model or arbitrary third-party extensions. Feature-specific switches and failure policies remain in force.

[Source: pi-system1](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-system1)

## Select a backend

`/system1` opens the picker, `/system1 status` shows the selection and local capability and authentication status, `/system1 jev` selects Jev, and `/system1 openai` offers OpenAI Decisions after an explicit billing confirmation. Opening the picker or checking status makes no model request. The footer chip shares this picker; it adds no footer row.

The global file stores `{"backend":"jev"}` or `{"backend":"openai-decisions"}`. It is shared by sessions using the same agent directory, not automatically across machines. A missing file defaults to Jev; malformed, unreadable or unsupported configuration makes the classifier unavailable rather than choosing another backend. There is no project override or automatic provider fallback.

In Jev mode, each feature's existing provider/model selection or discovery remains effective. In Decisions mode, the global selection overrides those legacy provider/model fields with `system1-openai/gpt-6-luna`. Existing per-feature disable flags, thresholds and timeouts still apply; changing the backend does not enable a disabled feature. Jev remains available to standalone integrations without pi-system1; Decisions requires the isolated provider registered by pi-system1.

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

Results contain typed answers, actual backend/provider/model, latency and reported usage. Bool answers contain a probability; choice answers include the selected label, its confidence and the label distribution; scores can be fractional, with confidence. The tool judges supplied evidence; it does not execute suggested actions. The legacy `jev-ask` shell helper follows the selected backend; Decisions rejects TypeSafe-specific experimental operations rather than emulating them. The `jev-judgments` skill can use `system1_judge` in Pi.

## Failures and evaluation

Unavailable credentials, model, quota or invalid answers produce a classifier failure, not a switch to another backend. Each feature keeps its own policy: tool-gate and Sidebar fail closed; next-prompt vetting fails open; cache trimming keeps the original output, while strict quick compaction cancels and ordinary summary fallback remains available. Other integrations retain their documented fallbacks.

Historical Jev measurements describe Jev only; native Decisions has not thereby established equivalent calibration or latency. Live evaluations use the selected backend and may consume credits or incur charges; run them only with explicit authorization. Reported catalog-estimated usage cost is not an invoice or proof of which credits funded a request.
