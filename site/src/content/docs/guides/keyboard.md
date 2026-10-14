---
title: Keymap & focus
description: A task-oriented reference to stock Pi keys, suite editor and dialog controls, explicit conflict resolution and an optional personal profile.
---

**Start with the task, then check focus.** A key can scroll the transcript, edit a draft or move a dialog selection; those are different owners. This guide distinguishes **stock Pi 1.2.0 defaults**, **suite features**, and an **optional personal profile**. Installing the suite does not install that profile.

Run **`/hotkeys`** for your effective main-editor/application bindings. The tables below explain ownership and context; each plugin's reference covers its local dialog keys. Pi action IDs belong in `~/.pi/agent/keybindings.json`. Plugin shortcuts and editor chords use the plugin's settings or implementation, not invented Pi action IDs.

## Navigate and search the transcript

**Owner: stock Pi. Focus: main prompt in fullscreen mode** (`"tuiMode": "fullscreen"`). These navigate the application-owned transcript, not the draft. In regular mode your terminal owns scrollback. A dialog or overlay has its own viewport and controls.

| Action ID | Stock keys | Task |
| --- | --- | --- |
| `tui.altScreen.pageUp` | PageUp | Read one page earlier. |
| `tui.altScreen.pageDown` | PageDown | Read one page later. |
| `tui.altScreen.previousPrompt` | Ctrl+Shift+Up / Ctrl+Up | Jump to the previous marked message. |
| `tui.altScreen.nextPrompt` | Ctrl+Shift+Down / Ctrl+Down | Jump to the next marked message. |
| `tui.altScreen.top` | Ctrl+Home | Go to the beginning. |
| `tui.altScreen.bottom` | Ctrl+End | Go to the end and follow new output. |
| `tui.altScreen.search` | Ctrl+Shift+F | Search rendered transcript text. |
| `tui.altScreen.searchNext` | Enter / Ctrl+G | Next match **while search is open**. |
| `tui.altScreen.searchPrevious` | Shift+Enter / Ctrl+Shift+G | Previous match **while search is open**. |
| `tui.altScreen.searchClose` | Escape | Close search. |
| `tui.altScreen.halfPageUp` | Unbound | Optional native half-page up. |
| `tui.altScreen.halfPageDown` | Unbound | Optional native half-page down. |
| `tui.altScreen.lineUp` | Unbound | Optional native line up. |
| `tui.altScreen.lineDown` | Unbound | Optional native line down. |

