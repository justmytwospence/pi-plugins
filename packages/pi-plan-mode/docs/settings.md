# pi-plan-mode settings reference

[Back to README](../README.md#%EF%B8%8F-settings)

Settings live in `<getAgentDir()>/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`).
The file may be a symlink; saves write through it, preserve unknown fields, and publish atomically.
The Settings step of `/planners` edits planners, efforts, subagent models, the time limit, Jev tool
selection, rendered plans, the default implementation context, the export path, and the shortcut;
everything else is edited in the file. An invalid file is ignored (defaults apply) and never overwritten.

### System 1 tool selection

`jevToolSelection` (default `true`) controls automatic tool preselection for either System 1 backend; `jevThreshold` remains the preselection threshold. `jevProvider` and `jevModel` are compatibility overrides for Jev only, for both tool selection and effort recommendations. The latter are independent of `jevToolSelection`. `/system1` configures the suite-wide order of Jev and OpenAI Decisions (Jev only by default); Decisions requires the `pi-system1` component and an isolated `/login system1-openai` API key or `SYSTEM1_OPENAI_API_KEY`, not subscription OAuth. Before selecting Decisions, claim eligible [Pro API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) in an organization with no purchased balance, auto-recharge or paid continuation. Pi cannot verify entitlement or funding. Requests can be billed. Operational failures can advance to the next configured backend with a notification; valid judgments and safety refusals do not trigger failover. The Tools step retains its fallback preselection when the chain is exhausted. Default `alwaysOffer` includes `system1_judge` and legacy `jev`; an explicit list replaces the defaults.

### Workflow and shortcut

`toggleShortcut` is unset by default. Without pi-tool-gate it toggles local work/plan; with the gate it cycles workflow, so do not configure it on the gate's own key. Gate's default Shift+Tab requires remapping Pi's stock `app.thinking.cycle`; Pi skips conflicting shortcuts. Gate's Alt+A changes approvals independently, including during planning. Plan mode alone does not enforce approvals.

### Plan files and names

`plansDirectory` sets where temporary drafts, approved plans, `/planners` implementation plans and
**Save for later** snapshots are written (default `~/.pi/agent/plans`; `~` is expanded).
Inline planning starts with a unique `draft-<timestamp>-<uuid>.md` path before a title exists.
The draft is not renamed while the agent writes it; planning guidance requests a concise,
descriptive first Markdown heading.

On approval, a newly allocated temporary draft is copied to a descriptive file using the exact
final reviewed text, including approval-editor changes. Implementation uses the new path; the
original draft stays intact for historical references and recovery. The filename comes from the
first usable title, normalized to a hyphenated slug of at most 80 characters. Missing, generic
(`Plan` or `The Plan`) and non-ASCII-only titles use `untitled-plan`. Collisions add `-2`, `-3`,
etc. without overwriting existing files. Reapproval keeps the approved path; existing,
restored legacy and user-provided paths are not renamed or replaced.

`/planners` implementation uses the same title-derived naming for the selected plan's current
text. **Save for later** suggests a title-derived name but your edited name is authoritative;
`.md` is automatic and collisions receive numeric suffixes. Saving leaves the original draft
intact, ends planning without implementation and clears the active plan so the next task gets a
new draft.

`defaultPlanExportPath` sets the explicit export path (default `PLAN.md`, relative to the project).
Export paths are not replaced by title-derived names, and exporting to an existing file still
reports a collision rather than overwriting it.

### Plan model pairs

Built-in plan model pairs (`anthropic/fableplan`, `anthropic/opusplan`, `openai-codex/astraplan`, `openai-codex/solplan`, `openai/astraplan`, `openai/solplan`) need no settings; see the README's [Plan model pairs](../README.md#plan-model-pairs). Planner and worker are Fable and Opus, Opus and Sonnet, Astra and Sol, and Sol and Terra. Each family resolves to the highest available generation on the pair's provider (the worker prefers the planner's generation), and a pair whose models are unavailable is not offered.

`modelPairs` adds or replaces pairs. Each key is the `provider/id` the pair registers under in `/model`:

```json
{
  "modelPairs": {
    "anthropic/fableplan": {
      "planner": "anthropic/claude-fable-5-1",
      "worker": "anthropic/claude-sonnet-5-1",
      "name": "Fable plan, Sonnet build"
    },
    "openai/reviewplan": { "planner": "openai/gpt-6-astra", "worker": "openai/gpt-6.1-terra" }
  }
}
```

A key equal to a built-in pair replaces it in place; other keys are added after the built-ins. `name` defaults to `<planner id> plan, <worker id> build`. The whole file is invalid (defaults apply, and it is never overwritten) when:

- a key is not a `provider/modelId` or has an effort suffix;
- `planner` or `worker` is missing, not a `provider/modelId`, or has an effort suffix;
- `planner` and `worker` are the same model;
- an entry has any key other than `planner`, `worker` and `name`;
- `name` is not a non-empty string of at most 80 characters.

A custom pair whose planner or worker is not available is not offered, like a built-in one. Effort is not part of a pair: System 1 judges it at plan entry and at approval, and you can override either (see [Choosing effort](https://pi-plugins.vercel.app/guides/effort/)). `defaultImplementationContext` (`keep` or `clear`) selects the `/planners` Implement step's context default. The earlier `implementationModelMap`, `defaultImplementationThinkingLevel`, `completionReview` and `completionMaxRevisions` keys are ignored.

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

