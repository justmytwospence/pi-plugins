// Optional contract with pi-sticky-last-prompt (channel pi-plugins.user-words.v1): plugins whose
// tool results carry the user's own words (an ask_user_question answer, plan feedback) register
// the tool names. Those rows stay out of tool groups, where the words would be folded into a
// one-line summary. Copied structurally, with no import; without providers nothing changes.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addUserWordTool, clearUserWordTools } from "./renderer/tool/grouping.ts";

export const USER_WORDS_CHANNEL = "pi-plugins.user-words.v1";

export interface UserWordsRequest {
	version: 1;
	register?: (toolName: string, extract: unknown) => void;
}

/**
 * On each session start, ask the providers which tools carry user words. `"*"` (any tool) names
 * no tool, so it changes nothing here; pi-sticky-last-prompt still finds those rows inside groups.
 */
export function keepUserWordToolsUngrouped(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		clearUserWordTools();
		const request: UserWordsRequest = {
			version: 1,
			register: (toolName) => {
				if (typeof toolName === "string" && toolName !== "*") addUserWordTool(toolName);
			},
		};
		try {
			pi.events?.emit?.(USER_WORDS_CHANNEL, request);
		} catch {
			// A provider that throws only loses its own tool.
		}
	});
}
