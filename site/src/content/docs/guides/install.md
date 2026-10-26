---
title: Install & select
description: Install the Pi Plugins Git package, choose individual extension entries, and avoid duplicate loading.
---
## Before you install

Use a working [Pi installation](https://pi.dev) with Git available. The suite's configured SDK tests target **Pi 1.2.0**, including local session lifecycle and memory TUI input, not live PTY proof; individual components have their own compatibility notes. A component’s older minimum version does not establish support for the entire suite.

Extensions run with Pi’s operating-system permissions. Review the [source](https://github.com/justmytwospence/pi-plugins) and [requirements](/guides/requirements/) before loading them. This website needs no credentials; some plugin features do.

## Install the suite

Run in your terminal:

```sh
pi install git:github.com/justmytwospence/pi-plugins
pi config
```

The first command adds the suite to personal Pi settings. **It loads all 33 extensions by default.** The second opens Pi’s resource selector: keep only the entries you want. It configures packages; it is not a command inside the chat.

For project-local selection:

```sh
pi install --local git:github.com/justmytwospence/pi-plugins
pi config --local
```

Project settings live in `.pi/settings.json` and load only after project trust is granted. Personal settings live in `~/.pi/agent/settings.json`. Run `pi list` to inspect configured sources. Start Pi again, or use `/reload` in a running session after changing resources.

:::caution[Choose before running a prompt]
Several plugins can use paid classifier requests when credentials are available. Loading all entries does not mean every feature is free or entirely offline. If that is not what you want, select a subset before starting work.
:::

## Enable an explicit subset

You can use the object form in Pi settings instead of the selector. **Merge** this entry into your existing `packages` array; do not replace unrelated settings.

This example loads exactly background work, subagents and the status footer, and nothing else from the suite:

```json
{
  "packages": [
    {
      "source": "git:github.com/justmytwospence/pi-plugins",
      "extensions": [
        "packages/pi-status-footer/src/index.ts",
        "packages/pi-subagents/src/index.ts",
        "packages/pi-bg/src/index.ts"
      ],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

These are **package-relative filter paths without a leading `./`**. Copy the exact entry from a plugin’s reference page.

- Omit `extensions` to load all entries in the suite manifest.
- Set `"extensions": []` to load none. The empty `skills`, `prompts` and `themes` arrays likewise load no other resource types from the suite, so the selection stays exact if the manifest gains them.
- A selection narrows the manifest; it is not a way to load undeclared files.
- One suite source means **one Git ref for every selected plugin**. The filters choose features, not versions.

The root manifest writes its own entry paths with `./`. That is not the spelling to use in the settings selection shown here.

There is no Git subdirectory source for one component. A source such as `git:github.com/justmytwospence/pi-plugins/packages/pi-bg` is not a valid way to install a single plugin: Pi clones a whole repository and reads its root manifest. Select the entry from the suite instead.

## Try without saving a package entry

```sh
pi -e git:github.com/justmytwospence/pi-plugins
```

This adds the suite for one invocation; it does not disable your other configured extensions. For a genuinely isolated local reproduction, see [troubleshooting](/guides/troubleshooting/#isolate-a-conflict).

To load one component from a local checkout of the repository, pass its package directory:

```sh
git clone https://github.com/justmytwospence/pi-plugins
cd pi-plugins
pi -e ./packages/pi-bg
```

Pi reads that directory's own `package.json` manifest. [Standalone & compatibility](/guides/standalone/) explains what each component does without its siblings.

## Avoid double registration

Never enable both a suite entry and another copy of that component. Pi can recognize the same package source, but the suite, a retired standalone repository and an upstream npm package are different packages. They can register the same tools, commands, shortcuts or UI hooks twice.

This includes absorbed upstream packages: remove `npm:pi-vim`, `npm:@saadjs/pi-stash`, `npm:pi-sticky-last-prompt` and `npm:@juicesharp/rpiv-todo` from your settings before selecting their suite replacements. [pi-todo](/plugins/pi-todo/) preserves upstream session replay and legacy config fallbacks; do not delete those files to resolve a registration collision.

In `pi config`, disable the old entry before enabling the suite copy. Review `pi list` and both personal and project settings if duplicates remain. In particular:

- Keep only one `ask_user_question` provider.
- Keep only one `todo` tool and `/todos` command provider: select `packages/pi-todo/index.ts`, not a second upstream copy.
- Keep only one owner of the custom footer.
- Keep only one prompt editor replacement: the suite's pi-vim, not a second vim package. An editor replacement must load **before** the status footer; selection filters do not reorder suite entries.

See the full [conflict checklist](/guides/troubleshooting/) and the packages that [stay separate](/guides/external/). Next, [pin a known revision](/guides/releases/) for a reproducible installation.
