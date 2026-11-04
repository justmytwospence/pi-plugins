---
title: Choosing subagent models
description: Vendor positioning, routing policy, and unmeasured limits for task-calibrated subagent models.
---

[pi-subagents](/plugins/pi-subagents/) runs each delegated task on a model and an effort level. The Anthropic/OpenAI positioning and prices below are from vendor sources checked as of 2026-10-29, not measurements by this suite; benchmark claims remain vendor claims. Google/Meta sources and the suite's own routing policy follow. Capability tiers and fallback roles are maintainer choices, not vendor recommendations or measured model equivalences. A 72-call Jev fixture calibration recorded routing-label agreement, not actual coding success or cost savings; its results appear below.

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

### Google and Muse Code

As of the same 2026-10-29 policy review, Google's [model directory](https://ai.google.dev/gemini-api/docs/models) describes Flash-Lite as the fast, lower-cost family, Flash as balancing speed and capability, and Pro as aimed at complex reasoning/coding. Its [Gemini 3.8 Flash page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) positions Flash for long-horizon software engineering and agent workflows at Flash speed. These are Google claims about API models, **not** evidence that a subscription Antigravity route has the same cost or capability ordering. `Argon` and `antigravity-` are registered route/model names in the Pi setup, not Google API performance comparisons. A stable numeric ID in the registry is required for automatic Google routing; preview, experimental, media and unversioned variants are excluded by policy.

