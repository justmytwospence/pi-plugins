---
title: Switchyard integration
description: Ownership and compatibility boundaries between Pi plugins, optional adapters and Switchyard.
---

Plugins own their replaceable within-session workflows and remain independently usable without Switchyard. An optional adapter lives alongside its plugin and translates plugin-owned semantics into portable UI; it is not a second workflow engine. Switchyard core owns hosts, sessions, workspaces, board tasks, dispatch, synchronization, review, notification delivery, authorization, takeover and policy enforcement.

For example, Pi planning and todo items remain plugin workflows, distinct from Switchyard board tasks. Pi background subprocess jobs and subagent workflows are distinct from host-service lifecycle. An approval UI may be plugin-provided, but core security and policy must not depend exclusively on an optional plugin. Existing core agent and task primitives remain core.

When changing an integration, identify the authoritative state and behavior without the plugin or adapter, preserve a portable fallback, and test relevant compatibility across both repositories. Classify each changed surface as adapter-backed, adequately generic or explicitly terminal-only; not every plugin needs an adapter. The [public Switchyard plugin-development skill](https://github.com/justmytwospence/switchyard/tree/dev/skills/switchyard-plugin-development) provides the authoring and verification workflow. Generalize a primitive only when two independent integrations need it, not a whole workflow.

Switchyard's structured adapter and remote-UI contract is separate from the terminal screen-reading contract used by Ovis and Collie. Passing one does not verify the other. Custom terminal UI is not universally converted. Adapter inspection, safe reload and portable preview depend on the Switchyard version: use its adapter-development capability and documented authoring tools when available, and keep legacy portable panels working when they are not.

## Adapter contract v2

Switchyard's adapter contract is one dependency-free type file, `packages/adapter-sdk/src/contract.ts` in Switchyard. Every adapter directory here keeps an identical copy as `src/switchyard/contract.ts`, with the Switchyard commit it came from in its header, and imports it with `import type` only; `scripts/test-contracts.mjs` checks the copies match and that nothing else is imported. Refresh all copies together from a Switchyard release.

Contract v2 adds tool views (one transcript line per tool call, with a verb, target, short facts and a detail node), dialog kinds (question, approval, plan), composer trackers, session badges and the `checklist`, `facts`, `rows` and `badge` nodes. A host from before v2 rejects those nodes and placements and disables the adapter, so every adapter guards them with the same `supports(ctx, feature)` check on `ctx.features` (undefined before v2) and keeps its v1 panels and pills as the fallback. A v1 host never calls `toolView` and ignores `Claim.kind`, so those need no guard. Adapters still read only what their plugin publishes (tool arguments and results, `details`, session entries, statuses); a plugin publishes a structured session entry when an adapter would otherwise have to parse display text.

