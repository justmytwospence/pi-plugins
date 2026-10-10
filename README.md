# Pi Plugins

A modular Pi extension suite: use any component on its own, or combine them into an integrated workflow. One Git package, independently selected extensions, one suite version—not a fork of Pi.

**[Documentation and landing page](https://pi-plugins.vercel.app)** · **[Personal project overview](https://www.spencerboucher.com/projects/pi-plugins)**

## Install

```sh
pi install git:github.com/justmytwospence/pi-plugins
```

All 19 extensions in the root manifest are enabled by default. Run `pi config` to disable unwanted extensions, then `/reload` to apply the selection. To enable only background jobs, use this package entry in Pi settings:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-bg/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

A Git commit or tag pins the whole suite. Components cannot be independently version-pinned within one managed Git package. Disabling a component does not uninstall its files. `pi remove` removes the suite.

Do not enable original standalone packages alongside their suite copies: Pi does not deduplicate different physical copies. Disable the old entries first, but keep their repos and checkouts for rollback.

## Components

`source-pins.json` records the exact original revisions imported into this trial. Each directory under `packages/` retains its original README, license, package manifest, tests, and dependency lockfile. The 19 imported extensions are exactly the previously pinned `pi-*` Git packages; retired lean-context and unpinned plugins are not imported. Third-party extensions, tmux-agents, and anthropic-billing-guard remain separate.

Some extensions require external services such as Jev, or offer optional Herdr/marimo integrations. See each component README. Individual operation does not imply that external services are unnecessary.

## Development

Runtime installation does not need a build step. The root exposes each original TypeScript entry point directly, without a wrapper extension.

```sh
npm install
# Install each component's development dependencies using its existing lockfile.
for dir in packages/*; do (cd "$dir" && npm ci); done
npm run check
```

`npm test` uses Pi's actual resource loader to verify the full suite, every individually selected extension, empty selection, registration parity, and duplicate names. It does not bind session lifecycle handlers, make model calls, or exercise the interactive TUI. `npm run check` additionally runs every component's original check command. Live TUI, reload, and integration behavior still need manual testing.

For a check against an already installed Pi SDK, set `PI_TEST_SDK` to its `dist/index.js` file URL or absolute path. `PI_ORIGINAL_ROOT` optionally enables registration parity checks against retained standalone checkouts.

## Documentation

The static documentation site lives in `site/`, with its own package manifest and lockfile. It is not part of Pi's runtime resource manifest.

```sh
cd site
npm ci
npm run check
npm run build
npm run dev
```

See the documentation for component reference pages, setup recipes, requirements, integration protocols, and troubleshooting. Each original component README remains available under `packages/`.

## Migration and rollback

See [the migration procedure](docs/trial.md). The consolidation passed component checks, individual and combined resource loading, registration parity, a fresh Git install/RPC startup, and a manual reload trial. Original repositories remain available and are not deleted or archived. Shared helpers are unchanged; no behavior refactor is bundled with the packaging migration.

## License

MIT. Component licenses and upstream attribution are retained in their original directories, including the plan-mode and subagents upstream credits. Nested repository/homepage metadata describes provenance during this trial, not a completed development migration.
