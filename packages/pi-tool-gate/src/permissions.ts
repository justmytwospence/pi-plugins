// Permission rules, in Claude Code's syntax: `Bash(git push:*)` (a prefix), `Bash(npm test)` (one
// exact command), `Edit(src/**)`, `Write(...)`, `Read(...)` (gitignore-style paths), or a bare tool
// name (`web_fetch`, `mcp__server`). Three lists, `allow`, `ask` and `deny`, merged from every scope
// (session, this project on this machine, the project's shared files, your user files); `deny`
// beats `ask` beats `allow` wherever each was written.
//
// A shell call is taken apart into its simple commands (bash.ts `bashUnits`): the parts of `a && b`,
// the commands inside `$(...)` and backticks, and the text of `sh -c` and `eval`. A deny or ask rule
// matches when any of them does; an allow rule opens a call only when it covers every part that does
// more than read. Calls the gate always holds (`alwaysAskBash`) are opened only by a rule naming the
// exact command. Everything here is pure except loading and editing the rule files.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type BashUnit, bashUnits, expandHome, READS_KEY, splitCommand } from "./bash.ts";
import { agentDir, isRecord, sharedConfigDir } from "./config.ts";
import type { Grant } from "./grants.ts";
import { type ProjectContext, projectFiles } from "./project.ts";

/** The lists in the order they win: a matching deny rule beats ask, ask beats allow. */
export const LISTS = ["deny", "ask", "allow"] as const;
export type RuleList = (typeof LISTS)[number];

/** Where a rule was written: this session, this project on this machine, or your user settings. */
export type Scope = "session" | "project" | "user";

export interface Origin {
  scope: Scope;
  /** Written in a file the other ports read too (`.agents/tool-gate.json`, `~/.config/agents/tool-gate.json`), or the project's own. */
  shared: boolean;
  /** The file, or `this session`. */
  source: string;
  /** Whether the gate may change it: only the configured project destination and unmanaged user file. */
  writable: boolean;
}

export interface ScopedRule {
  list: RuleList;
  /** The rule normalized (`Bash(git push:*)`). */
  text: string;
  /** The rule as it is stored, which removing it must match. */
  raw: string;
  rule: Rule;
  origin: Origin;
  /** The key a machine-local project grant is stored under (a migrated grant keeps its old key). */
  key?: string;
}

/** A rule in a file that this reader cannot use, kept to show the user. */
export interface IgnoredRule {
  list: RuleList;
  raw: string;
  error: string;
  origin: Origin;
}

export interface Rule {
  /** Normalized text. */
  text: string;
  /** `Bash`, `Edit`, `Write`, `Read`, or a tool name (with `*` wildcards; `mcp__server` covers the server's tools). */
  tool: string;
  /**
   * A command rule: a prefix (`git push:*`), a wildcard pattern (`vercel *--prod*`: `*` anywhere,
   * matching any text, spaces included; `re` is it compiled) or an exact command; `tokens` is the
   * command as words when it is one simple command.
   */
  command?: { kind: "prefix" | "glob" | "exact"; text: string; tokens?: string[]; re?: RegExp };
  /** A path rule. */
  path?: PathPattern;
}

export type Parsed = { ok: true; rule: Rule } | { ok: false; error: string };

const FILE_TOOLS = new Set(["Edit", "Write", "Read"]);
const NAMED = new Map([["bash", "Bash"], ["edit", "Edit"], ["write", "Write"], ["read", "Read"]]);

/** The rule tool a Pi tool belongs to: `bash` and `bg_run` are Bash, `read`, `grep`, `find` and `ls` are Read; others keep their name. */
export function ruleTool(tool: string): string {
  if (tool === "bash" || tool === "bg_run") return "Bash";
  if (tool === "edit") return "Edit";
  if (tool === "write") return "Write";
  if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") return "Read";
  return tool;
}

/** Parse a rule: `Tool` or `Tool(specifier)`. */
export function parseRule(raw: string): Parsed {
  const text = raw.trim();
  if (!text) return { ok: false, error: "The rule is empty." };
  const shape = /^([^\s()]+)\s*(?:\(([\s\S]*)\))?$/u.exec(text);
  if (!shape) return { ok: false, error: "Write a rule as Tool or Tool(specifier), for example Bash(git push:*)." };
  const name = shape[1] as string;
  const specifier = shape[2];
  if (!/^[A-Za-z0-9_.*:-]+$/u.test(name)) return { ok: false, error: `"${name}" is not a tool name.` };
  const tool = NAMED.get(name.toLowerCase()) ?? name;
  if (specifier === undefined) return { ok: true, rule: { text: tool, tool } };
  if (!specifier.trim()) return { ok: false, error: `${tool}() has nothing inside the parentheses; name the tool alone to cover every call.` };
  if (tool === "Bash") return parseCommandRule(specifier);
  if (FILE_TOOLS.has(tool)) {
    const pattern = compilePath(specifier);
    if (!pattern.ok) return pattern;
    return { ok: true, rule: { text: `${tool}(${specifier.trim()})`, tool, path: pattern.pattern } };
  }
  return { ok: false, error: `${tool}(...) is not supported: only Bash, Edit, Write and Read take a specifier. Name the tool alone (${tool}).` };
}

