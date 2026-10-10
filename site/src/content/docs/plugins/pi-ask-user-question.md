---
title: pi-ask-user-question
description: Ask structured multiple-choice questions with optional previews, free-text answers, notes, and host-aware dialogs.
plugin: pi-ask-user-question
---

pi-ask-user-question adds the `ask_user_question` tool for decisions the user should make. It is useful when proceeding would commit to a preference, scope, or trade-off that cannot be discovered from project files. The questionnaire supports both suggested choices and the user's own wording; selecting an offered answer is never mandatory.

## Enable, requirements, and costs

Choose `packages/pi-ask-user-question/src/index.ts` through the [suite installation guide](/guides/install/). All 19 extensions load by default; selected suite entries share one Git pin.

Keep only one extension registering `ask_user_question`. Duplicate providers are a configuration conflict, not an additional source of questions. This plugin has no settings file and no slash commands.

A terminal UI supplies the full questionnaire. An RPC host must support Pi's native select and input dialogs for the fallback interface. In print or JSON modes without a UI, the tool is withdrawn before each turn; a call that nevertheless arrives returns a no-user-to-ask error.

**Costs:** the questionnaire itself requires no credentials and makes no classifier or model requests. Generating the question and continuing after the answer use the session's normal model. Herdr and pi-subagents are optional integrations, not prerequisites.

## Tool schema and example

The top-level `questions` array accepts one to four questions. Each question supplies `question`, `header`, and two to four `options`. Each option has a `label` and `description`, with optional Markdown `preview`. `multiSelect` defaults to false.

Example tool arguments:

```json
{
  "questions": [
    {
      "question": "Where should the filters appear?",
      "header": "Layout",
      "multiSelect": false,
      "options": [
        {
          "label": "Sidebar (Recommended)",
          "description": "Keep filters visible while browsing results.",
          "preview": "| Filters | Results |\n| --- | --- |\n| Always visible | Main content |"
        },
        {
          "label": "Top bar",
          "description": "Give results more horizontal space.",
          "preview": "Filters above the results; the list uses the full width."
        }
      ]
    }
  ]
}
```

Every question automatically includes `Type something.`. Do not author an `Other` or `Type something.` option: reserved labels are rejected. Duplicate question text and duplicate option labels within a question are also rejected.

Keep headers to 12 characters or fewer for legibility. Longer headers are shortened on screen, not rejected. Use previews for concrete alternatives rather than repeating descriptions. Preview boxes are supported for single-select questions, following the highlighted option; the terminal places them beside the list at 100 columns or wider and below it otherwise.

## Answer in the terminal

The questionnaire replaces the editor while leaving the transcript above it. Multiple questions have individual tabs and a final Review tab. Completing a question moves to the next unanswered one; a single-question questionnaire submits immediately after answering.

| Key | Action |
| --- | --- |
| Up/Down or `j`/`k` | Move through rows, wrapping at either end. |
| `1`–`9` | Highlight a row without submitting it. |
| Enter | Choose a single answer, open free-text entry, or finish a multi-select question. |
| Space | Toggle a checkbox in multi-select. |
| `n` | Add a note to the answer. |
| Tab / Shift+Tab or Left/Right | Move between question tabs. |
| Esc | Leave an editor while retaining its draft; otherwise decline the questionnaire. |

In text and note editors, Enter saves and Shift+Enter inserts a newline. Multi-select accepts checked choices plus a typed answer. If nothing is checked when Enter finishes a multi-select question, the highlighted option is used alone. On Review, Enter submits; unanswered questions remain explicitly unanswered.

## Results and host differences

The model receives readable answer text beginning `User has answered your questions`, with question-to-answer pairs, selected previews when applicable, and notes. Multi-select labels are joined by commas. Structured result `details` also contain one answer per question, with kinds `option`, `custom`, `multi`, or `unanswered`, plus selections, notes, and previews.

Declining produces `User declined to answer questions`. It is not a tool failure requiring another questionnaire. Blank questions submitted from Review produce `Unanswered`, which is distinct from declining the whole call.

RPC uses one native dialog per question. Single-select offers numbered options followed by free text; multi-select uses a text input accepting option numbers such as `1,3`, or a custom answer. Previews are appended to the question text and limited to 600 characters each. Notes are terminal-only, and dismissing any RPC dialog declines the questionnaire. If the custom terminal UI cannot open, the extension attempts these native dialogs instead.

## Optional integrations and limitations

While a dialog is open, the tool emits a `herdr:blocked` hold, released on answer, decline, or error. Herdr's own Pi integration consumes this event; pi-herdr is not required to handle blocked state. Elsewhere it has no effect.

pi-subagents can forward an RPC child's dialogs to the parent UI, so a delegated agent can ask without owning a terminal pane. That depends on the host providing dialog handling; it does not make unattended runs interactive.

This tool records a choice, not an enforcement policy. The model must still honor the answer, and a selected option does not automatically change files or authorize unrelated commands. See [planning and review](/recipes/plan-review/) for using decisions in a larger workflow and [troubleshooting](/guides/troubleshooting/) for duplicate tools or missing UI.

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-ask-user-question) cover schema validation, answer formatting, terminal behavior, and RPC fallback.
