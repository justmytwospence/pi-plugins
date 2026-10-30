import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bashUnits } from "../src/bash.ts";
import {
  allowing,
  allowsPath,
  blocking,
  ruleWarning,
  type Call,
  describeOrigin,
  editUserRules,
  loadFileRules,
  localGrants,
  migrateGrant,
  parseRule,
  type RuleList,
  ruleTool,
  type ScopedRule,
  scopeLabel,
  sessionRule,
  suggest,
  userRulesFile,
} from "../src/permissions.ts";

const ROOT = "/Users/me/Projects/app";
const call = (tool: string, input: Record<string, unknown>): Call => ({ tool, input, cwd: ROOT, root: ROOT });
const bash = (command: string) => call("bash", { command });
const rule = (list: RuleList, text: string): ScopedRule => {
  const r = sessionRule(list, text);
  if (!r) throw new Error(`not a rule: ${text}`);
  return r;
};
const rules = (list: RuleList, ...texts: string[]) => texts.map((t) => rule(list, t));
const allows = (rs: ScopedRule[], c: Call, exact = false) => allowing(rs, c, exact)?.map((r) => r.text);

describe("parsing", () => {
  const text = (raw: string) => {
    const p = parseRule(raw);
    return p.ok ? p.rule.text : `error: ${p.error}`;
  };

  test("Bash: a prefix with :* or a trailing space and *, an exact command, or the whole tool", () => {
    expect(text("Bash(git push:*)")).toBe("Bash(git push:*)");
    expect(text("Bash(git push *)")).toBe("Bash(git push:*)");
    expect(text("Bash(npm test)")).toBe("Bash(npm test)");
    expect(text("  Bash( npm test )  ")).toBe("Bash(npm test)");
    expect(text("Bash")).toBe("Bash");
    expect(text("Bash(*)")).toBe("Bash");
    expect(text("bash(git status)")).toBe("Bash(git status)");
    const exact = parseRule("Bash(npm test)");
    expect(exact.ok && exact.rule.command).toEqual({ kind: "exact", text: "npm test", tokens: ["npm", "test"] });
    const prefix = parseRule("Bash(./bin/x run:*)");
    expect(prefix.ok && prefix.rule.command).toEqual({ kind: "prefix", text: "./bin/x run", tokens: ["bin/x", "run"] });
  });

  test("a compound command is an exact rule for the whole call, never a prefix", () => {
    const whole = parseRule("Bash(cd x && make)");
    expect(whole.ok && whole.rule.command).toEqual({ kind: "exact", text: "cd x && make" });
    expect(text("Bash(cd x && make:*)")).toMatch(/^error: A prefix rule names one command/u);
  });

  test("Edit, Write and Read take gitignore-style paths; other tools are named alone", () => {
    expect(text("Edit(src/**)")).toBe("Edit(src/**)");
    expect(text("write(~/notes/**)")).toBe("Write(~/notes/**)");
    expect(text("Read(//etc/hosts)")).toBe("Read(//etc/hosts)");
    expect(text("web_fetch")).toBe("web_fetch");
    expect(text("mcp__server")).toBe("mcp__server");
    expect(text("mcp__server__*")).toBe("mcp__server__*");
  });

  test("what is not a rule says why", () => {
    expect(text("")).toMatch(/empty/u);
    expect(text("Bash()")).toMatch(/nothing inside the parentheses/u);
    expect(text("Edit()")).toMatch(/nothing inside/u);
    expect(text("WebFetch(domain:example.com)")).toMatch(/only Bash, Edit, Write and Read take a specifier/u);
    expect(text("Bash(git push")).toMatch(/Write a rule as Tool or Tool\(specifier\)/u);
    expect(text("two words")).toMatch(/Write a rule as/u);
    expect(text("bad$name")).toMatch(/not a tool name/u);
  });

  test("tools map to rule tools", () => {
    expect(["bash", "bg_run"].map(ruleTool)).toEqual(["Bash", "Bash"]);
    expect(["read", "grep", "find", "ls"].map(ruleTool)).toEqual(["Read", "Read", "Read", "Read"]);
    expect([ruleTool("edit"), ruleTool("write"), ruleTool("web_fetch")]).toEqual(["Edit", "Write", "web_fetch"]);
  });
});

