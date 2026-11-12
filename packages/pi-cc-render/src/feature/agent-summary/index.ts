/**
 * Agent turn summary display: on agent_end, writes this turn's tool stats into a session entry,
 * which the entry renderer draws as a one-line row (tone by failures) with the end time right-aligned.
 *
 * Stats reuse ./core.ts (bash|powershell/read/edit/write/other).
 * appendEntry does not enter the LLM context; it only appears in the chat area.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Row } from "../../transcript-style.ts";
import { bindAgentSummary, summaryText, type AgentSummaryData } from "./core.ts";

export const AGENT_SUMMARY_ENTRY_TYPE = "agent-summary";

export default function (pi: ExtensionAPI): void {
	pi.registerEntryRenderer(AGENT_SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as AgentSummaryData;
		const text = summaryText(data);
		if (!text) return undefined;
		return new Row(theme, () => ({
			tone: data.failed ? "failed" : "done",
			title: text.title,
			titleColor: "muted",
			detail: text.detail,
			time: entry.timestamp,
		}));
	});

	bindAgentSummary(pi, (data) => {
		pi.appendEntry(AGENT_SUMMARY_ENTRY_TYPE, data);
	});
}
