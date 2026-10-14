---
title: pi-select-nav
description: Add consistent Ctrl+J/Ctrl+K picker navigation while preserving text entry and component-owned letter keys.
plugin: pi-select-nav
---

## Quick reference

- **Use it for:** Navigate eligible pickers and available task panels while protecting text fields.
- **Enable:** Select `packages/pi-select-nav/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Ctrl+J/K and sometimes j/k in lists; contextual Tab in the main prompt. No command or tool; no registered global shortcut.
- **Settings:** No plugin settings. Add Ctrl+K/J to Pi's `tui.select.up/down` for keybinding-aware lists/autocomplete.
- **Requirements, cost & privacy:** TUI/focus hooks only; no inference, network or external program. Focus heuristics inspect local component structure.
- **Integrations & limits:** Optional next-prompt and activities; explicit input contexts keep their own keys. Optional dialog forwarding supports the suite's pi-todo default/common rebind without requiring it. Shift+Tab remains stock unless explicitly remapped.

## Purpose and input behavior

`pi-select-nav` translates familiar list-navigation keys into arrow-key input before the focused component handles them. **Ctrl+J** becomes down and **Ctrl+K** becomes up in eligible focused components. Plain **j** and **k** provide the same movement only when the extension does not detect text entry or an existing component-owned letter binding. The purpose is to reach pickers that hardcode arrows instead of consulting Pi's configurable selection bindings.

Entry: `packages/pi-select-nav/src/index.ts`. Follow [Install & select](/guides/install/) to choose this suite entry. The suite loads every entry by default, and every selected entry shares one Git pin.

The main prompt editor is exempt from these list-navigation rewrites. So is a focused component that is itself a multiline editor, detected through its text getter and setter. In those contexts, Ctrl+J remains available for a newline and Ctrl+K for deleting to the end of the line. The extension is therefore not a global replacement of those editing actions throughout Pi.

An editor nested inside a dialog owns its keys too. If the focused dialog contains an editor that is active, or whose focus state cannot be determined, Ctrl+J and Ctrl+K pass through unchanged. Only an embedded editor that explicitly reports `focused: false` leaves the surrounding list eligible, as in a question dialog whose free-text row is not selected. Behavior therefore depends on which component actually owns focus. The extension does not add new selection actions to a component; it relies on that component already understanding arrow input.

Suite components can declare their input context through the shared `Symbol.for("pi-plugins.input-context.v1")` method. For list navigation, when the focused component has that method, select-nav neither renders it nor rewrites those keys: the component implements its own resolved bindings. The copy picker is one example. See [keyboard & focus](/guides/keyboard/).

## Contextual Tab

In the main prompt, Tab accepts a visible completion only after an explicit `@` mention or `/` command. It does not start implicit file browsing. Otherwise, it inserts an available [next-prompt suggestion](/plugins/pi-next-prompt/) into an empty editor without sending it, or selects the available [subagent](/plugins/pi-subagents/) or [background-task](/plugins/pi-bg/) panel. Drafts are never replaced. When a panel is selected, Tab cycles its entries, Enter opens one and Esc returns to the editor. A single background pill stays selected on repeated Tab presses.

With no suggestion or tasks, Tab does nothing. Shift+Tab keeps Pi's thinking-level shortcut. Dialogs and embedded editors retain their own Tab behavior, as do pending, Visual and EX modal operations. Key releases and pasted text are not routed as Tab presses.

These companions remain optional and load order does not choose the priority. The synchronous requests `prompt:accept-next { handled }` and `activity:prompt-tab { handled, phase }` coordinate acceptance and the active activity host. The task phase is `active` when cycling an already-selected panel and `enter` when first selecting it.

## Todo toggle in dialogs

Pi runs extension shortcuts only from the prompt editor, so a question, plan approval or other dialog would otherwise swallow them. While such a dialog has focus, select-nav passes **Ctrl+Shift+T** ([pi-todo](/plugins/pi-todo/)'s suite default) and **Ctrl+T** (a common configured `collapseKey` rebind) to registered extension shortcut handlers and consumes the key only when one runs. Other keys stay with the dialog. The list is the `DIALOG_SHORTCUTS` constant in the source; arbitrary custom collapse keys are not forwarded.

This companion behavior is optional: select-nav does not register `todo`, create tasks, require pi-todo or remap native keys. Stock Ctrl+T remains `app.thinking.toggle` unless you explicitly move or disable it before assigning todo that key. Pi skips conflicting extension shortcuts rather than overriding native bindings automatically. Text-entry and list-navigation protections still apply as described below; panel-toggle forwarding does not turn editor keys into list movement. See [stock, suite and optional personal bindings](/guides/keyboard/#track-logical-tasks).

## Requirements, configuration, and costs

The extension needs Pi's interactive terminal UI and access to its focused component. There are no external executables, credentials, network calls, model requests, or paid service costs. It does not depend on Herdr, a particular shell, or another suite component. The code uses Pi's terminal key parser rather than an operating-system-specific keyboard hook, but that does not establish universal terminal or third-party picker compatibility.

For keybinding-aware lists, also merge these bindings into `~/.pi/agent/keybindings.json`:

```json
{
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

Retaining the arrow keys preserves their normal behavior. These settings are complementary to the raw-input rewrite: the editor's autocomplete popup and other components reading Pi's bindings can handle the control keys directly, even when the focused editor is exempt from rewriting. Do not replace unrelated bindings when applying this example.

The plugin has no slash command, model-callable tool, or user-facing JSON settings of its own. Its plain-letter exception list, `J_K_DENYLIST`, is an empty source-level set of component constructor names, not an environment variable or configurable settings key. There is no documented runtime preference for adding entries to it.

If a terminal or multiplexer consumes a shortcut first, neither the extension nor Pi's selection bindings can recover an event that never reaches the application. Test the original arrow keys and the relevant control keys separately before treating a nonmoving cursor as a plugin defect.

## Text-entry and letter-binding safeguards

Plain j and k are intentionally more conservative than Ctrl+J and Ctrl+K. The extension preserves letters when the focused root is an Input or Editor, has a `focused` property, or renders Pi's cursor marker. It also walks component fields looking for focused text controls and string properties whose names contain `search`, `query`, or `filter`. Even an empty search string can indicate that typing letters belongs to filtering rather than navigation.

The walk is bounded: it descends at most three levels and stops around a 400-node limit, while skipping common links such as the TUI, theme, parent, and session. These are practical heuristics, not a formal declaration from every plugin about whether it accepts text. Deeply nested or unusual components may therefore require separate investigation.

For existing letter actions, the extension inspects function source on the focused component and its prototypes for literal j or k strings. Finding either preserves both letters. This protects components that bind those letters themselves. It can also be conservative: a literal appearing for another purpose may prevent navigation, while a binding hidden in an external helper or computed dynamically may escape detection.

Key-release events are left untouched, including releases reported by Kitty-protocol terminals, so a release is not rewritten into a second arrow press. This is a specific input safeguard, not a claim that every keyboard encoding has been tested. Ordinary arrows remain the useful fallback whenever a letter is deliberately preserved or a heuristic cannot identify the focused component correctly.

## Interactions and troubleshooting

If Ctrl+J and Ctrl+K work in one picker but not another, first identify whether the latter is actually a focused editor. Editors are exempt from rewriting; their autocomplete behavior depends on the additional Pi selection bindings. In a dialog, check whether focus belongs to the container or directly to a text editor. That difference explains why the same control key may move a choice in one screen and edit text in another.

If j or k types a letter instead of moving, inspect the presence of a search field or existing letter action before calling it a failure. Preserving typing is intentional. Conversely, if a letter is incorrectly consumed, reproduce with arrows and control keys, then identify the picker and its focus state. The bounded field walk and function-source inspection cannot promise safe handling of arbitrary custom components.

`pi-copy` already supports Ctrl+J/Ctrl+K, declares a filter context and does not require this entry. Its query field keeps receiving literal j and k. Question dialogs likewise need their free-text entry preserved. Other raw terminal-input listeners can interact with the rewritten data, so isolate input-handling extensions when diagnosing a conflict rather than assuming a universal load order fixes it.

The implementation obtains the TUI through a temporary invisible widget and calls `getFocusedComponent`; it only listens in Pi's interactive TUI mode and unsubscribes on session shutdown. Changes to Pi's internal focus surface can affect compatibility. The package check runs typechecking and a small [input-routing test](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-select-nav/test/input.test.mjs) for nested editors, explicit contexts and key releases; it does not cover every picker interaction. Report the exact picker, Pi version, terminal, key sequence, focus location, and whether plain arrows still work. That evidence is more useful than a broad claim that navigation fails everywhere.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-select-nav)