describe("prefix and exact commands", () => {
  const git = rules("allow", "Bash(git push:*)");

  test("a prefix matches the command and its arguments, not a longer word", () => {
    for (const command of ["git push", "git push origin main", "git push --force-with-lease", "cd x && git push", "FOO=1 git push"]) {
      // An assignment that is not on the unsafe list changes nothing.
      expect(allows(git, bash(command)), command).toEqual(["Bash(git push:*)"]);
    }
    for (const command of ["git pushx", "git pull", "git", "gitk push", "echo git push", "npm run git push"]) {
      expect(allows(git, bash(command)), command).toBeUndefined();
    }
  });

  test("the program and subcommand count however it is spelled: global options, wrappers, a path to the program", () => {
    expect(allows(git, bash("git -C ../other push origin"))).toBeDefined();
    expect(allows(git, bash("time git push"))).toBeDefined();
    expect(allows(git, bash("timeout 30 git push"))).toBeDefined();
    expect(allows(git, bash("/usr/bin/git push"))).toBeDefined();
    // Not when what runs is changed: an unsafe assignment or a git -c override, or another program called git.
    expect(allows(git, bash("PATH=/tmp/x git push"))).toBeUndefined();
    expect(allows(git, bash("GIT_SSH_COMMAND=evil git push"))).toBeUndefined();
    expect(allows(git, bash("git -c core.sshCommand=evil push"))).toBeUndefined();
    expect(allows(git, bash("./git push"))).toBeUndefined();
  });

  test("a prefix can name the program as typed, `./` ignored", () => {
    const script = rules("allow", "Bash(bin/homelab status:*)");
    expect(allows(script, bash("./bin/homelab status"))).toBeDefined();
    expect(allows(script, bash("bin/homelab status --all"))).toBeDefined();
    expect(allows(script, bash("bin/homelab restart"))).toBeUndefined();
    // An old grant for such a script was saved without its path: it covers the program on the path only.
    expect(allows(rules("allow", "Bash(homelab status:*)"), bash("bin/homelab status"))).toBeUndefined();
    expect(allows(rules("allow", "Bash(homelab status:*)"), bash("homelab status"))).toBeDefined();
  });

  test("an exact rule is that command: other arguments, or more words, do not match", () => {
    const test_ = rules("allow", "Bash(npm test)");
    expect(allows(test_, bash("npm test"))).toBeDefined();
    expect(allows(test_, bash("npm  test"))).toBeDefined();
    expect(allows(test_, bash("cd pkg && npm test"))).toBeDefined();
    expect(allows(test_, bash("npm test -- --watch"))).toBeUndefined();
    expect(allows(test_, bash("npm run test"))).toBeUndefined();
  });

  test("an exact rule is spelled as words, not quotes; with an expansion only the whole text matches", () => {
    const say = rules("allow", `Bash(ssh host 'ls -la')`);
    expect(allows(say, bash(`ssh host "ls -la"`))).toBeDefined();
    expect(allows(say, bash("ssh host ls -la"))).toBeUndefined();
    const expand = rules("allow", `Bash(sh -c 'echo $HOME')`);
    expect(allows(expand, bash(`sh -c 'echo $HOME'`))).toBeDefined();
    // The same words with the shell expanding $HOME first are another command.
    expect(allows(expand, bash(`sh -c "echo $HOME"`))).toBeUndefined();
  });

  test("a bare tool rule covers every command", () => {
    expect(allows(rules("allow", "Bash"), bash("make deploy"))).toEqual(["Bash"]);
    expect(allows(rules("allow", "bash"), call("bg_run", { command: "make deploy", cwd: ROOT }))).toEqual(["Bash"]);
  });
});

describe("wildcards anywhere, as in Claude Code", () => {
  const blocks = (rs: ScopedRule[], command: string) => blocking(rs, bash(command))?.text;

  test("a * anywhere matches any text, spaces included; :* is a trailing wildcard only at the end", () => {
    const p = parseRule("Bash(git log * main)");
    expect(p.ok && p.rule.command?.kind).toBe("glob");
    expect(parseRule("Bash(vercel *--prod:*)").ok && (parseRule("Bash(vercel *--prod:*)") as { rule: { text: string } }).rule.text).toBe("Bash(vercel *--prod *)");
    expect(parseRule("Bash(cd x && vercel *)").ok).toBe(false);
    // Claude Code's table.
    const log = rules("allow", "Bash(git log * main)");
    for (const c of ["git log --oneline main", "git log -5 main"]) expect(allows(log, bash(c)), c).toEqual(["Bash(git log * main)"]);
    for (const c of ["git log main", "git push origin main"]) expect(allows(log, bash(c)), c).toBeUndefined();
    const version = rules("allow", "Bash(* --version)");
    expect(allows(version, bash("node --version"))).toBeDefined();
    expect(allows(version, bash("node -v"))).toBeUndefined();
    const help = rules("allow", "Bash(* --help *)");
    expect(allows(help, bash("npm --help x"))).toBeDefined();
    expect(allows(help, bash("npm --help"))).toBeUndefined();
    const ls = rules("allow", "Bash(ls*)");
    expect(allows(ls, bash("lsof -i"))).toBeDefined();
    expect(allows(rules("allow", "Bash(ls *)"), bash("lsof -i"))).toBeUndefined();
  });

  test("ask rules catch a flag wherever it is, nested and behind runners: preview deploys run, production asks", () => {
    const set = [
      ...rules("allow", "Bash(vercel deploy *)"),
      ...rules("ask", "Bash(*vercel*--prod*)", "Bash(*vercel*--target*production*)", "Bash(vercel promote *)"),
    ];
    for (const c of ["vercel deploy --yes --non-interactive", "vercel deploy"]) {
      expect(blocks(set, c), c).toBeUndefined();
      expect(allows(set, bash(c)), c).toEqual(["Bash(vercel deploy:*)"]);
    }
    for (const c of [
      "vercel deploy --prod", "vercel deploy --yes --prod", "vercel --prod", "vercel deploy --prod=true",
      "vercel --cwd site deploy --prod", "npx vercel deploy --prod", "sh -c 'vercel deploy --yes --prod'",
      "git push && vercel deploy --prod", "echo $(vercel deploy --prod)",
    ]) expect(blocks(set, c), c).toBe("Bash(*vercel*--prod*)");
    for (const c of ["vercel deploy --target=production", "vercel deploy --target production"]) expect(blocks(set, c), c).toBe("Bash(*vercel*--target*production*)");
    expect(blocks(set, "vercel promote https://x.vercel.app")).toBe("Bash(vercel promote:*)");
  });

  test("an allow pattern does not match a command with an expansion; a deny pattern does", () => {
    expect(allows(rules("allow", "Bash(echo * done)"), bash("echo $X done"))).toBeUndefined();
    expect(blocking(rules("deny", "Bash(rm * $HOME)"), bash("rm -rf $HOME"))?.list).toBe("deny");
  });

  test("an allow pattern with * before the subcommand is flagged; an exact suggestion is never a pattern", () => {
    const warn = (list: RuleList, t: string) => {
      const p = parseRule(t);
      return p.ok ? ruleWarning(list, p.rule) : "unparsed";
    };
    expect(warn("allow", "Bash(git * main)")).toMatch(/before the subcommand/u);
    expect(warn("allow", "Bash(* --version)")).toMatch(/before the subcommand/u);
    expect(warn("allow", "Bash(git log * main)")).toBeUndefined();
    expect(warn("ask", "Bash(*vercel*--prod*)")).toBeUndefined();
    expect(suggest(bash("rm -rf build/*"))).toEqual([]);
  });
});

