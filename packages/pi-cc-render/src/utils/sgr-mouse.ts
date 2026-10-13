/**
 * SGR mouse protocol parsing (shared).
 *
 * Consolidates the single-packet parsing of feature/_util.ts and the batch parsing of renderer/mouse/packets.ts.
 */

/** SGR mouse protocol packet (code;col;row + M/m terminator). */
export type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

/** Parses a single complete SGR mouse packet (the whole data must be exactly one packet). */
export function parseSgrMousePacket(data: string): SgrMousePacket | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	return {
		code: Number(match[1]),
		col: Number(match[2]),
		row: Number(match[3]),
		final: match[4] as "M" | "m",
	};
}

/**
 * Parses an entire terminal input into a sequence of SGR mouse packets; the data must consist entirely of consecutive SGR packets
 * (returns null if other bytes are mixed in, leaving it to the regular input chain).
 */
export function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
	const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
	const packets: SgrMousePacket[] = [];
	let offset = 0;

	for (const match of data.matchAll(pattern)) {
		if (match.index !== offset) return null;
		offset = match.index + match[0].length;
		packets.push({
			code: Number(match[1]),
			col: Number(match[2]),
			row: Number(match[3]),
			final: match[4] as "M" | "m",
		});
	}

	return packets.length > 0 && offset === data.length ? packets : null;
}

/** Whether it is a left-button press (modifier keys excluded; 32 denotes a motion event). */
export function isSgrLeftPress(packet: SgrMousePacket): boolean {
	const baseButton = mouseBaseButton(packet.code);
	return packet.final === "M" && baseButton === 0 && (packet.code & 32) === 0;
}

/** Whether it is a left-button release. */
export function isSgrLeftRelease(packet: SgrMousePacket): boolean {
	const baseButton = mouseBaseButton(packet.code);
	return packet.final === "m" && baseButton === 0 && (packet.code & 32) === 0;
}

/** Pointer movement with no button held (35 in DECSET 1003). A left-button drag (32, text selection) is not hover. */
export function isSgrIdleMotion(packet: SgrMousePacket): boolean {
	return packet.final === "M" && (packet.code & 32) !== 0 && mouseBaseButton(packet.code) === 3;
}

/** Strips modifier bits (4/8/16/32: shift/meta/ctrl/motion) to get the base button code. */
export function mouseBaseButton(code: number): number {
	return code & ~(4 | 8 | 16 | 32);
}
