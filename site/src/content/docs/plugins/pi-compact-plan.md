---
title: Compaction plan
description: Say what you will do after compacting, answer a question if the session needs one, then review and approve the compaction focus it drafts.
plugin: pi-compact-plan
---

## Quick reference

- **Use it for:** Compacting with focus instructions that keep what your next task needs, without writing them from scratch.
- **Enable:** Select `packages/pi-compact-plan/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/compact-plan [what you will do next]`. Without an argument it asks; leave that empty to let the session infer the next step. Under the draft: compact with it, edit it, tell the session what to change, or cancel. Escape stops a request in flight.
- **Settings:** None.
- **Requirements, cost & privacy:** Pi 1.2+ with a UI. One request to the session's model (two if you answer its questions), sending the session's context; on supported APIs it reuses the session's last request so the context is read from the prompt cache.
- **Integrations & limits:** Plain `/compact [instructions]` is unchanged. Text fields use the suite's editor, so [Vim editing](/plugins/pi-vim/) works in them when it is loaded. Its dialogs hold Herdr's blocked state, and its requests the working state. A request gives up after 3 minutes.

`/compact [instructions]` already takes focus instructions; the useful part of them is what only you know (what comes next), plus the session-specific details a generic summary flattens (exact paths, decisions and their reasons, open bugs). `/compact-plan` splits that work: you give the goal, the session writes the details.

## Flow

1. `/compact-plan wire the retry into the CLI` (or `/compact-plan`, then type the goal).
2. The session's model reads the conversation and your goal. If an answer would change what the summary keeps (an abandoned approach, a side issue), it asks up to 3 questions in Pi's select, each with suggested answers, `Type your own answer` and `Skip this question`, then revises the draft with your answers.
3. The draft appears in the transcript the way plan mode shows a plan waiting for approval, with a select under it:

```
 Compaction focus · wire the retry into the CLI

 - Next task: wire retry() from src/net/retry.ts into the CLI's fetch command
 - Preserve verbatim: backoff is 2^n * 250ms capped at 8s (agreed: no jitter in tests)
 - Preserve briefly: why the old wrapper was removed
 - Drop: the caching tangent, the passing test runs

 Waiting for approval

 Compact with this focus?

 → Yes, compact with it
   Edit the focus
   No, change it
   Cancel
```

*Example, not a screenshot.*

4. **Edit the focus** opens the draft in the suite's editor (Normal mode with pi-vim): Enter or `:w` saves, Escape in Normal mode or `:q` discards. **No, change it** asks what should change and has the session revise the draft. **Yes** compacts with it; the status line becomes `✓ Compacted with this focus`, with how much of the drafting input came from the prompt cache, and your goal is placed in the empty prompt editor so you can send it next. **Cancel** (or Escape) leaves the session as it was.

The draft block is a session entry that is never sent to the model; the outcome is recorded with it, so a resumed session draws the same block.

## Cost and the prompt cache

The drafting is a side request outside the session: nothing is added to the transcript and other extensions do not see it. On the Anthropic Messages, OpenAI Responses (including Codex and Azure) and OpenAI Chat Completions APIs, it is the session's last provider request byte for byte (system prompt, tools, thinking settings, messages) with the final reply and the drafting instructions appended, so a warm cache serves the conversation. Otherwise (another API, or no request since `/tree` or a compaction) it sends the session's context as an ordinary request, which pays for the whole context once. The draft's status line reports how much of the drafting input came from the cache.

## Enable and requirements

Use [Install & select](/guides/install/) and select `packages/pi-compact-plan/src/index.ts`. It works on its own; pi-vim and pi-herdr are optional.

Source: [packages/pi-compact-plan](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-compact-plan). The request splicing is adapted from [Sidebar](/plugins/pi-sidebar/).
