---
title: pi-stash
description: Stash a half-written prompt with Ctrl+S, run a slash or shell command, and get the draft back without overwriting newer text.
plugin: pi-stash
---

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

Remove `npm:@saadjs/pi-stash` from your settings first. If another prompt stash already owns Ctrl+S in the same process, this copy reports it and stays inactive rather than stacking a second wrapper.

**Requirements and costs:** none beyond Pi's interactive terminal UI. There are no settings, external programs, credentials, network calls or model requests. The stash lives in memory only; it is not written to disk and does not survive restarting Pi. Print and RPC modes do nothing.

## Stash, swap and restore

| Editor | Stash | Ctrl+S does |
| --- | --- | --- |
| Has text | Empty | Stashes the draft and clears the editor |
| Empty | Has a prompt | Restores the stashed prompt |
| Has text | Has a prompt | Swaps the two |
| Empty | Empty | Warns that there is nothing to stash |

While a prompt is stashed, a `prompt stashed` status is shown; [pi-status-footer](/plugins/pi-status-footer/) turns it into a preview row under the editor.

Automatic restoration happens after a submitted slash command starts, after a `!` or `!!` shell command finishes, after a model or thinking-level change, and at session start when a stash is still held in the process. It **only fills an empty editor**. If you typed something new in the meantime, that text stays and the stash waits for an explicit Ctrl+S. After a shell command, Pi can leave the command itself in the editor; only that exact text is cleared before restoring.

## Editors and focus

Only Pi's main prompt editor is stashed. Ctrl+S passes through unchanged when another component has focus or when the editor is an embedded one inside a dialog, as marked by the suite editor contract. The stash wraps whatever editor factory was installed before it, so it composes with an editor replacement such as [pi-vim](/plugins/pi-vim/) loaded earlier.

With an editor that implements the suite snapshot protocol (pi-vim), the stash keeps the cursor position and modal state along with the text and restores them when the text still matches. Any other editor falls back to plain text. Prompt attachments such as pasted images are not part of the editor text and are not stashed.

## Limitations and troubleshooting

- One slot. Stashing again while a prompt is held swaps rather than queueing.
- Enter that only accepts an autocomplete item leaves the editor non-empty, so no automatic restore happens then.
- If Ctrl+S does nothing, check that the main editor has focus, that your terminal or multiplexer delivers the key, and whether a second stash extension produced a startup warning.
- On session shutdown the wrapper is released only if it is still the installed editor factory.

See [keyboard & focus](/guides/keyboard/) for how Ctrl+S fits with other suite shortcuts. [GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-stash), including the [entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-stash/src/index.ts) and upstream [license](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-stash/LICENSE).
