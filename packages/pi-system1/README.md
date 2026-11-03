# pi-system1

An ordered System 1 classifier waterfall for the suite and ad-hoc typed judgments. Jev alone remains the default. OpenAI Decisions uses the native Decisions API, not a chat model or generated confidence scores.

This document describes the approved waterfall target; commands and behavior require a compatible runtime and are not evidence of installation or rollout.

## Controls

The optional footer's `S1` value opens the same picker as `/system1`; there is no new global shortcut or footer row. `/system1 status` shows configuration and local capability/auth state without making a classifier request. The order lives in `$PI_CODING_AGENT_DIR/system1.json` (default `~/.pi/agent/system1.json`).

For a Jev rung, each feature retains its legacy provider/model overrides and discovery. The Decisions target is `system1-openai/gpt-6-luna`. Existing feature enable flags, thresholds and failure policies remain unchanged: selecting an order does not enable disabled features. Standalone consumers can still use Jev without this component. Decisions requires this component's native provider registration.

## OpenAI Decisions setup

Use `/login system1-openai` or `SYSTEM1_OPENAI_API_KEY` for the isolated API key. This provider exposes only the native `gpt-6-luna` classifier. It does not change chat providers, expose OAuth, use `OPENAI_API_KEY`, or reuse `openai`/Codex credentials. Its endpoint is fixed to the official `https://api.openai.com/v1/decisions` route.

Before activating Decisions, claim eligible [ChatGPT Pro API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) into the linked API organization, and confirm active included credits, no purchased balance, no auto-recharge, and no paid continuation. **Pi cannot verify which credit pool funds a request, balance, entitlement or quotas.** Local "configured" status is not a successful inference or proof of credits-only funding. Keep Jev selected until account setup is confirmed. Opening the picker, status or confirmation never probes the service or claims credits.

Unsupported hosts load cleanly with Jev alone. Operational failures can advance to another configured rung, subject to the rules below; a singleton order has no provider to fall back to.

## Typed judgments

`system1_judge` accepts evidence and independent native questions:

```json
{
  "state": { "claim": "A supplied claim", "evidence": "Supplied evidence" },
  "questions": {
    "supported": {
      "type": "bool",
      "instructions": "Does the evidence support the claim?",
      "criteria": { "true": "Supported", "false": "Not supported" }
    },
    "category": {
      "type": "choice",
      "instructions": "Choose the best category",
      "criteria": { "a": "Category A", "b": "Category B" }
    },
    "strength": {
      "type": "score",
      "instructions": "Rate the strength of support",
      "criteria": ["None", "Partial", "Strong"]
    }
  }
}
```

The read-only tool returns typed answers, configured order, actual backend/provider/model, selection key, latency and reported usage. Score values may be fractional zero-based rubric indices. Choice distributions and confidence come from the native classifier; nothing is fabricated. The tool judges evidence and never executes suggested actions. A failure is marked as a failed tool result and retains any reported usage; usage cost is a catalog estimate, not a verified invoice or free-credit debit. Live Decisions calibration against safety-critical suite policies remains separate from offline plumbing tests.

For shell integrations, pipe JSON into `node packages/pi-system1/bin/ask.mjs`. The bootstrap loads only the installed Pi SDK and this component, honors `PI_PACKAGE_DIR`, and never starts a chat session or project extensions. The CLI accepts legacy `noul` as bool and wraps nonobject legacy state under `input`. Exit codes are 0 for success, 1 for whole-chain or setup failure and 2 for invalid input. TypeSafe-only operations and model overrides are subject to the restrictions below.

## Ordered classifier failover

The picker offers four complete presets: `Jev → OpenAI`, `OpenAI → Jev`, `Jev only`, and `OpenAI only`. `/system1 jev` and `/system1 openai` remain singleton shortcuts; `/system1 order jev openai` and `/system1 order openai jev` select an order, with singleton forms and `openai-decisions` accepted as an alias. For example:

```json
{ "waterfall": ["jev", "openai-decisions"], "backend": "jev" }
```

`waterfall` is authoritative, nonempty, duplicate-free and limited to those two names; `backend` mirrors its first rung for old sessions. A missing file still means Jev only, and a legacy valid `backend` becomes a singleton. An invalid `waterfall` is an error even if `backend` is valid; unrelated JSON fields are preserved. Configuration is per agent directory, not automatically synchronized across machines.

Operational errors such as missing credentials, quota, throttling, unavailable models, transport errors, timeouts and malformed answers may advance to the next configured rung. A valid negative or uncertain result, safety refusal, disabled feature, invalid input, cancellation or configuration change does not. A failed partial batch is discarded and the next provider receives the complete question set. Feature-specific policies still govern whole-chain failure.

Credential, quota and unavailable-model failures cool the physical target for five minutes; rate-limit and transport failures for 30 seconds. Timeouts and invalid answers do not impose a target cooldown. At expiry, one request may retry the target; there are no background probes. `/system1 retry` resets cooldowns and cached failure state in the current Pi process only, without probing or changing the order. Other processes recover on their own cooldown or retry. Provider-failure, exhaustion and recovery notifications are deduplicated for 60 seconds, with repeat cooldown notices suppressed; ordinary cancellation and valid judgments do not warn.

The caller's timeout is one total deadline shared among runnable rungs, not a per-provider multiplier: each later runnable rung keeps a reserve of 700 ms (an even share when the deadline is shorter), and the preferred rung gets the rest. Multi-rung chains attempt each rung once. A singleton Jev chain may retain its optional one-time timeout retry within that same budget; host retries remain disabled. Decisions batches at most 400 questions.

Results identify the configured order and selection key separately from the actual winning backend, provider, model and target key, with fallback and sanitized attempt metadata. Reported usage is aggregated once across attempts; missing usage is unknown, not zero. Status distinguishes preferred order from the last actual route; the footer shows only the backend in use, and using a fallback does not change the saved order. RPC child notices travel through the existing notification channel, not model context, and metadata-only audit entries omit inputs and answers.

Newly including OpenAI requires interactive confirmation of the Pro-credit precautions above; headless configuration cannot provide consent. Reordering an already included OpenAI rung does not prompt again, but removing and later re-adding it does. The isolated `system1-openai` key and official endpoint remain required; subscription OAuth and generic OpenAI keys are not substitutes.

The CLI prints one JSON result on stdout with actual winner, order, attempts and aggregate usage, and notices on stderr; exit 2 remains invalid input and exit 1 whole-chain failure. A model override is allowed only for singleton Jev. TypeSafe `box`, `assets` and `long_context` remain legacy-helper features only under an explicit Jev-only chain; mixed chains reject them before calls. `jev-ask` delegates ordinary mixed/OpenAI requests to the installed common CLI without requiring a TypeSafe key first, and fails visibly if that CLI is unavailable.

This classifier API failover is separate from subscription chat-model `/waterfall`: API credits, subscription windows, throttles and catalog-estimated cost are different quantities.

## Development

```sh
npm ci
npm run check
```

Tests use temporary agent directories, fake registries and fake HTTP; no credentials or live inference are required. Shared helper, Herdr, footer-action and state contracts are package-local copies enforced by suite parity checks. No runtime sibling imports are needed.