/**
 * The command's words with `./bin/x` spelled `bin/x`, which is the same program. `./git` is not
 * `git`: a file in this directory, not the one on the path.
 */
function normalizeWords(words: readonly string[]): string[] {
  const first = words[0];
  return first !== undefined && /^\.\/.*\//u.test(first) ? [first.slice(2), ...words.slice(1)] : [...words];
}

function parseCommandRule(specifier: string): Parsed {
  const s = specifier.trim();
  if (s === "*") return { ok: true, rule: { text: "Bash", tool: "Bash" } };
  const head = s.endsWith(":*") || s.endsWith(" *") ? s.slice(0, -2).trim() : undefined;
  // As in Claude Code, a `*` anywhere else is a wildcard too (`git log * main`, `* --version`, `ls*`);
  // `:*` means a trailing ` *` only at the end.
  if (head?.includes("*") || (head === undefined && s.includes("*"))) {
    const parts = splitCommand(head === undefined ? s : `${head} *`);
    if (parts.length !== 1) {
      return { ok: false, error: "A rule with * names one command, for example Bash(git log * main); a compound command is matched part by part." };
    }
    const tokens = normalizeWords(parts[0] as string[]);
    const re = new RegExp(`^${tokens.join(" ").split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join("[\\s\\S]*")}$`, "u");
    const text = head === undefined ? s : `${head} *`;
    return { ok: true, rule: { text: `Bash(${text})`, tool: "Bash", command: { kind: "glob", text, tokens, re } } };
  }
  if (head !== undefined) {
    const parts = splitCommand(head);
    if (!head || parts.length !== 1) {
      return { ok: false, error: "A prefix rule names one command followed by :* (or a space and *), for example Bash(git push:*)." };
    }
    return { ok: true, rule: { text: `Bash(${head}:*)`, tool: "Bash", command: { kind: "prefix", text: head, tokens: normalizeWords(parts[0] as string[]) } } };
  }
  const parts = splitCommand(s);
  const tokens = parts.length === 1 ? normalizeWords(parts[0] as string[]) : undefined;
  return { ok: true, rule: { text: `Bash(${s})`, tool: "Bash", command: { kind: "exact", text: s, ...(tokens ? { tokens } : {}) } } };
}

// ---- paths ----------------------------------------------------------------------------------

/**
 * A gitignore-style path pattern. `*` and `?` stay inside one path part, `**` crosses them, and a
 * pattern naming a directory covers everything in it. Relative to the project: `src/**` is anchored
 * there, `*.env` (no slash) matches at any depth. `~/x` is under home, `/x` (or Claude Code's `//x`)
 * is an absolute path.
 */
export interface PathPattern {
  spec: string;
  anchor: "absolute" | "root" | "anywhere";
  re: RegExp;
  /** For `dir/**`, the directory itself too (listing it is reading it). */
  dirRe?: RegExp;
  /** The path, when the pattern has no wildcard. */
  literal?: string;
}

function globSource(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return re;
}

function compilePath(specifier: string): { ok: true; pattern: PathPattern } | { ok: false; error: string } {
  let p = specifier.trim();
  if (p.startsWith("//")) p = p.slice(1);
  p = expandHome(p);
  let anchor: PathPattern["anchor"];
  if (p.startsWith("/")) anchor = "absolute";
  else {
    const dotted = p.startsWith("./");
    p = dotted ? p.slice(2) : p;
    anchor = dotted || p.replace(/\/+$/u, "").includes("/") ? "root" : "anywhere";
  }
  if (p.length > 1) p = p.replace(/\/+$/u, "");
  if (!p) return { ok: false, error: "The path is empty." };
  try {
    const literal = /[*?]/u.test(p) ? undefined : p;
    const dir = p.endsWith("/**") && p.length > 3 ? p.slice(0, -3) : undefined;
    return {
      ok: true,
      pattern: {
        spec: specifier.trim(),
        anchor,
        re: new RegExp(`^${globSource(p)}$`, "u"),
        ...(dir ? { dirRe: new RegExp(`^${globSource(dir)}$`, "u") } : {}),
        ...(literal ? { literal } : {}),
      },
    };
  } catch {
    return { ok: false, error: `"${specifier.trim()}" is not a path pattern.` };
  }
}

