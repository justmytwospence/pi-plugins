---
title: Remote clients
description: What remote Pi clients can render, and where terminal access is still needed.
---

The suite preserves rich desktop dialogs. There is no remote-client UI setting to switch: TUI sessions use terminal components, while RPC sessions use supported Pi dialogs. Terminal access and native chat controls are different capabilities.

## Herdr and herdr-web-ui

Install Herdr's official Pi integration for lifecycle state and session identity. [pi-herdr](/plugins/pi-herdr/) adds metadata and orchestration; it does not replace that integration.

herdr-web-ui reads the running TUI and session store, rather than launching Pi in RPC mode. Its standard Pi prompt cards recognize the inline plan approval selector. The rich questionnaire and permission dialogs require its **terminal fallback**; previews, notes, review and multi-select are not native chat-card controls. `/planners` is a terminal interface too.

Attaching to a live terminal can resize the shared terminal seen on your desktop. Removing a particular phone client does not change this property of terminal attachment.

Plan approval/edit/feedback waits report `herdr:blocked`, like questions and permission prompts. This allows the official integration to expose waiting-for-input state. Extension-owned background work is separately reported through pi-herdr's `bg` metadata token; the audited web client does not account for this token when deciding whether to send a completion alert. A finish alert is not proof that every background job ended.

On iPhone, web push requires iOS 16.4+, HTTPS, and installing the site through Safari's **Add to Home Screen**. Open the installed app, enable **Alerts**, and send a test from its alert settings. The server must remain running. Alerts are suppressed while any app window is visible and focused on any device; test pushes bypass suppression.

See the [herdr-web-ui guide](https://github.com/devswha/herdr-web-ui/blob/main/docs/guide.md) for current setup and behavior.

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

These limits were checked against herdr-web-ui `dc2f11de`, Paseo `4a3ff87e` and Omnigent `f8f69988`. Custom question/gate frames were tested against the web prompt parser; the standard plan selector was recognized. This is not a live iPhone or end-to-end model test. Newer client revisions may behave differently.
