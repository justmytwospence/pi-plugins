---
title: Install & select
description: Install the Pi Plugins Git package, choose individual extension entries, and avoid duplicate loading.
---
## Before you install

Use a working [Pi installation](https://pi.dev) with Git available. The suite’s loader tests target **Pi 1.1.0**; individual components have their own compatibility notes. A component’s older minimum version does not establish support for the entire suite.

Extensions run with Pi’s operating-system permissions. Review the [source](https://github.com/justmytwospence/pi-plugins) and [requirements](/guides/requirements/) before loading them. This website needs no credentials; some plugin features do.

## Install the suite

Run in your terminal:

```sh
pi install git:github.com/justmytwospence/pi-plugins
pi config
```

The first command adds the suite to personal Pi settings. **It loads all 19 extensions by default.** The second opens Pi’s resource selector: keep only the entries you want. It configures packages; it is not a command inside the chat.

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

This example loads only background work, subagents and the status footer:

```json
{
  "packages": [
    {
      "source": "git:github.com/justmytwospence/pi-plugins",
      "extensions": [
        "packages/pi-status-footer/src/index.ts",
        "packages/pi-subagents/src/index.ts",
        "packages/pi-bg/src/index.ts"
      ]
    }
  ]
}
```

These are **package-relative filter paths without a leading `./`**. Copy the exact entry from a plugin’s reference page.

- Omit `extensions` to load all entries in the suite manifest.
- Set `"extensions": []` to load none.
- A selection narrows the manifest; it is not a way to load undeclared files.
- One suite source means **one Git ref for every selected plugin**. The filters choose features, not versions.

The root manifest writes its own entry paths with `./`. That is not the spelling to use in the settings selection shown here.

## Try without saving a package entry

```sh
pi -e git:github.com/justmytwospence/pi-plugins
```

This adds the suite for one invocation; it does not disable your other configured extensions. For a genuinely isolated local reproduction, see [troubleshooting](/guides/troubleshooting/#isolate-a-conflict).

## Avoid double registration

Never enable both a suite entry and the original standalone package for that component. Pi can recognize the same package source, but the suite and a standalone repository are different packages. They can register the same tools, commands, shortcuts or UI hooks twice.

In `pi config`, disable the old entry before enabling the suite copy. Review `pi list` and both personal and project settings if duplicates remain. In particular:

- Keep only one `ask_user_question` provider.
- Keep only one owner of the custom footer.
- Load an editor replacement such as pi-vim **before** the status footer.

See the full [conflict checklist](/guides/troubleshooting/). Next, [pin a known revision](/guides/releases/) for a reproducible installation.
