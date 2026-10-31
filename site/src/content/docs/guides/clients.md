---
title: Remote clients
description: What remote Pi clients can render, and where terminal access is still needed.
---

The suite preserves rich desktop dialogs. There is no remote-client UI setting to switch: TUI sessions use terminal components, while RPC sessions use supported Pi dialogs. Terminal access and native chat controls are different capabilities.

## Herdr and herdr-web-ui

Install Herdr's official Pi integration for lifecycle state and session identity. [pi-herdr](/plugins/pi-herdr/) adds metadata and orchestration; it does not replace that integration.

herdr-web-ui reads the running TUI and session store, rather than launching Pi in RPC mode. It builds a chat card for a Pi dialog when the screen ends the way Pi's own select and input dialogs do: a question, a blank line, one row per option, a blank line, then Pi's key hint (`↑↓ navigate  enter select  escape/ctrl+c cancel`, or `enter submit  escape/ctrl+c cancel` over a `›` field), followed by at most two footer lines. The questionnaire, permission prompts and plan approval all end that way, so a phone gets their options as buttons and their free-text fields (Type something., notes, Block with a message) as a text box. Multiple-choice questions are drawn as OmO's ask_user_question form, which herdr-web-ui shows as a checkbox card with a Submit button. While any dialog holds `herdr:blocked`, [pi-status-footer](/plugins/pi-status-footer/) shrinks to one row for the same reason, leaving room for one activity row (pi-bg's shells, subagents).

Limits: a card appears only with the cursor on the first row (as for Pi's own dialogs); a question showing a side-by-side preview and `/planners` still need the terminal. A multiple-choice question's typed answer is its numbered `Other` option: tick it on the phone and a text-box card follows.

Attaching to a live terminal can resize the shared terminal seen on your desktop. Removing a particular phone client does not change this property of terminal attachment.

Plan approval/edit/feedback waits report `herdr:blocked`, like questions and permission prompts. This allows the official integration to expose waiting-for-input state. Extension-owned background work is separately reported through pi-herdr's `bg` metadata token; the audited web client does not account for this token when deciding whether to send a completion alert. A finish alert is not proof that every background job ended.

On iPhone, web push requires iOS 16.4+, HTTPS, and installing the site through Safari's **Add to Home Screen**. Open the installed app, enable **Alerts**, and send a test from its alert settings. The server must remain running. Alerts are suppressed while any app window is visible and focused on any device; test pushes bypass suppression.

See the [herdr-web-ui guide](https://github.com/devswha/herdr-web-ui/blob/main/docs/guide.md) for current setup and behavior.

Sidebar can share the primary pane with planner and subagent views. Closing Sidebar expands the current view; closing that view returns to main without closing Sidebar. Native dialogs temporarily take the full width. The Sidebar conversation is read-only and belongs to the explicitly enrolled session family, not all sessions on the machine; it does not change the primary view's human controls. Family coverage may be partial or unavailable. See [pi-sidebar](/plugins/pi-sidebar/) for transcript retrieval and limits.

## Collie

[Collie](https://github.com/AltanS/collie) also mirrors Herdr panes to a phone and reads a waiting Pi dialog off the screen. Single-choice questions, permission prompts and Pi's own selects (plan approval, cache-guard) show as buttons, and a lone multiple-choice question as checkboxes (its Other answer is typed in the terminal). A set of several questions shows Collie's Escape card, with the terminal for the answer.

To send a message in one tap and lift those cards, Collie has to find Pi's editor. pi-status-footer paints a context gauge into the editor's rules and draws a taller, indented footer, pi-vim puts its mode label at the bottom rule's end, and pi-sidebar splits the pane, so declare that frame to Collie in `~/.config/collie/frames.toml` (a Collie build with `frames.toml` support, and checkbox cards for the multiple choice; see Collie's "Your own editor frame"):

```toml
[pi]
rule_glyphs = "━"
rule_labels = "ends"
status_rows = 12
status_indent = 1
status_blank_rows = 1
option_gutter = "│"
checkbox_ticks = "✓"
typed_answer = "Other"
# pi-sidebar's split: read only main's side
panel_below = { rule = "─", pointers = "▴▾" }
panel_beside = { rule = "│", pointers = "◂▸" }
```

Collie reads it at startup: run `collie restart` after an edit. Collie's phone app also shows the footer's rows under Chat; Settings → pi → Show the status line turns that off per device.

## Paseo

Paseo starts Pi in RPC mode. The questionnaire's select/input fallback supports ordinary selections, custom answers and numbered multi-select. Permission prompts use standard selects. Inline plan approval uses standard selects and editing uses the RPC editor.

The audited Paseo adapters have limitations:

- Its legacy subagent adapter expects a different input/result contract from this suite. Native child-session paths alone do not enable complete child tracking.
- Todo snapshots match its `rpiv-todo` adapter, but task dependencies and other metadata are not all presented.
- Question previews and duplicate headers have presentation/correlation limitations.
- Plan editor prefill is not preserved by the audited mapping.

The full-screen planner is not available in RPC. Do not equate a tool running successfully with complete native client presentation.

See [Paseo's provider documentation](https://github.com/getpaseo/paseo/blob/main/docs/providers.md).

## Omnigent

Omnigent's native Pi harness runs the actual TUI and injects web messages through its own extension. Arbitrary custom extension dialogs and the suite's `todo` tool are not guaranteed native web controls. Its managed agent directory can also change which extension configuration and agent presets are visible. The suite respects `PI_CODING_AGENT_DIR`; it does not bypass that isolation or either permission system.

The audited native bridge publishes idle at `agent_end`, which can precede Pi's final `agent_settled` boundary. Do not treat that status as proof that automatic continuations have finished.

## Audit baseline

Collie was checked against its pi reader on the `frames.toml` branch (`npm run check:clients`, 46 and 120 columns) and live from a phone on a two-machine crew. The herdr-web-ui layout was checked against its v17, v27 (0.4.8) and v31 (0.4.12) prompt parsers (`parseInteractivePrompt`) at 46 and 120 columns; other limits against herdr-web-ui `dc2f11de`, Paseo `4a3ff87e` and Omnigent `f8f69988`. Custom question/gate frames were tested against the web prompt parser; the standard plan selector was recognized. This is not a live iPhone or end-to-end model test. Newer client revisions may behave differently.
