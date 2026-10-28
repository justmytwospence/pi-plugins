import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Programs that only read, whatever their arguments (special cases are checked in
 * `readsDespiteArgs`). The list is conservative: a program whose arguments can make it write,
 * delete, run other programs or change the system is checked below, and anything it is unsure
 * about goes to Jev rather than running unasked.
 */
const READ_ONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "rg", "grep", "egrep", "fgrep", "ag", "fd", "find",
  "tree", "pwd", "echo", "printf", "which", "type", "whoami", "id", "date", "uname", "hostname", "env",
  "printenv", "stat", "file", "du", "df", "diff", "cmp", "sort", "uniq", "cut", "tr", "column", "nl", "jq",
  "yq", "basename", "dirname", "realpath", "readlink", "sha256sum", "shasum", "md5", "md5sum", "true",
  "false", "test", "ps", "uptime", "sed", "awk", "comm", "tac", "rev", "xxd", "od", "strings", "man",
  "history", "lsof", "cd", "sleep", "dig", "nslookup", "host", "ping", "traceroute", "ss",
  "netstat", "ifconfig", "ip", "free", "vm_stat", "pgrep", "nproc", "sysctl", "sw_vers",
  "lsblk", "mount", "groups", "locale", "xxd", "base64", "sha1sum", "cksum", "column",
]);

/** `<tool> <sub>` subcommands of other CLIs that only read. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  docker: new Set(["ps", "logs", "inspect", "images", "image", "stats", "top", "version", "info", "port", "diff", "history", "network", "volume", "context", "events"]),
  podman: new Set(["ps", "logs", "inspect", "images", "stats", "top", "version", "info", "port"]),
  kubectl: new Set(["get", "describe", "logs", "explain", "top", "version", "api-resources", "config"]),
  gh: new Set(["pr", "issue", "run", "repo", "release", "search", "status", "workflow"]),
  systemctl: new Set(["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "show", "cat"]),
  journalctl: new Set(["*"]),
  launchctl: new Set(["list", "print"]),
  sqlite3: new Set(["-readonly"]),
  // Not `execute-template` (its template can run commands) or `apply`/`add`/`edit`/`init`/`update`/...
  chezmoi: new Set(["cat", "cat-config", "diff", "status", "managed", "unmanaged", "ignored", "source-path", "target-path", "data", "dump", "dump-config", "verify", "doctor", "help"]),
};

/** Words that make a CLI subcommand change something, e.g. `gh pr merge`, `docker network rm`. */
const MUTATING_WORDS = /^(create|delete|rm|remove|merge|close|reopen|edit|comment|review|approve|apply|set|add|prune|kill|stop|start|restart|run|exec|cp|push|pull|login|logout|enable|disable|mask|unmask|reload|deploy|upload|download|clone|fork|rename|archive|transfer|sync|cancel|rerun|dispatch|use-context|set-context|delete-context|connect|disconnect|update|upgrade|install|uninstall|write|import|export|tag|untag|load|save|build|commit|attach|pause|unpause|scale|rollout|patch|replace|label|annotate|taint|drain|cordon|uncordon|expose|autoscale|certificate)$/u;

/** `kubectl config` verbs that only read; every other one (`use-context`, `set-*`, `delete-*`, `unset`) writes the kubeconfig. */
const KUBECTL_CONFIG_READS = new Set(["view", "current-context", "get-contexts", "get-clusters", "get-users"]);

/** Match short flags even when clustered or followed immediately by their value. */
function shortOption(args: readonly string[], letters: string): boolean {
  return args.some((a) => new RegExp(`^-[^-]*[${letters}]`, "u").test(a));
}

/** A plain HTTP GET with curl or wget. Unknown options go to judgment, not the read-only path. */
function isReadOnlyFetch(name: string, args: readonly string[]): boolean {
  const curl = name === "curl";
  const flags = new Set(curl
    ? ["--silent", "--show-error", "--fail", "--fail-with-body", "--location", "--head", "--include", "--verbose", "--compressed", "--globoff", "--no-buffer", "--disable", "--ipv4", "--ipv6"]
    : ["--quiet", "--no-verbose", "--verbose", "--server-response", "--spider", "--no-check-certificate"]);
  const values = new Set(curl
    ? ["--url", "--header", "--user-agent", "--cookie", "--referer", "--max-time", "--connect-timeout", "--retry", "--user", "--proxy", "--request"]
    : ["--header", "--user-agent", "--timeout", "--connect-timeout", "--tries", "--output-document"]);
  const shortFlags = curl ? "sSfLIivNqg46" : "qvSd";
  const shortValues = curl ? "HAbemuxX" : "OUT";
  let stdout = curl;
  let operands = false;
  const valueAllowed = (option: string, value: string | undefined): boolean => {
    if (value === undefined) return false;
    if (option === "X" || option === "--request") return value === "GET";
    if (option === "O" || option === "--output-document") {
      stdout = value === "-";
      return stdout;
    }
    return true;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--" && !operands) { operands = true; continue; }
    if (operands || !a.startsWith("-")) {
      if (!/^https?:\/\//u.test(a)) return false;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const option = eq < 0 ? a : a.slice(0, eq);
      if (flags.has(option) && eq < 0) {
        if (option === "--spider") stdout = true;
      } else if (values.has(option)) {
        if (!valueAllowed(option, eq < 0 ? args[++i] : a.slice(eq + 1))) return false;
      } else return false;
    } else {
      for (let j = 1; j < a.length; j++) {
        const option = a[j] as string;
        if (shortFlags.includes(option)) continue;
        if (!shortValues.includes(option)) return false;
        if (!valueAllowed(option, a.slice(j + 1) || args[++i])) return false;
        break;
      }
      if (a === "-") return false;
    }
  }
  return stdout;
}

/** `git <sub>` subcommands that only read (some need their own arguments checked, see `isReadOnlyGit`). */
const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "describe",
  "shortlog", "reflog", "cat-file", "grep", "remote", "tag", "config", "worktree", "stash", "merge-base",
  "name-rev", "for-each-ref", "show-ref", "rev-list", "whatchanged", "check-ignore",
]);

/** Git global options that take their value as the next token. */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--attr-source"]);
/** Git global options that change what runs: config overrides and the exec path. */
const GIT_GLOBAL_UNSAFE = /^(-c|--config-env|--exec-path|--super-prefix)(=|$)|^-c./u;

interface GitCommand {
  sub: string;
  /** Arguments after the subcommand. */
  args: string[];
  /** A `-c key=value` override, `--exec-path` or `--config-env`: the subcommand may not do what it says. */
  unsafeGlobal: boolean;
}

/** The git subcommand and its arguments, past global options like `-C dir` and `--no-pager`. */
export function gitCommand(args: readonly string[]): GitCommand | undefined {
  let unsafeGlobal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("-")) return { sub: a, args: args.slice(i + 1), unsafeGlobal };
    if (GIT_GLOBAL_UNSAFE.test(a)) unsafeGlobal = true;
    if (GIT_GLOBAL_WITH_VALUE.has(a)) i++;
  }
  return undefined;
}

