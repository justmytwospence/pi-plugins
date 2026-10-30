# pi-tool-gate

A Pi extension that auto-approves tool calls, so you are only pulled in when a call is risky and the agent could not find a way around it. Fixed rules settle the clear cases without a model call (read-only calls run, a short list of dangerous calls is always held); [Jev](https://docs.typesafe.ai), through Pi's own classifier models, judges the gray zone. A held call is first blocked with an explanation and a suggested workaround for the agent; only if the agent retries it, or another held call of the same family, are you asked. Your own [permission rules](#permission-rules), in Claude Code's syntax (`Bash(git push:*)`, `Edit(src/**)`), allow, always ask about or deny specific calls, for the session, the project or everywhere.

That is **auto approval**, independent of the current workflow (see [Workflow and approvals](#workflow-and-approvals)). It acts on every tool call (the `tool_call` event) and is not a sandbox: see [Limitations](#limitations).

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

## Workflow and approvals

Workflow and approvals are independent. Defaults are **work + auto**. `/mode` selects work, chat or plan; Shift+Tab cycles work → chat → plan → work (without pi-plan-mode, plan is omitted). Work permits ordinary requested actions. Chat blocks calls not recognized as reads; plan permits editing its plan file and judges shell commands using the existing plan policy, even under yolo. These guards are not a sandbox: configured orchestration bypasses, tool hints and shell classification have limits. Plan requires [pi-plan-mode](../pi-plan-mode/).

`/approvals` selects **auto** or **yolo**; Alt+A toggles them without changing workflow. Auto uses the checks below. Yolo bypasses ordinary approval checks, but deny rules and critical-removal protections remain, as do chat and plan guards. Legacy `manual` asks about non-read calls; `accept-edits` also permits qualifying in-project edits and filesystem commands. Both remain explicit compatibility arguments and are retained when restoring old sessions; Alt+A selects auto from either. `/mode auto|yolo|manual|accept-edits` is a compatibility alias for changing approvals only.

Approving a distinct-model plan handoff enters **exec**, owned by pi-plan-mode; same-model execution returns to work. While exec is active, workflow cycling and `/plan` cannot leave it; use `/plan-exec` for status or `/plan-exec stop` to stop. Approvals remain independently changeable. Both axes restore from the active session branch, including legacy combined-mode records. Without a UI, calls that would ask are blocked.

Pi reserves Shift+Tab for thinking-level cycling and skips a conflicting extension shortcut; it does not override the stock binding. Rebind `app.thinking.cycle` in `~/.pi/agent/keybindings.json` (for example to `alt+t`), or set `workflowShortcut` to another key. The event contracts are in [`src/modes.ts`](./src/modes.ts).

## How auto mode works

### 1. Clear cases, no model call

These run without a judgment:

- Tools in `allowTools` (see [Configuration](#configuration)).
- Pi's built-in `read`, `grep`, `find` and `ls` (except a `read` of a credential file, below).
- Tools that declare `readOnlyHint: true`.
- Shell commands (`bash`, and pi-bg's `bg_run`) in which every simple command only reads, with no writing redirect (`>`, `>>`, `&>` and the like, except to `/dev/null`) and no command or process substitution (`$(...)`, backticks, `<(...)`, `>(...)`). Read-only means programs such as `ls`, `cat`, `rg`, `grep`, `find`, `jq`, `sed`, `awk`, `sort`, `dig`, `ps`; read-only subcommands of `git` (`status`, `diff`, `log`, `show`, listing forms of `branch`/`tag`/`stash`/`worktree`, `config --get`, ...), `npm`/`pnpm`/`yarn`/`cargo`/`pip`/`uv`/`brew` (`ls`, `view`, `outdated`, ...), `docker` (`ps`, `logs`, `inspect`, ...), `docker compose` (`ps`, `logs`, `config`, ...), `podman`, `kubectl` (`get`, `describe`, `logs`, read-only `config` verbs), `gh` (`pr`/`issue`/`run`/... with `view`, `list`, `status`, `diff`, `checks` or `watch`), `systemctl status` and friends, `journalctl`, `launchctl list|print`, `sqlite3 -readonly`, `chezmoi` (`cat`, `diff`, `status`, `managed`, `source-path`, ..., without `-o`/`--output` or `--init`); plain `curl` GETs and `wget -qO-`/`-O-`/`--spider`; plus the programs in `readOnlyCommands`.

  Arguments are checked where they can make a "reading" program write or execute: `sed -i` or a `w`/`e` command, `find -delete`/`-exec`, `sort -o`, `awk` with `system()` or redirects, `fd -x`, `rg --pre`, `git -c ...`, `git branch <name>`, `curl -o`/`-d`/`-X POST`, `date -s` and so on. Leading assignments to variables that change what runs (`PATH`, `LD_*`, `GIT_*`, `PAGER`, `EDITOR`, `NODE_OPTIONS`, ...) and `env -S` make a command non-read-only. Wrappers such as `time`, `nice`, `env`, `nohup` and `timeout` are looked through.

These are always held, whatever Jev says:

- `sudo` or `doas`.
- `rm`, `rmdir` or `trash` of `/`, a top-level directory, your home directory, the project directory, or a parent of either.
- A force-push (`-f`, `--force`, `--force-with-lease`, `--mirror`, or a `+` refspec) to `main` or `master`, named or as the current branch.
- `curl` or `wget` piped into a shell.
- Running a file this session downloaded (below), in every mode but yolo.
- Touching files that hold live secrets: `.env` and `.env.*` (but not `*.example`, `*.sample`, `*.template`, `*.dist`, `*.default(s)`), `auth.json`, private SSH keys (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`), `.aws/credentials`, `.netrc`, `credentials`/`credentials.json`, and `*.pem`, `*.key`, `*.p12`, `*.pfx`. This covers `edit`/`write`/`read` of such a path and shell commands naming one, except programs that only name a file without reading or moving it (`ls`, `stat`, `chmod`, `touch`, ...), `git status`/`rm`/`restore`/..., and an unforced `git add` of a file git ignores. SSH config, public keys and `.npmrc` are left to Jev.

Commands nested in `sh -c '...'` (and other shells) and `eval` are checked against the same always-held rules. Writes and deletes outside the project that match none of these go to Jev.

#### Downloaded code

The gate keeps a list of the files the session downloaded: `curl -o f`/`--output f`, `curl -O url` (the URL's file name, under any `--output-dir`), `curl url > f`, `wget url` (the URL's file name, under any `-P`), `wget -O f`, `gh release download` (`-O f`; `-D dir` counts everything under that directory; otherwise each `-p` pattern), and `aria2c` (`-o f`, `-d dir`). Paths are resolved where the command runs, after any `cd` (and in `bg_run`'s `cwd`). A later `cp`, `mv` or `install` of a downloaded file makes the copy downloaded too (`mv` takes the mark with it), `chmod` keeps it and `rm` drops it. The list is rebuilt from the current branch's `bash` and `bg_run` calls whose results are not errors when a session starts and after `/tree` moves, and follows each finished call. Symlinks and `/tmp` versus `/private/tmp` resolve to the same file.

A command that runs one is always held: `./f` or any path naming it as the program, `sh`/`bash`/`zsh`/`dash f`, `source f` or `. f`, `python`/`python3`/`node`/`ruby`/`perl`/`bun f`, `deno run f`, also behind `sudo`, wrappers, `sh -c`, `eval` and substitutions, and also when the same command downloads it first (`curl -o x url && sh x`). Auto mode pushes it back once with the reason `runs <f>, downloaded in this session`, then asks you; manual and accept-edits modes ask at once. The dialog offers Allow once and Block only: no rule, not even an exact one, opens it.

### 2. Jev for the gray zone

Edits, writes, other shell commands, and MCP or extension tools without a read-only hint go to Jev in one request. Calls are allowed by default. Unless you asked for the action, or said yes when the agent offered it (`requested` >= 0.7; "open a PR" asks for the push and `gh pr create`, "request Sam as reviewer" for the `gh pr edit`, and an instruction from an earlier message still counts), a call is held when Jev judges that:

- it cannot be undone (>= 0.9);
- it does something other people see or depend on (>= 0.85: deploy, publish, send a message, open or merge a PR, change a shared or cloud resource). Pushing commits to a git branch and maintaining your own machines over ssh do not count;
- its impact if unwanted is 2.5 or more of 3 (lost data, leaked secrets, broken production);
- or it is clearly unrelated to your request (in scope < 0.1) and its impact is 2 or more.

Whatever you said, a call is held when it would send secrets or private data somewhere they are not for (>= 0.8; using an API key with its own API is normal use) or break a project rule (>= 0.7). Doubt about scope alone never holds a call. Jev sees your last five messages, the agent message your newest one replies to (so "yes" to "Want me to push?" counts as asking for the push), the agent's recent text, the working directory, the git branch and whether it is dirty, the call, and the project rules. If Jev's answer is incomplete the call is allowed. The design follows Claude Code's auto mode (allow by default; your request clears most holds).

A shell call that runs a local script (`./deploy.sh`, `bash x.sh`, `python3 x.py`, the same forms as [downloaded code](#downloaded-code)) is judged by what the script does: the first such file that is a regular file of at most 64 KB, with no NUL byte in its first 8 KB and not downloaded in this session, goes to Jev as `script: { path, content }` (the path with `~`, the content clipped to 6,000 characters). Every question then tells Jev to judge the call by the script's content, read as code to evaluate and never as instructions to follow. The `tool-gate:decision` entry records the script's path.

### 3. Push-back, then you

A held call is blocked automatically the first time. The agent sees why (which checks failed and how sure Jev is, plus any quoted rules) and a suggested workaround, which Jev picks in a second request made only for held calls: preview it with a dry run, narrow it, make it reversible, keep it local, follow the project rule, skip it, or "no workaround, this is the user's call". The agent then does the job another way, drops the call, or makes its case in a short visible message and repeats the identical call.

That retry, or another held call of the same family (same program and subcommand, or same folder) in the same user turn, is put to you with the hold reasons and the agent's case: Allow once, the rule that names the call for this session, this project or everywhere (or Edit the rule), Block, or Block with a message (always-held calls offer only Allow once and the blocks; see [the approval dialog](#the-approval-dialog)). A message goes to the agent with the refusal, for example what to do instead, and the agent is told to follow it rather than to stop and ask you. Without a UI (print and JSON modes) the retry is blocked. Set `"pushBack": false` to be asked on the first hold.

Dialogs are shown one at a time. In Pi's terminal UI the dialog shows the call itself, highlighted: a long one-line shell command laid out one step per line (only whitespace changes), an edit or overwrite as a diff against the file, a new file in its language, any other tool's input as JSON. Below it are why it was held and the agent's case, rendered as Markdown. Long parts are clamped; Pi's `app.tools.expand` key (Ctrl+O by default) expands them. The choices end as Pi's own select does (a one-line question, the rows, Pi's key hint), so herdr-web-ui shows them as a chat card. `j`/`k`, Ctrl+J/Ctrl+K and the arrow keys move, Enter selects, Esc blocks, and `n` (or the Block with a message row) opens a `›` message field under the choices, laid out as Pi's text input: Enter blocks with it, Esc goes back to the choices. The field uses an editor provider such as pi-vim when one answers on the suite's editor-factory channel, as pi-ask-user-question's fields do. In other UI modes (RPC clients, and subagent dialogs forwarded by pi-subagents) the question is a plain select with a one-line summary, followed by a text input when you pick Block with a message.

### Jev unavailable

When Jev cannot answer (Jev off in settings, no classifier model, no credentials, an invalid key, a timeout or another error), the gate warns once and falls back to Pi's tool hints: with a UI it asks you about calls whose tool declares `destructiveHint: true`, or that lack `readOnlyHint` and do not declare both `destructiveHint: false` and `openWorldHint: false` (so tools with no hints are asked about); everything else is allowed. Without a UI every such call is allowed. The always-held rules still apply.

## Permission rules

Rules settle specific calls, in Claude Code's syntax and with its order: `deny` beats `ask` beats `allow`. They live in four scopes that are added together, and you write them in `tool-gate.json`, in the approval dialog (**Allow rule for this session / in this project / everywhere**) or with `/gate rules`.

| List | A matching call |
| --- | --- |
| `deny` | Is blocked without asking you. The agent is told which rule it matched and that you forbade it, and not to look for a way around it. |
| `ask` | Always asks you, in every mode but yolo, even in auto mode: no Jev call, no push-back. The dialog offers Allow once, Block and Block with a message. |
| `allow` | Runs without a Jev call (and in manual mode without asking), when the rule covers it. |

A deny rule applies in every mode, yolo and chat mode included. An allow rule never overrides a deny or an ask rule, the [always-held calls](#1-clear-cases-no-model-call) (below), or the [directory policy](#directories) for a shell command. In chat mode a rule does not make a command read-only, so it stays blocked; an ask rule asks only about calls that read there.

### Syntax

| Rule | Covers |
| --- | --- |
| `Bash(git push:*)` or `Bash(git push *)` | The command `git push` with any arguments: `git push`, `git push origin main`, not `git pushx`. A prefix of whole words. |
| `Bash(git log * main)`, `Bash(*vercel*--prod*)`, `Bash(ls*)` | A `*` anywhere else matches any text, spaces included, as in Claude Code: `git log --oneline main`, not `git log main`; `vercel deploy --yes --prod` and `npx vercel --prod`; `ls` and `lsof`. Matched against the command's words joined by single spaces. One simple command per rule. |
| `Bash(npm test)` | Exactly that command: `npm test`, not `npm test -- --watch`. Compared as words, so quoting and spacing do not matter; a command with `$` or a backtick must match as written. |
| `Bash` or `Bash(*)` | Every shell command. |
| `Edit(src/**)`, `Write(...)`, `Read(...)` | A file path, as in `.gitignore`: relative to the project (the git checkout of the working directory) or `~/` or absolute. See [paths](#paths). |
| `web_fetch`, `mcp__server`, `mcp__server__*` | A tool by name. `mcp__server` covers every tool of that server; `*` in a name is a wildcard. |

`bash` and `bg_run` are `Bash`; `edit` is `Edit`; `write` is `Write`; `read`, `grep`, `find` and `ls` are `Read`. The four names are case-insensitive. Only `Bash`, `Edit`, `Write` and `Read` take a specifier: `WebFetch(domain:example.com)`-style rules are not supported, and a rule that cannot be read is ignored and listed by `/gate rules`. In a `Bash` rule every `*` is a wildcard; `:*` means a trailing ` *` only at the end, and a trailing ` *` that is the rule's only wildcard is a prefix of whole words that also matches the bare command (`Bash(ls *)` covers `ls`, not `lsof`). Put a pattern's `*` after the subcommand in an allow rule: `Bash(git * main)` allows every git subcommand, including `git -c core.fsmonitor=<script> diff main`, so `/gate rules` flags an allow rule with a `*` before the subcommand, as Claude Code warns at startup. Ask and deny patterns are the way to catch a flag wherever it appears: with `Bash(vercel deploy *)` allowed, `Bash(*vercel*--prod*)` and `Bash(*vercel*--target*production*)` as ask rules keep production deploys behind a prompt. `Bash(git push && rm x)` is an exact rule for that whole call, never a prefix.

### How a shell call is matched

The call is split into its simple commands (at `;`, `&&`, `||`, `|`, `&` and newlines), plus the commands inside `$(...)`, backticks, `<(...)`, `>(...)`, an unquoted here-document's substitutions, and the text of `sh -c '...'`, `bash -c`, `eval` and `sudo`.

- **Deny and ask** match when any of them matches, or the exact rule names the whole call. `Bash(rm -rf:*)` denies `git status && rm -rf x`, `ls $(rm -rf x)`, `bash -c 'rm -rf x'` and `sudo rm -rf x`.
- **Allow** must cover every command that does more than read. `Bash(git push:*)` allows `cd sub && git push origin x; ls`, not `git push && rm -rf x`. Read-only commands (`ls`, `cat`, `cd`, `echo`, `git status`, ...) need no rule, unless they redirect output to a file. Text run by `sh -c` is not covered by a rule for what is inside it: the `bash -c '...'` command itself must be allowed (the dialog offers its exact text). A call held only for a substitution or a redirect, whose commands all read, needs a rule for each of them (or the exact text).
- **What a command is called** includes the program as typed (`bin/homelab`; `./bin/homelab` is the same, `./git` is not `git`), the program past assignments and wrappers (`time npm test` is `npm test`), and for a prefix rule the program and subcommand it names (`git -C ../x push` is `git push`, `docker compose -f a.yml up` is `docker compose up`). An allow rule does not look past an assignment or wrapper option that changes what runs (`PATH=... git push`, `git -c ...`, `env -S`), or a program named by a path of its own.
- **A wildcard pattern** (`Bash(git log * main)`) matches the command as typed, past assignments and wrappers, or (deny and ask) as `sudo` runs it; it is not matched against the program-and-subcommand key, so `git -C x log -1 main` needs a pattern that allows for the option. An allow pattern never matches a command with `$` or a backtick.
- **A command this cannot read as a program with arguments** (a program named by a substitution or variable, `export A=1`, `set -e`) is opened only by a rule naming the whole call.
- **Always-held calls** (`sudo`, a force-push to main, a download piped to a shell, credential files, downloaded code) are never opened by a prefix rule, a bare tool rule or a wildcard path: only an exact rule does, `Bash(git push --force origin main)` for the whole command, `Edit(.env)` or `Read(.env)` for a credential file without wildcards. Downloaded code stays allow-once only, whatever the rule. Deny rules apply to all of them.

### Paths

`Edit`, `Write` and `Read` rules take gitignore-style patterns:

- `src/**` is anchored at the project and covers everything below `src` and `src` itself (so `ls src` is a read of it); `**/*.test.ts` crosses directories; `*` and `?` stay within one path part. As in `.gitignore`, a pattern that matches a directory covers everything in it, so `src/*` covers `src/a/b.ts`.
- A pattern with no slash matches at any depth (`*.env`, `generated`). `./package.json` is anchored at the project.
- `~/notes/**` is under your home; `/etc/app/**` is an absolute path (Claude Code's `//etc/app/**` works too).
- `edit` and `write` rules allow only their own tool, but a deny or ask rule for either covers both, as Claude Code's `Edit` rules do. `Read` rules cover `read`, `grep`, `find` and `ls`.
- A path rule applies to Pi's file tools, not to the paths a shell command names; use the [directory policy](#directories) and the always-held credential files for those. An allow rule for `Edit`, `Write` or `Read` also opens the directory policy for that tool: `Edit(~/dotfiles/**)` lets `edit` write there without a folder grant (a [derived path](#directories) stays held).

### Where rules live

All scopes are added together; no scope overrides another's deny or ask.

| Scope | Stored in | Changed by |
| --- | --- | --- |
| session | memory, never saved | the dialog, `/gate rules` |
| project (this machine) | `~/.pi/agent/tool-gate/project-grants.json` (under `PI_CODING_AGENT_DIR`), keyed by the project's main checkout so its worktrees share it | the dialog, `/gate rules` |
| project (shared) | `<project>/.agents/tool-gate.json` and `<project>/.pi/tool-gate.json`, `permissions` | you; read-only for `/gate rules` |
| user | `~/.pi/agent/tool-gate.json` (`PI_CODING_AGENT_DIR` honored), `permissions` | the dialog, `/gate rules` |
| user (shared) | `$XDG_CONFIG_HOME/agents/tool-gate.json` (default `~/.config/agents/`), `permissions` | you; read-only for `/gate rules` (it may be managed by another tool) |

The machine-local project scope stays outside the repository because its rules and folder grants hold this machine's absolute paths. The files take Claude Code's `permissions` block:

```json
{
  "permissions": {
    "allow": ["Bash(npm test)", "Bash(git push:*)", "Edit(src/**)"],
    "ask": ["Bash(git push --force:*)", "Read(notes/**)"],
    "deny": ["Bash(rm -rf:*)", "Read(.env)", "mcp__untrusted"]
  }
}
```

The lists of all four files are added together (unlike the rest of `tool-gate.json`, where arrays replace). The `agents` files are read by the opencode and Claude Code ports of this plugin too, which ignore keys they do not know, and this package ignores the other keys Claude Code puts in a `permissions` block. Rules are re-read before each call.

### The approval dialog

A held call that rules can name offers them, with the rule in the question and short rows (at most 42 characters, so a phone client reads them without wrapping):

```text
Allow bash git push origin feature?
Rule: Bash(git push:*)

→ Allow once
  Allow rule for this session
  Allow rule in this project
  Allow rule everywhere
  Edit the rule...
  Block
  Block with a message
```

- **This session**, **in this project** and **everywhere** add the rule to the `allow` list of the session, the machine-local project scope or your user file. If it cannot be saved (a user file that is not valid JSON), the call is allowed for the session and a warning says so.
- **Edit the rule...** opens the rule on a `›` line (one per line when there are several), checks it, and comes back to the dialog with the edited rule. A rule that is not one is refused with the reason and offered again as typed; Esc keeps the rule.
- **The suggested rule** is today's key of the call as a prefix: program and subcommand when it takes one (`git push`, `docker compose up`, `gh repo create`, `bin/homelab status`), skipping `cd`, `echo`, loop headers and here-document text. For a call with several keys there is one rule each, all shown. A script runner names its script (`python3 scripts/x.py:*`, `node server.js:*`). `edit` and `write` offer their folder (`Edit(src/a/**)`; a file directly in the project, `Edit(./package.json)`), other tools their name (`web_fetch`, `mcp__server__tool`).
- **No rule** is offered for a command containing `*`, which a rule would read as a wildcard.
- **The exact command** is offered instead of a prefix for programs whose arguments are the risk: `rm`, `mv`, `chmod`, `chown`, `dd`, `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `sudo`, `gh api`, and inline code (`python -c`, `node -e`, `bash -c`, `sh -c`, an interpreter fed on stdin). The whole call is the rule when the gate cannot read a command in it as a program with arguments (`export A=1`, a program named by a substitution), when its commands all read and are held only for a substitution or redirect, and when a here-document is fed to one of those risky programs (`git commit -F - <<EOF` is still a prefix). When a rule cannot be written back as exact (a command ending in a bare `*`), none is offered.
- **Always-held calls** offer only Allow once, Block and Block with a message. Add an exact rule with `/gate rules add` to open one.
- A hold by the [directory policy](#directories) offers the folder instead (`Allow folder for this session`, `in this project`; no everywhere), listed with the rules.

Without Pi's terminal UI the same rows are a plain select, and Edit opens Pi's editor with the rule.

### `/gate rules`

`/gate rules` prints every rule grouped by list and scope with the file it comes from (and the folder grants, and any rule it could not read), then a picker: pick a rule to remove it (session, this machine's project and your own user file; a rule from a shared file says which file to edit), or **Add a rule...** to choose the list, the scope and the rule. Arguments work too:

```text
/gate rules list
/gate rules add allow Bash(git push:*) --scope project
/gate rules add deny Read(.env) --scope user
/gate rules remove allow Bash(git push:*) [--scope session|project|user]
```

`--scope` is `session`, `project` (this machine's) or `user`; the default is `project`. `/gate grants` is the same command.

### Older saved grants

The project grants saved before rules existed are read as rules, in the machine-local project scope, with no rewrite until you change one: `bash:<key>` is `Bash(<key>:*)`, `tool:<x>` is `<x>`, `edit:<dir>` and `write:<dir>` are `Edit(<dir>/**)` and `Write(<dir>/**)`, an `unparsed shell:` key is the exact command, and `dir:` keys stay folder grants. A grant for reads with substitutions or redirects has no rule that says it and is no longer used. New rules are saved in the same file as entries with a key such as `allow:Bash(git push:*)`, which an older version lists as a grant and ignores. Rules match a program as typed, so a grant for a script run by its path (`bin/homelab status`, saved as `homelab status`) no longer covers `bin/homelab status`; allow it again.

### Compared with Claude Code

Same: the `allow`, `ask` and `deny` lists with deny, then ask, then allow; the rule syntax for `Bash(prefix:*)`, `Bash(exact)`, `Edit`, `Write`, `Read` and bare tool names; `mcp__server` for a server's tools; gitignore-style paths with `~/` and `//`-absolute; splitting compound commands so that a rule for one part does not allow the others; the same `permissions` block in a settings file.

Different:

- Only `Bash`, `Edit`, `Write` and `Read` take a specifier. There is no `WebFetch(domain:...)` or other tool specifier, and no managed (organization) scope. `Bash` wildcards follow Claude Code's (anywhere in the rule, matching spaces too); a `*` cannot be written as a literal asterisk.
- A path starting with `/` is absolute here; in Claude Code it is relative to the settings file's project and `//` is absolute. `//` works here too.
- `Edit` and `Write` allow rules cover their own tool (Claude Code's `Edit` covers every file-writing tool); deny and ask rules cover both.
- Path rules apply to Pi's file tools, not to the paths in shell commands.
- A prefix rule also matches through global options and wrappers (`git -C x push`, `time git push`) and sees through `sudo`, `sh -c`, `eval` and substitutions for deny and ask. Allow rules never open the calls the gate always holds, except an exact rule, and never downloaded code.
- The scopes are session, this machine's project, the project's shared files and your user files (in Claude Code, user, project, local and managed). Ask rules do not apply in yolo mode (deny rules do).
- Modes, the judge and the directory policy are this plugin's own; `permissions.defaultMode` and `additionalDirectories` are not read (`directories` is the folder policy).

## Directories

Pi has no directory boundary of its own, so the gate keeps one. In auto, manual and accept-edits modes (and for reads in chat and plan mode), a call is held when it touches a path outside its project's directories, before any Jev call. Auto mode pushes it back once, as with any held call, and then asks you. The dialog's **Allow folder for this session** and **in this project** grant that folder (listed by `/gate rules` beside the rules): a folder under a private root (`~/Projects/other`), the private root itself for a file directly in it (`~/Downloads/shot.png` grants `~/Downloads`), else the file's directory, or the directory itself when the write is to an existing one (a writing command's working directory: `cd ~ && chezmoi apply` grants `~`, not `/Users`).

- The project (the git checkout of the working directory, and the main checkout of a worktree) is always readable and writable.
- Private roots (`directories.private`: `~/Projects`, `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive) are neither read nor written outside the project and its grants.
- Other paths (system and toolchain directories, `~/.config`) can be read. They can be written only under `alwaysWrite` (temp and cache directories) or a `write` grant.
- `directories.read` grants extra readable directories (`["*"]` reads anywhere). `directories.write` grants extra directories to read and write. Paths take `~` and globs (`~/Projects/herdr-*`). Relative paths are relative to the project.
- `directories.derived` lists paths generated from a source elsewhere: a deployed config file, a build output or a generated client. A write to one outside the project is held even when a grant covers it, and the agent is told the entry's `hint` (word for word) instead of a Jev workaround, so it edits the source instead. Entries are `{ "path": "...", "hint": "..." }` or a bare path.
- `directories.exemptCommands` lists commands whose paths the policy does not check, typically the one that regenerates the derived paths from their source. An entry is a program and its leading words (`make install`, `stow`), matched by the program's base name and its first non-option arguments. Jev and the always-held rules still judge the command; redirects and other commands in the same line are still checked.

```json
{
  "directories": {
    "derived": [{ "path": "~/.config", "hint": "Edit the source in ~/Projects/dotfiles, then deploy it." }],
    "exemptCommands": ["stow"]
  }
}
```

Put a project's grants in its `.agents/tool-gate.json`, which the opencode and Claude Code ports read too:

```json
{ "directories": { "read": ["*"], "write": ["~/Projects/dotfiles"] } }
```

The gate finds paths in `read`, `grep`, `find` and `ls` arguments (reads) and `edit` and `write` paths (writes). In shell commands it finds words that look like paths (a slash, `~`, `.`), resolved after any `cd`:

- Read-only commands read them.
- `rm`, `mv`, `mkdir`, `touch`, `tee`, `ln`, `chmod` and the like write them, `cp`, `rsync` and `install` write their last operand, and `sed -i` writes its files.
- Any other program is assumed to write what it names.
- Output redirects write their target, resolved where their command runs, and input redirects read theirs. A redirect to `/dev/null` is never a write.
- A command run in another directory reads that directory, or writes it when the command does more than read.
- Commands inside `$(...)`, backticks, `<(...)`, `>(...)`, `sh -c` and `eval` count like any other, run where the command around them runs. Shell keywords (`for ... in`, `do`, `then`, `done`) are not commands: a loop or `if` counts by the commands in it.

This is a heuristic over arguments. Paths a program builds at runtime are not seen. Yolo mode ignores the policy, as Claude Code's bypass mode ignores its directories. `/gate` shows the resolved policy, and `"directories": { "enabled": false }` turns it off.

## Commands

- `/mode [work|chat|plan]`: select workflow; without an argument, open the picker. Exec is entered only through a handoff.
- `/approvals [auto|yolo]`: select approvals; without an argument, open the picker. Legacy `manual` and `accept-edits` arguments remain supported.
- `/gate` or `/gate status`: both axes and keys, counts, Jev model, push-back setting, project rules, permission rules and folder grants.
- `/gate rules [list | add | remove]`: [permission rules](#gate-rules) and folder grants: list them, pick one to remove it, or add one. `/gate grants` is the same.
- `/gate on`, `/gate off`: auto mode, or yolo mode.

Separate `workflow-mode` and `permission-mode` statuses show the axes and their keys; the gate also reports `gate: N auto · P pushed back · M asked`. Every call Jev judges is recorded in the session as a `tool-gate:decision` custom entry (tool, clipped arguments, scores, failures, action, latency, input tokens), for tuning thresholds. Jev's token usage is added to the gated tool's result.

## Project rules

These are guidance for Jev, not [permission rules](#permission-rules). Each top-level bullet (`-`, `*`, `+` or `1.`; indented lines continue it) in these files is a rule, checked on every judged call:

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

The `agents` locations are shared with the opencode and Claude Code ports of this plugin; keys a port does not know are ignored. The `permissions` block (`allow`, `ask`, `deny`; see [permission rules](#permission-rules)) is the exception to the merge rule: the lists of every file are added together. Settings are reloaded at session start and before each agent run. The defaults:

```json
{
  "enabled": true,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 8000 },
  "thresholds": {
    "irreversible": 0.9, "remoteChange": 0.85, "requested": 0.7, "exfiltration": 0.8,
    "impact": 2.5, "offTask": 0.1, "offTaskImpact": 2, "rule": 0.7
  },
  "allowTools": [
    "codemode", "tool_search", "todo", "ask_user_question", "plan_mode_question", "plan_mode_complete",
    "enter_plan_mode", "exit_plan_mode", "web_search", "fetch_content", "get_search_content", "code_search", "radius_web_search", "web_enable",
    "bg_status", "bg_logs", "bg_result", "bg_wait", "bg_kill", "subagents_enable"
  ],
  "readOnlyCommands": [],
  "pushBack": true,
  "defaultWorkflow": "work",
  "defaultApproval": "auto",
  "workflowShortcut": "shift+tab",
  "approvalShortcut": "alt+a",
  "directories": {
    "enabled": true,
    "private": ["~/Projects", "~/Documents", "~/Desktop", "~/Downloads", "~/Library/Mobile Documents"],
    "read": [],
    "write": [],
    "alwaysWrite": ["/tmp", "/private/tmp", "/dev", "$TMPDIR", "~/.cache", "~/Library/Caches", "~/.npm", "~/.bun", "~/.cargo", "~/.rustup", "~/.pyenv", "~/.local/share", "~/.local/state"],
    "derived": [],
    "exemptCommands": []
  }
}
```

- `enabled`: `false` defaults new sessions to yolo approvals unless `defaultApproval` overrides it.
- `defaultWorkflow` and `defaultApproval`: new-session defaults for each axis. Legacy `defaultMode` supplies fallback values where a new default is not set; restrictive legacy manual and accept-edits values are preserved.
- `modes` is deprecated and no longer controls either cycle. `cycleShortcut` is a legacy fallback when `workflowShortcut` is not a string.
- `workflowShortcut` and `approvalShortcut`: keys read at startup; `""` disables each. Reload after changing them. A duplicate key registers workflow only and reports the collision.
- `jev`: the classifier model (`provider`/`model`, looked up among Pi's classifier models) and its timeout; `enabled: false` uses the hint fallback.
- `thresholds`: the bars described above.
- `allowTools`: tools that never need a decision. Setting it replaces the whole default list.
- `readOnlyCommands`: extra programs treated as read-only in shell commands.
- `pushBack`: `false` asks you on the first hold instead of blocking it once.
- `directories`: the [directory policy](#directories). Its lists replace the defaults, so to add a private root, repeat the default ones.

## Requirements and costs

- Jev runs through Pi's classifier models (`ctx.modelRegistry.classify`), which needs Pi 0.99 or newer, and Pi's credentials for the provider (`TYPESAFE_API_KEY` for the default `typesafe` provider). Without them the hint fallback applies.
- Each gray-zone call makes one Jev request; each held call makes one more for the workaround (also for always-held calls). These requests can be billed by the provider.
- It runs `git branch --show-current`, `git status --porcelain`, `git check-ignore` and `git rev-parse --show-toplevel --git-common-dir` in the working directory, reads the target file of an edit or write to show a diff, and reads a local script a judged shell call runs (up to 64 KB) to send its content to Jev. It writes nothing to disk except `tool-gate:decision` entries in the Pi session.

## Optional integrations

- **Herdr**: while an approval dialog is open, the gate emits `herdr:blocked` on Pi's event bus (`{ active: true, label: "Allow? bash: ..." }`, then `{ active: false }` when it closes), so Herdr's Pi integration shows the pane as blocked. Outside Herdr nothing listens.
- **pi-bg**: `bg_run` is judged like `bash`, in its own `cwd`; the read-only `bg_*` tools are on the default allow list.
- **pi-subagents**: a subagent's approval dialogs reach you through pi-subagents' dialog forwarding.
- **pi-plan-mode**: provides plan mode in the cycle (above).
- **pi-status-footer**: shows workflow as a bold `WORK`, `CHAT`, `PLAN` or `EXEC` landmark, separate from Approvals and the gate tally. Badge hues depend on the theme; explanations and key hints stay subdued. During a blocked dialog the compact row retains the badge when available, subject to terminal width.

## Limitations

- It is not a sandbox. It inspects tool names and arguments before a call; it does not confine what a command does once it runs. The read-only command rules are a parser's best effort over shell syntax, and Jev's judgment is probabilistic.
- Tools in `allowTools` are never inspected. `codemode` is on the default list because the tools its scripts call are expected to be gated on their own; if they are not in your setup, remove it.
- When Jev is unavailable and there is no UI, every call except the always-held ones is allowed.
- Downloaded code is found by the forms above. Files whose names the command does not give (`gh release download` without `-O`, `-D` or `-p`, `curl -J`), files unpacked from a downloaded archive, downloads by other programs or tools, and a downloaded program run by bare name from `PATH` are not tracked.
- A script's content is read when the call is judged; a script that changes it while it runs is not seen.
- Session rules and folder grants are held in memory; this machine's project rules are saved outside the repository. The mode is saved in the session.
- Permission rules match by words, not by what a program does: `Bash(rm -rf:*)` does not deny `rm -fr x` or `rm -r -f x`, and a rule for a script's name does not follow what the script runs. Path rules cover Pi's file tools, not the paths a shell command names. Treat deny rules as guardrails, not as a sandbox.

## Development

```sh
cd packages/pi-tool-gate
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the vitest unit tests. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

`npm run eval` makes live, paid classifier requests; run it only with explicit authorization. It runs the package's eval targets through the repository's one runner (`scripts/eval.mjs --package pi-tool-gate`; the target shape and the runner are in `evals/shared/`) through the Pi installation on `PATH` (or `PI_PACKAGE_DIR`), and is skipped without `TYPESAFE_API_KEY`. The runner prints each target's report and `spend: $X over N calls`, appends a record (commit, seed, `EVAL_*` parameters, spend, calls and the numbers) to `evals/results/<id>.jsonl` in the repository (git-ignored), and exits non-zero when a target fails. From the repository root, `npm run -s eval -- --list` shows every target, `--dry <id>` counts the Jev calls a run would make without calling Jev, and `--last <id>` prints the last record with its difference from the one before. Targets, run by id (`npm run -s eval -- gate`) or all together (`npm run -s eval -- tool-gate`):

- `gate` (`eval/gate.target.ts`) judges 38 hand-written labeled calls, each with the verdict it should get (allow, hold, or either), and asks Jev for the workaround of each call it holds. It passes when no verdict misses its label and fewer than 20% of the Jev calls fail.
- `sessions` (`eval/sessions.target.ts`, planning in `eval/plans.ts`) replays real sessions from `~/.pi/agent/sessions` (`evals/shared/sessions.ts`, shared with pi-auto-effort: `EVAL_RECENT`, `EVAL_SAMPLE`, `EVAL_SEED`, `EVAL_MIN_PROMPTS`, `EVAL_MIN_TOOLS`). It plans each tool call of each sampled branch as the gate does in auto mode (`planCall`, with this machine's settings, rules and project grants), counts the clear cases and the downloaded-code holds, and asks Jev about the judged calls with the conversation as it stood then, 8 at a time. A call that ran counts as allowed and one you blocked as held; it reports Jev's holds on allowed calls (extra prompts) and allows on held calls (misses), and with `EVAL_COMPARE=1` judges each call that runs a script again without its content (recorded as the `compare` numbers). It costs one request per judged call: a default sample can hold thousands (`--dry sessions` counts them with `collect` and `countCalls`). It passes when fewer than 20% of the Jev calls fail; the rest is a report.
- `replay-file` (`eval/replay-file.target.ts`) replays recorded decisions from a JSON file, `GATE_REPLAY=decisions.json npm run -s eval -- replay-file` (each record has `users`, optional `prior`, `intent`, `tool`, `args` and an optional `label`). Without `GATE_REPLAY` it makes no call and passes. It passes when at most 5% of the verdicts are wrong and fewer than 20% of the Jev calls fail.

## License

MIT. See [LICENSE](./LICENSE).
