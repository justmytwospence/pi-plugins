---
title: Developing and testing the suite
description: Validate Pi loader selection, component behavior and the independent static documentation site with separate checks.
---

Runtime components live under `packages/<name>/`. Public documentation lives under `site/`. The root package exposes individual extension entry points through its `pi` manifest; it is not an npm workspace that installs every component or the site.

Keep components independently usable, and keep sibling integrations optional. For cross-extension changes, read [activity ownership and lifecycle](/architecture/activity/) alongside the relevant source and tests.

## Root SDK checks

From the repository root:

```sh
npm ci
npm test
```

The [root package scripts](https://github.com/justmytwospence/pi-plugins/blob/main/package.json) configure **Pi 1.2.0** as the SDK test target. They run loader, shortcut, contract, question-flow and lifecycle checks, then the shared eval helpers' unit tests. [The loader test](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/test-loader.mjs) uses Pi's actual `DefaultResourceLoader` with temporary, in-memory package settings rather than merely importing each factory through a stub.

The loader checks:

- The full suite loads without loader errors, in the manifest's entry order.
- Tool, command, flag and shortcut registrations do not collide across the suite.
- Each component loads alone from its package directory and through a filtered suite selection.
- Those selections match the full suite's registration signatures: tool, command, flag and shortcut names, plus event-handler counts.
- An explicit empty resource selection loads no extensions.

`PI_TEST_SDK` can supply an alternative SDK module specifier for the loader check; it is not required.

Additional checks cover actual Pi shortcut resolution (including stock Ctrl+L conflicts), synchronized contracts, questionnaire routing, local `AgentSession` startup/turn/session replacement and in-memory TUI input. See [shortcut tests](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/test-shortcuts.mjs), [question-flow tests](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/test-question-flow.mjs) and [lifecycle tests](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/test-lifecycle.mjs). The lifecycle fixture uses a local stub provider, not a paid remote model.

**Local SDK coverage is not live PTY proof.** These tests do start sessions and exercise selected TUI/input/lifecycle paths. They do not verify a real terminal's encoding, mouse reporting, rendered appearance or every extension combination. Focus, cleanup and reload still need interactive checks.

## Component checks

Install each component's lockfile dependencies in that component's directory, then run its own check. For example, from the repository root:

```sh
cd packages/pi-bg
npm ci && npm run check
```

Repeat for each component being changed. Root `npm ci` is not a substitute for these component installs. Respect the configured npm release-age policy; do not bypass it to make a check pass.

The exact check is defined by each component's `package.json`. For example, [pi-bg](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/package.json) runs typechecking and Vitest; [pi-plan-mode](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-plan-mode/package.json) also runs Biome; [pi-select-nav](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-select-nav/package.json) runs TypeScript checking and Node input-routing tests. Do not assume every `check` has identical coverage.

Once dependencies are installed for all components, run this from the repository root for the full set:

```sh
npm run check
```

That first runs the root SDK tests (and the unit tests of the shared eval helpers), then [scripts/check-components.mjs](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/check-components.mjs). The script reads the component list from the root `package.json`'s `pi.extensions`, runs `npm run check` in each package, continues through component failures and returns a failing exit status if any component fails. It does not install dependencies or check the site.

### Keep paid evaluations separate

**Never run `npm run eval` without explicit authorization.** Evaluation scripts use live paid classifier calls; they are not part of the ordinary validation workflow. Missing credentials or a possible skip is not authorization to invoke them.

Live evaluations are *targets*: one `eval/<id>.target.ts` per evaluation in a package, registered in the root `evals/targets.ts` and run by one runner, `npm run -s eval -- <id|package|all> [--dry] [--list] [--last] [--json]`. Each target says how many classifier calls it would make (`--dry`, no spend) and returns metrics, a report and whether it passed; the runner skips without `TYPESAFE_API_KEY`, adds up the spend, and appends every run to a git-ignored history that `--last` diffs. Targets either use hand-written cases or replay a random sample of your recent Pi sessions. Evals are manual, and only pi-auto-effort, pi-cache-guard, pi-copy, pi-next-prompt, pi-sidebar, pi-subagents and pi-tool-gate have them. The runner and the common helpers (the Pi model registry, the session sampler, a concurrency pool, a table printer, spend and results) live in [evals/shared](https://github.com/justmytwospence/pi-plugins/tree/main/evals/shared), which is development-only: it is not a component, not in the `pi` manifest and not importable from a component's `src`.

### Integration changes need more than loading

For activity changes, check both independent operation and the relevant enabled combinations. Exercise source offers before and after host startup, repeated offers, return to an independent pill, external wait completion and cleanup. The activity contract has five copies: pi-bg, pi-subagents, pi-marimo, pi-plan-mode and pi-herdr. Keep them aligned rather than introducing an implicit sibling dependency. The working-message contract is copied into pi-bg and pi-status-footer; test both independently and together, including overlapping waits and every release path.

Useful regression entry points include [pi-bg extension tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/test/extension.test.ts), [pi-subagents activity tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/test/activity.test.ts) and [pi-herdr collector tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/test/core/core.test.ts). These complement, not replace, interactive TUI and lifecycle checks. Report which checks were actually run and which remain unverified.

### Offline prompt-handoff PTY regression

From the repository root:

```sh
python3 scripts/test-prompt-offer.py
```

The [prompt-offer regression](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/test-prompt-offer.py) starts a real Pi PTY in regular and fullscreen modes with an offline custom provider. It loads explicit next-prompt and pi-vim entries plus a harmless `/prompt-offer-test` fixture, **without interactive-shell**. There are no real model, classifier or marimo calls. Install Pi and Node on PATH and run `npm ci` in both component directories first, respecting the release-age policy. Missing prerequisites fail rather than skip; a skipped run is not feature verification.

The provider calls `offer_prompt` with `/prompt-offer-test one  two`, then returns a tagless final answer. Terminal output, the saved tool receipt, a boolean-only UI probe and a temporary invocation sentinel verify: displayed acknowledgement, an empty editor with ghost text before acceptance, no execution by the tool or Tab, the exact draft after Tab, and exactly one invocation with unchanged arguments after Enter. Separate preexisting-draft cases require a blocked receipt and unchanged draft, including after Tab. The probe does not write draft/render text to its log or insert text into the editor; input is sent through the PTY. Child process groups, PTYs and temporary fixtures are cleaned up even on failure.

This tests bounded component-render acknowledgement and the exercised input path, not whether a human saw the suggestion or whether a real model always uses the tool correctly. It complements the unit and loader checks; it does not replace manual checks of other terminals or extension combinations.

## Independent static site

The site has its own [package manifest](https://github.com/justmytwospence/pi-plugins/blob/main/site/package.json) and lockfile. Use Node.js 22.12 or newer. From the repository root:

```sh
cd site
npm ci
npm run check
npm run build
```

This is a separate install, not a workspace command and not a runtime plugin requirement. The [Astro configuration](https://github.com/justmytwospence/pi-plugins/blob/main/site/astro.config.mjs) sets `output: "static"` and `trailingSlash: "always"`. The site produces static files in `site/dist/`, with zero backend: no server adapter, credentials, model requests or runtime extension imports are needed to serve it.

The checks have different responsibilities:

| Command | What it checks |
| --- | --- |
| `npm run check` | Runs `check-docs.mjs` for manifest/catalog coverage, frontmatter, uniform quick references, README catalog, keymap action IDs/defaults, JSON examples, selected entry paths and authored local links; then runs Astro diagnostics. |
| `npm run build` | Builds the static site and search output, then runs `check-build.mjs` against rendered HTML, local links and fragments, assets, canonical URLs, metadata and required search output. |

See [authored-document checks](https://github.com/justmytwospence/pi-plugins/blob/main/site/scripts/check-docs.mjs) and [rendered-build checks](https://github.com/justmytwospence/pi-plugins/blob/main/site/scripts/check-build.mjs). The action/default baseline in [keymap data](https://github.com/justmytwospence/pi-plugins/blob/main/site/src/data/keymap.mjs) is an audited Pi 1.2.0 snapshot, not personal configuration. The checker requires a deliberate re-audit if the root test SDK changes; it imports no runtime plugin or SDK. It checks documented defaults and IDs, not whether your terminal delivers a key.

These scripts do not fetch external links, so a passing check does not verify GitHub availability or remote content.

## Authoring conventions

- Put public pages in `site/src/content/docs/`, with a frontmatter `title` and a useful `description` of at least 30 characters.
- Use root-absolute, trailing-slash documentation links, such as [development](/development/) and [activity architecture](/architecture/activity/).
- Link claims to exact repository files, not just a repository homepage. Distinguish implemented behavior, targeted test coverage and manual verification.
- Per-plugin references use the package name as their filename and `plugin` frontmatter value. Keep selection examples exact: `packages/<name>/src/index.ts`, without a leading `./`.
- Start each plugin page with the same six-field Quick reference: use case, enable, controls, settings, requirements/cost/privacy, integrations/limits. Small automatic plugins should explicitly say they have no shortcut or command.
- State requirements, costs and optional integrations explicitly. Do not infer supported external tools or lifecycle guarantees from a registration test.
- Label terminal illustrations as examples rather than real screenshots, and do not use emojis in documentation.

The site owns public reference, recipe and architecture content. Keep the root README a concise install/development entry point, and keep private maintainer workflows outside public runtime requirements. See [installation and selection](/guides/install/) for user-facing configuration rather than development checks.
