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

`pi-cc-render` restyles Pi's transcript in the manner of Claude Code. Each tool call collapses to a one-line summary that expands on click or Ctrl+O. Consecutive tool calls are grouped into one card. `edit` and `write` results render as rich side-by-side or unified diffs. A `codemode` call shows its nested tool calls as a tree, including progress while the script is still running. When Pi hides thinking blocks (`hideThinkingBlock`), thinking is compacted to a short preview, the provider's latest reasoning summary becomes its title, and Ctrl+O (`app.tools.expand`) opens it in full along with the tool output, as Claude Code's Ctrl+O does. Hosts that draw their own chat with Pi's components, such as pi-sidebar, get the same through `setExpanded`. Output of `!` and `!!` commands is syntax-highlighted when its language is known: the file a reading command prints (`cat`, `head`, `bat`, `sed -n`), a diff (`git diff`, `git show`, `diff -u`), or JSON. A `bash` row says what the command does: its first-line `# description` comment, else a summary of the parsed command (a short one-liner stays as typed), and its expanded Input is the command formatted with shfmt and highlighted as bash. After a run with two or more tool calls, a per-turn tool summary appears. When startup details are shown, the native logo/tips header is suppressed and the startup listing shows Extensions, Context, Skills, Prompts and MCP, then an estimated occupied-context chart, then Models above the chat. In quiet/details-hidden mode, the listing and map are hidden. The collapsed Context, Skills, Prompts and Extensions listing is regrouped with counts and laid out in aligned columns: every section, MCP included, is split by level (project, then user, then path or extension; Context's levels sit side by side as columns), and inside a level local entries come before packages; Context and Skills also show an estimated token cost (a total on the heading, context files largest first with their own counts, and a count beside only the heaviest skills), and Ctrl+O reveals the full listing in the same styled layout. The Models section has one model per line under each provider with credentials, the providers in alphabetical ID order and side by side as Context's levels are, stacking ordered provider groups vertically in width-bounded columns: the provider's current generation (the newest version of every model family, leaving out `-latest` aliases, dated snapshots, billing lanes, image models and families a major version behind), plus the favorites from the model scope (`enabledModels` or `--models`, with any thinking level), marked by muted solid stars and listed first, and the current model highlighted in green. Each model shows its context window on the right in the units vendors quote (`1M`, `128K`, `922K`). The MCP section lists all configured servers, including disabled ones, with live states and tool counts (see [Startup splash](#startup-splash)). In fullscreen mode, cards react to hover, a click expands them, the mouse wheel scrolls, and a back-to-bottom button appears when you scroll up.

Example of a single card and a grouped card (illustration, not a screenshot):

```
  Read src/index.ts (offset=1, limit=40)
  ↳ 40 lines · click to show more

  Bash Run check (npm) in pi-cc-render · Grep "renderToken" src · Edit src/index.ts (+3 -1)
  ↳ 3 tools · click to show more
```

Generic tool arguments expand as labeled fields and ordered items, including literal multiline strings; collapsed agent rows use descriptions or honest generic labels rather than treating routing IDs as names. These are display changes only: tool arguments and literal result text remain unchanged. Tools can opt into their own call or result renderer with `ccstyleOwnCall` or `ccstyleOwnResult`; `excludeRenderers` still keeps selected tools entirely out of restyling.

Entry: `packages/pi-cc-render/src/index.ts`. Enable it through [Install & select](/guides/install/). Every suite entry loads by default, and one Git pin versions the selected components together. The suite manifest also registers two themes, `cc-dark` and `cc-light`. Choose either with `/theme` or the `theme` setting. An explicit selection that lists `themes` should include `packages/pi-cc-render/themes/cc-dark.json` and `packages/pi-cc-render/themes/cc-light.json` if you want them.

The context map and resource listings do not alter stored messages, prompt accounting or tool behavior. Clicking a model can switch the current session's model; clicking an MCP server opens Pi's native manager, where only an action you choose changes its state. One separate exception concerns `write`: the component re-registers it on `session_start` with a wrapper that records the previous file contents, so it can show the change as a diff. If another extension already owns `write`, this component yields and shows a notice instead of a diff.

## Startup splash

The chart's colored strip, after the resources and before Models in the startup listing, shows the **estimated composition of occupied context**, not a full-window treemap. Source categories include System text, loaded Files, advertised Skills, visible prepared Tools and MCP declarations, and retained History. File and skill text already included in System is attributed only once; unused full skill files, installed inventories and historical system messages are not added again. The splash's sections and chart share Pi's one-cell left inset. A proportional strip labels category segments above the bar and lists small categories in a key below. Within each category, contrasting shades show the largest source, second-largest source, and their combined remainder; each block prints its percentage of that category when the text fits. Sources too small to span four cells join the remainder, without artificial minimum widths, dark dividers or another chart row. MCP compares servers; other categories compare child sources. The "Small category totals" key below the strip lists amounts that did not fit above their segments, not extra context added to the estimate. The resource lists retain the detail. Source colors are separate from connection-state glyphs. One summary line shows the occupied estimate, its percentage of the selected model's total window, and the current model with its effort level when available. Unknown windows and over-capacity estimates are explicit. “Starting context” becomes “Context” once history is retained, and the map refreshes when the model, session or available tools change. It is **not measured prefill or provider billing**: later request hooks, provider-specific framing and unavailable hidden declarations limit the estimate. The strip is a non-input display above the chat, not an editor field or click target.

Models, Context and MCP use a balanced, width-aware column layout: ordered groups stack independently down each column, and long groups can split into subcolumns of at least two entries, including a single MCP scope. Skills, Prompts and Extensions use per-column widths so one long name does not waste space in every column. The collapsed splash measures terminal rows available after the editor, footer, existing chat, diagnostics and chart. It shows every list when possible; otherwise it folds only whole sections or subsections and marks them `+N hidden`. Ctrl+O reveals all entries in the same styled layout, with normal scrolling when necessary; `/model` and `/mcp` remain keyboard paths to hidden choices. A pane too short even for headings and diagnostics still scrolls. Provider groups are alphabetical by provider ID, with favorites first within a group. The Google splash group shows available subscription-backed Antigravity Gemini/Gemma with the `antigravity-` prefix hidden only in labels. Native Google API routes and cross-vendor Antigravity Claude/GPT routes stay out of this splash but remain available through native `/model` when authenticated. In fullscreen, an unmodified left click on a model selects it for the current session only (not the global default); a favorite's displayed thinking suffix applies after successful selection. Switching is refused during a running turn. `/model` remains the regular-mode keyboard path.

The MCP section lists all configured servers, including `enabled: false`, grouped by project, user and extension. Disabled server names are dim. In fullscreen, clicking a server announces its name and opens the native `/mcp` manager; Pi cannot automatically focus that server. The click does not toggle it, sign in or change configuration. Any action you explicitly choose in the native manager retains Pi's normal persistence behavior. The manager will not open from a click during a running turn; `/mcp` remains the regular-mode keyboard path.

| Marker | Meaning |
| --- | --- |
| Green `■` | Connected (including servers with zero tools) |
| Dim `□` | Disabled, disconnected, connecting or unknown (disabled names are dimmed) |
| Amber `□` | Needs sign-in |
| Red `□` | Failed |

Each MCP row has one square indicating connection state, not context inclusion. A connected row shows `N · ~X tok`: the live tool count and the estimated tokens in that server's directly visible prepared tool declarations, respectively. These are distinct measures and can differ; unavailable counts use `?`, and unavailable token estimates use `? tok`. Non-connected rows show neither metric. Individual rows exclude declarations that cannot be attributed to a server. When origin attribution is known, the MCP heading shows the estimated total, including unattributed MCP declarations; its category swatch corresponds to the chart, not connection state. Estimates are not provider billing.

Models use a muted `★` for favorites and a green highlight and `●` for the current model.

The MCP listing refreshes for as long as the splash exists, including late state, tool-count and configuration changes. Configuration files are stat-checked on polling ticks and parsed only when changed, never during rendering. This updates the display only: Pi still needs `/reload` to apply externally edited MCP configuration; the splash neither applies configuration nor connects servers. Compact warning/error icons and counts in the heading replace Pi's per-server startup warning while the section is shown; configuration warnings remain. Open the native manager for failure details. Use `/mcp` to resolve server problems.

Live state comes from Pi 1.2–1.4's built-in `/mcp` command, source-checked as `builtin:mcp`, through read-only argument completions and its non-TUI status projection. This relies on private text formats, not a public structured status API. Tool presence alone does not establish health: zero-tool and resource-only servers can be connected, and unavailable state is shown as `unknown`. Changes to Pi's projections can make live status unavailable.

## Commands and settings

| Command | Effect |
| --- | --- |
| `/ccstyle` or `/ccstyle panel` | Open the settings panel, with Style, Features, UI, Diff and Thinking tabs. |
| `/ccstyle on` | Claude Code style with rich diffs (the default). |
| `/ccstyle compact` | One summary line per assistant round. Experimental. |
| `/ccstyle off` | Pi's native rendering. Diff settings still apply to `edit` and `write`. |
| `/ccstyle status` | Print the full configuration. |

Panel changes apply to the current transcript immediately and are saved. Feature toggles take effect after `/reload`.

Configuration lives in `~/.pi/agent/pi-cc-render.json`. `PI_CODING_AGENT_DIR` changes the directory. Every key is optional, and invalid values fall back to their defaults. The keys cover the mode, `excludeRenderers`, the agent summary, expanded input and output line limits, `readableBash` and its bash input limit, the expanded card background slot, summary clip length, the startup header, the wheel step, the diff layout (`auto`, `split` or `unified`), the diff indicators, the split threshold, collapsed diff lengths, word wrap, and the thinking title, preview and animation. The [package README](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-cc-render) lists every key with its default and range. This example keeps the default style but always uses unified diffs and leaves background tools to their own renderers:

```json
{
  "diffViewMode": "unified",
  "excludeRenderers": ["bg_run", "bg_wait", "bg_logs", "bg_kill", "subagent"]
}
```

The file name differs from pi-cc-extensions' `pi-cc-extensions.json`, which this component does not read.

## Requirements and costs

The component makes no model or classifier calls and uses no network service, credentials or external executable. It reads its configuration at load time and writes it when the panel changes a value. Diff syntax highlighting loads `@shikijs/cli` lazily, and only when it can be resolved; bash formatting loads `sh-syntax` (shfmt compiled to WebAssembly) the same way, and without it commands are only broken one step per line. It is an optional dependency of this component, but the root suite lists it as a regular dependency. Without it, diffs keep the theme colors but lose syntax highlighting. Hover, click and wheel support need fullscreen mode and a terminal that reports SGR mouse events. In regular mode, Ctrl+O and the keyboard remain available.

The renderer patches private members of Pi's coding-agent and TUI packages: `ToolExecutionComponent`, `AssistantMessageComponent`, and the interactive mode's render path. In the TUI, it also wraps terminal input to see mouse packets. The patches go into a process-wide registry, so `/reload` replaces them instead of stacking them. If a Pi release renames one of these members, the affected feature stops working, but the rest of the extension keeps running. The package tests load the component through Pi 1.2.0's resource loader. They cover configuration, diff and summary rendering, renderer gates and the startup header. These tests do not drive a live terminal.

## Interactions and coexistence

A tool whose extension supplies its own `renderCall`, `renderResult` or `renderShell: "self"` is still restyled unless its name appears in `excludeRenderers`. Suite components that draw their own tool output, such as [pi-bg](/plugins/pi-bg/), [pi-subagents](/plugins/pi-subagents/) and [pi-ask-user-question](/plugins/pi-ask-user-question/), belong there. The panel's exclude entry toggles common names, and you can add any name to the file. The `Agent` tool always keeps its dedicated renderer. An exclusion only affects display. It never disables a tool.

Pi's `Markdown` component is not patched, so [pi-prose-width](/plugins/pi-prose-width/) still sets the measure inside thinking, assistant messages and the agent summary. [pi-markdown-extras](/plugins/pi-markdown-extras/) adds diagrams and admonitions independently. The footer is left to Pi or [pi-status-footer](/plugins/pi-status-footer/), and [pi-context](/plugins/pi-context/) provides `/context`.

**Do not enable pi-cc-extensions alongside this component.** Both patch the same Pi components and register `/ccstyle`, and Pi does not deduplicate different packages. pi-cc-extensions is superseded by this component, [pi-markdown-extras](/plugins/pi-markdown-extras/), [pi-context](/plugins/pi-context/), the working row and MCP chip in pi-status-footer, and `@run:` references in pi-subagents. Its `/clear` and `/exit` aliases are covered by [pi-clear-screen](/plugins/pi-clear-screen/). Its configuration keys for those features are ignored here.

## Origins and license

This component is a port of [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 0.9.10 by minuque, used under the MIT License. Only the renderer and its companions are carried over. Compact thinking is a fork of pi-compact-thinking by tifandotme (MIT). The rich diff renderer is adapted from pi-tool-display by MasuRii (MIT). The component's `LICENSE` and the diff renderer's `ATTRIBUTION.md` keep those notices.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-cc-render)