/** Whether `git <sub> <args>` only reads. */
function isReadOnlyGit(g: GitCommand): boolean {
  const { sub, args } = g;
  if (g.unsafeGlobal || !READ_ONLY_GIT.has(sub)) return false;
  const positional = args.filter((a) => !a.startsWith("-"));
  // `--output=<file>` writes the diff or log to a file; `-O` opens matches in a pager/editor.
  if (args.some((a) => /^--(output|ext-diff|textconv|filters)(=|$)/u.test(a))) return false;
  if (sub === "grep" && (shortOption(args, "O") || args.some((a) => a.startsWith("--open-files-in-pager")))) return false;
  if (sub === "branch") {
    if (shortOption(args, "dDmMcCufFt") || args.some((a) => /^--(delete|move|copy|force|track|set-upstream-to|unset-upstream|edit-description|create-reflog)(=|$)/u.test(a))) return false;
    // `-l` is --create-reflog, NOT --list: `git branch -l name` creates a branch.
    const listing = args.some((a) => /^(--list|--contains|--no-contains|--merged|--no-merged|--points-at)(=|$)/u.test(a));
    return positional.length === 0 || listing;
  }
  if (sub === "tag") {
    if (shortOption(args, "dDasfmFue") || args.some((a) => /^--(delete|annotate|sign|force|message|file|local-user|edit|cleanup|create-reflog)(=|$)/u.test(a))) return false;
    // `git tag <name>` creates a tag; a name is only a pattern after a listing or verify option.
    const listing = args.some((a) => /^(-l|-v|-n\d*|--list|--verify|--contains|--no-contains|--merged|--no-merged|--points-at)(=|$)/u.test(a));
    return positional.length === 0 || listing;
  }
  if (sub === "remote") return !positional.some((a) => ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(a));
  if (sub === "reflog") return positional.length === 0 || positional[0] === "show";
  if (sub === "config") {
    if (shortOption(args, "e") || args.some((a) => /^--(add|replace-all|unset|unset-all|rename-section|remove-section|edit)(=|$)/u.test(a))) return false;
    if (["get", "list"].includes(positional[0] ?? "")) return true;
    // --show-origin and --show-scope modify output, but do not select a read operation.
    return args.some((a) => ["--get", "--list", "-l", "--get-all", "--get-regexp"].includes(a));
  }
  if (sub === "stash") return positional.length > 0 && ["list", "show"].includes(positional[0] as string);
  if (sub === "worktree") return positional[0] === "list";
  return true;
}

/** `<pm> <sub>` subcommands of package managers that only read. */
const READ_ONLY_PM: Record<string, Set<string>> = {
  npm: new Set(["ls", "list", "view", "info", "outdated", "explain", "why", "root", "prefix", "config", "help", "search"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "root"]),
  yarn: new Set(["list", "why", "info", "outdated"]),
  cargo: new Set(["tree", "metadata", "search"]),
  pip: new Set(["list", "show", "freeze"]),
  uv: new Set(["tree"]),
  brew: new Set(["list", "info", "search", "outdated", "deps", "--prefix"]),
};

/**
 * Split a shell command into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines, keeping
 * quoted text intact. Each part is tokenized with quotes removed.
 */
export function splitCommand(command: string): string[][] {
  return splitParts(command).map((p) => p.tokens);
}

/** A simple command from `splitParts`: its tokens, and where its text starts in the command. */
export interface Part {
  tokens: string[];
  start: number;
}

/** `splitCommand`, keeping where each part starts. */
function splitParts(command: string): Part[] {
  const parts: Part[] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;
  let start = 0;
  /** Where the last unquoted, unescaped `>` is: only that one makes `>&` and `>|` redirects. */
  let redirectAt = -1;
  const endToken = () => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endPart = () => {
    endToken();
    if (tokens.length) parts.push({ tokens, start });
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && /[$`"\\\n]/u.test(command[i + 1] ?? "")) {
        if (command[++i] !== "\n") token += command[i];
      }
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === "\\" && i + 1 < command.length) {
      if (command[++i] !== "\n") { token += command[i]; inToken = true; }
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      // `2>&1`, `&>` and `>|` stay inside the token stream as redirects, not separators.
      if ((c === "&" && command[i + 1] === ">") || ((c === "&" || c === "|") && redirectAt === i - 1)) {
        token += c;
        inToken = true;
        continue;
      }
      endPart();
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
      start = i + 1;
    } else if (c === " " || c === "\t") {
      endToken();
    } else {
      if (c === ">") redirectAt = i;
      token += c;
      inToken = true;
    }
  }
  endPart();
  return parts;
}

/**
 * Environment variables that change what a program runs or where it reads and writes: a command
 * that sets one of them is not read-only whatever the program is (`PAGER='sh -c ...' git log`).
 */
const UNSAFE_ENV = /^(PATH|LD_[A-Z_]*|DYLD_[A-Z_]*|GIT_[A-Z_]*|PAGER|MANPAGER|EDITOR|VISUAL|SHELL|HOME|BASH_ENV|ENV|IFS|CDPATH|LESS.*|RIPGREP_CONFIG_PATH|AWKPATH|AWKLIBPATH|CURL_HOME|WGETRC|PERL5OPT|PYTHONSTARTUP|NODE_OPTIONS|RUBYOPT|TMPDIR|XDG_CONFIG_HOME)$/u;

/** Wrappers that run their last arguments as the real command, after options of their own. */
const WRAPPERS = new Set(["time", "nice", "command", "builtin", "nohup", "exec", "env", "timeout", "stdbuf", "setsid", "caffeinate", "chronic", "unbuffer"]);
/** Wrapper options that take their value as the next token. */
const WRAPPER_OPTION_WITH_VALUE: Record<string, Set<string>> = {
  nice: new Set(["-n", "--adjustment"]),
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};

/**
 * The program a simple command runs and its arguments, past leading `FOO=bar` assignments and
 * wrappers like `time`, `nice -n 10`, `env -i`, `nohup` and `timeout 5`. `unsafe` is set when an
 * assignment or wrapper option can change what the program does (`PATH=…`, `env -S …`).
 */
export function program(tokens: string[]): { name: string; args: string[]; unsafe: boolean } | undefined {
  let i = 0;
  let unsafe = false;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i] as string)) {
      if (UNSAFE_ENV.test((tokens[i] as string).split("=", 1)[0] as string)) unsafe = true;
      i++;
    }
    const head = tokens[i];
    if (head === undefined || !WRAPPERS.has(head)) break;
    i++;
    // nohup can create nohup.out even when its child only reads. Other complex wrappers
    // also need judgment; stripping them is only useful for the approval key/fixed holds.
    if (!["time", "nice", "command", "builtin", "env", "timeout"].includes(head)) unsafe = true;
    const withValue = WRAPPER_OPTION_WITH_VALUE[head];
    while (i < tokens.length && (tokens[i] as string).startsWith("-")) {
      const opt = tokens[i++] as string;
      if (opt === "--") break;
      const safeOption =
        (head === "time" && opt === "-p") ||
        (head === "nice" && /^(?:-n|--adjustment(?:=.+)?|-\d+)$/u.test(opt)) ||
        (head === "command" && /^-[pvV]+$/u.test(opt)) ||
        (head === "env" && ["-i", "--ignore-environment", "-u", "--unset"].includes(opt)) ||
        (head === "timeout" && /^(?:-[sk]|--(?:signal|kill-after)(?:=.+)?|--preserve-status|--foreground|--verbose)$/u.test(opt));
      if (!safeOption) unsafe = true;
      if (head === "env" && (opt === "-u" || opt === "--unset") && UNSAFE_ENV.test(tokens[i] ?? "")) unsafe = true;
      if (withValue?.has(opt)) i++;
    }
    // `timeout [options] DURATION command`.
    if (head === "timeout" && i < tokens.length && /^\d+(\.\d+)?[smhd]?$/u.test(tokens[i] as string)) i++;
  }
  const name = tokens[i];
  if (name === undefined) return unsafe ? { name: "", args: [], unsafe } : undefined;
  // A project script called ./ls is not the system ls.
  if (name.includes("/") && !/^\/(?:usr\/)?bin\/[^/]+$/u.test(name)) unsafe = true;
  return { name: path.basename(name), args: tokens.slice(i + 1), unsafe };
}

/**
 * Output redirects that write a file: `> out.txt`, `>> log`, `&> all`, `>| f`, `>& f`, `<> f`. Not
 * `/dev/null` or fd duplication (`2>&1`, `>&-`).
 */
export function writeRedirects(command: string): string[] {
  return redirectsAt(command).map((r) => r.target);
}

/** `writeRedirects`, with where each redirect starts in the command. */
export function redirectsAt(command: string): { target: string; at: number }[] {
  const targets: { target: string; at: number }[] = [];
  const re = /(?<![<>])(?:[0-9]*|&)(>>?|<>)\|?(&?)\s*([^\s;|&<>]*)/gu;
  // Match on a copy whose quoted and escaped characters are masked, so `sed 's/<[^>]*>/ /g'` has
  // no redirect; the target is then read back from the original and unquoted.
  const masked = maskQuoted(command);
  for (const match of masked.matchAll(re)) {
    const dup = match[2] === "&";
    const start = (match.index ?? 0) + match[0].length - (match[3] as string).length;
    const target = command.slice(start, (match.index ?? 0) + match[0].length).replace(/\\(.)|["']/gu, "$1");
    // `2>&1`, `>&-`: duplicating or closing a descriptor, not a file.
    if (dup && (/^\d+$/u.test(target) || target === "-")) continue;
    const at = match.index ?? 0;
    // A redirect with no target is a syntax error, or something this parser does not follow.
    if (target === "") {
      targets.push({ target: ">", at });
      continue;
    }
    if (target !== "/dev/null") targets.push({ target, at });
  }
  return targets;
}

/** `command` with every character inside quotes, or after a backslash, replaced by `x` (quotes kept). */
function maskQuoted(command: string): string {
  let out = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { out += c === "'" ? ((quote = undefined), c) : "x"; continue; }
    if (c === "\\" && i + 1 < command.length) { out += "xx"; i++; continue; }
    if (c === quote) { quote = undefined; out += c; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; out += c; continue; }
    out += quote ? "x" : c;
  }
  return out;
}

/** Expansions can hide options or executable names. Only literal shell words are auto-approved. */
function plainShell(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = undefined; continue; }
    if (c === "\\") { i++; continue; }
    if (c === quote) { quote = undefined; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; continue; }
    if (c === "$" || c === "`" || (!quote && (c === "(" || c === ")"))) return false;
    if (!quote && c === "<" && command[i + 1] === "<") return false;
  }
  return quote === undefined;
}

/** True when every simple command in `command` only reads. */
export function isReadOnlyBash(command: string, extra: readonly string[] = []): boolean {
  if (!plainShell(command)) return false;
  if (writeRedirects(command).length) return false;
  const parts = splitCommand(command);
  if (parts.length === 0) return false;
  return parts.every((tokens) => isReadOnlyPart(tokens, extra));
}

/** The sed scripts in `args`: the `-e`/`--expression` values, else the first operand. */
function sedScripts(args: readonly string[]): { scripts: string[]; scriptFile: boolean } {
  const scripts: string[] = [];
  let scriptFile = false;
  let first: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-e" || a === "--expression") scripts.push(args[++i] ?? "");
    else if (/^-[a-zA-Z]*e./u.test(a)) scripts.push(a.slice(a.indexOf("e") + 1));
    else if (a.startsWith("--expression=")) scripts.push(a.slice("--expression=".length));
    else if (a === "-f" || a === "--file" || /^-[a-zA-Z]*f/u.test(a) || a.startsWith("--file")) scriptFile = true;
    else if (a === "-l" || a === "--line-length") i++;
    else if (!a.startsWith("-") && first === undefined) first = a;
  }
  if (!scripts.length && first !== undefined) scripts.push(first);
  return { scripts, scriptFile };
}

