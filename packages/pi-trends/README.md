# pi-trends

Per-model-call trends for a Pi session: context %, effort (thinking level), tokens, cost, tool calls and duration.

- `/trends` opens an overlay with a chart per metric (areas and step lines for levels, bars for per-call events, each on its own axis) a `prompts` axis, and a movable call cursor (`←`/`→`, `[`/`]` prompt, `shift+←/→`, `Home`/`End`, `esc`).
- `alt+g` or `/trends widget [on|off]` toggles a one-line sparkline widget.

History is rebuilt from the current branch's session entries, so it survives resume, reload, `/tree` and compaction.

Settings (optional) in `~/.pi/agent/pi-trends.json`, overridden by `.pi/pi-trends.json`:

```json
{ "widget": false, "shortcut": "alt+g", "placement": "belowEditor" }
```

Docs: https://pi-plugins.vercel.app/plugins/pi-trends/
