# Footer integration

These instructions apply to footer integration work in every sibling plugin under `packages/`, not only edits in this directory.

## Integration responsibility

When adding or changing plugin functionality, inspect its user-visible states, controls and status publications. Update footer integration, action descriptors, tests and public documentation in the same logical change whenever those states or controls belong here. Reuse an existing semantic row first; a feature does not automatically earn a new row. If there is no footer impact, explicitly record that assessment in the completion response rather than making a cosmetic change.

## Information architecture

One concern per row. Context owns usage, cache state/timer, MCP and skills. Independent keeps model and workflow on separate rows; Linked combines them and cannot silently unlink. Approvals remain independent. Exec represents an approved lifecycle, not a freely cycled model setting. Reasoning remains independently adjustable in either model/workflow mode.

## Controls and hints

Put one primary effective key hint at the end of each control row, using provider/keybinding state rather than hardcoded keys. Clicking an actual visible value invokes the same underlying action as its keyboard/command path. Small reversible settings may cycle; model and consequential choices use explicit pickers. Telemetry clicks inspect: they must not silently compact, spend money, relax permissions or launch execution. Retain a discoverable off-state for toggles. Do not invent shortcuts for informational rows merely for symmetry.

## Visual consistency

Preserve shared icon/inset alignment, quiet labels and separators, bold workflow/model landmarks, semantic warning/error colors and adjacent dim ` · <key>` hints without alignment padding. Normal core rows do not wrap. Keep unknown, stale and cold states explicit; never present missing data as zero. Preserve meaningful state before low-priority detail/hints at narrow widths. Do not add decorative per-plugin styling that conflicts with this hierarchy.

## Ownership and optional integration

Plugins own behavior; the footer presents state and calls declared capabilities. No runtime sibling imports, rendered-string command parsing, fake user prompts or draft replacement to trigger actions. Absent providers yield absent controls. No I/O or model calls in rendering. Shared package-local contracts stay identical under contract tests.

Keep subscription windows, API throttles, balances and costs distinct. Identify the actual source and account; missing, unsupported, stale or local-only data must not become zero or unlimited. Never use another provider's credentials or account as a quota fallback.

## Interaction correctness

Hit regions derive from final ANSI/cell-aware layout. Measurement renders at another width must not invalidate the visible layout; real resize, snapshot and lifecycle invalidation still discard stale geometry. Ignore padding, separators, dropped segments and stale widths. Respect focus, dialogs, overlays, session generation, selection gestures and ordinary-terminal mouse ownership. Other-session chrome is read-only and never mutates main.

## Verification and client contracts

Read [client constraints](../../docs/clients.md) before layout/control changes. Test Independent, Linked, Exec, missing providers, blocked dialogs and stale/unavailable states at 46/120/180 columns, including Sidebar and activity rows. Preserve the single blocked-footer row and existing 13-status-row budget. Run footer/component checks, root integration checks and `npm run check:clients`; fix every FAIL/KNOWN rather than adding exceptions. Use real renderer/input tests for interaction changes, not only render snapshots.

## Pointers

- [Public behavior](../../site/src/content/docs/plugins/pi-status-footer.md)
- [Client parser constraints](../../docs/clients.md)
- [Layout and snapshots](src/index.ts), [interaction controller](src/interactions.ts)
- [Action contract](src/footer-actions.ts), [flow contract](src/flow-contract.ts)
- [Footer tests](test/footer.test.mjs), [interaction tests](test/interactions.test.mjs)
- [Repository checks, publication and rollout](../../AGENTS.md)
