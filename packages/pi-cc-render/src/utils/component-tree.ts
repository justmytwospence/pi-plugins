/**
 * Shared implementation of recursive component tree traversal.
 *
 * Consolidates the same "children + getMountedRoots + seen cycle guard" traversal previously scattered across renderer's compact-mode / message-display / transcript-refresh /
 * grouping / mouse/packets.
 *
 * The visitor is called once per non-array object node; returning `false` means do not descend into the node's
 * children and mounted roots (matching the early-return semantics at each original site).
 */
export function walkComponentTree(root: any, visitor: (value: any) => boolean | void): void {
	const seen = new Set<any>();
	const visit = (value: any): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		if (visitor(value) === false) return;
		const children = value.children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
		try {
			const mounted = value.getMountedRoots?.();
			if (Array.isArray(mounted)) {
				for (const root of mounted) visit(root);
			}
		} catch {
			// A lazy Proxy during a renderer switch may temporarily have no mounted roots.
		}
	};
	visit(root);
}
