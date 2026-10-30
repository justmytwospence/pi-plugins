# pi-next-prompt

A Pi extension that suggests the prompt you would most likely send next, like Claude Code's prompt suggestions. After a run, an ordinary suggestion appears as dim ghost text inside the empty editor, with no hint. `Tab` (or `Right`) fills it in; it is not sent. Typing hides it, and deleting what you typed brings it back, until you send a prompt. A draft already in the editor when the run ends does not lose an ordinary tag suggestion: it waits out of sight, and appears once you stash the draft (pi-stash's `Ctrl+S`) or delete it. With pi-stash and nothing stashed, `Ctrl+S` stashes the suggestion instead (`prompt:take-next` on `pi.events`).

Automatic suggestions only appear when there is one obvious next step. Most turns show nothing. Explicit requested handoffs instead use `offer_prompt` for ordinary text or Pi slash commands, or `offer_terminal` for shell commands.

Example of the ghost text in an empty editor:

```
────────────────────────────────────────────────────────────
 Do step 2: add an assert for neg in test.js
────────────────────────────────────────────────────────────
```

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-next-prompt/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-next-prompt/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-next-prompt
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## How it works

- **The main model writes the suggestion.** In interactive terminal sessions, a short system prompt section (`next_prompt`) asks the model to end its final message with one line `<next>...</next>` for an ordinary nonterminal next step, only when exactly one concrete next step is obvious. It leaves the tag out when the task is done, when it needs your input, when several steps are equally likely, or after an error. No extra model request is made for the suggestion itself.
- **Interactive commands use `offer_terminal`.** With optional pi-interactive-shell available, the model uses this model-only tool for interactive handoffs, including requested manual tests after implementation and automated checks. Its sole input is `command`: the raw, complete shell command, without an `!i` or `!!i` prefix. The tool prepends `!i ` and offers an editable suggestion; it never executes, submits or overwrites a draft. Quotes and internal whitespace are preserved exactly. Blank, boundary-whitespace (which Pi would strip on submission), multiline, control-character and prefixed inputs are rejected, as are suggestions exceeding a positive `maxChars`; commands are never truncated. The ghost may be clipped to the editor's width, but acceptance copies the whole command. Credentials never belong in a suggestion.
- **The line never stays in context.** On `message_end`, every line that consists only of a `<next>...</next>` tag is removed before the message is stored, so the session file and every later request carry the answer without it. Tags inside a line of prose are left alone. While the answer streams, the line is visible for a moment before it is removed. The last tag in the latest assistant message wins; one before a tool call is superseded by the final answer. With `maxChars` above 0, a longer suggestion is dropped; the default, 0, sets no limit.
- **Jev vets ordinary tags.** [Jev](https://docs.typesafe.ai), through Pi's classifier models, is asked whether the suggestion is a concrete, non-generic next step that follows from the answer, is not already done, and is something you would plausibly send next. Its input is your last prompt (clipped to 1,500 characters), the tail of the answer (2,000 characters) and the suggestion. The suggestion is shown at probability >= `jev.threshold` (default 0.6). If Jev is off or unavailable (no classifier model or credentials, timeout, error), the suggestion is shown anyway.
- **When ordinary tags show.** Only after a run that completed (not aborted or failed), only while the editor is empty (with a draft there, it is held until the editor is empty again), and only in the interactive terminal UI. Print mode, RPC mode and subagents get no instruction. Sending a prompt, a new run, compaction, switching models, navigating the session tree, starting a session, or `/next-prompt off` clears it.

## Verified prompt handoffs

When you ask the model to put ordinary text or a Pi slash command in your prompt, it should call the model-only `offer_prompt({text})` tool with the complete exact text, not rely on prose or a `<next>` tag. It works without pi-interactive-shell. For example, `/marimo new examples/viewer-demo.py` remains byte-for-byte identical; this tool does not run marimo or validate slash names against a partial command registry.

Input must be one nonempty line, with no leading/trailing whitespace, C0/C1 controls or line breaks. Any text beginning `!` is rejected: use `offer_terminal` for shell handoffs. Internal spaces and quotes are preserved, with no prefix, normalization or truncation. A positive `maxChars` rejects longer input; visual clipping does not shorten acceptance. Never include credentials.

A `displayed` receipt means the ghost or fallback widget included the suggestion in actual component output within one second, not that you saw it or that it was inserted into the editor. `blocked` is an explicit tool error naming the blocker. Queuing or mounting alone is not acknowledgement. The model must wait for `displayed` before claiming an offer; after the response finishes successfully, Tab/Right copies it into the editor, then Enter submits it. Nothing is overwritten, submitted or executed by the tool or acceptance key.

Blockers include disabled suggestions, non-TUI or unattached UI, non-main focus or autocomplete, a nonempty draft, an external owner or a different outstanding explicit offer, length/input validation, timeout, abort or reset. Identical same-kind offers are idempotent; prompt and terminal offers cannot replace each other. Draft entry or focus loss before successful settlement invalidates ownership; reset, reload/shutdown and failed or aborted settlement clear it. After successful settlement, a temporary focus change (for example, to Sidebar) suspends an acknowledged offer until the main editor regains focus. Prompt offers require no shell inspection or inline terminal support.

Explicit offers bypass Jev, outrank automatic tags and survive a tagless final answer or conflicting ordinary tag. They can render while busy, but cannot be accepted before successful settlement. Ordinary automatic suggestions remain optional and retain tag/Jev vetting. On blocked, the model should name the blocker and print the complete text plainly as a fallback, without claiming it is offered or in the editor. These instructions do not guarantee every model complies. Prompt acceptance never emits a shell-continuation signal; submitting a slash command uses Pi's normal command handling.

## Verified terminal offers

`offer_terminal` waits at most one second for the ghost or fallback widget to include the suggestion in its actual component output. A `displayed` result acknowledges that render, not that you have seen or accepted it. A queued offer alone is not displayed. A `blocked` result is an explicit tool error with a concrete reason. The model must not claim it offered a command unless the result says `displayed`.

An explicit offer can be visible while the agent is busy, but Tab/Right cannot accept it until the response settles successfully. Abort or failure clears it. Explicit offers bypass Jev, outrank automatic tags and survive a final answer with no tag. An identical still-visible explicit offer is idempotent; a different outstanding explicit offer or an external offer is a conflict, not permission to replace it.

Blockers include disabled suggestions, non-TUI or unattached UI, a nonempty editor or non-main focus, missing interactive-shell support, unsupported inline layout, conflicting external or explicit offers, and render timeout, abort or reset. Draft entry, focus loss, reset or shutdown while awaiting acknowledgement clears the owned offer and returns blocked. Unsupported-layout errors include safe diagnostics (component names/counts, renderer mode and lookup reason), never commands, drafts or terminal output.

After successful settlement, Tab/Right copies the suggestion; only Enter submits it. Submitting an accepted model-authored `!i` draft exactly unchanged allows pi-interactive-shell to continue the agent with status only, never terminal output or keystrokes. Manual, edited, externally offered and `!!i` commands do not automatically continue it.

Interactive-shell is inline-only: an unsupported transcript layout produces an explicit command-not-run error, with no overlay fallback and no automatic continuation. `/interactive-shell status` reports availability, layout diagnostics and the last actual handoff path. Live fullscreen panels support wheel/trackpad scrolling; regular mode uses the Ctrl+] keyboard controls. After exit, retained head/tail snapshots are static and memory-only, may contain sensitive text, and can disappear on transcript clear/rebuild, reload, session switch or exit; they are not saved to session history or model context. See [pi-interactive-shell](../pi-interactive-shell/README.md) for controls and privacy limits.

