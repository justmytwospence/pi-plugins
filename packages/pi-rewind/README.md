# pi-rewind

A Pi extension that restores files alongside conversation rewinds (`/tree` and `/fork`), like Claude Code's `/rewind` or OpenCode's `/undo`. It snapshots the working tree of the current git repository when you submit a message and when the agent run ends; when you move back to a checkpointed point in the conversation, it offers to put the files back as they were.

It is active only in git repositories, and by default only in interactive sessions.

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-rewind/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-rewind/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component: Pi does not deduplicate different packages that register the same tools, commands or shortcuts.

To try it alone from a checkout of the suite repository, for one run:

```sh
pi -e ./packages/pi-rewind
```

No `npm install` is needed to run it: the package.json has no `dependencies`; Pi supplies its peer dependencies.

## How it works

- When a user message is submitted (prompts and queued messages), the working tree of the repository containing Pi's working directory (tracked and untracked files, minus ignored ones) is snapshotted as a git tree object through a temporary index seeded from the real one. HEAD, the real index and the stash are never touched.
- When the agent run ends, the final state is snapshotted too.
- Snapshots are saved as `rewind-checkpoint` custom session entries, so they survive restarts. The tree objects are unreferenced; git keeps them for `gc.pruneExpire` (two weeks by default). If one has been garbage-collected, a rewind to it warns and restores nothing.
- On `/tree` to an entry, or `/fork` from one, that has a checkpoint and whose files differ from the current ones, it asks `Restore files to this point? (N files differ)` with Restore files or Keep current files. Restoring rewrites only the differing files and deletes files created since; directories left empty are removed. Choosing Keep current files changes nothing.
- A user message maps to the snapshot taken before it was answered (for `/tree`, and for `/fork` positioned before it); the last message of a run maps to the snapshot taken when that run ended. Non-message entries resolve to the nearest message above them. Other points have no checkpoint and get no offer.

## Commands

- `/rewind-undo`: restore the files as they were just before the last restore. Running it again reverts the undo. The undo point is kept in memory only, so it does not survive a restart.

## Configuration

- `PI_REWIND_ALWAYS=1`: also take snapshots when Pi has no UI (print and JSON modes). The restore offer still needs a UI. Any other value, or unset, means snapshots only with a UI.

There are no settings files.

## Requirements and costs

- `git` on `PATH`, and a working directory inside a git repository. Outside one it does nothing.
- No network access and no model calls. Snapshots write blob and tree objects into the repository's object database (`.git/objects`), including the contents of untracked, non-ignored files; temporary index files go in the system temp directory and are removed afterwards.

## Limitations

- Ignored files are never snapshotted, restored or deleted.
- It covers one repository per session: the one containing Pi's working directory when the session first needs it. Changes in other repositories or outside the repository are not tracked.

## Development

```sh
cd packages/pi-rewind
npm ci
npm run check
```

`npm run check` runs `tsc --noEmit` against Pi's types; there are no unit tests. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE).

## Keeping files on purpose

A plugin that moves the conversation while meaning to keep the files (pi-plan-mode returning to the planner after an implementation) sends `rewind:keep-files` on Pi's event bus first. The next `/tree` within 10 seconds is then not offered a restore. Nothing needs either plugin to be loaded.
