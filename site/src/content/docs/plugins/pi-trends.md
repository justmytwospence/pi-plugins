---
title: pi-trends
description: Chart context %, effort level, tokens, cost, tool calls and duration per model call, as a toggleable sparkline widget and a /trends overlay.
plugin: pi-trends
---

## Quick reference

- **Use it for:** See how the session evolved, model call by model call: context growth, effort changes (including pi-auto-effort's), token and cost spikes, tool-heavy or slow calls.
- **Enable:** Select `packages/pi-trends/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/trends` opens the chart overlay; `ctrl+shift+g` or `/trends widget [on|off]` toggles the one-line sparkline widget.
- **Settings:** Optional `~/.pi/agent/pi-trends.json` (project `.pi/pi-trends.json` overrides): `widget` (show at startup, default `false`), `shortcut` (default `ctrl+shift+g`, or `"off"`), `placement` (`belowEditor` default, or `aboveEditor`).
- **Requirements, cost & privacy:** No external dependency or inference calls. Reads the session locally and adds nothing to model context.
- **Integrations & limits:** Complements [pi-status-footer](/plugins/pi-status-footer/) and [pi-context](/plugins/pi-context/). Non-TUI modes get a plain-text report.

## Purpose

Each point is one model call (one assistant response). A prompt (your message) usually triggers several calls, one per tool round; a `prompts` axis under the charts marks where each prompt starts. For every call pi-trends records the context fill after the response, the thinking level in effect, its input/output/cache tokens and cost, the tool calls it made, and its duration including those tools. History is rebuilt from session entries, so it survives resume, reload, `/tree` and compaction (calls after a compaction are marked).

Example widget (illustration, not a screenshot):

```
ctx ▁▂▃▄▆▂▃ 31%  effort ▄▄▆▆▄▂▂ medium  cost ▂▃█▄▂▁▂ $2.64  new ▂▃█▄▂▁▂ 323k · 71 calls/3 prompts
```

## Keys and modes

| Where | Keys |
| --- | --- |
| Overlay | `←`/`→` (or `h`/`l`) move the call cursor; `[`/`]` jump to the previous/next prompt; `shift+←/→` (`H`/`L`) jump 10; `Home`/`End` (`g`/`G`); `esc` or `q` closes. |
| Anywhere | `ctrl+shift+g` toggles the widget. |

## Reading the charts

All charts share one x-axis: each call gets the same horizontal slot in every chart, so a call lines up vertically. Under the charts, `┴` ticks and numbers mark where each prompt starts; the cursor's prompt is highlighted. Each chart's header shows the cursor call's value, then a session aggregate.

| Chart | Shape | Y-axis | Header |
| --- | --- | --- | --- |
| Context | Filled area (a level that persists between calls), coloured by fill: under 50%, under 80%, above | 0 to a round value just above the peak, so growth stays visible on 1M windows | Cursor %, peak, window size |
| Effort | Step line: levels change, they do not slide between values | One named row per level used | Cursor level, number of changes |
| New tokens | Bars (per-call events) | 0 to a round maximum | Uncached input + cache writes, output; session total. Cache reads are excluded because Context already shows them |
| Cost | Bars | 0 to a round maximum | Cursor cost, session total |
| Tool calls | Bars | 0 to the maximum | Cursor count, session total |
| Duration | Bars | Logarithmic, so one long `bg_wait` does not flatten the rest | Cursor duration, session total |

A cache miss shows up as a single spike in both New tokens and Cost.

The widget shows the current level for Context and Effort, and session totals for the rest.

## How it counts

- **Context %** is the response's input + cache read + cache write + output, divided by that model's context window from the model registry.
- **Effort** is the latest `thinking_level_change` before the call; before any such entry, the current level.
- **New tokens and cost** are the call's provider-reported usage.
- **Duration** runs from the previous message (your prompt or the last tool result) to the response, extended to the last result of the tools it called.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-trends)
