/**
 * Single source of truth for ccstyle patch ownership and cross-module coordination keys.
 *
 * All use Symbol.for (global registry): after /reload the new module instance gets the same symbol,
 * which is key to recognizing/yielding patch ownership across reloads. Never change these Symbol.for into module-local Symbols.
 *
 * Two uses:
 * 1. globalThis slots: on install write host[KEY] = patch; on dispose restore based on ownership.
 * 2. Instance/function markers: tag a patch wrapper or component instance with a symbol property so other modules can recognize it.
 *
 * PatchRegistry funnels category 1 reads/writes into an install/dispose lifecycle with ownership semantics;
 * underneath it is still globalThis[symbol], so external code (including tests) reading the globalThis slot directly is unaffected.
 */

// ── compact / compact-thinking coordination ──
export const COMPACT_MODE_PATCH_KEY = Symbol.for("pi.ccstyle.compact-mode-patch");
export const COMPACT_THINKING_PATCH_KEY = Symbol.for("pi.ccstyle.compact-thinking-update");
export const PROTOTYPE_ORIGINAL_KEY = Symbol.for("pi.ccstyle.prototype-original");
export const COMPACT_THINKING_OWNER = Symbol.for("pi.ccstyle.compact-thinking-owner");

// ── assistant expanded state (instance marker) ──
export const ASSISTANT_SET_EXPANDED_KEY = Symbol.for("pi.ccstyle.compact-assistant-set-expanded");
export const ASSISTANT_TOGGLE_ROUND_KEY = Symbol.for("pi.ccstyle.compact-assistant-toggle-round");
export const ASSISTANT_REENTRY_KEY = Symbol.for("pi.ccstyle.compact-assistant-reentry");
/** An assistant component's `app.tools.expand` state (Ctrl+O), set through its prototype `setExpanded`. */
export const ASSISTANT_TOOLS_EXPANDED_KEY = Symbol.for("pi.ccstyle.assistant-tools-expanded");

// ── tool rendering patch ──
export const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("pi.ccstyle.global-tool-render-patch");
export const COMPONENT_TOOL_RENDER_MODE = Symbol.for("pi.ccstyle.component-tool-render-mode");
export const TOOL_EXPANDED_BACKGROUND_PATCH = Symbol.for(
	"pi.ccstyle.tool-expanded-background-patch",
);
// write ownership: confirmed once at registration; rendering uses it to decide whether to provide rich diff.
export const WRITE_OWNERSHIP_SLOT = Symbol.for("pi.ccstyle.write-ownership");

// ── message component patch ──
export const MESSAGE_DISPLAY_PATCH = Symbol.for("pi.ccstyle.message-display-patch");

// ── tool grouping ──
export const TOOL_GROUPING_PATCH_KEY = Symbol.for("pi.ccstyle.tool-grouping-patch");
export const TOOL_GROUPING_PARENT_KEY = Symbol.for("pi.ccstyle.tool-grouping-parent");
export const TOOL_GROUPING_GENERATION_KEY = Symbol.for("pi.ccstyle.tool-grouping-generation");

// ── regular main-screen rendering patch ──
export const MAIN_SCREEN_DO_RENDER_PATCH = Symbol.for("pi.ccstyle.main-screen-do-render-patch");

// ── mouse interaction ──
export const TOOL_MOUSE_OWNER_KEY = Symbol.for("pi.ccstyle.tool-mouse-owner");
export const TOOL_MOUSE_TUI_SLOT = Symbol.for("pi.ccstyle.tool-mouse-tui");
export const SCROLL_BUTTON_STATE_SLOT = Symbol.for("pi.ccstyle.scroll-button-state");
export const OFFICIAL_SCROLL_TO_END_KEY = Symbol.for("pi.ccstyle.official-scroll-to-end");
export const FLUSH_DOCKED_BASH_PATCH = Symbol.for("pi.ccstyle.flush-docked-bash-patch");
export const EARLY_STARTUP_HEADER_PATCH = Symbol.for("pi.ccstyle.early-startup-header-patch");
export const EARLY_STARTUP_HEADER_SWAP_KEY = Symbol.for("pi.ccstyle.early-startup-header-swap");
export const TOOL_HOVER_STATE_KEY = Symbol.for("pi.ccstyle.tool-hover-state");

// ── rich diff component marker ──
export const RICH_DIFF_COMPONENT = Symbol.for("pi.ccstyle.rich-diff-component");

// ── PatchRegistry: unified ownership lifecycle ──

/**
 * Read/write accessor for patch slots on the host. Funnels the scattered
 * `host[KEY] = patch` / `if (host[KEY] === patch) delete host[KEY]` into
 * an install/dispose lifecycle with ownership semantics:
 *
 * - install: overwrite and return the replaced old value (does not deactivate the old value automatically; some installers
 *   need to read the old patch first to chain downstream methods, so the caller decides how to inactivate).
 * - dispose: ownership-guarded delete - delete only if the slot is still === the value, preventing an old module
 *   from wrongly deleting the new module's patch after /reload.
 * - owns: whether the slot is still held by a value (identity comparison).
 * - ensure: lazy state slot (??= semantics), for unowned cross-module shared state.
 */
export class PatchRegistry {
	readonly host: Record<PropertyKey, unknown>;

	constructor(
		host: Record<PropertyKey, unknown> = globalThis as unknown as Record<PropertyKey, unknown>,
	) {
		this.host = host;
	}

	/** Reads the slot's current value. */
	get<T = unknown>(key: symbol): T | undefined {
		return this.host[key] as T | undefined;
	}

	/** Whether it is still held by value (identity comparison). */
	owns(key: symbol, value: unknown): boolean {
		return this.host[key] === value;
	}

	/** Overwrites and returns the replaced old value; does not deactivate the old value automatically. */
	install<T = unknown>(key: symbol, value: T): T | undefined {
		const previous = this.host[key] as T | undefined;
		this.host[key] = value;
		return previous;
	}

	/** Ownership-guarded delete: delete only if the slot is still === value. Returns whether it was deleted. */
	dispose(key: symbol, value: unknown): boolean {
		if (!this.owns(key, value)) return false;
		delete this.host[key];
		return true;
	}

	/** Lazy slot: when there is no value (null/undefined), initialize with init() and cache. */
	ensure<T>(key: symbol, init: () => T): T {
		const current = this.host[key];
		if (current !== null && current !== undefined) return current as T;
		const value = init();
		this.host[key] = value;
		return value;
	}

	/** Unconditionally deletes the slot (ownership not checked). Returns whether a key was actually deleted. */
	delete(key: symbol): boolean {
		if (!(key in this.host)) return false;
		delete this.host[key];
		return true;
	}
}

/** Global singleton: host is fixed to globalThis, stable across /reload and jiti reloads. */
export const patchRegistry = new PatchRegistry();
