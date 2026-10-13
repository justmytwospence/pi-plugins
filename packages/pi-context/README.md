# pi-context

`/context` shows where Pi's context window goes: a usage bar and one row per part (system prompt, memory files, skills, tool definitions, tool results, conversation, other, free space), with a scrollable preview of each part as the model receives it.

Example of the dialog (illustration, not a screenshot):

```
╭──────────────────────────────────────────────────────────────╮
│ Context Usage  31.2k / 200k tokens (15.6%)              [esc]│
├──────────────────────────────────────────────────────────────┤
│ ████████▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│                                                              │
│ › ■ System prompt       2.1k    1.1%                         │
│   ■ Memory              1.4k    0.7%                         │
│   ■ Skills              0.9k    0.4%                         │
│   ■ Tools definition    6.3k    3.2%                         │
│   ■ Tool results       14.0k    7.0%                         │
│   ■ Context             5.8k    2.9%                         │
│   ■ Other               0.7k    0.3%                         │
│   ■ Free space          169k   84.4%                         │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ select · Enter or click to preview · [esc] close          │
╰──────────────────────────────────────────────────────────────╯
```

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-context/>.

Ported from the `/context` command of [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) (MIT, minuque), without that package's renderer.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-context/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component or pi-cc-extensions' `/context`: Pi does not deduplicate different packages that register the same command.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-context
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## Commands

| Command | Effect |
|---|---|
| `/context` | Open the usage dialog |

In the dialog: `↑`/`↓` or the mouse wheel select a row, `Enter` or a click opens its preview, `esc` or `ctrl+c` closes. In a preview: `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` and the wheel scroll, the scrollbar can be dragged, `esc` returns to the dialog. Mouse input reaches the dialog only where Pi enables mouse tracking (fullscreen mode); otherwise the keyboard does everything.

Outside the TUI (`pi --mode rpc` and friends) the command prints the same rows as a plain-text notification.

## How it counts

The breakdown follows the three things a request carries: the system prompt, the tool declarations, and the messages.

- System prompt: `ctx.getSystemPrompt()` at characters / 4, minus the memory files and the skills section when those are embedded in it (so a file is never counted twice). Memory is the `contextFiles` of the system prompt options (AGENTS.md and friends); Skills is the `<available_skills>` block as Pi rendered it.
- Tools definition: name, description and parameter schema of every selected tool whose declaration the request includes (hidden tools are left out).
- Tool results: `toolResult` and `bashExecution` messages, through Pi's own `estimateTokens`.
- Context: everything else in `sessionManager.buildContextEntries()`: user messages, assistant text, thinking and tool calls, compaction and branch summaries, custom messages.

The total shown is the usage Pi reports (`ctx.getContextUsage()`), reconciled with the estimate: the percentage wins when the reported count disagrees with it, and the content estimate wins when both are far below what the content alone must cost. The four fixed parts keep their exact counts; tool results and conversation are scaled proportionally when the reported total is smaller than the estimate. Other is the remainder; Free space is the window minus the total.

## Requirements and costs

Nothing external. It reads the session and the system prompt through the extension API and writes nothing.

## Development

```sh
cd packages/pi-context
npm ci
npm run check
```

`check` runs `tsc --noEmit` and then the Vitest suite (`vitest run`, `test/**/*.test.ts`). For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE); it carries the upstream copyright of minuque.
