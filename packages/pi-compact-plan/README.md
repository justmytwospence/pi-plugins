# pi-compact-plan

A Pi extension for compacting with a focus you work out with the session. Run `/compact-plan [next prompt]`: the session drafts focus instructions for the summary (what to keep verbatim, what to keep briefly, what to drop), asking a question or two first only when an answer changes what the summary must keep. The focus is shown in the transcript on the same review card pi-plan-mode draws plans with, with the review under it: compact and stop, compact and continue, edit it (in the suite's editor, so pi-vim works there), tell the session what to change, or cancel. With pi-ask-user-question loaded, the questions and the review are its dialog, with typed answers and notes; otherwise Pi's selects.

The focus is for the summary, before compacting; the next prompt is what happens after. **Compact and stop** leaves your next prompt in the editor; **Compact and continue** sends it (or `Continue with the current work.` without one), after a one-line note saying the session was just compacted.

Example focus (illustration, not a screenshot):

```
 Compaction focus review
 - Keep verbatim: retry() in src/net/retry.ts; backoff is 2^n * 250ms capped at 8s; ...
 - Keep briefly: why the old wrapper was removed
 - Drop: the caching tangent, the passing test runs

 Waiting for approval · next: wire the retry into the CLI
```

The drafting is a side request to the session's model, outside the session. Where the API allows, it reuses the session's last provider request byte for byte, so the conversation is read from the prompt cache. When the drafting was read from the cache and you approve within a few minutes, the summary is written the same way, so it costs a cache read instead of Pi's uncached summarization request; otherwise Pi's summarizer writes it with the focus.

Only when the conversation is large and not (or probably not) in the prompt cache does it ask what to draft from: an outline of the session (prompts, replies, tool calls, error lines; a few percent of the tokens), after which Pi's summarizer reads the whole conversation once, or the full conversation, which re-reads it once and refills the cache so revisions and the summary are cheap. With pi-cache-guard loaded it uses its cache clock for that guess.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-compact-plan/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-compact-plan/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-compact-plan
```

## Development

```sh
npm ci
npm run check
```

## License

MIT. The request splicing is adapted from this suite's pi-sidebar; `editor-contract.ts`, `herdr-blocked.ts` and the text prompt follow pi-plan-mode.