/**
 * Whether a sed script can write a file or run a command: the `w`/`W` commands, `s///w file`,
 * and GNU sed's `e` command and `s///e` flag. The script is scanned command by command, so a
 * `w` inside `s/new/word/`, appended text, a label or a comment is not a command. Conservative:
 * anything the scanner cannot follow counts as writing.
 */
export function sedWrites(script: string): boolean {
  const s = script;
  const n = s.length;
  let i = 0;
  const at = () => s[i] ?? "";
  /** Past a `<d>…<d>` operand whose opening delimiter was consumed; false when unterminated. */
  const operand = (d: string): boolean => {
    while (i < n) {
      const c = s[i] as string;
      if (c === "\\") {
        i += 2;
        continue;
      }
      i++;
      if (c === d) return true;
    }
    return false;
  };
  const toLineEnd = () => {
    while (i < n && s[i] !== "\n") i++;
  };
  /** One address (`12`, `$`, `3~2`, `/re/`, `\cREc`); false when it cannot be followed. */
  const address = (): boolean => {
    const c = at();
    if (/[0-9]/u.test(c)) {
      while (/[0-9]/u.test(at())) i++;
      if (at() === "~") {
        i++;
        while (/[0-9]/u.test(at())) i++;
      }
      return true;
    }
    if (c === "$") {
      i++;
      return true;
    }
    if (c === "/") {
      i++;
      return operand("/");
    }
    if (c === "\\") {
      i++;
      const d = s[i++];
      return d !== undefined && d !== "\n" && operand(d);
    }
    return true;
  };
  const startsAddress = (c: string) => /[0-9$/\\]/u.test(c);
  while (i < n) {
    const c = at();
    if (/[\s;]/u.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      toLineEnd();
      continue;
    }
    if (startsAddress(c)) {
      if (!address()) return true;
      while (/[ \t]/u.test(at())) i++;
      if (at() === ",") {
        i++;
        while (/[ \t]/u.test(at())) i++;
        if (at() === "+") i++;
        if (!address()) return true;
      }
      while (/[ \t!]/u.test(at())) i++;
    }
    const cmd = s[i++];
    switch (cmd) {
      case "{":
        // A block opens straight onto its first command.
        continue;
      case "}":
      case "=":
      case "d":
      case "D":
      case "g":
      case "G":
      case "h":
      case "H":
      case "n":
      case "N":
      case "p":
      case "P":
      case "x":
      case "z":
      case "F":
        break;
      case "l":
      case "L":
      case "q":
      case "Q":
      case "v":
        while (/[0-9.]/u.test(at())) i++;
        break;
      case "s": {
        const d = s[i++];
        if (d === undefined || d === "\n" || d === "\\" || !operand(d) || !operand(d)) return true;
        while (/[gpImM0-9]/u.test(at())) i++;
        if (at() === "w" || at() === "e") return true;
        break;
      }
      case "y": {
        const d = s[i++];
        if (d === undefined || d === "\n" || d === "\\" || !operand(d) || !operand(d)) return true;
        break;
      }
      case "a":
      case "i":
      case "c":
        // `a text`, or `a\` with the text on the following lines, each continued by a trailing `\`.
        for (;;) {
          toLineEnd();
          if (s[i - 1] !== "\\" || i >= n) break;
          i++;
        }
        break;
      case "r":
      case "R":
        toLineEnd();
        break;
      case "b":
      case "t":
      case "T":
      case ":":
        while (i < n && s[i] !== "\n" && s[i] !== ";") i++;
        break;
      case "w":
      case "W":
      case "e":
        return true;
      default:
        // Unknown command: not followed, so not trusted.
        return true;
    }
    // A command ends at `;`, a newline, `}`, whitespace, a comment or the end of the script.
    if (i < n && !/[\s;}#]/u.test(at())) return true;
  }
  return false;
}

/** Whether a `READ_ONLY_PROGRAMS` program with these arguments still only reads. */
function readsDespiteArgs(name: string, args: readonly string[]): boolean {
  const positional = args.filter((a) => !a.startsWith("-"));
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));
  const cluster = (letters: string) => shortOption(args, letters);
  switch (name) {
    case "sed": {
      // `-i`/`-I` edit in place; `-f` runs a script this cannot read; `w`, `W` and `e` write or execute.
      if (cluster("iI") || args.some((a) => a.startsWith("--in-place"))) return false;
      const { scripts, scriptFile } = sedScripts(args);
      return !scriptFile && !scripts.some(sedWrites);
    }
    case "sort":
      return !cluster("o") && !args.some((a) => /^--(output|compress-program)(=|$)/u.test(a));
    case "find":
      return !has("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls");
    case "awk":
      // Output redirection (`print > f`, `print | "cmd"`), `system()`, and script files are not followed.
      return !args.some((a) => /system\s*\(|>|\||@(?:include|load)/u.test(a) || /^--(file|exec|load|dump-variables|profile|pretty-print)(=|$)/u.test(a)) && !cluster("fElop");
    case "env":
      return !args.some((a) => !a.startsWith("-") && !a.includes("="));
    case "yq":
      return !args.some((a) => /^--(inplace|in-place|split-exp|from-file)(=|$)/u.test(a)) && !cluster("is");
    case "fd":
      return !args.some((a) => /^--exec(?:-batch)?(=|$)/u.test(a)) && !cluster("xX");
    case "rg":
      return !args.some((a) => /^--(pre|hostname-bin)(=|$)/u.test(a));
    case "ag":
      return !args.some((a) => /^--pager(=|$)/u.test(a));
    case "file":
      return !cluster("C") && !has("--compile");
    case "lsof":
      return !cluster("D");
    case "tree":
      return !cluster("o");
    case "uniq":
      // `uniq in out` writes the second operand.
      return positional.length < 2;
    case "xxd":
      // `xxd in out` writes the second operand.
      return positional.length < 2;
    case "base64":
      return !cluster("o") && !args.some((a) => /^--output(=|$)/u.test(a));
    case "date":
      // `date -s`, `--set` and BSD's bare `date MMDDhhmm` set the clock.
      return !cluster("s") && !args.some((a) => a.startsWith("--set")) && positional.every((a) => a.startsWith("+"));
    case "hostname":
      return positional.length === 0 && !cluster("bF") && !args.some((a) => /^--(boot|file)(=|$)/u.test(a));
    case "sysctl":
      return !args.some((a) => /^--(write|load|system)(=|$)/u.test(a)) && !cluster("wpf") && !positional.some((a) => a.includes("="));
    case "ss":
      return !args.some((a) => /^--(kill|diag)(=|$)/u.test(a)) && !cluster("KD");
    case "ip": {
      // `ip [options] OBJECT [COMMAND]`: the command defaults to `show`.
      if (args.some((a) => a.startsWith("-") && !/^(?:-[46sdhjpor]+|--(?:oneline|details|statistics|json|pretty|resolve))$/u.test(a))) return false;
      const verb = positional[1];
      return verb === undefined || ["show", "list", "ls", "lst", "sh", "s", "l", "get", "help", "monitor"].includes(verb);
    }
    case "ifconfig":
      // `ifconfig eth0 down`, `ifconfig eth0 10.0.0.1` configure the interface.
      return positional.length <= 1 && !args.some((a) => a.startsWith("-") && !["-a", "-l", "-v", "-m", "-s"].includes(a)) && !(has("-a") && positional.length > 0);
    case "mount": {
      // Bare `mount` (or `mount -l`, `mount -t ext4`) lists; any operand or `-a` mounts.
      const rest: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-t" || args[i] === "--types") i++;
        else rest.push(args[i] as string);
      }
      return rest.every((a) => ["-l", "-v", "--verbose", "--show-labels", "-h", "--help", "-V", "--version"].includes(a));
    }
    case "history":
      return !cluster("cwardns");
    case "man":
      return !cluster("PHl") && !args.some((a) => /^--(pager|html|local-file|preprocessor)(=|$)/u.test(a));
    case "less":
    case "more":
      // `less +cmd` runs a less command on start, which can be `!shell`.
      return !args.some((a) => a.startsWith("+") || /^--(?:log-file|LOG-FILE|lesskey-file)(=|$)/u.test(a)) && !cluster("oOk");
    default:
      return true;
  }
}

