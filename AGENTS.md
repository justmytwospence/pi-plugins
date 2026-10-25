# Pi Plugins

This repository is the development source for the Pi extension suite. Add or change components under `packages/<name>/`, not in the retained standalone repositories or Pi's installed checkout. Keep plugins independently usable; optional sibling integrations must remain optional. The root `pi` manifest exposes distinct entry points for selection through `pi config`.

## Checks

- Root: `npm ci`, then `npm test` for actual Pi loader selection/registration tests.
- Components: install each component's lockfile dependencies (`npm ci` in its directory), then `npm run check` there or run root `npm run check` for the full set. Do not run `npm run eval` without explicit authorization: it uses live paid classifier calls.
- Docs: `cd site && npm ci && npm run check && npm run build`. Documentation is static, separately deployed, and must not affect runtime installation.

All npm installations follow the machine's release-age policy. Never bypass it.

## Releases and installation

One Git commit/tag versions the whole suite. Components can be independently enabled, not independently Git-version-pinned from this package. Never enable both the suite copy and original standalone copy of a component. Test manifest selection, registration parity, and interactions after integration changes. A factory-loader test is not a full TUI/lifecycle test.

Publish source changes before bumping the suite pin in `~/Projects/dotfiles/home/private_dot_pi/private_agent/settings.managed.json`. Read the dotfiles chezmoi skill and `~/Projects/dotfiles/docs/plugins.md`; iterate locally with `pi --no-extensions -e ~/Projects/pi-plugins`, and after a pin bump let dotfiles' converge script install it (`chezmoi apply`). Never edit an installed copy. Preserve original repo history and upstream MIT attribution. `source-pins.json` records initial import provenance, not the current release versions of components.

### Completion and rollout

Unless the user explicitly requests an uncommitted change or source-only work, finishing a change includes checking it, committing its files with a conventional commit, and pushing. For runtime changes, also update the installed suite: once the commit is on `origin/main`, set the `git:github.com/justmytwospence/pi-plugins@<commit>` spec in `~/Projects/dotfiles/home/private_dot_pi/private_agent/settings.managed.json` to the full commit hash (there is no pin command; edit the spec), commit and push only that pin change in dotfiles, run `chezmoi apply` (its converge script runs `pi update` for the new pin), and follow the dotfiles machine-synchronization policy (`ssh spencer@nuc '~/.local/bin/chezmoi update --no-tty'`). Read `~/Projects/dotfiles/AGENTS.md` and its chezmoi skill before doing so; preserve unrelated changes, including changes in the same settings file. Verify the installed revision on this machine and the NUC with `git -C ~/.pi/agent/git/github.com/justmytwospence/pi-plugins rev-parse HEAD` (the other Mac is not reachable; see the dotfiles policy). Do not call a runtime change done merely because its source was pushed.

Installing a new pin through the converge script writes `~/.pi/agent/reload-request`, so running sessions with pi-reload-all reload themselves once their turn ends and their editor is empty (the session doing the rollout included); a session with a draft stays pending until the draft is cleared. `/reload-all` does the same by hand on every Herdr machine. Sessions without the entry still need `/reload`. State any remaining rollout or reload step explicitly. When exactly one concrete step remains for the user, end with a `<next>…</next>` suggestion (for example, `<next>/reload</next>`); do not silently omit installation or synchronization. If rollout is blocked, report the blocker rather than claiming completion. Documentation-only changes need committing and pushing, but not a runtime pin bump.

## Remote clients

herdr-web-ui and Collie read waiting Pi dialogs off the screen. Before changing a dialog's rendering, the footer, a below-editor widget or Sidebar's layout, read `docs/clients.md` and run `npm run check:clients` afterwards.

## Documentation ownership

`site/` owns public landing, reference, recipes and architecture docs. The root README is a concise install/development front door; dotfiles documents the maintainer's private machine workflow. Do not invent external requirements or supported tools: verify source and tests. Label terminal illustrations as examples, not real screenshots.
