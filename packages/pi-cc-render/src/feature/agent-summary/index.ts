/**
 * Agent turn summary display: on agent_end, writes this turn's tool stats into a session entry,
 * which the entry renderer renders as a markdown blockquote `> [!TIP] *italic content*`.
 *
 * Stats reuse ./core.ts (bash|powershell/read/edit/write/other).
 * appendEntry does not enter the LLM context; it only appears in the chat area.
 * The blockquote text color takes the theme's mdQuote (muted gray under the cc theme), and the content uses *italic* syntax.
 */

import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindAgentSummary, summaryMarkdown, type AgentSummaryData } from "./core.ts";

export const AGENT_SUMMARY_ENTRY_TYPE = "agent-summary";

export default function (pi: ExtensionAPI): void {
	pi.registerEntryRenderer(AGENT_SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		const line = summaryMarkdown(entry.data as AgentSummaryData, {
			success: theme.getFgAnsi("success"),
			failed: theme.getFgAnsi("error"),
		});
		if (!line) return undefined;
		return new Markdown(line, 1, 0, getMarkdownTheme());
	});

	bindAgentSummary(pi, (data) => {
		pi.appendEntry(AGENT_SUMMARY_ENTRY_TYPE, data);
	});
}
