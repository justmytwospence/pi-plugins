---
title: pi-prose-width
description: Wrap Pi's Markdown prose at a readable measure without squeezing fenced code blocks or tables.
plugin: pi-prose-width
---

## Quick reference

- **Use it for:** Keep paragraphs readable without squeezing code blocks or tables.
- **Enable:** Select `packages/pi-prose-width/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/prose-width [columns|off]`; no tool or shortcut.
- **Settings:** `PROSE_WIDTH`, then `~/.config/agents/prose-width.json`, then 80 columns; 0/off disables. Session commands are not saved.
- **Requirements, cost & privacy:** Compatible private Markdown hook; no external program, network or inference calls. Display-only, no file reformatting.
- **Integrations & limits:** Optional renderers using Pi Markdown inherit it. Wide code can keep enclosing containers wide; restart for a fully unpatched baseline.

## Purpose and rendering scope

`pi-prose-width` limits the reading width of Markdown prose while preserving the available width for content that benefits from longer lines. The default measure is **80 columns**. On a wide terminal, a paragraph wraps earlier, but a fenced command or a table can continue across the wider pane. On a terminal narrower than the configured measure, the terminal's available width still wins.

Entry: `packages/pi-prose-width/src/index.ts`. Enable it through [Install & select](/guides/install/). Every suite entry loads by default; selected entries share one Git pin. The entry is independently selectable even though its version is tied to the suite revision.

The implementation patches the shared `Markdown` component from Pi's TUI package. Consequently, the scope is not limited to assistant replies: it includes user messages, thinking, and extension content when those surfaces use that Markdown component. It does not impose a global terminal width on every widget, list, editor, or plain-text tool renderer.

Paragraphs, headings, text tokens, lists, and blockquotes receive the narrower measure when appropriate. Code, tables, rules, and other token types retain the width they were given. This is a display preference, not a formatter for files or stored responses. It does not insert newlines into the source message text, revise a generated document, or change the model's context. Use it to improve reading, not to enforce line-length rules on copied code.

## Requirements and costs

The extension performs local rendering work only. It uses no external executable, credentials, network service, model request, or paid classifier call. It does not require Herdr, another multiplexer, or any of the sibling suite entries. The configuration path is shared by convention with other prose-width integrations, but those integrations are not dependencies and need not be installed.

Compatibility depends on Pi's Markdown implementation. The package README records testing with **Pi 1.2.0**. The extension patches `Markdown.prototype.renderToken`, a private method outside the stable extension API. If that method is absent, loading throws `pi-tui's Markdown has no renderToken to patch`. This is intentionally different from silently claiming to have applied a measure when the renderer no longer exposes the needed hook.

The patch also wraps Markdown rendering to invalidate cached lines when the measure changes. It is installed once per process, with shared state updated on later loads. That avoids repeatedly nesting the same patch during a reload, but it means disabling the entry is not identical to restoring the original prototype in an already running process. `/prose-width off` bypasses the width restriction; a fresh Pi process is the clean baseline for testing without the entry.

There is no explicit operating-system check in the implementation. That absence is not a tested platform matrix. The relevant requirement is a compatible shared Pi TUI Markdown class; clients rendering their own Markdown elsewhere do not automatically inherit this behavior.

## Settings and session commands

The configured measure is resolved in this order: a valid `PROSE_WIDTH` environment value, then `width` in `~/.config/agents/prose-width.json`, then 80. There is no project-local settings layer in this implementation, and it does not relocate this file using `XDG_CONFIG_HOME`. A missing, unreadable, or invalid JSON file falls back to the default when no valid environment override exists.

A persistent file can contain:

```json
{
  "width": 72
}
```

For a single process, start Pi with an environment override:

```sh
PROSE_WIDTH=72 pi
```

The supported interactive surface is the `/prose-width` command:

| Command | Result |
| --- | --- |
| `/prose-width` | Report the current measure or that wrapping is off. |
| `/prose-width 72` | Use 72 columns for this running session. |
| `/prose-width off` | Disable the narrower prose measure. |
| `/prose-width 0` | Also disable the narrower prose measure. |

Session commands update shared rendering state and invalidate cached Markdown when the value changes. They do not write the configuration file or environment. Reloading the extension reads persistent configuration again, so do not expect an interactive override to become a saved preference.

The parser accepts finite nonnegative numeric values and floors fractional values. The literal `off`, numeric zero, and JSON `false` disable the measure. Invalid command arguments produce an error notification and leave the current measure unchanged; invalid environment values fall through to file configuration. Prefer an ordinary positive integer or `off` rather than relying on numeric coercion for unusual inputs.

## Exceptions, interactions, and troubleshooting

A wide list or quote is not necessarily a failure. The extension deliberately preserves full width for a prose container holding a table or sufficiently wide code. The code-width check compares code-line string length against the measure minus six, allowing room for formatting overhead. This can keep a whole enclosing list at the wider measure, including prose beside the protected content. It prioritizes keeping preformatted content usable over forcing every prose line to the same width.

If a paragraph does not visibly change, first compare the terminal's available width with the configured measure, then run `/prose-width` to inspect the active value. Check `PROSE_WIDTH` before editing the shared file, because a valid environment value takes precedence. If only a particular plugin's output remains wide, determine whether it uses the shared Markdown component or its own text renderer.

Other plugins may also patch or replace rendering behavior. This package does not guarantee compatibility with arbitrary Markdown prototype patches. For a clean comparison, use `/prose-width off`, or restart with the entry deselected when you need the original unpatched renderer. `pi-herdr-scrollbar-width` handles a different issue: the available terminal width at fullscreen exit, not prose measure.

Unit tests exercise paragraph and heading widths, lists and quotes, full-width code and tables, wide code inside lists, cache invalidation, and configuration precedence. They provide useful evidence for those cases, not a promise covering every nested Markdown construct or future Pi renderer. Include a small Markdown example, terminal width, active measure, and Pi version when reporting unexpected wrapping.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-prose-width)
