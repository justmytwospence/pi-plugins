# Coherence implementation verification

Local verification completed for the 23-component suite against Pi 1.1.0.

- Root `npm run check`: passed. Includes actual SDK loader tests for isolated, standalone, individually selected and combined components; empty resource selection; optional BTW skill; actual shortcut resolution; metadata, host peers, helper parity and runtime independence; all component checks.
- `python3 scripts/pty-smoke.py`: passed in fullscreen and regular mode, with owned Vim and native fallback editors. Exercises editing, mode-sensitive scrolling, stash/restore, clearing, model picker, embedded question focus/Escape, draft preservation and resize. Uses isolated configuration and offline dummy credentials; never submits a model prompt.
- Owned Vim: 995 unit/integration tests passed; Neovim parity 321 passed with 23 retained upstream skips.
- Site: check/build passed, including 40 HTML pages and 2818 local link/asset checks.
- Portfolio: lint, typecheck, 323 tests and production build passed; lint retains pre-existing warnings. No deployment.
- Dotfiles: 22 migration/merge/profile tests passed. Configuration migration was tested on sources and fixtures before rollout; the four external package entries remain until a published suite revision provides their replacements.
- `git diff --check`: passed.

Live provider/classifier calls, autoresearch experiments, live notebook E2E and human visual acceptance in Herdr/tmux were not performed. Those remain manual acceptance boundaries, not claimed test results. During this verification phase, no paid evaluations, installation cooldown bypass, publication, pin bump, blanket chezmoi apply, or remote synchronization occurred. Publication and scoped rollout follow verification as separate operations. Existing unrelated working-tree changes were preserved.

The staged migration and rollback helpers are in `~/dotfiles/lib/pi_suite_migration.py`; they edit managed sources only. Publication and pinning are separate authorized operations. Initial consolidation provenance remains immutable in `source-pins.json`; new absorbed components retain their own upstream attribution and provenance.
