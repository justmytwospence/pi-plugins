# pi-vim

Vim editing for Pi's main prompt and optional embedded editors. Enable `packages/pi-vim/src/index.ts` from the suite; do not enable the standalone `pi-vim` package at the same time. This package can also be loaded directly with `pi -e ./packages/pi-vim/src/index.ts`.

## Editing and ownership

The engine retains pi-vim 0.14.2's motions, operators, counts, text objects, Visual modes, registers, clipboard policy, undo/redo, dot repeat, mode colors and `piVim` settings. The mode badge replaces the leftmost span of the editor's bottom border; the remaining border keeps host indicators at their original columns. See the [upstream reference at the imported revision](https://github.com/lajarre/pi-vim/blob/e55b07c05b648f3bbccf656c2b0c6ec63f1a91d1/README.md) for the supported commands and settings.

- **Main:** Ctrl+U/D scroll the fullscreen transcript half its viewport height through `tui.scrollBy` only in idle Normal mode. In regular mode they are consumed. Insert keeps native editing. Visual never scrolls the viewport; Escape returns to Normal before scrolling. EX is a text field: Ctrl+U clears its input while keeping `:` open, and Ctrl+D deletes forward at its end cursor (a no-op). Pending counts/operators cancel locally on Ctrl+U/D. Neither EX nor pending input scrolls the parent or invokes `app.exit`. Main EX retains upstream Pi-command/shell dispatch and guarded quit behavior.
- **Embedded:** Enter and `:w`, `:wq`, `:x` submit locally. The quit family cancels locally, with a nonempty-draft guard unless forced. Escape first closes autocomplete, changes mode, or cancels pending/EX input; Escape from idle Normal calls `onCancel`. Optional Ctrl+U/D viewport scrolling is local and idle-Normal-only, never Visual. EX uses the same local text-field controls as main. No EX command automatically reaches Pi's command registry, shell, agent or shutdown.
- **Lifecycle:** cursor ownership is shared once per TUI, not per dialog. Closing an inactive editor does not reset the active editor's shape; closing a dialog cannot disable a live main editor's cursor. Editors are disposed on session replacement/shutdown. Unchanged `setText` calls preserve draft cursor and Vim history across Pi's dialog restoration. Loading a second suite owner reports a diagnostic and leaves the first owner in place; standalone-copy detection reports a warning.

Terminal installation and discovery require `ctx.mode === "tui"`. RPC, JSON and print modes do not install terminal editors. A retained factory rejects use after its session ends.

## Optional editor factory

Consumers remain independently usable and do not import sibling packages. Copy the structural contract from [`src/contract.ts`](src/contract.ts), request a factory when opening the dialog, and fall back to Pi's native `Editor` when discovery is unanswered:

```ts
const request = { version: 1 } as EditorFactoryRequest;
pi.events.emit("pi-plugins.editor-factory.v1", request);
const editor = request.factory?.({
  surface: "embedded", tui, theme, keybindings,
  onSubmit: done,
  onCancel: () => done(undefined),
}) ?? new Editor(tui, theme);
```

Discovery is synchronous. The first provider sets `factory` and `provider: "pi-vim"`; an answered request is never overwritten. Both `main` and `embedded` surfaces are supported; main ignores embedded submit/cancel/EX hooks. Dispose embedded editors when their dialogs close.

The symbol-keyed API reports input context, surface and accurate Insert/Normal/Visual/EX/pending state (including autocomplete). Optional snapshots capture text, cursor, mode, selection anchor and opaque in-process undo/redo/register/repeat/paste history. The Insert hook enters Insert at the end of the draft. Mode-change events on `pi-vim:mode-change` include `surface`. See the contract for callback and snapshot details.

## Provenance and adaptations

Imported from **[lajarre/pi-vim](https://github.com/lajarre/pi-vim)**, npm **`pi-vim@0.14.2`**, Git revision **`e55b07c05b648f3bbccf656c2b0c6ec63f1a91d1`**. The read-only installed npm source matched this revision and the published archive. The source checkout used for the port was `/tmp/pi-vim-upstream`; the installed reference was `~/.pi/agent/npm/node_modules/pi-vim`.

Published archive: `https://registry.npmjs.org/pi-vim/-/pi-vim-0.14.2.tgz`

```text
npm integrity: sha512-CFSKJvOCNToueIMyBgsujT+gHa4sAlLOnT4VYZ6iCGKJ7M24eCVWFKKnnMt6tmP1rDE6T7k/AqBrb6LWzCzRaQ==
archive SHA-256: 0499071360bf4880581f220d083f7bd7e7b0fb20d2f97d32539c6390d92ce2b8
original index.ts SHA-256: 33fb11615c55a656f41f40b396d5706709445d50850fa5477b043534cbb828e2
```

[`provenance.json`](provenance.json) records exact original source/test SHA-256 values. These identify **upstream originals**, not modified destination files. [`LICENSE`](LICENSE) preserves upstream's MIT license and `Copyright (c) 2026 lajarre` verbatim.

Upstream `index.ts` is split into `src/engine/modal-editor.ts`, `src/session.ts` and `src/index.ts`. Other engine modules retain their source, except the cursor-reset export. The modal editor adds integration state/snapshots/disposal, engine-local EX text-field controls and protected surface/cursor/EX seams; autocomplete Escape remains local in Insert. Suite wrappers add the ownership behavior described above. `src/viewport-input.ts` is a narrow SDK 1.1.0 compatibility adapter: the native fullscreen listener precedes public input listeners, so it wraps the dynamically called `handleViewportInput` method only for Ctrl+U/D with an explicitly marked editor focused. This prevents configured native half-page bindings from stealing Insert/EX/pending input. Unknown focus and other input contexts retain native routing; the adapter is released with the final editor. `src/tui-runtime.ts` resolves the SDK's stable TUI Proxy to its actual renderer so ownership and cleanup survive renderer replacement. This is an adapted port, not a claim that the entire engine is byte-identical.

All upstream unit tests, Neovim parity tests and oracle support are retained. Test imports are relocated, the harness accepts structural input handlers, and the extension context includes SDK 1.1.0's TUI mode. Upstream mode-event assertions add the surface marker and exclude suite discovery events. Native autocomplete cursor expectations account for SDK 1.1.0. No upstream editing/parity assertions are removed; known upstream parity divergences remain explicitly skipped. Suite and actual-SDK integration tests are additional.

## Checks

```sh
cd packages/pi-vim
npm ci
npm run check
npm run test:nvim
```

Development dependencies pin Pi coding-agent and TUI **1.1.0**. Neovim parity requires `nvim`; it runs only locally, without live model/classifier calls. Full PTY smoke is a separate coordinator check.
