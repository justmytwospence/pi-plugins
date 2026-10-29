---
title: Choosing subagent models
description: What OpenAI and Anthropic say each model is for, what that costs, and how the pi-subagents roles use it.
---

[pi-subagents](/plugins/pi-subagents/) runs each delegated task on a model and an effort level. This page records what the two labs say about their current models, as of 2026-10-29, so the built-in roles rest on something checkable. Everything in the tables is a vendor statement or a vendor price. It was not measured here, and benchmark claims are marketing until you test them on your own work. Claims that could not be confirmed from a primary source are listed at the end.

## What the labs say

### Anthropic

| Model (Pi id) | Context and price (per million tokens) | Stated strengths | Stated weaknesses | Effort guidance |
|---|---|---|---|---|
| Fable 5.1 (`claude-fable-5-1`) | 1M context, flat. $10 in, $50 out, cache read $0.25. | Demanding reasoning and long-horizon agentic work. | Slowest and most expensive. Serial tool calls in long loops. Whole-file rewrites for small edits. | Default `high`. `xhigh` and `max` only where evals show a gain. |
| Opus 5.5 (`claude-opus-5-5`) | 1M context, flat. $4 in, $20 out, cache read $0.20. | Long-running agentic coding and knowledge work. Stated as matching Fable 5.1 on most work. Code review, clear writing, reading charts. | Thinks more per turn than Opus 5 at the same effort. Long turns can end on a progress update that a naive loop reads as done. | Default `medium`. `low` is reported close to Opus 5 at `high` on several coding evals. |
| Sonnet 5.5 (`claude-sonnet-5-5`) | 1M context, flat. $2 in, $10 out, cache read $0.10. | Well-scoped everyday tasks, bug fixes, polished documents. Within about 2 points of Opus 5.5 on one coding benchmark. | Opus 5.5 is stronger on open-ended work needing sustained judgment. At `low` or `medium` it can check in early or skip verification. Strictest cyber safeguards of the small models. | Start at `medium` for specified tasks and `high` for harder ones. |
| Haiku 5.5 (`claude-haiku-5-5`) | 1M context. **$0.10 in, $0.50 out up to 100k prompt tokens; $0.50 in, $2.50 out above it** (every rate is 5x). | Summaries, classification, extraction, routing, browser use. Positioned as a subagent next to Opus 5.5 and Sonnet 5.5. | "Best suited to more narrowly scoped tasks"; Sonnet 5.5 and Opus 5.5 remain better for complex agentic coding. At `low` it can skip a search or a check. | Default `medium`. |

