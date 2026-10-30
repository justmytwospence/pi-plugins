# pi-plan-mode settings reference

[Back to README](../README.md#%EF%B8%8F-settings)

Settings live in `<getAgentDir()>/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`).
The file may be a symlink; saves write through it, preserve unknown fields, and publish atomically.
The Settings step of `/planners` edits planners, efforts, subagent models, the time limit, Jev tool
selection, rendered plans, completion review, the default implementation context, the export path, and the shortcut;
everything else is edited in the file. An invalid file is ignored (defaults apply) and never overwritten.

### Implementation choices and effort

`implementationModelMap` maps an exact planning `provider/modelId` to an ordered list of handoff
model specs. Specs accept an optional `:off|minimal|low|medium|high|xhigh|max` effort suffix:

```json
{
  "implementationModelMap": {
    "anthropic/claude-fable-5-1": [
      "anthropic/claude-opus-5-5:high",
      "anthropic/claude-sonnet-5-1:medium"
    ],
    "openai-codex/gpt-6-astra": []
  },
  "defaultImplementationThinkingLevel": "medium"
}
```

Legacy scalar model specs are still accepted as one-element lists; existing normalized scalar
objects are accepted too. No automatic rewrite is needed. Lists preserve order, including empty
lists; invalid members invalidate the settings file. An explicit `[]` disables automatic handoff
defaults for that exact planning model, not direct execution. A missing entry uses the built-in
defaults; `null` resets the whole map. `scoutModelMap` remains a separate scalar mapping.

Built-in defaults are provider-local, in this order:

| Planning family | Handoff families |
| --- | --- |
| Astra | Sol, Terra |
| Sol | Terra |
| Fable | Opus, Sonnet |
| Opus | Sonnet |
| Sonnet, Terra, unrecognized | None |

OpenAI families match `gpt-<numeric dotted generation>-astra|sol|terra` IDs on `openai` or
`openai-codex`; Anthropic families match `claude-fable|opus|sonnet-<numeric dash generation>`
IDs on `anthropic`. Defaults never cross provider IDs. Each target family prefers a same-generation
sibling, otherwise the highest available numeric generation, with lexical model-ID tie breaking.
Unrecognized aliases or snapshot formats do not generate defaults. Only available/scoped models
are offered, even when that catalog is empty. Explicit mappings may cross providers and override
defaults; unavailable, duplicate and same-model targets are filtered, preserving the first effort
choice. There is no pi-subagents worker fallback or same-model pseudo-handoff.

Inline approval always starts with **Yes, implement here**, then **Yes, compact plan and implement
here**, followed by handoffs, Edit and Keep planning. Up/Down navigates, Left/Right adjusts effort
on every execution option, Enter selects, and Esc/Ctrl+C cancels. Both direct rows share the model's
effort selection; RPC uses separate action and effort selectors. `/planners` defaults to **Here**
with the main session model even for a plan written by A or B; **Handoff** is offered only when the
plan author's targets include a distinct available model. Its model row cycles those targets, and
its effort row is adjustable with Left/Right in both modes.

Direct execution retains the current effort by default. Handoffs use the target suffix first,
then `defaultImplementationThinkingLevel`, then `medium`. Unsupported levels normalize to the
greatest supported level no higher than requested, or the first supported level if none qualifies.
Nonreasoning models have no effort adjustment. Approval changes are per approval, not saved
settings; `/planners` retains per-model effort selections when changing modes. Model identity is
provider plus model ID: changing effort alone is not a handoff.

Direct execution is ordinary chat with normal implementation, verification and a final reply:
no exec mode, seeded consultant, `ask_planner`, `finish_plan`, completion card/review or planner
branch return. It may keep the conversation or compact to the approved plan in the same session,
never a child. Actual distinct-model handoffs retain consultation and the exec/completion workflow.
Inline handoffs compact in-session and retain planner return; `/planners` Handoff still supports
an explicit fresh child. Its Here context choices are **keep conversation** and **compact to plan
(same session)**; `defaultImplementationContext` (`keep` or `clear`) selects the default context.

### Completion review

`completionReview` (boolean, default `true`) enables a targeted review by the on-call planner when
`finish_plan` is called after an actual handoff. Direct execution does not use this workflow. Toggle it with **Completion review** in `/planners` Settings. The review is
an additional model turn, with its cost shown separately from implementation consultations. If disabled,
the completion card remains but the review is skipped; if there is no planner on call, no review is made.

