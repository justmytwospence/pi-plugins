---
title: Developing and testing the suite
description: Validate Pi loader selection, component behavior and the independent static documentation site with separate checks.
---

Runtime components live under `packages/<name>/`. Public documentation lives under `site/`. The root package exposes individual extension entry points through its `pi` manifest; it is not an npm workspace that installs every component or the site.

Keep components independently usable, and keep sibling integrations optional. For cross-extension changes, read [activity ownership and lifecycle](/architecture/activity/) alongside the relevant source and tests.

## Root loader checks

From the repository root:

```sh
npm ci
npm test
```

The [root package scripts](https://github.com/justmytwospence/pi-plugins/blob/main/package.json) run [scripts/test-loader.mjs](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/test-loader.mjs). This uses Pi's actual `DefaultResourceLoader` with temporary, in-memory package settings rather than merely importing each factory through a test stub.

The test checks:

- The full suite loads without loader errors, in the manifest's entry order.
- Tool, command, flag and shortcut registrations do not collide across the suite.
- Each component loads alone from its package directory and through a filtered suite selection.
- Those selections match the full suite's registration signatures: tool, command, flag and shortcut names, plus event-handler counts.
- An explicit empty resource selection loads no extensions.

`PI_TEST_SDK` can supply an alternative SDK module specifier. `PI_ORIGINAL_ROOT` optionally enables registration comparison with the original component directories. Neither is required for the default check.

**Registration parity is not behavior parity.** The script validates factory loading and selection; it does not start sessions, exercise the full TUI/lifecycle or make model calls. A pass does not establish correct focus handling, rendering, child cleanup, optional integration behavior or reload behavior in a live Pi session.

## Component checks

Install each component's lockfile dependencies in that component's directory, then run its own check. For example, from the repository root:

```sh
cd packages/pi-bg
npm ci && npm run check
```

Repeat for each component being changed. Root `npm ci` is not a substitute for these component installs. Respect the configured npm release-age policy; do not bypass it to make a check pass.

The exact check is defined by each component's `package.json`. For example, [pi-bg](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/package.json) runs typechecking and Vitest; [pi-plan-mode](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-plan-mode/package.json) also runs Biome; [pi-select-nav](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-select-nav/package.json) runs TypeScript checking only. Do not assume every `check` has identical coverage.

Once dependencies are installed for all components, run this from the repository root for the full set:

```sh
npm run check
```

That first runs the root loader test, then [scripts/check-components.mjs](https://github.com/justmytwospence/pi-plugins/blob/main/scripts/check-components.mjs). The script reads the component list from `source-pins.json`, runs `npm run check` in each package, continues through component failures and returns a failing exit status if any component fails. It does not install dependencies or check the site.

### Keep paid evaluations separate

**Never run `npm run eval` without explicit authorization.** Evaluation scripts use live paid classifier calls; they are not part of the ordinary validation workflow. Missing credentials or a possible skip is not authorization to invoke them.

For example, pi-subagents separates [ordinary tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/vitest.config.ts) under `test/**/*.test.ts` from [live evaluations](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/vitest.eval.config.ts) under `eval/**/*.eval.ts`.

### Integration changes need more than loading

For activity changes, check both independent operation and the relevant enabled combinations. Exercise source offers before and after host startup, repeated offers, return to an independent pill, external wait completion and cleanup. The contract is copied into pi-bg, pi-subagents and pi-marimo; keep those copies aligned rather than introducing an implicit sibling dependency.

Useful regression entry points include [pi-bg extension tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-bg/test/extension.test.ts), [pi-subagents activity tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-subagents/test/activity.test.ts) and [pi-herdr collector tests](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-herdr/test/core/core.test.ts). These complement, not replace, interactive TUI and lifecycle checks. Report which checks were actually run and which remain unverified.

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
| `npm run check` | Runs `check-docs.mjs` for manifest/catalog coverage, frontmatter, reference structure, JSON examples, selected entry paths and authored local links; then runs Astro diagnostics. |
| `npm run build` | Builds the static site and search output, then runs `check-build.mjs` against rendered HTML, local links and fragments, assets, canonical URLs, metadata and required search output. |

See [authored-document checks](https://github.com/justmytwospence/pi-plugins/blob/main/site/scripts/check-docs.mjs) and [rendered-build checks](https://github.com/justmytwospence/pi-plugins/blob/main/site/scripts/check-build.mjs). These scripts do not fetch external links, so a passing check does not verify GitHub availability or remote content.

## Authoring conventions

- Put public pages in `site/src/content/docs/`, with a frontmatter `title` and a useful `description` of at least 30 characters.
- Use root-absolute, trailing-slash documentation links, such as [development](/development/) and [activity architecture](/architecture/activity/).
- Link claims to exact repository files, not just a repository homepage. Distinguish implemented behavior, targeted test coverage and manual verification.
- Per-plugin references use the package name as their filename and `plugin` frontmatter value. Keep selection examples exact: `packages/<name>/src/index.ts`, without a leading `./`.
- State requirements, costs and optional integrations explicitly. Do not infer supported external tools or lifecycle guarantees from a registration test.
- Label terminal illustrations as examples rather than real screenshots, and do not use emojis in documentation.

The site owns public reference, recipe and architecture content. Keep the root README a concise install/development entry point, and keep private maintainer workflows outside public runtime requirements. See [installation and selection](/guides/install/) for user-facing configuration rather than development checks.
