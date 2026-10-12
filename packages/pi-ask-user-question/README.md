# pi-ask-user-question

A Pi extension that gives the model an `ask_user_question` tool: up to four multiple-choice questions, answered in a Claude Code-style dialog at the bottom of the terminal, with the answers sent back in Claude Code's words. The parameters follow Claude Code's `AskUserQuestion` schema, with Claude Code's "Other" replaced by a `Type something.` row on every question.

The tool acts only when the model calls it. While the user is being asked, it holds `herdr:blocked` so Herdr shows the pane as blocked. Without a UI the tool is withdrawn from the model.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-ask-user-question/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-ask-user-question/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

It registers a tool named `ask_user_question`, so disable any other extension that registers the same name (for example `npm:@juicesharp/rpiv-ask-user-question`, or a standalone `pi-ask-user-question` checkout).

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-ask-user-question
```

If another configured extension already provides `ask_user_question`, add `-ne` so only this one loads. No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`).

## What the model sends and gets back

```json
{
  "questions": [
    {
      "question": "Which date library should we use?",
      "header": "Library",
      "multiSelect": false,
      "options": [
        { "label": "date-fns (Recommended)", "description": "Tree-shakeable functions", "preview": "```ts\nformat(d, 'yyyy')\n```" },
        { "label": "dayjs", "description": "Small, Moment-like API" }
      ]
    }
  ]
}
```

1-4 questions, 2-4 options each. Every question also gets a `Type something.` row for an answer in the user's own words, so options labelled `Other` or `Type something.` (any case, with or without the period) are rejected, as are duplicate questions and duplicate labels within a question; the model gets an error naming the problem. Headers are meant to be 12 characters or fewer; longer ones are cut with `…` on screen, never rejected. `preview` is Markdown and is shown for single-select questions only.

The answer comes back as Claude Code's text (example):

```
User has answered your questions: "Which date library should we use?"="date-fns (Recommended)". selected preview: ```ts
format(d, 'yyyy')
```. user notes: only if it stays small. You can now continue with the user's answers in mind.
```

Multi-select answers are the selected labels joined by `, ` (typed text counts as one more item). A question left blank on the Review tab reads `"…"="Unanswered"`. Declining gives `User declined to answer questions`. The tool result's `details` carry the questions and one structured answer per question (`kind`: `option`, `custom`, `multi` or `unanswered`, plus `selected`, `notes` and `preview`). The transcript shows one line per answer, or `Declined`.

## The dialog

It takes the place of the editor, like Claude Code's: the transcript stays visible above it. Several questions get a tab each (`■` answered, `□` not) and a Review tab; answering one moves to the next unanswered question, then to Review. A single question submits as soon as it is answered. Options with a preview show it in a box beside the list in terminals 100 columns or wider, below it otherwise, following the highlighted option.

| Key | Does |
|---|---|
| Your `tui.select.up`/`tui.select.down` keys, `k`/`j`, Ctrl+K/Ctrl+J | move, wrapping |
| 1-9 | highlight that row (does not choose it) |
| Enter (`tui.select.confirm`) | choose the highlighted option; on `Type something.` open the editor; in multi-select, finish the question (with nothing checked, the highlighted option alone) |
| Space | check or uncheck an option (multi-select); on `Type something.` open the editor if nothing is typed yet |
| `n` | add a note to the question's answer |
| Tab, Shift+Tab, Right, Left | next or previous question or Review (several questions only) |
| Esc (`tui.select.cancel`) | in an editor, leave it keeping the draft; otherwise decline the questionnaire |

In the `Type something.` and notes editors, Enter saves and Shift+Enter starts a new line. Saving typed text answers a single-select question, or checks the text and finishes a multi-select one. If the editor is showing autocomplete, or is a modal editor (from an editor provider, below) that is not in its normal mode, Esc goes to the editor first. On the Review tab, Enter submits and Esc declines; questions left blank are reported as unanswered. If the tool call is aborted, the dialog closes as declined.

## Hosts

- **Terminal UI**: the dialog above.
- **Other UI modes** (RPC clients such as Paseo, and subagent children whose dialogs pi-subagents forwards), or if the terminal dialog cannot be shown: one native dialog per question. Single-select is a select with the options numbered and `Type something.` last (then a text input); multi-select is a text input taking numbers like `1,3`, where anything that is not a list of valid option numbers is taken as a typed answer. Previews are added to the question text, cut to 600 characters each; notes are terminal-only. Dismissing any dialog declines.
- **No UI** (print and JSON modes): before each agent run the tool is removed from the active tool list, and put back when a UI is present again (only if this extension removed it, so a tool list another extension narrowed is left alone). A call that still arrives gets an error telling the model there is nobody to ask and not to retry.

## Configuration

There are no settings. Key bindings come from Pi's `tui.select.*` keybindings.

## Requirements and costs

Nothing external: no network access, no model calls, no files read or written.

## Optional integrations

- **Herdr**: while the user is being asked (terminal dialog or native dialogs), the tool emits `herdr:blocked` on Pi's event bus: `{ active: true, label }` when the dialog opens and `{ active: false }` when it closes, however it closes. The label is the question headers (or questions) joined by ` · `, cut to 60 characters. Herdr's Pi integration shows the pane as blocked for as long as the hold lasts. Outside Herdr nothing listens.
- **Editor providers** (for example pi-vim): the `Type something.` and notes editors ask for an editor on the `pi-plugins.editor-factory.v1` event channel; a provider that answers supplies the editor, otherwise Pi's standard editor is used.
- **pi-subagents**: forwards a subagent child's native dialogs to you.
- **pi-tool-gate**: `ask_user_question` is on its default allow list.

## Limitations

- Only one extension can own the `ask_user_question` name; see [Install](#install).
- Notes and Markdown previews in a side box need the terminal UI.

## Development

```sh
cd packages/pi-ask-user-question
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the vitest unit tests. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