describe("deny, ask and allow", () => {
  const set = [...rules("allow", "Bash(git push:*)", "Bash(rm -rf build)"), ...rules("ask", "Bash(git push --force:*)"), ...rules("deny", "Bash(rm -rf:*)")];

  test("deny beats ask beats allow, whichever scope or order they were written in", () => {
    expect(blocking(set, bash("rm -rf build"))?.list).toBe("deny");
    expect(allows(set, bash("rm -rf build"))).toBeDefined();
    expect(blocking(set, bash("git push --force origin"))).toMatchObject({ list: "ask", text: "Bash(git push --force:*)" });
    expect(blocking(set, bash("git push origin"))).toBeUndefined();
    // Reversed order: still deny first.
    expect(blocking([...set].reverse(), bash("git push --force && rm -rf build"))?.list).toBe("deny");
    // An ask rule and a deny rule match the same call: deny.
    const both = [...rules("ask", "Bash(rm:*)"), ...rules("deny", "Bash(rm -rf:*)")];
    expect(blocking(both, bash("rm -rf x"))?.list).toBe("deny");
  });

  test("a part that does more than read must match an allow rule: git push does not allow `git push && rm -rf x`", () => {
    const push = rules("allow", "Bash(git push:*)");
    expect(allows(push, bash("git push && rm -rf x"))).toBeUndefined();
    expect(allows(push, bash("git push; npm publish"))).toBeUndefined();
    expect(allows(push, bash("git push | tee log"))).toBeUndefined();
    expect(allows(push, bash("git push && echo done && git status"))).toBeDefined();
    expect(allows(push, bash("cd sub; git push origin x; ls -la"))).toBeDefined();
    const both = rules("allow", "Bash(git push:*)", "Bash(npm test)");
    expect(allows(both, bash("npm test && git push"))).toEqual(["Bash(npm test)", "Bash(git push:*)"]);
  });

  test("any part matching a deny rule denies the whole call, and any matching an ask rule asks", () => {
    expect(blocking(rules("deny", "Bash(rm:*)"), bash("git status && rm x"))?.text).toBe("Bash(rm:*)");
    expect(blocking(rules("deny", "Bash(git log:*)"), bash("git log -3 && echo ok"))?.text).toBe("Bash(git log:*)");
    expect(blocking(rules("ask", "Bash(curl:*)"), bash("echo a; curl -s https://x.example"))?.list).toBe("ask");
    expect(blocking(rules("deny", "Bash(rm:*)"), bash("git status && ls"))).toBeUndefined();
  });

  test("commands inside substitutions count, for allow and for deny", () => {
    const push = rules("allow", "Bash(git push:*)");
    expect(allows(push, bash("git push $(rm -rf x)"))).toBeUndefined();
    expect(allows(push, bash("echo `git push`"))).toBeDefined();
    expect(allows(push, bash("cat <(git push)"))).toBeDefined();
    expect(allows(push, bash("cat <<EOF\n$(rm -rf x)\nEOF"))).toBeUndefined();
    const deny = rules("deny", "Bash(rm:*)");
    for (const command of ["ls $(rm -rf x)", "echo `rm x`", "cat <(rm x)", "cat <<EOF\n$(rm -rf x)\nEOF", "echo \"$(echo $(rm x))\""]) {
      expect(blocking(deny, bash(command))?.list, command).toBe("deny");
    }
    // A quoted $( is text.
    expect(blocking(deny, bash("echo '$(rm x)'"))).toBeUndefined();
  });

  test("text run by sh -c, eval and sudo is checked by deny and ask rules; an allow rule needs the outer command too", () => {
    const deny = rules("deny", "Bash(rm -rf:*)");
    for (const command of ["bash -c 'rm -rf x'", "sh -c \"cd y; rm -rf x\"", "eval rm -rf x", "sudo rm -rf x", "sudo -u root bash -c 'rm -rf /tmp/x'"]) {
      expect(blocking(deny, bash(command))?.list, command).toBe("deny");
    }
    // An allow rule for the inner command does not open the shell that runs it.
    expect(allows(rules("allow", "Bash(git push:*)"), bash("bash -c 'git push'"))).toBeUndefined();
    expect(allows(rules("allow", "Bash(sudo systemctl restart nginx)"), bash("sudo systemctl restart nginx"))).toBeDefined();
  });

  test("calls whose parts all read need a rule for each command, and an unparsed part only the exact call", () => {
    // `ls $(...)`: held for the substitution alone.
    const c = bash("ls $(git rev-parse --show-toplevel)");
    expect(allows(rules("allow", "Bash(ls:*)"), c)).toBeUndefined();
    expect(allows(rules("allow", "Bash(ls:*)", "Bash(git rev-parse:*)"), c)).toHaveLength(2);
    expect(allows(rules("allow", "Bash(ls $(git rev-parse --show-toplevel))"), c)).toBeDefined();
    // A redirect makes an `echo` a write.
    expect(allows(rules("allow", "Bash(echo:*)"), bash("echo hi > out.txt"))).toBeDefined();
    expect(allows(rules("allow", "Bash(git push:*)"), bash("echo hi > out.txt && git push"))).toBeUndefined();
    // `$(which x) y` is a program this cannot name.
    expect(allows(rules("allow", "Bash(x:*)", "Bash(which:*)"), bash("$(which x) y"))).toBeUndefined();
    expect(allows(rules("allow", "Bash($(which x) y)"), bash("$(which x) y"))).toBeDefined();
    expect(allows(rules("allow", "Bash(npm test:*)"), bash("export A=1 && npm test"))).toBeUndefined();
  });

  test("a here-document is the script: only the whole text allows it", () => {
    const text = "python3 - <<'EOF'\nprint(1)\nEOF";
    expect(allows(rules("allow", "Bash(python3:*)"), bash(text))).toBeDefined();
    expect(allows(rules("allow", `Bash(${text})`), bash(text))).toBeDefined();
    expect(allows(rules("allow", `Bash(${text})`), bash("python3 - <<'EOF'\nprint(2)\nEOF"))).toBeUndefined();
  });
});

