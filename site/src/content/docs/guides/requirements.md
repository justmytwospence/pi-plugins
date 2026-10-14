---
title: Requirements & costs
description: Distinguish local Pi features from paid classifier requests, model sessions and external tools.
---
## The site and the plugins are separate

This is a static Astro/Starlight site. Reading it, searching it and building it require **no model credentials and no backend service**. Search uses a build-time Pagefind index served with the site. Fonts are bundled locally; the site does not load remote font services.

Installing a Pi extension is different: it runs code inside your agent process. A shell task can run whatever command you give it, and a planner or subagent can consume your configured model access.

The configured SDK test target is **Pi 1.2.0**, covering loader selection, local session lifecycle and memory TUI input—not a live PTY compatibility matrix. Classifier-dependent components generally require Pi 0.99 or later; next-prompt requires Pi 1.0 or later. Private terminal hooks can change independently of those minimums.

## What needs something else?

| Component or feature | Requirement and boundary |
| --- | --- |
| Logical todos | No external executable, classifier, credentials or required sibling. pi-todo stores snapshots in session tool results; task text reaches the model and session history. UI needs an interactive session; rpiv-i18n is optional and rpiv-config is not required. |
| Background jobs | A shell environment with `bash`; commands may need their own tools or credentials. Process groups are used for stopping work. |
| Subagents | A runnable `pi` command and usable model/provider configuration. Child sessions make model calls. |
| Subagent worktrees | Git and a suitable repository, only when `worktree: true` is requested. Subagents use `git worktree add` directly; no external worktree helper is required. |
| Plan mode | Credentials or subscription access for the selected planner and helper models. The `/planners` workflow runs two planner sessions, each with separate usage; main-session plan mode does not start them. Optional tools bring their own requirements. |
| Diff review and rewind | A Git repository. Snapshots include non-ignored untracked files and are not a backup service. |
| Herdr integration | An interactive Pi in Herdr. Herdr’s own Pi integration owns working/blocked/idle state. PR metadata also needs an authenticated `gh` command. |
| Herdr worktree children | Git plus the active Herdr socket's worktree create/open operations. No external worktree CLI; normal child tabs share the existing checkout. |
| Notebook observation | A running marimo server with the registry/session/SSE interfaces the extension uses. Token-protected servers need `MARIMO_TOKEN`. Editing is a separate marimo-pair workflow. |
| Status footer | Optional provider quota sources; its row icons are Nerd Font glyphs that need terminal font support. Basic session rows do not require a Claude Code account. |
| Clipboard picker | Pi’s clipboard support in your terminal environment. Optional Jev ranking. |
| CC render | `@shikijs/cli` is an optional dependency of the component but a regular dependency of the root suite; it supplies diff syntax highlighting; hover, click and wheel need fullscreen mode and SGR mouse reporting. Patches private Pi rendering members. |
| Markdown extras | `grok-mermaid` (a suite dependency) for diagrams; without it diagram fences pass through unchanged. |
| Terminal refinements | Relevant TUI hooks and terminal behavior; clear-screen needs fullscreen mode, scrollbar-width only acts inside Herdr. |

The documentation does **not** assert a Windows compatibility matrix for the whole collection. Several components use POSIX shell/process behavior. Check each component’s implementation before adopting it in a different environment.

## Classifier features are optional, not free

[Jev](https://docs.typesafe.ai) is a classifier model accessed through Pi’s model registry. When enabled and available it receives the data needed for the judgment; requests can be billed by the configured provider.

| Plugin | What the classifier sees | Without it |
| --- | --- | --- |
| [Auto effort](/plugins/pi-auto-effort/) | Requests and recent run activity | Keeps the thinking level |
| [Cache guard](/plugins/pi-cache-guard/) | Tool output or conversation items being trimmed/compacted | Warnings and clock still work; normal Pi compaction remains available |
| [Tool gate](/plugins/pi-tool-gate/) | Proposed calls, recent user intent and rules | Uses a tool-hint/UI fallback; not equivalent protection |
| [Subagents](/plugins/pi-subagents/) | Delegation task and candidate choices | Uses agent configuration and parent/default choices |
| [Copy picker](/plugins/pi-copy/) | Candidate excerpts and recent messages | Recency ordering |
| [Next prompt](/plugins/pi-next-prompt/) | Suggested next step and answer | Can show the suggestion without vetting |
| [Plan mode](/plugins/pi-plan-mode/) | Planning task and available tools | You can select tools manually |

For most plugins, `"jev": { "enabled": false }` in the plugin’s own configuration disables classifier use. Plan mode uses `"jevToolSelection": false`. **There is no suite-wide Jev switch.** See the reference pages for filenames and merge precedence.

The default TypeSafe provider uses Pi’s credentials, such as `TYPESAFE_API_KEY` or `/login typesafe`. Do not put credentials in these docs, a public repository, or a front-end environment variable. Cache guard supports additional provider choices; that does not imply identical fallback discovery in every component.

:::caution[Tool gate is not a security boundary]
Classifier judgments are probabilistic. In particular, when Jev is unavailable and there is no UI, the fallback allows calls that would otherwise need a UI decision. Do not use this gate as your only control over untrusted programs or secrets.
:::

## Read the right number

Footer cost is a reported token-price estimate, not an invoice or a subscription charge. Cache guard uses published model prices where available and an idle-time heuristic where a cache TTL is unknown. Jev latency and savings depend on the workload and provider; benchmark anecdotes are not performance guarantees.

Quota lookup can make authenticated HTTP requests without making a model call. The status footer’s Claude account reading may belong to a different account from Pi’s model session. [Manage context and cost](/recipes/cache-cost/) explains the distinctions.
