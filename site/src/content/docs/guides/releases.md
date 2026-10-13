---
title: Pin, update & rollback
description: Treat Pi Plugins as one Git-versioned suite while retaining independent plugin selection.
---
## One release, independent selection

The root package exposes 26 extension entries. A Git commit or tag selects the version of **the whole suite**. Your `extensions` filter selects which entries load.

There are no independent per-component Git pins within this package. Do not combine multiple copies of the suite at different refs to simulate them. `source-pins.json` records initial import provenance, not current component release versions.

## Pin a revision

Choose a full commit SHA or an existing tag from the [repository](https://github.com/justmytwospence/pi-plugins). Replace `COMMIT_OR_TAG` below; it is a placeholder, not a published release.

```sh
pi install git:github.com/justmytwospence/pi-plugins@COMMIT_OR_TAG
```

For an existing selected install, edit only the `source` value in its package object, preserving your filters:

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins@COMMIT_OR_TAG",
  "extensions": [
    "packages/pi-diff-review/src/index.ts",
    "packages/pi-prose-width/src/index.ts"
  ]
}
```

This is **one object inside `packages`**, not the whole settings file. Then reconcile package checkouts:

```sh
pi update --extensions
pi list
```

Use `/reload` or restart Pi. Record the previous ref and the selected entries before changing either.

## Update intentionally

| Source | What updating does |
| --- | --- |
| Unpinned Git source | Moves to the repository’s current default-branch revision |
| Git source at a commit or tag | Reconciles that ref; does not move the configured pin |
| Local checkout path | Loads your checkout; you manage its files and dependencies |

To update only the suite, Pi also accepts its configured source:

```sh
pi update git:github.com/justmytwospence/pi-plugins
```

For a pinned source, use its full configured source or change the pin and run `pi update --extensions`. **`pi update` alone updates Pi itself**, not the extension collection. Check `pi update --help` on older Pi installations because package commands have evolved.

After an update, confirm that your selections are still present and test the interactions you use: footer/editor order, task views, planner dialogs and notebook state. Loader tests are not full terminal-session certification.

## Roll back

1. Restore the previous suite `source` ref in the same settings scope.
2. Leave the selected-entry list intact unless the older manifest did not include an entry.
3. Run `pi update --extensions`.
4. Restart Pi or `/reload`, then reproduce the workflow that regressed.

Rolling back extension code does not undo files edited by an agent, restore deleted process logs, or guarantee older code can read newer session state. Keep normal Git commits and backups for your work.

## Remove the suite

```sh
pi remove git:github.com/justmytwospence/pi-plugins
```

Use `--local` for a project-local entry, and the configured source including its ref when appropriate. Removal unregisters the package after reload/restart; it is not a request to delete plugin settings, your sessions, or your project’s files.