describe("calls the gate always holds", () => {
  test("a prefix rule never opens one; the exact command does", () => {
    const command = "git push --force origin main";
    expect(allows(rules("allow", "Bash(git push:*)", "Bash(git:*)", "Bash"), bash(command), true)).toBeUndefined();
    expect(allows(rules("allow", `Bash(${command})`), bash(command), true)).toEqual([`Bash(${command})`]);
    // The exact rule for a part is not the whole call.
    expect(allows(rules("allow", `Bash(${command})`), bash(`cd x && ${command}`), true)).toBeUndefined();
    expect(allows(rules("allow", `Bash(cd x && ${command})`), bash(`cd x && ${command}`), true)).toBeDefined();
    // The same text with other spacing is the same single command.
    expect(allows(rules("allow", `Bash(${command})`), bash("git  push --force  origin main"), true)).toBeDefined();
  });

  test("a path rule opens a credential file only when it names it without wildcards", () => {
    const env = call("edit", { path: ".env" });
    expect(allows(rules("allow", "Edit(**)", "Edit(*)", "Edit(./*)", "Edit(src/**)"), env, true)).toBeUndefined();
    expect(allows(rules("allow", "Edit(.env)"), env, true)).toBeDefined();
    expect(allows(rules("allow", "Edit(./.env)"), env, true)).toBeDefined();
    expect(allows(rules("allow", "Edit(.env)"), call("edit", { path: "src/.env" }), true)).toBeDefined();
    expect(allows(rules("allow", "Edit(./.env)"), call("edit", { path: "src/.env" }), true)).toBeUndefined();
    // A bare tool rule is not an exact one.
    expect(allows(rules("allow", "Edit"), env, true)).toBeUndefined();
  });
});

