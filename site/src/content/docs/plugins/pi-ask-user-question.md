---
title: pi-ask-user-question
description: Ask structured multiple-choice questions with optional previews, free-text answers, notes, and host-aware dialogs.
plugin: pi-ask-user-question
---

## Quick reference

- **Use it for:** Ask about a preference or trade-off that cannot be established from project files.
- **Enable:** Select `packages/pi-ask-user-question/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `ask_user_question`; no slash command or global shortcut. Local choice, note, free-text and Review controls below.
- **Settings:** No settings file. 1–4 questions, 2–4 options each; `multiSelect` defaults to false; a custom-answer row is automatic.
- **Requirements, cost & privacy:** TUI or RPC select/input support. No extra inference itself; answers enter normal model context. No user UI means no available questionnaire.
- **Integrations & limits:** Optional embedded Vim and Herdr blocked state. Headless subagents report decisions as blockers; an answer is not an enforcement policy.

pi-ask-user-question adds the `ask_user_question` tool for decisions the user should make. It is useful when proceeding would commit to a preference, scope, or trade-off that cannot be discovered from project files. The questionnaire supports both suggested choices and the user's own wording; selecting an offered answer is never mandatory.

## Enable, requirements, and costs

Choose `packages/pi-ask-user-question/src/index.ts` through the [suite installation guide](/guides/install/). Every suite entry loads by default; selected suite entries share one Git pin.

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
| Up/Down | Move through rows, wrapping at either end. |
| `j`/`k` or `1`–`9` on offered options | Navigate or highlight a row without submitting it. |
| Typing or paste on `Type something.` | Start an answer immediately; `n`, `j`, `k`, and digits are text here. |
| Enter | Choose a single answer, open free-text entry, or finish a multi-select question. |
| Space | Toggle a checkbox in multi-select. |
| `n` on an offered option, or Ctrl+G on any row | Add a note, distinct from the free-text answer. |
| Tab / Shift+Tab or Left/Right | Move between question tabs. |
| Esc | Leave an editor while retaining its draft; otherwise decline the questionnaire. |

Typed answers and notes are edited in a `›` field under the options, without a box; the draft answer also shows on its row. The dialog ends in Pi's own key hint and puts descriptions behind a `│` gutter, the layout herdr-web-ui reads as a chat card; Ctrl+K on an empty field stays in it, because herdr-web-ui clears fields with Ctrl+K Ctrl+U. In text and note editors, Enter saves, Shift+Enter inserts a newline, and Ctrl+J/Ctrl+K move to another row in any editor mode (a note is saved, an answer draft is kept). An empty answer keeps the editor open with guidance. Multi-select accepts checked choices plus a typed answer; a typed answer alone is also valid. The answer field uses the full width without a preview box. If nothing is checked when Enter finishes a multi-select question, the highlighted option is used alone. On Review, Enter on Submit answers submits and Cancel declines; unanswered questions remain explicitly unanswered. Unsaved answer and note drafts are visible, and Enter returns to the first unfinished field before submitting.

With pi-vim enabled, opening or reopening a field starts in Insert mode. The cursor shape shows the mode; the field has no mode badge. Escape first leaves Insert/Visual mode, then returns to the list while retaining the draft. Autocomplete likewise gets Escape before the questionnaire does.

### Interaction design

This suite-owned component keeps Claude Code-compatible tool arguments without duplicating another `ask_user_question` provider. Its interaction design draws on [Claude Code's printable-text routing](https://code.claude.com/docs/en/keybindings#text-fields), [Codex's inline custom-answer flow](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/bottom_pane/async_questions/input.rs), and [OpenCode's separate composition and confirmation states](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/tui/src/routes/session/question.tsx).

For our terminal setup, text owns its keys, highlights do not submit, batches retain Review, and Vim fields reopen ready to type. Notes remain supplementary, never a substitute for an answer. These are this plugin's choices, not a claim that every harness variant behaves identically.

## Results and host differences

The model receives readable answer text beginning `User has answered your questions`, with question-to-answer pairs, selected previews when applicable, and notes. Multi-select labels are joined by commas. Structured result `details` also contain one answer per question, with kinds `option`, `custom`, `multi`, or `unanswered`, plus selections, notes, and previews.

Declining produces `User declined to answer questions`. It is not a tool failure requiring another questionnaire. Blank questions submitted from Review produce `Unanswered`, which is distinct from declining the whole call.

RPC uses one native dialog per question. Single-select offers numbered options followed by free text; multi-select uses a text input accepting option numbers such as `1,3`, or a custom answer. Previews are appended to the question text and limited to 600 characters each. Notes are terminal-only, and dismissing any RPC dialog declines the questionnaire. If the custom terminal UI cannot open, the extension attempts these native dialogs instead.

## Optional integrations and limitations

While a dialog is open, the tool emits a `herdr:blocked` hold, released on answer, decline, or error. Herdr's own Pi integration consumes this event; pi-herdr is not required to handle blocked state. Elsewhere it has no effect.

Headless pi-subagents cannot use this tool. Workers return decisions and permission blockers to their parent instead of opening user dialogs.

This tool records a choice, not an enforcement policy. The model must still honor the answer, and a selected option does not automatically change files or authorize unrelated commands. See [planning and review](/recipes/plan-review/) for using decisions in a larger workflow and [troubleshooting](/guides/troubleshooting/) for duplicate tools or missing UI.

[Source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-ask-user-question) cover schema validation, answer formatting, terminal behavior, and RPC fallback.
