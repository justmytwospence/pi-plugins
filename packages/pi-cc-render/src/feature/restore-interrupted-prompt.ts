/**
 * Restore an interrupted prompt, as Claude Code does: pressing Escape before the model has
 * streamed anything puts the prompt that started the run back into the editor. Once any
 * assistant output (text, thinking or a tool call) has streamed, Escape only interrupts.
 *
 * Only prompts typed in the interactive editor count; steering and follow-up messages sent
 * while a run is streaming are already returned to the editor by Pi itself on abort. The
 * restored prompt goes before whatever the editor then holds (Pi's restored queue or a draft
 * typed during the run), separated by a blank line, the same way Pi combines restored text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function restoreInterruptedPrompt(pi: ExtensionAPI): void {
	let typed: string | undefined; // last idle prompt from the editor, until its run starts
	let prompt: string | undefined; // the prompt that started the current run
	let responded = false;

	pi.on("input", (event) => {
		typed = event.source === "interactive" && event.streamingBehavior === undefined && event.text.trim()
			? event.text
			: undefined;
		return undefined;
	});

	pi.on("before_agent_start", (event) => {
		prompt = event.messageType === "user" ? typed : undefined;
		typed = undefined;
		responded = false;
		return undefined;
	});

	pi.on("message_update", (event) => {
		if ((event.message as { role?: string }).role === "assistant") responded = true;
	});

	pi.on("agent_settled", (event, ctx: ExtensionContext) => {
		const text = prompt;
		prompt = undefined;
		if (!event.aborted || responded || !text || ctx.mode !== "tui" || !ctx.hasUI) return;
		const current = ctx.ui.getEditorText();
		ctx.ui.setEditorText([text, current].filter((part) => part.trim()).join("\n\n"));
	});
}