/** Whether one simple command (from `splitCommand`) only reads. */
function isReadOnlyPart(tokens: string[], extra: readonly string[]): boolean {
  const p = program(tokens);
  if (!p) return true;
  const { name, args } = p;
  if (p.unsafe) return false;
  if (extra.includes(name)) return true;
  if (name === "git") {
    const g = gitCommand(args);
    return g !== undefined && isReadOnlyGit(g);
  }
  const pm = READ_ONLY_PM[name];
  if (pm) {
    const positional = args.filter((a) => !a.startsWith("-"));
    const sub = positional[0];
    if (sub === undefined || !pm.has(sub)) return false;
    // `npm config set` writes .npmrc.
    if (name === "npm" && sub === "config") return ["get", "list", "ls"].includes(positional[1] ?? "");
    return true;
  }
  if (name === "curl" || name === "wget") return isReadOnlyFetch(name, args);
  const cli = READ_ONLY_SUBCOMMANDS[name];
  if (cli) {
    if (name === "sqlite3") {
      return (
        args.length === 3 && args[0] === "-readonly" && !args[1]?.startsWith("-") &&
        (args[2] ?? "").split(";").every((sql) => !sql.trim() || /^\s*select\b/iu.test(sql)) &&
        !args.some((a) => /(?:^|\n)\s*\.|\b(?:attach|load_extension|writefile|edit)\b/iu.test(a))
      );
    }
    if (name === "journalctl") return !args.some((a) => /^--(vacuum|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)/u.test(a));
    if (name === "docker" && args[0] === "compose") {
      let i = 1;
      while (args[i]?.startsWith("-")) {
        const opt = args[i++] as string;
        if (["-f", "--file", "-p", "--project-name", "--profile", "--project-directory", "--env-file", "--parallel"].includes(opt)) i++;
        else if (!/^--(?:file|project-name|profile|project-directory|env-file|parallel|ansi|progress)=/u.test(opt)) return false;
      }
      const sub = args[i];
      return sub !== undefined && ["ps", "logs", "config", "ls", "images", "top", "version"].includes(sub) &&
        !shortOption(args.slice(i + 1), "o") && !args.some((a) => /^--output(=|$)/u.test(a));
    }
    const words = args.filter((a) => !a.startsWith("-"));
    const sub = words[0];
    if (sub === undefined || !cli.has(sub)) return false;
    // `gh pr view` reads, `gh pr merge` does not; `docker network ls` reads, `docker network rm` does not.
    if (words.slice(1).some((w) => MUTATING_WORDS.test(w))) return false;
    if (name === "gh") {
      if (shortOption(args, "w") || args.some((a) => a === "--web" || a === "--browser")) return false;
      const verbs: Record<string, readonly string[]> = {
        pr: ["view", "list", "status", "diff", "checks"], issue: ["view", "list", "status"],
        run: ["view", "list", "watch"], repo: ["view", "list"], release: ["view", "list"],
        search: ["prs", "issues", "repos", "code", "commits"], workflow: ["view", "list"],
      };
      if (sub !== "status" && !verbs[sub]?.includes(words[1] ?? "")) return false;
    }
    // `chezmoi cat -o file` writes the file; `--init` runs the config template.
    if (name === "chezmoi" && (shortOption(args, "o") || args.some((a) => /^--(?:output|init)(=|$)/u.test(a)))) return false;
    if (name === "podman" && args.some((a) => /^--(?:logfile|log-file)(=|$)/u.test(a))) return false;
    if (name === "docker" && ["network", "volume", "context", "image"].includes(sub) && !["ls", "inspect", "list"].includes(words[1] ?? "")) return false;
    if (name === "kubectl" && sub === "config") return KUBECTL_CONFIG_READS.has(words[1] ?? "");
    return true;
  }
  if (!READ_ONLY_PROGRAMS.has(name)) return false;
  return readsDespiteArgs(name, args);
}

/**
 * Files that hold live secrets. Like Claude Code's auto mode, only secrets themselves are fixed
 * holds: SSH config and public keys, and config files that usually carry no token (`.npmrc`), are
 * left to Jev, whose exfiltration check still catches sending them away.
 */
const CREDENTIAL_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/u,
  /(^|\/)auth\.json$/u,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/u,
  /(^|\/)\.aws\/credentials$/u,
  /(^|\/)\.netrc$/u,
  /(^|\/)credentials(\.json)?$/u,
  /\.(pem|key|p12|pfx)$/u,
];

/** Checked-in templates such as `.env.example` hold no secrets. */
const NOT_CREDENTIALS = /\.(example|sample|template|dist|defaults?)$/u;

export function isCredentialPath(file: string): boolean {
  return !NOT_CREDENTIALS.test(file) && CREDENTIAL_PATTERNS.some((re) => re.test(file));
}

