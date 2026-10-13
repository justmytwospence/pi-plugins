---
title: Standalone & compatibility
description: Select one component, understand its native fallbacks, and test it without sibling packages.
---

## One feature, one entry

The suite contains 26 independently selectable extensions. They share a Git revision, not runtime dependencies. Install the suite and choose entries with `pi config`, or use an [explicit resource selection](/guides/install/#enable-an-explicit-subset).

From a local checkout, Pi can load a component's own package manifest:

```sh
pi -e ./packages/pi-ask-user-question
```

That does not disable your other installed extensions. For an isolated invocation, use an empty temporary agent directory, disable discovery, and load only the component you are testing:

```sh
PI_CODING_AGENT_DIR="$(mktemp -d)" pi --offline --no-extensions --no-skills \
  --no-prompt-templates --no-context-files --no-mcp \
  -e ./packages/pi-ask-user-question
```

This example is for input and startup checks without credentials. A model-driven feature still needs its own model or classifier configuration. Do not copy credentials into a public reproduction.

## Optional composition

| Feature | With optional siblings | Without them |
| --- | --- | --- |
| Questions, comments and steering | The optional editor-factory protocol provides embedded Vim editors | Native Pi text editors |
| Prompt stash | An editor snapshot preserves cursor, mode and in-process history where supported | Text-only snapshots; no promised attachment support |
| Planner, Herdr and notebook activity | Existing FleetView or background activity hosts aggregate their entries | Each producer keeps its own UI/status and commands |
| `/tasks` | pi-bg aggregates registered activity sections | Only pi-bg provides the command; producers never require it |
| `/stop` | Stops eligible shell work owned by pi-bg | Still shell-only; it is not an all-activity kill command |
| Rewind and diff review | The diff viewer can display checkpoint comparisons | Rewind recovery works independently |
| Next-prompt | Owned Vim acceptance enters Insert mode at the end | Native text insertion; never submission |

Logical todos are separate from process activity. Retained external packages are described in [External integrations](/guides/external/).

## Input and mode ownership

A package-local structural protocol declares `editor`, `filter`, `list` or `viewer` focus. The optional editor factory is discovered synchronously over Pi's event bus; consumers do not import another component's runtime code. An unanswered request selects the native editor.

Embedded editors use local submit/cancel callbacks. Their EX commands cannot shut down the parent Pi session or dispatch its shell commands. Main and embedded editors are different surfaces even when they share an editing engine. See [Keyboard & focus](/guides/keyboard/).

## Compatibility boundaries

The development and loader baseline is **Pi 1.1.0**. Host SDK packages are `*` peers, following Pi's package convention; that is not a claim that every older or future SDK works. Every component includes its own manifest, license, development dependencies and checks.

Some visual features inspect private host layout or rendering APIs. Missing APIs produce a diagnostic or native/degraded behavior rather than making an optional feature a dependency. Fullscreen transcript clearing and mode-aware transcript scrolling need an application-owned viewport. Regular mode leaves scrollback to the terminal.

RPC supports native dialogs but not custom terminal screens. Print and JSON mode retain applicable tools and lifecycle behavior without terminal-only listeners. Optional classifier access, account credentials, sockets and external services remain optional unless a particular feature explicitly requires them.

Never load two implementations of an absorbed component simultaneously. Disable the old npm entry before selecting its suite replacement, keep old configuration/session data, and retain the previous package selection for rollback.

## Verification

The root checks derive their component inventory from `package.json`, not initial import provenance. They compare selected, standalone and isolated package registrations; check actual Pi shortcut resolution, helper parity and runtime independence; and run each component's checks. These are not substitutes for interactive focus, terminal and lifecycle acceptance. See [Development](/development/).
