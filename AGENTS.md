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

## Documentation ownership

`site/` owns public landing, reference, recipes and architecture docs. The root README is a concise install/development front door; dotfiles documents the maintainer's private machine workflow. Do not invent external requirements or supported tools: verify source and tests. Label terminal illustrations as examples, not real screenshots.