## Keys and focus

The ghost text is drawn by wrapping the focused editor's `render` while a suggestion is shown, so it works with any editor component that draws Pi's cursor: the software block, or the hardware cursor marker (as pi-vim does). An editor that draws neither gets a dim line under the editor instead, for example `→ Run tests  Tab to accept`.

The accept keys (`acceptKeys`, default `tab` and `right`) are taken only when all of these hold; otherwise they reach the focused component as usual:

- a suggestion is shown and the editor is empty; an explicit prompt or terminal offer also requires successful turn settlement;
- the focused component is the main prompt editor (the one focused at session start, or one that reports the suite's `main` editor surface), not an embedded editor or a dialog;
- the editor is not showing autocomplete, and, for a modal editor that reports its mode (pi-vim), it is in Normal or Insert state without autocomplete.

Accepting puts the text in the editor without submitting it. If the editor offers the suite's insert hook (pi-vim), it then enters Insert mode at the end of the text. After any other key reaches the main editor, the suggestion is hidden while the editor holds text and shown again once it is empty.

With pi-select-nav enabled, Tab accepts explicit `@`/`/` completion first, then a
next-prompt in an empty editor, then selects available task panels. While a panel
is selected, Tab cycles entries; Enter opens one and Esc returns to the editor.
Existing drafts are preserved, and no available target means Tab does nothing.

## Commands

- `/next-prompt` or `/next-prompt status`: a human-readable notification of at most eight logical lines (which may wrap to the terminal width), without suggestion text. It covers enabled/UI and current offer state, main focus and draft, turn and acceptance readiness, the last explicit offer outcome, pre- and post-settlement component-output observations tied to offer IDs, automatic tag/vetting state, and a trace hint. An omitted tag can be deliberate abstention, not necessarily an error.
- `/next-prompt trace [page]`: inspect a numbered, text-free lifecycle trace, four events per page. The newest page comes first; events within each page are chronological. A bare `trace` freezes a new in-memory snapshot; numbered pages reuse it, capturing one first if none exists. Invalid or out-of-range pages produce a usage or range message. The single snapshot and the live 32-event ring survive ordinary turns and reset on session replacement.
- `/next-prompt on`, `/next-prompt off`: for this session. Off also drops the prompt section from later runs and clears any suggestion.

Diagnostics make no model calls or files, and inspection does not render the editor/widget or create an acknowledgement. Inclusion in component output is not proof that you saw or accepted an offer. Typing a diagnostic command can itself hide an offer; preceding evidence remains in the trace.

## Configuration

Four files, read in this order, each merged on top of the last (objects merge key by key; other values replace only when the type matches; unreadable or invalid files are ignored):

1. `~/.config/agents/next-prompt.json` (`$XDG_CONFIG_HOME/agents/` if set)
2. `~/.pi/agent/next-prompt.json` (`$PI_CODING_AGENT_DIR/` if set)
3. `<project>/.agents/next-prompt.json`
4. `<project>/.pi/next-prompt.json`

The `agents` locations are meant to be shared with the opencode and Claude Code ports of this tool; the `.pi` locations are Pi-only. Settings are reread at session start and before each run. Defaults:

```json
{
  "enabled": true,
  "acceptKeys": ["tab", "right"],
  "maxChars": 0,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 1500, "threshold": 0.6 }
}
```

`acceptKeys` are pi-tui key ids (`tab`, `right`, `ctrl+f`, ...). The first one labels the fallback line's hint.

## Requirements and costs

- Pi 1.0 or newer. Interactive terminal UI only.
- The prompt section adds a few system prompt tokens to every interactive run, and a suggestion adds a short line of output tokens.
- Jev vetting of ordinary tag suggestions is optional; explicit prompt and terminal offers bypass it. It needs a Pi with classifier models and a configured classifier model; Pi resolves the credentials (`TYPESAFE_API_KEY` for its `typesafe` provider). Each ordinary tag candidate makes one classifier request, which can be billed. Set `jev.enabled` to `false` to skip it.
- On disk it reads only the settings files above and writes nothing. It rewrites assistant messages only to remove the tag lines.

## Optional integrations

- Other extensions can offer a next prompt over Pi's event bus: `pi.events.emit("prompt:offer", { source, text })`, and withdraw it with `{ source }` and no text. An offer is shown only while Pi is idle, never replaces the model's own suggestion, and is cleared by the next prompt. Busy-time requests are dropped, unlike explicit prompt/terminal offers. External offers bypass Jev but do not provide the tools' render acknowledgement or model-authored command continuation. Nothing is ever sent. pi-marimo uses it for new marimo-lens selections (`Use Lens to address S1 in fit.py`).
- pi-vim, or any editor that reports the suite's editor surface and mode markers: the suggestion is offered only in its main editor in Normal or Insert state, and accepting calls its insert hook. Not required.

## Limitations

- Drawing inside the editor wraps the editor's `render` method while a suggestion is shown, and reaches the TUI through a throwaway widget. Editors that draw no cursor get the fallback line.
- For ordinary nonterminal suggestions, if the model never emits the tag, nothing is shown; there is no separate suggestion request. A displayed explicit prompt or terminal offer instead survives a tagless final answer. `/next-prompt status` distinguishes this from a classifier veto or UI/focus blocker. Stored answers cannot prove omission: valid and invalid tag lines are stripped before persistence.
- A finished implementation with pending rollout can still have one obvious next step; the instruction explicitly permits that suggestion, without making suggestions unconditional.

## Development

```sh
cd packages/pi-next-prompt
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` (sources, tests, evals and the shared eval helpers) and the Vitest unit tests (`vitest run`). For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

From the repository root, `python3 scripts/test-prompt-offer.py` runs an offline custom-provider PTY regression in regular and fullscreen modes, loading only next-prompt, pi-vim and a harmless slash-command fixture. It checks the displayed receipt, ghost before acceptance, exact Tab draft, Enter exactly once with unchanged arguments, and a blocked preexisting draft. It requires Pi/Node and installed component dependencies; a skipped run is not verification. It makes no real model or marimo calls.

`npm run eval` makes live, paid classifier requests; run it only with explicit authorization. It runs the package's eval target through the repository's one runner (`scripts/eval.mjs --package pi-next-prompt`), skipped without `TYPESAFE_API_KEY`. The `vet` target (`eval/vet.target.ts`, engine in `eval/vet.ts`) measures how well the vet tells a useful suggestion from an unrelated one. Sessions never store suggestions (the `<next>` line is stripped), so it scores your real next messages instead: for each sampled session (the runner reads `$PI_CODING_AGENT_DIR/sessions`, default `~/.pi/agent/sessions`) and each assistant turn you answered, up to 12 turns per session, it asks the vet's own question with your real next message as the suggestion (skipping slash commands, `!` commands and messages under 3 or over 300 characters) and again with a next message from another sampled session. It reports how many real messages pass the 0.6 threshold, how many mismatched ones are hidden, the separation (the probability that a random real message scores above a random mismatched one), mean probabilities, Jev failures and the 10 lowest-scoring real messages, which the vet would have hidden. It passes when fewer than 20% of the requests fail. From the repository root: `npm run -s eval -- vet`, `npm run -s eval -- --dry vet` (counts the requests without making any) and `npm run -s eval -- --last vet`.

## License

MIT. See [LICENSE](./LICENSE).
