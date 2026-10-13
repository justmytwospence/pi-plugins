---
title: Rewind
description: Restore checkpointed working-tree files when navigating earlier conversation points in Pi.
plugin: pi-rewind
---

## Quick reference

- **Use it for:** Move local file state back when navigating to an earlier conversation checkpoint.
- **Enable:** Select `packages/pi-rewind/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Pi `/tree` or `/fork` triggers restoration offers; `/rewind-undo` reverses the last restore. No `/rewind` or global shortcut.
- **Settings:** No JSON settings. `PI_REWIND_ALWAYS=1` permits non-UI snapshots; the undo slot is in memory.
- **Requirements, cost & privacy:** Git repository; UI for restoration choices. No remote or inference calls. Snapshots include non-ignored untracked content and use local object-store space.
- **Integrations & limits:** Optional diff-review checkpoint reuse. Does not undo remote effects, ignored untracked files or external paths; Git GC can remove snapshots.

Rewind connects conversation navigation with local file state. Moving to an earlier message does not normally undo filesystem changes; this extension offers a separate restoration choice when that conversation point has a checkpoint.

## Enable and requirements

Select `packages/pi-rewind/src/index.ts` through [Install & select](/guides/install/). The suite loads every entry by default, and every selected entry shares one Git pin.

A Git executable and a working Git repository are required. Outside a repository, the extension does not create checkpoints. Normal operation requires a UI; `PI_REWIND_ALWAYS=1` also enables snapshots in non-interactive modes, but does not supply a restoration dialog where no UI exists.

**There are no Jev calls, model calls or remote requests in this extension.** Its costs are local Git processing, filesystem I/O and object-store space. Large working trees and large non-ignored files can make snapshots expensive. Checkpoints are not a substitute for commits or backups.

## What a checkpoint contains

At each submitted user message, the extension snapshots the repository working tree using a temporary Git index. It records another snapshot when the agent run ends. The real index, HEAD and stash are not changed by this mechanism.

Snapshots include tracked files and non-ignored untracked files. Git ignore rules do not make already tracked files disappear. Because the snapshot covers the repository rather than edits attributed to a particular tool, it can include your own changes and changes made by other processes. Files outside that repository are not included.

Checkpoint metadata is stored as `rewind-checkpoint` custom session entries, associating conversation entries with the repository root and Git tree object. These records survive restarts, but the underlying tree objects are unreferenced and can be pruned by Git. The README describes the default `gc.pruneExpire` window as two weeks; actual retention depends on your repository's Git configuration and cleanup activity.

## Restore through conversation navigation

Use Pi's existing `/tree` or `/fork` navigation. This extension does not register a separate `/rewind` command. When the selected point has a matching checkpoint and its files differ from the present state, the dialog offers **Restore files** or **Keep current files**, with a differing-file count.

A typical workflow is to navigate back to the user request before an unwanted edit, inspect the restoration offer, and choose whether the conversation alone or both conversation and files should move back. Keeping current files is a valid choice when you want to reuse completed work in a different conversational branch.

Restoration writes only differing files and deletes files that exist now but were absent in the target snapshot. That includes non-ignored untracked files created after the checkpoint. It does not reset the real staging area to match the restored working tree, so inspect your file and staging state before committing anything.

## Undo and configuration

`/rewind-undo` restores the file state captured immediately before the last restoration. The implementation then retains the state it just replaced, allowing another invocation to reverse that file-state change. This is one in-memory undo slot, not a durable stack of every restore. Do not expect it to survive a process restart merely because checkpoint metadata does.

There is no plugin JSON configuration file or session on/off command. To collect checkpoints in a non-interactive invocation, set the environment variable when starting Pi:

```sh
PI_REWIND_ALWAYS=1 pi
```

The variable changes snapshot eligibility; it does not make every possible conversation entry checkpointed. Pre-message snapshots are associated with session entries when the agent run ends, and post-run snapshots attach only when the leaf is a message.

## Limits and optional integrations

There are no required companion plugins. Rewind integrates directly with Pi's tree and fork events. It restores repository files, not external effects such as a deployment, a sent message, a database update or a remote branch change. Ignored untracked files and files outside the repository are beyond its snapshot coverage.

A missing checkpoint, unchanged tree or unavailable repository can mean no restoration offer. If Git has already collected the target tree, the extension warns and leaves files unrestored. File application is not transactional: an error can report an incomplete restore after some changes have happened. Review the result rather than assuming every operation succeeded, and avoid concurrent editors or agents when restoring shared files.

See [Troubleshooting](/guides/troubleshooting/) and the [source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-rewind) for checkpoint lookup and restoration behavior. Long-term recovery still belongs in your normal version-control and backup workflow.
