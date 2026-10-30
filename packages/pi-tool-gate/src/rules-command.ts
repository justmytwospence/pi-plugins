// `/gate rules`: list, add and remove the permission rules (permissions.ts) in force for this
// project, and the folder grants beside them (Claude Code's additional directories).
// Read-only sources stay read-only here: the answer names the file.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shown } from "./dirs.ts";
import { grantsFile } from "./grants.ts";
import { type IgnoredRule, LISTS, parseRule, type Origin, type RuleList, ruleWarning, type Scope, type ScopedRule, scopeLabel } from "./permissions.ts";

/** A folder the project or session may read or write beyond the policy: `dir:read:/abs`. */
export interface DirGrant {
  key: string;
  access: "read" | "write";
  dir: string;
}

export interface ScopedDir extends DirGrant {
  scope: "session" | "project";
  /** Omitted for legacy callers; they store project grants in project-grants.json. */
  source?: string;
  writable?: boolean;
  shared?: boolean;
}

/** What the command needs from the gate: the rules in force, and ways to change the ones it may. */
export interface RuleStore {
  /** The project, for titles. */
  project: string;
  projectPersistence?: "local" | "shared";
  userWritable?: boolean;
  sources?: () => readonly string[];
  diagnostics?: () => readonly string[];
  rules(): readonly ScopedRule[];
  ignored(): readonly IgnoredRule[];
  dirs(): readonly ScopedDir[];
  add(scope: Scope, list: RuleList, text: string): Promise<void>;
  remove(rule: ScopedRule): Promise<void>;
  removeDir(dir: ScopedDir): Promise<void>;
}

export const ADD_A_RULE = "Add a rule...";
const MANAGED_USER_RULES = "User rules are managed. Edit their source and deploy it; this command made no changes.";
const scopes = (store: RuleStore): Array<{ label: string; scope: Scope }> => [
  { label: "This session", scope: "session" },
  { label: `This project (${store.projectPersistence ?? "local"})`, scope: "project" },
  ...(store.userWritable === false ? [] : [{ label: "Everywhere (your user settings)", scope: "user" as const }]),
];
const SCOPE_ORDER = (o: Origin) => (o.scope === "session" ? 0 : o.scope === "project" ? (o.shared ? 2 : 1) : o.shared ? 4 : 3);

const sourceOf = (o: Origin) => (o.scope === "session" ? "this session" : shown(o.source));
const dirLabel = (d: ScopedDir) => `${d.access}s in ${shown(d.dir)}`;
const dirScope = (d: ScopedDir) => d.scope === "session" ? "session" : d.shared ? "project (shared)" : d.source && !d.source.endsWith("project-grants.json") ? "project (local)" : "project (this machine)";
const dirSource = (d: ScopedDir) => d.scope === "session" ? "this session" : shown(d.source ?? grantsFile());

/** Rules grouped by list, then by scope and file, then the folders and any rule that could not be read. */
export function formatRules(store: RuleStore): string {
  const out: string[] = [`Permission rules for ${store.project} (deny beats ask beats allow):`];
  for (const list of LISTS) {
    out.push(`${list}`);
    const rules = store.rules().filter((r) => r.list === list);
    if (!rules.length) out.push("  none");
    const groups = new Map<string, ScopedRule[]>();
    for (const r of [...rules].sort((a, b) => SCOPE_ORDER(a.origin) - SCOPE_ORDER(b.origin))) {
      const heading = r.origin.scope === "session" ? "session" : `${scopeLabel(r.origin)}: ${sourceOf(r.origin)}`;
      groups.set(heading, [...(groups.get(heading) ?? []), r]);
    }
    for (const [heading, group] of groups) {
      out.push(`  ${heading}`, ...group.map((r) => {
        const warning = ruleWarning(r.list, r.rule);
        return warning ? `    ${r.text} (warning: ${warning})` : `    ${r.text}`;
      }));
    }
  }
  const dirs = store.dirs();
  out.push("folders");
  if (!dirs.length) out.push("  none");
  const folderGroups = new Map<string, ScopedDir[]>();
  for (const d of dirs) {
    const heading = d.scope === "session" ? "session" : `${dirScope(d)}: ${dirSource(d)}`;
    folderGroups.set(heading, [...(folderGroups.get(heading) ?? []), d]);
  }
  for (const [heading, group] of folderGroups) out.push(`  ${heading}`, ...group.map((d) => `    ${dirLabel(d)}`));
  const ignored = store.ignored();
  if (ignored.length) {
    out.push("ignored (not usable rules)");
    for (const r of ignored) out.push(`  ${r.list}: ${r.raw}: ${r.error} [${scopeLabel(r.origin)}: ${sourceOf(r.origin)}]`);
  }
  const sources = store.sources?.() ?? [];
  if (sources.length) out.push("sources", ...[...new Set(sources)].map((source) => `  ${shown(source)}`));
  const diagnostics = store.diagnostics?.() ?? [];
  if (diagnostics.length) out.push("diagnostics", ...diagnostics.map((diagnostic) => `  ${diagnostic}`));
  return out.join("\n");
}

