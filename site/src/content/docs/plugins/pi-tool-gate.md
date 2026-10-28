---
title: Tool gate
description: Choose permission modes with an explicitly remapped Shift+Tab; auto mode combines fixed checks, paid Jev judgments and human approval.
plugin: pi-tool-gate
---

## Quick reference

- **Use it for:** Choose an approval policy for tool calls, escalating risky operations without treating the gate as a sandbox.
- **Enable:** Select `packages/pi-tool-gate/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/mode`, `/gate`, `/gate rules`; Shift+Tab cycles only after remapping stock `app.thinking.cycle`, or choose another `cycleShortcut`.
- **Settings:** `tool-gate.json` shared/user/project layers, including `permissions` allow/ask/deny rules; default auto mode, paid Jev on, pushback on, 8000 ms classifier timeout (one retry on timeout).
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
| Manual (`manual mode on`) | Recognized reads only; every other call asks, with rules to allow for the session, the project or everywhere. No classifier requests. |
| Accept edits (`accept edits on`) | Reads, edits and writes inside the project, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` on files inside the project. Other commands ask. |
| Plan (`plan mode on`) | With [pi-plan-mode](/plugins/pi-plan-mode/) only. Edits are blocked except to its plan file; commands are judged as in auto mode. Approving the plan picks the next mode. |
| Auto (`auto mode on`) | The default: the checks and judgments below. |
| Yolo (`yolo mode on`) | Claude Code's bypass permissions mode: everything except removing `/`, top-level directories, home, the project or their parents. Opt in by adding `yolo` (or `bypassPermissions`) to `modes`, or use `/mode yolo`. |

Without a UI, calls that would ask are blocked. Sessions remember their mode across resume; new sessions start in `defaultMode`. Pi's stock Shift+Tab is reserved for `app.thinking.cycle`; current Pi **skips** the conflicting extension shortcut. It does not override that action automatically. Move the stock action, for example to `alt+t` in `~/.pi/agent/keybindings.json`, or choose a different `cycleShortcut`, then `/reload`. `/mode` remains available without a shortcut.

## What runs and what is held in auto mode

Recognized read-only tools and shell commands pass without classification. Examples include `read`, `grep`, `git status` and `git diff`, subject to credential-path and shell checks. Tools declaring `readOnlyHint` and names in `allowTools` also bypass judgment. These hints are declarations, not independently verified behavior.

Fixed checks hold operations such as `sudo`, force-pushing main/master, deleting protected roots, piping a download into a shell and accessing recognized live-secret files. A fixed hold cannot be cleared by Jev's approval. Edits, writes, other commands and unannotated extension tools normally enter classifier judgment. `bg_run` commands receive the same shell checks as `bash`.

Running code the session downloaded is a fixed hold in every mode except yolo. The gate tracks files written by `curl -o`/`-O`/`> file`, `wget`, `gh release download` (`-O`, `-D`, `-p`) and `aria2c`, resolved after any `cd`, and follows later `cp`, `mv` and `install` (`rm` drops a file). The list is rebuilt from the current branch's successful shell calls when a session starts or moves in its tree. Running such a file (`./file`, `sh`/`bash`/`zsh`/`dash file`, `source file`, `python`/`node`/`ruby`/`perl`/`bun file`, `deno run file`), even in the command that downloads it, is pushed back once in auto mode and then asked about, with **Allow once** and **Block** only (no rule opens it). Names a command does not give (an unpacked archive, `gh release download` without `-O`, `-D` or `-p`) are not tracked.

When a judged shell call runs a local script that was not downloaded (a regular file of at most 64 KB, not binary), Jev also receives the script's path and content (clipped to 6,000 characters) and is told to judge the call by what the script does, treating the content as code to evaluate rather than instructions to follow.

Default classifier thresholds hold unrequested calls at 0.9 irreversible probability, 0.85 remote-change probability, or impact 2.5 out of three. A clearly off-task call needs both scope probability below 0.1 and impact at least two to be held. A sufficiently clear user request, including agreement to the assistant's proposal, can clear those checks at probability 0.7; the request need not name the command, a step the instruction plainly requires counts, and earlier instructions in the session still stand. It does not clear exfiltration at 0.8 (sending secrets somewhere they are not for; a credential used with its own service is not exfiltration) or project-rule violations at 0.7.

By default, a held call first returns an explanation to the agent rather than asking you. A retry of the identical call, or another held call in the same family during that user turn, asks for approval. The agent can instead narrow, preview or abandon the operation.

## Approvals and commands

The interactive dialog shows the call and why it was held. Its rows are **Allow once**, then, when rules can name the call, **Allow rule for this session**, **in this project** and **everywhere**, **Edit the rule...**, then **Block** and **Block with a message**, whose text goes to the agent with the refusal. The rule itself is in the question (`Rule: Bash(git push:*)`), not in the rows, which stay under 42 characters so phone clients read them. Fixed-rule holds, including downloaded code, offer only Allow once and the blocks. Esc blocks; `n` opens the message field; Ctrl+O expands long content. Bash is displayed as a command, file edits as a diff, and other tool arguments as JSON. RPC and forwarded subagent questions use a simpler presentation.

- `/mode [chat|manual|accept-edits|plan|auto|yolo]` switches the permission mode; with no argument it lists every mode.
- `/gate` or `/gate status` shows the mode, counts, classifier settings, project rules, permission rules and folder grant counts.
- `/gate rules` lists the permission rules and folder grants by list and scope, and offers to remove or add one; `/gate rules list|add|remove ...` do the same with arguments. `/gate grants` is the same command.
- `/gate on` switches to auto mode; `/gate off` to yolo mode.

For example, after a held publish attempt, inspect the agent's explanation and proposed call before choosing Allow once. Do not interpret a retry as proof that the action is necessary.

## Permission rules

Rules settle specific calls in Claude Code's syntax and order: `deny` beats `ask` beats `allow`, whichever scope each is in.

| List | A matching call |
| --- | --- |
| `deny` | Is blocked without asking. The agent is told which rule matched and that you forbade it. Applies in every mode, yolo and chat included. |
| `ask` | Always asks you, even in auto mode, with no classifier request and no push-back. Not applied in yolo mode. |
| `allow` | Runs without a classifier request. Never overrides deny or ask, the calls the gate always holds, or the directory policy for a shell command. |

Syntax, as in Claude Code:

- `Bash(git push:*)` (or `Bash(git push *)`): the command and any arguments, by whole words (`git push`, `git push origin main`, not `git pushx`). `Bash(npm test)` is exactly that command. `Bash` alone is every shell command.
- `Edit(src/**)`, `Write(...)`, `Read(...)`: gitignore-style paths relative to the project, or `~/...` or absolute (`/etc/app/**`; `//etc/app/**` also works). A pattern with no slash matches at any depth. `Read` covers `read`, `grep`, `find` and `ls`.
- A bare tool name: `web_fetch`, `mcp__server` (every tool of that server), `mcp__server__*`.

`bash` and `bg_run` are `Bash`; `edit` is `Edit`; `write` is `Write`. `edit` and `write` allow rules cover their own tool, while deny and ask rules for either cover both. Other tools take no specifier: rules like `WebFetch(domain:example.com)` are not supported and are listed as ignored.

A shell call is taken apart into its simple commands, including those in `$(...)`, backticks, process substitutions and the text of `sh -c`, `eval` and `sudo`. A deny or ask rule matches when any of them does: `Bash(rm -rf:*)` denies `git status && rm -rf x`, `ls $(rm -rf x)` and `bash -c 'rm -rf x'`. An allow rule must cover every command that does more than read: `Bash(git push:*)` allows `cd sub && git push origin x`, not `git push && rm -rf x`. A prefix matches through global options and wrappers (`git -C ../x push`, `time git push`), but allow rules do not look past an assignment or option that changes what runs (`PATH=... git push`, `git -c ...`). A command the gate cannot read as a program with arguments (`$(which x) y`, `export A=1`) is opened only by a rule naming the whole call.

The calls the gate always holds (`sudo`, a force-push to main, a download piped to a shell, credential files) are never opened by a prefix rule or a wildcard: only an exact rule does (`Bash(git push --force origin main)`, `Edit(.env)`). Downloaded code stays allow-once only. Deny rules apply to all of them. An `Edit`, `Write` or `Read` allow rule also opens the directory policy for its tool (`Edit(~/dotfiles/**)`), though not for a derived path. Path rules apply to Pi's file tools, not to the paths a shell command names.

### Scopes

All scopes are added together.

| Scope | Stored in | `/gate rules` can change it |
| --- | --- | --- |
| Session | Memory | Yes |
| Project, this machine | `~/.pi/agent/tool-gate/project-grants.json`, keyed by the main checkout | Yes |
| Project, shared | `<project>/.agents/tool-gate.json` and `.pi/tool-gate.json` | No: it names the file |
| User | `~/.pi/agent/tool-gate.json` | Yes |
| User, shared | `~/.config/agents/tool-gate.json` | No: it names the file |

The files use Claude Code's `permissions` block. Unlike the rest of `tool-gate.json`, where arrays replace, the lists of all four files are added together. The opencode and Claude Code ports read the same shared files and ignore the block.

```json
{
  "permissions": {
    "allow": ["Bash(npm test)", "Bash(git push:*)", "Edit(src/**)"],
    "ask": ["Bash(git push --force:*)"],
    "deny": ["Bash(rm -rf:*)", "Read(.env)"]
  }
}
```

### Rules from the dialog

The suggested rule is the call's program and subcommand as a prefix (`Bash(git push:*)`, `Bash(docker compose up:*)`), one rule for each such command in the call, shown in the question. A script runner names its script (`Bash(python3 scripts/x.py:*)`), `edit` and `write` offer their folder (`Edit(src/a/**)`) and other tools their name. For programs whose arguments are the risk (`rm`, `mv`, `chmod`, `chown`, `dd`, `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `sudo`, `gh api`, inline code such as `python -c` or `bash -c`), for a here-document fed to one of them, and for a command the gate cannot read as a program with arguments, the rule is the exact command. **Edit the rule...** opens the rule in an editor, refuses text that is not a rule with the reason, and returns to the dialog with the edited rule. **Everywhere** writes to `~/.pi/agent/tool-gate.json`; if a rule cannot be saved the call is allowed for the session and a warning says so. Holds by the directory policy offer the folder instead (session or project only): the folder under a private root, the root itself for a file directly in it (a file in `~/Downloads` grants `~/Downloads`), else the file's directory, or the directory itself for a write to an existing one (such as a writing command's working directory). Read the folder in the question before granting it; `/gate rules` lists the folder grants beside the rules.

Project grants saved by earlier versions are read as rules without rewriting the file: `bash:<key>` as `Bash(<key>:*)`, `tool:<x>` as `<x>`, `edit:<dir>` and `write:<dir>` as `Edit(<dir>/**)` and `Write(<dir>/**)`, and `dir:` grants stay folders. New rules are saved in the same file under keys older versions ignore.

### Compared with Claude Code

The same: the three lists and their order, the `Bash`, `Edit`, `Write` and `Read` syntax, bare tool names with `mcp__server`, gitignore-style paths, and splitting compound commands so a rule for one part does not allow the rest.

Different: only those four tools take a specifier (no `WebFetch(domain:...)`) and there is no managed scope; `*` is a wildcard only as a `Bash` prefix; a path starting with `/` is absolute here (Claude Code reads it relative to the project and uses `//` for absolute); `Edit` and `Write` allow rules cover their own tool; path rules do not look inside shell commands; ask rules do not apply in yolo mode; and the modes, classifier and directory policy are this plugin's own.

## Configuration and project rules

Settings merge in order from `~/.config/agents/tool-gate.json`, `~/.pi/agent/tool-gate.json`, `<project>/.agents/tool-gate.json` and `<project>/.pi/tool-gate.json`. `$XDG_CONFIG_HOME` relocates shared user settings. Objects merge; arrays replace rather than extend earlier arrays, except the `permissions` lists, which are added together.

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

Project rules (guidance for the classifier, not [permission rules](#permission-rules)) are top-level bullets read from project `.agents/tool-gate-rules.md`, project `.pi/tool-gate-rules.md`, shared user `tool-gate-rules.md`, then Pi user `tool-gate-rules.md`. Duplicate rules are dropped and at most 30 are loaded. For example:

```markdown
- No new runtime dependencies without asking.
- Never edit generated files directly; change their source instead.
```

Project rules apply to classifier-judged calls, not to every bypassed read-only or already-allowed call.

## Privacy, fallback and optional integrations

Jev receives clipped recent user messages, the assistant message preceding the latest request, recent assistant intent, working directory, Git branch/dirty state, tool name and arguments, the content of a local script a shell call runs (up to 6,000 characters), and applicable rules. Arguments and scripts can include source code or private text. A hold's reasons accompany the workaround request. Local `tool-gate:decision` session entries include abbreviated arguments and scores but do not enter model context.

When Jev is unavailable, gray-area calls use Pi's tool annotations: flagged calls ask in a UI, while other calls run. Without a UI, that unavailable-classifier path allows them. In contrast, fixed-rule holds and classifier-decided holds block retries when nobody can approve. Incomplete successful judgments can also allow a call. Do not use this extension as a fail-closed security boundary.

Headless pi-subagents cancel approval dialogs and report a permission blocker to the parent; they never approve a gated action automatically. The `herdr:blocked` event marks an open dialog for a listening Herdr integration; without a listener it has no effect. Status footer shows the mode on its model row and preserves the gate's status notice, but is not required. See [Troubleshooting](/guides/troubleshooting/) and the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-tool-gate) for exact bypasses and fallback behavior.
