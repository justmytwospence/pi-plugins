---
title: Switchyard integration
description: Ownership and compatibility boundaries between Pi plugins, optional adapters and Switchyard.
---

Plugins own their replaceable within-session workflows and remain independently usable without Switchyard. An optional adapter lives alongside its plugin and translates plugin-owned semantics into portable UI; it is not a second workflow engine. Switchyard core owns hosts, sessions, workspaces, board tasks, dispatch, synchronization, review, notification delivery, authorization, takeover and policy enforcement.

For example, Pi planning and todo items remain plugin workflows, distinct from Switchyard board tasks. Pi background subprocess jobs and subagent workflows are distinct from host-service lifecycle. An approval UI may be plugin-provided, but core security and policy must not depend exclusively on an optional plugin. Existing core agent and task primitives remain core.

When changing an integration, identify the authoritative state and behavior without the plugin or adapter, preserve a portable fallback, and test relevant compatibility across both repositories. Generalize a primitive only when two independent integrations need it, not a whole workflow.

Switchyard's structured adapter and remote-UI contract is separate from the terminal screen-reading contract used by Ovis and Collie. Passing one does not verify the other. Custom terminal UI is not universally converted. Adapter inspection, safe reload and portable preview depend on the Switchyard version: use its adapter-development capability and documented authoring tools when available, and keep legacy portable panels working when they are not.
