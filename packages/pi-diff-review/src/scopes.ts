/** Diff scopes: which two trees a review compares. */

import { currentBranch, defaultBranch, headTree, indexTree, mergeBase, snapshot, treeExists, treeOf } from "./git.ts";
import type { ReviewMark, Turn } from "./session.ts";

export type ScopeKind = "unreviewed" | "turn" | "session" | "head" | "staged" | "branch" | "ref";

export interface ScopeRequest {
	kind: ScopeKind;
	/** For "turn": 1 is the latest run, 2 the one before, and so on. */
	turn?: number;
	/** For "ref" (any commit-ish) and "branch" (the base branch, default origin/HEAD). */
	ref?: string;
}

export interface ResolvedScope {
	request: ScopeRequest;
	label: string;
	base: string;
	target: string;
	/** The target is the live working tree, so comments refer to the current files. */
	live: boolean;
	turnCount: number;
}

export interface ScopeInputs {
	root: string;
	turns: Turn[];
	mark?: ReviewMark;
}

function shortPrompt(p: string, max = 48): string {
	const one = p.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function relativeTime(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/** The scope /diff opens with: everything unreviewed when the session has history, else uncommitted changes. */
export function defaultScope(inputs: ScopeInputs): ScopeRequest {
	return inputs.turns.length > 0 || inputs.mark ? { kind: "unreviewed" } : { kind: "head" };
}

export function parseScopeArgs(args: string): ScopeRequest | undefined {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return undefined;
	const [w, arg] = words;
	switch (w) {
		case "unreviewed":
		case "new":
			return { kind: "unreviewed" };
		case "turn":
		case "last":
			return { kind: "turn", turn: arg ? Math.max(1, Number.parseInt(arg, 10) || 1) : 1 };
		case "session":
		case "all":
			return { kind: "session" };
		case "head":
		case "uncommitted":
			return { kind: "head" };
		case "staged":
		case "cached":
		case "--cached":
		case "--staged":
			return { kind: "staged" };
		case "branch":
			return { kind: "branch", ref: arg };
		default:
			return { kind: "ref", ref: w };
	}
}

export async function resolveScope(req: ScopeRequest, inputs: ScopeInputs): Promise<ResolvedScope | string> {
	const { root, turns, mark } = inputs;
	const turnCount = turns.length;
	const live = async () => (await snapshot(root)) ?? "";
	const ok = async (base: string | undefined, target: string, label: string, isLive = true) => {
		if (!target) return "could not snapshot the working tree";
		if (!base) return `no base for ${label}`;
		if (!(await treeExists(root, base))) return `the snapshot for ${label} is gone (garbage-collected)`;
		return { request: req, label, base, target, live: isLive, turnCount } satisfies ResolvedScope;
	};

	switch (req.kind) {
		case "unreviewed": {
			if (mark) return ok(mark.tree, await live(), `unreviewed, since your review ${relativeTime(mark.at)}`);
			if (turns.length) return ok(turns[0].pre, await live(), "unreviewed, since the session began");
			return ok(await headTree(root), await live(), "uncommitted vs HEAD");
		}
		case "session": {
			if (!turns.length) return "no turns recorded in this session yet";
			return ok(turns[0].pre, await live(), "everything this session changed");
		}
		case "turn": {
			if (!turns.length) return "no turns recorded in this session yet";
			const n = Math.min(Math.max(1, req.turn ?? 1), turns.length);
			req.turn = n;
			const t = turns[turns.length - n];
			const next = turns[turns.length - n + 1];
			const latest = n === 1;
			const target = latest ? await live() : (t.post ?? next?.pre ?? (await live()));
			const which = latest ? "last turn" : `turn -${n}`;
			return ok(t.pre, target, `${which}: ${shortPrompt(t.prompt)}`, latest || (!t.post && !next));
		}
		case "head":
			return ok(await headTree(root), await live(), "uncommitted vs HEAD");
		case "staged":
			return ok(await headTree(root), (await indexTree(root)) ?? "", "staged vs HEAD", false);
		case "branch": {
			const ref = req.ref ?? (await defaultBranch(root));
			if (!ref) return "no default branch found (origin/HEAD, main or master)";
			const mb = await mergeBase(root, ref);
			if (!mb) return `no merge base with ${ref}`;
			const name = (await currentBranch(root)) ?? "HEAD";
			return ok(await treeOf(root, mb), await live(), `${name} vs ${ref}`);
		}
		case "ref": {
			const ref = req.ref ?? "HEAD";
			const tree = await treeOf(root, ref);
			if (!tree) return `unknown revision: ${ref}`;
			return ok(tree, await live(), `working tree vs ${ref}`);
		}
	}
}
