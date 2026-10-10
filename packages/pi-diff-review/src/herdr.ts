/**
 * herdr integration through pi-herdr's event-bus bridge: zoom pi's pane while reviewing, and open
 * files in a split beside it. Without pi-herdr (or outside herdr) nothing listens: the review just
 * does not zoom, and `o` says what it needs.
 */

interface EventBus {
	emit(channel: string, data: unknown): void;
}

/** Whether pi-herdr is active in this session (it answers the probe synchronously). */
export function herdrActive(events: EventBus): boolean {
	let active = false;
	events.emit("herdr:probe", { reply: () => (active = true) });
	return active;
}

/** Zoom the pane for the duration of `action` (pi-herdr restores it, unless it was already zoomed). */
export async function withZoom<T>(events: EventBus, enabled: boolean, action: () => Promise<T>): Promise<T> {
	if (!enabled) return action();
	events.emit("herdr:zoom", { active: true });
	try {
		return await action();
	} finally {
		events.emit("herdr:zoom", { active: false });
	}
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Open a file in $EDITOR in a herdr split beside pi's pane. */
export function openInSplit(events: EventBus, root: string, file: string, line: number | undefined): Promise<string> {
	if (!herdrActive(events)) return Promise.resolve("o needs herdr and pi-herdr (open the file yourself; y copies path:line)");
	const editor = process.env.VISUAL || process.env.EDITOR || "vi";
	const command = `${editor} ${line ? `+${line} ` : ""}${shellQuote(file)}`;
	return new Promise((resolve) => {
		events.emit("herdr:split", {
			command,
			cwd: root,
			done: (ok: boolean, message: string) =>
				resolve(ok ? `opened ${file}${line ? `:${line}` : ""} beside pi (the zoom is lifted while you edit)` : message),
		});
	});
}