Meta's [models guide](https://dev.meta.ai/docs/models) positions Wonder for complex, long-running software engineering and orchestration, and Spark for higher-volume, latency- or cost-sensitive work such as subagent tasks. Meta's [Spark page](https://dev.meta.ai/models/muse-spark) describes Spark 1.3 as optimized for agentic workflows and coding; its benchmarks are vendor-reported, not measured here. The guide distinguishes **Standard** (content not used for model training) from **Contributor** (content may be used to train Meta models for a usage/price benefit). Automatic Muse picks use versioned Standard IDs, `muse-spark-1.3` and `muse-wonder-1.0` when registered—not `-contributor` variants, unverified Wonder Full IDs or image models. The bare `muse-spark` alias follows the bridge's catalog default (currently Wonder), so it is not a safe automatic Spark pin. There is no verified registered Muse premium candidate in this setup; an explicit model override remains possible.

Subscription-backed Antigravity and local MTPLX/LM Studio can report zero pricing. That is not evidence of zero marginal usage, equal capability, a ranked local model family, or cost per completed task. The suite does not infer capability from price metadata.

## Routing policy (not a measured ranking)

Built-in roles supply task/tool scope and **fallback** model/effort baselines when the configured System 1 classifier chain has no usable answer. `/system1` defaults to Jev only and can configure an ordered Jev and native OpenAI Decisions chain; operational failures can advance to the next configured classifier. This API-classifier route is independent of main and worker chat providers and the separate subscription chat-model `/waterfall`. Their assignments are not fixed pins or ceilings. For each delegated task, model capability and reasoning effort are judged independently: a hard task can merit a registered Astra/Fable premium candidate, while a straightforward task can use a cheaper tier even under `worker` or `reviewer`. A premium model does not imply xhigh effort, and a cheap model can need high effort. Neither a long specification, required tests, role name nor parent-project importance alone justifies escalation. User/project agent-file pins stay fixed; explicit call arguments win separately for each field.

| Automatic route | `fast` | `balanced` | `strong` | optional `premium` |
|---|---|---|---|---|
| `anthropic` | Haiku | Sonnet | Opus | Fable |
| `openai`, `openai-codex` | Luna | Terra | Sol | Astra |
| `google/gemini-*` (plain) | stable versioned Flash-Lite | stable versioned Flash | stable versioned Argon/Pro | — |
| `google/antigravity-gemini-*` | stable versioned Flash | stable versioned Flash | stable versioned Argon/Pro | — |
| `google/antigravity-claude-*` | Sonnet | Sonnet | Opus | — |
| `muse-code` | versioned Standard Spark | versioned Standard Spark | versioned Standard Wonder | — |

These are **suite policy families**, not equivalent capability ratings between vendors. Only registered, physical-chat candidates of the selected route are offered; a missing premium family is omitted, and duplicate models across tiers are intentional when no verified intermediate exists. OpenAI and legacy Codex share policy but retain their own provider IDs. Under provider `google`, plain Gemini, Antigravity Gemini and Antigravity Claude retain separate prefixes; an Antigravity model must never silently become a direct Google API pick. Unknown/local providers receive no invented hierarchy: if no mapping works, retain the parent with a visible fallback notice, while effort can still be classified. The synchronous `subagents:role-model` service has no task to judge and returns the applicable role baseline without classification; it cannot predict a future task's adaptive pick.

| Role | Anthropic | OpenAI / Codex | Google Gemini | Muse Code | Unknown/local effort |
|---|---|---|---|---|---|
| explorer | Sonnet 5.5 / low | Luna 6 / high | Flash 3.8 / low | Spark 1.3 / low | low |
| worker | Sonnet 5.5 / medium | Terra 6.1 / medium | Flash 3.8 / medium | Spark 1.3 / medium | medium |
| researcher | Sonnet 5.5 / medium | Terra 6.1 / medium | Flash 3.8 / medium | Spark 1.3 / medium | medium |
| writer | Sonnet 5.5 / medium | Terra 6.1 / medium | Flash 3.8 / medium | Spark 1.3 / medium | medium |
| reviewer | Opus 5.5 / high | Sol 6.1 / high | Argon 4 / high | Wonder 1.0 / high | high |
| planner | Opus 5.5 / high | Sol 6.1 / high | Argon 4 / high | Wonder 1.0 / high | high |

Antigravity Gemini uses the Google column with `antigravity-`-prefixed IDs; Antigravity Claude uses the Anthropic column under provider `google`, also prefixing IDs. `general` falls back to balanced/medium. Unavailable baseline models use a registered same-route family if possible, then balanced/medium; no model mapping keeps the parent visibly. Effort is clamped to supported levels when a registered model is chosen, except an explicit thinking argument follows Pi's usual pass-through behavior.

The historical Jev calibration below does not establish equivalent calibration or routing results for OpenAI Decisions.

The `routing` eval checks 24 fixed task/provider cases crossed over Anthropic, OpenAI, Antigravity Gemini and Muse. Its first live three-repeat run made **72 Jev classifier calls**: 68/72 tier matches (94.4%), 72/72 effort matches (100%), 68/72 joint matches (94.4%), and 24/24 hard-task matches (100%). There were no failed calls, routine premium/xhigh picks, or hard-task fast/balanced picks. The four misses were specified-implementation tasks routed `fast` rather than `balanced`/`strong` (three Anthropic, one OpenAI). The recorded spend was $0.0000, meaning no nonzero cost was reported—not that the paid calls were free. Acceptance thresholds passed, so the reserved 24-call full-matrix follow-up was **not** run. `npm run -s eval -- routing --dry` plans calls without spending. These observed fixture-routing results do **not** measure coding quality, task success, or cost savings. The separate `profiles` replay compares baselines when classification is unavailable, not adaptive routing.

## What was not verified

- Parameter counts and any "size" ordering of the models: neither lab states them.
- That Terra writes better than Astra or Sol. OpenAI describes Terra's writing as clearer and more natural, and publishes no ranking.
- That Sonnet 5.5 or Sol over-refuses benign security work. Both labs document cyber safeguards that can stop legitimate tasks; reports of specific refusals are anecdotes.
- That small models degrade past 100k tokens. Only Haiku's price change is documented.
- Which model each lab would pick for scouting, review or planning. Neither says; the role table is inferred from the model-level statements.
- Whether Pi passes every effort and thinking option through for these ids, including the newer Google/Muse routes.
- Full benchmark tables. The announcements show headline deltas, and several charts were not readable as text.
- Comparative completion quality across providers or the cost per finished delegated task under adaptive routing. The planned routing eval does not execute coding models.
