import { createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	renderEditDiffResult,
	renderWriteDiffResult,
	type DisplayConfigInput,
} from "./diff-renderer.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../../../config/config.ts";
import { patchRegistry, WRITE_OWNERSHIP_SLOT } from "../../../utils/patch-keys.ts";
import { executeWriteWithMetadata, WriteExecutionMetadataStore } from "./write-execution.ts";

function resultText(result: any): string {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	return blocks
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function unavailableComponent(reason: string, theme: any) {
	return {
		render(width: number): string[] {
			return [
				truncateToWidth(
					theme.fg("warning", `↳ diff unavailable: ${reason}`),
					Math.max(0, width),
					"",
				),
			];
		},
		invalidate() {},
	};
}

export function renderRichToolResult(
	toolName: string,
	result: any,
	options: any,
	theme: any,
	context: any,
	writeMetadata: WriteExecutionMetadataStore,
	/** Plain snapshot or live getter — getter lets /ccstyle panel changes repaint existing diffs. */
	displayConfig: DisplayConfigInput = DEFAULT_TOOL_DISPLAY_CONFIG,
): any | undefined {
	if (options?.isPartial || options?.isError || context?.isError) return undefined;
	const expanded = options?.expanded === true || context?.expanded === true;
	const filePath = context?.args?.file_path ?? context?.args?.path;
	if (toolName === "edit") {
		return renderEditDiffResult(
			result?.details,
			{
				expanded,
				filePath,
				isHovered: options?.isHovered,
				invalidate: () => context?.invalidate?.(),
			},
			displayConfig,
			theme,
			resultText(result),
		);
	}
	if (toolName !== "write") return undefined;
	// Yield: when another extension owns write, provide no rich diff and hand back to the plain result row.
	if (!ownsWriteTool()) return undefined;

	const metadata = writeMetadata.get(context?.toolCallId);
	if (!metadata) {
		return unavailableComponent("execution metadata is unavailable", theme);
	}
	if (metadata.diffUnavailableReason) {
		return unavailableComponent(metadata.diffUnavailableReason, theme);
	}
	return renderWriteDiffResult(
		typeof context?.args?.content === "string" ? context.args.content : undefined,
		{
			expanded,
			filePath,
			previousContent: metadata.previousContent,
			fileExistedBeforeWrite: metadata.fileExistedBeforeWrite,
			isHovered: options?.isHovered,
			invalidate: () => context?.invalidate?.(),
		},
		displayConfig,
		theme,
		resultText(result),
	);
}

/** Source when write is taken by another extension, used to report the conflict. */
export type ExternalWriteOwner = { source: string; path: string };

type WriteOwnershipState = {
	/** Whether write is executed by this plugin; undefined means not yet confirmed, treated as owned to keep existing behavior. */
	owned?: boolean;
};

function writeOwnership(): WriteOwnershipState {
	return patchRegistry.ensure<WriteOwnershipState>(WRITE_OWNERSHIP_SLOT, () => ({}));
}

/**
 * Whether write is executed by this plugin. Execution metadata exists only if a write override was registered;
 * otherwise the rendering layer must defer to the plain result row, so every card doesn't degrade to "diff unavailable".
 */
export function ownsWriteTool(): boolean {
	return writeOwnership().owned !== false;
}

/** The other extension currently owning write; undefined for builtin or when not registered. */
function findExternalWriteOwner(pi: ExtensionAPI): ExternalWriteOwner | undefined {
	try {
		const tools = pi.getAllTools() as any[];
		const write = tools?.find((tool: any) => tool?.name === "write") as any;
		const sourceInfo = write?.sourceInfo;
		const source = sourceInfo?.source;
		if (!write || typeof source !== "string" || source === "builtin") return undefined;
		return { source, path: typeof sourceInfo?.path === "string" ? sourceInfo.path : "" };
	} catch {
		// getAllTools is unavailable before the extension runtime is bound.
		return undefined;
	}
}

export function installWriteOverride(
	pi: ExtensionAPI,
	store = new WriteExecutionMetadataStore(),
	/** Called once when write is already taken by another extension, so the caller can report the conflict. */
	onExternalOwner?: (owner: ExternalWriteOwner) => void,
): WriteExecutionMetadataStore {
	if (typeof (pi as any).registerTool !== "function") return store;
	const state = writeOwnership();
	const external = findExternalWriteOwner(pi);
	if (external) {
		// Yield: execution and diff both belong to the other extension; the rendering layer uses owned=false to take the plain result row.
		state.owned = false;
		onExternalOwner?.(external);
		return store;
	}
	state.owned = true;
	const nativeWrite = createWriteToolDefinition(process.cwd()) as any;
	pi.registerTool({
		...nativeWrite,
		async execute(
			toolCallId: string,
			params: { path: string; content: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd: string },
		) {
			return executeWriteWithMetadata(store, toolCallId, params, signal, ctx.cwd);
		},
	});
	return store;
}

export {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type ToolDisplayConfig,
	type DiffViewMode,
	type DiffIndicatorMode,
} from "../../../config/config.ts";
export type { DisplayConfigInput } from "./diff-renderer.ts";
export { WriteExecutionMetadataStore } from "./write-execution.ts";