describe("paths", () => {
  const home = homedir();
  const edit = (file: string) => call("edit", { path: file });

  test("relative patterns: a directory pattern is anchored, a bare name matches at any depth", () => {
    const src = rules("allow", "Edit(src/**)");
    expect(allows(src, edit("src/a.ts"))).toBeDefined();
    expect(allows(src, edit("src/deep/er/a.ts"))).toBeDefined();
    expect(allows(src, edit(`${ROOT}/src/a.ts`))).toBeDefined();
    expect(allows(src, edit("lib/src/a.ts"))).toBeUndefined();
    expect(allows(src, edit("../src/a.ts"))).toBeUndefined();
    expect(allows(src, edit("/elsewhere/src/a.ts"))).toBeUndefined();
    const anywhere = rules("allow", "Edit(*.md)", "Edit(generated)");
    expect(allows(anywhere, edit("README.md"))).toBeDefined();
    expect(allows(anywhere, edit("docs/a/b.md"))).toBeDefined();
    expect(allows(anywhere, edit("docs/a.txt"))).toBeUndefined();
    expect(allows(anywhere, edit("generated/x/y.ts"))).toBeDefined();
  });

  test("a leading ./ anchors; /* is one level; ** crosses directories; a directory name covers what is in it", () => {
    expect(allows(rules("allow", "Edit(./package.json)"), edit("package.json"))).toBeDefined();
    expect(allows(rules("allow", "Edit(./package.json)"), edit("pkg/package.json"))).toBeUndefined();
    // As in gitignore, a pattern that matches a directory covers everything in it.
    expect(allows(rules("allow", "Edit(./*)"), edit("src/a.ts"))).toBeDefined();
    expect(allows(rules("allow", "Edit(src/*)"), edit("src/a.ts"))).toBeDefined();
    expect(allows(rules("allow", "Edit(src/*)"), edit("src/b/a.ts"))).toBeDefined();
    expect(allows(rules("allow", "Edit(src/*)"), edit("lib/a.ts"))).toBeUndefined();
    // dir/** is the directory's contents, and the directory itself for listing it.
    expect(allows(rules("allow", "Read(src/**)"), call("ls", { path: "src" }))).toBeDefined();
    expect(allows(rules("allow", "Edit(**/*.test.ts)"), edit("a.test.ts"))).toBeDefined();
    expect(allows(rules("allow", "Edit(**/*.test.ts)"), edit("x/y/a.test.ts"))).toBeDefined();
    expect(allows(rules("allow", "Edit(./src)"), edit("src/a/b.ts"))).toBeDefined();
    expect(allows(rules("allow", "Edit(src/?.ts)"), edit("src/a.ts"))).toBeDefined();
    expect(allows(rules("allow", "Edit(src/?.ts)"), edit("src/ab.ts"))).toBeUndefined();
  });

  test("home, absolute and Claude Code's // absolute patterns", () => {
    expect(allows(rules("allow", "Edit(~/notes/**)"), edit(`${home}/notes/a/b.md`))).toBeDefined();
    expect(allows(rules("allow", "Edit(~/notes/**)"), edit("~/notes/a.md"))).toBeDefined();
    expect(allows(rules("allow", "Edit(~/notes/**)"), edit(`${home}/other/a.md`))).toBeUndefined();
    expect(allows(rules("allow", "Edit(/etc/app/**)"), edit("/etc/app/x.conf"))).toBeDefined();
    expect(allows(rules("allow", "Edit(//etc/app/**)"), edit("/etc/app/x.conf"))).toBeDefined();
    expect(allows(rules("allow", "Edit(/etc/app/**)"), edit("/etc/other/x.conf"))).toBeUndefined();
  });

  test("allow rules are per tool; deny and ask for Edit and Write cover both file-writing tools", () => {
    const edits = rules("allow", "Edit(src/**)");
    expect(allows(edits, call("write", { path: "src/a.ts" }))).toBeUndefined();
    expect(allows(rules("allow", "Write(src/**)"), call("write", { path: "src/a.ts" }))).toBeDefined();
    expect(blocking(rules("deny", "Edit(src/gen/**)"), call("write", { path: "src/gen/a.ts" }))?.list).toBe("deny");
    expect(blocking(rules("ask", "Write(src/gen/**)"), call("edit", { path: "src/gen/a.ts" }))?.list).toBe("ask");
    expect(blocking(rules("deny", "Edit(src/gen/**)"), call("read", { path: "src/gen/a.ts" }))).toBeUndefined();
  });

  test("Read rules cover read, grep, find and ls", () => {
    const deny = rules("deny", "Read(.env)", "Read(~/.ssh/**)");
    expect(blocking(deny, call("read", { path: ".env" }))?.list).toBe("deny");
    expect(blocking(deny, call("grep", { pattern: "x", path: "apps/web/.env" }))?.list).toBe("deny");
    expect(blocking(deny, call("ls", { path: `${homedir()}/.ssh` }))?.list).toBe("deny");
    expect(blocking(deny, call("find", { path: "~/.ssh/keys" }))?.list).toBe("deny");
    expect(blocking(deny, call("read", { path: "src/a.ts" }))).toBeUndefined();
    // grep's path defaults to the working directory.
    expect(blocking(rules("ask", "Read(./*)"), call("grep", { pattern: "x" }))).toBeUndefined();
  });

  test("a path rule opens the directory policy for its tool, not for another", () => {
    const rs = rules("allow", "Edit(~/dotfiles/**)", "Read(~/Projects/other/**)");
    expect(allowsPath(rs, "edit", `${homedir()}/dotfiles/x`, ROOT)).toBe(true);
    expect(allowsPath(rs, "write", `${homedir()}/dotfiles/x`, ROOT)).toBe(false);
    expect(allowsPath(rs, "read", `${homedir()}/Projects/other/a.ts`, ROOT)).toBe(true);
    expect(allowsPath(rs, "edit", `${homedir()}/Projects/other/a.ts`, ROOT)).toBe(false);
  });
});

describe("other tools", () => {
  test("a tool name covers that tool; mcp__server covers the server's tools; * is a wildcard", () => {
    const rs = rules("allow", "web_fetch", "mcp__paperless", "mcp__chrome__*");
    expect(allows(rs, call("web_fetch", {}))).toEqual(["web_fetch"]);
    expect(allows(rs, call("web_fetch_more", {}))).toBeUndefined();
    expect(allows(rs, call("mcp__paperless__list_tags", {}))).toEqual(["mcp__paperless"]);
    expect(allows(rs, call("mcp__paperless_other__x", {}))).toBeUndefined();
    expect(allows(rs, call("mcp__chrome__click", {}))).toEqual(["mcp__chrome__*"]);
    expect(blocking(rules("deny", "mcp__paperless"), call("mcp__paperless__list_tags", {}))?.list).toBe("deny");
    expect(blocking(rules("ask", "mcp__*__delete*"), call("mcp__x__delete_all", {}))?.list).toBe("ask");
  });
});

