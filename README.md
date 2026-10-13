# Pi Plugins

A modular suite of 26 extensions for [Pi](https://pi.dev): background work, subagents, planning, review, context awareness and terminal ergonomics. Every component can be enabled on its own; one Git ref versions the whole suite. It is not a fork of Pi.

**[Documentation](https://pi-plugins.vercel.app)** · [Personal project overview](https://www.spencerboucher.com/projects/pi-plugins)

## Components

| Area | Components |
| --- | --- |
| Run and coordinate | pi-bg, pi-subagents, pi-herdr, pi-marimo, pi-btw |
| Think and review | pi-plan-mode, pi-ask-user-question, pi-diff-review, pi-rewind, pi-tool-gate |
| Context and cost | pi-cache-guard, pi-auto-effort, pi-status-footer, pi-context |
| Terminal and editing | pi-vim, pi-stash, pi-copy, pi-next-prompt, pi-select-nav, pi-cc-render, pi-markdown-extras, pi-prose-width, pi-sticky-last-prompt, pi-clear-screen, pi-appearance-resync, pi-herdr-scrollbar-width |

Each component has a [reference page](https://pi-plugins.vercel.app/guides/overview/) with its commands, keys, settings, requirements and costs. Some features make paid classifier requests, need Git, Herdr or marimo, or patch non-public TUI internals. Read [requirements and costs](https://pi-plugins.vercel.app/guides/requirements/) before enabling everything.

## Install

```sh
pi install git:github.com/justmytwospence/pi-plugins
```

This loads every component. Run `pi config` to keep only the ones you want, then `/reload`.

To select exactly, put the suite in the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`) as an object, merging it with your existing entries:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": [
    "packages/pi-bg/src/index.ts",
    "packages/pi-diff-review/src/index.ts"
  ],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

- Entries are package-relative paths without a leading `./`. Copy them from each component's reference page.
- Omitting `extensions` loads every entry; `[]` loads none. Filters narrow the root manifest; they cannot load undeclared files.
- Pin with `git:github.com/justmytwospence/pi-plugins@<commit-or-tag>`. The ref applies to every selected component; components cannot be pinned separately.
- There is no Git subdirectory source for a single component. Select it from the suite instead.

Never enable a second copy of a component alongside the suite: neither a retired standalone `pi-*` repository nor the upstream package a component was absorbed from. Pi does not deduplicate different packages that register the same tools, commands, shortcuts or editor. See [standalone compatibility](https://pi-plugins.vercel.app/guides/standalone/).

To load a single component from a checkout of this repository for one run:

```sh
pi -e ./packages/pi-bg
```

Add `-ne` to disable your configured extensions for that run.

## Development

Runtime loading needs no build step: the root `pi` manifest points at each component's TypeScript entry point.

```sh
npm ci
npm test
for dir in packages/*/; do (cd "$dir" && npm ci); done
npm run check
```

`npm test` exercises Pi's real resource loader over the full suite, each individually selected entry, standalone component directories, and an empty selection, comparing registrations. It does not start sessions, make model calls or drive the interactive TUI, so focus, rendering, reload and integration behavior still need manual checks. `npm run check` runs the loader test and then every component's own `check`.

Never run `npm run eval` without explicit authorization: evaluations make live, paid classifier calls.

The documentation site in `site/` is a separate static Astro project with its own lockfile:

```sh
cd site
npm ci
npm run check
npm run build
```

Develop components under `packages/<name>/`. Keep each one independently usable and sibling integrations optional. See [development and testing](https://pi-plugins.vercel.app/development/).

## Provenance

[docs/trial.md](docs/trial.md) is the historical record of the original reversible consolidation of 19 standalone repositories; it is not current installation guidance. `source-pins.json` records the revisions first imported, not current component versions. Original repository history is preserved.

## License

MIT. Each component keeps its own `LICENSE`. Upstream attribution is retained where components began elsewhere: pi-plan-mode (narumiruna/pi-extensions), the pi-subagents UI (tintinweb/pi-subagents), pi-vim (lajarre/pi-vim), pi-stash (`@saadjs/pi-stash` by Saad Bash), pi-sticky-last-prompt (tangentyh/pi-collections), pi-btw (dbachelder/pi-btw), and pi-cc-render, pi-markdown-extras, pi-context and parts of pi-status-footer (pi-cc-extensions by minuque; pi-cc-render also credits tifandotme/pi-extensions and MasuRii/pi-tool-display). See [about and credits](https://pi-plugins.vercel.app/about/).
