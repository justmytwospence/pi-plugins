---
title: Tool gate
description: Choose a work, chat or plan workflow and tool approvals separately, with auto approval for routine calls.
plugin: pi-tool-gate
---

## Quick reference

- **Use it for:** Choose an approval policy for tool calls, escalating risky operations without treating the gate as a sandbox.
- **Enable:** Select `packages/pi-tool-gate/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/mode`, `/approvals`, `/gate`, `/gate rules`. Shift+Tab cycles workflow after remapping stock `app.thinking.cycle`; Alt+A toggles approvals.
- **Settings:** `tool-gate.json` shared/user/project layers, including `permissions` allow/ask/deny rules; default auto mode, classifier on, pushback on, 8000 ms timeout (one Jev timeout retry; no Decisions retry).
- **Requirements, cost & privacy:** Pi classifier/provider access; proposed arguments and clipped user intent can leave the machine. Fixed checks and manual mode are local.
- **Integrations & limits:** Works alone; Plan needs pi-plan-mode. Footer and Herdr are optional. Stock conflicts skip shortcut registration; calls needing an unavailable classifier are blocked.

Tool gate separates workflow from approvals and, in auto mode, reduces routine approval interruptions while escalating risky calls. It is an approval policy inside Pi, **not a sandbox**, a complete secret scanner or a guarantee that every dangerous operation will be caught.

The global [System 1](/plugins/pi-system1/) configuration (`/system1`) sets an ordered chain of Jev and native OpenAI Decisions (Jev only by default). The legacy `jev` settings still control this feature, including its enabled flag and timeout; provider/model overrides apply only to Jev. Decisions requires pi-system1 and its isolated API credential; it uses API billing, not subscription OAuth. Pi does not verify credit funding. Operational failures can advance to the next configured backend with a notification; valid judgments and safety refusals do not trigger failover.

## Enable and requirements

Follow [Install & select](/guides/install/) and select `packages/pi-tool-gate/src/index.ts`. The suite loads every entry by default, with one Git pin covering the selected entries.

Classifier judgments require Pi 0.99 or newer and credentials for the configured provider. Defaults use `typesafe/jev-latest` through Pi's model registry, with `TYPESAFE_API_KEY` and an 8,000 ms timeout; a timed-out Jev request is retried once; Decisions is not retried. Fixed checks do not require a classifier; calls routed to classification are blocked if a valid verdict is unavailable.

**Classifier calls are external requests that can incur charges.** Most gray-area calls require one judgment; an initially held call can make another request for a suggested workaround. Even a fixed-rule hold can use that workaround request. Classified calls add reported classifier usage to their tool result. Costs depend on volume and input, not just how many approval dialogs appear.

## Workflow and approvals

