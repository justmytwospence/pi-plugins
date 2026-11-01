# pi-system1

One System 1 classifier selection for the suite and ad-hoc typed judgments. Jev remains the default. OpenAI Decisions uses the native Decisions API, not a chat model or generated confidence scores.

## Controls

- `/system1` opens the explicit backend picker.
- `/system1 status` shows the backend, physical target, global configuration path and local capability/auth state. It does not make a classifier request.
- `/system1 jev` selects Jev.
- `/system1 openai` checks local setup and asks for the same billing confirmation as the picker. Headless activation is refused.
- The optional footer's `S1` value opens the same picker. There is no new global shortcut or footer row.

Selection lives only in `$PI_CODING_AGENT_DIR/system1.json` (default `~/.pi/agent/system1.json`). A missing file selects Jev; malformed or unreadable configuration is unavailable, not a fallback. Writes preserve unrelated future JSON keys. Sessions using the same agent directory share this choice; it is not automatically synchronized between machines.

In Jev mode, each feature retains its own legacy provider/model overrides and discovery. In Decisions mode, the target is always `system1-openai/gpt-6-luna`. Existing feature enable flags, thresholds and failure policies remain unchanged: selecting a backend does not enable disabled features. Standalone consumers can still use Jev without this component. Decisions requires this component's native provider registration.

## OpenAI Decisions setup

Use `/login system1-openai` or `SYSTEM1_OPENAI_API_KEY` for the isolated API key. This provider exposes only the native `gpt-6-luna` classifier. It does not change chat providers, expose OAuth, use `OPENAI_API_KEY`, or reuse `openai`/Codex credentials. Its endpoint is fixed to the official `https://api.openai.com/v1/decisions` route.

Before activating Decisions, claim eligible [ChatGPT Pro API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) into the linked API organization, and confirm active included credits, no purchased balance, no auto-recharge, and no paid continuation. **Pi cannot verify which credit pool funds a request, balance, entitlement or quotas.** Local "configured" status is not a successful inference or proof of credits-only funding. Keep Jev selected until account setup is confirmed. Opening the picker, status or confirmation never probes the service or claims credits.

Unsupported hosts load cleanly in Jev mode. Missing credentials/provider, invalid answers, exhausted credits and other classifier failures do not trigger another model or provider. Decisions calls have one end-to-end deadline, zero automatic retries and sequential batches of at most 400 questions. Jev retains its one wrapper timeout retry, which callers can disable with `retryTimeout: false`; host classifier retries are disabled for both.

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

The read-only tool returns typed answers, actual backend/provider/model, selection key, latency and reported usage. Score values may be fractional zero-based rubric indices. Choice distributions and confidence come from the native classifier; nothing is fabricated. The tool judges evidence and never executes suggested actions. A failure is marked as a failed tool result and retains any reported usage; usage cost is a catalog estimate, not a verified invoice or free-credit debit. Live Decisions calibration against safety-critical suite policies remains separate from offline plumbing tests.

For shell integrations, pipe JSON into `node packages/pi-system1/bin/ask.mjs`. The bootstrap loads only the installed Pi SDK and this component, honors `PI_PACKAGE_DIR`, and never starts a chat session or project extensions. The CLI accepts legacy `noul` as bool and wraps nonobject legacy state under `input`. Exit codes are 0 for success, 1 for classifier/setup failure and 2 for invalid input. Decisions rejects TypeSafe-only `box`, `assets`, `long_context` and request-level model overrides without making a model request.

## Development

```sh
npm ci
npm run check
```

Tests use temporary agent directories, fake registries and fake HTTP; no credentials or live inference are required. Shared helper, Herdr, footer-action and state contracts are package-local copies enforced by suite parity checks. No runtime sibling imports are needed.
