# Pi Plugins

A modular suite of 34 extensions for [Pi](https://pi.dev): background work, subagents, planning, review, context awareness and terminal ergonomics. Every component can be enabled on its own; one Git ref versions the whole suite. It is not a fork of Pi.

**[Documentation](https://pi-plugins.vercel.app)** · **[Keymap & focus](https://pi-plugins.vercel.app/guides/keyboard/)** · **[Requirements, cost & privacy](https://pi-plugins.vercel.app/guides/requirements/)** · **[Development & testing](https://pi-plugins.vercel.app/development/)**

## Choose your plugins

All 34 references include activation, controls, defaults, requirements, costs and limitations. Start with the workflow you need; companions are optional.

### Run & coordinate

| Plugin | Use it to… |
| --- | --- |
| [pi-bg](https://pi-plugins.vercel.app/plugins/pi-bg/) | Run jobs and services; wait for results without polling. |
| [pi-interactive-shell](https://pi-plugins.vercel.app/plugins/pi-interactive-shell/) | Explicitly hand an idle terminal to `!i <command>`, then return to Pi. |
| [pi-todo](https://pi-plugins.vercel.app/plugins/pi-todo/) | Track logical tasks and dependencies in a persistent checklist. |
| [pi-subagents](https://pi-plugins.vercel.app/plugins/pi-subagents/) | Delegate bounded tasks to headless Pi workers. |
| [pi-herdr](https://pi-plugins.vercel.app/plugins/pi-herdr/) | Coordinate interactive handoffs and Herdr pane metadata. |
| [pi-recap](https://pi-plugins.vercel.app/plugins/pi-recap/) | See where a session stands when you come back to it. |
| [pi-sidebar](https://pi-plugins.vercel.app/plugins/pi-sidebar/) | Chat read-only beside a working session, on its prompt cache. |
| [pi-reload-all](https://pi-plugins.vercel.app/plugins/pi-reload-all/) | Reload every Pi session, here and on Herdr's machines, once each is idle. |
| [pi-mcp-device-login](https://pi-plugins.vercel.app/plugins/pi-mcp-device-login/) | Sign in to OAuth MCP servers with a code, no localhost redirect. |

### Think & review

| Plugin | Use it to… |
| --- | --- |
| [pi-plan-mode](https://pi-plugins.vercel.app/plugins/pi-plan-mode/) | Plan before editing, or compare two constrained planners. |
| [pi-ask-user-question](https://pi-plugins.vercel.app/plugins/pi-ask-user-question/) | Make choices with previews, notes and free-text answers. |
| [pi-diff-review](https://pi-plugins.vercel.app/plugins/pi-diff-review/) | Review actual changes and send line comments together. |
| [pi-rewind](https://pi-plugins.vercel.app/plugins/pi-rewind/) | Restore checkpointed files when rewinding the conversation. |
| [pi-tool-gate](https://pi-plugins.vercel.app/plugins/pi-tool-gate/) | Choose permission modes; optionally classify risky calls. Not a sandbox. |

### Context & cost

| Plugin | Use it to… |
| --- | --- |
| [pi-cache-guard](https://pi-plugins.vercel.app/plugins/pi-cache-guard/) | Review cold-cache sends and optionally trim context. |
| [pi-auto-effort](https://pi-plugins.vercel.app/plugins/pi-auto-effort/) | Adjust reasoning effort within your manual ceiling. |
| [pi-status-footer](https://pi-plugins.vercel.app/plugins/pi-status-footer/) | Read Git, context and provider usage at a glance. |
| [pi-context](https://pi-plugins.vercel.app/plugins/pi-context/) | Inspect what fills the context window, with previews. |
| [pi-compact-plan](https://pi-plugins.vercel.app/plugins/pi-compact-plan/) | Plan a compaction: say what is next, review the focus it drafts. |
| [pi-trends](https://pi-plugins.vercel.app/plugins/pi-trends/) | Chart context %, effort, tokens and cost per model call. |
| [pi-pressure](https://pi-plugins.vercel.app/plugins/pi-pressure/) | See CPU, memory and thermal pressure, only while the machine is constrained. |

### Terminal & editing

| Plugin | Use it to… |
| --- | --- |
| [pi-vim](https://pi-plugins.vercel.app/plugins/pi-vim/) | Edit modally; open files or an external editor from the prompt. |
| [pi-history-search](https://pi-plugins.vercel.app/plugins/pi-history-search/) | Fuzzy-search session prompts and browse matching prefixes. |
| [pi-stash](https://pi-plugins.vercel.app/plugins/pi-stash/) | Set a draft aside and restore it after a command. |
| [pi-copy](https://pi-plugins.vercel.app/plugins/pi-copy/) | Copy a useful fragment instead of an entire reply. |
| [pi-next-prompt](https://pi-plugins.vercel.app/plugins/pi-next-prompt/) | Accept an editable next step, never auto-send it. |
| [pi-select-nav](https://pi-plugins.vercel.app/plugins/pi-select-nav/) | Navigate pickers and task panels without hijacking text fields. |
| [pi-cc-render](https://pi-plugins.vercel.app/plugins/pi-cc-render/) | Use compact tool cards, rich diffs and thinking summaries. |
| [pi-markdown-extras](https://pi-plugins.vercel.app/plugins/pi-markdown-extras/) | Render diagrams, admonitions and tidier links. |
| [pi-prose-width](https://pi-plugins.vercel.app/plugins/pi-prose-width/) | Narrow paragraphs while keeping code and tables wide. |
| [pi-sticky-last-prompt](https://pi-plugins.vercel.app/plugins/pi-sticky-last-prompt/) | Keep the scrolled-past prompt visible and jump back on click. |
| [pi-clear-screen](https://pi-plugins.vercel.app/plugins/pi-clear-screen/) | Clear the fullscreen view without deleting context. |
| [pi-appearance-resync](https://pi-plugins.vercel.app/plugins/pi-appearance-resync/) | Retry delayed terminal light/dark reports. |
| [pi-herdr-scrollbar-width](https://pi-plugins.vercel.app/plugins/pi-herdr-scrollbar-width/) | Fix one-column wrapping at fullscreen exit inside Herdr. |

Notebooks: [pi-marimo](https://github.com/justmytwospence/pi-marimo) is a separate package (`pi install npm:pi-marimo`) that integrates with these components.

Some features make paid classifier requests or patch private TUI hooks. **Ctrl+L and Shift+Tab need explicit stock-key remaps** before the suite shortcuts work; see the [keymap](https://pi-plugins.vercel.app/guides/keyboard/#resolve-the-two-stock-conflicts). Read [requirements](https://pi-plugins.vercel.app/guides/requirements/) before enabling everything.

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

The configured SDK test target is **Pi 1.2.0**. `npm test` checks real loader selection/registration, shortcut conflicts, shared contracts, question routing, local `AgentSession` lifecycle, in-memory TUI input and the unit tests of the shared eval helpers. It makes no live model calls and is not live PTY proof; terminal rendering, focus and reload still need interactive checks. `npm run check` runs these root tests and every component's own `check`, using the root manifest as the inventory.

Never run `npm run eval` without explicit authorization: evaluations make live, paid classifier calls. They are manual, run per package, and their shared helpers live in `evals/shared/`.

The documentation site in `site/` is a separate static Astro project with its own lockfile:

```sh
cd site
npm ci
npm run check
npm run build
```

Develop components under `packages/<name>/`. Keep each one independently usable and sibling integrations optional. See [development and testing](https://pi-plugins.vercel.app/development/).

## Provenance

`source-pins.json` records the revisions first imported from the original repositories (CI also reads its component list), not current component versions. Each original repository keeps its history.

## License

MIT. Each component keeps its own `LICENSE`. Upstream attribution is retained where components began elsewhere: pi-todo (`@juicesharp/rpiv-todo` 2.12.0 by juicesharp, original commit `7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f`), pi-plan-mode (narumiruna/pi-extensions), the pi-subagents UI (tintinweb/pi-subagents), pi-vim (lajarre/pi-vim), pi-stash (`@saadjs/pi-stash` by Saad Bash), pi-interactive-shell (Pi's shipped `examples/extensions/interactive-shell.ts`, MIT by Mario Zechner / earendil-works), pi-sticky-last-prompt (tangentyh/pi-collections), and pi-cc-render, pi-markdown-extras, pi-context and parts of pi-status-footer (pi-cc-extensions by minuque; pi-cc-render also credits tifandotme/pi-extensions and MasuRii/pi-tool-display). See [about and credits](https://pi-plugins.vercel.app/about/).
