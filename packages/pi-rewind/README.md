# pi-rewind

A [pi](https://pi.dev) extension that restores files alongside conversation rewinds
(`/tree` and `/fork`), like Claude Code's `/rewind` or OpenCode's `/undo`.

- When a user message is submitted, the working tree (tracked and untracked files,
  minus ignored ones) is snapshotted as a git tree object through a temporary index.
  HEAD, the real index and the stash are never touched.
- When the agent run ends, the final state is snapshotted too.
- Snapshots are persisted as `rewind-checkpoint` custom session entries, so they
  survive restarts. Tree objects are unreferenced; git keeps them for
  `gc.pruneExpire` (two weeks by default).
- On `/tree` or `/fork` to a checkpointed entry, it offers to restore files. Only
  differing files are rewritten; files created since are deleted.
- `/rewind-undo` restores the state saved just before the last restore.

Only active in git repositories and interactive sessions. Set `PI_REWIND_ALWAYS=1`
to snapshot in non-interactive modes too.

## Install

```sh
pi install git:github.com/justmytwospence/pi-rewind
```

or add a checkout's path to `packages` in `~/.pi/agent/settings.json`.

## Development

```sh
npm install
npm run check   # tsc against pi's types
```
