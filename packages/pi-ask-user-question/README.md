# pi-ask-user-question

A Pi extension that gives the model an `ask_user_question` tool: up to four multiple-choice questions (plus follow-ups shown only for certain answers), answered in a Claude Code-style dialog at the bottom of the terminal, with the answers sent back in Claude Code's words. The parameters follow Claude Code's `AskUserQuestion` schema, with Claude Code's "Other" replaced by a `Type something.` row on every question.

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

1-4 questions, 2-4 options each. A question with `showIf` is a follow-up, asked only when an earlier question was answered with one of the listed options: `"showIf": { "header": "Auth", "answers": ["OAuth"] }` names that question by its header and lists its option labels (for a multi-select question, selecting any of them counts; typed answers never match). A follow-up of a hidden follow-up stays hidden. With follow-ups a call can hold up to 6 questions, still at most 4 without `showIf`. A `showIf` that does not name exactly one earlier question by header, or lists a label that question does not offer, is rejected. Every question also gets a `Type something.` row for an answer in the user's own words, so options labelled `Other` or `Type something.` (any case, with or without the period) are rejected, as are duplicate questions and duplicate labels within a question; the model gets an error naming the problem. Headers are meant to be 12 characters or fewer; longer ones are cut with `…` on screen, never rejected. `preview` is Markdown and is shown for single-select questions only.

The answer comes back as Claude Code's text (example):

```
User has answered your questions: "Which date library should we use?"="date-fns (Recommended)". selected preview: ```ts
format(d, 'yyyy')
```. user notes: only if it stays small. You can now continue with the user's answers in mind.
```

Multi-select answers are the selected labels joined by `, ` (typed text counts as one more item). A question left blank on the Review tab reads `"…"="Unanswered"`. A follow-up that was never shown is left out of the text. Declining gives `User declined to answer questions`. The tool result's `details` carry the questions and one structured answer per question (`kind`: `option`, `custom`, `multi`, `unanswered`, or `skipped` for a follow-up that was never shown, plus `selected`, `notes` and `preview`). The transcript shows one line per answer, or `Declined`.

## The dialog

It takes the place of the editor, like Claude Code's: the transcript stays visible above it. Several questions get a tab each (`■` answered, `□` not) and a Review tab; answering one moves to the next unanswered question, then to Review. A follow-up gets its tab (and its Review row) only while the answer it depends on calls for it, so it appears as soon as that answer is chosen and disappears again if the answer changes (anything already entered in it is kept, but not reported while it is hidden). A single question submits as soon as it is answered. Options with a preview show it in a box beside the list in terminals 100 columns or wider, below it otherwise, following the highlighted option.

| Key | Does |
|---|---|
| Your `tui.select.up`/`tui.select.down` keys, Ctrl+K/Ctrl+J | move, wrapping; Ctrl+K/Ctrl+J also work from an open answer or note field, in any editor mode (a note is saved, an answer draft stays on its row) |
| `k`/`j`, 1-9 | navigate or highlight without choosing; on the free-text row, start typing an answer instead |
| Enter (`tui.select.confirm`) | choose the highlighted option; on `Type something.` open the editor; in multi-select, finish the question (with nothing checked, the highlighted option alone) |
| Space | check or uncheck an option (multi-select); on `Type something.` open the editor if nothing is typed yet |
| Typing or paste on `Type something.` | open the answer field and retain the first character, including `n`, `j`, `k`, or digits |
| `n` on an offered option, or Ctrl+G on any row | add a note to the question's answer |
| Tab, Shift+Tab, Right, Left | next or previous question or Review (several questions only) |
| Esc (`tui.select.cancel`) | in an editor, leave it keeping the draft; otherwise decline the questionnaire |

