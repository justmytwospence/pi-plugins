---
title: pi-context
description: Open /context to see where the context window goes, with a usage bar, per-part token estimates and previews of what the model receives.
plugin: pi-context
---

## Purpose

`pi-context` adds one command, `/context`. It opens a dialog with a usage bar and one row per part of the request: system prompt, memory files, skills, tool definitions, tool results, conversation, other, and free space. From any row you can open a scrollable preview of that part as the model receives it. The dialog answers a practical question: what is filling the window right now, and is it something you control, such as a large memory file, many tool declarations, or long tool output?

Example of the dialog (illustration, not a screenshot; numbers are made up):

```
 Context Usage  31.2k / 200k tokens (15.6%)                [esc]
 ████████▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 › ■ System prompt       2.1k    1.1%
   ■ Memory              1.4k    0.7%
   ■ Skills              0.9k    0.4%
   ■ Tools definition    6.3k    3.2%
   ■ Tool results       14.0k    7.0%
   ■ Context             5.8k    2.9%
   ■ Other               0.7k    0.3%
   ■ Free space          169k   84.4%
```

Entry: `packages/pi-context/src/index.ts`. Enable it through [Install & select](/guides/install/). Every suite entry loads by default, and one Git pin versions the selected components together.

## Keys and modes

| Where | Keys |
| --- | --- |
| Dialog | `↑`/`↓` or the mouse wheel select a row; `Enter` or a click opens its preview; `esc` or `ctrl+c` closes. |
| Preview | `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` and the wheel scroll; the scrollbar can be dragged; `esc` returns to the dialog. |

Mouse input only reaches the dialog where Pi enables mouse tracking, which means fullscreen mode. Elsewhere, the keyboard does everything. Outside the TUI, for example in `pi --mode rpc`, the command prints the same rows as a plain-text notification.

## How it counts

The breakdown follows the three things a request carries: the system prompt, the tool declarations and the messages.

- **System prompt** is `ctx.getSystemPrompt()` at four characters per token. Memory files and the skills section are subtracted when they are embedded in it, so nothing is counted twice. Memory is the prompt's context files (AGENTS.md and similar). Skills is the `<available_skills>` block as Pi rendered it.
- **Tools definition** counts the name, description and parameter schema of every selected tool whose declaration the request includes. Hidden tools are left out.
- **Tool results** counts tool-result and bash-execution messages, using Pi's own `estimateTokens`.
- **Context** is everything else in the session's context entries: user messages, assistant text, thinking and tool calls, compaction and branch summaries, and custom messages.

The total is the usage Pi reports (`ctx.getContextUsage()`), reconciled with the estimate. When the reported count disagrees with the reported percentage, the percentage wins. When both are far below what the content alone must cost, the content estimate wins. The four fixed parts keep their exact counts. Tool results and conversation are scaled down proportionally when the reported total is smaller than the estimate. Other is the remainder, and Free space is the window minus the total. The per-part numbers are therefore **estimates**, not a provider's tokenizer output.

## Requirements and costs

The component needs nothing external and has no runtime dependencies. Pi supplies its peer packages. It reads the session and system prompt through the extension API, writes nothing, and makes no model, classifier or network requests. Opening the dialog does not add anything to the conversation or model context.

Unit tests cover the estimator, the system-prompt split without double counting, selected and declared tool definitions, scaling and reconciliation rules, and the plain-text report. A loader test registers the command, draws the dialog, opens a preview on Enter and on click, and closes on escape. These tests do not use a real terminal.

## Interactions and origins

`/context` complements [pi-status-footer](/plugins/pi-status-footer/)'s context gauge and [pi-cache-guard](/plugins/pi-cache-guard/)'s trimming. It shows the breakdown but does not trim or compact anything. See [Manage context and cost](/recipes/cache-cost/) for how these fit together.

This component is ported from the `/context` command of [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) by minuque, used under the MIT License, without that package's renderer. Its `LICENSE` keeps the upstream copyright. Do not also enable pi-cc-extensions' `/context` or another copy of this component. Pi does not deduplicate different packages that register the same command.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-context)
