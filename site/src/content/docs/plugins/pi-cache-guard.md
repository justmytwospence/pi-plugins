---
title: Cache guard
description: Review expensive cache misses and optionally reduce tool output and conversation history with Jev.
plugin: pi-cache-guard
---

## Quick reference

- **Use it for:** Review expensive cold-cache sends; optionally trim large tool output or compact history.
- **Enable:** Select `packages/pi-cache-guard/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/cache-guard` status/compact/jev/fresh/on/off. No global shortcut; warning dialog keys below.
- **Settings:** `cache-guard.json` shared/user/project layers; warning threshold 100,000 tokens, idle heuristic 180 min for providers with no documented cache lifetime.
- **Requirements, cost & privacy:** Optional paid Jev sends output/history excerpts; summaries use model tokens. Full trimmed output is saved locally. Warnings and clock work without Jev.
- **Integrations & limits:** Optional footer/Herdr; other extensions can offer models in the dialog (`cache:model-offers`, `cache:model-choice`). `/cache-guard off` disables warnings, not classifier trimming. No cache warming; Pi owns warming and its costs.

Cache guard gives you a choice before sending a prompt that is likely to re-cache an expensive conversation. Its clock and warnings work without a classifier. Optional Jev features trim incoming tool output and help compact history.

## Enable and requirements

Use [Install & select](/guides/install/) with `packages/pi-cache-guard/src/index.ts`. The suite enables every entry by default; selected components share one Git pin. Interactive dialogs need a UI. Jev features require Pi 0.99 or newer, classifier credentials and permission to send conversation excerpts to that provider.

**Jev is paid**, including the connectivity check performed by `/cache-guard jev`. A summary produced by Pi also uses the configured summarization model. The menu counts conversation tokens, not classifier requests: "no summary model" does not mean the classifier is free. See [Cache and cost](/recipes/cache-cost/) before enabling automated context reduction.

## Decide what to send

The warning threshold is `warn.minTokens`: the dialog appears when a cold cache would re-send at least that many tokens (default 100,000; `0` asks on every cold cache). It counts tokens rather than dollars for every model, and `warn.minCost` is ignored in Pi. Anthropic's clock uses five minutes, or one hour with `PI_CACHE_RETENTION=long`. OpenAI's API on GPT-5.6 and later uses the `prompt_cache_options.ttl` each request sends (30 minutes by default, 12 hours for `"12h"`), also a guaranteed minimum. The rest of OpenAI (the Codex backend, ChatGPT sign-ins, older models) uses `prompt_cache_retention`, which guarantees nothing: the clock shows an estimate (`cache ~12:00`) of the documented typical lifetime (about 30 minutes for `24h`, 10 for `in_memory`) and then calls the cache probably cold. For providers with no documented lifetime, the default three-hour idle threshold describes a possible miss rather than a certain expiry. A model switch can also trigger a warning.

The dialog lets you send, send and stop asking for the session, compact first, open a linked fresh session, or keep the prompt in the editor. With Jev available, classifier-only compaction and a conventional summary are separate choices. Enter defaults to sending; Esc keeps the prompt. The headline and option labels give the tokens each path re-sends uncached.

When another extension offers models, the dialog also offers to send on one of them: a miss re-caches the conversation whatever the model, so switching then loses no warm cache. An offer marked recommended comes first, so Enter takes it, and the plain send is named after the current model; other offers follow the mute line. Taking one sends the prompt as a plain send does, and the extension that made the offer switches the model; cache guard never does. The dialog waits for offers at most 2.5 seconds, while it looks for Jev, and without offers it has no model lines. Example, with example model names:

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens.
Sending re-caches 601k tokens on any model; a summary reads up to 601k, a quick compaction none; a new session starts empty.
Recommended: Claude Sonnet 5.5 (routine change).
-> Send with Claude Sonnet 5.5 (recommended)
   Send with Claude Opus 5.5
   Send, and stop asking in this session
   Send with Claude Haiku 5.5 instead
   Compact quickly, then send (~1s)
   Compact with a summary, then send
   Start a new session with this prompt
   Keep the prompt in the editor
