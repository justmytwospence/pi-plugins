# pi-ask-user-question

A [pi](https://pi.dev) extension that gives the model an `ask_user_question` tool: up to four
multiple-choice questions, answered in a Claude Code-style dialog at the bottom of the terminal,
with the answers sent back in Claude Code's words. While the dialog is open the pane shows as
blocked in [herdr](https://herdr.dev).

## What the model sends and gets back

The parameters are Claude Code's `AskUserQuestion` schema:

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

1-4 questions, 2-4 options each. Every question also gets a `Type something.` row for an answer
in the user's own words, so options labelled `Other` or `Type something.` are rejected, as are
duplicate questions and duplicate labels within a question. Headers are meant to be 12 characters
or fewer; longer ones are cut with `…` on screen, never rejected. `preview` is Markdown, shown for
single-select questions.

The answer comes back as Claude Code's text:

```
User has answered your questions: "Which date library should we use?"="date-fns (Recommended)". selected preview: ```ts
format(d, 'yyyy')
```. user notes: only if it stays small. You can now continue with the user's answers in mind.
```

Multi-select answers are the selected labels joined by `, ` (typed text counts as one more item);
a question left blank on the Review tab reads `"…"="Unanswered"`; Esc gives
`User declined to answer questions`. The tool result's `details` carry the questions and one
structured answer per question (`kind`: `option`, `custom`, `multi` or `unanswered`, plus
`selected`, `notes` and `preview`). The transcript shows one line per answer.

## The dialog

It takes the place of the editor, like Claude Code's: the transcript stays visible above it.
Several questions get a tab each (`■` answered, `□` not) and a Review tab; answering one moves to
the next unanswered question, then to Review. A single question submits as soon as it is answered.
Options with a preview show it in a box beside the list in terminals 100 columns or wider, below
it otherwise, following the highlighted option.

| Key | Does |
|---|---|
| ↑ ↓ (and `j` `k`, and your `tui.select.up`/`down` keys) | move, wrapping |
| 1-9 | highlight that row (does not choose it) |
| Enter | choose the highlighted option; on `Type something.` open the editor; in multi-select, finish the question (with nothing checked, the highlighted option alone) |
| Space | check or uncheck an option (multi-select) |
| `n` | add a note to the question's answer |
| Tab, Shift+Tab, ← → | next or previous question (several questions) |
| Esc | leave an editor, keeping the draft; otherwise decline the questionnaire |

In the `Type something.` and notes editors, Enter saves and Shift+Enter starts a new line. Saving
typed text answers a single-select question, or checks the text and finishes a multi-select one.
On the Review tab, Enter submits; questions left blank are reported as unanswered.

## herdr

While the user is being asked (the terminal dialog or the RPC dialogs below), the tool holds
`herdr:blocked` on pi's event bus: `{ active: true, label }` when the dialog opens and
`{ active: false }` when it closes, however it closes. The label is the question headers joined by
` · `, cut to 60 characters. herdr's pi integration shows the pane as blocked for as long as the
hold lasts. Outside herdr nothing listens and the events do nothing.

## Hosts

- **Terminal UI**: the dialog above.
- **RPC** (Paseo, and subagent children whose dialogs pi-subagents forwards): one native dialog per
  question. Single-select is a select with the options numbered and `Type something.` last (then
  a text input); multi-select is a text input taking numbers like `1,3`, where anything that is not
  a list of option numbers is taken as a typed answer. Previews are added to the question text,
  cut to 600 characters each; notes are terminal-only. Dismissing any dialog declines.
- **No UI** (print and JSON modes): the tool is removed from the model's tool list before each
  turn and put back when a UI is present again; a call that still arrives gets an error telling the
  model there is nobody to ask.

## Install

```sh
pi install git:github.com/justmytwospence/pi-ask-user-question
```

It registers `ask_user_question`, so remove any other extension that does (for example
`npm:@juicesharp/rpiv-ask-user-question`). There are no settings.

## Development

```sh
npm ci && npm run check   # typecheck and unit tests
```
