---
title: About & credits
description: Pi Plugins is Spencer Boucher’s personal extension collection, with preserved upstream attribution.
---
## A personal collection, built for Pi

Pi Plugins is maintained by [Spencer Boucher](https://github.com/justmytwospence). It collects focused changes to the coding session: long-running work, planning, review, context awareness and terminal ergonomics.

This documentation covers the Pi suite at [justmytwospence/pi-plugins](https://github.com/justmytwospence/pi-plugins). It is an independent personal project, not the official Pi documentation. For Pi itself, start at [pi.dev](https://pi.dev).

All 30 components are exposed as selectable entries from one Git package. They can be independently enabled, not independently version-pinned within the suite.

## Source and attribution

The suite preserves original repository history and MIT attribution. Component licenses remain with their source.

- **Logical tasks** import [juicesharp/rpiv-mono’s rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f/packages/rpiv-todo) 2.12.0 at original commit `7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f`, with upstream history and MIT attribution preserved. [pi-todo](/plugins/pi-todo/) keeps the `todo` tool, `/todos` command and upstream replay/localization identities while adopting suite configuration and a one-row collapsed widget.
- **Plan mode** began as a fork of [narumiruna/pi-extensions’ plan-mode package](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode), originally published as `@narumitw/pi-plan-mode`. Its planner was subsequently rebuilt around in-process Pi sessions.
- **Subagent UI** adapts the widget, FleetView and conversation viewer from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents), ported to this component’s RPC children and run records.
- **CC render, Markdown extras and context** are ports of [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) by minuque (MIT), as are status footer's working row and MCP chip. CC render's compact thinking forks pi-compact-thinking by tifandotme, and its rich diffs adapt [pi-tool-display](https://github.com/MasuRii/pi-tool-display) by MasuRii.
- The documentation is built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). Search is provided by [Pagefind](https://pagefind.app). Self-hosted fonts are DM Sans and IBM Plex Mono, distributed under the SIL Open Font License through Fontsource.

See the [suite license](https://github.com/justmytwospence/pi-plugins/blob/main/LICENSE), individual `packages/<name>/LICENSE` files, and [initial source provenance](https://github.com/justmytwospence/pi-plugins/blob/main/source-pins.json).

## Related projects

Some components share implementation or configuration conventions with projects for other harnesses. These are **related links**, not products installed by this suite, a migration path, or a promise of feature parity:

- [opencode-herdr](https://github.com/justmytwospence/opencode-herdr)
- [opencode-marimo](https://github.com/justmytwospence/opencode-marimo) and [claude-marimo](https://github.com/justmytwospence/claude-marimo)
- [claude-cache-guard](https://github.com/justmytwospence/claude-cache-guard), [opencode-cache-guard](https://github.com/justmytwospence/opencode-cache-guard) and [codex-cache-guard](https://github.com/justmytwospence/codex-cache-guard)

## About the illustrations

The landing-page terminal is a CSS illustration of a possible workflow. It is labeled as an example, not a screenshot or evidence of a measured run. Times, percentages and status text in examples are illustrative.

## Documentation boundaries

Reference pages are grounded in the repository’s README files, implementation and tests. External provider behavior and upstream terminal APIs can change. Test results establish what a test exercises, not an unrestricted support guarantee.

Found a mismatch? [Open an issue](https://github.com/justmytwospence/pi-plugins/issues) with the relevant source path and a minimal reproduction. Do not include credentials or private session content.