/** `/`, a top-level directory, home, the project, or a parent of home or the project. */
function isProtectedDir(resolved: string, cwd: string): boolean {
  if (path.dirname(resolved) === "/" || resolved === "/") return true;
  const isAncestorOf = (dir: string) => dir === resolved || dir.startsWith(`${resolved}${path.sep}`);
  return isAncestorOf(homedir()) || isAncestorOf(path.resolve(cwd));
}

/** Tools whose `command` is a shell command, judged by the same rules: bash, and pi-bg's bg_run. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "bg_run"]);

/** The directory a shell tool's command starts in: pi-bg's `bg_run` takes its own `cwd`. */
export function shellDir(tool: string, input: Record<string, unknown>, cwd: string): string {
  return tool !== "bash" && typeof input.cwd === "string" && input.cwd ? path.resolve(cwd, expandHome(input.cwd)) : cwd;
}

export function expandHome(file: string): string {
  if (file === "~" || file === "$HOME") return homedir();
  if (file.startsWith("~/")) return path.join(homedir(), file.slice(2));
  if (file.startsWith("$HOME/")) return path.join(homedir(), file.slice(6));
  return file;
}

/** Shells whose `-c` argument is a command of its own, judged by the same fixed rules. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** sudo options that take their value as the next token. */
const SUDO_WITH_VALUE = new Set(["-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-T", "-U", "--user", "--group", "--prompt", "--chdir", "--host"]);

/** The command `sudo`/`doas` runs, past their options; undefined when there is none (`sudo -i`). */
export function unwrapSudo(args: string[]): { name: string; args: string[]; unsafe: boolean } | undefined {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const opt = args[i++] as string;
    if (opt === "--") break;
    if (SUDO_WITH_VALUE.has(opt)) i++;
  }
  return program(args.slice(i));
}

/** Commands nested in `sh -c '…'` and `eval …`, which the fixed rules check too. */
export function nestedCommands(p: { name: string; args: string[] }): string[] {
  if (p.name === "eval") return p.args.length ? [p.args.join(" ")] : [];
  if (!SHELLS.has(p.name)) return [];
  const i = p.args.findIndex((a) => /^-[a-zA-Z]*c/u.test(a));
  const script = i >= 0 ? p.args[i + 1] : undefined;
  return script ? [script] : [];
}

/**
 * Reasons this bash command must be put to the user whatever Jev says, or [] when none apply.
 * `branch` is the current git branch, for force-pushes without an explicit refspec.
 */
export function alwaysAskBash(command: string, cwd: string, branch?: string, ignored: ReadonlySet<string> = new Set()): string[] {
  const reasons: string[] = [];
  const parts = splitCommand(command);
  for (const tokens of parts) {
    let p = program(tokens);
    if (!p) continue;
    if (p.name === "sudo" || p.name === "doas") {
      reasons.push("runs as root (sudo)");
      // The command sudo runs is checked too: `sudo rm -rf /` deletes as well.
      p = unwrapSudo(p.args);
      if (!p) continue;
    }
    const { name, args } = p;
    if (name === "rm" || name === "rmdir" || name === "trash") {
      for (const target of args.filter((a) => !a.startsWith("-"))) {
        if (isProtectedDir(path.resolve(cwd, expandHome(target)), cwd)) {
          reasons.push(`deletes ${target}, the project, your home directory, or a parent of either`);
          break;
        }
      }
    }
    if (name === "git" && gitCommand(args)?.sub === "push") {
      const pushArgs = gitCommand(args)!.args;
      const force = pushArgs.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror" || /^\+/u.test(a));
      const refs = pushArgs.filter((a) => !a.startsWith("-"));
      const mentionsMain = refs.some((a) => /(^|[:+/])(main|master)$/u.test(a));
      const onMain = refs.length <= 1 && (branch === "main" || branch === "master");
      if (force && (mentionsMain || onMain)) reasons.push("force-pushes main/master");
    }
    for (const nested of nestedCommands(p)) reasons.push(...alwaysAskBash(nested, cwd, branch, ignored));
  }
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/u.test(command)) reasons.push("pipes a download into a shell");
  forEachPart(command, cwd, (tokens, dir) => {
    const p = program(tokens);
    if (p && SECRET_SAFE.has(p.name)) return;
    const gitSub = p?.name === "git" ? gitCommand(p.args)?.sub : undefined;
    if (gitSub && GIT_SECRET_SAFE.has(gitSub)) return;
    const forcedAdd = gitSub === "add" && p!.args.some((a) => a === "-f" || a === "--force");
    for (const token of tokens) {
      if (!isCredentialPath(expandHome(token))) continue;
      // Git will not stage an ignored file without -f, so naming it in `git add` exposes nothing.
      if (gitSub === "add" && !forcedAdd && ignored.has(path.resolve(dir, expandHome(token)))) continue;
      reasons.push(`touches credentials (${token})`);
      return;
    }
  });
  return [...new Set(reasons)];
}

/** Programs that can name a secret file without revealing or moving its contents. */
const SECRET_SAFE = new Set([
  "ls", "stat", "test", "[", "[[", "chmod", "chown", "chgrp", "touch", "du", "file", "realpath", "readlink", "basename", "dirname",
]);
/** Git subcommands that never stage, print or send file contents. */
const GIT_SECRET_SAFE = new Set(["status", "check-ignore", "ls-files", "rm", "restore", "update-index"]);

/** Calls `fn` for each simple command with the directory it runs in, following `cd` along the way. */
function forEachPart(command: string, cwd: string, fn: (tokens: string[], dir: string) => void): void {
  for (const part of locatedParts(command, cwd)) if (!part.cd) fn(part.tokens, part.dir);
}

/** Words that open and close a compound command. Alone in a part, a closer runs nothing. */
const COMPOUND_OPENERS = new Set(["{", "if", "while", "until", "for", "select", "case"]);
const COMPOUND_CLOSERS = new Set(["}", "done", "fi", "esac"]);

/**
 * Each simple command with the directory it runs in (for a `cd`, the one it leaves), following
 * `cd` along the way, also after a keyword (`then cd x`, `{ cd x`).
 */
export function locatedParts(command: string, cwd: string): (Part & { dir: string; redirectDir: string; cd: boolean })[] {
  let dir = cwd;
  /** Where each open compound command (`{ ...; }`, `if`, a loop, `case`) started. */
  const opened: string[] = [];
  return splitParts(command).map((part) => {
    const here = dir;
    // A redirect after `}`, `done`, `fi` or `esac` applies to the compound command, from where it started.
    let redirectDir = here;
    for (const t of part.tokens) {
      if (COMPOUND_CLOSERS.has(t)) redirectDir = opened.pop() ?? here;
      else if (COMPOUND_OPENERS.has(t)) opened.push(here);
      if (!LEADING_KEYWORDS.has(t)) break;
    }
    const p = program(withoutKeywords(part.tokens));
    if (p?.name !== "cd") return { ...part, dir: here, redirectDir, cd: false };
    const target = p.args.find((a) => !a.startsWith("-"));
    dir = target ? path.resolve(dir, expandHome(target)) : homedir();
    return { ...part, dir: here, redirectDir, cd: true };
  });
}

/**
 * Secret files named in unforced `git add`s, as absolute paths, grouped by the directory git runs
 * in: the caller asks git which are ignored and passes those to `alwaysAskBash`.
 */
export function secretGitAdds(command: string, cwd: string): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  forEachPart(command, cwd, (tokens, dir) => {
    const p = program(tokens);
    if (p?.name !== "git") return;
    const g = gitCommand(p.args);
    if (g?.sub !== "add") return;
    if (g.args.some((a) => a === "-f" || a === "--force")) return;
    for (const token of g.args) {
      if (!isCredentialPath(expandHome(token))) continue;
      byDir.set(dir, [...(byDir.get(dir) ?? []), path.resolve(dir, expandHome(token))]);
    }
  });
  return byDir;
}

/** Reasons a write/edit to `file` must be held whatever Jev says, or []. */
export function alwaysAskPath(file: string): string[] {
  const reasons: string[] = [];
  if (isCredentialPath(expandHome(file))) reasons.push(`touches credentials (${file})`);
  return reasons;
}

