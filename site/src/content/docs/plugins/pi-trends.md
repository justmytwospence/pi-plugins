---
title: pi-trends
description: Chart context %, effort level, tokens, cost, tool calls and duration turn by turn, as a toggleable sparkline widget and a /trends overlay.
plugin: pi-trends
---

## Quick reference

- **Use it for:** See how the session evolved: context growth, effort changes (including pi-auto-effort's), token and cost spikes, tool-heavy or slow turns.
- **Enable:** Select `packages/pi-trends/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/trends` opens the chart overlay; `ctrl+shift+g` or `/trends widget [on|off]` toggles the one-line sparkline widget.
- **Settings:** Optional `~/.pi/agent/pi-trends.json` (project `.pi/pi-trends.json` overrides): `widget` (show at startup, default `false`), `shortcut` (default `ctrl+shift+g`, or `"off"`), `placement` (`belowEditor` default, or `aboveEditor`).
- **Requirements, cost & privacy:** No external dependency or inference calls. Reads the session locally and adds nothing to model context.
- **Integrations & limits:** Complements [pi-status-footer](/plugins/pi-status-footer/) and [pi-context](/plugins/pi-context/). Non-TUI modes get a plain-text report.

## Purpose

A turn starts at a user message and runs until the next one. For each turn on the current branch, pi-trends records the context fill after the last response, the thinking level in effect, summed input/output/cache tokens and cost, the number of tool calls and the wall time. History is rebuilt from session entries, so it survives resume, reload, `/tree` and compaction (turns after a compaction are marked).

Example widget (illustration, not a screenshot):

```
ctx ▁▂▃▄▆▂▃ 31%  effort ▄▄▆▆▄▂▂ medium  tok ▂▃█▄▂▁▂ 48k  cost ▂▃█▄▂▁▂ $0.041
```

## Keys and modes

| Where | Keys |
| --- | --- |
| Overlay | `←`/`→` (or `h`/`l`) move the turn cursor; `shift+←/→` (`H`/`L`) jump 10; `Home`/`End` (`g`/`G`); `esc` or `q` closes. |
| Anywhere | `ctrl+shift+g` toggles the widget. |

The overlay draws one braille line chart per metric (2x4 dots per cell, so twice as many turns as columns fit before it scrolls), with a vertical cursor on the selected turn and its full details on the bottom line. Context bars are coloured by fill (under 50%, under 80%, above).

## How it counts

- **Context %** is input + cache read + cache write + output of the turn's last assistant response, divided by that model's context window from the model registry.
- **Effort** is the latest `thinking_level_change` before the response; before any such entry, the current level.
- **Tokens and cost** sum every assistant response in the turn, from provider-reported usage.
- **Duration** runs from the user message to the turn's last entry.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-trends)