describe("suggested rules", () => {
  const s = (command: string) => suggest(bash(command));

  test("the key of bashKeys as a prefix", () => {
    expect(s("git push origin main")).toEqual(["Bash(git push:*)"]);
    expect(s("cd ~/b && git -C x push")).toEqual(["Bash(git push:*)"]);
    expect(s("npm test -- --watch")).toEqual(["Bash(npm test:*)"]);
    expect(s("docker compose -f a.yml up -d")).toEqual(["Bash(docker compose up:*)"]);
    expect(s("docker restart authelia")).toEqual(["Bash(docker restart authelia:*)"]);
    expect(s("gh repo create me/x --public")).toEqual(["Bash(gh repo create:*)"]);
    expect(s("FOO=1 cargo test -p x")).toEqual(["Bash(cargo test:*)"]);
    expect(s("make")).toEqual(["Bash(make:*)"]);
    expect(s("bin/homelab status")).toEqual(["Bash(bin/homelab status:*)"]);
    expect(s("./scripts/deploy.sh --prod")).toEqual(["Bash(scripts/deploy.sh:*)"]);
    expect(s("uv run pytest -q")).toEqual(["Bash(uv run:*)"]);
  });

  test("one rule per key, for a call with several", () => {
    expect(s("npm test && git push && rm -rf build")).toEqual(["Bash(git push:*)", "Bash(npm test:*)", "Bash(rm -rf build)"]);
    expect(s("echo \"$(git push origin $(npm publish))\"; npm test")).toEqual(["Bash(git push:*)", "Bash(npm publish:*)", "Bash(npm test:*)"]);
    expect(s("for d in a b; do docker restart $d; done")).toEqual(["Bash(docker restart:*)"]);
  });

  test("the exact command for programs whose arguments are the risk", () => {
    expect(s("rm -rf build")).toEqual(["Bash(rm -rf build)"]);
    expect(s("mv a.txt b.txt")).toEqual(["Bash(mv a.txt b.txt)"]);
    expect(s("chmod 755 bin/x")).toEqual(["Bash(chmod 755 bin/x)"]);
    expect(s("chown me:me x")).toEqual(["Bash(chown me:me x)"]);
    expect(s("dd if=a of=b bs=1m")).toEqual(["Bash(dd if=a of=b bs=1m)"]);
    expect(s("curl -s -X POST https://x.example/api")).toEqual(["Bash(curl -s -X POST https://x.example/api)"]);
    expect(s("wget https://x.example/f.sh")).toEqual(["Bash(wget https://x.example/f.sh)"]);
    expect(s("ssh host 'ls -la'")).toEqual(["Bash(ssh host 'ls -la')"]);
    expect(s("scp a host:b")).toEqual(["Bash(scp a host:b)"]);
    expect(s("rsync -av a/ host:b/")).toEqual(["Bash(rsync -av a/ host:b/)"]);
    expect(s("nc -l 9000")).toEqual(["Bash(nc -l 9000)"]);
    expect(s("gh api repos/me/x/issues")).toEqual(["Bash(gh api repos/me/x/issues)"]);
    expect(s("sudo systemctl restart nginx")).toEqual(["Bash(sudo systemctl restart nginx)"]);
    // Time and environment are not part of what the rule says.
    expect(s("time rm -rf build")).toEqual(["Bash(rm -rf build)"]);
    // Inline code and scripts fed on stdin.
    expect(s("python3 -c 'print(1)'")).toEqual(["Bash(python3 -c 'print(1)')"]);
    expect(s("node -e \"console.log(1)\"")).toEqual(["Bash(node -e 'console.log(1)')"]);
    expect(s("bash -c 'git push'")).toEqual(["Bash(bash -c 'git push')"]);
    expect(s("sh -c 'make; make test'")).toEqual(["Bash(sh -c 'make; make test')"]);
    expect(s("python3")).toEqual(["Bash(python3)"]);
    expect(s("python3 - <<'EOF'\nprint(1)\nEOF")).toEqual(["Bash(python3 - <<'EOF'\nprint(1)\nEOF)"]);
    expect(s("ssh host <<'EOF'\nls\nEOF")).toEqual(["Bash(ssh host <<'EOF'\nls\nEOF)"]);
  });

  test("a here-document fed to a program that is not code is no reason for the whole call: git commit is a prefix", () => {
    expect(s("git commit -F - <<'EOF'\nfix: a thing\nEOF")).toEqual(["Bash(git commit:*)"]);
    expect(s("git add -A && git commit -m \"$(cat <<'EOF'\nfix: a thing\nEOF\n)\"")).toEqual(["Bash(git add:*)", "Bash(git commit:*)"]);
    expect(s("cat <<'EOF' > notes.md\nhello\nEOF")).toEqual(["Bash(cat <<'EOF' > notes.md\nhello\nEOF)"]);
  });

  test("a script runner's rule names the script", () => {
    expect(s("python3 scripts/x.py --fast")).toEqual(["Bash(python3 scripts/x.py:*)"]);
    expect(s("node server.js")).toEqual(["Bash(node server.js:*)"]);
    expect(s("bash scripts/setup.sh")).toEqual(["Bash(bash scripts/setup.sh:*)"]);
    expect(s("python3 -u x.py")).toEqual(["Bash(python3 -u x.py)"]);
    expect(s("python3 -m pytest")).toEqual(["Bash(python3 -m pytest)"]);
  });

  test("the whole call for what bashKeys marks unparsed shell, and for reads held for a substitution or redirect", () => {
    expect(s("export A=1 && npm test")).toEqual(["Bash(export A=1 && npm test)"]);
    expect(s("$(which python) x.py")).toEqual(["Bash($(which python) x.py)"]);
    expect(s("env -S 'rm -rf x'")).toEqual(["Bash(env -S 'rm -rf x')"]);
    expect(s("grep -c Admin $(ls cfg) > /tmp/out.txt")).toEqual(["Bash(grep -c Admin $(ls cfg) > /tmp/out.txt)"]);
    expect(s("echo hi > f")).toEqual(["Bash(echo hi > f)"]);
    // An exact rule with an expansion in it names the whole call, not the part.
    expect(s("cd x && rm -rf $DIR")).toEqual(["Bash(cd x && rm -rf $DIR)"]);
    // A trailing * would read back as a prefix: spelled as words when it can be, else not offered.
    expect(s("cp a *")).toEqual(["Bash(cp:*)"]);
    expect(s("export A=1 && ls *")).toEqual([]);
    expect(s("echo x > f; cat *")).toEqual([]);
  });

  test("every suggestion is a rule that allows the call it was made for", () => {
    for (const command of [
      "git push origin main", "npm test && git push", "rm -rf build", "python3 scripts/x.py --fast", "curl -s https://x.example/api",
      "ssh host 'ls -la'", "bash -c 'git push'", "docker compose -f a.yml up -d", "export A=1 && npm test", "echo hi > f",
      "grep -c Admin $(ls cfg) > /tmp/out.txt", "python3 - <<'EOF'\nprint(1)\nEOF", "node -e \"console.log(1)\"", "bin/homelab status",
    ]) {
      const offered = s(command);
      expect(offered.length, command).toBeGreaterThan(0);
      expect(allows(offered.map((t) => rule("allow", t)), bash(command)), command).toBeDefined();
    }
  });

  test("edit and write by folder, other tools by name, reads not at all", () => {
    expect(suggest(call("edit", { path: "src/a/b.ts" }))).toEqual(["Edit(src/a/**)"]);
    expect(suggest(call("write", { path: `${ROOT}/src/new.ts` }))).toEqual(["Write(src/**)"]);
    expect(suggest(call("edit", { path: "package.json" }))).toEqual(["Edit(./package.json)"]);
    expect(suggest(call("write", { path: `${homedir()}/.zshrc` }))).toEqual(["Write(~/.zshrc)"]);
    expect(suggest(call("edit", { path: "../other/a.ts" }))).toEqual(["Edit(/Users/me/Projects/other/**)"]);
    expect(suggest(call("write", { path: `${homedir()}/notes/a.md` }))).toEqual(["Write(~/notes/**)"]);
    expect(suggest(call("write", { path: "/etc/x/y" }))).toEqual(["Write(/etc/x/**)"]);
    expect(suggest(call("web_fetch", { url: "https://x" }))).toEqual(["web_fetch"]);
    expect(suggest(call("mcp__paperless__update_document", {}))).toEqual(["mcp__paperless__update_document"]);
    expect(suggest(call("read", { path: "x" }))).toEqual([]);
    for (const [tool, file] of [["edit", "src/a/b.ts"], ["write", "package.json"], ["edit", "/etc/x/y"]] as const) {
      const input = { path: file };
      expect(allows(suggest(call(tool, input)).map((t) => rule("allow", t)), call(tool, input)), `${tool} ${file}`).toBeDefined();
    }
  });

  test("units: each simple command with what it does, nested text marked", () => {
    const units = bashUnits("cd x && git -C y push origin; bash -c 'rm -rf z'");
    expect(units.map((u) => [u.words[0], u.key, u.nested, u.read])).toEqual([
      ["cd", undefined, false, true],
      ["git", "git push", false, false],
      ["bash", "bash", false, false],
      ["rm", "rm", true, false],
    ]);
  });
});