type Entry = { kind: "rule"; label: string; rule: ScopedRule } | { kind: "dir"; label: string; dir: ScopedDir };

function entriesOf(store: RuleStore): Entry[] {
  const entries: Entry[] = [];
  for (const list of LISTS) {
    const rules = store.rules().filter((r) => r.list === list);
    for (const rule of [...rules].sort((a, b) => SCOPE_ORDER(a.origin) - SCOPE_ORDER(b.origin))) {
      entries.push({ kind: "rule", label: `${list}: ${rule.text} (${scopeLabel(rule.origin)})`, rule });
    }
  }
  for (const dir of store.dirs()) entries.push({ kind: "dir", label: `folder: ${dirLabel(dir)} (${dirScope(dir)})`, dir });
  return entries;
}

const USAGE =
  "Usage: /gate rules [list | add <allow|ask|deny> <rule> [--scope session|project|user] | remove <allow|ask|deny> <rule> [--scope ...]]";

function isList(word: string | undefined): word is RuleList {
  return word === "allow" || word === "ask" || word === "deny";
}

/** `<list> <rule...> [--scope s]`: the rule may hold spaces, as `Bash(git push:*)`. */
function parseArgs(rest: string): { list: RuleList; text: string; scope?: Scope } | string {
  const m = /^(\S+)\s+([\s\S]+?)(?:\s+--scope(?:=|\s+)(\S+))?\s*$/u.exec(rest.trim());
  if (!m || !isList(m[1])) return USAGE;
  const scope = m[3];
  if (scope !== undefined && scope !== "session" && scope !== "project" && scope !== "user") return `Unknown scope "${scope}": use session, project or user.`;
  return { list: m[1], text: (m[2] as string).trim(), ...(scope ? { scope } : {}) };
}

async function add(ctx: ExtensionContext, store: RuleStore, list: RuleList, text: string, scope: Scope) {
  if (scope === "user" && store.userWritable === false) {
    ctx.ui.notify(MANAGED_USER_RULES, "warning");
    return false;
  }
  const parsed = parseRule(text);
  if (!parsed.ok) {
    ctx.ui.notify(parsed.error, "warning");
    return false;
  }
  try {
    await store.add(scope, list, parsed.rule.text);
  } catch (error) {
    ctx.ui.notify(`Could not save the rule: ${(error as Error).message}`, "warning");
    return false;
  }
  const where = scopes(store).find((s) => s.scope === scope)?.label.toLowerCase() ?? scope;
  const warning = ruleWarning(list, parsed.rule);
  ctx.ui.notify(`Added to ${list}: ${parsed.rule.text} (${where}).${warning ? ` Warning: it ${warning}.` : ""}`, warning ? "warning" : "info");
  return true;
}

async function addInteractively(ctx: ExtensionContext, store: RuleStore) {
  const list = await ctx.ui.select("Add a rule: which list? (deny beats ask beats allow)", [...LISTS].reverse());
  if (!isList(list)) return;
  const choices = scopes(store);
  const where = await ctx.ui.select(`Add to ${list}: where?`, choices.map((s) => s.label));
  const scope = choices.find((s) => s.label === where)?.scope;
  if (!scope) return;
  for (;;) {
    const text = (await ctx.ui.input(`${list} rule (Bash(git push:*), Edit(src/**), web_fetch)`, "Bash(git push:*)"))?.trim();
    if (!text) return;
    if (await add(ctx, store, list, text, scope)) return;
  }
}

