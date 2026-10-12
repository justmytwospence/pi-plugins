# pi-cache-guard

A Pi extension that asks before a prompt would re-cache a large conversation, shows how long the prompt cache has left, and, with [Jev](https://docs.typesafe.ai) (TypeSafe's judgment model, through Pi's classifier models), keeps the context lean: large tool output is trimmed to what the agent needs, and a conversation can be compacted without an LLM summary. Everything but the Jev parts works without Jev.

It is the Pi member of the cache-guard family: [claude-cache-guard](https://github.com/justmytwospence/claude-cache-guard), [opencode-cache-guard](https://github.com/justmytwospence/opencode-cache-guard) and [codex-cache-guard](https://github.com/justmytwospence/codex-cache-guard) share its core (`src/core.ts`: the clock, costs and settings), its Jev logic (`src/lean.ts`: trimming and compaction, with no harness imports) and its shared settings file. It replaces pi-lean-context.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-cache-guard/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-cache-guard/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-cache-guard
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## Cold-cache warning

A provider keeps a cached prompt prefix for its TTL from the start of the last request that used it. The TTL comes from the model's `promptCache` lifetime in Pi's model metadata (`short`, or `long` with `PI_CACHE_RETENTION=long`; for Anthropic, 5 minutes or 1 hour). The first prompt after that writes the whole conversation to the cache again, at the model's cache-write price from Pi's catalog (always 2x input for the 1-hour tier) instead of the much cheaper cache-read price. When that rewrite would cost at least `warn.minCost` (default $0.50 at API prices; `warn.minTokens` tokens when Pi has no prices for the model), the prompt waits for a choice.

Example of the question:

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$2.88 at API prices).
-> Send anyway (~$3.00)
   Send, and stop asking in this session
   Compact with Jev, then send it (~1s, ~$0)
   Compact with a summary, then send it (up to ~$2.40)
   Start a new session with this prompt (no history, ~$0)
   Keep the prompt in the editor
```

The headline cost is what the miss adds over a cache hit. The costs in the options are each path's total.

- **Send anyway**, or **Send, and stop asking in this session.** Sending is first, so Enter sends as if nothing had asked. The second turns the question off for this session; the clock and the Herdr token keep running.
- **Compact with Jev** (when Jev is ready). Jev judges every message and tool call against the held prompt, and the summary is written in code from its choices: no LLM reads the history. If Jev fails, nothing is compacted and the prompt goes back in the editor with the reason.
- **Compact with a summary** (labeled **Compact first** without Jev). Asks what the summary should keep: Pi's default summary, a summary focused on the held prompt (keep what it needs, drop the rest), or your own guidance. It then runs Pi's compaction and sends the prompt onto the small context. Compacting reads the history once at input price instead of a cache write; with Jev filtering on (`compact.filter`), Pi's summarizer reads only what Jev did not drop, so the price shown is an upper bound. If compaction fails (for example the session is too small), the prompt goes back in the editor.
- **Start a new session.** Opens a new session linked to this one (as its parent), on the same model and thinking level, and sends the prompt there, images included. Also available as `/cache-guard fresh`, which takes the editor's text.
- **Keep the prompt in the editor.** Esc does the same, and spends nothing. Images attached to the held prompt are not put back.

When Jev is not set up (and not turned off), the question ends with a tip: `/cache-guard jev` sets it up, or turns it (and the tip) off.

It also asks when the selected model differs from the one the conversation was cached for (each model has its own cache). For models without a published TTL (for example OpenAI and Codex models) it asks after `warn.idleMinutes` (default 180) idle, worded as a likelihood.

Never held: commands (`/...`), shell input (`!...`), steering and follow-ups while the agent runs, input from other extensions (anything not typed interactively), and sessions without a UI.

## Status clock

The `cache-guard` status reads `cache 4:12` (time left), `cache cold`, `cache cold (model)` or `cache cold?` (no TTL known, long idle). It updates every second. pi-status-footer folds it into its context row.

## Trimming tool output (Jev)

Large text results are trimmed before they enter the context, so the prompt cache is never disturbed: over `trim.minChars` (12,000) characters from `bash`, `grep`, `find`, `ls`, MCP tools (`mcp__*`) and tools whose name contains `web`, `fetch`, `search` or `content`; over `trim.readMinChars` (50,000) from `read`. `edit` and `write` results are never trimmed.

Jev reads your last request, what the agent last said, the tool call and the output, split into at most `trim.maxBlocks` (150) blocks, and says which blocks hold what the agent needs: errors, failures, warnings, requested values, results. The kept blocks plus the first `trim.headLines` (5) and last `trim.tailLines` (20) lines stay, in order, with `[… N lines omitted …]` markers, and a footer points at the full output saved under `~/.pi/agent/cache-guard/tool-output/<session>/<toolCallId>.txt`, to read with `offset`/`limit`.

Output too large for one Jev request (`trim.stateBudgetChars`) is pre-filtered in code first: head, tail, every line that looks like an error or warning with two lines of context, and an even sample. Nothing is trimmed when:

- Jev thinks the agent wants the whole output (`trim.needsAllThreshold`);
- more than `trim.maxKeptShare` (70%) of lines would be kept;
- the same call (tool and arguments) was already trimmed this turn, so asking again returns everything;
- the call is nested inside another tool call (for example from a codemode script);
- Jev is unavailable, fails or times out (`jev.timeoutMs`), or the full output cannot be saved.

Jev's token usage is added to the tool result. The `lean-context` status (`lean: −12k tok`, an estimate of the tokens kept out so far) is what pi-status-footer shows on its context row.

## Compacting with Jev

Jev sorts every message and tool call being compacted into *verbatim* (requirements, decisions, exact values, open errors), *summarize*, or *drop* (superseded or noise), in batches of up to 120, with `compact.concurrency` requests in flight. Anything Jev does not answer is summarized.

- **The cold-cache menu, `/cache-guard compact [focus]` and context-overflow recovery** write the summary in code, with no LLM: the earlier summary, your requests, the verbatim items, one-line notes for the rest, and the files read and modified. The menu and the command cancel when Jev fails; overflow recovery falls back to Pi's compaction with a warning.
- **`/compact` and automatic compaction** run Pi's own summarizer on the conversation with dropped items removed and summarized ones shortened, then append the verbatim items under `## Kept verbatim`. `"compact": { "filter": false }` leaves them to Pi alone. Any failure falls back to Pi's normal compaction.

A Jev summary is assembled, not written: Pi's summary reads better when the history needs explaining.

## Transcript notices

After a turn that re-billed a significant part of the conversation (from 20k tokens or $0.10), it adds a line such as `Cache miss after 12m idle: 600k tokens re-billed (~$2.88)`; one for each keep-warm refresh (`Cache warmed: $0.0123`); and one for what a compaction billed. These mirror Pi's own `showCacheMissNotices` lines; that setting also prints `Anthropic dropped N thinking blocks`, so leave it off and let this extension print the cache lines. They are custom session entries (`cache-guard-notice`, never sent to the model), so they show again on resume. `/cache-guard off` stops them for the session.

## Keeping the cache warm: not here

Pi does that itself: set `"cacheWarming": "idle"` in `~/.pi/agent/settings.json` (a global-only setting), and `/session` shows its next decision. Pi records those refreshes as `cache_warm` usage entries; this extension's clock counts the ones that hit the cache.

## Setting up Jev

Jev runs through Pi's classifier models, so Pi holds the credentials. Any of these works; with no provider configured, the first one Pi can reach is used:

| Provider | Model | Pi credentials |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY`, or `/login typesafe` with a key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys) |
| `openrouter` | `~typesafe/jev-latest`, `typesafe/jev-1.13` | `OPENROUTER_API_KEY` or `/login openrouter` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `opencode` | `jev-1.13` | `OPENCODE_API_KEY` |

`/cache-guard jev` shows which one is in use and checks that it answers (for example `Jev: typesafe/jev-latest, answered in 312 ms.`), offers the others it found, and can turn Jev off. With none set up it explains the choices and puts `/login typesafe` (or `/login openrouter`) in the editor; run `/cache-guard jev` again afterwards to check. Its choices are saved to `~/.pi/agent/cache-guard.json` (`jev.provider`, `jev.model`, `jev.enabled`). A missing Jev is looked for again, at most once a minute, the next time it is needed (for example after a `/login`).

## Commands

- `/cache-guard` or `/cache-guard status`: the last request, TTL, time left or why it is cold, whether the next prompt will ask, and which Jev is in use.
- `/cache-guard compact [focus]`: a Jev compaction now, judged against the focus (or your last requests). Without Jev it offers Pi's summary instead, or Jev setup.
- `/cache-guard jev`: set up, check, switch or turn off Jev.
- `/cache-guard fresh`: a new linked session that starts with the editor's text.
- `/cache-guard on`, `/cache-guard off`: the warning, the clock, the Herdr token and the transcript lines, for this session. Trimming and compaction follow the settings.

## Configuration

Read in this order, each merged on top of the last (objects merge, other values replace; unreadable or invalid files are ignored):

1. `~/.config/agents/cache-guard.json` (`$XDG_CONFIG_HOME/agents/` if set), shared with the other ports
2. `~/.pi/agent/cache-guard.json` (`$PI_CODING_AGENT_DIR/` if set), Pi-only; `/cache-guard jev` writes here
3. `<project>/.agents/cache-guard.json`
4. `<project>/.pi/cache-guard.json`

Pi reads every setting except `warm` and `warn.confirmSeconds`, which are for ports without built-in warming or that can only block a prompt. Defaults for the rest:

```json
{
  "enabled": true,
  "warn": { "enabled": true, "minCost": 0.5, "minTokens": 100000, "idleMinutes": 180 },
  "herdr": { "enabled": true },
  "jev": { "enabled": true, "provider": "", "model": "", "timeoutMs": 2500 },
  "trim": { "enabled": true, "minChars": 12000, "readMinChars": 50000, "maxBlocks": 150, "stateBudgetChars": 60000,
            "keepThreshold": 0.4, "needsAllThreshold": 0.6, "maxKeptShare": 0.7, "headLines": 5, "tailLines": 20 },
  "compact": { "filter": true, "timeoutMs": 10000, "concurrency": 4 }
}
```

- `minTokens` applies only to models Pi has no prices for.
- An empty `jev.provider` picks the first provider that works; an empty `jev.model` uses that provider's default from the table.
- `trim.keepThreshold` is the probability at which a block is kept. `compact.timeoutMs` is per Jev request.
- `"enabled": false` turns everything off, Jev included; `"jev": { "enabled": false }` turns off only the Jev parts (and the tips).

## Requirements and costs

- The warning, clock and notices need nothing external. They use Pi's model metadata for TTLs and prices; costs are estimates at API list prices.
- Jev is optional. It needs a Pi with classifier models (Pi 0.99 or newer) and credentials for one of the providers above. Each trim makes one classifier request, each Jev compaction one request per batch, and `/cache-guard jev` sends a one-question probe. These requests can be billed.
- Filtered `/compact` and automatic compaction still call your current model through Pi's summarizer, as Pi's compaction does.
- On disk: it reads the settings files above; writes full tool output under `~/.pi/agent/cache-guard/tool-output/` when it trims; and writes `~/.pi/agent/cache-guard.json` only from `/cache-guard jev`. In the session it appends `cache-guard:jev` decision entries and `cache-guard-notice` entries (never sent to the model).

## Optional integrations

- pi-status-footer: folds the `cache-guard` and `lean-context` statuses into its context row. Optional; without it Pi shows the statuses as usual.
- [Herdr](https://herdr.dev), through the suite's pi-herdr: the extension emits `herdr:token` on Pi's event bus with the pane token `cache`: `cold 601k` (or `cold? 180k` for a guess from idle time) while the next prompt would re-cache at least the warning threshold, cleared while the cache is warm or small and when the session ends. It resends the token on `herdr:ready`. Without pi-herdr nothing listens. `"herdr": { "enabled": false }` turns it off. Example Herdr sidebar row in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", { token = "$cache", fg = "#5f87d7", rules = [{ starts_with = "cold?", dim = true }] }]]
```

## Limitations

- The clock is the API's guaranteed minimum, measured from each request's start; entries are deleted soon after it, not exactly at it. Other invalidations (tool or system prompt changes, an MCP server reconnecting) are not visible to it.
- After a compaction or branch summary there is no cached request to track until the next response.
- The warning needs an interactive UI; prompts sent without one are never held.

## Development

```sh
cd packages/pi-cache-guard
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` and the Vitest unit tests (`vitest run`). `npm run eval` runs live evals in `eval/` (trimming real-looking build and test logs, and a compaction) against Jev through the Pi installation on `PATH` (or `PI_PACKAGE_DIR`); they are skipped without `TYPESAFE_API_KEY`. `npm run eval` makes live, paid classifier requests; run it only with explicit authorization. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).
