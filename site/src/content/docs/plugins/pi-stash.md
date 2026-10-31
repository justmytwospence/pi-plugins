---
title: pi-stash
description: Stash a half-written prompt with Ctrl+S, run a slash or shell command, and get the draft back without overwriting newer text.
plugin: pi-stash
---

## Quick reference

- **Use it for:** Set a half-written main prompt aside, run a command and restore it without overwriting new text.
- **Enable:** Select `packages/pi-stash/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Ctrl+S stashes/restores/swaps in the main editor, and in [pi-sidebar](/plugins/pi-sidebar/)'s composer with a stash of its own. No slash command or model tool.
- **Settings:** No settings; one main-editor slot per saved session. Reopening leaves it stashed until Ctrl+S restores it; supported text/cursor/modal snapshots survive restart. Sidebar's separate slots stay in memory.
- **Requirements, cost & privacy:** TUI only; no network, inference or external program. Stashed text is plaintext custom session data, included in JSONL exports but not model context. Current unstashed drafts and attachments are not persisted.
- **Integrations & limits:** Optional Vim snapshots/footer hint; stashes a shown next-prompt suggestion. Embedded fields are untouched. Migrating from the upstream stash requires a full restart after saving the draft.

`pi-stash` gives the main prompt editor a single stash slot per saved Pi session. Press **Ctrl+S** to set the current draft aside and clear the editor, run a slash command such as `/model` or a `!` shell command, and the draft comes back on its own. Reopening a session leaves its recovered prompt stashed, ready for Ctrl+S. It began as [`@saadjs/pi-stash`](https://www.npmjs.com/package/@saadjs/pi-stash) 0.0.3 (MIT, Saad Bash) and was adapted for the suite.

## Enable and requirements

Entry: `packages/pi-stash/src/index.ts`. Follow [Install & select](/guides/install/), or merge this object into your `packages` array:

```json
{
  "packages": [
    {
      "source": "git:github.com/justmytwospence/pi-plugins",
      "extensions": ["packages/pi-stash/src/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

When migrating from `npm:@saadjs/pi-stash`, **save current and stashed drafts outside Pi before disabling it or fully restarting**. While its handlers are active, restore the stash with Ctrl+S in an empty main editor and save the text. Then remove the upstream copy from your settings and fully quit and restart Pi: `/reload` leaves the upstream stash object in memory, even after the upstream extension is disabled. This copy cannot distinguish that unknown untagged object from a live upstream copy, so it leaves the object and current draft untouched and stays inactive with a restart notice. Its saved-session persistence does not adopt or rescue that legacy stash; a full restart clears it. If the legacy handlers are gone, this inactive copy cannot recover it through Ctrl+S. Tagged duplicate suite instances are also reported rather than stacked.

**Requirements and costs:** none beyond Pi's interactive terminal UI. There are no settings, external programs, credentials, network calls or model requests. Print and RPC modes do nothing.

**Storage and privacy:** main-editor stash changes are saved as versioned `pi-stash.state` custom entries in the Pi session. Stashed text is plaintext and included in JSONL exports, but these custom entries do not contribute to model context. Restoring or clearing the stash records an empty slot; it does not erase earlier snapshots from the append-only session history. Restoring never submits a prompt. Only the stash is saved—not an ordinary current editor draft, attachments or Sidebar controller stashes.

A draft-only session that has never submitted its first user message is not yet saved to disk, so its stash cannot be recovered after a full restart. With `--no-session`, the stash stays in memory only.

## Stash, swap and restore

| Editor | Stash | Ctrl+S does |
| --- | --- | --- |
| Has text | Empty | Stashes the draft and clears the editor |
| Empty | Has a prompt | Restores the stashed prompt |
| Has text | Has a prompt | Swaps the two |
| Empty, showing a [next-prompt](/plugins/pi-next-prompt/) suggestion | Empty | Stashes the suggestion and withdraws it |
| Empty | Empty | Warns that there is nothing to stash |

While a prompt is stashed, a `prompt stashed` status is shown; [pi-status-footer](/plugins/pi-status-footer/) turns it into a preview row under the editor.

Automatic restoration happens after a submitted slash command starts (once no selector, dialog or extension UI covers the editor; `/copy`, `/export`, `/share` and `/import` clear the editor when they finish, so their restore waits for that), after a `!` or `!!` shell command finishes, and after a model or thinking-level change. It **only fills an empty editor**. Session starts are different: reopening, restarting or reloading leaves the prompt stashed with its indicator/preview, without changing the current editor. Commands that replace the session load the destination's own stash rather than automatically restoring the outgoing one. If you typed something new in the meantime, that text stays and the stash waits for an explicit Ctrl+S. After a shell command, Pi can leave the command itself in the editor; only that exact text is cleared before restoring.

`/tree`, `/fork` and `/clone` are the exception to "after a slash command starts". They can load an earlier user message into the editor, so the draft stays stashed until the selector, its dialogs and the navigation have finished. If the editor is then empty (a non-message node, a clone, a cancelled `/tree`), the draft comes back. If it holds the loaded message, the draft returns after you submit that message. A cancelled `/fork` keeps the draft until Ctrl+S or the next submit.

## Sessions and navigation

Each saved session owns its main-editor slot, even when sessions share a cwd. `/new` starts empty. `/resume` and a session-replacing `/import` load only the destination session's saved stash. Imported copies with the same session ID but a different file path have separate state. If `/import` completes without replacing the session, its usual empty-editor restoration still applies.

Interactive forks/clones copy the live parent's current slot, **including an empty slot**, rather than reviving an older inherited stash. A CLI fork starts with the latest snapshot in its copied session entries. Parent and child then evolve independently: restoring the child's stash does not consume the parent's, and selected-message prefill remains protected.

The latest session-wide stash snapshot wins, regardless of the active tree branch. Tree navigation does not resurrect a consumed stash from an earlier branch. Reopening leaves the recovered prompt stashed; use Ctrl+S to restore it, or to swap it with text already in the editor.

## Editors and focus

Only Pi's main prompt editor is stashed. Ctrl+S passes through unchanged when another component has focus or when the editor is an embedded one inside a dialog, as marked by the suite editor contract. Other plugins can ask pi-stash for a stash of their own over the `pi-plugins.prompt-stash.v1` event channel; pi-sidebar's composer does, so its drafts never mix with main's. These controller slots stay in memory only and are not persisted with the session. The stash wraps whatever editor factory was installed before it, so it composes with an editor replacement such as [pi-vim](/plugins/pi-vim/) loaded earlier.

With an editor that implements the suite snapshot protocol (pi-vim), the stash persists supported cursor position, modal mode and selection anchor along with the text, and restores them when the text still matches. Opaque editor history stays in process within the same session; it is never serialized. Unsupported or mismatched snapshots fall back to plain text, as does any editor without the protocol. Prompt attachments such as pasted images are not part of the editor text and are not stashed.

## Limitations and troubleshooting

- One main-editor slot per saved session. Stashing again while a prompt is held swaps rather than queueing.
- Reopening leaves a recovered prompt stashed, not in the editor. Use Ctrl+S to restore or swap it. Never-submitted draft-only sessions and `--no-session` do not provide recovery after restart.
- If saving fails, a warning says changes are in memory only. The stash remains available; a subsequent stash change retries saving, and normal shutdown retries dirty state. Until a save succeeds, do not rely on restart recovery.
- An unsupported or invalid latest saved record warns and restores no prompt; pi-stash does not fall back to an older stash or overwrite the invalid record merely by opening the session.
- Enter that only accepts an autocomplete item leaves the editor non-empty, so no automatic restore happens then.
- If Ctrl+S does nothing, check that the main editor has focus, that your terminal or multiplexer delivers the key, and whether a second stash extension produced a startup warning.
- On session shutdown the wrapper is released only if it is still the installed editor factory.

See [keyboard & focus](/guides/keyboard/) for how Ctrl+S fits with other suite shortcuts. [GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-stash), including the [entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-stash/src/index.ts) and upstream [license](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-stash/LICENSE).