The colored **Implementation complete** card separates the implementer's required `report`,
`verification` and `concerns` fields from the planner's assessment and consultation count.
Verification, outstanding issues, verdict and count stay visible when collapsed; Ctrl+O expands
only the longer implementation and assessment narratives. The reviewer inspects relevant files, working-tree changes and commit
history, distinguishing inspected evidence from reported checks. It is instructed not to run tests or
mutate files; its tool policy is not a sandbox. Failed or unavailable reviews are reported as such, not
as success. The assessment is informational, not user approval or an automatic implementation of findings;
`finish_plan` still ends exec mode.

### Rendered plans

`renderedPlans` (boolean, default `true`) shows each finished plan in its `/planners` lane as a page
rendered by terminal-browser; `false` keeps terminal text. It needs `terminal-browser` on `PATH` and
a terminal with Kitty graphics. Environment variables for unusual setups:

- `PI_PLAN_MODE_TERMINAL_BROWSER`: the terminal-browser executable to use; empty turns rendering off.
- `PI_PLAN_MODE_FRAMES`: `shared` (the terminal reads the picture from shared memory on this machine,
  the default locally and in herdr) or `inline` (the pixels travel through the terminal, the default
  over SSH without herdr; Linux only).
- `PI_PLAN_MODE_SCALE`: the page's pixel ratio; by default it follows the terminal's cell height
  (2 for Retina-sized cells).

### Safe shell subcommands

`safeSubcommands` maps any command prefix to subcommand prefixes that the user chooses to trust completely in limited `bash` and `powershell`.
For example, `"kubectl": ["get", "apply"]` trusts commands beginning with `kubectl get` or `kubectl apply`, while `"npm": ["run inspect-custom"]` trusts commands beginning with `npm run inspect-custom`.
Command keys and subcommand entries are trimmed and must be non-empty strings.
Matches are literal and case-sensitive after leading whitespace in the submitted command is ignored.
A match requires the complete `<command> <subcommand>` prefix followed by whitespace, a shell control operator, or the end of the submitted command, so `"kubectl": ["apply"]` does not match `kubectl applies`.
Duplicate values and command keys that become equal after trimming are merged in first-seen order.
Omitted `safeSubcommands`, an empty object, and empty arrays preserve the default policy.

When a configured prefix matches, the planners' policy permits the complete submitted command without parsing or applying any command, argument, mutation, chain, redirect, expansion, substitution, multiline, or PowerShell syntax checks.
For example, `"kubectl": ["apply"]` also permits `kubectl apply -f deployment.yaml && rm -rf build`.
Likewise, `"gh": ["pr view"]` permits `gh pr view 218 --web`, `gh pr view 218 > pr.txt`, and any trailing shell content.
The setting therefore delegates the complete shell decision to the user and can allow arbitrary code execution with Pi's permissions.
It is not a sandbox, confirmation gate, or read-only guarantee.
Choose entries that are as specific as your workflow permits, and configure them only for commands and repositories you fully trust.

Commands that do not match still use the built-in fail-closed reviewed policy.
That default policy includes Git `status`, `log`, `diff`, `show`, `branch`, `remote`, `ls-files`, and `grep`, with command-specific argument checks.
It rejects output and input redirects, shell expansion and substitution, explicit pager or browser requests, explicit external diff, textconv, filter, or signature helpers, mutating flags, malformed command layouts, and any parsed chain containing an unsafe segment.
Read-dominant Git validators accept ordinary inspection flags without requiring `--no-textconv` or `--no-ext-diff`; Git may therefore invoke a helper configured by the user or trusted repository even when the command does not request one explicitly.
Use the negative flags when you want to suppress those configured helpers.
Mixed read/write surfaces remain narrower: use `git remote show -n` to avoid invoking a transport helper, while mutating `branch` and `remote` forms remain blocked unless explicitly trusted through `safeSubcommands`.

Read-only does not mean private: Git inspection can expose repository history and tracked secrets, while configured commands can expose or modify any data available to Pi's process.
A built-in-policy `git -C <path>` inspection is accepted only when the path keeps Git in Pi's current working directory.
The default policy reduces accidental mutation and cross-repository executable configuration; configured `safeSubcommands` bypass that protection.
A non-object `safeSubcommands`, empty command or subcommand string, non-array value, or non-string entry invalidates the entire settings file and triggers the normal warning/default fallback on session start.