describe("saved grants from before rules", () => {
  test("bash, tool and edit/write keys are read as allow rules; dir keys stay folders", () => {
    const m = migrateGrant;
    expect(m("bash:git push")).toEqual({ kind: "rule", list: "allow", text: "Bash(git push:*)" });
    expect(m("bash:docker compose up")).toEqual({ kind: "rule", list: "allow", text: "Bash(docker compose up:*)" });
    expect(m("tool:web_fetch")).toEqual({ kind: "rule", list: "allow", text: "web_fetch" });
    expect(m("edit:/Users/me/Projects/app/src")).toEqual({ kind: "rule", list: "allow", text: "Edit(/Users/me/Projects/app/src/**)" });
    expect(m("write:/tmp/")).toEqual({ kind: "rule", list: "allow", text: "Write(/tmp/**)" });
    expect(m("dir:read:/Users/me/Downloads")).toEqual({ kind: "dir", key: "dir:read:/Users/me/Downloads", access: "read", dir: "/Users/me/Downloads" });
    expect(m("dir:write:/x")).toMatchObject({ kind: "dir", access: "write" });
    // What an old unparsed key meant, exactly; reads with substitutions have no rule.
    expect(m("bash:unparsed shell: export A=1 && npm test")).toEqual({ kind: "rule", list: "allow", text: "Bash(export A=1 && npm test)" });
    expect(m("bash:reads with substitutions or redirects")).toBeUndefined();
    // The keys new rules are saved under.
    expect(m("allow:Bash(git push:*)")).toEqual({ kind: "rule", list: "allow", text: "Bash(git push:*)" });
    expect(m("deny:Bash(rm:*)")).toEqual({ kind: "rule", list: "deny", text: "Bash(rm:*)" });
    expect(m("something else")).toBeUndefined();
  });

  test("localGrants turns a project's entries into rules in the machine-local scope, keeping their keys", () => {
    const grants = [
      { key: "bash:git push", label: "`git push`", added: "2026-01-01" },
      { key: "dir:read:/x", label: "reads in /x", added: "" },
      { key: "allow:Bash(npm test)", label: "Bash(npm test)", added: "" },
      { key: "bash:reads with substitutions or redirects", label: "reads", added: "" },
      { key: "allow:WebFetch(domain:x)", label: "bad", added: "" },
    ];
    const local = localGrants(grants, "/agent/tool-gate/project-grants.json");
    expect(local.rules.map((r) => [r.list, r.text, r.key])).toEqual([
      ["allow", "Bash(git push:*)", "bash:git push"],
      ["allow", "Bash(npm test)", "allow:Bash(npm test)"],
    ]);
    expect(local.rules[0]?.origin).toEqual({ scope: "project", shared: false, source: "/agent/tool-gate/project-grants.json", writable: true });
    expect(local.dirs).toEqual([{ kind: "dir", key: "dir:read:/x", access: "read", dir: "/x" }]);
    expect(local.ignored.map((r) => r.raw)).toEqual(["WebFetch(domain:x)"]);
  });
});

