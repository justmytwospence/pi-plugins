---
title: pi-stash
description: Stash a half-written prompt with Ctrl+S, run a slash or shell command, and get the draft back without overwriting newer text.
plugin: pi-stash
---

## Quick reference

- **Use it for:** Set a half-written main prompt aside, run a command and restore it without overwriting new text.
- **Enable:** Select `packages/pi-stash/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Ctrl+S stashes/restores/swaps in the main editor, and in [pi-sidebar](/plugins/pi-sidebar/)'s composer with a stash of its own. No slash command or model tool.
- **Settings:** No settings; one in-memory slot. Text/cursor/modal snapshots when supported; no persistence across process restart.
- **Requirements, cost & privacy:** TUI only; no network, inference or external program. Draft stays in memory; image attachments are not stashed.
- **Integrations & limits:** Optional Vim snapshots/footer hint. Embedded fields are untouched. Migrating from the upstream stash requires a full restart after saving the draft.

`pi-stash` gives the main prompt editor a single stash slot. Press **Ctrl+S** to set the current draft aside and clear the editor, run a slash command such as `/model` or a `!` shell command, and the draft comes back on its own. It began as [`@saadjs/pi-stash`](https://www.npmjs.com/package/@saadjs/pi-stash) 0.0.3 (MIT, Saad Bash) and was adapted for the suite.

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

Remove `npm:@saadjs/pi-stash` from your settings first. When migrating from it, restore or copy any stashed draft, then fully quit and restart Pi: `/reload` leaves the upstream stash object in memory, even after the upstream extension is disabled. This copy cannot distinguish that retained object from a live upstream copy, so it preserves the object and stays inactive with a restart notice. Tagged duplicate suite instances are also reported rather than stacked.

**Requirements and costs:** none beyond Pi's interactive terminal UI. There are no settings, external programs, credentials, network calls or model requests. The stash lives in memory only; it is not written to disk and does not survive restarting Pi. Print and RPC modes do nothing.

## Stash, swap and restore

| Editor | Stash | Ctrl+S does |
| --- | --- | --- |
| Has text | Empty | Stashes the draft and clears the editor |
| Empty | Has a prompt | Restores the stashed prompt |
| Has text | Has a prompt | Swaps the two |
| Empty | Empty | Warns that there is nothing to stash |

While a prompt is stashed, a `prompt stashed` status is shown; [pi-status-footer](/plugins/pi-status-footer/) turns it into a preview row under the editor.

Automatic restoration happens after a submitted slash command starts (once no selector, dialog or extension UI covers the editor; `/copy`, `/export`, `/share` and `/import` clear the editor when they finish, so their restore waits for that), after a `!` or `!!` shell command finishes, after a model or thinking-level change, and at session start when a stash is still held in the process. It **only fills an empty editor**. If you typed something new in the meantime, that text stays and the stash waits for an explicit Ctrl+S. After a shell command, Pi can leave the command itself in the editor; only that exact text is cleared before restoring.

`/tree`, `/fork` and `/clone` are the exception to "after a slash command starts". They can load an earlier user message into the editor, so the draft stays stashed until the selector, its dialogs and the navigation have finished. If the editor is then empty (a non-message node, a clone, a cancelled `/tree`), the draft comes back. If it holds the loaded message, the draft returns after you submit that message. A cancelled `/fork` keeps the draft until Ctrl+S or the next submit.

## Editors and focus

Only Pi's main prompt editor is stashed. Ctrl+S passes through unchanged when another component has focus or when the editor is an embedded one inside a dialog, as marked by the suite editor contract. Other plugins can ask pi-stash for a stash of their own over the `pi-plugins.prompt-stash.v1` event channel; pi-sidebar's composer does, so its drafts never mix with main's. The stash wraps whatever editor factory was installed before it, so it composes with an editor replacement such as [pi-vim](/plugins/pi-vim/) loaded earlier.

With an editor that implements the suite snapshot protocol (pi-vim), the stash keeps the cursor position and modal state along with the text and restores them when the text still matches. Any other editor falls back to plain text. Prompt attachments such as pasted images are not part of the editor text and are not stashed.

## Limitations and troubleshooting

- One slot. Stashing again while a prompt is held swaps rather than queueing.
- Enter that only accepts an autocomplete item leaves the editor non-empty, so no automatic restore happens then.
- If Ctrl+S does nothing, check that the main editor has focus, that your terminal or multiplexer delivers the key, and whether a second stash extension produced a startup warning.
- On session shutdown the wrapper is released only if it is still the installed editor factory.

See [keyboard & focus](/guides/keyboard/) for how Ctrl+S fits with other suite shortcuts. [GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-stash), including the [entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-stash/src/index.ts) and upstream [license](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-stash/LICENSE).
