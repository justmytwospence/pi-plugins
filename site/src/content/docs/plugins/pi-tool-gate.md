---
title: Tool gate
description: Choose permission modes with an explicitly remapped Shift+Tab; auto mode combines fixed checks, paid Jev judgments and human approval.
plugin: pi-tool-gate
---

## Quick reference

- **Use it for:** Choose an approval policy for tool calls, escalating risky operations without treating the gate as a sandbox.
- **Enable:** Select `packages/pi-tool-gate/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/mode`, `/gate`; Shift+Tab cycles only after remapping stock `app.thinking.cycle`, or choose another `cycleShortcut`.
- **Settings:** `tool-gate.json` shared/user/project layers; default auto mode, paid Jev on, pushback on, 8000 ms classifier timeout (one retry on timeout).
- **Requirements, cost & privacy:** Pi classifier/provider access for Jev; proposed arguments and clipped user intent can leave the machine. Fixed checks and manual mode are local.
- **Integrations & limits:** Optional plan mode, footer and Herdr blocked state. The stock conflict skips shortcut registration; unavailable-classifier fallback is not fail-closed.

Tool gate brings Claude Code's permission modes to Pi and, in auto mode, reduces routine approval interruptions while escalating risky calls. It is an approval policy inside Pi, **not a sandbox**, a complete secret scanner or a guarantee that every dangerous operation will be caught.

## Enable and requirements

Follow [Install & select](/guides/install/) and select `packages/pi-tool-gate/src/index.ts`. The suite loads every entry by default, with one Git pin covering the selected entries.

Classifier judgments require Pi 0.99 or newer and credentials for the configured provider. Defaults use `typesafe/jev-latest` through Pi's model registry, with `TYPESAFE_API_KEY` and an 8,000 ms timeout; a timed-out request is retried once. Fixed checks do not require Jev, but the unavailable-classifier fallback is less protective, especially without a UI.

**Jev calls are paid external requests.** Most gray-area calls require one judgment; an initially held call can make another request for a suggested workaround. Even a fixed-rule hold can use that workaround request. Classified calls add reported classifier usage to their tool result. Costs depend on volume and input, not just how many approval dialogs appear.

## Permission modes

After an [explicit stock-key remap](/guides/keyboard/#resolve-the-two-stock-conflicts), Shift+Tab cycles the modes as in Claude Code (from auto: manual, accept edits, plan, auto); `/mode` switches directly or lists them. The footer shows the mode with Claude Code's labels.

| Mode | Runs without asking |
| --- | --- |
| Chat (`chat mode on`) | Recognized reads only; every other call is blocked without asking, and the agent is told to talk and answer questions. No classifier requests. Opt in by adding `chat` to `modes`. |
| Manual (`manual mode on`) | Recognized reads only; every other call asks, with an "allow similar" option. No classifier requests. |
| Accept edits (`accept edits on`) | Reads, edits and writes inside the project, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` on files inside the project. Other commands ask. |
| Plan (`plan mode on`) | With [pi-plan-mode](/plugins/pi-plan-mode/) only. Edits are blocked except to its plan file; commands are judged as in auto mode. Approving the plan picks the next mode. |
| Auto (`auto mode on`) | The default: the checks and judgments below. |
| Yolo (`yolo mode on`) | Claude Code's bypass permissions mode: everything except removing `/`, top-level directories, home, the project or their parents. Opt in by adding `yolo` (or `bypassPermissions`) to `modes`, or use `/mode yolo`. |

Without a UI, calls that would ask are blocked. Sessions remember their mode across resume; new sessions start in `defaultMode`. Pi's stock Shift+Tab is reserved for `app.thinking.cycle`; current Pi **skips** the conflicting extension shortcut. It does not override that action automatically. Move the stock action, for example to `alt+t` in `~/.pi/agent/keybindings.json`, or choose a different `cycleShortcut`, then `/reload`. `/mode` remains available without a shortcut.

## What runs and what is held in auto mode

Recognized read-only tools and shell commands pass without classification. Examples include `read`, `grep`, `git status` and `git diff`, subject to credential-path and shell checks. Tools declaring `readOnlyHint` and names in `allowTools` also bypass judgment. These hints are declarations, not independently verified behavior.

Fixed checks hold operations such as `sudo`, force-pushing main/master, deleting protected roots and accessing recognized live-secret files. A fixed hold cannot be cleared by Jev's approval. Edits, writes, other commands and unannotated extension tools normally enter classifier judgment. `bg_run` commands receive the same shell checks as `bash`.

Default classifier thresholds hold unrequested calls at 0.9 irreversible probability, 0.85 remote-change probability, or impact 2.5 out of three. A clearly off-task call needs both scope probability below 0.1 and impact at least two to be held. A sufficiently clear user request, including agreement to the assistant's proposal, can clear those checks at probability 0.7; the request need not name the command, a step the instruction plainly requires counts, and earlier instructions in the session still stand. It does not clear exfiltration at 0.8 (sending secrets somewhere they are not for; a credential used with its own service is not exfiltration) or project-rule violations at 0.7.

By default, a held call first returns an explanation to the agent rather than asking you. A retry of the identical call, or another held call in the same family during that user turn, asks for approval. The agent can instead narrow, preview or abandon the operation.

## Approvals and commands

The interactive dialog offers **Allow once**, **Allow similar for this session** and **Always allow similar in this project** when applicable, **Block**, and **Block with a message**, whose text goes to the agent with the refusal. Fixed-rule holds do not offer a similar-call grant. Esc blocks; `n` opens the message field; Ctrl+O expands long content. Bash is displayed as a command, file edits as a diff, and other tool arguments as JSON. RPC and forwarded subagent questions use a simpler presentation.

Similar-call grants are broader than exact argument matches. Shell grants use program/subcommand keys and can apply across working directories. Edit/write grants are directory-scoped; other tools are keyed by name. Directory grants cover the folder under a private root, the root itself for a file directly in it (a file in `~/Downloads` grants `~/Downloads`), else the file's directory, or the directory itself for a write to an existing one (such as a writing command's working directory). Read the scope shown in the approval option before granting it. Project grants are saved in `~/.pi/agent/tool-gate/project-grants.json`, outside the repository, keyed by the main checkout so worktrees share them.

- `/mode [chat|manual|accept-edits|plan|auto|yolo]` switches the permission mode; with no argument it lists every mode.
- `/gate` or `/gate status` shows the mode, counts, classifier settings, rules and grant counts.
- `/gate grants` lists this project's saved grants; picking one revokes it.
- `/gate on` switches to auto mode; `/gate off` to yolo mode.

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
    "timeoutMs": 8000
  }
}
```

`defaultMode` (default `auto`) chooses the starting mode, `modes` the modes the cycle key steps through, while `/mode` still offers every mode (`["default", "acceptEdits", "plan", "auto"]`; for example `["chat", "plan", "auto"]`), and `cycleShortcut` its key (`shift+tab`; `""` for none, read after `/reload`). `enabled: false` starts sessions in yolo mode.

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

Headless pi-subagents cancel approval dialogs and report a permission blocker to the parent; they never approve a gated action automatically. The `herdr:blocked` event marks an open dialog for a listening Herdr integration; without a listener it has no effect. Status footer shows the mode on its model row and preserves the gate's status notice, but is not required. See [Troubleshooting](/guides/troubleshooting/) and the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-tool-gate) for exact bypasses and fallback behavior.
