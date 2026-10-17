# pi-trends

Per-turn trends for a Pi session: context %, effort (thinking level), tokens, cost, tool calls and duration.

- `/trends` opens an overlay with a line chart per metric and a movable turn cursor (`←`/`→`, `shift+←/→`, `Home`/`End`, `esc`).
- `ctrl+shift+g` or `/trends widget [on|off]` toggles a one-line sparkline widget.

History is rebuilt from the current branch's session entries, so it survives resume, reload, `/tree` and compaction.

Settings (optional) in `~/.pi/agent/pi-trends.json`, overridden by `.pi/pi-trends.json`:

```json
{ "widget": false, "shortcut": "ctrl+shift+g", "placement": "belowEditor" }
```

Docs: https://pi-plugins.vercel.app/plugins/pi-trends/
