# pi-model-waterfall

Starts new Pi sessions on the first subscription model under quota. It is not a provider or virtual model: it uses `pi.setModel` once, when an interactive session starts (`startup` or `new`), then leaves model choice to you. It does nothing for resumed, forked or reloaded sessions, headless sessions, or when the command line names a model (`--model`, `-m`, `--provider`). The extension does not require the status footer.

The fixed order is Anthropic Opus 5.5, OpenAI Sol, Google Antigravity Argon, then Muse Wonder (`muse-code`, from pi-muse-bridge). A rung is skipped when any applicable window is at 95% used or more, or when its quota is unknown, stale or unreadable. No API-key or pay-as-you-go fallback is permitted.

- **Anthropic:** Pi's own subscription OAuth; the all-models weekly window must be known, a 5h window binds when reported, and weekly limits scoped to another model (such as Fable) are ignored while one naming Opus binds.
- **OpenAI:** the signed-in Codex account's windows, and a blocked account (`limit_reached` or `allowed: false`) is skipped even below 95%.
- **Google:** the exact Argon reasoning-variant quota, the shared Gemini windows and Argon's weekly window.
- **Muse:** the signed-in Muse CLI's usage. A window with no usage yet counts as available.

The session switches only if you have not changed model or sent a turn while quota was being read. It reports `Waterfall: started on <model> (skipped ...)`, or warns `Waterfall: no subscription under quota; staying on <model>` and keeps Pi's default. `/waterfall` shows the startup choice and every rung's state (`available`, `exhausted` with its reset, `disabled` or `unknown`), assessed in the background from cached quota reads; it does not fetch quota or call a model. The same detached, credential-free `pi-plugins.model-waterfall.v1` snapshot is available to the footer and startup splash.
