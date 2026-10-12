# pi-sticky-last-prompt

Pin the latest user prompt fully above Pi's fullscreen transcript viewport. Left-click the single-line bar to jump back to that prompt, with follow-tail disabled.

## Load independently

Requires Pi SDK 1.1.0; tested against `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 1.1.0. No sibling extension or runtime dependency is required. The host supplies both SDK peers; development dependencies are local test/typecheck tools only.

From the suite checkout, load just this extension for one invocation:

```sh
pi -e ./packages/pi-sticky-last-prompt/src/index.ts
```

For a persistent local package declaration, use `pi install ./packages/pi-sticky-last-prompt`. This component is private (not separately published to npm); its own `pi.extensions` manifest works independently of the suite's root manifest. Enable only one copy: do not also load `npm:pi-sticky-last-prompt` or the suite entry point.

Select fullscreen mode before starting the session. Regular, RPC, JSON and print sessions stay dormant. No tools, commands, shortcuts, sockets or timers are registered.

## Behavior

- User messages and skill invocations (`[skill] name`) count as prompts. Whitespace collapses to a single line; long labels are ellipsized and styled with the current theme.
- The bar is blank when the newest prompt touching the top boundary still has visible rows, including when its first row is exactly on the boundary. It does not fall back to an older prompt while a newer one crosses the edge.
- A left press/click inside the bar is handled through SDK 1.1 component mouse routing. Wheel, other buttons, drags and ordinary transcript input retain Pi's fallback behavior. A click revalidates the painted prompt's identity and current offsets, avoiding jumps to a replacement branch or a prompt hidden by a subsequent clear.
- With only this non-capturing overlay present, a guarded `hasOverlay()` wrapper keeps scrollbar dragging and text selection available. Other visible overlays retain stock suppression. A pre-existing own-method wrapper, even one bearing our tag, makes this copy inactive with a warning; a matching top prompt overlay hides this copy.
- Width changes (including a reserved scrollbar column), skill expansion, streaming, in-place edits and nested transcript rebuilds are remeasured on each paint. No polling or session-history seeding is needed.
- If `pi-clear-screen` is also enabled, its exact zero-row sentinel forms a clear horizon: earlier prompts stay unpinned until you scroll above that horizon. This is optional, detected structurally, with no import from that package.
- Shutdown, reload, widget disposal and repeated session starts release this instance's resources. Later renderer wrappers and other instances' widgets are never deleted; a retained wrapper in another owner's chain becomes pass-through.

## Limits

The bar covers the top transcript row while visible. Keyboard users can use Pi's ordinary transcript navigation; the extension adds no jump shortcut. The upstream private-use pin glyph needs a compatible font.

Transcript components are walked and rendered once more per bar paint (their own render caches still apply). This favors correct offsets over the upstream width/height-only cache, which misses same-height nested edits.

Renderer transcript/overlay internals are not public API. SDK 1.1 supplies a stable TUI proxy; the extension briefly installs a symbol-keyed receiver probe to obtain the real renderer, removes it immediately, and performs wrapper ownership checks there. Missing internals leave the bar blank or inactive. Later SDK versions are unverified despite the SDK-recommended wildcard peer ranges.

Choose the TUI mode at session start. Pi refuses renderer mode switches while any overlay entry exists, even a non-capturing or blank bar; disabling the extension and reloading releases it. Headless tests exercise SDK rendering and mouse routing in memory, not a real terminal lifecycle.

## Checks

With the component's dependencies already present:

```sh
cd packages/pi-sticky-last-prompt
npm run check
```

This runs strict TypeScript checking and local Vitest tests. It requires no live session, network access or paid evaluation. The check does not install dependencies.

## Attribution

Derived from **`pi-sticky-last-prompt@0.1.1`**, by the pi-collections contributors, under MIT. [UPSTREAM.md](UPSTREAM.md) records the verified installed artifact, repository, hashes and local changes. [LICENSE](LICENSE) preserves the original copyright and MIT text verbatim. [UPSTREAM-CHANGELOG.md](UPSTREAM-CHANGELOG.md) is the unmodified upstream changelog, not this fork's release history.
