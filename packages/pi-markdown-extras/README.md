# pi-markdown-extras

Extra Markdown rendering for Pi's transcript, applied to user and assistant messages through one `registerMarkdownTransformer`:

- Mermaid dialect fences (`statediagram`, `classdiagram`, `erdiagram`, `sequencediagram` and their `-v2` variants, plus `mermaid`) become Unicode box-drawing diagrams through [grok-mermaid](https://github.com/xl0/grok-mermaid).
- GitHub admonitions (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) become a quote with a bold plain-text label.
- Circled numbers (U+2460..U+2473) are rewritten as `(1)`..`(20)`, which keep a fixed width in every font.
- Link labels that span lines are joined so trailing padding is not part of the clickable area.

Ported from [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) (MIT, minuque). The upstream bare-URL linkifier is not included: Pi's Markdown already autolinks bare URLs, and the linkifier corrupted bold URLs such as `**https://example.com/a**`.

Example of the result (illustration, not a screenshot):

~~~
> [!WARNING]
> The cache is cleared
> on every restart.
~~~

renders as

~~~
| Warning: The cache is cleared on every restart.
~~~

Part of [Pi Plugins](https://github.com/justmytwospence/pi-plugins). Reference: <https://pi-plugins.vercel.app/plugins/pi-markdown-extras/>.

## Install

Install the suite and select only this component. Merge this object into the `packages` array of `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "source": "git:github.com/justmytwospence/pi-plugins",
  "extensions": ["packages/pi-markdown-extras/src/index.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Alternatively, `pi install git:github.com/justmytwospence/pi-plugins` loads every suite component; use `pi config` to keep only the ones you want, then `/reload`. One Git ref versions every selected component. Do not also enable a standalone copy of this component or pi-cc-extensions: both register the same transforms.

To try it alone from a checkout of the suite repository, for one run:

```sh
cd packages/pi-markdown-extras && npm ci
pi -e ./packages/pi-markdown-extras
```

## How it works

The transformer runs on every Markdown render, in this order:

1. Thinking (`assistant-thinking`) is returned verbatim.
2. Multi-line link labels are normalized. This also runs while streaming, so a partially received message never gets an oversized click area.
3. While streaming, nothing else runs. On the final render: circled numbers are rewritten, diagram fences are rendered, admonitions are rewritten.

Diagram and admonition rewrites skip fenced code; the link fix and diagram rendering also skip inline code. An unclosed diagram fence is left as is. Rendered diagram rows are emitted as inline code joined by hard line breaks, as Pi's built-in `mermaid` transformer does. When grok-mermaid cannot parse the source, or the art is wider than the available width, the source is shown in a framed code block instead. Rendered art is cached by source (50 entries) because resize and restore redraw the same messages.

Admonition bodies are joined into one line after the label (`> **Note:** ...`). Consecutive admonitions stay separate quotes.

## Requirements and costs

`grok-mermaid` is the only runtime dependency. The extension imports it lazily when it loads; if it cannot be resolved, diagram fences pass through unchanged and every other transform still works. Nothing is read or written on disk.

## Development

```sh
cd packages/pi-markdown-extras
npm ci
npm run check
```

`check` runs `tsc --noEmit` and then the Vitest suite (`vitest run`, `test/**/*.test.ts`), which includes the bold-URL regression test. For the full suite, the repository root's `npm run check` runs every component's check after the root loader test.

## License

MIT. See [LICENSE](./LICENSE); it carries the upstream pi-cc-extensions copyright.
