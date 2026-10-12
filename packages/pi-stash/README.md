# pi-stash

Main-editor draft stashing for Pi SDK 1.1.0. Independently usable; pi-vim is optional.

## Use

- **Ctrl+S** stashes the main draft and clears the editor.
- Run `/command`: the draft returns when the command starts or finishes and the editor is empty.
- Run `!command` or `!!command`: restoration waits for shell completion.
- **Ctrl+S** with an empty editor restores manually; with text in both places it swaps them.
- Model and thinking-level selection also restore into an empty editor.

Automatic restoration never replaces a newly typed nonempty draft. The stash stays available for a manual restore or swap. Ctrl+S passes through in embedded editors and when the main editor does not own focus. Attachments are not stashed.

The optional version-1 editor snapshot protocol restores text, cursor, modal mode, selection anchor and in-process history with pi-vim. Without a snapshot provider, restoration uses text only. Symbols are copied structurally from `packages/pi-vim/src/contract.ts`; this package imports no sibling package.

A process-global draft survives session replacement. Session-local callbacks and timers are invalidated on shutdown; editor factory teardown leaves newer owners alone. Duplicate stash instances are diagnosed rather than stacked. Do not enable the upstream package alongside this package. Editor-replacing extensions should load first.

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

Offline tests cover stash/swap, optional snapshots, focus, autocomplete, shell/slash restoration, new drafts, replacement sessions, duplicate ownership and teardown. They do not establish a full interactive TUI smoke test.

## Origin

Absorbed from the installed **`@saadjs/pi-stash@0.0.3`**, read without modifying it. `UPSTREAM.json` records the exact installed source and SHA-256 hashes. The original MIT license and Saad Bash attribution are preserved in `LICENSE` and source comments. This suite version adds main-only focus handling, structural snapshots, generation-aware restoration and ownership-safe cleanup.
