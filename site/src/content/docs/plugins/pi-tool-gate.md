---
title: Tool gate
description: Combine fixed checks, paid Jev judgments and human approval for uncertain or risky tool calls.
plugin: pi-tool-gate
---

Tool gate reduces routine approval interruptions while escalating risky calls. It is an approval policy inside Pi, **not a sandbox**, a complete secret scanner or a guarantee that every dangerous operation will be caught.

## Enable and requirements

Follow [Install & select](/guides/install/) and select `packages/pi-tool-gate/src/index.ts`. The suite loads all 19 extensions by default, with one Git pin covering the selected entries.

Classifier judgments require Pi 0.99 or newer and credentials for the configured provider. Defaults use `typesafe/jev-latest` through Pi's model registry, with `TYPESAFE_API_KEY` and a 3,000 ms timeout. Fixed checks do not require Jev, but the unavailable-classifier fallback is less protective, especially without a UI.

**Jev calls are paid external requests.** Most gray-area calls require one judgment; an initially held call can make another request for a suggested workaround. Even a fixed-rule hold can use that workaround request. Classified calls add reported classifier usage to their tool result. Costs depend on volume and input, not just how many approval dialogs appear.

## What runs and what is held

Recognized read-only tools and shell commands pass without classification. Examples include `read`, `grep`, `git status` and `git diff`, subject to credential-path and shell checks. Tools declaring `readOnlyHint` and names in `allowTools` also bypass judgment. These hints are declarations, not independently verified behavior.

Fixed checks hold operations such as `sudo`, force-pushing main/master, deleting protected roots and accessing recognized live-secret files. A fixed hold cannot be cleared by Jev's approval. Edits, writes, other commands and unannotated extension tools normally enter classifier judgment. `bg_run` commands receive the same shell checks as `bash`.

Default classifier thresholds hold unrequested calls at 0.9 irreversible probability, 0.85 remote-change probability, or impact 2.5 out of three. A clearly off-task call needs both scope probability below 0.1 and impact at least two to be held. A sufficiently clear user request, including agreement to the assistant's proposal, can clear those checks at probability 0.8. It does not clear exfiltration at 0.8 or project-rule violations at 0.7.

By default, a held call first returns an explanation to the agent rather than asking you. A retry of the identical call, or another held call in the same family during that user turn, asks for approval. The agent can instead narrow, preview or abandon the operation.

## Approvals and commands

The interactive dialog offers **Allow once**, **Allow similar for this session** when applicable, and **Block**. Fixed-rule holds do not offer a similar-call grant. Esc blocks; Ctrl+O expands long content. Bash is displayed as a command, file edits as a diff, and other tool arguments as JSON. RPC and forwarded subagent questions use a simpler presentation.

Similar-call grants are broader than exact argument matches. Shell grants use program/subcommand keys and can apply across working directories. Edit/write grants are directory-scoped; other tools are keyed by name. Read the scope shown in the approval option before granting it.

- `/gate` or `/gate status` shows counts, classifier settings, rules and grant counts.
- `/gate on` enables the gate for this session, subject to configuration.
- `/gate off` bypasses it for this session.

For example, after a held publish attempt, inspect the agent's explanation and proposed call before choosing Allow once. Do not interpret a retry as proof that the action is necessary.

## Configuration and project rules

Settings merge in order from `~/.config/agents/tool-gate.json`, `~/.pi/agent/tool-gate.json`, `<project>/.agents/tool-gate.json` and `<project>/.pi/tool-gate.json`. `$XDG_CONFIG_HOME` relocates shared user settings. Objects merge; arrays replace rather than extend earlier arrays.

This `.pi/tool-gate.json` keeps the standard checks but asks immediately instead of first pushing back:

```json
{
  "enabled": true,
  "pushBack": false,
  "jev": {
    "enabled": true,
    "provider": "typesafe",
    "model": "jev-latest",
    "timeoutMs": 3000
  }
}
```

Overriding `allowTools` replaces the entire default list. Adding a tool there bypasses its ordinary checks, so do not treat it as a cosmetic preference. `readOnlyCommands` similarly extends trusted shell programs. The default allowance for `codemode` relies on Pi gating its nested tool calls separately.

Rules are top-level bullets read from project `.agents/tool-gate-rules.md`, project `.pi/tool-gate-rules.md`, shared user `tool-gate-rules.md`, then Pi user `tool-gate-rules.md`. Duplicate rules are dropped and at most 30 are loaded. For example:

```markdown
- No new runtime dependencies without asking.
- Never edit generated files directly; change their source instead.
```

Rules apply to classifier-judged calls, not to every bypassed read-only or already-granted call.

## Privacy, fallback and optional integrations

Jev receives clipped recent user messages, the assistant message preceding the latest request, recent assistant intent, working directory, Git branch/dirty state, tool name and arguments, and applicable rules. Arguments can include source code or private text. A hold's reasons accompany the workaround request. Local `tool-gate:decision` session entries include abbreviated arguments and scores but do not enter model context.

When Jev is unavailable, gray-area calls use Pi's tool annotations: flagged calls ask in a UI, while other calls run. Without a UI, that unavailable-classifier path allows them. In contrast, fixed-rule holds and classifier-decided holds block retries when nobody can approve. Incomplete successful judgments can also allow a call. Do not use this extension as a fail-closed security boundary.

Optional pi-subagents can forward approval questions. The `herdr:blocked` event marks an open dialog for a listening Herdr integration; without a listener it has no effect. Status footer preserves the gate's status notice, but is not required. See [Troubleshooting](/guides/troubleshooting/) and the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-tool-gate) for exact bypasses and fallback behavior.
