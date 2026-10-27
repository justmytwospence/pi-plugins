---
title: Compaction plan
description: Say what you will do after compacting, answer a question if the session needs one, then review and approve the compaction focus it drafts.
plugin: pi-compact-plan
---

## Quick reference

- **Use it for:** Compacting with focus instructions that keep what your next task needs, without writing them from scratch.
- **Enable:** Select `packages/pi-compact-plan/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/compact-plan [what you will do next]`. Without an argument it asks; leave that empty to let the session infer the next step. Under the draft: compact with it, compact and continue, edit it, tell the session what to change, or cancel. Escape stops a request in flight.
- **Settings:** None.
- **Requirements, cost & privacy:** Pi 1.2+ with a UI. One request to the session's model (two if you answer its questions), sending the session's context; on supported APIs it reuses the session's last request so the context is read from the prompt cache.
- **Integrations & limits:** Plain `/compact [instructions]` is unchanged. With [Ask a question](/plugins/pi-ask-user-question/) loaded, the questions and the review use its dialog (typed answers, notes, Review tab); otherwise Pi's selects. Text fields use the suite's editor, so [Vim editing](/plugins/pi-vim/) works in them when it is loaded. Its dialogs hold Herdr's blocked state, and its requests the working state. A request gives up after 3 minutes.

`/compact [instructions]` already takes focus instructions; the useful part of them is what only you know (what comes next), plus the session-specific details a generic summary flattens (exact paths, decisions and their reasons, open bugs). `/compact-plan` splits that work: you give the goal, the session writes the details.

## Flow

1. `/compact-plan wire the retry into the CLI` (or `/compact-plan`, then type the goal).
2. The session's model reads the conversation and your goal. If an answer would change what the summary keeps (an abandoned approach, a side issue), it asks up to 3 questions, then revises the draft with your answers. With pi-ask-user-question loaded they are its dialog: options with descriptions, `Type something.` for your own answer, `n` to add a note to an option, and a Review tab (with a note on all answers) when there are several. Without it, each is a Pi select with `Type your own answer` and `Skip this question`.
3. The draft appears in the transcript as the same review card plan mode draws a plan with (`Compaction plan review` on the tool background, the focus, then `Waiting for approval`), with the review under it (here pi-ask-user-question's dialog):

```
 Compaction plan review
 - Next task: wire retry() from src/net/retry.ts into the CLI's fetch command
 - Preserve verbatim: backoff is 2^n * 250ms capped at 8s (agreed: no jitter in tests)
 - Preserve briefly: why the old wrapper was removed
 - Drop: the caching tangent, the passing test runs

 Waiting for approval · next: wire the retry into the CLI

 Ask user ·  Compaction  ───────────────────────────────────────────
 Compact with this focus? Or type what should change.
 → 1. Yes, compact with it · Compact now. A note on this option is added to the focus.
   2. Yes, compact and continue · Compact, then send the next step so the session keeps working. A note is added to the focus.
   3. Edit the focus · Open the draft in the editor. A note on this option is added to it first.
   4. Cancel · Leave the session as it is.
   5. Type something.
 n note  ↑↓ navigate  enter select  escape/ctrl+c cancel
```

*Example, not a screenshot.*

4. **Yes** compacts with the draft; a note on it (`n`) is added to the focus as an `Also:` line. **Yes, compact and continue** does the same, then sends your goal (or `Continue with the next step.` when you gave none) as the next prompt, so the session keeps working without you. **Edit the focus** opens the draft in the suite's editor (Normal mode with pi-vim): Enter or `:w` saves, Escape in Normal mode or `:q` discards. **Type something.** (or, with Pi's select, **No, change it**) tells the session what to change, and it revises the draft. **Cancel** or Escape leaves the session as it was. After compacting, the card turns green and reads `Compaction plan` and `✓ Compacted with this focus`, with how much of the drafting input came from the prompt cache; a decided focus longer than 12 lines folds until you expand the transcript (ctrl+o). After a plain **Yes**, your goal is placed in the empty prompt editor so you can send it next.

The draft block is a session entry that is never sent to the model; the outcome is recorded with it, so a resumed session draws the same block.

## Cost and the prompt cache

The drafting is a side request outside the session: nothing is added to the transcript and other extensions do not see it. On the Anthropic Messages, OpenAI Responses (including Codex and Azure) and OpenAI Chat Completions APIs, it is the session's last provider request byte for byte (system prompt, tools, thinking settings, messages) with the final reply and the drafting instructions appended, so a warm cache serves the conversation. Otherwise (another API, or no request since `/tree` or a compaction) it sends the session's context as an ordinary request, which pays for the whole context once. The draft's status line reports how much of the drafting input came from the cache.

## Enable and requirements

Use [Install & select](/guides/install/) and select `packages/pi-compact-plan/src/index.ts`. It works on its own; pi-ask-user-question, pi-vim and pi-herdr are optional.

Source: [packages/pi-compact-plan](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-compact-plan). The request splicing is adapted from [Sidebar](/plugins/pi-sidebar/).
