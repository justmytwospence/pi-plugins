# pi-plan-mode

A Pi extension with two ways to plan before anything changes:

- **Plan mode**, as in Claude Code, in your own conversation: `/plan` (or Shift+Tab with [pi-tool-gate](../pi-tool-gate/) after an explicit stock thinking-key remap) turns it on, your agent researches read-only and writes its plan to a plan file, then shows you the plan and asks who implements it.
- **`/planners`**, a full-screen planner for two models at once: both plan the same task read-only while you watch, answer their questions, and talk to them. Once both plans are in, a pane below them is your own main agent, which got every plan, talks them over with you, questions the planners, and writes the merged plan when you ask. Then you implement the plan you like, with the model, effort, and context you choose.

It acts only while plan mode is on, when you run `/plan` or `/planners` (or press the shortcut you configured), while a planning run you started is alive, and when your agent calls `enter_plan_mode` or `exit_plan_mode`.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-plan-mode/>. Started as a fork of [`@narumitw/pi-plan-mode`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode); see [License](#license).

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-plan-mode/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-plan-mode
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies. Pi loads `src/index.ts` directly; there is no build step. Requires Pi 0.99 or newer. Install only from sources you trust: Pi extensions run with Pi's permissions.

## Plan mode

```text
/plan Add rate limiting to the public API
```

`/plan` turns plan mode on and, with a task, sends it as your next message. With [pi-tool-gate](../pi-tool-gate/), plan is a workflow: Shift+Tab cycles work, chat and plan after moving or disabling Pi's stock `app.thinking.cycle` in `keybindings.json` (current Pi otherwise skips the conflicting shortcut). Approvals are independent; Alt+A toggles auto and yolo. Without it, set `toggleShortcut` to toggle plan mode with a key. Your agent can also turn plan mode on itself with `enter_plan_mode` when a task deserves a plan first.

While plan mode is on:

- Your agent is told (once, with your next message, or right away mid-turn) to research, ask you what it cannot find out, and write its plan to a **plan file**, `~/.pi/agent/plans/<two-words>.md` (`plansDirectory` moves it). One file per session: entering plan mode again continues it.
- `edit` and `write` are blocked except for the plan file. Commands: with pi-tool-gate, the gate judges them as in auto mode (as Claude Code's classifier does while planning); without it, only read-only commands run (the [shell policy](./docs/settings.md)).
- When the plan is ready, your agent calls `exit_plan_mode`. The plan shows in the chat (Mermaid diagrams drawn as terminal diagrams, top-down when a left-to-right chart is too wide) and you choose:
  - **Yes, implement here** (first and default): your current model implements it in this conversation, keeping the context.
  - **Yes, compact plan and implement here**: compact to the approved plan and implement with the same model in the same session, without creating a child session.
  - `Yes, hand off to <model> (<effort>)`: an available, distinct model implements it in this session. When this turn ends, the context is compacted down to the plan, the model is switched, and a collapsed handoff message (`ctrl+o` expands it) carries the plan and how to implement it; implementation starts at once.
  - **Edit the plan first**: edit it in your external editor (Pi's `externalEditor` setting, else `$VISUAL` / `$EDITOR`; a Markdown editor such as [edamame](https://github.com/mijowi/edamame) keeps it rendered while you edit), or in Pi's editor when none is set; the file is updated and you choose again. The approval tells your agent the plan was edited.
  - **No, keep planning**: say what should change (or leave it empty, or press Esc, and say it in the chat). With an editor provider such as pi-vim the field is that editor (Enter or `:w` sends, Escape in Normal mode or `:q` cancels). Plan mode stays on.
- Ordinary same-model approval returns to work without changing approvals. A distinct-model handoff enters exec. Leaving plan for chat does not permit edits.

When you decline and the agent revises a plan, approval shows a short **What changed** bullet summary followed by the full current plan in normal styling, not a red/green prose diff. Without a supplied summary it says **Plan revised since your last review.** First or identical submissions show no revision summary. Editing the plan in the approval dialog clears any stale agent summary; the full current plan is always authoritative.

Up/Down selects an approval option; Left/Right adjusts effort on every execution option, including both direct choices; Enter confirms and Esc/Ctrl+C cancels. Both direct rows share the current model's effort selection. Direct execution starts at the current effort; handoffs use the target's configured effort suffix, then `defaultImplementationThinkingLevel`, then `medium`. Levels are normalized to those the model supports (the greatest supported level no higher than requested, else the first supported level); nonreasoning models have no effort adjustment. Changes apply only to this approval, not saved defaults. In RPC, action and effort are separate selectors. Changing effort alone is not a model handoff: model identity is provider plus model ID.

`implementationModelMap` supplies ordered handoff choices. Without an explicit entry, provider-local defaults are **Astra → Sol, Terra; Sol → Terra; Fable → Opus, Sonnet; Opus → Sonnet**, nearest tier first. Sonnet, Terra and unrecognized families have none. Defaults stay within the exact provider (`openai`, `openai-codex` or `anthropic`) and use authenticated available models, independently of your cycling shortlist, preferring the same generation, otherwise the highest available numeric generation. The cycling shortlist (`enabledModels`/scoped models) does not restrict implementation choices; the `/planners` planning-model picker remains scoped. Explicit mappings may cross providers. Unavailable, duplicate and same-model targets are removed; there is no pi-subagents worker fallback or same-model pseudo-handoff. The two direct choices are always available. See [settings](./docs/settings.md#implementation-choices-and-effort) for lists and empty-list opt-out.

Direct execution is ordinary chat: no exec mode, seeded consultant, `ask_planner`, `finish_plan`, completion card/review or return to a planning branch. The agent implements, verifies and replies normally, with or without same-session compaction. Plans are written to a handoff standard: Summary, Decisions, Changes (files, signatures, behavior), Steps, Verification, Out of scope and Handoff notes, so an actual handoff needs no new design decisions.

### Exec mode

Approving a distinct-model handoff starts exec mode; Shift+Tab never enters or leaves it. Approvals remain independent and Alt+A can change them. Exec remains active through consultation, review, revisions and pauses until final completion or an explicit stop. Plans are named by their first heading, not their file name.

#### Planner on call

After a handoff, the model that planned stays on call. Your implementing agent gets `ask_planner`: it asks when the plan does not fit what it finds, and waits for a decision. The planner is a copy of the planning conversation (opened the first time it is asked), so it keeps its research context; it can read the current files, including the implementer's changes, and run read-only commands. It is as capable as a `/planners` planner given every tool: all your `plannerToolsets` (web research, MCP servers), every command grant, and read-only subagents on `scoutModelMap`'s model (else pi-subagents' `explorer` model). The only file it may write is the plan file: when its answer changes the plan it edits the file and adds a dated line under `## Amendments`, and the expanded consultation card shows the amendment diff. Each ask is a planning-model turn over the planning context; its cost counts in the footer and in the session totals.

#### Unplanned files

The first edit or write of each file the plan does not list (paths in backticks in its Changes) gets a note appended to the tool result, telling the implementer to ask the planner, or to record the departure under `## Amendments` without one. Nothing is blocked, and a plan that names no paths gets no notes.

#### Completion review and recovery

**`finish_plan` submits for completion review; it does not itself end exec mode.** The implementer supplies nonempty `report`, `verification` (including checks not run) and `concerns`. Only an explicit structured **Accepted** decision completes reviewed work. The planner reviews the approved plan and amendments, current files and commit history; it does not rerun tests, treat reported checks as independently verified, or introduce new preferences. Changes requested return to the same implementer context for fixes or evidence-backed disputes. Each later submission must respond exactly once to every outstanding finding by ID, with status `addressed`, `disputed` or `blocked` and an explanation.

`completionMaxRevisions` is an integer from 0–5, default **2**: the initial review plus two fix-and-review cycles means at most three reviews before pausing. Zero still performs the initial review. Failures do not consume revision cycles and are never automatically retried. Exhausted revisions, human-only checks or decisions, unavailable planners, invalid/empty replies, timeout and cancellation pause visibly with exec mode, model and implementation context intact. Calling `finish_plan` again cannot bypass the pause or reset the budget.

Explicit recovery uses `/plan-exec` (without arguments, shows phase, findings and actions):

- `/plan-exec retry`: after a failed or interrupted review, authorize one retry of the saved submission without resetting counts or costs.
- `/plan-exec resume <answer>`: answer a user-needed question or authorize one extra revision-and-review cycle after budget exhaustion. Each further extension requires another explicit command. Human answers remain user-provided evidence.
- `/plan-exec accept`: while paused, confirm **Finish without planner acceptance?** with **Finish without review**, or choose **Keep paused**. Confirmation produces **Completed by user override**, preserving findings and limitations, never **Accepted**. No interactive UI means no override.
- `/plan-exec stop`: abandon the execution as **Implementation stopped**, without claiming completion, restoring the model or returning to the planner.

With `completionReview: false`, completion is explicitly **Completed without review**. Accepted, configured no-review and confirmed override are final outcomes; only then does normal model restoration and return-to-planning navigation run. If return navigation fails, the saved return remains retryable with `/plan-back`. Paused work survives reload; interrupted in-flight exchanges restore paused, without another paid request.

Consultations and reviews are readable transcript cards: **Consultation N** shows Question, Planner decision and (when expanded) Plan amendment; pending calls show **Planner thinking…** and activity. **Review N** shows the submitted report and verification, previous findings paired with implementer responses, then the planner's evidence, limitations and findings. Pending exchanges and actionable findings in the latest unresolved review stay fully visible; older narratives fold to 12 lines. Consultation summaries use the actual decision's first paragraph, not a generated success claim. Cards use explicit labels as well as semantic colors: green for accepted; amber for changes, user-needed, no-review or override; red for review failure. Unfinished work is never labeled Finished. The footer shows exec on the workflow row with its phase (`implementing`, `consulting`, `review N`, `revising · N findings` or `paused · user needed/review unavailable`), consultation count and separate cumulative consultation and review costs; approvals have their own row when the gate is present. Final completion cards show a concise outcome with previews of the implementer-reported report, verification and concerns. In Pi's terminal UI, Ctrl+O opens the full recorded detail, including the complete reports, reviewed evidence, revision history, changed files, remaining limitations and separate consultation/review totals. Reported checks are not independent verification.

While exec is active, `enter_plan_mode`, `/plan`, `/planners` and workflow changes are refused. Use `/plan-exec` for status and recovery, or `/plan-exec stop` to leave exec; stopping or completing returns to work without changing approvals. Reload and branch navigation restore the recorded state. A failed or aborted handoff returns to plan for reapproval when the session has not since changed.

The plan tools are model-only: your agent calls them directly, never inside `codemode`. This keeps the plan's inline renderer visible while you approve it.

In Pi's fullscreen terminal mode, **Plan review** scrolls the chat to the beginning of the plan when the approval picker opens. Short plans get temporary trailing space so their beginning is at the top too. Scroll the chat to read; redraws leave your position alone. After editing, review starts at the revised plan's beginning. Closing review removes the space and follows the latest message again. Regular terminal mode and RPC keep their usual presentation; their scrollback is not controlled by this extension.

`planCompleteCommand` runs for an approved plan, as it does for `/planners`.

## The planners screen

```text
/planners Add rate limiting to the public API
```

`/planners` (with or without a task) needs Pi's interactive terminal UI; everything else happens on the screen, which covers the whole terminal. It always runs two planners; for one plan, use plan mode. A step bar at the top right shows where you are:

**Settings → Tools → Planning → Review → Implement**

### 1. Settings

One page with the task, the planners, and your preferences. Up/Down (or Ctrl+K/Ctrl+J, Ctrl+P/Ctrl+N, `k`/`j`) pick a row, Left/Right (or Ctrl+H/Ctrl+L, `h`/`l`; Space also steps forward) change its value, Enter edits a text row or goes on, Esc closes.

- **Task**: a box above the rows, shown in full and wrapped. Tab moves into it and out of it; while it has focus every key goes to its editor (Shift+Enter for a new line, Enter to save and go on). Empty plans what the conversation so far is about.
- **Planner A** and **Planner B**, each with its **effort** and **subagents** (the model its read-only helpers run on, with their own **effort**; `none` turns them off). B defaults to a different model than A.
- **Time limit** per planner turn (15 to 180 minutes; default 45). At 80% the planner is asked to wrap up; at the limit it is stopped.
- Preferences: whether tools are picked automatically (**Auto-pick tools**), whether finished plans are rendered (below), **Completion review** (`completionReview`, default on), **Review revisions** (`completionMaxRevisions`, 0–5, default 2), where implementation starts by default, and the export path.

Changes are saved as your defaults in `~/.pi/agent/pi-plan-mode.json`.

### 2. Tools

What the planners may use: Shell (read-only commands and any command grants), Subagents, your toolsets (for example web research), MCP servers and their tools, and **Other tools** from your other Pi extensions. When Jev tool selection is on and a Jev classifier is available, Jev scores every tool for the task while you look and preselects the ones that would make the plan better informed; your own changes win. Tools in `alwaysOffer` (by default web research, Context7 docs and Jev judgments, where you have them) are always preselected and marked `always`: Jev scores them but never turns them off.

Keys: Up/Down (`k`/`j`, Ctrl+P/Ctrl+N, Ctrl+K/Ctrl+J) move, Ctrl+U/Ctrl+D move ten rows, `g`/Home and `G`/End jump to the ends, Space or `x` toggles, Tab opens or closes a group, Right/`l` opens a group or steps into it, Left/`h` closes it or goes up, `a` selects all, `n` selects none, Esc goes back. Enter asks `Start planning with N planners?`; Enter or `y` starts, Esc or `n` keeps editing.

### 3. Planning

Above the lanes, one live row per planner (and M, your main agent, once it is there) shows its state, how long its turn has run, its tool calls, subagent tasks, tokens, cost, and what it is doing now. One lane per planner, side by side. Each shows its planner's chat (or its plan, once it has one; the rule under the lane shows the two as tabs, `plan  chat`, and Left/Right on an empty line switch), the subagents it has running, and a line to talk to it. Type and press Enter to steer a working planner or to start a new turn with an idle one; both planners can be working on your messages at once. Sending a message shows the chat; a new plan version shows the plan from its top.

With **Rendered plans** on (the Settings step; default on), a plan view is a styled page instead of terminal text: headings, tables, highlighted code, task lists, GitHub callouts (`> [!NOTE]` and the rest), and Mermaid diagrams, in the Pi theme's colors with code in your terminal's font (read from Ghostty's config when Pi runs in Ghostty). [terminal-browser](https://github.com/zenbu-labs/terminal-browser) renders the page through its embedded mode; Pi keeps a picture of it and shows that in the lane with Kitty graphics placeholders, so it needs terminal-browser on `PATH` and a terminal Pi shows Kitty images in (Ghostty, Kitty, or herdr inside one). Scrolling moves through the picture like text, with no redrawing: Up/Down, PgUp/PgDn, Ctrl+U/D, Home/End and the wheel; Left/Right still switch to the chat; M's pane renders plan M the same way. The page is captured again when the plan, the colors or the lane's width change, taking about half a second. Mermaid comes bundled (`vendor/mermaid`); a diagram it cannot draw shows as text art. Without terminal-browser or Kitty graphics the row says `unavailable`; when a page cannot be shown, that lane keeps the terminal text and its rule says why. The pages are temporary files, deleted when the screen closes.

When a planner asks a question, the bottom of its lane becomes the question, as in pi-ask-user-question: its options, then `Type something.` and `Skip (let the planner decide)`. Up/Down, `j`/`k` or Ctrl+J/Ctrl+K move, a digit jumps to that row, Enter picks. On `Type something.`, Enter or just typing opens the answer line (a pi-vim editor goes to Insert mode); Enter saves the answer, Esc goes back to the options and keeps the draft. While a question is up, keys go to it, not to the chat line; Ctrl+U/Ctrl+D still scroll the chat above. With several questions, Left/Backspace (back) and Right (forward, up to the first unanswered one) move between them to change an earlier answer; nothing is sent until all are answered.

Lane keys, as the planner screen implements them:

| Keys | |
|---|---|
| Tab, Shift+Tab | move between the lanes, the M pane (once it is there) and the actions |
| Up/Down | scroll the focused lane a line (when no question is waiting) |
| Left/Right | on an empty line, switch the lane between its plan and its chat (while a question is up, move between its questions) |
| j/k, 1-9, Space | while a question is up: move, jump to a row, open `Type something.` |
| Ctrl+U/Ctrl+D, PageUp/PageDown | scroll the focused lane half a page or a page (these keys are taken by the lane, not its message line) |
| Mouse wheel | scroll the lane under the pointer |
| Ctrl+O | expand or collapse tool output (and, with pi-cc-render, collapsed thinking) in a chat, as in Pi |
| Ctrl+T | hide or show thinking in a chat, as in Pi |
| Ctrl+N/Ctrl+P | step through a planner's running subagents; Esc goes back to the planner |
| Shift+Up/Shift+Down | move the divider above M by a row |
| Esc | leave (below) |

A lane's chat (and M's) is drawn by Pi's own components: Markdown, thinking, and every tool call with its own renderer (extension tools included). A restored planner's chat shows its history.

Pi's built-in commands that matter for a planner work in its lane and act on its own session: `/login [provider]` (a failed planner then retries), `/model [query]`, `/thinking [level]` (or `/effort`), `/compact [instructions]`, `/context` (or `/usage`), `/copy` and `/help`. The hint line lists the matching ones as you type. Start a message with `//` to send one that begins with a slash. In M's pane, which is your main session, a `/command` leaves `/planners` with the command in your editor, so every Pi command is there.

### 4. Review

Once both plans are in (or one is, and the other planner failed), a full-width pane appears below the lanes: **M, your main agent**, the agent of the session you started `/planners` from, so it has all your context. Until then it has nothing to do, so the lanes get the whole screen; when it appears, its chat says so, and so does a notification if the screen is hidden. What you type there goes to it (a new turn, or a steer while it works), and the pane shows its replies as they stream. Each plan, and each revision, lands in your main conversation in full as it arrives, with what you and that planner said since its previous version. While a run is active your agent has two tools:

- `plan_ask_planner`: ask planner A or B about its plan or what it found; the planner answers from its own research (the question shows in its lane as `main agent › …`). It refuses while that planner is working or waiting for your answers.
- `plan_submit_merged`: when you ask for it, record the merged (or adjusted) plan as **plan M**; the M pane shows it (Left/Right switch between the plan and the chat).

You do not have to word that request yourself: **Write plan M** in the actions asks M to merge both plans and what you decided into plan M, and once there is one, **Revise plan M** asks it to fold in what you discussed since. Either moves you to M's pane to watch it write.

M is asked, not forced, to leave files alone while planning is underway. The focused pane gets the room: M takes the bottom third while you talk to it and shrinks to a few lines otherwise. To choose the split yourself, drag M's title rule (the divider) with the mouse, or press Shift+Up/Shift+Down; that size then holds for the rest of the Pi session, and a double-click on the divider goes back to the automatic sizing.

The actions (Left/Right or `h`/`l` choose, Enter runs) are, as they apply:

- **Log in to <provider>…**, first, when a planner failed because its provider refused its credentials (an expired or revoked login): it opens Pi's login dialog in place, as `/login` does, and the planner tries again once you are logged in.
- **Write plan M** (with two plans in, until M has one; not while M is working).
- **Implement…**: the Implement step; its Plan row picks M (first, once there is one), A or B.
- **Revise plan M** (right after Implement, once M has a plan).
- **Export…**: a page with the plan (M first) and the path (prefilled from settings); Enter writes that plan to a Markdown file.
- **Discard**: stop the planners and throw these plans away. (Esc hides the screen and keeps them.)

Leaving Implement or Export with **back to the plans** returns to the actions bar.

You can keep talking to either planner in Review, too.

### 5. Implement

The row page selects the **plan** (M, A or B), **mode**, **effort** and **context**. **Here** is the default mode: it always uses your main session's current model and effort, regardless of who wrote the selected plan. Context is **keep conversation** or **compact to plan (same session)**. Both are ordinary execution with a normal final reply, no exec mode, consultant or completion review, and no child session.

**Handoff** appears only when the plan author's mapping or provider-local defaults offer an available target distinct from your current session model. Its model row cycles only those ordered targets. It retains the existing keep-conversation or fresh-child context choices; a fresh child receives only the implementation brief and plan. Actual handoffs activate exec mode: the author planner (A or B) stays on call; plan M has a planner on call only with a fresh child. Consultation, `finish_plan` and completion review remain available on these paths.

Left/Right adjusts each row, including effort in either mode. Here starts at the current effort; handoff effort uses the configured target suffix, then `defaultImplementationThinkingLevel`, then `medium`, normalized to supported levels as in inline approval. Switching modes preserves per-model effort selections. Enter closes the planner and starts implementing.

### Leaving, stopping and reopening

**Esc** on the planning screen (after leaving a focused subagent) asks before leaving:

- **Hide (keep planning)**, or **Hide (keep the plans)** when nothing is working: close the screen. Planners keep working in the background; the footer shows their state (for example `plan: A working · B ready (/planners)`), and you are notified once when one asks something or a new plan version is ready.
- **Stop planning** (only while something is working): stop every working planner, and abort your main agent's turn if it is running. The plans so far are kept.
- **Back**: return to the screen.

Planners are stopped from this screen (Stop planning, Discard, or implementing a plan, which ends the run) or by their time limit; they are also shut down when the Pi session ends or switches (a turn cut off that way resumes when the run is restored). Planners and their research scouts are entries in `/tasks` and contribute pills to FleetView or pi-bg's fallback host. Enter returns to the planning screen; double-`x` stops a working planner row. Scout rows are observational, not independently stoppable from the list; stop their owning planner or use the planning screen. `/stop` remains pi-bg's shell-only command and does not reach them.

`/planners` reopens the screen where you left it, also after `/reload` or resuming the session: planners keep their sessions on disk, so you can keep talking to them. A planner whose turn the reload or restart cut off, or whose last turn failed, resumes by itself; its lane shows `continue (resumed …)` or `try again (resumed after an error)`.

## How it works

Each planner is its own in-process Pi session (created with Pi's SDK):

- It starts with your main conversation's messages, so it has your context.
- It runs on its own model and effort, with only the tools you chose, under a read-only policy (this package's planner extension): `edit` and `write` are blocked, `bash` is limited to reviewed read-only commands plus your command grants and `safeSubcommands`, MCP calls are limited to the servers and tools you selected, and tools you did not select are refused.
- It reaches models through the providers your session registered, so subscriptions and custom providers work without extra setup.
- The planner on call (exec mode) is a seeded copy of the planning session under `~/.pi/agent/plan-mode/planners/`. It gets what a `/planners` planner gets with every row of the Tools step selected except Other tools (your other extensions' tools, which the read-only policy does not cover): read-only shell plus every command grant, every toolset and MCP server, and `plan_subagents`; `edit`/`write` are limited to the plan file.
- It asks you questions with `plan_mode_question` (shown in its lane) and submits its plan with `plan_mode_complete`; resubmitting makes a new version.
- Its subagents (`plan_subagents`) are read-only `pi` subprocesses on the subagent model. Planners and subagents start without your extensions, so a provider extension the parent session loaded (detected: pi-anthropic-auth, which keeps a Claude subscription paying) is passed to them; `providerExtensions` overrides this per provider (`[]` turns it off).

M is not another session: the M pane shows your main session's own events and sends what you type to it. Each plan is added to that session as a message without starting a turn (your agent reads it on its next turn; in your main chat it shows collapsed, and Pi's expand key expands it). The run's two tools are active only while a run is, and their guidelines tell your agent how to use them and to change nothing while planning is underway. Implementing "in this conversation" then builds the plan in the session that discussed it.

Planner sessions are stored under `~/.pi/agent/plan-mode/planners/`; runs are saved as custom entries in your session so `/planners` can restore them.

## Configuration

`~/.pi/agent/pi-plan-mode.json` (Pi's agent directory; a symlink is fine, saves write through it). The Settings step edits the common ones; the rest are JSON-only. An invalid file is ignored (defaults apply) and never overwritten. Example (the model names are placeholders):

```json
{
  "planners": ["anthropic/claude-fable-5-1:xhigh", "openai-codex/gpt-6-astra:xhigh"],
  "scoutModelMap": {
    "anthropic/claude-fable-5-1": "anthropic/claude-opus-5-5:high",
    "openai-codex/gpt-6-astra": "openai-codex/gpt-6.1-sol:high"
  },
  "plannerTimeoutSeconds": 2700,
  "implementationModelMap": {
    "anthropic/claude-fable-5-1": ["anthropic/claude-opus-5-5:high", "anthropic/claude-sonnet-5-1:medium"],
    "openai-codex/gpt-6-astra": []
  },
  "defaultImplementationContext": "keep",
  "defaultPlanExportPath": "PLAN.md",
  "plansDirectory": "~/notes/plans",
  "plannerToolsets": {
    "web": {
      "label": "Web research",
      "description": "Web search and page fetching.",
      "extensions": ["~/.pi/agent/npm/node_modules/pi-web-access"],
      "tools": ["web_search", "fetch_content", "get_search_content"]
    },
    "mcp": {
      "label": "MCP servers",
      "description": "Connected services.",
      "mcp": true,
      "extensions": ["builtin:mcp", "builtin:codemode"],
      "tools": ["codemode"]
    }
  },
  "commandGrants": {
    "jev": {
      "label": "Jev judgments",
      "description": "Ask TypeSafe's Jev for fast typed judgments mid-research: rank or filter many files or search hits, classify items, check claims against a source, triage long output.",
      "commands": ["~/.local/bin/jev-ask"],
      "skills": ["~/.agents/skills/jev-judgments"],
      "enabled": false
    }
  },
  "jevToolSelection": true,
  "jevThreshold": 0.5,
  "jevProvider": "typesafe",
  "jevModel": "jev-latest",
  "planCompleteCommand": ["bash", "~/.claude/hooks/save-plan-to-obsidian.sh"]
}
```

- Model specs are `provider/modelId`, optionally with `:off|minimal|low|medium|high|xhigh|max`.
- `planners`: planner A and (optionally) B, preselected on the Settings step.
- `scoutModelMap`: planner model to the model its subagents run on.
- `plannerTimeoutSeconds`: the per-turn time limit (default 2700, 45 minutes).
- `implementationModelMap`: ordered lists of handoff model specs, keyed by the planning model. Legacy scalar specs are accepted as one-element lists; `[]` disables automatic handoff defaults for that exact model without removing direct execution. Missing entries use the provider-local families above. `scoutModelMap` remains scalar and independent.
- `defaultImplementationThinkingLevel`: handoff effort when the target has no suffix; otherwise `medium`. Direct execution defaults to the current effort.
- `defaultImplementationContext` (`keep` or `clear`): the Implement step's context default.
- `defaultPlanExportPath`: the export path (default `PLAN.md`, relative to the project).
- `toggleShortcut`: a key that toggles plan mode (with pi-tool-gate, it cycles the gate's modes instead, like the gate's own Shift+Tab); none by default. Do not set it to the gate's key. It changes after `/reload`.
- `plansDirectory`: where plan mode writes plan files (default `~/.pi/agent/plans`; `~` is expanded).
- `alwaysOffer`: tools planners always get, whatever Jev scores: a toolset, command grant, MCP server, or Other tool by id or name (`web`, `jev`, `context7`), or one tool of a group (`web/web_search`, `context7/query-docs`). Unset, it is `["web", "web_search", "fetch_content", "context7", "jev"]` (names your setup lacks are ignored); set it to replace that, or to `[]` to leave every tool to Jev.
- `plannerToolsets`: named bundles of extensions and tools; `mcp: true` expands into your MCP servers. `commandGrants`: extra commands bash may run (one per call), with skills that explain them.
- `renderedPlans` (default `true`): finished plans as rendered pages in their lanes (see Planning and Review).
- `completionReview` (boolean, default `true`): targeted completion review after handoff; an unavailable planner pauses when review is enabled. Turning it off produces **Completed without review**. Review costs are separate from consultation costs.
- `completionMaxRevisions` (integer 0–5, default `2`): fix-and-review cycles after the initial review; **Review revisions** in `/planners` Settings cycles the limit.
- `jevToolSelection` (default `true`), `jevThreshold` (default 0.5, the probability at which a tool is preselected), `jevProvider` (default `typesafe`), `jevModel` (default `jev-latest`).
- `providerExtensions`: provider id to the extensions planners and subagents load when their model is on that provider; an entry replaces detection for that provider.
- `planCompleteCommand` runs when you implement or export a plan, with Claude Code `PostToolUse`-shaped JSON on stdin (`tool_input.plan`, `tool_response.filePath`, `model`), so a hook written for Claude's `ExitPlanMode` works unchanged. Its output is ignored, it is killed after 30 seconds, and failures never break planning.
- `safeSubcommands` (JSON-only) fully trusts command prefixes in the planners' bash policy; see the [settings reference](./docs/settings.md), which also describes the built-in read-only shell policy.

## Requirements and costs

- Pi 0.99 or newer and its interactive terminal UI.
- Planners, their subagents and M make ordinary model requests on the models you pick, through your session's providers, billed as those providers bill them. Each planner and each subagent is a separate session, so two planners with subagents can use several times the tokens of one agent. The planning screen shows tokens and cost per planner.
- Jev tool selection makes an optional classifier request through Pi's classifier models (default `typesafe/jev-latest`, which needs Pi's credentials for it, such as `TYPESAFE_API_KEY`); it can be billed. Without a classifier the Tools step uses its fallback preselection.
- Your agent plans on your session's model. An enabled completion review with a planner on call adds a separate model turn over its seeded planning context.
- On disk: it reads and writes `~/.pi/agent/pi-plan-mode.json`, writes plan mode's plan files under `~/.pi/agent/plans/` (or `plansDirectory`), appends plan-mode state entries and hidden notices to your session, stores planner sessions under `~/.pi/agent/plan-mode/planners/`, appends run entries and plan messages to your session, writes exported plans where you choose, and writes a temporary plan file for `planCompleteCommand`.

## Optional integrations

- **pi-tool-gate**: owns workflow and approvals independently. Plan joins the workflow cycle (Shift+Tab needs a stock `app.thinking.cycle` remap); the gate judges commands while planning under either approval setting. Ordinary approval returns to work without changing approvals. They communicate through `workflow-mode` events; see pi-tool-gate's `src/modes.ts`. Without the gate, plan mode has its own work/plan toggle and read-only shell policy, and does not enforce an approval policy.
- **pi-subagents**: optional scout-model integration through `subagents:role-model` (the `explorer` role when no `scoutModelMap` entry applies). Its worker model is not an implementation fallback.
- **Herdr**: while any planner is working, the extension holds `herdr:working` on Pi's event bus (`{ active: true, label: "Planning" }`, then `{ active: false }`), so pi-herdr shows the pending run in Herdr's sidebar; while a planner waits for your answers it also holds `herdr:blocked` (`label: "Planner question"`). Outside Herdr, or without pi-herdr, nothing listens.
- **pi-anthropic-auth** (or any extension named in `providerExtensions`): forwarded to planners and subagents on that provider.
- **Custom editors** such as pi-vim's: the Task box uses the editor component your main editor uses, so its modes work there (pi-vim's `:q` leaves the box instead of quitting Pi).

## Limitations

- Completion review does not rerun tests: the planner is instructed not to modify files or run tests and must distinguish implementer-reported checks from evidence it inspected. The existing on-call policy still permits plan-file edits and configured grants; it is not a sandbox. An assessment is not proof of independently verified checks or user approval.
- `/planners`' Handoff fresh context is a child session; Here compaction keeps the same session.
- The read-only policy covers Pi's `edit`/`write` (blocked), shell commands and MCP calls. Toolset and Other tools you select run as their own extensions implement them, and command grants and `safeSubcommands` bypass the shell review (see the [settings reference](./docs/settings.md)). It is not a sandbox.
- M (your main agent) is only asked to leave files alone while planning.
- At most two planners per run.
- `/planners` does nothing outside the interactive terminal UI. Plan mode works without a UI, but nobody can approve a plan there.
- Plan mode blocks `edit` and `write` outside the plan file and (without pi-tool-gate) non-read-only shell commands. Other extension and MCP tools your agent has keep working; it is told not to change anything with them.

## Development

```sh
cd packages/pi-plan-mode
npm ci
npm run check
```

`npm run check` runs `biome check .`, `tsc --noEmit -p tsconfig.test.json` and the vitest tests; `npm run format` applies Biome's fixes. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

Source layout:

```text
src/
├── index.ts            # entry: the planner app, or the MCP guard inside a subagent
├── plan.ts             # /plan and /planners: settings, tools, runs, implement, export, restore
├── inline-plan.ts      # plan mode in your conversation: plan file, enter/exit tools, approval
├── handoff.ts          # the plan standard and the implementation brief
├── exec.ts             # exec mode: the planner on call, finish_plan, unplanned-edit notes
├── active-tools.ts     # turning extension tools on and off
├── plan-file.ts        # plan files: names, paths, reading and writing
├── main-chat.ts        # your main agent as M: delivered plans, the run tools, the M pane's view
├── app/                # the full-screen pages: options rows, lanes, frame
├── planner/            # in-process planner sessions: agent, session, policy extension, access, prompts
├── tool-tree*.ts       # the tools tree and its screen
├── jev-tool-picker.ts  # Jev's tool scores
└── tool-policy.ts, command-grants.ts, mcp-tools.ts, scout-process.ts, settings.ts, …
```

## License

MIT. See [LICENSE](./LICENSE).

Started as a fork of [`@narumitw/pi-plan-mode`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode) from narumiruna/pi-extensions (MIT, history preserved); the planner has since been rebuilt around in-process planner sessions.
