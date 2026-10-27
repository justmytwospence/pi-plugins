# pi-stash

Main-editor draft stashing for Pi SDK 1.1.0. Independently usable; pi-vim is optional.

## Use

- **Ctrl+S** stashes the main draft and clears the editor.
- Run `/command`: the draft returns when the command starts or finishes and the editor is empty, but never while a selector, dialog or extension UI covers the editor. `/copy`, `/export`, `/share` and `/import` clear the editor when they finish, so the draft returns after that.
- Run `!command` or `!!command`: restoration waits for shell completion.
- Run `/tree`, `/fork` or `/clone`: the draft stays stashed while the selector and its dialogs are open, so Pi can load the message you went back to. If the editor is empty afterwards (a non-message node, a clone or a cancelled `/tree`), the draft comes back. If it holds the loaded message, the draft returns after you submit that message. A cancelled `/fork` keeps the draft until Ctrl+S or the next submit, because a cancel looks the same as a fork in progress.
- **Ctrl+S** with an empty editor restores manually; with text in both places it swaps them.
- **Ctrl+S** with an empty editor and nothing stashed stashes the [pi-next-prompt](../pi-next-prompt) suggestion on screen, if any (optional; asked synchronously over `pi.events` channel `prompt:take-next`, declared in `src/contract.ts`).
- Model and thinking-level selection also restore into an empty editor.

Automatic restoration never replaces a newly typed nonempty draft. The stash stays available for a manual restore or swap. Ctrl+S passes through in embedded editors and when the main editor does not own focus. Attachments are not stashed.

The optional version-1 editor snapshot protocol restores text, cursor, modal mode, selection anchor and in-process history with pi-vim. Without a snapshot provider, restoration uses text only. Symbols are copied structurally from `packages/pi-vim/src/contract.ts`; this package imports no sibling package.

A process-global draft survives session replacement. Session-local callbacks and timers are invalidated on shutdown; editor factory teardown leaves newer owners alone. Duplicate suite instances are diagnosed rather than stacked. Do not enable the upstream package alongside this package. Editor-replacing extensions should load first.

## Stash service for other editors

Other plugins' editors can get a stash of their own over `pi.events` (channel `pi-plugins.prompt-stash.v1`, declared in `src/contract.ts`): emit `{ version: 1 }`, and an active pi-stash sets `create`. A controller from `create({ editor, notify, changed })` handles Ctrl+S (`handleKey`) with the same stash, restore and swap rules as main, and `submitted(text)` brings the draft back after a `/` command. Each controller keeps its own draft, apart from main's. pi-sidebar's composer uses it.

## Migrating from @saadjs/pi-stash

Disable the upstream copy and **fully quit and restart Pi** before using this copy; do not hot-switch between these implementations in either direction. `/reload` and session replacement do not clear process-global state: `@saadjs/pi-stash@0.0.3` creates an untagged stash in its factory, even if no draft was ever stashed, and does not delete it on shutdown.

An unrecognized global stash can therefore be retained state from a retired copy or belong to a still-loaded legacy copy. Pi's extension API does not expose a complete loaded-extension inventory, and configured or installed packages do not prove which handlers are running. This copy warns about that uncertainty, stays inactive and leaves the stash and current draft untouched. It does not claim that the legacy copy still owns Ctrl+S, or adopt its stash and risk conflicting handlers. Tagged suite instances continue to use their active-instance lease for duplicate detection.

**Save current and stashed drafts outside Pi before disabling the legacy copy or quitting.** While the legacy copy is still active, restore its stash with Ctrl+S in an empty main editor and save the restored text. If its handlers are no longer available, this inactive suite copy cannot recover the retained stash through Ctrl+S. Leaving a stash untouched does not save it durably: stashes are in-memory only, a full process restart clears them, and there is no automatic cross-process draft migration. Removing the legacy copy from settings alone cannot resolve an already-retained global stash.

## Load independently

From this repository:

```bash
pi -e ./packages/pi-stash/src/index.ts
```

Or add the absolute path to this package directory as a local Pi package. The package manifest exposes only `src/index.ts`. Runtime packages are supplied by Pi, not bundled.

## Check

```bash
cd packages/pi-stash
npm ci
npm run check
```

Offline tests cover stash/swap, optional snapshots, focus, autocomplete, shell/slash restoration, new drafts, replacement sessions, retained legacy state, live legacy duplicates, suite duplicate ownership and teardown. They do not establish a full interactive TUI smoke test.

## Origin

Absorbed from the installed **`@saadjs/pi-stash@0.0.3`**, read without modifying it. `UPSTREAM.json` records the exact installed source and SHA-256 hashes. The original MIT license and Saad Bash attribution are preserved in `LICENSE` and source comments. This suite version adds main-only focus handling, structural snapshots, generation-aware restoration and ownership-safe cleanup.
