---
title: pi-select-nav
description: Add consistent Ctrl+J/Ctrl+K picker navigation while preserving text entry and component-owned letter keys.
plugin: pi-select-nav
---

## Purpose and input behavior

`pi-select-nav` translates familiar list-navigation keys into arrow-key input before the focused component handles them. **Ctrl+J** becomes down and **Ctrl+K** becomes up in eligible focused components. Plain **j** and **k** provide the same movement only when the extension does not detect text entry or an existing component-owned letter binding. The purpose is to reach pickers that hardcode arrows instead of consulting Pi's configurable selection bindings.

Entry: `packages/pi-select-nav/src/index.ts`. Follow [Install & select](/guides/install/) to choose this suite entry. The suite loads all 19 extensions by default, and every selected entry shares one Git pin.

The main prompt editor is exempt. So is a focused component that is itself a multiline editor, detected through its text getter and setter. In those contexts, Ctrl+J remains available for a newline and Ctrl+K for deleting to the end of the line. The extension is therefore not a global replacement of those editing actions throughout Pi.

An editor nested inside a dialog is a different case: the dialog can remain eligible for control-key navigation while literal letters are protected for text entry. This distinction is useful in question dialogs that combine choices with a free-text row, but it also means behavior depends on which component actually owns focus. The extension does not add new selection actions to a component; it relies on that component already understanding arrow input.

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

For existing letter actions, the extension inspects function source on the focused component and its prototypes for literal j or k strings. Finding either preserves both letters. This protects patterns such as the `k` stop-task action described for background-task pickers. It can also be conservative: a literal appearing for another purpose may prevent navigation, while a binding hidden in an external helper or computed dynamically may escape detection.

Key-release events are left untouched, including releases reported by Kitty-protocol terminals, so a release is not rewritten into a second arrow press. This is a specific input safeguard, not a claim that every keyboard encoding has been tested. Ordinary arrows remain the useful fallback whenever a letter is deliberately preserved or a heuristic cannot identify the focused component correctly.

## Interactions and troubleshooting

If Ctrl+J and Ctrl+K work in one picker but not another, first identify whether the latter is actually a focused editor. Editors are exempt from rewriting; their autocomplete behavior depends on the additional Pi selection bindings. In a dialog, check whether focus belongs to the container or directly to a text editor. That difference explains why the same control key may move a choice in one screen and edit text in another.

If j or k types a letter instead of moving, inspect the presence of a search field or existing letter action before calling it a failure. Preserving typing is intentional. Conversely, if a letter is incorrectly consumed, reproduce with arrows and control keys, then identify the picker and its focus state. The bounded field walk and function-source inspection cannot promise safe handling of arbitrary custom components.

`pi-copy` already supports Ctrl+J/Ctrl+K and does not require this entry. Its query field should continue receiving literal j and k. Question dialogs likewise need their free-text entry preserved. Other raw terminal-input listeners can interact with the rewritten data, so isolate input-handling extensions when diagnosing a conflict rather than assuming a universal load order fixes it.

The implementation obtains the TUI through a temporary invisible widget and calls `getFocusedComponent`; changes to Pi's internal focus surface can affect compatibility. The package's check is typechecking, without a dedicated unit-test suite for every picker interaction. Report the exact picker, Pi version, terminal, key sequence, focus location, and whether plain arrows still work. That evidence is more useful than a broad claim that navigation fails everywhere.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-select-nav)
