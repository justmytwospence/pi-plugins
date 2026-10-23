# pi-cc-render

Claude Code-style transcript rendering for Pi: one-line tool summaries that expand on click or Ctrl+O, consecutive tool calls grouped into a card, rich side-by-side or unified diffs for `edit` and `write`, a codemode call tree, compact thinking with the provider's summary as its title (when Pi hides thinking blocks; Ctrl+O opens it with the tool output, as in Claude Code), a per-turn tool summary, and a startup header. In fullscreen mode cards react to hover, click to expand, and a back-to-bottom button appears when you scroll up.

Example of a tool card and a grouped card (illustration, not a screenshot):

~~~
  Read src/index.ts (offset=1, limit=40)
  ↳ 40 lines · click to show more

  Bash ls -la · Grep "renderToken" src · Edit src/index.ts (+3 -1)
  ↳ 3 tools · click to show more
~~~

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-cc-render/>.

This component is a port of [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) by minuque (MIT). Only the renderer and its companions are included here; see [What is not included](#what-is-not-included).

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-cc-render/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": ["packages/pi-cc-render/themes/cc-dark.json", "packages/pi-cc-render/themes/cc-light.json"]
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. Do not also enable pi-cc-extensions: both patch the same Pi components and register `/ccstyle`.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-cc-render
```

Pi supplies the peer dependencies. Syntax highlighting inside diffs uses `@shikijs/cli` when it can be resolved from the package directory (it is an `optionalDependencies` entry, installed by `npm ci` in a checkout); without it diffs render with the theme colours only.

## Commands

| Command | Effect |
|---|---|
| `/ccstyle` or `/ccstyle panel` | Open the settings panel (Style, Features, UI, Diff, Thinking tabs) |
| `/ccstyle on` | Claude Code style with rich diffs (default) |
| `/ccstyle compact` | One summary line per assistant round (experimental) |
| `/ccstyle off` | Pi's native rendering; diff settings still apply to `edit`/`write` |
| `/ccstyle status` | Print the full configuration |

Panel changes apply to the current transcript immediately and are saved. Feature toggles apply after `/reload`.

## Themes

`cc-dark` and `cc-light` are registered through the package manifest; pick them with `/theme` or `theme` in `~/.pi/agent/settings.json`.

## Configuration

`~/.pi/agent/pi-cc-render.json` (`PI_CODING_AGENT_DIR` overrides the directory). The old `pi-cc-extensions.json` is not read. Every key is optional; invalid values fall back to the defaults shown.

```jsonc
{
  // style
  "mode": "on", // on / compact / off
  "excludeRenderers": [], // tools that keep their own renderer; Agent always does

  // features
  "enableAgentSummary": true, // per-turn tool summary after agent_end (2+ tools)
  "restoreInterruptedPrompt": true, // Escape before the model responds puts the prompt back in the editor

  // ui
  "expandedInputMaxLines": 5, // expanded tool Input lines; overflow shows a hint
  "expandedOutputMaxLines": 10, // expanded tool Output lines; overflow shows a hint
  "expandedPreviewMaxLines": 40, // max lines for expanded TaskList bodies
  "expandedCardBackground": "userMessageBg", // theme bg slot: userMessageBg, toolPendingBg, customMessageBg, selectedBg, searchMatchBg, toolSuccessBg, toolErrorBg
  "inputClip": 0, // path/command clip length in summaries; 0 = fit width, else 8..500
  "showStartupHeader": true, // logo and tips header on new sessions
  "scrollStepLines": 3, // fullscreen mouse wheel step (1..50)

  // diff
  "diffViewMode": "auto", // auto / split / unified
  "diffIndicatorMode": "bars", // bars / classic / none
  "diffSplitMinWidth": 120, // min terminal width for side-by-side columns (40..300)
  "editDiffCollapsedLines": 24, // edit body lines before the expand hint (1..500)
  "writeDiffCollapsedLines": 0, // write body lines; 0 = creation summary only (0..500)
  "diffWordWrap": true, // wrap long diff lines instead of truncating

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // latest provider summary as the thinking title
  "previewLines": 3, // thinking preview lines; 0 hides the body
  "animationIntervalMs": 90, // title animation interval
  "dimThinkingText": false // dim thinking body text
}
```

### Interrupted prompts

As in Claude Code, pressing Escape before the model has streamed anything (text, thinking or a tool call) puts the prompt that started the run back into the editor, so you can edit and resend it. Once output has started, Escape only interrupts. Only prompts typed in the interactive editor are restored, as text (attached images are not); steering and follow-up messages are already returned to the editor by Pi. If the editor then holds text (a restored queue or a draft typed during the run), the prompt goes before it, separated by a blank line.

The interrupted prompt stays in the transcript and the session, so resending it adds a second copy to the context.

## Coexisting with other tool renderers

A tool whose extension provides `renderCall`, `renderResult` or `renderShell: "self"` is still restyled unless its name is listed in `excludeRenderers`. Suite components such as pi-bg and pi-subagents that draw their own tool output should be listed there (the panel's Exclude tools entry toggles common names; any name can be added to the file). The `Agent` tool always keeps its dedicated renderer.

## How it works

The renderer patches Pi's `ToolExecutionComponent`, `AssistantMessageComponent` and the interactive mode's `doRender` on the shared class prototypes, and registers the patches in a process-wide registry so a `/reload` replaces rather than stacks them. In TUI mode it also wraps terminal input to see SGR mouse packets for hover, click and wheel.

`write` is re-registered on `session_start` with a wrapper that records the previous file content so the result can be rendered as a diff. If another extension already owns `write`, this component yields and shows a notice instead of a diff.

pi-tui's `Markdown` is not touched, so pi-prose-width's measure applies inside thinking, assistant messages and the agent summary. The footer is left to Pi or pi-status-footer.

## What is not included

Compared with pi-cc-extensions 0.9.10, this component does not include the custom footer, `/context`, `@` session and subagent references, the `/clear` and `/exit` aliases, the extended Working message, or the Markdown enhancements (Mermaid, admonitions, URL linking). Their configuration keys (`enableSessionReference`, `enableSubagentAutocomplete`, `enableContextCommand`, `enableWorkingMessage`, `enableAliases`, `enableCustomFooter`, `footer*`) are ignored.

## Requirements and costs

Nothing external. It reads `~/.pi/agent/pi-cc-render.json` at load and writes it when the panel changes a value. Diff syntax highlighting loads `@shikijs/cli` lazily and only when it is resolvable.

## Limitations

The patches rely on private members of pi-coding-agent and pi-tui; a Pi release that renames them disables the affected feature rather than the whole extension. Mouse interaction needs a terminal that reports SGR mouse events.

## Development

```sh
cd packages/pi-cc-render
npm ci
npm run check
```

`check` runs `tsc --noEmit` and then the Vitest suite (`test/**/*.test.ts`). The tests cover configuration, the diff and summary renderers, and a load through Pi 1.1.0's `DefaultResourceLoader`, with no model calls.

## License

MIT. See [LICENSE](./LICENSE), which carries the upstream notices for minuque (pi-cc-extensions), tifandotme (pi-compact-thinking) and MasuRii (pi-tool-display, see [ATTRIBUTION.md](./src/renderer/tool/diff/ATTRIBUTION.md)).
