import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";

// shell
import { installBashHighlight } from "./feature/shell/bash-highlight.ts";
import { installFlushDockedBash } from "./feature/shell/flush-docked-bash.ts";
import piStartupHeader, { installEarlyStartupHeader } from "./feature/shell/startup-header.ts";

// features
import agentSummary from "./feature/agent-summary/index.ts";
import { installCompactThinking } from "./feature/compact-thinking.ts";
import restoreInterruptedPrompt from "./feature/restore-interrupted-prompt.ts";
import { keepUserWordToolsUngrouped } from "./user-words.ts";

// renderer
import claudeCodeStyle, { getCompactThinkingConfig } from "./renderer/index.ts";

/**
 * pi-cc-render: Claude Code-style transcript rendering for Pi.
 *
 * Ported from pi-cc-extensions (MIT, minuque). This suite component carries the
 * renderer, rich diffs, mouse interaction, compact thinking, agent summary and the
 * startup header. The footer, /context, session references, aliases, working
 * message and Markdown enhancements are intentionally not included here.
 */
export default function (pi: ExtensionAPI): void {
	// shell chrome
	installFlushDockedBash();
	installBashHighlight();
	installEarlyStartupHeader();
	piStartupHeader(pi);

	// dialog tools stay out of tool groups (registered before the render stack's own session_start)
	keepUserWordToolsUngrouped(pi);

	// render stack: the thinking controller is handed to the style layer as a query
	claudeCodeStyle(pi, undefined, installCompactThinking(pi, getCompactThinkingConfig()));

	// features
	if (config.enableAgentSummary) agentSummary(pi);
	if (config.restoreInterruptedPrompt) restoreInterruptedPrompt(pi);
}

export { CONFIG_PATH, config, DEFAULT_CONFIG, normalizeConfig } from "./config/config.ts";
