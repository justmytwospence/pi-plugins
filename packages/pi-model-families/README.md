# pi-model-families

One model-family table for the suite, and offline discovery of families it does not know yet. pi-subagents and pi-plan-mode each carry an identical copy of the table (`src/model-families.ts`, held byte-identical by the repository's contract test), so either works without this package. This package adds the `/families` command and the notice about new families, and is the only writer of the user file.

## What the table knows

Per route (a provider plus an id shape; Google has three: plain Gemini, Antigravity Gemini and Antigravity Claude), the families in preference order and the tiers each fills (`fast`, `balanced`, `strong`, `premium`). A new generation of a known family (Gemini 5 Argon, Claude Opus 6) needs nothing: the newest registered model of the best family for a tier wins. Plan model pairs are derived from the same table.

## Discovering new families

At session start the registry is matched against each route's id pattern. A family the table does not rank, that you have not ignored, and whose newest generation is at least the route's newest ranked generation is a discovery. It is placed provisionally in the tiers of the most expensive ranked family priced at or below it, by registry price (`cost.input + cost.output`; a subscription route takes the price of its API twin). A discovery is never placed in `premium`, and a family without a price is left unrouted. Provisional families are used for subagent tier picks but never for plan model pairs. No network request is made.

A discovery is announced once. `/families` lists them: confirm the provisional tiers, choose others, or ignore the family. `/families list` prints the whole table. Confirming writes `~/.pi/agent/model-families.json`; subagent picks follow at once and plan model pairs after `/reload`.

## The user file

`$PI_CODING_AGENT_DIR/model-families.json` (default `~/.pi/agent/model-families.json`), version 1. It adds to the built-in table and never replaces it, so a family a later release ships is not hidden:

```json
{
  "version": 1,
  "routes": {
    "google/antigravity-gemini": {
      "add": [{ "id": "neon", "name": "Neon", "tiers": ["strong"], "before": "argon" }],
      "ignore": ["lithium"],
      "pairs": [{ "planner": "carbon", "worker": "hydrogen" }]
    }
  },
  "seen": { "google/antigravity-gemini": ["neon"] }
}
```

A built-in family wins over an `add` with the same id. A file that cannot be read or fails validation is ignored with a warning and the built-in table applies. Routes: `anthropic`, `openai` (also `openai-codex`), `google/antigravity-claude`, `google/antigravity-gemini`, `google/gemini`, `muse-code`.
