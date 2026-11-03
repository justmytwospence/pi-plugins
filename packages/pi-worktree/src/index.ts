// /worktree: one git worktree per task under <repo>/.worktrees/<branch>, with this
// conversation moved into it through Pi's own session switch (no terminal
// multiplexer). A session holds `git worktree lock` on the worktree it runs in;
// merged, clean, unused worktrees are removed by /worktree done, /worktree prune
// and a throttled background prune when a session starts.
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  branchExists,
  defaultBase,
  fastForwardRoot,
  fetchOrigin,
  inUse,
  isClean,
  isManaged,
  isMerged,
  listWorktrees,
  lockReason,
  nodeRun,
  parseLockReason,
  pruneMerged,
  real,
  removeWorktree,
  validBranch,
  worktreePath,
  type Worktree,
} from "./git.ts";
import { latestSession, sessionDirFor, sessionInto, writeEmptySession, type CurrentSession } from "./sessions.ts";

const run = nodeRun;
const PRUNE_EVERY_MS = 10 * 60_000;

export const SUBCOMMANDS = [
  { value: "new", label: "new <branch> [--fresh] -- create .worktrees/<branch> from origin and move this conversation there" },
  { value: "open", label: "open <branch> -- move to an existing worktree's latest session" },
  { value: "done", label: "done [--force] -- leave a merged worktree and remove it" },
  { value: "rm", label: "rm <branch> [--force] -- remove another worktree and its branch" },
  { value: "prune", label: "prune -- remove every clean, merged, unused worktree" },
  { value: "ls", label: "ls -- list this repository's worktrees" },
];

const current = (ctx: ExtensionContext): CurrentSession => ({
  file: ctx.sessionManager.getSessionFile(),
  cwd: ctx.sessionManager.getCwd(),
  sessionDir: ctx.sessionManager.getSessionDir(),
});

const findByName = (list: Worktree[], name: string) =>
  list.slice(1).find((w) => w.branch === name || basename(w.path) === name);

export async function completions(prefix: string, cwd: string = process.cwd()) {
  const text = prefix.trimStart();
  const m = /^(\S+)\s+(\S*)$/.exec(text);
  if (!m) {
    const hits = SUBCOMMANDS.filter((s) => s.value.startsWith(text));
    return hits.length ? hits : null;
  }
  const [, sub, arg] = m;
  if (!["open", "rm"].includes(sub)) return null;
  const hits = ((await listWorktrees(run, cwd)) ?? [])
    .slice(1)
    .flatMap((w) => (w.branch?.startsWith(arg) ? [{ value: `${sub} ${w.branch}`, label: w.branch }] : []));
  return hits.length ? hits : null;
}

