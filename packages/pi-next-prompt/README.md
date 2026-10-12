# pi-next-prompt

A Pi extension that suggests the prompt you would most likely send next, like Claude Code's prompt suggestions. After a run, the suggestion appears as dim ghost text inside the empty editor, with no hint. `Tab` (or `Right`) fills it in; it is not sent. Typing hides it, and deleting what you typed brings it back, until you send a prompt.

It only appears when there is one obvious next step. Most turns show nothing.

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

- **The main model writes the suggestion.** In interactive terminal sessions, a short system prompt section (`next_prompt`) asks the model to end its final message with one line `<next>...</next>` only when exactly one concrete next step is obvious (at most 110 characters), and to leave it out when the task is done, when it needs your input, when several steps are equally likely, or after an error. No extra model request is made for the suggestion itself.
- **The line never stays in context.** On `message_end`, every line that consists only of a `<next>...</next>` tag is removed before the message is stored, so the session file and every later request carry the answer without it. Tags inside a line of prose are left alone. While the answer streams, the line is visible for a moment before it is removed. The last tag in the latest assistant message wins; one before a tool call is superseded by the final answer. A suggestion longer than `maxChars` is dropped.
- **Jev vets it.** [Jev](https://docs.typesafe.ai), through Pi's classifier models, is asked whether the suggestion is a concrete, non-generic next step that follows from the answer, is not already done, and is something you would plausibly send next. Its input is your last prompt (clipped to 1,500 characters), the tail of the answer (2,000 characters) and the suggestion. The suggestion is shown at probability >= `jev.threshold` (default 0.6). If Jev is off or unavailable (no classifier model or credentials, timeout, error), the suggestion is shown anyway.
- **When it shows.** Only after a run that completed (not aborted or failed), only if the editor is still empty, and only in the interactive terminal UI. Print mode, RPC mode and subagents get no instruction. Sending a prompt, a new run, compaction, switching models, navigating the session tree, starting a session, or `/next-prompt off` clears it.

## Keys and focus

The ghost text is drawn by wrapping the focused editor's `render` while a suggestion is shown, so it works with any editor component that draws Pi's cursor: the software block, or the hardware cursor marker (as pi-vim does). An editor that draws neither gets a dim line under the editor instead, for example `→ Run tests  Tab to accept`.

The accept keys (`acceptKeys`, default `tab` and `right`) are taken only when all of these hold; otherwise they reach the focused component as usual:

- a suggestion is shown and the editor is empty;
- the focused component is the main prompt editor (the one focused at session start, or one that reports the suite's `main` editor surface), not an embedded editor or a dialog;
- the editor is not showing autocomplete, and, for a modal editor that reports its mode (pi-vim), it is in Normal or Insert state without autocomplete.

Accepting puts the text in the editor without submitting it. If the editor offers the suite's insert hook (pi-vim), it then enters Insert mode at the end of the text. After any other key reaches the main editor, the suggestion is hidden while the editor holds text and shown again once it is empty.

With pi-select-nav enabled, Tab accepts explicit `@`/`/` completion first, then a
next-prompt in an empty editor, then selects available task panels. While a panel
is selected, Tab cycles entries; Enter opens one and Esc returns to the editor.
Existing drafts are preserved, and no available target means Tab does nothing.

## Commands

- `/next-prompt` or `/next-prompt status`: on/off, instruction injection, the latest assistant's valid/invalid/omitted tag, settlement events, Jev approval/veto, terminal UI availability, current focus/draft blockers, and ghost/fallback/concealed offer. Approval is not the same as display. Diagnostics reset on a new run or session invalidation; they are memory-only and make no model calls. An omitted tag can be deliberate abstention, not necessarily an error.
- `/next-prompt on`, `/next-prompt off`: for this session. Off also drops the prompt section from later runs and clears any suggestion.

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
  "maxChars": 110,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 1500, "threshold": 0.6 }
}
```

`acceptKeys` are pi-tui key ids (`tab`, `right`, `ctrl+f`, ...). The first one labels the fallback line's hint.

## Requirements and costs

- Pi 1.0 or newer. Interactive terminal UI only.
- The prompt section adds a few system prompt tokens to every interactive run, and a suggestion adds a short line of output tokens.
- Jev vetting is optional. It needs a Pi with classifier models and a configured classifier model; Pi resolves the credentials (`TYPESAFE_API_KEY` for its `typesafe` provider). Each suggestion makes one classifier request, which can be billed. Set `jev.enabled` to `false` to skip it.
- On disk it reads only the settings files above and writes nothing. It rewrites assistant messages only to remove the tag lines.

## Optional integrations

- pi-vim, or any editor that reports the suite's editor surface and mode markers: the suggestion is offered only in its main editor in Normal or Insert state, and accepting calls its insert hook. Not required.

## Limitations

- Drawing inside the editor wraps the editor's `render` method while a suggestion is shown, and reaches the TUI through a throwaway widget. Editors that draw no cursor get the fallback line.
- If the model never emits the tag, nothing is shown; there is no separate suggestion request. `/next-prompt status` distinguishes this from a classifier veto or UI/focus blocker. Stored answers cannot prove omission: valid and invalid tag lines are stripped before persistence.
- A finished implementation with pending rollout can still have one obvious next step; the instruction explicitly permits that suggestion, without making suggestions unconditional.

## Development

```sh
cd packages/pi-next-prompt
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the Vitest unit tests (`vitest run`). For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