/** Commands that only steer the shell; they say nothing about what a call does. */
const SHELL_NOISE = new Set([
  "cd", "pushd", "popd", "echo", "printf", "export", "unset", "set", "true", "false", ":", "sleep", "test", "[", "[[",
  "local", "read", "wait", "shift", "return", "exit", "break", "continue",
]);
/** Keywords that may lead a command (`if grep ...`, `do docker restart x`). */
const LEADING_KEYWORDS = new Set(["if", "elif", "while", "until", "then", "do", "else", "{", "}", "!", "time"]);
/** Parts that are loop or case headers and closers, not commands. */
const NOT_COMMANDS = new Set(["for", "case", "select", "function", "done", "fi", "esac"]);
/** CLIs whose second word also matters: `docker compose up`, `gh repo create`, `kubectl get pods`. */
const TWO_LEVEL = new Set(["docker", "podman", "gh", "kubectl", "gcloud", "aws", "az", "helm"]);
/** CLIs whose first word is a subcommand (`git push`, `npm run`); for other programs it is usually a file. */
const SUBCOMMAND_CLIS = new Set([
  ...TWO_LEVEL, "git", "npm", "pnpm", "yarn", "bun", "deno", "npx", "bunx", "uv", "uvx", "pip", "pip3", "poetry", "cargo", "rustup",
  "go", "systemctl", "launchctl", "brew", "apt", "apt-get", "dnf", "snap", "terraform", "tofu", "pulumi", "make", "just", "vercel",
  "wrangler", "fly", "flyctl", "tailscale", "herdr", "tmux", "pi", "claude", "codex", "plugins", "worktree", "bd", "stow", "docker-compose",
]);
const WORD = /^[a-z][a-z0-9_:-]*$/u;

/** The command with here-document bodies removed: they are input, not commands. */
export function withoutHeredocBodies(command: string): string {
  return heredocs(command).text;
}

/**
 * The command with here-document bodies removed, and the bodies whose delimiter is unquoted
 * (`<<EOF`, not `<<'EOF'`): the shell expands `$(...)` and backticks in those before the command runs.
 */
function heredocs(command: string): { text: string; expanding: string[] } {
  const out: string[] = [];
  const pending: { delimiter: string; expands: boolean; lines: string[] }[] = [];
  const expanding: string[] = [];
  for (const line of command.split("\n")) {
    const open = pending[0];
    if (open) {
      if (line.trim() === open.delimiter) {
        pending.shift();
        if (open.expands) expanding.push(open.lines.join("\n"));
      } else open.lines.push(line);
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/<<-?\s*(\\?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/gu)) {
      pending.push({ delimiter: m[3] as string, expands: !m[1] && !m[2], lines: [] });
    }
  }
  // An unterminated body still runs its substitutions.
  for (const open of pending) if (open.expands) expanding.push(open.lines.join("\n"));
  return { text: out.join("\n"), expanding };
}

/**
 * The commands in `$(...)` and backticks in a here-document body. Quotes there are literal text,
 * so only a backslash escapes; inside a substitution, quoting works as usual.
 */
