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

## Documentation ownership

`site/` owns public landing, reference, recipes and architecture docs. The root README is a concise install/development front door; dotfiles documents the maintainer's private machine workflow. Do not invent external requirements or supported tools: verify source and tests. Label terminal illustrations as examples, not real screenshots.
