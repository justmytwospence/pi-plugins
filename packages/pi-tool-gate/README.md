# pi-tool-gate

A Pi extension that auto-approves tool calls, so you are only pulled in when a call is risky and the agent could not find a way around it. Fixed rules settle the clear cases without a model call (read-only calls run, a short list of dangerous calls is always held); [Jev](https://docs.typesafe.ai), through Pi's own classifier models, judges the gray zone. A held call is first blocked with an explanation and a suggested workaround for the agent; only if the agent retries it, or another held call of the same family, are you asked.

That is **auto mode**, one of the Claude Code permission modes the gate provides; Shift+Tab cycles them (see [Permission modes](#permission-modes)). It acts on every tool call (the `tool_call` event) and is not a sandbox: see [Limitations](#limitations).

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-tool-gate/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-tool-gate/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-tool-gate
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## Permission modes

As in Claude Code, the mode decides what runs without asking you. Shift+Tab (`cycleShortcut`) steps through them, from auto to manual, then accept edits, plan, and back to auto; `/mode` picks one (`/mode` alone lists them). The footer shows the active one with Claude Code's labels.

| Mode | Status | Runs without asking |
| --- | --- | --- |
| manual (`default`) | `⏸ manual mode on` | Reads only ([clear cases](#1-clear-cases-no-model-call)); everything else asks you, with "allow similar" for the session. |
| accept edits (`acceptEdits`) | `⏵⏵ accept edits on` | Reads, `edit`/`write` inside the project, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` when every file they name is inside the project (after any `cd`; no redirects or expansions; `sed` without `w`/`e`). Credential files and the [always-held calls](#1-clear-cases-no-model-call) still ask. |
| plan | `⏸ plan mode on` | Needs [pi-plan-mode](../pi-plan-mode/): edits are blocked except to its plan file; commands are judged as in auto mode. Approving the plan picks the next mode. |
| auto | `⏵⏵ auto mode on` | Everything Jev and the fixed rules allow, below. The default. |
| bypass (`bypassPermissions`) | `⏵⏵ bypass permissions on` | Everything, except removing `/`, a top-level directory, home, the project or a parent of them. Not in the cycle unless you add it to `modes`. |

Without a UI, a call that would ask you is blocked. The mode is saved in the session, so a resumed session comes back in it; a new session starts in `defaultMode`. Plan mode joins the cycle only when pi-plan-mode announces itself on Pi's event bus (contract in [`src/modes.ts`](./src/modes.ts)); other extensions can request a mode (`permission-mode:set`) or a cycle step (`permission-mode:cycle`) and follow changes (`permission-mode:changed`).

Pi binds Shift+Tab to its thinking-level cycle by default; the gate takes it over (Pi warns about the conflict at startup). Rebind `app.thinking.cycle` in `~/.pi/agent/keybindings.json` (for example to `alt+t`), or set `cycleShortcut` to another key.

## How auto mode works

### 1. Clear cases, no model call

These run without a judgment:

- Tools in `allowTools` (see [Configuration](#configuration)).
- Pi's built-in `read`, `grep`, `find` and `ls` (except a `read` of a credential file, below).
- Tools that declare `readOnlyHint: true`.
- Shell commands (`bash`, and pi-bg's `bg_run`) in which every simple command only reads, with no writing redirect (`>`, `>>`, `&>` and the like, except to `/dev/null`) and no command or process substitution (`$(...)`, backticks, `<(...)`, `>(...)`). Read-only means programs such as `ls`, `cat`, `rg`, `grep`, `find`, `jq`, `sed`, `awk`, `sort`, `dig`, `ps`; read-only subcommands of `git` (`status`, `diff`, `log`, `show`, listing forms of `branch`/`tag`/`stash`/`worktree`, `config --get`, ...), `npm`/`pnpm`/`yarn`/`cargo`/`pip`/`uv`/`brew` (`ls`, `view`, `outdated`, ...), `docker` (`ps`, `logs`, `inspect`, ...), `docker compose` (`ps`, `logs`, `config`, ...), `podman`, `kubectl` (`get`, `describe`, `logs`, read-only `config` verbs), `gh` (`pr`/`issue`/`run`/... with `view`, `list`, `status`, `diff`, `checks` or `watch`), `systemctl status` and friends, `journalctl`, `launchctl list|print`, `sqlite3 -readonly`; plain `curl` GETs and `wget -qO-`/`-O-`/`--spider`; plus the programs in `readOnlyCommands`.

  Arguments are checked where they can make a "reading" program write or execute: `sed -i` or a `w`/`e` command, `find -delete`/`-exec`, `sort -o`, `awk` with `system()` or redirects, `fd -x`, `rg --pre`, `git -c ...`, `git branch <name>`, `curl -o`/`-d`/`-X POST`, `date -s` and so on. Leading assignments to variables that change what runs (`PATH`, `LD_*`, `GIT_*`, `PAGER`, `EDITOR`, `NODE_OPTIONS`, ...) and `env -S` make a command non-read-only. Wrappers such as `time`, `nice`, `env`, `nohup` and `timeout` are looked through.

These are always held, whatever Jev says:

- `sudo` or `doas`.
- `rm`, `rmdir` or `trash` of `/`, a top-level directory, your home directory, the project directory, or a parent of either.
- A force-push (`-f`, `--force`, `--force-with-lease`, `--mirror`, or a `+` refspec) to `main` or `master`, named or as the current branch.
- `curl` or `wget` piped into a shell.
- Touching files that hold live secrets: `.env` and `.env.*` (but not `*.example`, `*.sample`, `*.template`, `*.dist`, `*.default(s)`), `auth.json`, private SSH keys (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`), `.aws/credentials`, `.netrc`, `credentials`/`credentials.json`, and `*.pem`, `*.key`, `*.p12`, `*.pfx`. This covers `edit`/`write`/`read` of such a path and shell commands naming one, except programs that only name a file without reading or moving it (`ls`, `stat`, `chmod`, `touch`, ...), `git status`/`rm`/`restore`/..., and an unforced `git add` of a file git ignores. SSH config, public keys and `.npmrc` are left to Jev.

Commands nested in `sh -c '...'` (and other shells) and `eval` are checked against the same always-held rules. Writes and deletes outside the project that match none of these go to Jev.

### 2. Jev for the gray zone

Edits, writes, other shell commands, and MCP or extension tools without a read-only hint go to Jev in one request. Calls are allowed by default. Unless you asked for the action, or said yes when the agent offered it (`requested` >= 0.8), a call is held when Jev judges that:

- it cannot be undone (>= 0.9);
- it does something other people see or depend on (>= 0.85: deploy, publish, send a message, open or merge a PR, change a shared or cloud resource). Pushing commits to a git branch and maintaining your own machines over ssh do not count;
- its impact if unwanted is 2.5 or more of 3 (lost data, leaked secrets, broken production);
- or it is clearly unrelated to your request (in scope < 0.1) and its impact is 2 or more.

Whatever you said, a call is held when it would send secrets or private data off the machine (>= 0.8) or break a project rule (>= 0.7). Doubt about scope alone never holds a call. Jev sees your last three messages, the agent message your newest one replies to (so "yes" to "Want me to push?" counts as asking for the push), the agent's recent text, the working directory, the git branch and whether it is dirty, the call, and the project rules. If Jev's answer is incomplete the call is allowed. The design follows Claude Code's auto mode (allow by default; your request clears most holds).

### 3. Push-back, then you

A held call is blocked automatically the first time. The agent sees why (which checks failed and how sure Jev is, plus any quoted rules) and a suggested workaround, which Jev picks in a second request made only for held calls: preview it with a dry run, narrow it, make it reversible, keep it local, follow the project rule, skip it, or "no workaround, this is the user's call". The agent then does the job another way, drops the call, or makes its case in a short visible message and repeats the identical call.

That retry, or another held call of the same family (same key, below) in the same user turn, is put to you with the hold reasons and the agent's case: Allow once, Allow similar for this session, or Block (always-held calls offer no "allow similar"). Without a UI (print and JSON modes) the retry is blocked. Set `"pushBack": false` to be asked on the first hold.

Dialogs are shown one at a time. In Pi's terminal UI the dialog shows the call itself, highlighted: a long one-line shell command laid out one step per line (only whitespace changes), an edit or overwrite as a diff against the file, a new file in its language, any other tool's input as JSON. Below it are why it was held and the agent's case, rendered as Markdown. Long parts are clamped; Pi's `app.tools.expand` key (Ctrl+O by default) expands them, `j`/`k` and the arrow keys move, Enter selects, Esc blocks. In other UI modes (RPC clients, and subagent dialogs forwarded by pi-subagents) the question is a plain select with a one-line summary.

### Allow similar

"Allow similar" names what it grants, for example ``Allow similar for this session (`docker restart`, `python3`)``. A shell call is keyed by each command in it that does more than read, as program plus subcommand when it takes one (`git push`, `docker compose up`, `gh repo create`, `bin/homelab status`); `cd`, `echo`, loop headers, assignments, `$(...)` substitutions and here-document bodies are skipped. A later call runs unasked when every one of its keys was granted, whatever directory it starts in. Calls whose commands all only read (held back only by a substitution or redirect) share one key. Edits and writes are keyed by tool and directory, other tools by name. Grants are held in memory and never saved.

### Jev unavailable

When Jev cannot answer (Jev off in settings, no classifier model, no credentials, an invalid key, a timeout or another error), the gate warns once and falls back to Pi's tool hints: with a UI it asks you about calls whose tool declares `destructiveHint: true`, or that lack `readOnlyHint` and do not declare both `destructiveHint: false` and `openWorldHint: false` (so tools with no hints are asked about); everything else is allowed. Without a UI every such call is allowed. The always-held rules still apply.

## Commands

- `/mode [manual|accept-edits|plan|auto|bypass]`: switch modes; with no argument, pick one from a list.
- `/gate` or `/gate status`: the mode and cycle, counts, Jev model, push-back setting, number of rules and session grants.
- `/gate on`, `/gate off`: auto mode, or bypass mode.

The status line shows the mode (`permission-mode` key, `⏵⏵ auto mode on (shift+tab to cycle)`) and, in auto and plan mode, `gate: N auto · P pushed back · M asked`. Every call Jev judges is recorded in the session as a `tool-gate:decision` custom entry (tool, clipped arguments, scores, failures, action, latency, input tokens), for tuning thresholds. Jev's token usage is added to the gated tool's result.

## Project rules

Each top-level bullet (`-`, `*`, `+` or `1.`; indented lines continue it) in these files is a rule, checked on every judged call:

1. `<project>/.agents/tool-gate-rules.md`
2. `<project>/.pi/tool-gate-rules.md`
3. `$XDG_CONFIG_HOME/agents/tool-gate-rules.md` (default `~/.config/agents/`)
4. `~/.pi/agent/tool-gate-rules.md` (`$PI_CODING_AGENT_DIR` honored)

They are read in that order, duplicates dropped, at most 30. Files are re-read when they change.

```markdown
- Migrations are append-only: never edit an existing migration, add a new one.
- No new runtime dependencies without asking.
```

## Configuration

`tool-gate.json` is read from these files, each merged on top of the last (objects merge, other values, including arrays, replace); a missing or invalid file is ignored:

1. `$XDG_CONFIG_HOME/agents/tool-gate.json` (default `~/.config/agents/`)
2. `~/.pi/agent/tool-gate.json` (`$PI_CODING_AGENT_DIR` honored)
3. `<project>/.agents/tool-gate.json`
4. `<project>/.pi/tool-gate.json`

The `agents` locations are shared with the opencode and Claude Code ports of this plugin; keys a port does not know are ignored. Settings are reloaded at session start and before each agent run. The defaults:

```json
{
  "enabled": true,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 3000 },
  "thresholds": {
    "irreversible": 0.9, "remoteChange": 0.85, "requested": 0.8, "exfiltration": 0.8,
    "impact": 2.5, "offTask": 0.1, "offTaskImpact": 2, "rule": 0.7
  },
  "allowTools": [
    "codemode", "tool_search", "todo", "ask_user_question", "plan_mode_question", "plan_mode_complete",
    "enter_plan_mode", "exit_plan_mode", "web_search", "fetch_content", "get_search_content", "code_search", "radius_web_search", "web_enable",
    "bg_status", "bg_logs", "bg_result", "bg_wait", "bg_kill", "subagents_enable"
  ],
  "readOnlyCommands": [],
  "pushBack": true,
  "defaultMode": "auto",
  "modes": ["default", "acceptEdits", "plan", "auto"],
  "cycleShortcut": "shift+tab"
}
```

- `enabled`: `false` starts sessions in bypass mode.
- `defaultMode`: the mode a new session starts in (`manual`, `accept-edits`, `plan`, `auto`, `bypass`, or Claude Code's names).
- `modes`: the modes the cycle key steps through, always in Claude Code's order; add `"bypassPermissions"` to include bypass.
- `cycleShortcut`: the key that cycles modes, read at startup (changes after `/reload`); `""` for none.
- `jev`: the classifier model (`provider`/`model`, looked up among Pi's classifier models) and its timeout; `enabled: false` uses the hint fallback.
- `thresholds`: the bars described above.
- `allowTools`: tools that never need a decision. Setting it replaces the whole default list.
- `readOnlyCommands`: extra programs treated as read-only in shell commands.
- `pushBack`: `false` asks you on the first hold instead of blocking it once.

## Requirements and costs

- Jev runs through Pi's classifier models (`ctx.modelRegistry.classify`), which needs Pi 0.99 or newer, and Pi's credentials for the provider (`TYPESAFE_API_KEY` for the default `typesafe` provider). Without them the hint fallback applies.
- Each gray-zone call makes one Jev request; each held call makes one more for the workaround (also for always-held calls). These requests can be billed by the provider.
- It runs `git branch --show-current`, `git status --porcelain` and `git check-ignore` in the working directory, and reads the target file of an edit or write to show a diff. It writes nothing to disk except `tool-gate:decision` entries in the Pi session.

## Optional integrations

- **Herdr**: while an approval dialog is open, the gate emits `herdr:blocked` on Pi's event bus (`{ active: true, label: "Allow? bash: ..." }`, then `{ active: false }` when it closes), so Herdr's Pi integration shows the pane as blocked. Outside Herdr nothing listens.
- **pi-bg**: `bg_run` is judged like `bash`, in its own `cwd`; the read-only `bg_*` tools are on the default allow list.
- **pi-subagents**: a subagent's approval dialogs reach you through pi-subagents' dialog forwarding.
- **pi-plan-mode**: provides plan mode in the cycle (above).
- **pi-status-footer**: shows the mode on its model row, in Claude Code's colors.

## Limitations

- It is not a sandbox. It inspects tool names and arguments before a call; it does not confine what a command does once it runs. The read-only command rules are a parser's best effort over shell syntax, and Jev's judgment is probabilistic.
- Tools in `allowTools` are never inspected. `codemode` is on the default list because the tools its scripts call are expected to be gated on their own; if they are not in your setup, remove it.
- When Jev is unavailable and there is no UI, every call except the always-held ones is allowed.
- "Allow similar" grants are held in memory; they are not saved. The mode is saved in the session.

## Development

```sh
cd packages/pi-tool-gate
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the vitest unit tests. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

`npm run eval` makes live, paid classifier requests; run it only with explicit authorization. It judges labeled calls through the Pi installation on `PATH` (or `PI_PACKAGE_DIR`) and is skipped without `TYPESAFE_API_KEY`. `GATE_REPLAY=decisions.json npm run eval -- eval/replay.eval.ts` replays recorded decisions the same way.

## License

MIT. See [LICENSE](./LICENSE).
