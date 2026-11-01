---
title: Transcript checkpoints
description: Explicit producer-authored checkpoints and one shared row index for navigation, copying and pinned prompts.
---

Ctrl+U/D on [pi-vim](/plugins/pi-vim/)'s fullscreen main prompt moves between **checkpoints** in Insert and idle Normal mode, without Escape. Navigation preserves the draft and mode; Ctrl+D never exits main Pi. Prompts, human feedback, concluding assistant responses, delivered plans/reports and completed shell frames are stops. Routine tool calls, status updates and thinking-only content are not. Visual, EX and pending input remain local; embedded editors and read-only viewers retain their local editing and paging behavior.

The implementation separates three concerns:

1. **Producers declare events.** A plugin knows when it delivers a plan or report and explicitly annotates that value.
2. **Renderers map rows.** The common index maps declarations onto actual visible document ranges, including grouped and cleared views.
3. **Consumers select.** Vim moves between checkpoints; sticky prompts select human intent; copy mode retains all copyable blocks. A checkpoint does not automatically become pinned text, and unmarked output is still copyable.

There is no prose classifier, importance threshold or central list of plugin tools/custom-message names.

## Declare a checkpoint

The package-local `transcript-contract.ts` helper annotates a tool result or custom message without changing its content or existing details:

```ts
return transcriptCheckpoint(
  { content: [{ type: "text", text: report }], details: { markdown: [0] } },
  { id: toolCallId, kind: "report" },
);
```

This is an example producer return, not a Pi SDK method. The helper clones the value and object-shaped details, adding:

```ts
{
  "pi-plugins.transcript.v1": {
    version: 1,
    checkpoint: { id: toolCallId, kind: "report" }
  }
}
```

Use one occurrence ID per delivered event, not a command string or task ID shared across multiple executions. Final tool results can use their tool-call ID; a custom-message delivery can use an existing delivery ID or a newly created UUID. Reuse an ID only for multiple representations of that same occurrence. `kind` is an extensible label, not a closed registry: a new kind needs no navigator change.

Place the declaration in the shared final-result/delivery builder. Do not add it to a renderer or consult mutable task state while rendering: a launch acknowledgement must not turn into a report stop merely because its task later finishes. Pending/progress/ready-only results remain unannotated.

Because details are persisted, declarations survive reload/resume without a live job registry. Older unannotated plugin artifacts are conservatively skipped; their wording is never reverse-engineered. Native prompts/responses remain navigable.

## Describe runtime components

A component without a persisted message, such as a completed interactive terminal snapshot, implements the structural symbol hook:

```ts
[Symbol.for("pi-plugins.transcript-block.v1")]() {
  return {
    kind: "bash",
    checkpoint: { id: this.commandOccurrenceId, kind: "shell" },
  };
}
```

The hook receives `{ width, lines }`, with the component's actual rendered rows. It may supply `kind`, `error`, `userText`, `checkpoint` and `subjects`. `subjects` explicitly lists semantic children represented by one atomic range; it does not promise per-child geometry.

Tool groups use that mechanism. A group produces one navigation stop and can represent the latest human feedback among its children. Summing the ordinary renders of grouped tools would be incorrect: the group changes widths, summaries, spacing and expansion. Hidden content with no visible representative creates no checkpoint.

## Row transformations

Known plain Containers concatenate child rows. The index verifies that composition against the actual render before using child offsets. Other wrappers are opaque unless they provide a mapping.

`Symbol.for("pi-plugins.transcript-rows.v1")` receives `{ width, lines, index, splice }` and returns a mapped index. `index(children, width)` indexes untransformed children; `splice(index, start, deleteCount, insertLines)` updates ranges alongside a row transformation. The result must match the actual final rendered lines exactly, with valid end-exclusive ranges.

Clear-screen uses this hook to map its removed sentinel and trailing padding while recording a zero-row clear horizon. The generic index knows nothing about clear-screen's sentinel. Hook ownership follows the renderer wrapper: cleanup restores only properties still owned by that installation.

## Native boundaries and human words

A single compatibility adapter reads Pi's structural component state:

- User messages and skill invocation representatives are prompts.
- Nonstreaming assistant messages with text blocks, no tool-call block and a terminal stop state are responses. Thinking-only/tool preambles are not responses.
- Completed native user shell cards and compaction/branch summaries are checkpoints.
- Tool/custom plugin records contribute only their explicit annotation, not their tool name, custom type or prose.

The existing `pi-plugins.user-words.v1` hook supplies actual user answers/feedback from tool results. Providers register extractors synchronously during discovery; late offers are ignored and failing providers are isolated. This does not require sticky-last-prompt to be enabled. It is separate from artifact checkpoint declarations.

## Shared implementation and lifecycle

`shared/transcript/` is the canonical development source for the contract, index, viewport adapter and runtime-receiver helper. Generate the independently usable components' local copies with:

```sh
node scripts/sync-transcript-helpers.mjs
```

Verify without writing:

```sh
node scripts/sync-transcript-helpers.mjs --check
```

Root contract tests enforce source/copy equality and prohibit runtime sibling imports. Edit the canonical files, not generated copies. There is no required transcript-service extension.

Navigation captures current rows and actual allocated pane width. Stops do not wrap or resume follow mode, and leave one row above the checkpoint when possible for the pinned-prompt bar. Repeated clamped positions at the end are one landing position. Frozen copy-mode scroll-back refuses changed document/view/width/lines instead of applying stale coordinates.

Vim's keyboard guard and cc-render's mouse/viewport wrapper use the same stable-Proxy receiver resolver. Wrappers chain the current instance handler, not the native prototype, and restore only their own property descriptors. This keeps configured native scroll bindings from stealing main checkpoint input and preserves newer owners during cleanup.

Pi currently has no supported API for full live transcript-child geometry. Necessary host-layout lookups are isolated in the capability-checked viewport adapter. Unsupported/ambiguous geometry fails closed rather than scrolling a different view. Resize, same-height edits, compact rendering and session/renderer replacement require fresh captures; the implementation does not retain stale row positions or run another layout pass.