function heredocSubstitutions(body: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++;
    } else if (c === "$" && body[i + 1] === "(") {
      const end = closingParen(body, i + 1);
      // `$((...))` is arithmetic, not a command.
      if (body[i + 2] !== "(") out.push(body.slice(i + 2, end));
      i = end;
    } else if (c === "`") {
      let inner = "";
      let j = i + 1;
      for (; j < body.length && body[j] !== "`"; j++) {
        if (body[j] === "\\" && /[`$\\]/u.test(body[j + 1] ?? "")) j++;
        inner += body[j];
      }
      out.push(inner);
      i = j;
    }
  }
  return out;
}

/**
 * What one simple command does, as `program [subcommand [subcommand]]`, or undefined for shell
 * noise; with the program as it was typed (`bin/homelab`, `git`).
 */
function partInfo(tokens: string[]): { key: string; invoked: string } | undefined {
  let i = 0;
  while (i < tokens.length && LEADING_KEYWORDS.has(tokens[i] as string)) i++;
  const rest = tokens.slice(i);
  const head = rest[0];
  if (head === undefined || NOT_COMMANDS.has(head) || /\)$|\(\)\{?$/u.test(head)) return undefined;
  const p = program(rest);
  if (!p || SHELL_NOISE.has(p.name) || !/^[A-Za-z_][A-Za-z0-9_.+-]*$/u.test(p.name)) return undefined;
  const positional = (p.name === "git" ? (gitCommand(p.args)?.args ?? []) : p.args).filter((a) => !a.startsWith("-"));
  const first = p.name === "git" ? gitCommand(p.args)?.sub : positional[0];
  // Project scripts (`bin/homelab status`) usually take subcommands too.
  const invoked = rest.find((t) => path.basename(t) === p.name) ?? "";
  const typed = invoked || p.name;
  const takesSubcommand = SUBCOMMAND_CLIS.has(p.name) || invoked.includes("/");
  if (first === undefined || !WORD.test(first) || !takesSubcommand) return { key: p.name, invoked: typed };
  if (!TWO_LEVEL.has(p.name)) return { key: `${p.name} ${first}`, invoked: typed };
  const second = positional.slice(1).find((a) => WORD.test(a));
  return { key: second ? `${p.name} ${first} ${second}` : `${p.name} ${first}`, invoked: typed };
}

/** A simple command as the permission rules see it (`bashUnits`). */
export interface BashUnit {
  /** Its words, quotes removed, past the keywords that lead it (`do`, `then`). */
  words: string[];
  /** It only reads (as `isReadOnlyBash` counts a command). */
  read: boolean;
  /** What it does as `bashKeys` names it (`git push`); undefined for shell noise and what is not a program. */
  key?: string;
  /** The program as typed, when it names a key (`bin/homelab`). */
  invoked?: string;
  /** Not read-only and not a program this can name (`$(which x) y`, `export A=1`): only the call's whole text can say what it does. */
  unparsed: boolean;
  /** An assignment, wrapper option or git `-c` changes what it runs (`PATH=... git push`). */
  unsafe: boolean;
  /** It redirects output to a file. */
  writes: boolean;
  /** Its program past assignments and wrappers, when it has one. */
  program?: { name: string; args: string[] };
  /** The command a privilege wrapper (`sudo`, `doas`) runs, past its own options. */
  inner?: { name: string; args: string[] };
  /** From the text of `sh -c '...'` or `eval ...`, not the call itself. */
  nested: boolean;
}

/**
 * Every simple command in the call, in the order `bashKeys` visits them: past here-document bodies,
 * inside `$(...)`, backticks, `<(...)`, `>(...)` and unquoted here-documents' substitutions, and
 * inside `sh -c`/`eval` text (marked `nested`).
 */
export function bashUnits(command: string, extraReadOnly: readonly string[] = []): BashUnit[] {
  const units: BashUnit[] = [];
  const visit = (command: string, nested: boolean) => {
    const { text: plain, expanding } = heredocs(command);
    const { text, bodies } = extractSubstitutions(plain);
    for (const tokens of splitCommand(text)) {
      if (NOT_COMMANDS.has(tokens[0] ?? "")) continue;
      let i = 0;
      while (i < tokens.length && LEADING_KEYWORDS.has(tokens[i] as string)) i++;
      const words = tokens.slice(i);
      if (!words.length) continue;
      const info = partInfo(tokens);
      const read = isReadOnlyPart(words, extraReadOnly);
      const p = program(words);
      const g = p?.name === "git" ? gitCommand(p.args) : undefined;
      let runs = p;
      let inner: { name: string; args: string[] } | undefined;
      if (p && (p.name === "sudo" || p.name === "doas")) {
        runs = unwrapSudo(p.args);
        if (runs) inner = { name: runs.name, args: runs.args };
      }
      units.push({
        words,
        read,
        ...(info ? { key: info.key, invoked: info.invoked } : {}),
        unparsed: !read && !info,
        unsafe: Boolean(p?.unsafe || g?.unsafeGlobal),
        writes: writeRedirects(words.join(" ")).length > 0,
        ...(p ? { program: { name: p.name, args: p.args } } : {}),
        ...(inner ? { inner } : {}),
        nested,
      });
      for (const script of runs ? nestedCommands(runs) : []) visit(script, true);
    }
    for (const { body } of bodies) visit(body, nested);
    for (const body of expanding) for (const inner of heredocSubstitutions(body)) visit(inner, nested);
  };
  visit(command, false);
  return units;
}

/**
 * What a call does, as keys: one per command in it that does more than read, skipping `cd`,
 * `echo`, loop headers and the like. The permission rules offered for a call (permissions.ts) are
 * built from them, so `cd /tmp/a && docker restart x` and `cd ~/b; docker restart x` are the same
 * `docker restart`, and a rule for it never covers `rm`. Commands inside `$(...)`, backticks,
 * `<(...)`, `>(...)` and unquoted here-documents count like the others: `ls $(rm -rf x)` is keyed
 * `rm`, not as a read.
 */
export function bashKeys(command: string, extraReadOnly: readonly string[] = []): string[] {
  const keys = new Set<string>();
  let unparsed = false;
  for (const unit of bashUnits(command, extraReadOnly)) {
    if (unit.nested || unit.read) continue;
    if (unit.key) keys.add(unit.key);
    else if (unit.unparsed) unparsed = true;
  }
  // An opaque command is not a read: a grant for redirected reads must not cover env -S…
  // or an executable hidden in an expansion. Such grants cover only the exact opaque call.
  if (unparsed) keys.add(`unparsed shell: ${command.trim()}`);
  return keys.size ? [...keys].sort() : [READS_KEY];
}

/** The "allow similar" key for calls whose commands all only read. */
export const READS_KEY = "reads with substitutions or redirects";

/** The word a substitution leaves in place of itself for `bashPathAccess`: not path-like on its own. */
export const SUBSTITUTED = "$(...)";

/**
 * `command` with each command substitution (`$(...)`, backticks) outside single quotes, and each
 * process substitution (`<(...)`, `>(...)`) outside quotes, replaced by `SUBSTITUTED`, and their
 * bodies with where each placeholder starts in the new text. Arithmetic (`$((...))`) becomes `0`.
 */
export function extractSubstitutions(command: string): { text: string; bodies: { body: string; at: number }[] } {
  const bodies: { body: string; at: number }[] = [];
  let text = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      text += c;
      continue;
    }
    if (c === "\\") {
      text += command.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === quote) quote = undefined;
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else if (command[i + 1] === "(" && (c === "$" || (!quote && (c === "<" || c === ">")))) {
      const end = closingParen(command, i + 1);
      if (c === "$" && command[i + 2] === "(") text += "0";
      else {
        bodies.push({ body: command.slice(i + 2, end), at: text.length });
        text += SUBSTITUTED;
      }
      i = end;
      continue;
    } else if (c === "`") {
      let body = "";
      let j = i + 1;
      for (; j < command.length && command[j] !== "`"; j++) {
        if (command[j] === "\\" && /[`$\\]/u.test(command[j + 1] ?? "")) j++;
        body += command[j];
      }
      bodies.push({ body, at: text.length });
      text += SUBSTITUTED;
      i = j;
      continue;
    }
    text += c;
  }
  return { text, bodies };
}

/** The index of the `)` closing the `(` at `open`, past quoted text and nested parentheses, or the end. */
function closingParen(command: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let i = open; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (c === "\\") i++;
    else if (c === quote) quote = undefined;
    else if (quote) continue;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return command.length;
}

/** The filesystem commands accept-edits mode runs unasked, as Claude Code's does. */
const ACCEPT_EDITS_COMMANDS = new Set(["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"]);
/** Options of these commands that take the next token as their value. */
const FS_OPTION_WITH_VALUE: Record<string, Set<string>> = {
  mkdir: new Set(["-m", "--mode"]),
  touch: new Set(["-d", "-r", "-t", "--date", "--reference"]),
  cp: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  mv: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  sed: new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]),
};

/** The files a filesystem command names (for sed, the files after its script). */
function fsOperands(name: string, args: readonly string[]): string[] {
  const withValue = FS_OPTION_WITH_VALUE[name] ?? new Set<string>();
  const operands: string[] = [];
  let scriptGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (name === "sed" && (a === "-e" || a === "--expression" || /^-[a-zA-Z]*e./u.test(a) || a.startsWith("--expression="))) scriptGiven = true;
      // `-t DIR` and `--target-directory DIR` name a destination: it is an operand too.
      if ((name === "cp" || name === "mv") && (a === "-t" || a === "--target-directory")) operands.push(args[i + 1] ?? "");
      if (withValue.has(a)) i++;
      continue;
    }
    operands.push(a);
  }
  // Without -e, sed's first operand is its script.
  return name === "sed" && !scriptGiven ? operands.slice(1) : operands;
}

/**
 * Whether accept-edits mode runs this command unasked: every simple command in it only reads or
 * is a filesystem command (`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`) whose files all lie
 * inside the project (after any `cd`), with no write redirect, expansion or substitution. `sed`
 * may edit in place but not run a `w`/`e` command or read a script file. Removals of a protected
 * directory and credential files are never covered.
 */
export function isAcceptEditsBash(command: string, cwd: string, extra: readonly string[] = []): boolean {
  if (!plainShell(command)) return false;
  if (writeRedirects(command).length) return false;
  const root = path.resolve(cwd);
  const inside = (file: string) => file === root || file.startsWith(`${root}${path.sep}`);
  let parts = 0;
  let ok = true;
  forEachPart(command, cwd, (tokens, dir) => {
    parts++;
    if (!ok || isReadOnlyPart(tokens, extra)) return;
    const p = program(tokens);
    if (!p || p.unsafe || !ACCEPT_EDITS_COMMANDS.has(p.name)) {
      ok = false;
      return;
    }
    if (p.name === "sed") {
      const { scripts, scriptFile } = sedScripts(p.args);
      if (scriptFile || scripts.some(sedWrites)) {
        ok = false;
        return;
      }
    }
    const operands = fsOperands(p.name, p.args);
    if (!operands.length) {
      ok = false;
      return;
    }
    for (const operand of operands) {
      const file = path.resolve(dir, expandHome(operand));
      if (!operand || !inside(file) || isProtectedDir(file, cwd) || isCredentialPath(file)) ok = false;
    }
  });
  return ok && parts > 0;
}

/** Programs that write every path they name. */
const WRITES_ALL = new Set([
  "rm", "rmdir", "trash", "unlink", "shred", "mkdir", "touch", "tee", "ln", "chmod", "chown", "chgrp", "truncate", "mv",
]);
/** Programs that read their sources and write their last operand. */
const WRITES_LAST = new Set(["cp", "rsync", "install", "scp"]);

const REDIRECT = /^[0-9&]*(>>?|<>?|<)/u;

/**
 * Whether a token names a local file: it has a slash or starts with `~`, `.` or `$HOME`, and is
 * not a URL, a package spec (`git:github.com/o/r`, `github:o/r`) or a remote (`nuc:/x`,
 * `user@nuc:~/x`): a `:` before the first slash, unless the token starts like a local path.
 */
function pathLike(token: string): boolean {
  if (!token || token.includes("://") || token.startsWith("-")) return false;
  const local = /^(\/|~|\.|\$HOME)/u.test(token);
  if (!local && token.split("/")[0].includes(":")) return false;
  return token.includes("/") || token === "." || token === ".." || token === "~" || token.startsWith("~") || token.startsWith("$HOME");
}

/** The file-like words of a simple command's arguments, including `--opt=/path` values. */
function pathArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq > 0 && pathLike(a.slice(eq + 1))) out.push(a.slice(eq + 1));
      continue;
    }
    const eq = a.indexOf("=");
    // dd's `of=/x`, `if=/x`.
    if (eq > 0 && /^[a-z]+$/u.test(a.slice(0, eq)) && pathLike(a.slice(eq + 1))) out.push(a.slice(eq + 1));
    else if (pathLike(a)) out.push(a);
  }
  return out;
}

/**
 * Whether a word an arbitrary program takes is plausibly a file there: an absolute path counts only
 * when its top-level directory exists, so `pi -p "/smoke"`, `/$CMD` and `/api/v1` routes are
 * arguments, not writes to the filesystem root. Commands known to write (`mkdir /x`) are not
 * filtered: their intent is clear.
 */
function plausibleFile(word: string, resolved: string): boolean {
  if (!word.startsWith("/")) return true;
  const top = resolved.split("/")[1];
  return !top || existsSync(`/${top}`);
}

/**
 * Whether a command matches an exempt entry: its program (by base name) followed by the entry's
 * other words as its first arguments, skipping options (`chezmoi -v apply` matches
 * `chezmoi apply`; an option that takes a separate value before them defeats the match).
 */
function isExemptPart(p: { name: string; args: string[] }, exempt: readonly string[]): boolean {
  if (!exempt.length) return false;
  const words = [path.basename(p.name), ...p.args.filter((a) => !a.startsWith("-"))];
  return exempt.some((entry) => {
    const want = entry.trim().split(/\s+/u);
    return want.length > 0 && want.every((w, i) => words[i] === w);
  });
}

/** ssh options that take a separate value (OpenSSH `ssh(1)` synopsis). */
const SSH_VALUE_OPTIONS = "BbcDEeFIiJLlmOoPpQRSWw";

/**
 * The local files an `ssh` invocation names. Its host and remote command name paths on the
 * remote machine, so they are not local reads or writes. Local option values are: `-i`, `-F` and
 * `-o Key=/path` are read, `-E` (log file) and `-S` (control socket) are written.
 */
function sshLocalFiles(args: readonly string[]): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || !a.startsWith("-") || a === "-") break;
    // Bundled flags: `-vT`, or `-i~/.ssh/key` / `-p22` with an attached value.
    for (let j = 1; j < a.length; j++) {
      const flag = a[j];
      if (!SSH_VALUE_OPTIONS.includes(flag)) continue;
      const value = j + 1 < a.length ? a.slice(j + 1) : args[++i];
      if (value !== undefined) {
        const v = flag === "o" ? value.slice(value.indexOf("=") + 1).trim() : value;
        if (pathLike(v)) (flag === "E" || flag === "S" ? writes : reads).push(v);
      }
      break;
    }
  }
  return { reads, writes };
}

/** A simple command past the keywords that may lead it: `do ls` runs `ls`. `time` is left to `program`, with its options. */
export function withoutKeywords(tokens: string[]): string[] {
  let k = 0;
  while (k < tokens.length && tokens[k] !== "time" && LEADING_KEYWORDS.has(tokens[k] as string)) k++;
  return tokens.slice(k);
}

/**
 * The files and directories a shell command reads and writes, as absolute paths, for the
 * directory policy. A heuristic: words that look like paths (a slash, `~`, `.`), resolved against
 * the directory each part runs in (after `cd`), plus write redirects (never `/dev/null`), resolved
 * the same way. A read-only part reads what it names; `rm`, `mv`, `mkdir`, `touch`, `tee`, `ln`,
 * `chmod`... write it; `cp`, `rsync` and `install` write their last operand; `sed -i` writes its
 * files; any other program is assumed to write what it names. A part run in another directory
 * (`cd ../x && make`) reads that directory, or writes it when the part does more than read. Shell
 * keywords (`for ... in`, `do`, `then`, `done`) are not programs: a loop or `if` counts by the
 * commands in it. Commands in `$(...)`, backticks, `<(...)`, `>(...)`, `sh -c` and `eval` are
 * followed, in the directory their command runs in. A part matching one of `exempt` (see
 * `isExemptPart`) names no paths; its directory still counts. `origin` is the directory the
 * agent works in, when the command starts elsewhere (pi-bg's `bg_run` with its own `cwd`).
 */
export function bashPathAccess(
  command: string,
  cwd: string,
  extra: readonly string[] = [],
  exempt: readonly string[] = [],
  origin: string = cwd,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const resolve = (dir: string, file: string) => path.resolve(dir, expandHome(file));
  /** `origin` is where the agent's call runs: a part elsewhere reads or writes its directory. */
  const visit = (command: string, cwd: string, origin: string) => {
    const { text, bodies } = extractSubstitutions(withoutHeredocBodies(command));
    const parts = locatedParts(text, cwd);
    const partAt = (at: number) => parts.findLast((p) => p.start <= at);
    for (const { target, at } of redirectsAt(text)) if (target !== ">") writes.add(resolve(partAt(at)?.redirectDir ?? cwd, target));
    for (const part of parts) if (!part.cd) visitPart(part.tokens, part.dir, origin);
    // A substitution runs where the command around it runs.
    for (const { body, at } of bodies) visit(body, partAt(at)?.dir ?? cwd, origin);
  };
  const visitPart = (raw: string[], dir: string, origin: string) => {
    // Redirects (collected by `visit`) are not arguments: `2>/dev/null`, `> out`.
    const words = raw.filter((t, i) => !REDIRECT.test(t) && !/^[0-9&]*(>>?|<>?|<)\|?&?$/u.test(raw[i - 1] ?? ""));
    raw.forEach((t, i) => {
      const input = /^[0-9]*<([^<>]*)$/u.exec(t);
      const target = input ? input[1] || raw[i + 1] : undefined;
      if (target && pathLike(target)) reads.add(resolve(dir, target));
    });
    const tokens = withoutKeywords(words);
    const head = tokens[0];
    // A loop header runs nothing; its list may name paths (`for f in ~/x/*.md`).
    if (head === "for" || head === "select") {
      const list = tokens.indexOf("in");
      for (const w of list < 0 ? [] : tokens.slice(list + 1)) if (pathLike(w)) reads.add(resolve(dir, w));
      return;
    }
    if (tokens.length === 1 && COMPOUND_CLOSERS.has(head as string)) return;
    const p = program(tokens);
    if (!p) return;
    const readOnly = isReadOnlyPart(tokens, extra);
    if (dir !== origin) (readOnly ? reads : writes).add(dir);
    if (isExemptPart(p, exempt)) return;
    if (path.basename(p.name) === "ssh") {
      const own = sshLocalFiles(p.args);
      for (const f of own.reads) reads.add(resolve(dir, f));
      for (const f of own.writes) writes.add(resolve(dir, f));
      return;
    }
    const nested = nestedCommands(p);
    const args = p.args.filter((a) => !nested.includes(a));
    const files = pathArgs(p.name === "eval" ? [] : args).map((f) => resolve(dir, f));
    if (readOnly) {
      // sed's script (`s/a/b/`) is not a file.
      const named = p.name === "sed" ? fsOperands("sed", p.args).filter(pathLike).map((f) => resolve(dir, f)) : files;
      for (const f of named) reads.add(f);
    } else if (WRITES_ALL.has(p.name)) {
      for (const f of files) writes.add(f);
    } else if (WRITES_LAST.has(p.name)) {
      // A remote destination (`scp f nuc:/x`) is not a local file: every local operand is read.
      const dest = args.filter((a) => !a.startsWith("-")).at(-1);
      if (dest !== undefined && !pathLike(dest)) for (const f of files) reads.add(f);
      else files.forEach((f, i) => (i === files.length - 1 ? writes : reads).add(f));
    } else if (p.name === "sed") {
      // Past its script: `s/a/b/` is not a file.
      const inPlace = p.args.some((a) => /^-[a-zA-Z]*i/u.test(a) || a.startsWith("--in-place"));
      for (const f of fsOperands("sed", p.args).filter(pathLike)) (inPlace ? writes : reads).add(resolve(dir, f));
    } else {
      const guessed = pathArgs(p.name === "eval" ? [] : args).filter((a) => plausibleFile(a, resolve(dir, a)));
      for (const f of guessed) writes.add(resolve(dir, f));
    }
    for (const script of nested) visit(script, dir, origin);
  };
  visit(command, cwd, path.resolve(origin));
  for (const f of writes) reads.delete(f);
  return { reads: [...reads], writes: [...writes] };
}