export default function (pi: ExtensionAPI) {
  let lockedPath: string | undefined;
  let stale = false;

  const ffNote = (ctx: ExtensionContext, root: string, ff: { lockfileChanged: boolean }) => {
    if (ff.lockfileChanged) ctx.ui.notify(`Main checkout updated; package-lock.json changed: run npm ci in ${root}.`, "warning");
  };

  const switchTo = async (ctx: ExtensionCommandContext, file: string, path: string, branch: string) => {
    const res = await ctx.switchSession(file, {
      withSession: async (c) => c.ui.notify(`Working in ${path} (${branch}).`, "info"),
    });
    return !res.cancelled;
  };

  const removalMessage = (path: string, branch: string | undefined, res: { ok: boolean; error?: string }) =>
    res.ok
      ? `Removed ${path}${branch ? ` and branch ${branch}` : ""}.${res.error ? ` (${res.error})` : ""}`
      : `Could not remove ${path}: ${res.error}`;

  pi.registerCommand("worktree", {
    description: "Task worktrees in <repo>/.worktrees: new, open, done, rm, prune, ls",
    getArgumentCompletions: (prefix) => completions(prefix),
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const sub = words[0] ?? "ls";
      const fresh = words.includes("--fresh");
      const force = words.includes("--force");
      const name = words.slice(1).find((w) => !w.startsWith("--"));
      const list = await listWorktrees(run, ctx.cwd);
      if (!list) return ctx.ui.notify("Not in a git repository.", "error");
      const root = list[0].path;
      const agentDir = getAgentDir();

      if (sub === "ls") {
        const lines = list.slice(1).map((w) => {
          const use = inUse(w);
          return `${w.branch ?? "(detached)"}  ${w.path}${use.busy ? `  [in use: pid ${use.pid ?? "?"}]` : ""}`;
        });
        return ctx.ui.notify(lines.length ? lines.join("\n") : "No linked worktrees.", "info");
      }

      if (sub === "new") {
        if (!name) return ctx.ui.notify("Usage: /worktree new <branch> [--fresh]", "error");
        if (!(await validBranch(run, name))) return ctx.ui.notify(`Invalid branch name: ${name}`, "error");
        const dest = worktreePath(root, name);
        const existing = list.find((w) => w.branch === name || real(w.path) === real(dest));
        if (existing) return ctx.ui.notify(`${name} already has a worktree at ${existing.path}; use /worktree open ${name}.`, "error");
        await fetchOrigin(run, root);
        const base = await defaultBase(run, root);
        ctx.ui.notify(`Creating ${dest} from ${base}...`, "info");
        ffNote(ctx, root, await fastForwardRoot(run, root, base));
        const add = (await branchExists(run, root, name))
          ? await run("git", ["-C", root, "worktree", "add", dest, name], { timeout: 600_000 })
          : await run("git", ["-C", root, "worktree", "add", "--no-track", "-b", name, dest, base], { timeout: 600_000 });
        if (add.code !== 0) return ctx.ui.notify(`git worktree add failed: ${add.stderr.trim()}`, "error");
        const file = sessionInto(dest, current(ctx), agentDir, fresh);
        if (!(await switchTo(ctx, file, dest, name))) ctx.ui.notify(`Worktree ready at ${dest}; session switch cancelled.`, "warning");
        return;
      }

      if (sub === "open") {
        if (!name) return ctx.ui.notify("Usage: /worktree open <branch>", "error");
        const w = findByName(list, name);
        if (!w) return ctx.ui.notify(`No worktree for ${name}; /worktree new ${name} creates one.`, "error");
        if (real(w.path) === real(ctx.cwd)) return ctx.ui.notify(`Already in ${w.path}.`, "info");
        const use = inUse(w);
        if (use.busy && !(await ctx.ui.confirm("Worktree in use", `Pi pid ${use.pid ?? "?"} is using ${w.path}. Open it here too?`))) return;
        const dir = sessionDirFor(w.path, current(ctx), agentDir);
        const file = (await latestSession(w.path, dir)) ?? writeEmptySession(dir, w.path);
        await switchTo(ctx, file, w.path, w.branch ?? basename(w.path));
        return;
      }

      if (sub === "done") {
        const index = list.findIndex((w) => real(w.path) === real(ctx.cwd));
        const w = list[index];
        if (index <= 0 || !w) return ctx.ui.notify("Not in a linked worktree; run /worktree done inside one.", "error");
        if (!w.branch) return ctx.ui.notify("Detached worktree; remove it with /worktree rm.", "error");
        const branch = w.branch;
        if (!(await isClean(run, w.path))) return ctx.ui.notify(`Uncommitted changes in ${w.path}; commit or discard them first.`, "error");
        await fetchOrigin(run, root);
        const merged = await isMerged(run, root, branch);
        if (!merged.merged) {
          if (!force) {
            const sha = merged.sha ? merged.sha.slice(0, 7) : "?";
            return ctx.ui.notify(
              `${branch} has no merged pull request at ${sha}${merged.note ? ` (${merged.note})` : ""}. Ship it first, or /worktree done --force to discard it.`,
              "warning",
            );
          }
          const ok = await ctx.ui.confirm(`Discard ${branch}?`, "Its commits are not in a merged pull request and will be deleted with the worktree.");
          if (!ok) return;
        }
        ffNote(ctx, root, await fastForwardRoot(run, root, await defaultBase(run, root)));
        const file = sessionInto(root, current(ctx), agentDir, false);
        const target: Worktree = { ...w, locked: true };
        const res = await ctx.switchSession(file, {
          withSession: async (c) => {
            const removed = await removeWorktree(run, root, target);
            c.ui.notify(removalMessage(target.path, branch, removed), removed.ok ? "info" : "error");
          },
        });
        if (res.cancelled) ctx.ui.notify("Session switch cancelled; worktree kept.", "warning");
        return;
      }

      if (sub === "rm") {
        if (!name) return ctx.ui.notify("Usage: /worktree rm <branch> [--force]", "error");
        const w = findByName(list, name);
        if (!w) return ctx.ui.notify(`No worktree for ${name}.`, "error");
        if (real(w.path) === real(ctx.cwd)) return ctx.ui.notify(`This session is in ${w.path}; use /worktree done.`, "error");
        const use = inUse(w);
        if (use.busy) return ctx.ui.notify(`${w.path} is in use by Pi pid ${use.pid ?? "?"}; close that session first.`, "error");
        const clean = await isClean(run, w.path);
        if (clean) await fetchOrigin(run, root);
        const merged = clean && !!w.branch && (await isMerged(run, root, w.branch)).merged;
        if (!merged) {
          if (!force) return ctx.ui.notify(`${name} is not clean and merged; /worktree rm ${name} --force to discard it.`, "error");
          if (!(await ctx.ui.confirm(`Discard ${name}?`, `${w.path} and its branch will be removed.`))) return;
        }
        const res = await removeWorktree(run, root, w);
        return ctx.ui.notify(removalMessage(w.path, w.branch, res), res.ok ? "info" : "error");
      }

      if (sub === "prune") {
        await fetchOrigin(run, root);
        const res = await pruneMerged(run, root, ctx.cwd);
        ctx.ui.notify(res.removed.length ? `Pruned: ${res.removed.join(", ")}` : "Nothing to prune.", "info");
        if (res.failed.length) ctx.ui.notify(`Failed: ${res.failed.join("\n")}`, "error");
        return;
      }

      ctx.ui.notify(`Unknown subcommand: ${sub}. Use new, open, done, rm, prune or ls.`, "error");
    },
  });

  const lock = async (root: string, path: string) => {
    const res = await run("git", ["-C", root, "worktree", "lock", "--reason", lockReason(), path]);
    if (res.code === 0) lockedPath = path;
  };

  const backgroundPrune = async (ctx: ExtensionContext, root: string) => {
    const common = await run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0) return;
    const dir = join(common.stdout.trim(), "pi-worktree");
    const stamp = join(dir, "last-prune");
    try {
      if (Date.now() - statSync(stamp).mtimeMs < PRUNE_EVERY_MS) return;
    } catch {}
    mkdirSync(dir, { recursive: true });
    writeFileSync(stamp, "");
    const now = new Date();
    utimesSync(stamp, now, now);
    if (!(await fetchOrigin(run, root))) return;
    const res = await pruneMerged(run, root, ctx.cwd);
    if (res.removed.length && !stale) ctx.ui.notify(`Pruned merged worktrees: ${res.removed.join(", ")}`, "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    stale = false;
    if (process.env.PI_SUBAGENT) return;
    const list = await listWorktrees(run, ctx.cwd);
    if (!list) return;
    const root = list[0].path;
    const here = list.slice(1).find((w) => real(w.path) === real(ctx.cwd));
    if (here && isManaged(root, here)) {
      if (!here.locked) await lock(root, here.path);
      else if (parseLockReason(here.lockReason)?.pid === process.pid) lockedPath = here.path;
      else {
        const use = inUse(here);
        if (use.busy) {
          if (ctx.hasUI) ctx.ui.notify(`Pi pid ${use.pid ?? "?"} is also using this worktree.`, "warning");
        } else {
          await run("git", ["-C", root, "worktree", "unlock", here.path]);
          await lock(root, here.path);
        }
      }
    }
    const others = list.slice(1).some((w) => isManaged(root, w) && w !== here);
    if (ctx.hasUI && others) void backgroundPrune(ctx, root).catch(() => {});
  });

  pi.on("session_shutdown", (event) => {
    stale = true;
    if (lockedPath && event.reason !== "reload") {
      spawnSync("git", ["-C", lockedPath, "worktree", "unlock", lockedPath], { stdio: "ignore" });
      lockedPath = undefined;
    }
  });
}
