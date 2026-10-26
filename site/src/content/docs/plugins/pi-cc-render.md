---
title: pi-cc-render
description: Claude Code-style transcript rendering for Pi, with tool cards, grouped calls, rich diffs, compact thinking and a settings panel.
plugin: pi-cc-render
---

## Quick reference

- **Use it for:** Read compact tool cards, grouped calls, rich diffs and thinking summaries.
- **Enable:** Select `packages/pi-cc-render/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/ccstyle` panel/on/compact/off/status. No added global shortcut; stock Ctrl+O expands tool detail and collapsed thinking.
- **Settings:** `pi-cc-render.json`; CC mode and rich diffs by default. Panel changes save; feature toggles need `/reload`.
- **Requirements, cost & privacy:** TUI private hooks; fullscreen/SGR mouse for pointer features. No inference calls. Shiki is an optional component dependency but a regular root-suite dependency.
- **Integrations & limits:** Optional prose/Markdown/footer/context. Exclude self-rendered tools as needed; write wrapper yields to another owner. Do not load pi-cc-extensions too.

## Purpose and scope

`pi-cc-render` restyles Pi's transcript in the manner of Claude Code. Each tool call collapses to a one-line summary that expands on click or Ctrl+O. Consecutive tool calls are grouped into one card. `edit` and `write` results render as rich side-by-side or unified diffs. A `codemode` call shows its nested tool calls as a tree, including progress while the script is still running. When Pi hides thinking blocks (`hideThinkingBlock`), thinking is compacted to a short preview, the provider's latest reasoning summary becomes its title, and Ctrl+O (`app.tools.expand`) opens it in full along with the tool output, as Claude Code's Ctrl+O does. Hosts that draw their own chat with Pi's components, such as pi-sidebar, get the same through `setExpanded`. Output of `!` and `!!` commands is syntax-highlighted when its language is known: the file a reading command prints (`cat`, `head`, `bat`, `sed -n`), a diff (`git diff`, `git show`, `diff -u`), or JSON. After a run with two or more tool calls, a per-turn tool summary appears. New sessions open with a startup header. In fullscreen mode, cards react to hover, a click expands them, the mouse wheel scrolls, and a back-to-bottom button appears when you scroll up.

Example of a single card and a grouped card (illustration, not a screenshot):

```
  Read src/index.ts (offset=1, limit=40)
  ↳ 40 lines · click to show more

  Bash ls -la · Grep "renderToken" src · Edit src/index.ts (+3 -1)
  ↳ 3 tools · click to show more
```

Entry: `packages/pi-cc-render/src/index.ts`. Enable it through [Install & select](/guides/install/). Every suite entry loads by default, and one Git pin versions the selected components together. The suite manifest also registers two themes, `cc-dark` and `cc-light`. Choose either with `/theme` or the `theme` setting. An explicit selection that lists `themes` should include `packages/pi-cc-render/themes/cc-dark.json` and `packages/pi-cc-render/themes/cc-light.json` if you want them.

This component changes display only. It does not alter tool behavior, model context or stored messages. One exception concerns `write`: the component re-registers it on `session_start` with a wrapper that records the previous file contents, so it can show the change as a diff. If another extension already owns `write`, this component yields and shows a notice instead of a diff.

## Commands and settings

| Command | Effect |
| --- | --- |
| `/ccstyle` or `/ccstyle panel` | Open the settings panel, with Style, Features, UI, Diff and Thinking tabs. |
| `/ccstyle on` | Claude Code style with rich diffs (the default). |
| `/ccstyle compact` | One summary line per assistant round. Experimental. |
| `/ccstyle off` | Pi's native rendering. Diff settings still apply to `edit` and `write`. |
| `/ccstyle status` | Print the full configuration. |

Panel changes apply to the current transcript immediately and are saved. Feature toggles take effect after `/reload`.

Configuration lives in `~/.pi/agent/pi-cc-render.json`. `PI_CODING_AGENT_DIR` changes the directory. Every key is optional, and invalid values fall back to their defaults. The keys cover the mode, `excludeRenderers`, the agent summary, expanded input and output line limits, the expanded card background slot, summary clip length, the startup header, the wheel step, the diff layout (`auto`, `split` or `unified`), the diff indicators, the split threshold, collapsed diff lengths, word wrap, and the thinking title, preview and animation. The [package README](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-cc-render) lists every key with its default and range. This example keeps the default style but always uses unified diffs and leaves background tools to their own renderers:

```json
{
  "diffViewMode": "unified",
  "excludeRenderers": ["bg_run", "bg_wait", "bg_logs", "bg_kill", "subagent"]
}
```

The file name differs from pi-cc-extensions' `pi-cc-extensions.json`, which this component does not read.

## Requirements and costs

The component makes no model or classifier calls and uses no network service, credentials or external executable. It reads its configuration at load time and writes it when the panel changes a value. Diff syntax highlighting loads `@shikijs/cli` lazily, and only when it can be resolved. It is an optional dependency of this component, but the root suite lists it as a regular dependency. Without it, diffs keep the theme colors but lose syntax highlighting. Hover, click and wheel support need fullscreen mode and a terminal that reports SGR mouse events. In regular mode, Ctrl+O and the keyboard remain available.

The renderer patches private members of Pi's coding-agent and TUI packages: `ToolExecutionComponent`, `AssistantMessageComponent`, and the interactive mode's render path. In the TUI, it also wraps terminal input to see mouse packets. The patches go into a process-wide registry, so `/reload` replaces them instead of stacking them. If a Pi release renames one of these members, the affected feature stops working, but the rest of the extension keeps running. The package tests load the component through Pi 1.2.0's resource loader. They cover configuration, diff and summary rendering, renderer gates and the startup header. These tests do not drive a live terminal.

## Interactions and coexistence

A tool whose extension supplies its own `renderCall`, `renderResult` or `renderShell: "self"` is still restyled unless its name appears in `excludeRenderers`. Suite components that draw their own tool output, such as [pi-bg](/plugins/pi-bg/), [pi-subagents](/plugins/pi-subagents/) and [pi-ask-user-question](/plugins/pi-ask-user-question/), belong there. The panel's exclude entry toggles common names, and you can add any name to the file. The `Agent` tool always keeps its dedicated renderer. An exclusion only affects display. It never disables a tool.

Pi's `Markdown` component is not patched, so [pi-prose-width](/plugins/pi-prose-width/) still sets the measure inside thinking, assistant messages and the agent summary. [pi-markdown-extras](/plugins/pi-markdown-extras/) adds diagrams and admonitions independently. The footer is left to Pi or [pi-status-footer](/plugins/pi-status-footer/), and [pi-context](/plugins/pi-context/) provides `/context`.

**Do not enable pi-cc-extensions alongside this component.** Both patch the same Pi components and register `/ccstyle`, and Pi does not deduplicate different packages. pi-cc-extensions is superseded by this component, [pi-markdown-extras](/plugins/pi-markdown-extras/), [pi-context](/plugins/pi-context/), the working row and MCP chip in pi-status-footer, and `@run:` references in pi-subagents. Its `/clear` and `/exit` aliases are covered by [pi-clear-screen](/plugins/pi-clear-screen/). Its configuration keys for those features are ignored here.

## Origins and license

This component is a port of [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 0.9.10 by minuque, used under the MIT License. Only the renderer and its companions are carried over. Compact thinking is a fork of pi-compact-thinking by tifandotme (MIT). The rich diff renderer is adapted from pi-tool-display by MasuRii (MIT). The component's `LICENSE` and the diff renderer's `ATTRIBUTION.md` keep those notices.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-cc-render)
