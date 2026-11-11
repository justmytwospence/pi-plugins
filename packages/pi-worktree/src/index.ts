// /worktree and the `worktree` tool: one git worktree per task under <repo>/.worktrees/<branch>, with
// this conversation carried into it. A move forks the session into a file whose header points at the
// worktree; where that session then runs is a placement provider's call (pi-herdr opens a pane in
// the worktree's Herdr space and closes this one; a Switchyard adapter can answer the same
// contract), and with no provider an interactive Pi switches the session in place.
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  addWorktree,
  defaultBase,
  fetchOrigin,
  isClean,
  isManaged,
  isMerged,
  listWorktrees,
  nodeRun,
  notMergedText,
  real,
  removeWorktree,
  validBranch,
  verifyRef,
  type Run,
  type Worktree,
} from "./git.ts";
import { HOLD_CHANNELS, Holds } from "./holds.ts";
import { place, type PlaceResult } from "./place-contract.ts";
import { declareReadOnlyCalls } from "./read-only-call.ts";
import { latestSession, sessionDirFor, sessionInto, writeEmptySession, type CurrentSession } from "./sessions.ts";

const TOOL = "worktree";
const COMMAND = "worktree";
const CONTINUE_COMMAND = "worktree-continue";
const MOVED_ENTRY = "pi-worktree:moved";

export const SUBCOMMANDS = [
  { value: "new", label: "new <branch> [--base <ref>] [--fresh] -- create .worktrees/<branch> and continue this conversation there" },
  { value: "move", label: "move <branch> -- continue this conversation in an existing worktree" },
  { value: "open", label: "open <branch> -- show an existing worktree's latest session" },
  { value: "done", label: "done [--force] -- leave a worktree merged into origin's default branch (or by pull request) and remove it" },
  { value: "ls", label: "ls -- list this repository's worktrees" },
];

const findByName = (list: Worktree[], name: string) =>
  list.slice(1).find((w) => w.branch === name || basename(w.path) === name);

export async function completions(prefix: string, cwd: string = process.cwd(), run: Run = nodeRun) {
  const text = prefix.trimStart();
  const m = /^(\S+)\s+(\S*)$/.exec(text);
  if (!m) {
    const hits = SUBCOMMANDS.filter((s) => s.value.startsWith(text));
    return hits.length ? hits : null;
  }
  const [, sub, arg] = m;
  if (!["move", "open"].includes(sub)) return null;
  const hits = ((await listWorktrees(run, cwd)) ?? [])
    .slice(1)
    .flatMap((w) => (w.branch?.startsWith(arg) ? [{ value: `${sub} ${w.branch}`, label: w.branch }] : []));
  return hits.length ? hits : null;
}

const continuation = (from: string, path: string, branch: string | undefined) =>
  `[pi-worktree] This conversation moved from ${from} into the worktree ${path} (branch ${branch}). Your working directory is now ${path}. Continue the task here.`;

const switchyardText = (path: string) =>
  `This session runs under Switchyard, which keeps a session in the workspace it started in: start a session in ${path} from Switchyard (its picker lists the worktree).`;

type Mover = "provider" | "switchyard" | "in-place" | "none";
type Pending =
  | { kind: "move"; root: string; path: string; branch?: string; prompt?: string }
  | { kind: "done" };

interface Deps {
  run?: Run;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  placeTimeoutMs?: number;
  terminal?: Pick<NodeJS.WriteStream, "isTTY" | "writable" | "write">;
}

export default function (pi: ExtensionAPI) {
  createWorktree(pi, {});
}

