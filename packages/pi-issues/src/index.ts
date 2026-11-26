// pi-issues: start GitHub issues in linked-branch worktrees, and set issue statuses.
//
// It sequences standard tools and keeps no state of its own: `gh issue develop` links the branch to
// the issue on GitHub, `git worktree add` checks it out in <repo>/.worktrees/<branch>, one
// `setIssueStatus` call marks the issues In progress, and the agent opens the session there (with
// pi-herdr's spawn, which finds the worktree). GitHub's own links carry the issue from then on.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { suggestBranch } from "./branch.ts";
import type { Exec } from "./exec.ts";
import { fetchIssues, fetchStatuses, type IssueSummary, listOpenIssues, setStatus } from "./github.ts";
import { startIssues, startReport } from "./start.ts";
import { ghTitles, type TitleSource, titledMessage } from "./titles.ts";
import { resolveWorkflow } from "./workflow.ts";

const TOOL = "issue";
const COMPLETION_TTL_MS = 60_000;
/** Title lookups hold up the finished message, so they give up quickly. */
const TITLE_TIMEOUT_MS = 5_000;

const PARAMS = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("status")], {
    description: "start: link a branch, check it out in a worktree, set In progress and return the session's task; status: set a status",
  }),
  issues: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, description: "Issue numbers; with start, one branch for all of them" }),
  branch: Type.Optional(Type.String({ description: "start: the branch (default: the issue's linked branch, one its body names, or a short slug of its title)" })),
  status: Type.Optional(Type.String({ description: "status: the status name, such as In progress, In review, Done or Not planned" })),
  repo: Type.Optional(Type.String({ description: "status: owner/name, when not this checkout's repository" })),
});

export function startMessage(numbers: number[], branch: string): string {
  const s = numbers.length > 1 ? "s" : "";
  return `Start GitHub issue${s} ${numbers.map((n) => `#${n}`).join(" ")} on branch \`${branch}\` with the issue tool (action=start), then start its worktree session as the result says.`;
}

export default function piIssues(pi: ExtensionAPI, deps: { exec?: Exec; inHerdr?: () => boolean; titles?: TitleSource } = {}) {
  const exec: Exec = deps.exec ?? ((cmd, args, cwd) => pi.exec(cmd, args, { cwd, timeout: 60_000 }));
  const inHerdr = deps.inHerdr ?? (() => process.env.HERDR_ENV === "1");
  const titles = deps.titles ?? ghTitles(deps.exec ?? ((cmd, args, cwd) => pi.exec(cmd, args, { cwd, timeout: TITLE_TIMEOUT_MS })));

  // Issue and pull request numbers in the agent's replies get their titles (titles.ts). The message
  // is replaced before it is saved or sent, so requests stay append-only.
  pi.on("message_end", async (event, ctx) => {
    try {
      const message = await titledMessage(event.message, ctx.cwd, titles);
      return message ? { message } : undefined;
    } catch {
      return undefined;
    }
  });

  pi.registerTool({
    name: TOOL,
    label: "GitHub issue",
    description:
      "GitHub issues. start: link a branch to the issues on GitHub (`gh issue develop`, from the repo's base branch), check it out in <repo>/.worktrees/<branch>, set the issues In progress, and return the task for the worktree session. status: set the issues' status by name (Backlog, Todo, In progress, In review, Done, Not planned).",
    promptSnippet: "Start GitHub issues in linked-branch worktrees and set issue statuses",
    promptGuidelines: [
      "Use issue action=start when the user asks to start, pick up or work on GitHub issues in a worktree, then start the session it names with herdr action=spawn where=worktree and the task it returns.",
      "Use issue action=status to set GitHub issue statuses instead of gh project or GraphQL calls; a pull request whose body says `Closes #N` moves the issue to In review and, once merged into the default branch, to Done by itself.",
    ],
    parameters: PARAMS,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
      if (params.action === "start") {
        const result = await startIssues(exec, ctx.cwd, params.issues, params.branch);
        return text(startReport(result, inHerdr()));
      }
      const wanted = params.status?.trim();
      if (!wanted) throw new Error("status: give the status name");
      const { root, repo: here } = await resolveWorkflow(exec, ctx.cwd);
      const repo = params.repo?.trim() || undefined;
      const statuses = await fetchStatuses(exec, root, repo);
      if (!statuses.length) throw new Error(`${repo ?? here} has no issue statuses`);
      const status = statuses.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
      if (!status) throw new Error(`Unknown status "${wanted}"; this repository has: ${statuses.map((s) => s.name).join(", ")}`);
      const issues = await fetchIssues(exec, root, [...new Set(params.issues)], repo);
      for (const issue of issues) await setStatus(exec, root, issue.id, status.id);
      return text(`Set ${issues.map((i) => `#${i.number}`).join(", ")} to ${status.name}.`);
    },
  });

  const cache = new Map<string, { at: number; issues: Promise<IssueSummary[]> }>();
  const openIssues = (cwd: string): Promise<IssueSummary[]> => {
    const hit = cache.get(cwd);
    if (hit && Date.now() - hit.at < COMPLETION_TTL_MS) return hit.issues;
    const issues = listOpenIssues(exec, cwd);
    cache.set(cwd, { at: Date.now(), issues });
    issues.catch(() => cache.delete(cwd));
    return issues;
  };

  pi.registerCommand(TOOL, {
    description: "Start GitHub issues in a worktree: /issue [number...] (no number: pick one)",
    getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
      if (/\s/.test(prefix)) return null;
      try {
        const wanted = prefix.replace(/^#/, "");
        const items = (await openIssues(process.cwd()))
          .filter((i) => String(i.number).startsWith(wanted))
          .map((i) => ({ value: String(i.number), label: `#${i.number}`, description: i.title }));
        return items.length ? items : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const numbers: number[] = [];
        for (const token of tokens) {
          const match = /^#?(\d+)$/.exec(token);
          if (!match) return ctx.ui.notify("Usage: /issue [number...]", "error");
          numbers.push(Number(match[1]));
        }
        if (!numbers.length) {
          if (!ctx.hasUI) return ctx.ui.notify("Usage: /issue <number...> (picking an issue needs the interactive UI)", "error");
          const open = await openIssues(ctx.cwd);
          if (!open.length) return ctx.ui.notify("No open issues in this repository.", "info");
          const lines = open.map((i) => `#${i.number} ${i.title}${i.milestone ? `  · ${i.milestone}` : ""}`);
          const choice = await ctx.ui.select("Start which issue?", lines);
          if (choice === undefined) return;
          numbers.push(open[lines.indexOf(choice)]!.number);
        }
        const unique = [...new Set(numbers)];
        let branch: string;
        const { root } = await resolveWorkflow(exec, ctx.cwd);
        const [first] = await fetchIssues(exec, root, [unique[0]!]);
        const suggestion = suggestBranch(first!);
        if (ctx.hasUI) {
          const typed = await ctx.ui.input(`Branch for #${unique[0]} (Enter: ${suggestion})`, suggestion);
          if (typed === undefined) return;
          branch = typed.trim() || suggestion;
        } else branch = suggestion;
        const message = startMessage(unique, branch);
        if (ctx.isIdle()) pi.sendUserMessage(message);
        else pi.sendUserMessage(message, { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
