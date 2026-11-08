# pi-model-waterfall

Starts new Pi sessions on the first eligible subscription model under quota. It is not a provider or virtual model: it uses `pi.setModel` once, when an interactive session starts (`startup` or `new`), then leaves model choice to you. It does nothing for resumed, forked or reloaded sessions, headless sessions, or when the command line names a model (`--model`, `-m`, `--provider`). The extension does not require the status footer.

The default order is Anthropic Opus 5.5, OpenAI Sol, then Google Antigravity Argon. A rung is skipped when any applicable window is at 95% used or more, or when quota is unknown, stale, reset-due or unreadable. The 95% waterfall threshold is a safety margin, not proof of actual 100% exhaustion or provider rejection. No API-key or pay-as-you-go fallback is permitted.

- **Anthropic:** Pi's own subscription OAuth; the all-models weekly window must be known, a 5h window binds when reported, and weekly limits scoped to another model (such as Fable) are ignored while one naming Opus binds.
- **OpenAI:** the signed-in Codex account's windows, and a blocked account (`limit_reached` or `allowed: false`) is skipped even below 95%.
- **Google:** shared Gemini 5h and weekly, Argon weekly and the exact low/medium/high Argon reasoning variant for the physical model's thinking level must all be known and below threshold. Argon is the only automatic Google candidate; healthy shared quota cannot rescue missing or exhausted Argon quota, and no other Google model or lower reasoning level is substituted.
- **Muse:** still supported for manual selection, favorites and explicit opt-in. Its signed-in CLI's usage gates the rung when configured; a window with no usage yet counts as available.

The session switches only if you have not changed model or sent a turn while quota was being read. It reports `Waterfall: started on <model> (skipped ...)`, or warns `Waterfall: no subscription under quota; staying on <model>` and keeps Pi's default. `/waterfall` shows the startup choice and active rungs' states (`available`, `exhausted` with its reset, `disabled` or `unknown`), assessed in the background from cached quota reads; it does not fetch quota or call a model. The same detached, credential-free `pi-plugins.model-waterfall.v1` snapshot is available to the footer and startup splash. An exhausted Google rung can name its blocking shared, model or variant quota; invalid or stale observations remain unknown.

## Configuration

Set `order` in `~/.pi/agent/model-waterfall.json` or `<cwd>/.pi/model-waterfall.json`. For example, to opt Muse in after the default three:

```json
{ "order": ["anthropic", "openai", "google", "muse-code"] }
```

A project order replaces the global order; a missing file or field retains the lower-precedence order. Entries must be unique supported provider IDs. An empty array disables automatic checks and selection. Malformed or unreadable configuration, invalid orders, duplicate or unknown IDs fail closed with no quota checks or selection; a valid explicit project order can override a global error. Configuration is resolved at session start and remains fixed for that session; new or reloaded sessions read it again.
