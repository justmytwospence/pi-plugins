---
title: pi-markdown-extras
description: Render Mermaid dialect fences as box-drawing diagrams, GitHub admonitions as labeled quotes, and fix wide characters and multi-line links.
plugin: pi-markdown-extras
---

## Quick reference

- **Use it for:** Read diagrams, labeled admonitions and tidier links in transcript Markdown.
- **Enable:** Select `packages/pi-markdown-extras/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** Automatic rendering; no command, tool or shortcut.
- **Settings:** No plugin settings. Diagram cache: 50 sources; most transforms wait until the final render.
- **Requirements, cost & privacy:** `grok-mermaid` is a suite dependency; missing/failed diagrams fall back to source. No disk, network or inference work.
- **Integrations & limits:** Optional CC render/prose width. Stored messages/context are unchanged; diagram width/parse limits still apply. Do not stack the upstream transformer.

## Purpose and rendering scope

`pi-markdown-extras` adds a few transforms to Pi's transcript Markdown. It registers a single `registerMarkdownTransformer` for user and assistant messages:

- **Diagram fences.** Mermaid dialect fences become Unicode box-drawing diagrams through [grok-mermaid](https://github.com/xl0/grok-mermaid). This covers `statediagram`, `classdiagram`, `erdiagram`, `sequencediagram`, their `-v2` variants, and `mermaid`.
- **Admonitions.** GitHub admonitions (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) become a quote that starts with a bold plain-text label.
- **Circled numbers.** U+2460 to U+2473 are rewritten as `(1)` to `(20)`, which have the same width in every font.
- **Multi-line links.** Link labels that span lines are joined, so trailing padding is not part of the clickable area.

Example input and result (illustration, not a screenshot):

```
> [!WARNING]
> The cache is cleared
> on every restart.
```

renders as a single quote line: `Warning: The cache is cleared on every restart.` with the label in bold.

Entry: `packages/pi-markdown-extras/src/index.ts`. Enable it through [Install & select](/guides/install/). Every suite entry loads by default, and one Git pin versions the selected components together. These transforms change only what the terminal shows. They never change the stored message or model context.

## Transform order

The transformer runs on every Markdown render, in this order:

1. Thinking (`assistant-thinking`) is returned verbatim.
2. Multi-line link labels are normalized. This step also runs while a message streams, so a partly received message never gets an oversized click area.
3. During streaming, nothing else runs. On the final render, circled numbers are rewritten, then diagram fences are rendered, then admonitions are rewritten.

Diagram and admonition rewrites skip fenced code. The link fix and diagram rendering also skip inline code. An unclosed diagram fence is left unchanged. Diagram rows are emitted as inline code joined by hard line breaks, the same approach Pi's built-in `mermaid` transformer takes. Admonition bodies are joined onto one line after the label, and consecutive admonitions stay separate quotes.

## Requirements and costs

`grok-mermaid` is the only runtime dependency. The suite lists it as a dependency. The extension imports it lazily at load time. If it cannot be resolved, diagram fences pass through unchanged and every other transform still works. Nothing is read from or written to disk, and the component makes no model, classifier or network requests. Rendering is local CPU work. Rendered art is cached by source (50 entries), because resizing and restoring the screen redraw the same messages.

When grok-mermaid cannot parse a diagram, or the art is wider than the available width, the source appears in a framed code block instead. A missing diagram is therefore usually a parse or width issue, not a failure of the extension. Widen the pane or simplify the diagram, then compare.

The package tests run with Vitest against Pi 1.2.0's Markdown types. They cover the transforms and include a regression test for bold URLs. No live terminal is involved.

## Interactions and differences from upstream

This component is ported from [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) by minuque, used under the MIT License. Its `LICENSE` keeps the upstream copyright. The upstream bare-URL linkifier was deliberately left out. Pi's Markdown already autolinks bare URLs, and the linkifier corrupted bold URLs such as `**https://example.com/a**`.

Do not also enable pi-cc-extensions or another copy of this component. Both would register the same transforms, and Pi does not deduplicate them. The component works without [pi-cc-render](/plugins/pi-cc-render/). It also composes with [pi-prose-width](/plugins/pi-prose-width/), which sets the paragraph measure. Diagrams are inline code, so they keep their own width.

[GitHub source](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-markdown-extras)
