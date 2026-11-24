---
title: Compaction plan
description: Work out a compaction focus with the session, answer a question if it needs one, then compact and stop or continue with your next prompt.
plugin: pi-compact-plan
---

## Quick reference

- **Use it for:** Compacting with focus instructions that keep what your next task needs, without writing them from scratch, then stopping or carrying on in one step.
- **Enable:** Select `packages/pi-compact-plan/src/index.ts` with [`pi config`](/guides/install/#enable-an-explicit-subset).
- **Controls:** `/compact-plan [next prompt]`. Under the drafted focus: compact and stop, compact and continue, edit it, tell the session what to change, or cancel. Escape stops a drafting request in flight.
- **Settings:** None.
- **Requirements, cost & privacy:** Pi 1.2+ with a UI. One request to the session's model (two if you answer its questions, one more per revision), sending the session's context; on supported APIs it reuses the session's last request so the context is read from the prompt cache, and the summary is then written the same way. When the cache is cold it asks whether to draft from an outline (a few percent of the tokens) or the full conversation.
- **Integrations & limits:** Plain `/compact [instructions]` is unchanged. With [Ask a question](/plugins/pi-ask-user-question/) loaded, the questions and the review use its dialog (typed answers, notes, Review tab); otherwise Pi's selects. Text fields use the suite's editor, so [Vim editing](/plugins/pi-vim/) works in them when it is loaded. With [Cache guard](/plugins/pi-cache-guard/) loaded, its cache clock decides whether the cache is cold, and it leaves a summary written from the cache alone. Its dialogs hold Herdr's blocked state, and its requests the working state. A request gives up after 3 minutes.

`/compact [instructions]` already takes focus instructions; the useful part of them is what only you know (what comes next), plus the session-specific details a generic summary flattens (exact paths, decisions and their reasons, open bugs). `/compact-plan` splits that work: you give the next prompt, the session writes the details.

The focus is for the summary, before compacting: what it keeps verbatim, keeps briefly and drops. Your next prompt is what happens after: the session reads it only to judge what matters, and it is sent unchanged if you continue.

## Flow

1. `/compact-plan wire the retry into the CLI`, or `/compact-plan` alone to keep what the current work needs.
2. Only if the conversation is 50k tokens or more and not (or probably not) in the prompt cache, it asks `Draft the focus from?`: **An outline of the session** (listed first) or **The full conversation**. See [Cost and the prompt cache](#cost-and-the-prompt-cache). Escape cancels.
3. The session's model reads the conversation (or the outline) and your next prompt. If an answer would change what the summary keeps (an abandoned approach, a side issue), it asks up to 3 questions, then revises the focus with your answers. With pi-ask-user-question loaded they are its dialog: options with descriptions, `Type something.` for your own answer, `n` to add a note to an option, and a Review tab (with a note on all answers) when there are several. Without it, each is a Pi select with `Type your own answer` and `Skip this question`.
4. The focus appears in the transcript on the review card plan mode draws a plan with (`Compaction focus review` on the tool background, the focus, then `Waiting for approval`), with the review under it (here pi-ask-user-question's dialog):

```
 Compaction focus review
 - Keep verbatim: retry() in src/net/retry.ts; backoff is 2^n * 250ms capped at 8s (agreed: no jitter in tests)
 - Keep briefly: why the old wrapper was removed
 - Drop: the caching tangent, the passing test runs

 Waiting for approval · next: wire the retry into the CLI

 Ask user ·  Compaction  ───────────────────────────────────────────
 Compact with this focus? Or type what should change.
 → 1. Compact and stop · Compact; your next prompt waits in the editor.
   2. Compact and continue · Compact, then send your next prompt.
   3. Edit the focus · Open the focus in the editor.
   4. Cancel · Leave the session as it is.
   5. Type something.
 n note  ↑↓ navigate  enter select  escape/ctrl+c cancel
```

*Example, not a screenshot.*

5. **Compact and stop** compacts and places your next prompt in the empty prompt editor. **Compact and continue** compacts, then sends your next prompt (or `Continue with the current work.` without one) after a one-line note saying the session was just compacted, so the model does not compact again. A note on either (`n`) is added to the focus as an `Also:` line. **Edit the focus** opens it in the suite's editor (Normal mode with pi-vim): Enter or `:w` saves, Escape in Normal mode or `:q` discards. **Type something.** (or, with Pi's select, **No, change it**) tells the session what to change, and it revises the focus. **Cancel** or Escape leaves the session as it was. After compacting, the card turns green and reads `Compaction focus` and `✓ Compacted with this focus`, with how many tokens the drafting (and a summary from the cache) read and how much of that came from the prompt cache; a focus longer than 12 lines folds until you expand the transcript (ctrl+o). A drafting or compaction failure sends nothing.

The card is a session entry that is never sent to the model; the outcome is recorded with it, so a resumed session draws the same block.

## Cost and the prompt cache

The drafting is a side request outside the session: nothing is added to the transcript and other extensions do not see it. On the Anthropic Messages, OpenAI Responses (including Codex and Azure) and OpenAI Chat Completions APIs, it is the session's last provider request byte for byte (system prompt, tools, thinking settings, messages) with the final reply and the drafting instructions appended, so a warm cache serves the conversation. Otherwise (another API, or no request since `/tree` or a compaction) it sends the session's context as an ordinary request, which pays for the whole context once.

Pi's own summarizer never uses the cache: it sends the conversation as text in a request of its own. So when the drafting was read from (or stored in) the prompt cache and you approve within 4 minutes, `/compact-plan` writes the summary itself the same way, on the session's last request, in Pi's summary format and stopping where Pi's kept recent messages begin. That costs a cache read instead of a full uncached read. If that request cannot be made or fails, Pi's summarizer writes the summary with the focus.

When the conversation is 50k tokens or more, its outline is at most a quarter of its size, and the cache is cold, it asks what to draft from:

- **An outline of the session**: every prompt and reply, one line per tool call, and each tool result cut to its first and last lines and any error or warning lines, sent as an ordinary request on the session's model. Drafting, questions and revisions cost a few percent of the conversation; Pi's summarizer then reads the whole conversation once, so nothing is dropped from the summary. The focus names any detail the outline hid rather than guessing it.
- **The full conversation**: re-reads it once (on supported APIs, refilling the cache), so the draft sees everything, and revisions and the summary then read it from the cache.

The cache is guessed cold when there is no request to reuse (another API, or none since `/tree` or a compaction), or when pi-cache-guard's `cache:state` says cold; otherwise warm, and it drafts from the full conversation without asking.

## Enable and requirements

Use [Install & select](/guides/install/) and select `packages/pi-compact-plan/src/index.ts`. It works on its own; pi-ask-user-question, pi-vim, pi-cache-guard and pi-herdr are optional.

Source: [packages/pi-compact-plan](https://github.com/justmytwospence/pi-plugins/tree/main/packages/pi-compact-plan). The request splicing is adapted from [Sidebar](/plugins/pi-sidebar/).
