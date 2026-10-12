# Reversible consolidation trial

> Historical record. This describes how the first 19 standalone components were consolidated into the suite. It is kept for provenance and is not current installation or development guidance; see the [README](../README.md) and the [documentation site](https://pi-plugins.vercel.app).

This trial imports the 19 active, pinned pi-prefixed Git plugins without changing their implementation. The original development repositories and installed copies remain intact. Local, third-party, and cross-harness packages remain separate.

## Safety checks

- Copy only tracked files at the exact installed/pinned revisions; do not sweep in uncommitted work or credentials.
- Preserve every component license and package manifest, including upstream attribution.
- Preserve component order in the suite manifest. Third-party packages keep their relative order, with pi-vim before the suite.
- Compare registration signatures to the original installed copies, and test all components through the actual Pi loader both together and individually selected.
- Test the Git package in a temporary `PI_CODING_AGENT_DIR` before changing live settings.
- Keep existing installs on disk. Do not run `pi remove` against originals during the trial.
- Apply through the chezmoi source, never edit its generated live settings directly.

## Switch

Back up the managed settings source locally (outside Git), then replace the 19 original managed package entries with one commit-pinned suite entry. Preserve all unrelated entries, local packages, and settings. Original pins remain recorded in `source-pins.json`.

Apply only the Pi settings target, install/reconcile the suite through Pi, and validate the fresh resource loader. Existing running sessions keep their current extension instances until `/reload` or restart. After reload, manually check the footer, questions, plan mode, background work, subagents, review, and navigation. Passing factory/registration tests is not proof of interactive lifecycle behavior.

During the trial, do not bump an original plugin and the suite independently without recording which installation is active. Develop the suite in its source repo, not the managed installed copy. No old repositories are archived.

## Rollback

Restore the previous `packages` array in the managed chezmoi source from the local backup. Leave other settings untouched. Apply the Pi settings target and `/reload` or restart Pi. The old installed copies are still present, so rollback does not need to remove the suite or recreate old repos. The suite can remain on disk, but must not remain enabled alongside its original components.

The trial intentionally does not migrate opencode, change the blog, refactor shared helpers, or assert compatibility with untested Pi versions.
