---
title: Manage context & cost
description: Use cache warnings, reasoning levels and usage measurements without mistaking estimates for guarantees.
---
**Use:** [pi-cache-guard](/plugins/pi-cache-guard/) and optionally [pi-status-footer](/plugins/pi-status-footer/).

## Start with observation

```text
/cache-guard status
/status details
```

Use only the commands for plugins you enabled. The footer can put the cache clock on the context row and show native reasoning. Without it, cache guard still publishes its own status.

Keep the distinctions clear:

- **Context usage** estimates how much of the model window is occupied.
- **Cache reuse** describes the last measured request, not the next one.
- **Cache time left** is based on request timing and known TTL, not direct access to the provider’s cache.
- **Cost** is the reported token-price estimate, not a subscription invoice or classifier API credit balance. Subscription windows and throttles are separate measurements.
- **Quota used** is account-level data, when available and fresh.

## Decide when the cache is cold

After enough idle time, a large conversation can be expensive to write into the cache again. Cache guard holds a user prompt when the conversation it would re-cache reaches `warn.minTokens` (default 100,000; `0` always asks). The question counts tokens, not dollars. Unknown TTLs use an idle-time warning instead of a guaranteed expiry claim.

The menu lets you send, stop asking for the session, compact, start fresh or keep the prompt in the editor. Esc keeps the text without sending. Images attached to a held prompt are not restored to the editor.

Choose based on the work:

- **Send** when the detailed history is still useful.
- **Compact with a summary** when the story and reasoning need explaining.
- **Compact quickly** when an assembled selection of exact requirements, decisions and file notes is enough.
- **Start fresh** when the next request is independent.

The classifier `/system1` order is separate from `/waterfall`, which routes subscription chat models. A chat model switch can also make the cache cold. System/tool changes and other invalidations are not all visible to the clock.

## Enable classifier features deliberately

Cache guard’s warnings and clock work without a classifier. Its optional trimming and fast compaction send tool output or conversation items to a classifier provider. To keep those off, use your Pi-specific `~/.pi/agent/cache-guard.json`:

```json
{
  "jev": { "enabled": false }
}
```

Use `/system1` to choose the global classifier order: Jev only is the default; either native classifier can be used alone or in an ordered Jev/OpenAI Decisions chain. Operational failures can advance to the next configured provider, with a notification; `/system1 status` shows the recent route. `/cache-guard jev` remains a compatibility alias for classifier setup and status; opening it does not itself run a paid connectivity probe. Configure credentials in Pi, not in the site or project docs. Decisions requires a separate API key and billing setup; see [Requirements & costs](/guides/requirements/) before selecting it.

Tool trimming runs before results enter context and points to a saved full-output file. Asking for the same output again in the turn can return it untrimmed. Nested codemode calls are not trimmed by this path. A compacted history is still lossy; inspect important exact values before discarding the originals.

## Let effort follow the work

Effort is selected at task and Linked phase boundaries, not on every message or during a run. Manual changes govern the current phase; approved implementation effort is applied without reclassification. Quota can influence automatic choices at those boundaries, but telemetry alone never changes effort. See [Choosing effort](/guides/effort/) for precedence, failure behavior and configuration.

Cache guard preserves supported deliberate effort changes in request history using cache-safe `configuration_update` transport. It does not select effort, and disabling cache warnings does not disable this transport.

## Warming belongs to Pi

Cache guard does not implement keep-warm calls. Pi’s own setting controls them in `~/.pi/agent/settings.json`:

```json
{
  "cacheWarming": "idle"
}
```

Warming resends a request with a very small output cap and **can cost money**. It is not a free timer refresh. Pi decides whether expected savings justify warming; `/session` shows its decision. Do not assume every model or provider supports the same cache behavior.

## Know where quota data came from

The status footer can query Claude and Codex account usage using Pi’s own subscription logins. Without a Pi Claude subscription login, it reads a shared Claude Code OAuth usage cache instead, whose account may be different from the account Pi bills. Unknown/stale data stays marked as such.

Use `/status native` for Pi’s own footer or `/status all` to keep the other subscription account visible. Neither a pretty gauge nor a low token-price estimate guarantees headroom in your subscription.
