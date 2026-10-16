---
title: Next prompt
description: Offer one concrete follow-up as editable ghost text, with optional paid Jev validation.
plugin: pi-next-prompt
---

## Quick reference

- **Use it for:** Offer one editable next step after a completed run, without a separate generation request.
- **Enable:** Select `packages/pi-next-prompt/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/next-prompt` status/on/off; Tab/Right accept into an empty focused main editor, never submit.
- **Settings:** `next-prompt.json` shared/user/project layers; enabled, Tab/Right, max 110 characters; Jev timeout 1500 ms, threshold 0.6.
- **Requirements, cost & privacy:** Pi 1.0+ TUI; normal input/output tokens for suggestion instruction; optional paid Jev sees suggestion/request/answer excerpts.
- **Integrations & limits:** Optional Vim/select-nav. Missing classifier shows unvetted text; no prompt after failed/aborted runs. Suggestions are not authorization.

Next prompt offers a likely follow-up after a completed run. It is deliberately selective: a finished task, an unresolved question or several equally plausible directions should produce no suggestion. Accepting text never sends it automatically.

## Enable and requirements

Use [Install & select](/guides/install/) and select `packages/pi-next-prompt/src/index.ts`. The suite loads every entry by default and uses one Git pin for every selected component. This extension requires Pi 1.0 or newer; use the installation guide's tested version for the suite as a whole.

Suggestions need Pi's interactive terminal UI. Print mode, RPC hosts and ordinary headless subagents receive no suggestion instruction, even when an RPC host reports UI support. No companion extension is required, and Jev is optional rather than a prerequisite for showing text.

The main model receives an additional prompt section of roughly 150 tokens and may emit roughly 20 extra output tokens for a suggestion. There is no separate generative request. **Optional Jev validation is a paid external classifier call**, however, so “no extra generation” does not mean “no extra model cost.”

## Accept, edit or ignore

A suggestion appears as dim text in an empty editor after a completed run. Press Tab or Right to copy it into the editor, then review, edit and send it normally. For example, a suggestion to run a specific test should remain an editable proposal, not permission to execute that test without your next message.

Typing hides the suggestion. Deleting everything you typed brings it back until a prompt is sent. A new run, a submitted prompt, compaction, tree navigation, a model change or a session switch clears it. Failed and aborted runs do not show suggestions.

The acceptance keys are intercepted only while a suggestion is offered, the editor is empty, and the focused component is the main prompt editor: not an editor embedded in a dialog, not while autocomplete is open, and, with pi-vim, only in an idle Insert or Normal state (not during a pending command, Visual mode or an EX line). Otherwise the focused component handles Right normally. With [pi-select-nav](/plugins/pi-select-nav/), Tab accepts explicit completion or selects available task panels instead of triggering implicit file completion. A selected task panel keeps Tab for navigation, even if a new suggestion arrives. With pi-vim, accepting also moves the editor to Insert mode at the end of the text; it still does not submit.

The extension wraps rendering rather than replacing the editor. Editors drawing Pi's software or hardware cursor, including pi-vim, can show inline ghost text. If no compatible cursor is drawn, the fallback is a dim line below the editor with an acceptance hint naming the first configured key.

## Commands and configuration

- `/next-prompt` or `/next-prompt status` reports enabled state and the last suggestion's verdict.
- `/next-prompt on` enables suggestions for the session, subject to settings.
- `/next-prompt off` clears the suggestion and stops adding the instruction for subsequent runs.
- Any other argument shows a usage warning.

Files merge in order: `~/.config/agents/next-prompt.json`, `~/.pi/agent/next-prompt.json`, `<project>/.agents/next-prompt.json`, then `<project>/.pi/next-prompt.json`. Shared user settings honor `$XDG_CONFIG_HOME`. Objects merge, while arrays and scalar values replace earlier values. A value whose type does not match the default (for example a string where a number belongs, or a non-finite number) is ignored.

This project `.pi/next-prompt.json` keeps the default acceptance keys and length while disabling classifier validation:

```json
{
  "enabled": true,
  "acceptKeys": ["tab", "right"],
  "maxChars": 110,
  "jev": { "enabled": false }
}
```

Acceptance keys use pi-tui key identifiers, such as `tab`, `right` or `ctrl+f`. When enabled, Jev defaults to provider `typesafe`, model `jev-latest`, timeout 1,500 ms and acceptance threshold 0.6. Pi supplies credentials, normally `TYPESAFE_API_KEY` for TypeSafe.

## Data sent and fallback behavior

The main model writes a final `<next>...</next>` line under the added instruction. The extension strips recognized tag lines at `message_end` before storing the assistant response, keeping them out of the saved answer and later conversation context. The tag may briefly be visible during streaming. Once you accept and send a suggestion, it is naturally an ordinary user message.

For a candidate suggestion, Jev receives the suggestion itself, up to 1,500 characters of the latest user prompt and up to 2,000 characters from the end of the assistant answer. Those excerpts may contain private project details. The classifier checks whether the proposal is concrete, relevant and not already completed; this is not a safety or authorization check.

A probability below 0.6 hides the proposal by default. Disabled Jev, missing credentials, timeouts or missing answers **show the proposal anyway**. There is no classifier request when the main model supplies no candidate. `/next-prompt status` helps distinguish a rejected candidate from one shown without validation.

## Offers from other extensions

An extension can offer a next prompt over Pi's event bus with `prompt:offer { source, text }`, and withdraw it with `{ source }` and no text. An offer appears only while Pi is idle and never replaces the model's own suggestion. It goes through no Jev check and is cleared by your next prompt, and nothing is sent. pi-marimo uses it when you make a new marimo-lens selection.

## Limitations and related documentation

A suggestion is model-authored and can still be wrong or redundant, even after validation. It cannot know which of several unstated priorities you prefer. Do not expect a suggestion after every turn, and review accepted commands or requests before sending them.

For editor or key conflicts, consult [Troubleshooting](/guides/troubleshooting/). The [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-next-prompt) cover tag processing, editor behavior, lifecycle clearing and classifier fallback.