Typing on `Type something.` opens a `›` field under the options (titled Your answer) and the text also stays on that row in place of the label after you leave the field; `n` opens a Note field the same way, and a saved note shows under the question. Neither field has a box. Each option's description follows its label on the same line (`1. Apple · Crunchy`). A single-choice question ends in Pi's own key hint, the layout herdr-web-ui reads Pi's dialogs by, so a phone gets the options as buttons and the fields as a text box. A multiple-choice question is laid out as OmO's ask_user_question form instead (`Ask user`, a tab bar ending in Submit, a ✓ column after the numbers (blank when unchecked, so the phone card stays clean) and a `choose any` cue in the title, a numbered `Other` option for a typed answer (ticking it asks for the text when the answer is committed, so a phone can type one too) with OmO's typed-answer row as a faint help line, and OmO's key hint), which herdr-web-ui shows as a checkbox card; there a number toggles its option, Backspace clears the checks, and Tab finishes a lone question. Ctrl+K on an empty field does nothing (it would otherwise leave it), since herdr-web-ui clears a field with Ctrl+K Ctrl+U. The dialog shows no mode badge; with a modal editor such as pi-vim, the cursor shape shows the mode. In the `Type something.` and notes editors, Enter saves and Shift+Enter starts a new line (Ctrl+J moves to the next row instead). A free-text answer needs no offered option, including in multi-select. Empty answer submission keeps the editor open with guidance. Saving typed text answers a single-select question, or checks the text and finishes a multi-select one. Free-text composition uses the full width, without an irrelevant preview box. If the editor is showing autocomplete, or is a modal editor (from an editor provider, below) that is not in its normal mode, Esc goes to the editor first. On the Review tab, Enter on Submit answers submits, Cancel or Esc declines; questions left blank are reported as unanswered. Unsaved answer/note drafts are shown on Review; Enter returns to the first unfinished field instead of silently dropping it. If the tool call is aborted, the dialog closes as declined.

## Hosts

- **Terminal UI**: the dialog above.
- **Other UI modes** (RPC clients such as Paseo, and subagent children whose dialogs pi-subagents forwards), or if the terminal dialog cannot be shown: one native dialog per question. Single-select is a select with the options numbered and `Type something.` last (then a text input); multi-select is a text input taking numbers like `1,3`, where anything that is not a list of valid option numbers is taken as a typed answer. Previews are added to the question text, cut to 600 characters each; notes are terminal-only. Follow-ups are asked only if the answers before them call for them. Dismissing any dialog declines.
- **No UI** (print and JSON modes): before each agent run the tool is removed from the active tool list, and put back when a UI is present again (only if this extension removed it, so a tool list another extension narrowed is left alone). A call that still arrives gets an error telling the model there is nobody to ask and not to retry.

## Configuration

There are no settings. Key bindings come from Pi's `tui.select.*` keybindings.

## Requirements and costs

Nothing external: no network access, no model calls, no files read or written.

## Optional integrations

- **Herdr**: while the user is being asked (terminal dialog or native dialogs), the tool emits `herdr:blocked` on Pi's event bus: `{ active: true, label }` when the dialog opens and `{ active: false }` when it closes, however it closes. The label is the question headers (or questions) joined by ` · `, cut to 60 characters. Herdr's Pi integration shows the pane as blocked for as long as the hold lasts. Outside Herdr nothing listens.
- **Editor providers** (for example pi-vim): the `Type something.` and notes editors ask for an editor on the `pi-plugins.editor-factory.v1` event channel; a provider that answers supplies the editor, otherwise Pi's standard editor is used. Opening or reopening a field requests Insert mode through the optional editor protocol. The footer shows modal state, `i` in Normal mode, and whether Enter uses an answer or saves a note.
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

`npm run check` runs `tsc --noEmit` and the vitest unit tests. Root `npm test` also checks composition with real native and Vim editors through regular/fullscreen TUI keyboard routing, including drafts, re-entry and custom-only multi-select. These component integration checks are not full session-lifecycle tests. Root `npm run check` additionally runs every component's check.

## License

MIT. See [LICENSE](./LICENSE).
