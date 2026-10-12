# pi-btw

Parallel side conversations for Pi, adapted from **pi-btw 0.6.1** by Dan Bachelder (MIT). This package runs independently on the **Pi SDK 1.1.0**; no sibling plugin is required. Exact import provenance and SHA-256 hashes of the readonly installed upstream files are in [`UPSTREAM.json`](UPSTREAM.json). The upstream copyright and license remain in [`LICENSE`](LICENSE).

## Load independently

```bash
pi -e /absolute/path/to/pi-plugins/packages/pi-btw
```

Or install that local package path with `pi install`, then `/reload`. `package.json` exposes `src/index.ts` and `skills/`. Enable only one pi-btw copy: do not load both this package and upstream, or both this package and the suite's entry point. Host-provided Pi packages are wildcard peers; development checks pin all three to 1.1.0. There are no runtime npm dependencies or imports from sibling packages.

## Commands

| Command | Behavior |
| --- | --- |
| `/btw [--save] [question]` | Continue a contextual side thread; without a question, reopen the current mode's composer. |
| `/side [--save] [question]` | Alias for `/btw`; same thread and settings. |
| `/btw:new [--save] [question]` | Clear the thread and start fresh with the current main-session context. |
| `/btw:tangent [--save] [question]` | Start/continue a thread without the main conversation. |
| `/btw:ask [--save] [question]` | Start/continue with main context and only `read`, `grep`, `find`, `ls`. |
| `/btw:clear` | Clear the thread and dismiss the overlay. |
| `/btw:model [<provider> <model> <api> \| clear]` | Show, set or clear the BTW-only model override. Missing credentials fall back to the main model. |
| `/btw:thinking [<level> \| clear]` | Show, set or clear the BTW-only thinking override. Levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `/btw:inject [instructions]` | Send the full thread to the main agent, then clear it. |
| `/btw:summarize [instructions]` | Summarize with the effective BTW model, thinking off and no tools, then inject and clear. |

`-s` aliases `--save`. Switching between contextual, tangent and ask modes resets the thread. Changing a BTW override preserves completed exchanges but recreates the child on its next prompt. Normal composer follow-ups retain the current mode. BTW-owned `/btw:*` commands stay local; other slash input goes through the child session's `prompt()` path, not the parent's command registry.

The child uses its own in-memory session and explicit built-in tools rooted at the parent's `cwd`. Contextual and ask modes inherit the active main branch, excluding BTW notes and SDK system-message tool declarations. Tangent mode omits main conversation messages, but retains the parent's system-prompt instructions. All modes retain those instructions; **none inherit the parent's active tools, extension factories, MCP servers, skill registrations or prompt templates**. Contextual and tangent modes expose `read`, `bash`, `edit`, `write`.

`/btw:ask` is a read-only **tool selection**, not a sandbox or a safety guarantee. Inherited prompt text may describe parent capabilities; that text does not register tools. There is no path restriction or permission-extension inheritance. Contextual/tangent tools can edit the same workspace as the main agent, so coordinate concurrent edits.

## UI and delivery

In TUI mode, BTW has a focused overlay with a transcript and composer. Inline questions also work in RPC, JSON, print and SDK hosts: completed answers become visible notes when no terminal overlay is available. Composer-only commands require the TUI. Notifications depend on the host's UI support.

- `Alt+/`, `Super+/` or `Ctrl+Alt+W`: switch focus without closing. Super requires terminal protocol support.
- `PI_BTW_FOCUS_KEYS="ctrl+/,ctrl+alt+b"`: replace focus shortcuts; blank/invalid entries are ignored, with upstream defaults if none remain.
- `Alt+w`: toggle framed window and full width, preserving the text draft and focus.
- Native Input: arrows, wheel, PgUp/PgDn scroll; Ctrl+U/D scroll half a page **only with an empty composer**. With text, they reach Input.
- Enter submits. Native Ctrl+C clears text or dismisses an empty composer.
- First Escape during a running side call aborts it and leaves partial output visible; a second Escape dismisses. Idle Escape dismisses without clearing completed exchanges.

Rendering stays within Pi's 78% overlay-height cap. Short terminals reduce the transcript first; below nine available overlay rows they omit transcript/borders/hints and prioritize the composer, including a multiline editor's cursor row. A one-row overlay shows only that composer row. At least two terminal rows are needed for Pi's one-row top margin; a one-row terminal cannot place this overlay reliably.

An optional embedded editor provider is discovered **synchronously when the overlay opens** through `pi.events.emit("pi-plugins.editor-factory.v1", { version: 1 })`. The package-local structural contract matches `packages/pi-vim/src/contract.ts`; there is no import or dependency on pi-vim. With no provider, or a failed factory, the native Input remains available. Provider editors own modal editing, autocomplete and EX handling; Ctrl+U/D scroll through the supplied callback only in idle Normal mode. Insert, Visual, EX and pending input stay with the editor. The provider is disposed on every close/remount. Focus, cursor markers and input-context/mode symbols are propagated locally; BTW installs no global Ctrl+U/D listener.

Prompts and handoffs serialize within one thread. Reset, dismissal, settings changes, tree navigation, session replacement and shutdown invalidate old async work. Late factories are disposed without prompting; late answers and summaries cannot save, inject, reopen UI or clear a newer thread. Summary calls are tracked and aborted during teardown. Busy status is checked **at delivery**: notes and handoffs use follow-up delivery while the main agent is busy, never steering it.

## Saved state and skill

Upstream entry names and payload formats are preserved:

- `btw-thread-entry`: question, thinking, answer, provider, model, api, thinkingLevel, timestamp, optional usage.
- `btw-thread-reset`: timestamp and optional mode (`contextual`, `tangent`, `readonly`).
- `btw-model-override`: set/clear action, timestamp, and model reference for set.
- `btw-thinking-override`: set/clear action, timestamp, and thinkingLevel for set.
- `btw-note`: visible custom message using the upstream Question/Answer Markdown and exchange details.

State rehydrates from the active branch, not abandoned history. Hidden entries never enter main model context; visible BTW notes are filtered from future main context too. Live tool activity is kept in the overlay; completed persisted exchanges rehydrate as question/thinking/answer. The `skills/btw/SKILL.md` workflow and full command family are retained, with wording narrowed to tool selection rather than a safety claim.

## Development and limits

```bash
cd packages/pi-btw
npm ci
npm run check
```

Checks typecheck source/tests and run hermetic regression and SDK loader/session tests. They do not make paid model calls or open live sockets. No live terminal/provider end-to-end test is claimed. Terminal modifier delivery, IME placement and real-provider cancellation remain host-dependent. Generation guards prevent stale local effects; abort cannot undo filesystem actions a tool already completed. Delivery APIs are fire-and-forget: an asynchronous host delivery failure cannot be acknowledged transactionally by this extension.