The workflow/approval defaults are **work + auto**. `/mode` selects work, chat or plan; after an [explicit stock-key remap](/guides/keyboard/#resolve-the-two-stock-conflicts), Shift+Tab cycles them. Plan requires [pi-plan-mode](/plugins/pi-plan-mode/); without it the cycle is work → chat → work. The workflow decides what kind of call may run at all, the same under every approval setting, and its blocks never ask. Chat blocks calls not recognized as reads; read actions of tools that declare them per call (such as `herdr` list or `subagent` status, see below) run, and so do subagent runs (not `worktree: true`) when pi-subagents is loaded, whose children start in chat too. Plan keeps the repository unchanged while it plans, and is meant for spikes: `edit` and `write` reach only its plan file and the scratch directory beside it (`<plan>.spike/`), and a shell command that does more than read is checked against the plan scope instead of refused. Writes the parser sees inside the repository block outright (anything under `.git`, anything git does not ignore); otherwise one System 1 question, whether it leaves the repository unchanged, decides (`thresholds.planScope`, 0.8; blocked when System 1 is off or fails), and a command that passes goes on to the approval setting like any other call (auto's classifier, or yolo). The scope holds under yolo, and it applies to subagents a planning session starts: they inherit plan and its scratch directory. `planShell: "read-only"` in your user config restores the older rule. Other tools are left to the approval setting. For chat and plan, read-only commands may use expansions whose commands only read (`$(...)`, literal variables, `for` loops over literal words, `xargs` with a read-only command), with unknown values accepted only where they cannot make the command write; such calls still go through approvals as unparsed shell. `ssh host '<command>'` counts as a read when its remote command does. A shell command the parser cannot follow (a `python3 -c` analysis, a heredoc) gets one System 1 question, whether it only reads, and runs when the answer reaches `thresholds.readOnly` (0.9); otherwise, or without System 1, it is blocked. Approvals treat a command judged read-only like any other read, so auto asks no second question. A block tells the agent to split its command into simpler reads. These are best-effort guards, not a sandbox; hints, configured bypasses and shell classification have limits.

`/approvals` selects auto or yolo; Alt+A toggles them independently, including in plan. Auto uses the checks below. Approvals decide only about calls the workflow permits, the same way in every workflow. Yolo bypasses ordinary approvals, including the directory policy, ask rules and always-held calls, in chat and plan as in work; deny rules, critical-removal protections and the workflow's own blocks remain. Legacy manual and accept-edits remain explicit compatibility values and are restored from older sessions; Alt+A selects auto from either. `/mode auto|yolo|manual|accept-edits` changes approvals only.

In the interactive UI, workflow and approval shortcuts share a preview with supported Plan and reasoning cycles: one combined settings journal line updates immediately. Only final values apply; `pending` is not effective protection, and current guards and approvals remain in force. Returning every touched setting to its original value is a true no-op, with no intermediate changes or plan allocation. Submitting an ordinary prompt flushes the preview first; if applying fails, the message is not sent. Opening a dialog or selector, leaving main focus, session or branch navigation, compaction, reload/shutdown, or an external change to a touched setting cancels the pending preview. Explicit commands and picker selections, and tool-owned transitions remain immediate; plan and tool approvals still require explicit confirmation.

Keyboard cycles commit when all participating modifiers are released if release reporting is negotiated through the actual terminal path and the current held state is confirmed. SSH, Herdr and tmux paths are negotiated, not assumed to support it. Otherwise, including first or fast interactions while negotiation or held state is unconfirmed, unmodified keys, pointer and programmatic cycles, the final choice applies after 1000 ms of inactivity; each accepted cycle restarts that fallback. A confirmed hold has no unconditional timeout: if a release is lost with no later input, it cannot be distinguished from a continuing hold. Each batch has its own transaction; consecutive completed successful or unchanged batches reuse one UI-only history row until a boundary such as submit, an explicit choice, unrelated output or navigation. The row shows the latest batch, not an aggregate of earlier changes.

Plan approval returns to Work. The active branch restores workflow and approvals, including legacy records. Without a UI, calls that would ask are blocked.

Pi's stock Shift+Tab is reserved for `app.thinking.cycle`; current Pi **skips** the conflicting extension shortcut. Move the stock action, for example to `alt+t`, or choose a different `workflowShortcut`, then `/reload`. `/mode` remains available without a shortcut.

## What runs and what is held in auto mode

Recognized read-only tools and shell commands pass without classification. Examples include `read`, `grep`, `git status` and `git diff`, subject to credential-path and shell checks. Tools declaring `readOnlyHint` and names in `allowTools` also bypass judgment. Tools whose calls read or act depending on their input answer per call on the optional `pi-plugins.read-only-call.v1` event channel (`{ version: 1, tool, input }`; the tool's owner sets `readOnly` synchronously, any `false` wins): [pi-herdr](/plugins/pi-herdr/)'s `list`, `read`, `wait` and `crew` status and [pi-subagents](/plugins/pi-subagents/)' `status` and `result` count as reads, their other actions do not. An owner's answer takes precedence over the tool's static hint. These hints are declarations, not independently verified behavior.

Fixed checks hold operations such as `sudo`, force-pushing main/master, deleting protected roots, piping a download into a shell and accessing recognized live-secret files. A fixed hold cannot be cleared by classifier approval. Edits, writes, other commands and unannotated extension tools normally enter classifier judgment. `bg_run` commands receive the same shell checks as `bash`.

Running code the session downloaded is a fixed hold in every mode except yolo. The gate tracks files written by `curl -o`/`-O`/`> file`, `wget`, `gh release download` (`-O`, `-D`, `-p`) and `aria2c`, resolved after any `cd`, and follows later `cp`, `mv` and `install` (`rm` drops a file). The list is rebuilt from the current branch's successful shell calls when a session starts or moves in its tree. Running such a file (`./file`, `sh`/`bash`/`zsh`/`dash file`, `source file`, `python`/`node`/`ruby`/`perl`/`bun file`, `deno run file`), even in the command that downloads it, is pushed back once in auto mode and then asked about, with **Allow once** and **Block** only (no rule opens it). Names a command does not give (an unpacked archive, `gh release download` without `-O`, `-D` or `-p`) are not tracked.

When a judged shell call runs a local script that was not downloaded (a regular file of at most 64 KB, not binary), the classifier also receives the script's path and content (clipped to 6,000 characters) and is told to judge the call by what the script does, treating the content as code to evaluate rather than instructions to follow.

Default classifier thresholds hold unrequested calls at 0.9 irreversible probability, 0.85 remote-change probability, or impact 2.5 out of three. A clearly off-task call needs both scope probability below 0.1 and impact at least two to be held. A sufficiently clear user request, including agreement to the assistant's proposal, can clear those checks at probability 0.7; the request need not name the command, a step the instruction plainly requires counts, and earlier instructions in the session still stand. It does not clear exfiltration at 0.8 (sending secrets somewhere they are not for; a credential used with its own service is not exfiltration) or project-rule violations at 0.7.

By default, a held call first returns an explanation to the agent rather than asking you. A retry of the identical call, or another held call in the same family during that user turn, asks for approval. The agent can instead narrow, preview or abandon the operation.

## Permission prompts

`/gate prompts` reports the current state and source. `/gate prompts off` denies calls requiring permission rather than opening a dialog; `/gate prompts on` restores prompting, and `/gate prompts default` clears the branch override. The latest branch override takes precedence over the explicitly inherited subagent value, then merged configuration. The root `denyInsteadOfPrompting` setting defaults to `false`; children inherit either value as their starting policy and may override it on their branch. The `/approvals` picker keeps Auto and Yolo and offers a prompt toggle without changing approval mode.

This does not approve calls or change workflow, classification, deny rules or critical-removal protections. Auto still evaluates calls; manual and accept-edits retain their usual permission requirements; Yolo bypasses ordinary approvals but not critical holds. A call requiring permission receives a non-terminating refusal and does not run. With `pushBack: true`, the first hold still explains the reason and seeks a workaround, but escalation is denied instead of prompting; with `pushBack: false`, the first approval-required hold is denied. Questions, authentication, plan review and approval, and explicitly opened settings pickers remain interactive.

## Approvals and commands

The interactive dialog shows the call and why it was held. Its rows are **Allow once**, then, when rules can name the call, **Allow rule for this session**, **in this project** and **everywhere**, **Edit the rule...**, then **Block** and **Block with a message**, whose text goes to the agent with the refusal. The rule itself is in the question (`Rule: Bash(git push:*)`), not in the rows, which stay under 42 characters so phone clients read them. Fixed-rule holds, including downloaded code, offer only Allow once and the blocks. Esc blocks; `n` opens the message field; Ctrl+O expands long content. Bash is displayed as a command, file edits as a diff, and other tool arguments as bounded, indented fields. The final question includes explicit Action and Target lines, including in RPC and forwarded subagent questions; an unavailable target is marked Not specified. This changes presentation only: tool arguments and policy data retain their original structured values.

- `/mode [work|chat|plan]` selects workflow; without an argument it opens the picker.
- `/approvals [auto|yolo]` selects approvals; without arguments it opens a picker. The footer's Approvals control opens this picker rather than toggling Yolo.
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

Syntax follows parts of Claude Code's permission rules, not complete Claude Code parity:

- `Bash(git push:*)` (or `Bash(git push *)`): the command and any arguments, by whole words (`git push`, `git push origin main`, not `git pushx`). `Bash(npm test)` is exactly that command. A `*` anywhere else matches any text, spaces included, as in Claude Code: `Bash(git log * main)`, `Bash(*vercel*--prod*)`. `Bash` alone is every shell command. Put an allow pattern's `*` after the subcommand (`/gate rules` flags one before it); ask and deny patterns catch a flag wherever it is, so `Bash(vercel deploy *)` allowed with `Bash(*vercel*--prod*)` and `Bash(*vercel*--target*production*)` as ask rules can run preview deploys and ask about matching production commands. Such string rules do not enforce arbitrary script or API behavior; blog policy also asks for every Git push and PR merge. Yolo bypasses asks, so use platform access controls too.
- `Edit(src/**)`, `Write(...)`, `Read(...)`: gitignore-style paths, anchored as in Claude Code: `//etc/app/**` is absolute, `~/notes/**` is under your home, `/notes/**` is relative to the file the rule is written in (your user file's directory, else the project root), `./x` and `a/b` are relative to the project root, and a pattern with no slash matches at any depth. `Read` covers `read`, `grep`, `find` and `ls`, and a `Read` deny rule also stops `edit` and `write` of those files. `Write(path)` is read as `Edit(path)`.
- A bare tool name: `web_fetch`, `mcp__server` (every tool of that server), `mcp__server__*`.

`bash` and `bg_run` are `Bash`; `edit` is `Edit`; `write` is `Write`. An `Edit` rule covers `edit` and `write` in every list. Other tools take no specifier: rules like `WebFetch(domain:example.com)` are not supported and are listed as ignored.

A shell call is taken apart into its simple commands, including those in `$(...)`, backticks, process substitutions and the text of `sh -c`, `eval` and `sudo`. A deny or ask rule matches when any of them does: `Bash(rm -rf:*)` denies `git status && rm -rf x`, `ls $(rm -rf x)` and `bash -c 'rm -rf x'`. An allow rule must cover every command that does more than read: `Bash(git push:*)` allows `cd sub && git push origin x`, not `git push && rm -rf x`. A prefix matches through global options and wrappers (`git -C ../x push`, `time git push`), but allow rules do not look past an assignment or option that changes what runs (`PATH=... git push`, `git -c ...`). A command the gate cannot read as a program with arguments (`$(which x) y`, `export A=1`) is opened only by a rule naming the whole call.

Exact rules match identical trimmed source; word-equivalence applies only to proven literal argument lists. Active expansions, redirects, comments, compounds and incomplete quoting do not acquire equivalence through token normalization. Opaque analysis cannot get a read-only or narrowed-prefix auto-allow: deny and ask inspect confidently found commands, while the unresolved remainder follows the ordinary approval or classification path.

The calls the gate always holds (`sudo`, a force-push to main, a download piped to a shell, credential files) are never opened by a prefix rule or a wildcard: only an exact rule does (`Bash(git push --force origin main)`, `Edit(.env)`). Downloaded code stays allow-once only. Deny rules apply to all of them. An `Edit`, `Write` or `Read` allow rule also opens the directory policy for its tool (`Edit(~/dotfiles/**)`), though not for a derived path. Path rules apply to Pi's file tools, not to the paths a shell command names.

### Scopes

All scopes are added together.

| Scope | Stored in | `/gate rules` can change it |
| --- | --- | --- |
| Session | Memory | Yes |
| Project, local | `<main>/.pi/tool-gate.local.json` | Yes, when configured for local saves |
| Project, shared | `<active-root>/.agents/tool-gate.json` and `.pi/tool-gate.json` | `.pi/tool-gate.json` when configured for shared saves |
| User | `~/.pi/agent/tool-gate.json` | Yes, unless globals are managed |
| User, shared | `~/.config/agents/tool-gate.json` | No: it names the file |

The active Git checkout root supplies shared policy even from a subdirectory; linked worktrees use their own shared files and the main checkout's local file. Nested repositories are separate projects; outside Git the launch directory is used. If the main checkout cannot be resolved reliably, policy-requiring calls are blocked rather than guessing. The checkout is resolved at session and turn start (and when rules change), not on every call; a resolution error names the Git lookup that failed and its diagnostic. If a lookup times out or cannot start after the same directory resolved earlier in the session, the gate keeps that earlier checkout and warns; a lookup that answers with an error, or a stall with no earlier resolution, still blocks.

Worktree discovery prefers modern Git's NUL-delimited porcelain output, retaining support for newline-containing paths and existing separate-Git-directory/submodule layouts. On older Git (including 2.30), only an exact unsupported-`-z` diagnostic (exit 129, not killed) triggers a retry with line-oriented porcelain; timeouts, other errors and malformed NUL output never trigger a retry. The fallback validates the complete, unquoted listing, including record fields and final terminators, and accepts only a verified main checkout whose canonical common directory is exactly `<main>/.git` and whose `.git` is an actual directory, not a symlink. Ordinary spaces and Unicode are supported; ambiguous or control-character paths, malformed or bare records, symlinked `.git`, separate Git directories and submodules are rejected by the legacy fallback. Unsupported layouts block policy-requiring calls rather than guessing or falling back to the launch directory.

The files use a Claude Code-style `permissions` block. Permission lists and `directories.read`/`directories.write` are additive; other arrays replace. The opencode and Claude Code ports read the same shared files and ignore the block.

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

The suggested rule is the call's program and subcommand as a prefix (`Bash(git push:*)`, `Bash(docker compose up:*)`), one rule for each such command in the call, shown in the question. A script runner names its script (`Bash(python3 scripts/x.py:*)`), `edit` and `write` offer their folder (`Edit(src/a/**)`) and other tools their name. For programs whose arguments are the risk (`rm`, `mv`, `chmod`, `chown`, `dd`, `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `sudo`, `gh api`, inline code such as `python -c` or `bash -c`), for a here-document fed to one of them, and for a command the gate cannot read as a program with arguments, the rule is the exact command. **Edit the rule...** opens the rule in an editor, refuses text that is not a rule with the reason, and returns to the dialog with the edited rule. **Everywhere** writes to `~/.pi/agent/tool-gate.json` when user rules are writable; if saving fails after approval the call is allowed for the session only and a warning says so (an already malformed policy blocks before approval). Holds by the directory policy offer the folder instead (session or project only): the folder under a private root, the root itself for a file directly in it (a file in `~/Downloads` grants `~/Downloads`), else the file's directory, or the directory itself for a write to an existing one (such as a writing command's working directory). Read the folder in the question before granting it; `/gate rules` lists the folder grants beside the rules.

Project grants saved by earlier versions are read as rules without rewriting the file: `bash:<key>` as `Bash(<key>:*)`, `tool:<x>` as `<x>`, `edit:<dir>` and `write:<dir>` as `Edit(<dir>/**)` and `Write(<dir>/**)`, and `dir:` grants stay folders. New project rules and folder grants go to the configured local or shared project file, not the legacy grants file.

### Compared with Claude Code

The same: the three lists and their order, the `Bash`, `Edit`, `Write` and `Read` syntax, bare tool names with `mcp__server`, gitignore-style paths, and splitting compound commands so a rule for one part does not allow the rest.

Different: only those four tools take a specifier (no `WebFetch(domain:...)`) and its managed-global write setting is not Claude's managed organization scope; a single `/` is relative to the settings file (user files) or the project root, which stands in for Claude Code's primary working directory; path rules do not look inside shell commands; plan keeps the repository unchanged with a repository check on shell commands, and holds that under yolo (Claude Code lifts plan's blocks under bypass permissions); a project file may only tighten (see below), as Claude Code ignores loosening settings from project files; push-back replaces Claude Code's three-in-a-row and twenty-total denial fallback; ask rules do not apply in yolo mode; and the modes, classifier and directory policy are this plugin's own.

## Configuration and project rules

Settings merge in order from `~/.config/agents/tool-gate.json`, `~/.pi/agent/tool-gate.json`, `<active-root>/.agents/tool-gate.json`, `<active-root>/.pi/tool-gate.json` and `<main>/.pi/tool-gate.local.json`. `$XDG_CONFIG_HOME` relocates shared user settings. Objects merge; permission lists and `directories.read`/`directories.write` are additive and deduplicated, while other arrays replace. Empty directory lists cannot remove inherited grants. Malformed policy blocks permission-requiring calls; a narrow diagnostic read of the errored file remains subject to deny and credential checks.

`persistence.project` selects `local` (default, main checkout's local file) or `shared` (active root's `.pi/tool-gate.json`) for project saves; the gate does not commit them. Set `persistence.userWritable` to `false` in user settings to manage global rules externally: the dialog hides the everywhere choice and `/gate rules` refuses user-scope edits, directing you to edit and deploy the source. Project settings cannot change it. In general project files may only tighten: they supply permission rules, directory grants, `directories.private` and `directories.derived` (added to yours) and stricter approvals, while `enabled`, `allowTools`, `readOnlyCommands`, `thresholds`, `jev`, `persistence`, a yolo default, `denyInsteadOfPrompting: false`, `planShell: "scoped"`, `directories.enabled: false`, `directories.alwaysWrite` and `directories.exemptCommands` are honored only from your user files and reported by `/gate` when a project sets them. Session rules and folder grants last until the session ends, across `/tree`. Legacy `project-grants.json` remains readable and removable, but is not the destination for new saves.

This `.pi/tool-gate.json` keeps the standard checks but asks immediately instead of first pushing back:

```json
{
  "enabled": true,
  "pushBack": false,
  "denyInsteadOfPrompting": false,
  "jev": {
    "enabled": true,
    "provider": "typesafe",
    "model": "jev-latest",
    "timeoutMs": 8000
  }
}
```

`defaultWorkflow` and `defaultApproval` set new-session defaults (`work` and `auto`). Legacy `defaultMode` is a fallback for unset axes; restrictive legacy values remain supported. `modes` is deprecated and no longer determines either cycle. `workflowShortcut` defaults to `shift+tab`, falling back to legacy `cycleShortcut`; `approvalShortcut` defaults to `alt+a`. An empty string disables the respective key; reload after changing it. Duplicate keys register workflow only and report the collision. `enabled: false` defaults new sessions to yolo approvals unless `defaultApproval` overrides it.

Overriding `allowTools` replaces the entire default list. Adding a tool there bypasses its ordinary checks, so do not treat it as a cosmetic preference. `readOnlyCommands` similarly extends trusted shell programs. The default allowance for `codemode` relies on Pi gating its nested tool calls separately.

Project rules (guidance for the classifier, not [permission rules](#permission-rules)) are top-level bullets read from project `.agents/tool-gate-rules.md`, project `.pi/tool-gate-rules.md`, shared user `tool-gate-rules.md`, then Pi user `tool-gate-rules.md`. Duplicate rules are dropped and at most 30 are loaded. For example:

```markdown
- No new runtime dependencies without asking.
- Never edit generated files directly; change their source instead.
```

Project rules apply to classifier-judged calls, not to every bypassed read-only or already-allowed call.

## Privacy, classifier failures and optional integrations

The selected classifier receives clipped recent user messages, the assistant message preceding the latest request, recent assistant intent, working directory, Git branch/dirty state, tool name and arguments, the content of a local script a shell call runs (up to 6,000 characters), and applicable rules. Arguments and scripts can include source code or private text. A hold's reasons accompany the workaround request. Local `tool-gate:decision` session entries include abbreviated arguments and scores but do not enter model context.

When the selected classifier is unavailable or returns an incomplete or invalid verdict, calls routed to classification are blocked and do not run. An identical retry may offer Allow once in the UI, without suggesting a persistent rule solely for the failure; headless retries remain blocked. Read-only and explicitly allowed calls remain subject to their ordinary checks and can run without classification. The gate is not an OS sandbox or a fail-closed security boundary.

The classifier can receive the active branch's stored approved-plan snapshot, capped at 12,000 characters, rather than the mutable plan file. The next user message expires it; a fresh approval can establish a new snapshot. It is context subordinate to current instructions and explicit rules, not blanket permission.

A pi-subagents child starts with the parent's approval setting, and in chat when the parent is in chat or plan, through the optional `pi-plugins.subagent-env.v1` environment contract (honored only in a process marked as a subagent; its own branch records win). Headless pi-subagents cancel approval dialogs and report a permission blocker to the parent; they never approve a gated action automatically. The `herdr:blocked` event marks an open dialog for a listening Herdr integration; without a listener it has no effect. Status footer shows workflow as a bold lowercase `work`, `chat` or `plan` landmark and approvals separately, preserving the gate's status notice; it is not required. Badge hues depend on the theme, and the explanation and key hint stay subdued. See [Troubleshooting](/guides/troubleshooting/) and the [source and tests](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-tool-gate) for exact bypasses and failure behavior.