Sources: [models overview](https://platform.claude.com/docs/en/models/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), the [Opus 5.5](https://www.anthropic.com/claude-opus-5-5), [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5) and [Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5) announcements, and the per-model prompting guides under [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering).

What Anthropic says about delegating:

- Compare models on cost per completed task, not per token, and tune effort before switching models.
- `low` effort suits "simpler tasks that need the best speed and lowest costs, such as subagents".
- Its own measurement: Haiku 5.5 subagents under Opus 5.5 at `medium` cut cost by 32% and lowered the pass rate by about 4 points. It calls this an alternative to lowering effort, not an improvement. Delegation to cheaper workers paid off only for routine work with a long cost tail, or work larger than one context. For a dependent chain, or work that fits in one context, the orchestrator alone at lower effort won in every measured case.
- Claude Code's built-in Explore agent uses the main conversation's model; Haiku only if you define your own.

### OpenAI

| Model (Pi id) | Context and price (per million tokens) | Stated strengths | Stated weaknesses | Effort guidance |
|---|---|---|---|---|
| GPT-6 Astra (`gpt-6-astra`) | 1.05M in the API, 272K in Pi. $10 in, $50 out; $20 and $75 above 272K. | Most capable: hard reasoning, coding, computer use, research, cyber. | Refuses advanced cyber tasks by design. More likely to stop and ask questions. | Start at `low`. |
| GPT-6.1 Sol (`gpt-6.1-sol`) | 1.05M in the API, 500K in Codex. $2 in, $10 out; $4 and $15 above 272K. | "Nearly matches" Astra on agentic coding and computer use at one-fifth the price. | Astra is still recommended for the hardest scientific research. | Default `medium`. |
| GPT-6.1 Terra (`gpt-6.1-terra`) | 1.05M in the API, 500K in Pi. $1 in, $5 out; $2 and $7.50 above 272K. | Visual reasoning, precise computer use, clear writing. Over three times faster than Astra and Sol. | "For the most complex coding tasks, GPT-6.1 Sol and GPT-6 Astra remain the better choice." | Start at `medium`. |
| GPT-6 Luna (`gpt-6-luna`) | 1.05M in the API, 272K in Pi. $0.10 in, $0.50 out; $0.20 and $0.75 above 272K. | Focused, high-volume tasks: summarization, extraction, focused coding. For clear, repeatable tasks. | Not for open-ended work. | Start at `high`. |

Sources: [models](https://developers.openai.com/api/docs/models), [pricing](https://developers.openai.com/api/docs/pricing), [Codex models](https://developers.openai.com/codex/models), and the release posts for [Astra](https://openai.com/index/gpt-6-astra/), [Sol](https://openai.com/index/introducing-gpt-6-1-sol/) and [Terra](https://openai.com/index/introducing-gpt-6-1-terra/).

Estimated Codex subscription allowance, in local messages per five hours on Plus: Astra 5-45, Sol 15-160, Terra 35-285, Luna 350-3,000 ([Codex pricing](https://developers.openai.com/codex/pricing)). A prompt over 272K input tokens is billed at 2x input and 1.5x output on the API.

OpenAI gives no per-sub-task table. Its guidance is model-level: Astra when quality matters most, Sol to balance cost, Terra and Luna when price-sensitive, and the effort advice above ("most tasks do not need Max or Ultra").

## Roles in pi-subagents

The built-in roles pin a model and an effort per provider. The picker chooses a role, so a role's model does not depend on how hard Jev rates the task. These are this suite's defaults, derived from the tables above and from the maintainer's own run history. They are not the labs' recommendations.

| Role | Anthropic | Codex | Why |
|---|---|---|---|
| explorer | Sonnet 5.5, low | Luna, high | Recon and search. Haiku is avoided because exploration often passes 100k tokens, where its price multiplies by 5. Luna is OpenAI's focused-task model and starts at `high`. |
| worker | Sonnet 5.5, medium | Sol 6.1, medium | A clear spec: Sonnet's stated sweet spot; Sol for balanced coding. |
| reviewer | Opus 5.5, high | Sol 6.1, high | Careful review; Opus is the lab's stated code-review result. |
| researcher | Sonnet 5.5, medium | Terra 6.1, medium | Web and documents; Terra is positioned for clear communication. |
| writer | Sonnet 5.5, medium | Terra 6.1, medium | Documents and write-ups. |
| planner | Opus 5.5, high | Sol 6.1, high | Design and hard analysis without edits. |

Astra and Fable are never chosen automatically: Astra's allowance is small, and Fable accounted for most of the maintainer's subagent spend on read-only work. Pass `model` to use one.

## What was not verified

- Parameter counts and any "size" ordering of the models: neither lab states them.
- That Terra writes better than Astra or Sol. OpenAI describes Terra's writing as clearer and more natural, and publishes no ranking.
- That Sonnet 5.5 or Sol over-refuses benign security work. Both labs document cyber safeguards that can stop legitimate tasks; reports of specific refusals are anecdotes.
- That small models degrade past 100k tokens. Only Haiku's price change is documented.
- Which model each lab would pick for scouting, review or planning. Neither says; the role table is inferred from the model-level statements.
- Whether Pi passes every effort and thinking option through for these ids.
- Full benchmark tables. The announcements show headline deltas, and several charts were not readable as text.