/** The directory prefixes of a path, shortest first, then the path itself. */
function lineage(candidate: string): string[] {
  const out: string[] = [];
  for (let i = 1; i < candidate.length; i++) if (candidate[i] === "/") out.push(candidate.slice(0, i));
  out.push(candidate);
  return out;
}

/**
 * Whether `file` (absolute) matches. With `exact`, only a pattern with no wildcard that names the
 * file itself matches: what may open a call the gate always holds (a credential file).
 */
export function matchPath(pattern: PathPattern, file: string, root: string, exact = false): boolean {
  let candidate = file;
  if (pattern.anchor !== "absolute") {
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    candidate = rel;
  }
  if (exact) {
    if (pattern.literal === undefined) return false;
    return pattern.anchor === "anywhere" ? path.basename(file) === pattern.literal : candidate === pattern.literal;
  }
  if (pattern.anchor === "anywhere") return candidate.split("/").some((part) => pattern.re.test(part));
  return lineage(candidate).some((prefix) => pattern.re.test(prefix) || pattern.dirRe?.test(prefix) === true);
}

// ---- commands -------------------------------------------------------------------------------

const hasExpansion = (words: readonly string[]) => words.some((w) => /[$`]/u.test(w));

const SHELL_RESERVED_WORDS = new Set([
  "!", "case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for", "function",
  "if", "in", "select", "then", "time", "until", "while", "{", "}", "[[", "]]",
]);

/** Conservative proof that quote removal is the only shell operation on this argument list. */
function literalShellArguments(source: string): boolean {
  let quote: "'" | '"' | undefined;
  let wordStart = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      const next = source[++i];
      if (next === undefined || next === "\n" || next === "\r") return false;
      continue;
    }
    if (c === "$" || c === "`") return false;
    if (quote === '"') {
      if (c === '"') quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === " " || c === "\t") {
      // Bare reserved words can change shell grammar. Reject them in any position rather than
      // trying to prove their grammatical role; quotes and escapes remain in the source slice.
      if (SHELL_RESERVED_WORDS.has(source.slice(wordStart, i))) return false;
      wordStart = i + 1;
    } else if (/[*?\[\]{}~<>#;|&()\n\r]/u.test(c)) return false;
  }
  return quote === undefined && source.trim().length > 0 && !SHELL_RESERVED_WORDS.has(source.slice(wordStart));
}

function startsWith(prefix: readonly string[], words: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((t, i) => t === words[i]);
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * The words a unit answers to. A rule is tried against the command as typed (without its `./`),
 * against the program past assignments and wrappers (`time npm test` is `npm test`), against the
 * program a `sudo` runs, and, for a prefix, against the program and subcommands it names
 * (`git -C x push` is `git push`). Allow rules skip the last three for a unit an assignment, wrapper
 * option or `git -c` changes (`PATH=... git push`), which is not the program it seems.
 */
function formsOf(u: BashUnit, blocking: boolean): { argv: string[][]; key?: string[] } {
  const argv = [normalizeWords(u.words)];
  const trusted = blocking || !u.unsafe;
  if (u.program && trusted) argv.push([u.program.name, ...u.program.args]);
  if (u.inner && blocking) argv.push([u.inner.name, ...u.inner.args]);
  return { argv, ...(u.key && trusted ? { key: u.key.split(" ") } : {}) };
}

function unitMatches(rule: Rule, u: BashUnit, blocking: boolean): boolean {
  const c = rule.command;
  if (!c?.tokens || (!blocking && u.opaque)) return false;
  if (c.kind === "exact") {
    // Expansion-bearing exact allows name only the whole call. Blocking rules may inspect an
    // identically spelled command inside a compound or nested shell, without losing its source.
    if (!blocking && (!literalShellArguments(c.text) || !literalShellArguments(u.source))) return false;
    return sameCommand(c.text, u.source, formsOf(u, blocking).argv);
  }
  const forms = formsOf(u, blocking);
  if (c.kind === "prefix") return forms.argv.some((f) => startsWith(c.tokens as string[], f)) || (forms.key !== undefined && startsWith(c.tokens, forms.key));
  // A wildcard pattern is matched against the command's words joined by single spaces; to allow, not
  // against a command with an expansion, whose words are not what runs.
  return forms.argv.some((f) => (blocking || !hasExpansion(f)) && c.re?.test(f.join(" ")) === true);
}

/** Whether an exact rule names this whole command: the same text, or the same single command in other spacing or quoting. */
function sameCommand(rule: string, command: string, alternatives: readonly string[][] = []): boolean {
  if (rule.trim() === command.trim()) return true;
  if (!literalShellArguments(rule) || !literalShellArguments(command)) return false;
  const a = splitCommand(rule);
  const b = splitCommand(command);
  return a.length === 1 && b.length === 1 && [b[0] as string[], ...alternatives]
    .some((words) => sameWords(normalizeWords(a[0] as string[]), normalizeWords(words)));
}

// ---- matching a call ------------------------------------------------------------------------

export interface Call {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  /** The project's root, which relative path patterns are relative to (default `cwd`). */
  root?: string;
  /** Extra programs treated as read-only in shell commands. */
  readOnlyCommands?: readonly string[];
}

const analyses = new WeakMap<Call, BashUnit[]>();

function unitsOf(call: Call): BashUnit[] {
  let found = analyses.get(call);
  if (!found) {
    found = bashUnits(String(call.input.command ?? ""), call.readOnlyCommands ?? []);
    analyses.set(call, found);
  }
  return found;
}

function fileOf(call: Call): string | undefined {
  const kind = ruleTool(call.tool);
  if (kind === "Edit" || kind === "Write") return path.resolve(call.cwd, expandHome(String(call.input.path ?? "")));
  if (kind === "Read") return path.resolve(call.cwd, expandHome(String(call.input.path ?? ".") || "."));
  return undefined;
}

function nameMatches(pattern: string, tool: string): boolean {
  if (pattern.includes("*")) return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u").test(tool);
  return tool === pattern || (pattern.startsWith("mcp__") && tool.startsWith(`${pattern}__`));
}

/**
 * Whether a rule's tool covers a Pi tool. To deny or ask, Edit and Write cover both file-writing
 * tools, as Claude Code's Edit rules do; to allow, each covers its own.
 */
function covers(ruleName: string, tool: string, blocking: boolean): boolean {
  const kind = ruleTool(tool);
  if (ruleName === "Bash" || ruleName === "Edit" || ruleName === "Write" || ruleName === "Read") {
    if (blocking && (ruleName === "Edit" || ruleName === "Write") && (kind === "Edit" || kind === "Write")) return true;
    return kind === ruleName;
  }
  return nameMatches(ruleName, tool);
}

function bare(r: Rule): boolean {
  return !r.command && !r.path;
}

/** Whether a deny or ask rule matches the call. */
function blocks(r: Rule, call: Call): boolean {
  if (!covers(r.tool, call.tool, true)) return false;
  if (bare(r)) return true;
  if (r.command) {
    const command = String(call.input.command ?? "");
    if (r.command.kind === "exact" && sameCommand(r.command.text, command)) return true;
    return unitsOf(call).some((u) => unitMatches(r, u, true));
  }
  const file = fileOf(call);
  return file !== undefined && r.path !== undefined && matchPath(r.path, file, call.root ?? call.cwd);
}

/**
 * Why an allow rule may cover more than it seems to, as Claude Code warns at startup: a `*` before
 * the subcommand (`git * main`, `* --version`) lets it match any subcommand or program, including
 * options that make the program run something else (`git -c core.fsmonitor=...`).
 */
export function ruleWarning(list: RuleList, rule: Rule): string | undefined {
  const c = rule.command;
  if (!c) return undefined;
  if (c.kind === "exact" && !literalShellArguments(c.text)) {
    return "contains shell syntax or incomplete quoting; exact matching requires identical source, and allow rules cover only the whole call";
  }
  if (c.kind === "prefix" && !literalShellArguments(c.text)) {
    return "contains shell syntax or incomplete quoting; prefix words do not preserve expansion semantics";
  }
  if (c.kind === "glob" && /['"\\\\]/u.test(c.text)) {
    return "contains quoting or escaping with a *; stars in permission rules are wildcards even when quoted or escaped";
  }
  if (list !== "allow" || c.kind !== "glob") return undefined;
  const before = c.text.slice(0, c.text.indexOf("*"));
  const words = before.split(" ").slice(0, -1).filter(Boolean);
  return words.length < 2 ? "has a * before the subcommand, so it allows any subcommand or program there" : undefined;
}

/** The deny rule that stops the call, else the ask rule that makes it ask, else undefined. */
export function blocking(rules: readonly ScopedRule[], call: Call): ScopedRule | undefined {
  for (const list of ["deny", "ask"] as const) {
    const hit = rules.find((r) => r.list === list && blocks(r.rule, call));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The allow rules that open the call, or undefined. A bare rule (`Bash`, `web_fetch`) covers every
 * call of its tool; a command rule must cover every part of a shell call that does more than read,
 * or be the call's exact text; a path rule covers the file. With `exact` (calls the gate always
 * holds) only a rule naming the exact command, or a wildcard-free path, opens it.
 */
export function allowing(rules: readonly ScopedRule[], call: Call, exact = false): ScopedRule[] | undefined {
  const mine = rules.filter((r) => r.list === "allow" && covers(r.rule.tool, call.tool, false));
  if (!mine.length) return undefined;
  const root = call.root ?? call.cwd;
  if (ruleTool(call.tool) !== "Bash") {
    const file = fileOf(call);
    const hit = mine.find((r) =>
      bare(r.rule) ? !exact : file !== undefined && r.rule.path !== undefined && matchPath(r.rule.path, file, root, exact));
    return hit ? [hit] : undefined;
  }
  const command = String(call.input.command ?? "");
  const whole = mine.find((r) => r.rule.command?.kind === "exact" && sameCommand(r.rule.command.text, command));
  if (whole) return [whole];
  if (exact) return undefined;
  const everything = mine.find((r) => bare(r.rule));
  if (everything) return [everything];
  const units = unitsOf(call).filter((u) => !u.nested);
  if (!units.length || unitsOf(call).some((u) => u.opaque) || units.some((u) => u.unparsed)) return undefined;
  // Parts that do more than read need a rule. A call held only for a substitution or redirect, whose
  // parts all read, needs one for each of its commands.
  const acting = units.filter((u) => !u.read || u.writes);
  const required = acting.length ? acting : units.filter((u) => u.key !== undefined);
  if (!required.length) return undefined;
  const used = new Set<ScopedRule>();
  for (const u of required) {
    const rule = mine.find((r) => unitMatches(r.rule, u, false));
    if (!rule) return undefined;
    used.add(rule);
  }
  return [...used];
}

/** The allow rule that covers writing or reading `file` with `tool`, for the directory policy (derived paths are never opened by one). */
export function allowsPath(rules: readonly ScopedRule[], tool: string, file: string, root: string): boolean {
  return rules.some((r) => r.list === "allow" && covers(r.rule.tool, tool, false) && r.rule.path !== undefined && matchPath(r.rule.path, file, root));
}

// ---- suggestions ----------------------------------------------------------------------------

/** Programs whose arguments are the risk: their rules name the exact command. */
const EXACT_PROGRAMS = new Set([
  "rm", "mv", "chmod", "chown", "chgrp", "dd", "curl", "wget", "ssh", "scp", "rsync", "nc", "ncat", "netcat", "sudo", "doas", "eval",
]);
const SHELL_PROGRAMS = /^(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish)$/u;
const SCRIPT_RUNNERS = /^(?:sh|bash|zsh|dash|ksh|python[0-9.]*|node|nodejs|bun|ruby|perl|php)$/u;
const INLINE_FLAGS: Array<[RegExp, RegExp]> = [
  [SHELL_PROGRAMS, /^-[A-Za-z]*c[A-Za-z]*$/u],
  [/^python[0-9.]*$/u, /^-[A-Za-z]*c$/u],
  [/^(?:node|nodejs|bun)$/u, /^(?:-e|-p|--eval|--print)$/u],
  [/^(?:ruby|perl)$/u, /^-[A-Za-z]*[eE]$/u],
  [/^(?:php)$/u, /^-r$/u],
  [/^(?:lua|osascript)$/u, /^-e$/u],
];

/** Inline code (`python -c`, `node -e`, `bash -c`), or an interpreter fed its script on stdin. */
function runsInlineCode(u: BashUnit): boolean {
  const p = u.program;
  if (!p) return false;
  if (p.name === "deno" && p.args[0] === "eval") return true;
  if (INLINE_FLAGS.some(([name, flag]) => name.test(p.name) && p.args.some((a) => flag.test(a)))) return true;
  return SCRIPT_RUNNERS.test(p.name) && !p.args.some((a) => a !== "-" && !a.startsWith("-"));
}

function quoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/u.test(word) ? word : `'${word.replace(/'/gu, "'\\''")}'`;
}

/** The rule for exactly this command, or undefined when its text could not be read back as exact (a trailing `*`). */
function exactRule(command: string): string | undefined {
  const text = command.trim();
  // A `*` in a rule is a wildcard: a command with one cannot be named exactly.
  if (!text || text.includes("*")) return undefined;
  const rule = `Bash(${text})`;
  const parsed = parseRule(rule);
  return parsed.ok && parsed.rule.command?.kind === "exact" ? rule : undefined;
}

/**
 * The rule for one command: a prefix of its program and subcommands, or exactly the command when its
 * arguments are the risk (`exact`). Undefined when the command has an expansion that an exact rule
 * could not name.
 */
function unitRule(u: BashUnit): { rule: string; exact: boolean } | undefined {
  const name = u.program?.name ?? "";
  const keyWords = (u.key ?? "").split(" ");
  const exact = () => {
    const rule = literalShellArguments(u.source) ? exactRule(u.source) : undefined;
    return rule ? { rule, exact: true } : undefined;
  };
  if (u.opaque) return undefined;
  if (EXACT_PROGRAMS.has(name) || u.key?.startsWith("gh api") || runsInlineCode(u)) return exact();
  let words = keyWords;
  const typed = normalizeWords([u.invoked ?? name])[0] as string;
  if (u.invoked?.includes("/") && !/^\/(?:usr\/)?bin\//u.test(u.invoked)) words = [typed, ...keyWords.slice(1)];
  // A script runner's prefix names the script: `python3 scripts/x.py`, not every `python3`. With options
  // before the script, nothing short of the whole command does.
  if (SCRIPT_RUNNERS.test(name) && keyWords.length === 1) {
    const script = u.program?.args[0];
    if (script === undefined || script.startsWith("-")) return exact();
    words = [name, script];
  }
  // Copied words are not user-authored patterns. A literal star would turn this into a glob.
  if (words.some((word) => word.includes("*"))) return exact();
  const rule = `Bash(${words.map(quoteWord).join(" ")}:*)`;
  const parsed = parseRule(rule);
  return parsed.ok && parsed.rule.command?.kind === "prefix" ? { rule, exact: false } : exact();
}

/** The rules to offer for a shell call: one per key of `bashKeys`, each a prefix or, for risky programs, the exact command. */
export function suggestBash(command: string, readOnlyCommands: readonly string[] = []): string[] {
  const whole = exactRule(command);
  const heredoc = /<<-?\s*\\?['"]?[A-Za-z_]/u.test(command);
  const units = bashUnits(command, readOnlyCommands);
  const acting = units.filter((u) => !u.nested && !u.read);
  if (!acting.length || units.some((u) => u.opaque) || acting.some((u) => u.unparsed)) return whole ? [whole] : [];
  const rules = new Set<string>();
  for (const u of acting) {
    const r = unitRule(u);
    // A here-document is the program's input: when the program runs its input as code, or its
    // arguments are the risk, only the whole call names it. `git commit -F - <<EOF` is a prefix.
    if (!r || (heredoc && r.exact)) return whole ? [whole] : [];
    rules.add(r.rule);
  }
  return [...rules].sort();
}

/**
 * `Edit(src/a/**)` for a file in `src/a`: its folder, relative to the project when inside it, else
 * under `~` or absolute. A file directly in the project, in home or in `/` is named itself, since a
 * pattern for its folder would cover everything below it.
 */
function folderRule(kind: string, file: string, root: string): string {
  const dir = path.dirname(file);
  const home = homedir();
  const rel = path.relative(root, dir);
  let pattern: string;
  if (rel === "") pattern = `./${path.basename(file)}`;
  else if (!rel.startsWith("..") && !path.isAbsolute(rel)) pattern = `${rel}/**`;
  else if (dir === home) pattern = `~/${path.basename(file)}`;
  else if (dir.startsWith(`${home}/`)) pattern = `~/${path.relative(home, dir)}/**`;
  else pattern = dir === "/" ? `/${path.basename(file)}` : `${dir}/**`;
  return `${kind}(${pattern})`;
}

/**
 * The rules the approval dialog offers to allow a call (none when no rule can name it): shell calls
 * by what they run, `edit` and `write` by their folder, other tools by name. Reads are not offered.
 */
export function suggest(call: Call): string[] {
  const kind = ruleTool(call.tool);
  if (kind === "Bash") return suggestBash(String(call.input.command ?? ""), call.readOnlyCommands);
  if (kind === "Edit" || kind === "Write") {
    const file = fileOf(call);
    return file ? [folderRule(kind, file, call.root ?? call.cwd)] : [];
  }
  if (kind === "Read") return [];
  return parseRule(call.tool).ok ? [call.tool] : [];
}

// ---- grants saved before rules existed ------------------------------------------------------

export type Migrated =
  | { kind: "rule"; list: RuleList; text: string }
  | { kind: "dir"; key: string; access: "read" | "write"; dir: string };

/**
 * What a saved project grant key means now: new keys are `allow:<rule>` (also `ask:`, `deny:`);
 * `bash:<key>` is `Bash(<key>:*)`, `tool:<x>` is `<x>`, `edit:<dir>` and `write:<dir>` are
 * `Edit(<dir>/**)` and `Write(<dir>/**)`; `dir:` keys stay folder grants. A key for reads with
 * substitutions or redirects has no rule that says it and is dropped.
 */
export function migrateGrant(key: string): Migrated | undefined {
  const listed = /^(allow|ask|deny):([\s\S]+)$/u.exec(key);
  if (listed) return { kind: "rule", list: listed[1] as RuleList, text: listed[2] as string };
  const dir = /^dir:(read|write):(.+)$/u.exec(key);
  if (dir) return { kind: "dir", key, access: dir[1] as "read" | "write", dir: dir[2] as string };
  const bash = /^bash:([\s\S]+)$/u.exec(key);
  if (bash) {
    const k = bash[1] as string;
    if (k === READS_KEY) return undefined;
    if (k.startsWith("unparsed shell: ")) {
      const exact = exactRule(k.slice("unparsed shell: ".length));
      return exact ? { kind: "rule", list: "allow", text: exact } : undefined;
    }
    return { kind: "rule", list: "allow", text: `Bash(${k}:*)` };
  }
  const tool = /^tool:(.+)$/u.exec(key);
  if (tool) return { kind: "rule", list: "allow", text: tool[1] as string };
  const folder = /^(edit|write):(.+)$/u.exec(key);
  if (folder) return { kind: "rule", list: "allow", text: `${folder[1] === "edit" ? "Edit" : "Write"}(${(folder[2] as string).replace(/\/+$/u, "")}/**)` };
  return undefined;
}

/** The key a rule is saved under in the machine-local project file. */
export function ruleKey(list: RuleList, text: string): string {
  return `${list}:${text}`;
}

export const SESSION: Origin = { scope: "session", shared: false, source: "this session", writable: true };

export function localOrigin(file: string): Origin {
  return { scope: "project", shared: false, source: file, writable: true };
}

/** Rules and folder grants in this project's machine-local grants, migrating the old keys. */
export function localGrants(grants: readonly Grant[], file: string): { rules: ScopedRule[]; dirs: Extract<Migrated, { kind: "dir" }>[]; ignored: IgnoredRule[] } {
  const rules: ScopedRule[] = [];
  const dirs: Extract<Migrated, { kind: "dir" }>[] = [];
  const ignored: IgnoredRule[] = [];
  const origin = localOrigin(file);
  for (const g of grants) {
    const m = migrateGrant(g.key);
    if (!m) continue;
    if (m.kind === "dir") {
      dirs.push(m);
      continue;
    }
    const parsed = parseRule(m.text);
    if (parsed.ok) rules.push({ list: m.list, text: parsed.rule.text, raw: m.text, rule: parsed.rule, origin, key: g.key });
    else ignored.push({ list: m.list, raw: m.text, error: parsed.error, origin });
  }
  return { rules, dirs, ignored };
}

export function sessionRule(list: RuleList, raw: string): ScopedRule | undefined {
  const parsed = parseRule(raw);
  return parsed.ok ? { list, text: parsed.rule.text, raw, rule: parsed.rule, origin: SESSION } : undefined;
}

// ---- rule files -----------------------------------------------------------------------------

export interface PolicyLoadError {
  source: string;
  error: string;
}

export interface FileRules {
  rules: ScopedRule[];
  ignored: IgnoredRule[];
  errors: PolicyLoadError[];
}

export interface PersistenceOptions {
  project?: "local" | "shared";
  userWritable?: boolean;
}

/** Missing files are normal; existing invalid policies must remain visible to the caller. */
function readPolicy(file: string): Record<string, unknown> {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!isRecord(json)) throw new Error(`${file} is not a JSON object`);
  return json;
}

function readRuleFile(file: string, origin: Origin): FileRules {
  const rules: ScopedRule[] = [];
  const ignored: IgnoredRule[] = [];
  const errors: PolicyLoadError[] = [];
  try {
    const permissions = readPolicy(file).permissions;
    if (isRecord(permissions)) {
      for (const list of LISTS) {
        const entries = permissions[list];
        if (!Array.isArray(entries)) continue;
        for (const raw of entries) {
          if (typeof raw !== "string") continue;
          const parsed = parseRule(raw);
          if (parsed.ok) rules.push({ list, text: parsed.rule.text, raw, rule: parsed.rule, origin });
          else ignored.push({ list, raw, error: parsed.error, origin });
        }
      }
    }
  } catch (error) {
    errors.push({ source: file, error: error instanceof Error ? error.message : String(error) });
  }
  return { rules, ignored, errors };
}

/** Merged permission lists, user scopes then active shared policy and main-checkout local policy. */
export function loadFileRules(project: ProjectContext | string, options: PersistenceOptions = {}): FileRules {
  const context = typeof project === "string" ? { cwd: project, root: project, main: project, isGit: false } : project;
  const rules: ScopedRule[] = [];
  const ignored: IgnoredRule[] = [];
  const errors: PolicyLoadError[] = [];
  const local = path.join(context.main, ".pi", "tool-gate.local.json");
  const destination = options.project === "shared" ? path.join(context.root, ".pi", "tool-gate.json") : local;
  const files: Origin[] = [
    { scope: "user", shared: true, source: path.join(sharedConfigDir(), "tool-gate.json"), writable: false },
    { scope: "user", shared: false, source: userRulesFile(), writable: options.userWritable !== false },
    ...projectFiles(context).map((file): Origin => ({
      scope: "project", shared: file !== local, source: file, writable: file === destination,
    })),
  ];
  // Read afresh: neither same-tick file replacements nor changed persistence options may retain
  // stale policy or origins.
  for (const origin of files) {
    const read = readRuleFile(origin.source, origin);
    rules.push(...read.rules);
    ignored.push(...read.ignored);
    errors.push(...read.errors);
  }
  return { rules, ignored, errors };
}

/** Your user rules' file: `~/.pi/agent/tool-gate.json` (`PI_CODING_AGENT_DIR` honored). */
export function userRulesFile(): string {
  return path.join(agentDir(), "tool-gate.json");
}

const mutations = new Map<string, Promise<void>>();

/** Serialize in-process writers as well as other sessions, rereading only after acquiring the lock. */
async function editPolicy(file: string, mutate: (json: Record<string, unknown>) => void): Promise<void> {
  file = path.resolve(file);
  const previous = mutations.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const lockFile = `${file}.lock`;
    const deadline = Date.now() + 2_000;
    let lock;
    while (!lock) {
      try {
        lock = await open(lockFile, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Policy file is busy; no changes were saved.");
        await delay(Math.min(50, remaining));
        if (Date.now() >= deadline) throw new Error("Policy file is busy; no changes were saved.");
      }
    }
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const json = readPolicy(file);
      mutate(json);
      await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`, { flag: "wx" });
      await rename(tmp, file);
    } finally {
      try {
        await unlink(tmp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      } finally {
        try { await lock.close(); } finally { await unlink(lockFile); }
      }
    }
  });
  mutations.set(file, pending);
  try {
    await pending;
  } finally {
    if (mutations.get(file) === pending) mutations.delete(file);
  }
}

function editList(json: Record<string, unknown>, section: string, list: string, op: "add" | "remove", raw: string, equivalent = (entry: unknown) => entry === raw): void {
  const block = isRecord(json[section]) ? { ...json[section] } : {};
  const current: unknown[] = Array.isArray(block[list]) ? [...block[list] as unknown[]] : [];
  const next = op === "add" ? (current.some(equivalent) ? current : [...current, raw]) : current.filter((entry) => !equivalent(entry));
  if (next.length) block[list] = next;
  else delete block[list];
  if (Object.keys(block).length) json[section] = block;
  else delete json[section];
}

/** Add/remove a rule without changing unrelated policy fields. Rejects invalid existing JSON. */
export async function editRulesFile(file: string, operation: "add" | "remove", list: RuleList, raw: string): Promise<void> {
  await editPolicy(file, (json) => editList(json, "permissions", list, operation, raw));
}

function homeGrant(dir: string): string {
  if (dir === "*") return dir;
  const absolute = path.resolve(expandHome(dir));
  const home = homedir();
  return absolute === home ? "~" : absolute.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, absolute)}` : absolute;
}

/** Store home-relative directory grants, deduplicating absolute and home-relative spellings. */
export async function editDirectoryGrant(file: string, operation: "add" | "remove", access: "read" | "write", dir: string): Promise<void> {
  if (operation === "add" && /[*?]/u.test(dir)) {
    throw new Error("This folder contains wildcard characters and cannot be saved as a literal grant. Allow once instead.");
  }
  const normalized = homeGrant(dir);
  await editPolicy(file, (json) => editList(json, "directories", access, operation, normalized,
    (entry) => typeof entry === "string" && homeGrant(entry) === normalized));
}

/** Backward-compatible user-file wrapper; callers must await the save. */
export async function editUserRules(op: "add" | "remove", list: RuleList, raw: string, file = userRulesFile()): Promise<void> {
  await editRulesFile(file, op, list, raw);
}

// ---- describing -----------------------------------------------------------------------------

export function scopeLabel(o: Origin): string {
  if (o.scope === "session") return "session";
  if (o.scope === "project") return o.shared ? "project (shared)" : path.basename(o.source) === "project-grants.json" ? "project (this machine)" : "project (local)";
  return o.shared ? "user (shared)" : "user";
}

/** Where a rule came from: the scope, and the file when it has one. */
export function describeOrigin(o: Origin, shown: (file: string) => string = (f) => f): string {
  return o.scope === "session" ? "session" : `${scopeLabel(o)}: ${shown(o.source)}`;
}
