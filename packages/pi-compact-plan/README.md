# pi-compact-plan

A Pi extension that turns compaction into a small plan. Run `/compact-plan <what you will do next>`: the session asks a question or two only when an answer changes what the summary must keep, then drafts focus instructions and opens them in an editor. Submit to compact with them (after any edits); Esc cancels.

Example draft (illustration, not a screenshot):

```
Next task: wire retry() from src/net/retry.ts into the CLI's fetch command
Preserve verbatim: backoff is 2^n * 250ms capped at 8s; ...
Preserve briefly: why the old wrapper was removed
Drop: the caching tangent, the passing test runs
```

The drafting is a side request to the session's model, outside the session. Where the API allows, it reuses the session's last provider request byte for byte, so the conversation is read from the prompt cache.

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

MIT. The request splicing is adapted from this suite's pi-sidebar.