```

The dialog opens only in answer to a prompt you send, never on its own, so keystrokes and remote clients never land in a dialog they did not expect. When it holds a prompt, macOS plays `warn.sound` (default `Basso`; a name from `/System/Library/Sounds`, a file path, or `""` for silence) regardless of focus. Inside Herdr a notification names the project and the held prompt, and the pane shows as blocked. Elsewhere the terminal bell rings.

Commands, shell input, steering, running-agent follow-ups and extension-generated input are not held. Images attached to a held prompt are not restored to the editor: check attachments before resending.

## Commands and configuration

| Command | Effect |
| --- | --- |
| `/cache-guard` or `/cache-guard status` | Inspect the clock, next warning and Jev availability. |
| `/cache-guard compact [focus]` | Request Jev compaction; without Jev, offer Pi's summary. |
| `/cache-guard jev` | Check, configure, switch or disable the classifier. |
| `/cache-guard fresh` | Start a linked session using the editor's text. |
| `/cache-guard on` or `/cache-guard off` | Toggle warnings, clock and transcript notices for this session. |

Configuration merges from `~/.config/agents/cache-guard.json`, `~/.pi/agent/cache-guard.json`, `<project>/.agents/cache-guard.json`, then `<project>/.pi/cache-guard.json`. Later values win and objects merge. `$XDG_CONFIG_HOME` is honored for shared settings.

For warning-only operation, place this in `.pi/cache-guard.json`:

```json
{
  "enabled": true,
  "warn": {
    "enabled": true,
    "minTokens": 100000,
    "idleMinutes": 180
  },
  "jev": { "enabled": false }
}
```

`/cache-guard off` does **not** disable trimming or compaction; those follow settings. Set top-level `enabled` to `false` to disable everything, or `jev.enabled` to `false` to disable classifier work only.

With empty `jev.provider` and `jev.model`, discovery checks configured providers in order: TypeSafe, OpenRouter, Vercel AI Gateway, Cloudflare Workers AI and OpenCode. The direct default candidate is `typesafe/jev-latest`, using Pi's `TYPESAFE_API_KEY` or `/login typesafe`. `/cache-guard jev` saves its choices in `~/.pi/agent/cache-guard.json`; project overrides can still take precedence.

## Data sent and context reduction

Trimming sends the latest user request, assistant text, tool name, arguments and output blocks to Jev. Default thresholds are over 12,000 characters for supported command, MCP and web outputs, and over 50,000 for `read`. Large outputs are bounded before classification. Kept blocks retain their order, with head and tail lines and omission markers.

Full trimmed text is saved locally under `~/.pi/agent/cache-guard/tool-output/<session>/`; the result points to that file for rereading with `offset` and `limit`. Treat those files as potentially sensitive. Final codemode output is eligible for trimming at `trim.minChars`; intermediate nested results remain untouched so scripts can process them. Repeating the same trimmed call within the same turn returns the full result, and Jev can elect to keep everything.

Compaction sends textual conversation units and the current goal to Jev, in batches. It classifies units as verbatim, summarize or drop. Classifier-only compaction assembles a summary in code; it still sends history to a model for judgment, just not to a generative summarizer. Ordinary `/compact` and automatic threshold compaction can instead run Pi's summarizer on filtered history. Set `compact.filter` to `false` to leave those paths to Pi.

## Fallbacks, integrations and limits

If trimming cannot classify or save the full output, it leaves the content unchanged. A failed explicitly requested Jev compaction cancels rather than silently buying a conventional summary; a held prompt returns to the editor. Overflow recovery and ordinary filtered compaction fall back to Pi's compaction. Classifier requests already attempted may still incur charges.

[Status footer](/plugins/pi-status-footer/) optionally places the cache clock and `lean-context` savings estimate on its context row. With pi-herdr and Herdr present, the event-bus bridge can publish a `cache` pane token (a snowflake and `601k` when cold, an hourglass and `8m` in the last minutes before a big idle cache expires), plus `cache_expires` (the expiry, epoch ms) while an idle session's big warm cache has at most `herdr.expiringMinutes` (default 10) left, which herdr-plugins' agent-cycle sorts on; `herdr.enabled: false` disables that integration. Neither sibling is required. Other extensions can also read the cache from the `cache:state` event: `{ cold, tokens?, model? }`, emitted at session start, on every change (cold or warm, a new response, a model switch), and again before each prompt and at each agent start. `cold` is also true when nothing is cached yet; top-level `enabled: false` stops the event.

Model offers require a listener from another extension; Auto effort does not supply them. Model offers use two more events. Before the dialog opens, cache guard emits `cache:model-offers` with a mutable `{ text, tokens, offers: [] }` (the held prompt and the tokens the miss re-caches). A listener pushes into `offers`, synchronously during the emit, a promise of `{ model: "provider/id", label, recommended?, note? }[]` or undefined. Offers that arrive within 2.5 seconds are kept, minus malformed ones, the current model and repeats; only the first `recommended` offer counts as the recommendation, and a `note` appears in the question beside it. Once the dialog is answered, `cache:model-choice` carries `{ text, model }`: the chosen offer's `provider/id`, or `null` for any other answer, emitted whenever the dialog was shown. The listener applies the model itself. Names and types (`MODEL_OFFERS`, `MODEL_CHOICE`, `ModelOffer`, `ModelOffers`, `ModelChoice`) are exported from `src/index.ts`.

The dialog is Pi's own select, which wraps a long option onto a second row that phone clients cannot read, so every option fits 42 characters and the token counts and the recommendation's reason are in the question. herdr-web-ui and Collie read it at every width. See [remote clients](/guides/clients/).

This extension does not warm the cache itself. Pi's `cacheWarming` setting owns refresh requests and their costs. The clock cannot observe every invalidation, including system-prompt or tool changes, and a compacted summary is not lossless history. Consult [Troubleshooting](/guides/troubleshooting/) and the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-cache-guard) when actual behavior differs from an estimate.
