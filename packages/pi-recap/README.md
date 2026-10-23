# pi-recap

A Pi extension that writes one line on where the session stands when you come back to it. After a turn settles and the session sits idle for 3 minutes, the recap is added to the transcript, as Claude Code's session recap is. `/recap` writes one right away, for example in a session you just resumed.

Example (illustration, not a screenshot):

```
 ※ recap: Fixed the parser to skip empty lines; tests pass, waiting on your OK to push
```

With [pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/) loaded, the same line is the turn's Herdr notification text (its `$summary` pane token): one model call per turn feeds both.

The idea comes from [pi-away](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-away) by Thomas van Dongen (MIT). This is an independent implementation built on pi-herdr's turn summary.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-recap/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-recap/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. Do not also enable a standalone copy of this component.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-recap
```

## How it works

- **One recap per turn.** As a turn settles, a small model (the first of `anthropic/claude-haiku-5-5`, `anthropic/claude-haiku-4-5` with credentials, thinking off, 4-second cap) writes at most 80 characters from a condensed transcript: up to 5 earlier prompts of the session as context, then the latest prompt, its tool calls and the final reply. It says what got done and, if the turn ended needing you, what you must decide or do. A reply that is already one short line is used as is, with no model call. Without a model, on an error, a timeout or an interrupted turn, the reply's first sentence stands in.
- **The line.** After 3 minutes idle the recap is appended to the transcript as a custom session entry, which stays in the scrollback and is never sent to the model. It is drawn like Claude Code's, but bold throughout: a dim bold `※` and `recap:`, then the text in dim bold italic, wrapped under the label at [pi-prose-width](https://pi-plugins.vercel.app/plugins/pi-prose-width/)'s measure when that is loaded.
- **When.** As in Claude Code, an automatic recap needs at least 3 prompts in the session and 2 more since the previous recap. It is also skipped after an interrupted run, or when it is just the reply's own short line (already on screen). A new run, tree navigation or a new session before the delay cancels it.
- **Shared with pi-herdr.** pi-herdr asks for the recap as the turn settles (`recap:summary` on Pi's event bus) and writes it to its `$summary` pane token, which notification tools show as the alert's body. Without pi-recap, pi-herdr writes its own, last-turn-only summary.

## Commands

- `/recap`: waits for any run to finish, then adds the recap of the latest turn to the transcript at once, whatever the prompt count (reusing this turn's recap if one was already written).

## Configuration

| Variable | Effect |
| --- | --- |
| `PI_RECAP=0` | No automatic recap line; `/recap` and pi-herdr's summary still work |
| `PI_RECAP_DELAY_MS` | Idle delay before the line appears (default `180000`) |
| `PI_RECAP_MODEL` | `provider/id` for the recap; else `PI_HERDR_SUMMARY_MODEL`, else Haiku |
| `PI_HERDR_SUMMARY=0` | No model call: the reply's first sentence only |

## Requirements and costs

- Pi 1.0 or newer, interactive terminal UI only; print, RPC and subagent sessions stay dormant.
- One small request per settled turn whose reply is longer than a line (Haiku, a few hundred input and about 20 output tokens), through your configured credentials. With pi-herdr loaded, this replaces pi-herdr's own summary request rather than adding one.
- Each recap is saved in the session file as a `recap` custom entry, so it reappears when the session is resumed.

## Event bus

`pi.events.emit("recap:summary", { reply(promise) })`: when pi-recap is active, it calls `reply` with a `Promise<string | undefined>` for the current turn's recap, computed once per turn.

## Development

```sh
cd packages/pi-recap
npm ci
npm run check
```

## License

MIT. See [LICENSE](./LICENSE).
