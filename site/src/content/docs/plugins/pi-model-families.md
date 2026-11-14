---
title: Model families
description: One shared model-family table for tiers and plan pairs, with offline discovery of new families.
plugin: pi-model-families
---

## Quick reference

- **Use it for:** Confirming or ignoring model families that appeared in your registry and that the suite's table does not rank yet.
- **Enable:** Select `packages/pi-model-families/src/index.ts` from the suite manifest. pi-subagents and pi-plan-mode carry the same table themselves and work without it.
- **Controls:** `/families` (confirm or ignore a discovery) and `/families list` (the whole table).
- **Settings:** An optional `$PI_CODING_AGENT_DIR/model-families.json` (default `~/.pi/agent/model-families.json`); absent means the built-in table.
- **Requirements, cost & privacy:** None; it reads Pi's model registry only and makes no network or model request.
- **Integrations & limits:** pi-subagents tiers and role profiles, and pi-plan-mode's built-in pairs. Plan pairs update after `/reload`.

[Source: pi-model-families](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-model-families)

## How families are ranked

Each route (plain Gemini, Antigravity Gemini, Antigravity Claude, Anthropic, OpenAI, Muse Code) lists its families in preference order with the tiers each fills. A new generation of a known family is picked up with no change. Provider route and ID shape are part of the table, so an Antigravity model never becomes a direct API pick.

## Discovery

A family the table does not rank, whose newest generation is at least the route's newest ranked generation, is a discovery. It is placed provisionally like the most expensive ranked family priced at or below it in the registry (`cost.input + cost.output`; Antigravity models take the price of their API twin). A discovery is never premium, a family without a price is left unrouted, and provisional families never become plan-pair planners or workers. It is announced once; `/families` confirms the placement, chooses other tiers or ignores it.

## The user file

The file only adds: `routes.<route>.add` (id, tiers, optional name and `before`), `ignore`, `pairs` overrides and `seen`. Built-in families win over an `add` with the same id, so a later release that ships the family makes the entry inert. An unreadable or invalid file is ignored with a warning.