describe("rule files", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-perm-"));
    cwd = path.join(root, "project");
    mkdirSync(cwd);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "pi"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };

  test("the lists of every file are added together, with where each came from", () => {
    write(path.join(root, "xdg", "agents", "tool-gate.json"), { permissions: { deny: ["Bash(rm -rf:*)"], allow: ["web_fetch"] } });
    write(path.join(root, "pi", "tool-gate.json"), { pushBack: false, permissions: { allow: ["Bash(git push:*)"], ask: ["Bash(git push --force:*)"] } });
    write(path.join(cwd, ".agents", "tool-gate.json"), { directories: { read: ["*"] }, permissions: { allow: ["Edit(src/**)"], deny: ["Read(.env)"] } });
    write(path.join(cwd, ".pi", "tool-gate.json"), { permissions: { allow: ["Bash(npm test)"] } });
    const { rules: found, ignored } = loadFileRules(cwd);
    expect(found.map((r) => `${r.list} ${r.text} [${scopeLabel(r.origin)}]`)).toEqual([
      "deny Bash(rm -rf:*) [user (shared)]",
      "allow web_fetch [user (shared)]",
      "ask Bash(git push --force:*) [user]",
      "allow Bash(git push:*) [user]",
      "deny Read(.env) [project (shared)]",
      "allow Edit(src/**) [project (shared)]",
      "allow Bash(npm test) [project (shared)]",
    ]);
    expect(ignored).toEqual([]);
    const byText = (t: string) => found.find((r) => r.text === t)!;
    expect(byText("Bash(git push:*)").origin).toMatchObject({ scope: "user", shared: false, writable: true, source: path.join(root, "pi", "tool-gate.json") });
    expect(byText("web_fetch").origin).toMatchObject({ scope: "user", shared: true, writable: false });
    expect(byText("Edit(src/**)").origin).toMatchObject({ scope: "project", shared: true, writable: false, source: path.join(cwd, ".agents", "tool-gate.json") });
    expect(byText("Bash(npm test)").origin).toMatchObject({ scope: "project", writable: false });
    expect(describeOrigin(byText("Bash(npm test)").origin, (f) => path.relative(cwd, f))).toBe("project (shared): .pi/tool-gate.json");
    expect(describeOrigin(rule("allow", "web_fetch").origin)).toBe("session");
  });

  test("a rule this cannot read is listed as ignored, and the rest of the file still counts; bad JSON counts for nothing", () => {
    write(path.join(cwd, ".agents", "tool-gate.json"), {
      permissions: { allow: ["WebFetch(domain:x)", "Bash(git status)", 7, "Bash()"], ask: "not a list", deny: ["Bash(rm:*)"] },
    });
    write(path.join(cwd, ".pi", "tool-gate.json"), "{ not json");
    const { rules: found, ignored } = loadFileRules(cwd);
    expect(found.map((r) => r.text)).toEqual(["Bash(rm:*)", "Bash(git status)"]);
    expect(ignored.map((r) => r.raw)).toEqual(["WebFetch(domain:x)", "Bash()"]);
  });

  test("changes to a file are picked up", () => {
    const file = path.join(cwd, ".agents", "tool-gate.json");
    write(file, { permissions: { allow: ["a_tool"] } });
    expect(loadFileRules(cwd).rules.map((r) => r.text)).toEqual(["a_tool"]);
    write(file, { permissions: { allow: ["a_tool", "b_tool"], extra: 1 } });
    // Same size can share an mtime tick: touch it forward.
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(loadFileRules(cwd).rules.map((r) => r.text)).toEqual(["a_tool", "b_tool"]);
  });

  test("editing the user file adds and removes a rule and leaves the rest of the file alone", () => {
    const file = userRulesFile();
    expect(file).toBe(path.join(root, "pi", "tool-gate.json"));
    write(file, { pushBack: false, jev: { enabled: false }, permissions: { deny: ["Bash(rm:*)"], defaultMode: "plan" } });
    editUserRules("add", "allow", "Bash(git push:*)");
    editUserRules("add", "allow", "Bash(git push:*)");
    editUserRules("add", "allow", "web_fetch");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      pushBack: false,
      jev: { enabled: false },
      permissions: { deny: ["Bash(rm:*)"], defaultMode: "plan", allow: ["Bash(git push:*)", "web_fetch"] },
    });
    editUserRules("remove", "allow", "Bash(git push:*)");
    editUserRules("remove", "deny", "Bash(rm:*)");
    expect(JSON.parse(readFileSync(file, "utf8")).permissions).toEqual({ defaultMode: "plan", allow: ["web_fetch"] });
    editUserRules("remove", "allow", "web_fetch");
    expect(JSON.parse(readFileSync(file, "utf8")).permissions).toEqual({ defaultMode: "plan" });
    expect(loadFileRules(cwd).rules).toEqual([]);
  });

  test("a file that is not a JSON object is not overwritten", () => {
    const file = userRulesFile();
    write(file, "{ nope");
    expect(() => editUserRules("add", "allow", "web_fetch")).toThrow(/not valid JSON/u);
    expect(readFileSync(file, "utf8")).toBe("{ nope");
    write(file, "[1]");
    expect(() => editUserRules("add", "allow", "web_fetch")).toThrow(/not a JSON object/u);
  });

  test("a missing file is created with the rule", () => {
    editUserRules("add", "ask", "Bash(npm publish:*)");
    expect(JSON.parse(readFileSync(userRulesFile(), "utf8"))).toEqual({ permissions: { ask: ["Bash(npm publish:*)"] } });
  });
});