On Windows/WSL, search defaults to Ctrl+F and marked-message jumps use Ctrl+Up/Down without the Ctrl+Shift aliases. Modified keys depend on what your terminal reports. See [Pi's keybinding reference](https://pi.dev/docs/keybindings) for the platform-specific defaults beyond these tables.

**Example:** PageUp to inspect output, Ctrl+Shift+F to find an error, Enter to step through matches, Escape to close search, Ctrl+End to resume following the run. Searching and clearing a view do not compact model context.

Suite additions:

- [pi-vim](/plugins/pi-vim/) uses Ctrl+U/D for half-page transcript scrolling **only in idle Normal mode on the main prompt**. Do not assign those keys globally to native half-page actions; native fullscreen bindings normally precede editor input.
- [pi-clear-screen](/plugins/pi-clear-screen/) clears the view with Ctrl+L **after an explicit model-selector remap**. It leaves history/context and the current draft intact. `/clear` instead starts a fresh conversation while retaining model/effort.
- [pi-sticky-last-prompt](/plugins/pi-sticky-last-prompt/) pins a scrolled-past prompt; clicking it jumps back. It adds no keyboard shortcut.

## Edit, recall and send a prompt

**Owner: stock Pi. Focus: native main editor, or pi-vim in Insert mode unless a modal/chord action owns the input.** Autocomplete and dialogs can change what Enter/Tab mean.

| Action ID | Stock keys | Task |
| --- | --- | --- |
| `tui.editor.cursorUp` | Up | Move up; recall older history at the top of the draft. |
| `tui.editor.cursorDown` | Down | Move down; recall newer history at the bottom. |
| `tui.editor.historyPrevious` | Unbound | Recall history regardless of cursor position, if configured. |
| `tui.editor.historyNext` | Unbound | Recall newer history regardless of cursor position, if configured. |
| `tui.editor.cursorLineStart` | Home / Ctrl+A | Start of line. |
| `tui.editor.cursorLineEnd` | End / Ctrl+E | End of line. |
| `tui.editor.deleteWordBackward` | Ctrl+W / Alt+Backspace | Delete the preceding word. |
| `tui.editor.deleteToLineStart` | Ctrl+U | Delete to line start, **not scroll**. |
| `tui.editor.deleteToLineEnd` | Ctrl+K | Delete to line end, **not list navigation**. |
| `tui.editor.deleteCharForward` | Delete / Ctrl+D | Delete forward; see empty-editor exit below. |
| `tui.editor.yank` | Ctrl+Y | Paste the last deletion from Pi's kill ring. |
| `tui.editor.yankPop` | Alt+Y | Cycle earlier deletions after a yank. |
| `tui.editor.undo` | Ctrl+- | Undo an edit (Windows: Ctrl+Z; WSL: Alt+Z). |
| `tui.input.newLine` | Shift+Enter / Ctrl+J | Insert a newline. |
| `tui.input.submit` | Enter | Send; while running, normally steer. Autocomplete may accept an item first. |
| `tui.input.tab` | Tab | Native completion; select-nav changes main-prompt routing below. |
| `app.message.followUp` | Alt+Enter | Queue a follow-up instead of steering (Windows/WSL: Ctrl+Q). |
| `app.message.dequeue` | Alt+Up | Restore queued messages to the editor (Windows/WSL: Alt+Q). |
| `app.clear` | Ctrl+C | Clear the draft; a second press can exit. |
| `app.exit` | Ctrl+D | Exit **when the main editor is empty**. |
| `app.interrupt` | Escape | Interrupt/cancel when no local editor action consumes it. |
| `app.editor.external` | Ctrl+G | Edit the prompt externally; search owns Ctrl+G while searching. |
| `app.message.copy` | Ctrl+X | Copy a message/selection in the applicable Pi context. |
| `app.tools.expand` | Ctrl+O | Expand/collapse tool output. |
| `app.model.select` | Ctrl+L | Open the model picker; conflicts with suite view clearing. |
| `app.model.cycleForward` | Ctrl+P | Cycle models; dedicated history actions can take precedence. |
| `app.model.cycleBackward` | Ctrl+Shift+P | Cycle models backward (Windows/WSL: Alt+P). |
| `app.thinking.cycle` | Shift+Tab | Cycle effort; conflicts with tool-gate's requested key. |
| `app.thinking.toggle` | Ctrl+T | Expand/collapse thinking blocks; conflicts if todo's `collapseKey` is customized to Ctrl+T. |

Dedicated history actions are unbound in stock Pi. Binding them to Ctrl+P/N is a preference, not a suite default; stock Ctrl+P cycles models. Pi gives configured history actions precedence over application actions on those keys in its main editor. Disable model cycling too if you want an unambiguous setup.

[pi-stash](/plugins/pi-stash/) adds **Ctrl+S** in the focused main editor: stash, restore or swap one draft. This is a raw editor wrapper, not a configurable stock action. A dialog's Ctrl+S remains local—for example, saving a model selection. [pi-copy](/plugins/pi-copy/) adds **Ctrl+Shift+X** (configurable `shortcut`) for `/yank`; Pi's `/copy` stays separate.

## Use Vim on the main prompt or in a dialog

**Owner: [pi-vim](/plugins/pi-vim/).** “Idle Normal” means no count, operator, pending motion, autocomplete or EX line. Normal-mode `gg`/`G` move the **draft cursor**, not the transcript; read-only viewers have their own document motions.

| Task | Main prompt | Embedded suite text field |
| --- | --- | --- |
| Leave Insert/Visual or cancel pending input | Escape or Ctrl+[ is local first. | Same; the host dialog does not close on the first mode change. |
| Escape in idle Normal | Reaches Pi's `app.interrupt`. | Cancels/returns to the host dialog. |
| Half-page with Ctrl+U/D | Scrolls the fullscreen transcript; consumed/inert in regular mode. | Scrolls only the host's offered viewport, otherwise consumed. |
| Ctrl+U/D in Insert | Native text editing; empty Ctrl+D can exit Pi. | Local editing, never Pi process exit. |
| Ctrl+U/D in EX/pending state | Edits EX text or cancels pending keys; does not scroll. | Same local behavior; never invokes `app.exit`. |
| `:name args` / `:!cmd` / `:!!cmd` | Dispatches a known Pi command or shell action, preserving the draft. Reserved Vim EX names are not Pi commands. | Never dispatches to Pi, shell or the model. |
| `:w`, `:wq`, `:x` | Not embedded-submit commands; main EX is the Pi bridge. | Submits locally; Enter also submits according to the host. |
| `:q` / `:q!` | Quit only with an empty draft, or force quit. | Cancel, guarded when text exists unless forced. |

A practical motion starter: `i`/`a` to type; `h j k l`, `w b e`, `0 ^ $` and `gg G` to move; `d`/`c`/`y` plus a motion, `dd`/`cc`/`yy`, `v`/`V`, `p`/`P`, `u`, Ctrl+R and `.` for editing. Counts compose, for example `3w` or `2dd`. See the [local cheatsheet](/plugins/pi-vim/#motion-cheatsheet) and [upstream supported commands at the imported revision](https://github.com/lajarre/pi-vim/blob/e55b07c05b648f3bbccf656c2b0c6ec63f1a91d1/README.md). This is not full Vim: macros, block Visual, Vim search and general Vim EX semantics are not supported.

Current embedded consumers include question answers/notes, diff comments, subagent steering and BTW composition. Without pi-vim, each falls back to its native editor; no consumer requires the provider.

## Open an external editor or find a file

**Suite chords, not new Pi action IDs. Focus: pi-vim's main editor only.** Press the two keys sequentially, not together.

| Task | Keys | Mode / configuration |
| --- | --- | --- |
| Edit the prompt externally | Ctrl+X Ctrl+E | Insert or idle Normal; invokes stock `app.editor.external` even when its direct binding is `[]`. |
| Insert an `@path` | Ctrl+X Ctrl+F | Insert only; opens the file finder. |
| Keep stock Ctrl+X behavior | Ctrl+X, then wait one second | A lone prefix is replayed to Pi; a non-chord next key also replays it. |
| Move in the file finder | Up/Down, Ctrl+P/N or Ctrl+K/J | Picker-local; letters filter. |
| Browse / insert / cancel | Tab / Enter / Escape | Descend into a directory / insert path / cancel. |

Pi chooses its external editor from `externalEditor`, then `$VISUAL`, `$EDITOR`, and a platform fallback (Notepad on Windows, otherwise nano). That is a **Pi setting**, not `piVim`. Embedded dialogs, EX input and pending modal commands never trigger these main-editor chords.

Plain file queries rank fuzzy project and home matches normally. `~/`, `/`, `./` and `../` constrain the search root; directory segments resolve fuzzily, so `~/dl/inv` can browse `~/Downloads`. **Explicit `~/Downloads/` browsing and its descendants list newest MODIFIED first**, not newest-created or best fuzzy score first. Filtering keeps that recency order; general project/home ranking is unchanged. Metadata uses bounded async reads (16 at a time), cached for this picker lifetime; missing/unreadable times sort last and ties sort alphabetically. Close and reopen to refresh cached recency. See [finding files](/plugins/pi-vim/#finding-files) for depth, hidden-file and `fd` fallback behavior.

## Track logical tasks

**Owner: [pi-todo](/plugins/pi-todo/), a suite component, not an external requirement.** Its `todo` tool tracks status and dependencies; `/todos` shows the full non-deleted checklist grouped by status. These are logical tasks, separate from pi-bg's process/session activity in `/tasks`.

| Owner | Suite default | Task / setting |
| --- | --- | --- |
| `pi-todo` | Ctrl+Shift+T | Collapse/expand the live todo widget; `collapseKey` in `pi-todo.json`. |

Stock Pi keeps Ctrl+T for thinking blocks. pi-todo defaults to Ctrl+Shift+T without requiring a personal profile or native remap. Its collapsed widget puts `Todos (done/total)` and the configured expand hint on one content row, followed by a blank spacer. `collapseKey: "off"` disables the shortcut; other valid keys are configurable. If you choose Ctrl+T—or your own native binding occupies Ctrl+Shift+T—move or disable the native action explicitly; **the suite does not override it automatically**. `/reload` rebinds the shortcut.

Global settings live in `~/.pi/agent/pi-todo.json` (`PI_CODING_AGENT_DIR` honored); project `.pi/pi-todo.json` overrides them, with legacy rpiv-todo fallback. `maxWidgetLines` defaults to `12` with a floor of `3`; optional guidance settings remain available. See the [plugin reference](/plugins/pi-todo/#configuration).

## Plan, inspect tasks and review changes

These keys are **local to the named focused surface**, not global shortcuts. No Pi action IDs exist for `x`, `r`, lane commands or review EX commands.

| Task / focus | Controls | Owner / configuration |
| --- | --- | --- |
| Enter plan mode in the main chat | `/plan [task]`; optionally a configured `toggleShortcut` | [pi-plan-mode](/plugins/pi-plan-mode/); no shortcut by default. With gate, the configured key cycles gate modes instead. |
| Choose permission mode at the main prompt | `/mode [mode]`; Shift+Tab **after remapping the stock conflict** | [pi-tool-gate](/plugins/pi-tool-gate/), `cycleShortcut` (default `shift+tab`, empty string disables). |
| Move between planner lanes/actions | Tab / Shift+Tab | `/planners`; not effort/permission cycling inside that screen. |
| Read a planner lane | Ctrl+U/D; Left/Right plan/chat on an empty line; Ctrl+O tool output; Ctrl+T thinking | Planner screen owns these; Ctrl+O and Ctrl+T match stock Pi. Typed input steers that lane. |
| Answer a planner's question | Up/Down or j/k, digits jump, Enter picks; `Type something.` opens the answer line, Esc returns to the options; Left/Right between questions | The question owns the lane's keys until it is answered, also with pi-vim. |
| Hide or stop planning | Escape opens Hide / Stop planning / Back | Hiding keeps the run alive; `/planners` reopens it. |
| Select activity panels from the prompt | Tab after explicit completion/suggestion routing | [pi-select-nav](/plugins/pi-select-nav/) plus an activity host; drafts preserved. Repeated Tab cycles, Enter opens, Escape returns. |
| Inspect a task | `/tasks`, then Enter on a row | [pi-bg](/plugins/pi-bg/) combines shell, subagent, notebook, planner/scout and Herdr-child sources as enabled. |
| Stop a listed running task | `x` twice, only if the owner supports stopping | Owner-specific: process stop, kernel interrupt, planner stop or awaited Herdr-child interrupt. **Never closes a Herdr pane.** |
| Stop all own shell tasks | `/stop` | pi-bg only; not subagents, notebooks, planners or Herdr children. |
| Inspect a subagent | `/subagents [id]`; Enter opens; `b` backgrounds a foreground run | [pi-subagents](/plugins/pi-subagents/); conversation Enter opens steering, `m` cycles Markdown. |
| Review changes | `/diff`; `j/k`, Ctrl+D/U, `gg/G`; `]c/[c` hunks, `]f/[f` files | [pi-diff-review](/plugins/pi-diff-review/); `/` and `n/N` search this diff, not Pi's transcript. |
| Leave feedback / send it | `c` comment, `s` suggestion; `:w` send, `:wq` send/close | An open comment editor owns text keys. |
| Record review progress | `r` checks/folds a file; `:mark` advances the live review mark | `:mark` confirms and stays open. Closing never marks reviewed. `?` shows the full viewer keymap. |

[Background workflows](/recipes/background-work/) explain consuming completed child results with `bg_wait` instead of receiving a second completion. The wait owns the working message above footer statistics until it releases; the task keeps running if you press Escape.

## Use pickers, questions and overlays

| Focus / task | Controls | Owner |
| --- | --- | --- |
| Native selection list | Up/Down, PageUp/PageDown, Enter, Escape or Ctrl+C | Pi's selection actions (listed below). Add Ctrl+K/J via Pi settings if wanted. |
| Eligible unknown picker | Ctrl+J/K, sometimes j/k → down/up | pi-select-nav preserves main/nested editors, search fields and component-owned letter actions. Explicit suite input contexts handle their own bindings. |
| Main-prompt Tab | Explicit `@` or `/` completion → empty-editor next suggestion → activity panel → nothing | select-nav. An already-selected activity panel keeps Tab even if a suggestion arrives. Dialogs/embedded editors keep their own Tab. |
| Next-step ghost text | Tab or Right accepts, typing dismisses | [pi-next-prompt](/plugins/pi-next-prompt/), `acceptKeys`; empty focused editor only, no pending/Visual/EX or autocomplete. Acceptance does not send. |
| `/yank` filter | Ctrl+J/K moves; Tab Suggested/All; Right previews; Enter copies | pi-copy; letters including j/k filter. Escape clears the query first, then closes. Ctrl+U clears query; Ctrl+D deletes forward, not scrolls. |
| Question choices | Arrows or j/k; Enter selects; Space toggles multi-select; Ctrl+G adds a note | [pi-ask-user-question](/plugins/pi-ask-user-question/). On `Type something.`, letters/digits are text. |
| Question tabs / Review | Tab/Shift+Tab or Left/Right; Review Enter submits | Local to the questionnaire. Escape from a text field retains the draft; otherwise declines. |
| BTW focus / width | Alt+/, Super+/ or Ctrl+Alt+W; Alt+W width | [pi-btw](/plugins/pi-btw/); `PI_BTW_FOCUS_KEYS` replaces focus keys. The overlay can stay open with focus back in the main editor. |
| BTW submit / cancel | Enter; Escape aborts streaming, or dismisses when idle | Native empty composer scrolls with Ctrl+U/D; with Vim, only idle Normal does. |
| Read-only log / child viewer | Ctrl+U/D scrolls where supported; Escape returns | Focused viewer, not global. A steering composer instead owns editing keys. |
| Notebook view | j/k scroll, Tab notebook, `o` browser, double-`x` interrupt, Escape/`h` return | [pi-marimo](/plugins/pi-marimo/); interrupt targets the kernel, not its server process. |

Stock selection action IDs, configurable in `keybindings.json`:

| Action ID | Stock keys | Task |
| --- | --- | --- |
| `tui.select.up` | Up | Previous item. |
| `tui.select.down` | Down | Next item. |
| `tui.select.pageUp` | PageUp | Previous page. |
| `tui.select.pageDown` | PageDown | Next page. |
| `tui.select.confirm` | Enter | Confirm the item. |
| `tui.select.cancel` | Escape / Ctrl+C | Cancel the list. |

With [pi-todo](/plugins/pi-todo/) selected, pi-select-nav can forward **Ctrl+Shift+T** (suite default) and **Ctrl+T** (a common configured rebind) from eligible dialogs to registered extension shortcut handlers, consuming the key only when one runs. It does not forward arbitrary custom todo keys, create tasks or remap stock thinking. Text editors keep their editing keys and list-navigation safeguards; forwarding a panel toggle is not permission to rewrite text input.

## Resolve the two stock conflicts

**Current Pi skips a suite shortcut that conflicts with these reserved stock actions. A startup warning is not an automatic override.**

- **Ctrl+L:** move or disable `app.model.select` before clear-screen can register a working shortcut.
- **Shift+Tab:** move or disable `app.thinking.cycle` before tool-gate's default `cycleShortcut` can work. Alternatively change `cycleShortcut` itself. `/mode` works without the key.
- Plan mode alone registers no shortcut. If you set `toggleShortcut` to Shift+Tab, resolve the same thinking conflict. With tool-gate, never also register plan mode on the gate's key.
- **Customized todo key:** pi-todo's Ctrl+Shift+T default has no stock Ctrl+T conflict. If you change `collapseKey` to Ctrl+T, move or disable `app.thinking.toggle` first. A personal native Ctrl+Shift+T binding also requires moving that action or choosing another todo key.

A minimal stock-action remap in `~/.pi/agent/keybindings.json` is:

```json
{
  "app.model.select": "alt+m",
  "app.thinking.cycle": "alt+t"
}
```

Merge, `/reload`, then inspect `/hotkeys` and startup diagnostics. An array replaces that action's defaults; `[]` disables only its direct keys, not the underlying action. Extension-to-extension duplicate shortcuts are a separate collision—keep one owner. Ctrl+J/K list navigation is not a reason to remove their editing meanings from text fields.

## Optional personal profile

**This is a labeled personal configuration, not stock Pi or automatic suite behavior.** It moves model/effort controls, binds dedicated history and reserves Ctrl+G for returning to the transcript tail. The external editor remains available through pi-vim's Ctrl+X Ctrl+E chord when that component is selected. This profile also relocates native thinking and tree no-tools filtering to Ctrl+Shift+T so that a separately configured todo toggle can use Ctrl+T.

```json
{
  "app.model.select": ["alt+p", "alt+m"],
  "app.model.cycleForward": [],
  "app.model.cycleBackward": [],
  "app.thinking.cycle": "alt+t",
  "app.thinking.toggle": "ctrl+shift+t",
  "app.tree.filter.noTools": "ctrl+shift+t",
  "app.tree.filter.labeledOnly": "ctrl+shift+l",
  "app.editor.external": [],
  "tui.altScreen.bottom": ["ctrl+g", "ctrl+end"],
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.select.up": ["up", "ctrl+k"],
  "tui.select.down": ["down", "ctrl+j"]
}
```

### Optional todo rebind

To pair the profile above with pi-todo, merge this into `~/.pi/agent/pi-todo.json` (or project `.pi/pi-todo.json`), preserving `maxWidgetLines`, `guidance` and any unrelated settings:

```json
{
  "collapseKey": "ctrl+t"
}
```

Use both changes together, then `/reload`: **Ctrl+T becomes the personal todo key; Ctrl+Shift+T becomes native thinking, not the todo default.** Applying only the keybindings profile would conflict with pi-todo's default Ctrl+Shift+T. Neither file is installed by the suite, and neither is necessary when you keep stock Pi plus suite defaults.

During transcript search, Ctrl+G still advances matches rather than jumping to the tail; close search first. The profile disables both model-cycle actions, including Windows/WSL's Alt+P conflict. Ctrl+O remains native tool expansion. Ctrl+U/D remain **unbound** as native fullscreen half-page actions; Vim supplies the mode-sensitive route. Alt+T cycles Pi effort, not a guarantee of identical Claude thinking semantics.

Herdr/tmux prefixes are separate and can intercept keys before Pi. A multiplexer shortcut is not an application action ID, and no complete cross-tool keymap mirroring is implied.

## Input precedence and troubleshooting

Use this ownership order to diagnose a key, not a promise that arbitrary extensions cannot intercept it:

1. **Terminal/multiplexer:** only delivered key packets can reach Pi; modified keys may need richer keyboard reporting.
2. **Native fullscreen input:** transcript scroll/search actions normally precede public input listeners. Search owns its match controls while open; overlays/dialogs own their own focus. The suite's narrow Vim adapter protects Ctrl+U/D in marked text editors from native half-page bindings.
3. **Suite raw listeners:** route contextual Tab, suggestions, panel focus or eligible picker movement. Components declare `editor`, `filter`, `list` or `viewer` through `Symbol.for("pi-plugins.input-context.v1")`; select-nav leaves declared list-navigation ownership alone.
4. **Focused component:** local text/modal/picker handlers run. Application/extension shortcuts are normally dispatched from the main prompt editor, not every dialog. Escape is local first; an embedded idle-Normal Escape cancels that dialog, not Pi.

When a key does the wrong thing:

- Check **where focus is** and whether Vim is Insert, idle Normal, Visual, pending or EX. Try arrows and a plain Escape before assuming a global binding failed.
- Run **`/hotkeys`** for effective main-editor/application keys; read startup “Skipping” diagnostics. Local dialog keys need their own help/reference, not `/hotkeys` alone.
- Check the exact **action ID** in `keybindings.json`, or the correct plugin setting (`cycleShortcut`, `toggleShortcut`, `collapseKey`, `shortcut`, `acceptKeys`). Chords have no separate action ID.
- After editing bindings, plugin settings or selection, use **`/reload`**. A private renderer/stdout patch or retained upstream stash may need a full restart for a clean baseline.
- Remove duplicate standalone/upstream copies. For a minimal reproduction, load one component and then add companions back; see [troubleshooting](/guides/troubleshooting/#isolate-a-conflict).

Keep [requirements](/guides/requirements/) and the relevant plugin reference nearby when a feature depends on fullscreen, Git, clipboard support or an optional external tool.