async function pick(ctx: ExtensionContext, store: RuleStore, entry: Entry) {
  if (entry.kind === "dir") {
    const d = entry.dir;
    if (d.writable === false) {
      ctx.ui.notify(`${dirLabel(d)} is in ${dirSource(d)}; /gate rules does not edit that file. Edit it to change the folder grant.`, "info");
      return;
    }
    const choice = await ctx.ui.select(`folder: ${dirLabel(d)}\nScope: ${dirScope(d)} (${dirSource(d)})`, ["Remove", "Cancel"]);
    if (choice !== "Remove") return;
    try {
      await store.removeDir(d);
    } catch (error) {
      ctx.ui.notify(`Could not remove it: ${(error as Error).message}`, "warning");
      return;
    }
    ctx.ui.notify(`Removed: ${dirLabel(d)}.`, "info");
    return;
  }
  const { rule } = entry;
  if (rule.origin.scope === "user" && store.userWritable === false) {
    ctx.ui.notify(MANAGED_USER_RULES, "warning");
    return;
  }
  if (!rule.origin.writable) {
    const shared = rule.origin.shared && rule.origin.scope === "user" ? ", which the opencode and Claude Code ports read too" : "";
    ctx.ui.notify(`${rule.text} is in ${sourceOf(rule.origin)}${shared}; /gate rules does not edit that file. Edit it to change the rule.`, "info");
    return;
  }
  const choice = await ctx.ui.select(`${rule.list}: ${rule.text}\nScope: ${scopeLabel(rule.origin)} (${sourceOf(rule.origin)})`, ["Remove", "Cancel"]);
  if (choice !== "Remove") return;
  try {
    await store.remove(rule);
  } catch (error) {
    ctx.ui.notify(`Could not remove it: ${(error as Error).message}`, "warning");
    return;
  }
  ctx.ui.notify(`Removed from ${rule.list}: ${rule.text}.`, "info");
}

/** `/gate rules`, `/gate rules list|add|remove ...` and the `/gate grants` alias. */
export async function rulesCommand(args: string, ctx: ExtensionContext, store: RuleStore): Promise<void> {
  const word = args.trim().split(/\s+/u)[0] ?? "";
  const tail = args.trim().slice(word.length).trim();
  if (word === "list") {
    ctx.ui.notify(formatRules(store), "info");
    return;
  }
  if (word === "add") {
    const parsed = parseArgs(tail);
    if (typeof parsed === "string") {
      ctx.ui.notify(parsed, "warning");
      return;
    }
    await add(ctx, store, parsed.list, parsed.text, parsed.scope ?? "project");
    return;
  }
  if (word === "remove") {
    const parsed = parseArgs(tail);
    if (typeof parsed === "string") {
      ctx.ui.notify(parsed, "warning");
      return;
    }
    if (parsed.scope === "user" && store.userWritable === false) {
      ctx.ui.notify(MANAGED_USER_RULES, "warning");
      return;
    }
    const wanted = parseRule(parsed.text);
    const text = wanted.ok ? wanted.rule.text : parsed.text;
    const found = store.rules().filter((r) => r.list === parsed.list && (r.text === text || r.raw === parsed.text));
    const inScope = parsed.scope ? found.filter((r) => r.origin.scope === parsed.scope) : found;
    if (!inScope.length) {
      ctx.ui.notify(`No ${parsed.list} rule ${parsed.text}${parsed.scope ? ` in ${parsed.scope}` : ""}.`, "warning");
      return;
    }
    const removable = inScope.filter((r) => r.origin.writable && !(r.origin.scope === "user" && store.userWritable === false));
    if (!removable.length) {
      const first = inScope[0] as ScopedRule;
      ctx.ui.notify(first.origin.scope === "user" && store.userWritable === false ? MANAGED_USER_RULES : `${first.text} is in ${sourceOf(first.origin)}; /gate rules does not edit that file. Edit it to change the rule.`, "warning");
      return;
    }
    try {
      for (const r of removable) await store.remove(r);
    } catch (error) {
      ctx.ui.notify(`Could not remove it: ${(error as Error).message}`, "warning");
      return;
    }
    ctx.ui.notify(`Removed from ${parsed.list}: ${text}.`, "info");
    return;
  }
  if (word !== "" && word !== "grants" && word !== "rules") {
    ctx.ui.notify(USAGE, "warning");
    return;
  }
  const entries = entriesOf(store);
  ctx.ui.notify(formatRules(store), "info");
  const labels = [...entries.map((e) => e.label), ADD_A_RULE];
  const picked = await ctx.ui.select(`Permission rules for ${store.project} (enter selects)`, labels);
  if (picked === undefined) return;
  if (picked === ADD_A_RULE) {
    await addInteractively(ctx, store);
    return;
  }
  const entry = entries[labels.indexOf(picked)];
  if (entry) await pick(ctx, store, entry);
}
