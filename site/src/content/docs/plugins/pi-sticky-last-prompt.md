---
title: pi-sticky-last-prompt
description: Pin the last prompt you scrolled past to the top of Pi's fullscreen transcript, and click it to jump back.
plugin: pi-sticky-last-prompt
---

## Quick reference

- **Use it for:** Remember which prompt the scrolled transcript belongs to and jump back to it.
- **Enable:** Select `packages/pi-sticky-last-prompt/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Automatic bar; left-click jumps to the pinned prompt. No command, tool or shortcut.
- **Settings:** No settings; derives the pin from the live transcript on paint.
- **Requirements, cost & privacy:** Fullscreen TUI; reported mouse clicks for jumping, Nerd Font for pin icon. No network, inference or external program; shows prompt text locally.
- **Integrations & limits:** Pin survives a clear-screen Ctrl+L. Private renderer hooks may change; duplicate/wrapped overlay ownership makes it stay inactive.

`pi-sticky-last-prompt` shows a one-line bar at the very top of Pi's fullscreen TUI with the most recent prompt that has scrolled completely out of view. Left-click the bar and the transcript scrolls so that prompt sits just below it. It began as [pi-sticky-last-prompt](https://github.com/tangentyh/pi-collections/tree/main/extensions/sticky-last-prompt) 0.1.1 (MIT, pi-collections contributors) and was adapted for the suite.

## Enable and requirements

Entry: `packages/pi-sticky-last-prompt/src/index.ts`. Follow [Install & select](/guides/install/), or merge this object into your `packages` array:

```json
{
  "packages": [
    {
      "source": "git:github.com/justmytwospence/pi-plugins",
      "extensions": ["packages/pi-sticky-last-prompt/src/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Remove `npm:pi-sticky-last-prompt` first. A second sticky bar is detected and reported, and this copy then stays hidden.

**Requirements and costs:** Pi's **fullscreen** TUI (`"tuiMode": "fullscreen"`) and a terminal that reports mouse clicks for the jump. In regular mode the bar is not shown. There are no settings, commands, external programs, network calls or model requests. The pin icon is a Nerd Font private-use glyph; a font without it may draw a placeholder instead.

## What gets pinned

The bar shows the latest prompt whose rows have all scrolled above the top of the viewport. While a prompt is still crossing the top edge, the bar is blank rather than repeating text that is directly beneath it. Text is collapsed to one line and truncated to the terminal width. Skill invocations count as prompts and are shown as `[skill] <name>`.

With [pi-clear-screen](/plugins/pi-clear-screen/), a Ctrl+L clear keeps the latest prompt pinned at the top of the cleared view, so you still see what the conversation is answering.

The pin is recomputed on each paint from the live transcript, so scrolling, streaming output, resizing, `/tree` navigation, compaction and reloads re-derive it without polling. Prompt positions are cached per width and content height; streaming output that changes the height costs one extra measuring pass of the transcript per frame.

## Clicking and mouse behavior

A left click on the bar scrolls the transcript so the pinned prompt lands just below the bar, and turns off follow-tail so new output does not pull the view back down. Only a left press or click inside the bar row is consumed. The wheel, scrollbar, text selection and other buttons keep Pi's normal behavior.

To keep the scrollbar and mouse selection working while the bar is visible, the extension wraps the renderer's internal `hasOverlay()` check so its own non-capturing bar is not counted. Any other visible overlay, such as a dialog or search, restores Pi's normal suppression. The bar covers the top transcript row while it is shown.

## Limitations

The extension reads non-public renderer and transcript internals defensively. If a Pi release renames them, the bar or the click stops working rather than breaking other features. If another extension already wraps `hasOverlay()`, this copy reports it and stays inactive instead of stacking. On shutdown the wrapper becomes pass-through and is removed only if it is still the installed function.

See [keyboard & focus](/guides/keyboard/) for other fullscreen interactions. [GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-sticky-last-prompt), including the [entry point](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-sticky-last-prompt/src/index.ts) and upstream [license](https://github.com/justmytwospence/pi-plugins/blob/main/packages/pi-sticky-last-prompt/LICENSE).
