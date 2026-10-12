---
title: pi-copy
description: Pick messages, Markdown fragments, commands, paths, and URLs to copy, with optional paid Jev ranking.
plugin: pi-copy
---

## Picker and copied content

Run **`/yank`**, or press **Ctrl+Shift+X** by default, to choose text from the current session branch. This is a separate command: Pi's built-in `/copy` and Ctrl+X retain their existing behavior. The picker requires the interactive terminal UI; RPC, JSON, and print workflows are not supported by this command. It does not register a model-callable copy tool.

Entry: `packages/pi-copy/src/index.ts`. Follow [Install & select](/guides/install/) for suite selection. Every suite entry loads by default and selected components share one Git pin.

The default window covers the last 30 user turns. Whole user messages and assistant replies are available, alongside pieces extracted from replies: sections, fenced code, lists and their introductory lines, nested list items, tables, quotes, commit messages, and sufficiently long paragraphs. It also recognizes commands, useful inline snippets, paths, and URLs. Assistant `bash` tool-call commands are included; arbitrary tool results and thinking blocks are not treated as whole copyable messages.

The picker is always a search field: printable keys, including `j` and `k`, go into a fuzzy filter. Move with Pi's configured `tui.select.up`/`tui.select.down` bindings (arrows by default) or Ctrl+K/Ctrl+J; PageUp/PageDown move by a page of rows. Tab switches **Suggested** and **All**. Right arrow, or Space with an empty filter, toggles a preview; left arrow collapses it. `tui.select.confirm` (Enter) copies and closes. `tui.select.cancel` (Escape) first clears a nonempty filter, then closes on another press.

Because the filter is a text field, Ctrl+U and Ctrl+D keep text meanings: Ctrl+U clears the query, and Ctrl+D is delete-forward at the end of the query, which has nothing to delete. Neither scrolls the list. Backspace removes the last character; a bracketed paste goes into the filter with control characters replaced by spaces. Preview length is limited, but copying uses the selected piece's text, not the truncated preview. Extracted commands can omit shell prompts, and code pieces omit their enclosing fences: inspect the selected kind rather than assuming every piece is a byte-for-byte message copy.

## Requirements, privacy, and costs

Extraction, filtering, and recency ordering happen locally. **Jev ranking is optional and paid**, and is enabled by default when the configured classifier and credentials are available. The default is Pi's `typesafe` provider with `jev-latest`. Pi resolves credentials, including `TYPESAFE_API_KEY` for that provider. Classifier integration requires Pi 0.99 or newer; that component requirement is not a compatibility promise for every other suite entry.

Opening the picker can send candidate text and recent user messages to the classifier before you select anything. By default, each candidate is clipped to 600 characters for ranking; the last three nonempty user messages are clipped to 500 characters each. Candidates are limited by both a piece count and a character-budget estimate. Treat this as external processing of session content, not merely a local clipboard operation. Disable ranking before opening sensitive sessions if you do not want those requests.

Clipboard writes use Pi's `copyToClipboard` helper, not a plugin-specific executable. In the inspected Pi 1.1.0 helper, platform fallbacks include `pbcopy` on macOS, `clip` on Windows, `wl-copy` on Wayland, and `xclip` or `xsel` on X11. These are fallback routes, not a list of programs everyone must install. Native clipboard availability and display access also matter. Remote or headless terminal copying may rely on OSC 52, whose delivery cannot be verified by Pi. This does not establish end-to-end support for every terminal, SSH setup, or multiplexer combination.

## Settings and ranking

Settings load from `~/.pi/agent/copy.json`, then `<project>/.pi/copy.json`. `PI_CODING_AGENT_DIR` changes the global directory. Nested objects merge; other values replace earlier values. Unreadable or invalid JSON files are ignored. The complete defaults include a request-budget field omitted from the README's shorter example:

```json
{
  "jev": {
    "enabled": true,
    "provider": "typesafe",
    "model": "jev-latest",
    "timeoutMs": 3000
  },
  "rank": {
    "maxPieces": 120,
    "pieceChars": 600,
    "stateBudgetChars": 60000,
    "copyableThreshold": 0.3,
    "wantWeight": 0.6
  },
  "maxTurns": 30,
  "shortcut": "ctrl+shift+x"
}
```

To avoid classifier requests, use this partial override:

```json
{
  "jev": {
    "enabled": false
  }
}
```

Settings are reread when the picker opens, except that the shortcut is registered when the extension loads. **Source/README discrepancy:** the README describes the shortcut as global-only, but the implementation calls the merged loader with `process.cwd()` at registration. A project file present in that startup directory can therefore affect registration. A later working-directory change does not re-register the key. Set the shortcut globally for a predictable baseline and check startup project overrides when diagnosing conflicts.

The picker opens without waiting for ranking. Suggested combines likelihood and recency, with default weights of 0.6 and 0.4; prose below the copyability threshold is excluded only from Suggested. All stays newest-first. Judgments are cached by content within the session and cleared on session start. The 120-piece limit is a ceiling, not a promise: the estimated 60,000-character budget can select fewer. Disabling new requests does not explicitly clear already cached judgments in the running session.

## Interactions and troubleshooting

If a wanted item is missing from Suggested, switch to All before changing extraction settings. Jev may have judged prose unsuitable for pasting, but that does not remove it from All. If it is absent there too, check the current branch, the `maxTurns` window, and parser boundaries. Repeated identical pieces are deduplicated. Short standalone prose and introductory lines are not always separate pieces; templated URLs such as `http://127.0.0.1:<port>/x` are deliberately skipped. Copy the whole reply when an exact fragment is not offered.

A missing classifier, absent credentials, timeout, or classification error does not prevent opening the picker. Without judgments it uses recency ordering; existing cached judgments can still influence Suggested. Closing the picker aborts the outstanding ranking request. Ranking updates preserve a piece you navigated to if it remains in the list; an untouched cursor stays at the top of the newly ordered results.

While open, the picker emits paired `herdr:blocked` events with the label `Yank picker`. Herdr integration is optional; without a listener these events are inert. `pi-select-nav` is also optional: the picker handles Ctrl+J/Ctrl+K itself and declares a filter input context, so select-nav leaves its keys alone and literal letters reach the search field.

`Nothing to copy yet` means extraction found no pieces. `Copy failed: ...` is a clipboard-backend error, not a Jev failure. Investigate display access, backend availability, and terminal clipboard permissions. A success notification confirms the helper returned, but an OSC 52 route cannot confirm the destination clipboard actually changed. No paid live evaluation is needed to use local recency mode.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-copy)