export function createWorktree(pi: ExtensionAPI, deps: Deps): void {
  const run = deps.run ?? nodeRun;
  const agentDir = deps.agentDir ?? getAgentDir();
  const env = deps.env ?? process.env;
  const placeTimeoutMs = deps.placeTimeoutMs ?? 120_000;
  const underSwitchyard = !!(env.SWITCHYARD_BRIDGE_SOCKET || env.SWITCHYARD_CONTROL_SOCKET);
  const terminal = deps.terminal ?? process.stdout;
  const reportCwd = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI || !terminal.isTTY || !terminal.writable) return;
    const cwd = ctx.sessionManager.getCwd();
    // A sentinel prevents URL parsing from trimming trailing control characters in the path.
    if (isAbsolute(cwd)) terminal.write(`\x1b]7;${pathToFileURL(`${cwd}x`).href.slice(0, -1)}\x07`);
  };
  pi.on("session_start", (_event, ctx) => reportCwd(ctx));
  pi.on("before_agent_start", (_event, ctx) => { reportCwd(ctx); });

  const holds = new Holds();
  for (const channel of HOLD_CHANNELS) pi.events.on(channel, (e) => holds.apply(channel, e as never));
  const holdText = () => {
    const labels = holds.labels();
    return labels.length ? `Background work is still running in this session (${labels.join(", ")}): wait for it or stop it before moving.` : undefined;
  };

  const mover = (ctx: ExtensionContext): Mover => {
    if (place(pi.events)) return "provider";
    if (underSwitchyard) return "switchyard";
    return ctx.mode === "tui" && ctx.hasUI ? "in-place" : "none";
  };
  const title = (path: string, branch?: string) => pi.getSessionName()?.trim() || branch || basename(path);
  const modelOf = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const current = (ctx: ExtensionContext): CurrentSession => ({
    file: ctx.sessionManager.getSessionFile(),
    cwd: ctx.sessionManager.getCwd(),
    sessionDir: ctx.sessionManager.getSessionDir(),
  });
  const removalMessage = (path: string, branch: string | undefined, res: { ok: boolean; error?: string }) =>
    res.ok
      ? `Removed ${path}${branch ? ` and branch ${branch}` : ""}.${res.error ? ` (${res.error})` : ""}`
      : `Could not remove ${path}: ${res.error}`;
  const refusal = (m: Mover, path: string) => (m === "switchyard" ? switchyardText(path) : m === "none" ? "Moving needs an interactive Pi." : undefined);

  const awaitPlacement = async (result: Promise<PlaceResult>): Promise<PlaceResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PlaceResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "Placement did not answer in time; check Herdr before retrying." }), placeTimeoutMs);
      timer.unref?.();
    });
    try { return await Promise.race([result, timeout]); } finally { if (timer) clearTimeout(timer); }
  };

  const runMove = async (ctx: ExtensionCommandContext, t: { root: string; path: string; branch?: string; fresh?: boolean; prompt?: string }): Promise<boolean> => {
    const held = holdText();
    if (held) { ctx.ui.notify(held, "warning"); return false; }
    const m = mover(ctx);
    const no = refusal(m, t.path);
    if (no) { ctx.ui.notify(no, "error"); return false; }
    const file = sessionInto(t.path, current(ctx), agentDir, !!t.fresh);
    const claimed = place(pi.events, {
      kind: "move", root: t.root, path: t.path, branch: t.branch, file, title: title(t.path, t.branch),
      model: modelOf(ctx), thinking: pi.getThinkingLevel(), prompt: t.prompt,
    });
    if (claimed) {
      const res = await awaitPlacement(claimed.result);
      if (!res.ok) { ctx.ui.notify(`${res.error} Session file kept: ${file}`, "error"); return false; }
      pi.appendEntry(MOVED_ENTRY, { path: t.path, branch: t.branch, file, provider: claimed.provider });
      ctx.ui.notify(res.detail, "info");
      if (res.close) await res.close();
      return true;
    }
    pi.appendEntry(MOVED_ENTRY, { path: t.path, branch: t.branch, file, provider: "in-place" });
    const r = await ctx.switchSession(file, {
      withSession: async (c) => {
        c.ui.notify(`Working in ${t.path}${t.branch ? ` (${t.branch})` : ""}.`, "info");
        if (t.prompt) await c.sendUserMessage(t.prompt);
      },
    });
    if (r.cancelled) ctx.ui.notify(`Session switch cancelled; the worktree is ready at ${t.path}.`, "warning");
    return !r.cancelled;
  };

  const runOpen = async (ctx: ExtensionCommandContext, w: Worktree, root: string): Promise<void> => {
    const no = refusal(mover(ctx), w.path);
    if (no) return void ctx.ui.notify(no, "error");
    const claimed = place(pi.events, { kind: "open", root, path: w.path, branch: w.branch, title: w.branch ?? basename(w.path) });
    if (claimed) {
      const res = await awaitPlacement(claimed.result);
      ctx.ui.notify(res.ok ? res.detail : res.error, res.ok ? "info" : "error");
      return;
    }
    const dir = sessionDirFor(w.path, current(ctx), agentDir);
    const file = (await latestSession(w.path, dir)) ?? writeEmptySession(dir, w.path);
    await ctx.switchSession(file, { withSession: async (c) => c.ui.notify(`Working in ${w.path} (${w.branch ?? basename(w.path)}).`, "info") });
  };

  /** The checks `done` makes before anything changes; a string is why it cannot proceed. */
  const doneTarget = async (ctx: ExtensionContext, list: Worktree[]): Promise<{ root: string; w: Worktree; branch: string } | { error: string; level: "error" | "warning" }> => {
    const root = list[0].path;
    const index = list.findIndex((w) => real(w.path) === real(ctx.cwd));
    const w = list[index];
    if (index <= 0 || !w) return { error: "Not in a linked worktree; run /worktree done inside one.", level: "error" };
    if (!isManaged(root, w)) return { error: `${w.path} is not under ${root}/.worktrees; remove it by hand.`, level: "error" };
    if (!w.branch) return { error: "Detached worktree; remove it by hand with git worktree remove.", level: "error" };
    if (!(await isClean(run, w.path))) return { error: `Uncommitted changes in ${w.path}; commit or discard them first.`, level: "error" };
    const held = holdText();
    if (held) return { error: held, level: "warning" };
    return { root, w, branch: w.branch };
  };

  const runDone = async (ctx: ExtensionCommandContext, force: boolean, interactive: boolean): Promise<void> => {
    const list = await listWorktrees(run, ctx.cwd);
    if (!list) return void ctx.ui.notify("Not in a git repository.", "error");
    const target = await doneTarget(ctx, list);
    if ("error" in target) return void ctx.ui.notify(target.error, target.level);
    const { root, w, branch } = target;
    const no = refusal(mover(ctx), root);
    if (no) return void ctx.ui.notify(no, "error");
    await fetchOrigin(run, root);
    const merged = await isMerged(run, root, branch);
    if (!merged.merged) {
      if (!force || !interactive) {
        return void ctx.ui.notify(
          `${notMergedText(branch, merged)}. Ship it first${interactive ? ", or /worktree done --force to discard it" : ""}.`,
          "warning",
        );
      }
      const id = `worktree-done:${randomUUID()}`;
      pi.events.emit("herdr:blocked", { active: true, id, label: "Discard unmerged worktree" });
      let ok = false;
      try {
        ok = await ctx.ui.confirm(`Discard ${branch}?`, `Its commits are not in ${merged.base ?? "a remote default branch"} or a merged pull request and will be deleted with the worktree.`);
      } finally {
        pi.events.emit("herdr:blocked", { active: false, id });
      }
      if (!ok) return;
    }
    const file = sessionInto(root, current(ctx), agentDir, false);
    const claimed = place(pi.events, {
      kind: "move", root, path: root, file, title: title(root), model: modelOf(ctx), thinking: pi.getThinkingLevel(),
    });
    if (claimed) {
      const res = await awaitPlacement(claimed.result);
      if (!res.ok) return void ctx.ui.notify(`${res.error} Session file kept: ${file}`, "error");
      const removed = await removeWorktree(run, root, w);
      if (!removed.ok) {
        pi.appendEntry(MOVED_ENTRY, { path: root, file, provider: claimed.provider });
        return void ctx.ui.notify(`Worktree kept: ${removed.error}. This conversation also continues in ${root}; close this pane yourself.`, "error");
      }
      pi.appendEntry(MOVED_ENTRY, { path: root, file, provider: claimed.provider, removed: w.path });
      ctx.ui.notify(removalMessage(w.path, branch, removed), "info");
      if (res.close) await res.close();
      return;
    }
    pi.appendEntry(MOVED_ENTRY, { path: root, file, provider: "in-place", removed: w.path });
    const r = await ctx.switchSession(file, {
      withSession: async (c) => {
        const removed = await removeWorktree(run, root, w);
        c.ui.notify(removalMessage(w.path, branch, removed), removed.ok ? "info" : "error");
      },
    });
    if (r.cancelled) ctx.ui.notify("Session switch cancelled; worktree kept.", "warning");
  };

  const listLines = (list: Worktree[], cwd: string) =>
    list.slice(1).map((w) => `${w.branch ?? "(detached)"}  ${w.path}${real(w.path) === real(cwd) ? "  [this session]" : ""}`);

  /** The base ref for a new branch: the given one (verified), else origin's default. */
  const baseFor = async (root: string, given: string | undefined): Promise<{ base: string } | { error: string }> => {
    await fetchOrigin(run, root);
    if (given) return (await verifyRef(run, root, given)) ? { base: given } : { error: `Unknown base ${given}.` };
    return { base: await defaultBase(run, root) };
  };

  pi.registerCommand(COMMAND, {
    description: "Task worktrees in <repo>/.worktrees: new <branch> [--base <ref>] [--fresh], move <branch>, open <branch>, done [--force], ls",
    getArgumentCompletions: (prefix) => completions(prefix),
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const sub = words[0] ?? "ls";
      const rest = words.slice(1);
      const fresh = rest.includes("--fresh");
      const force = rest.includes("--force");
      const baseAt = rest.indexOf("--base");
      const baseFlag = baseAt >= 0 ? rest[baseAt + 1] : undefined;
      const name = rest.find((w, i) => !w.startsWith("--") && !(baseAt >= 0 && i === baseAt + 1));
      const list = await listWorktrees(run, ctx.cwd);
      if (!list) return ctx.ui.notify("Not in a git repository.", "error");
      const root = list[0].path;

      if (sub === "ls") {
        const lines = listLines(list, ctx.cwd);
        return ctx.ui.notify(lines.length ? lines.join("\n") : "No linked worktrees.", "info");
      }
      if (!["new", "move", "open", "done"].includes(sub)) return ctx.ui.notify(`Unknown subcommand: ${sub}. Use new, move, open, done or ls.`, "error");
      if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current turn to finish before using /worktree.", "warning");

      if (sub === "new") {
        if (!name) return ctx.ui.notify("Usage: /worktree new <branch> [--base <ref>] [--fresh]", "error");
        if (!(await validBranch(run, name))) return ctx.ui.notify(`Invalid branch name: ${name}`, "error");
        const dest = `${root}/.worktrees/${name.replaceAll("/", "-")}`;
        const existing = list.find((w) => w.branch === name || real(w.path) === real(dest));
        if (existing) return ctx.ui.notify(`${name} already has a worktree at ${existing.path}; use /worktree move ${name}.`, "error");
        const b = await baseFor(root, baseFlag);
        if ("error" in b) return ctx.ui.notify(b.error, "error");
        ctx.ui.notify(`Creating ${dest} from ${b.base}...`, "info");
        const added = await addWorktree(run, root, name, b.base);
        if (!added.ok) return ctx.ui.notify(`git worktree add failed: ${added.error}`, "error");
        await runMove(ctx, { root, path: added.path, branch: name, fresh });
        return;
      }
      if (sub === "move" || sub === "open") {
        if (!name) return ctx.ui.notify(`Usage: /worktree ${sub} <branch>`, "error");
        const w = findByName(list, name);
        if (!w) return ctx.ui.notify(`No worktree for ${name}; /worktree new ${name} creates one.`, "error");
        if (real(w.path) === real(ctx.cwd)) return ctx.ui.notify(`Already in ${w.path}.`, "info");
        if (sub === "move") await runMove(ctx, { root, path: w.path, branch: w.branch });
        else await runOpen(ctx, w, root);
        return;
      }
      await runDone(ctx, force, true);
    },
  });

  // ---- the tool: the move happens when the turn has settled, through a hidden command ----

  let pending: Pending | undefined;
  const queued = new Map<string, Pending>();
  const tail = (m: Mover) =>
    `${m === "provider" ? " in a new pane in the worktree's space, and this pane closes" : " in this terminal"}. End your turn now with one short line.`;

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

  pi.registerTool({
    name: TOOL,
    label: "Worktree",
    description:
      "Task worktrees in <repo>/.worktrees/<branch>, with this conversation carried along. new creates one and, when this turn ends, continues the conversation there (in Herdr a new pane in the worktree's space, closing this one; elsewhere this terminal switches); move does the same for an existing worktree; done, inside a worktree whose branch is merged (contained in origin's default branch, or a merged pull request at its tip), removes it and its branch and returns the conversation to the main checkout; list shows them.",
    promptSnippet: "Create a task worktree and continue this conversation in it; remove it and return once merged",
    promptGuidelines: [
      "Use worktree action=new only when the user asks for a worktree or branch isolation; otherwise ask first. Name the branch with a short bare slug.",
      "A worktree request keeps this conversation: use the worktree tool rather than spawning another agent there, moving Herdr panes, or running git worktree add for the current task.",
      "After worktree action=new, move or done succeeds, end your turn with one short line and do nothing else in this session: the move happens when the turn ends, and the moved session gets a note to continue the task.",
      "worktree action=done refuses uncommitted or unmerged work (not in origin's default branch and no merged pull request); tell the user what blocks it instead of forcing it.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("new"), Type.Literal("move"), Type.Literal("done"), Type.Literal("list")], {
        description: "new: create <repo>/.worktrees/<branch> and continue this conversation there when the turn ends; move: continue it in an existing worktree; done: inside a merged worktree (in origin's default branch, or a merged pull request), remove it and return to the main checkout; list: show the worktrees",
      }),
      branch: Type.Optional(Type.String({ description: "new/move: the branch; a short bare slug for a new one (no feature/ or chore/ prefix unless the repository requires one)" })),
      base: Type.Optional(Type.String({ description: "new: the ref to branch from (default: origin's default branch, fetched first)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { action, branch, base } = params as { action: "new" | "move" | "done" | "list"; branch?: string; base?: string };
      if (action !== "list" && env.PI_SUBAGENT) throw new Error("A subagent cannot move its conversation into a worktree.");
      const list = await listWorktrees(run, ctx.cwd);
      if (!list) throw new Error("Not in a git repository.");
      const root = list[0].path;
      if (action === "list") {
        const lines = listLines(list, ctx.cwd);
        return text(lines.length ? lines.join("\n") : "No linked worktrees.");
      }
      const m = mover(ctx);

      if (action === "done") {
        const target = await doneTarget(ctx, list);
        if ("error" in target) throw new Error(target.error);
        const no = refusal(m, target.root);
        if (no) throw new Error(no);
        await fetchOrigin(run, target.root);
        const merged = await isMerged(run, target.root, target.branch);
        if (!merged.merged) throw new Error(`${notMergedText(target.branch, merged)}. Ship it first.`);
        pending = { kind: "done" };
        return text(`When this turn ends, ${target.w.path} and branch ${target.branch} are removed and this conversation returns to ${target.root}. End your turn now with one short line.`);
      }

      if (!branch) throw new Error("branch is required.");
      if (action === "move") {
        const w = findByName(list, branch);
        if (!w) throw new Error(`No worktree for ${branch}; use action=new.`);
        const no = refusal(m, w.path);
        if (no) throw new Error(no);
        if (real(w.path) === real(ctx.cwd)) throw new Error(`Already in ${w.path}.`);
        const held = holdText();
        if (held) throw new Error(held);
        pending = { kind: "move", root, path: w.path, branch: w.branch, prompt: continuation(ctx.cwd, w.path, w.branch) };
        return text(`When this turn ends, this conversation continues in ${w.path}${tail(m)}`);
      }

      // new
      if (!(await validBranch(run, branch))) throw new Error(`Invalid branch name: ${branch}`);
      const held = holdText();
      if (held) throw new Error(held);
      const dest = `${root}/.worktrees/${branch.replaceAll("/", "-")}`;
      const existing = list.find((w) => w.branch === branch || real(w.path) === real(dest));
      if (existing) throw new Error(`${branch} already has a worktree at ${existing.path}; use action=move.`);
      const b = await baseFor(root, base);
      if ("error" in b) throw new Error(b.error);
      const added = await addWorktree(run, root, branch, b.base);
      if (!added.ok) throw new Error(`git worktree add failed: ${added.error}`);
      const head = `Created ${added.path} on branch ${branch} from ${b.base}.`;
      if (m === "switchyard") return text(`${head} ${switchyardText(added.path)}`);
      if (m === "none") return text(`${head} This session cannot move there (not an interactive Pi).`);
      pending = { kind: "move", root, path: added.path, branch, prompt: continuation(ctx.cwd, added.path, branch) };
      return text(`${head} When this turn ends, this conversation continues there${tail(m)}`);
    },
  });
  declareReadOnlyCalls(pi.events, TOOL, (input) => input.action === "list");

  pi.on("agent_settled", (event, ctx) => {
    reportCwd(ctx);
    const next = pending;
    if (!next) return;
    pending = undefined;
    if (event.aborted) {
      const where = next.kind === "move" ? next.branch ?? "the worktree" : "the main checkout";
      try { ctx.ui.notify(`Move to ${where} cancelled with the turn; /worktree move <branch> (or /worktree done) does it.`, "warning"); } catch { /* stale */ }
      return;
    }
    const id = randomUUID();
    queued.set(id, next);
    setTimeout(() => void pi.sendUserMessage(`/${CONTINUE_COMMAND} ${id}`, { expandPromptTemplates: true }), 0);
  });

  pi.registerCommand(CONTINUE_COMMAND, {
    description: "(pi-worktree internal) finish a move the worktree tool scheduled",
    handler: async (args, ctx) => {
      const id = args.trim();
      const next = queued.get(id);
      queued.delete(id);
      if (!next) return ctx.ui.notify("No scheduled worktree move.", "warning");
      if (next.kind === "done") return runDone(ctx, false, false);
      await runMove(ctx, { root: next.root, path: next.path, branch: next.branch, prompt: next.prompt });
    },
  });

  pi.on("session_shutdown", () => {
    pending = undefined;
    queued.clear();
  });

  pi.registerEntryRenderer<{ path?: string; branch?: string; provider?: string }>(MOVED_ENTRY, (entry, _options, theme) => {
    const d = entry.data;
    if (!d?.path) return undefined;
    return new Text(theme.fg("dim", `Moved to ${d.path}${d.branch ? ` (${d.branch})` : ""} · ${d.provider ?? "?"}`), 1, 0);
  });
}
