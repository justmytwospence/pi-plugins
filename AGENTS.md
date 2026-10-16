# Pi Plugins

This repository is the development source for the Pi extension suite. Add or change components under `packages/<name>/`, not in the retained standalone repositories or Pi's installed checkout. Keep plugins independently usable; optional sibling integrations must remain optional. The root `pi` manifest exposes distinct entry points for selection through `pi config`.

## Checks

- Root: `npm ci`, then `npm test` for actual Pi loader selection/registration tests.
- Components: install each component's lockfile dependencies (`npm ci` in its directory), then `npm run check` there or run root `npm run check` for the full set. Do not run `npm run eval` without explicit authorization: it uses live paid classifier calls.
- Docs: `cd site && npm ci && npm run check && npm run build`. Documentation is static, separately deployed, and must not affect runtime installation.

All npm installations follow the machine's release-age policy. Never bypass it.

## Releases and installation

One Git commit/tag versions the whole suite. Components can be independently enabled, not independently Git-version-pinned from this package. Never enable both the suite copy and original standalone copy of a component. Test manifest selection, registration parity, and interactions after integration changes. A factory-loader test is not a full TUI/lifecycle test.

Publish source changes before bumping the suite pin in `~/dotfiles/private_dot_pi/private_agent/settings.managed.json`. Read the dotfiles chezmoi skill and `~/dotfiles/docs/plugins.md`; use `plugins try pi-plugins` for local iteration and `plugins pin pi-plugins` for published pins. Never edit an installed copy. Preserve original repo history and upstream MIT attribution. `source-pins.json` records initial import provenance, not the current release versions of components.

### Completion and rollout

Unless the user explicitly requests an uncommitted change or source-only work, finishing a change includes checking it, committing its files with a conventional commit, and pushing. For runtime changes, also update the installed suite with `plugins pin pi-plugins`, commit and push only that pin change in dotfiles, and follow the dotfiles machine-synchronization policy. Read `~/dotfiles/AGENTS.md` and its chezmoi skill before doing so; preserve unrelated changes, including changes in the same settings file. Verify the installed revision on each synced host. Do not call a runtime change done merely because its source was pushed.

Running Pi sessions still need `/reload` after installation. State any remaining rollout or reload step explicitly. When exactly one concrete step remains for the user, end with a `<next>…</next>` suggestion (for example, `<next>/reload</next>`); do not silently omit installation or synchronization. If rollout is blocked, report the blocker rather than claiming completion. Documentation-only changes need committing and pushing, but not a runtime pin bump.

## herdr-web-ui compatibility

herdr-web-ui (devswha/herdr-web-ui, `server/prompt.ts`) turns a waiting Pi dialog into a phone card by reading the screen text. It has no configuration hook. Every dialog that holds `herdr:blocked` must keep a layout it can read, or phones fall back to a bare Enter/Esc card:

- **Pi layout** (single-choice questions, tool-gate approvals, plan approval, Review): from the bottom, at most 2 footer lines, a rule, then Pi's key hint ending in `↑↓ navigate  enter select  escape/ctrl+c cancel` (or `enter submit  escape/ctrl+c cancel` under a single `›` input line). Above that a blank line, then one row per option (cursor `→`, single-space labels, cursor on the first row). A wrapped rest of a row goes behind a 1-column `│`. Above that a blank line, then the question.
- **OmO form** (multi-select questions): an `Ask user` line, a tab bar ending in `Submit`, numbered rows indented 2-4, an unnumbered `Type your own answer` line, and a hint starting `↑↓ move  1-9 select  space toggle  enter next` and ending `esc cancel`. No footer line may end in `%`, `$`, `#` or `>`. Number keys toggle, Backspace clears, Tab commits.
- pi-status-footer shrinks to one row while `herdr:blocked` is held, so a pi-bg or subagent activity row still fits in the 2 lines after the hint.
- Anything drawn on an option row shows up in the phone card's option text, so keep box glyphs and decorations off unchecked rows.

Before changing a dialog's rendering, the footer, or below-editor widgets, render the screen at 46 and 120 columns. Feed it, plus the footer and any activity row, to the installed parser: `parseInteractivePrompt("pi", screen)` from `~/.local/share/herdr-web-ui/remote-v*/server/prompt.ts`, run with that bundle's `bin/bun`. Check the card's question, options and `multi_select`, and the text-box card after "Type something." or "Other". Re-check after herdr-web-ui updates.

## Documentation ownership

`site/` owns public landing, reference, recipes and architecture docs. The root README is a concise install/development front door; dotfiles documents the maintainer's private machine workflow. Do not invent external requirements or supported tools: verify source and tests. Label terminal illustrations as examples, not real screenshots.
