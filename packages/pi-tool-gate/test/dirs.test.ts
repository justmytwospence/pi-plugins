import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bashPathAccess } from "../src/bash.ts";
import { DEFAULT_DIRECTORIES, canRead, canWrite, describePolicy, resolvePolicy, scopeOf, under, violations } from "../src/dirs.ts";
import { Downloads, downloadedRunReasons, trackCall, trackCommand } from "../src/downloads.ts";
import toolGate from "../src/index.ts";
import { assistantEntry, fakeJev, harness, userEntry } from "./harness.ts";

const H = homedir();
const P = path.join(H, "Projects");
const app = path.join(P, "app");

describe("bashPathAccess", () => {
  const access = (command: string, cwd = app) => bashPathAccess(command, cwd);

  test("arithmetic substitutions keep their containing cwd, including heredocs", () => {
    expect(access("cd ~/.config; echo $((1 + $(touch ./arithmetic)))").writes).toContain(`${H}/.config/arithmetic`);
    expect(access("cd ~/.config; cat <<EOF\n$((1 + $(touch ./heredoc)))\nEOF").writes).toContain(`${H}/.config/heredoc`);
    expect(access("cat <<'EOF'\n$(( $(touch ~/.config/quoted) ))\nEOF").writes).toEqual([]);
  });

  test("read-only commands read what they name, relative to the directory they run in", () => {
    expect(access("cat ~/Projects/other/README.md")).toEqual({ reads: [`${P}/other/README.md`], writes: [] });
    expect(access("rg foo ../other src")).toEqual({ reads: [`${P}/other`], writes: [] });
    expect(access("git -C ~/dotfiles log").reads).toContain(`${H}/dotfiles`);
    expect(access("chezmoi cat ~/.config/git/ignore > /tmp/g && diff /tmp/g ~/.config/git/ignore")).toEqual({
      reads: [`${H}/.config/git/ignore`],
      writes: ["/tmp/g"],
    });
  });

  test("a sed script with > is neither a redirect nor a file", () => {
    expect(access("sed -e 's/<[^>]*>/ /g' /tmp/us_wsdl.xml | tr -s ' '")).toEqual({ reads: ["/tmp/us_wsdl.xml"], writes: [] });
  });

  test("words without a slash are not paths, and URLs are not files", () => {
    expect(access("git status && npm test")).toEqual({ reads: [], writes: [] });
    expect(access("curl -s https://example.com/a/b")).toEqual({ reads: [], writes: [] });
  });

  test("package specs and host:path remotes are not local files; local paths with a colon are", () => {
    expect(access("pi update git:github.com/o/r")).toEqual({ reads: [], writes: [] });
    expect(access("npm i github:o/r")).toEqual({ reads: [], writes: [] });
    expect(access("scp ./f nuc:/tmp/f")).toEqual({ reads: [`${app}/f`], writes: [] });
    expect(access("scp nuc:/x ./y")).toEqual({ reads: [], writes: [`${app}/y`] });
    expect(access("rsync -a src/ user@nuc:~/dst/")).toEqual({ reads: [`${app}/src`], writes: [] });
    expect(access("cat ./a:b")).toEqual({ reads: [`${app}/a:b`], writes: [] });
    expect(access("rm /tmp/a:b").writes).toEqual(["/tmp/a:b"]);
  });

  test("writes: redirects, filesystem commands, cp's destination, sed -i", () => {
    expect(access("echo hi > ~/Projects/other/x").writes).toEqual([`${P}/other/x`]);
    expect(access("rm -rf ../other/build").writes).toEqual([`${P}/other/build`]);
    expect(access("cp src/a.ts ~/Projects/other/a.ts")).toEqual({ reads: [`${app}/src/a.ts`], writes: [`${P}/other/a.ts`] });
    expect(access("sed -i s/a/b/ ~/Projects/other/f")).toMatchObject({ writes: [`${P}/other/f`] });
    expect(access("sed s/a/b/ ~/Projects/other/f")).toMatchObject({ writes: [], reads: expect.arrayContaining([`${P}/other/f`]) });
    expect(access("2>/dev/null ls ~/x").writes).toEqual([]);
    expect(access("wc -l < ~/Projects/other/f 2>/dev/null")).toEqual({ reads: [`${P}/other/f`], writes: [] });
  });

  test("other programs are assumed to write what they name", () => {
    expect(access("python3 ~/Projects/other/tool.py").writes).toEqual([`${P}/other/tool.py`]);
  });

  test("ssh: the remote command names remote paths; local key, config, log and socket options count", () => {
    expect(access("ssh -o BatchMode=yes -o ConnectTimeout=10 spencer@nuc '~/.local/bin/chezmoi update --no-tty' 2>&1 | tail -15")).toEqual({ reads: [], writes: [] });
    expect(access("ssh nuc rm -rf ~/Projects/other")).toEqual({ reads: [], writes: [] });
    expect(access("ssh -i ~/.ssh/k -F ./cfg -o IdentityFile=~/.ssh/j -E /tmp/ssh.log nuc ls /x")).toEqual({
      reads: [`${H}/.ssh/k`, `${app}/cfg`, `${H}/.ssh/j`],
      writes: ["/tmp/ssh.log"],
    });
    expect(access("ssh -vSctl nuc true")).toEqual({ reads: [], writes: [] });
    expect(access("ssh nuc true > ~/Projects/other/out").writes).toEqual([`${P}/other/out`]);
  });

  test("absolute words whose top-level directory does not exist are arguments, not files", () => {
    expect(access('pi --no-extensions -e /tmp/s/smoke.ts -p "/smoke"').writes).toEqual(["/tmp/s/smoke.ts"]);
    expect(access('C=smoke; cd /tmp/s && pi -p "/$C"').writes).toEqual(["/tmp/s"]);
    expect(access("node server.js --route /api/v1").writes).toEqual([]);
    expect(access("mkdir /smoke").writes).toEqual(["/smoke"]);
  });

  test("a part run elsewhere reads that directory, or writes it when it does more than read", () => {
    expect(access("cd ~/Projects/other && git status")).toEqual({ reads: [`${P}/other`], writes: [] });
    expect(access("cd ~/Projects/other && make")).toEqual({ reads: [], writes: [`${P}/other`] });
  });

  test("exempt commands name no paths; other parts, redirects and the directory still count", () => {
    const ex = (command: string, cwd = app) => bashPathAccess(command, cwd, [], ["chezmoi apply", "make install"]);
    expect(ex("chezmoi apply ~/.config/x")).toEqual({ reads: [], writes: [] });
    expect(ex("chezmoi -v apply ~/.config/x")).toEqual({ reads: [], writes: [] });
    expect(ex("/opt/homebrew/bin/chezmoi apply ~/.config/x")).toEqual({ reads: [], writes: [] });
    expect(ex("sh -c 'chezmoi apply ~/.config/x'")).toEqual({ reads: [], writes: [] });
    expect(ex("chezmoi apply ~/.config/x && cp a ~/.config/y").writes).toEqual([`${H}/.config/y`]);
    expect(ex("chezmoi apply ~/.config/x > ~/.config/log").writes).toEqual([`${H}/.config/log`]);
    expect(ex("chezmoi add ~/.config/x").writes).toEqual([`${H}/.config/x`]);
    expect(ex("cd ~/Projects/other && make install").writes).toEqual([`${P}/other`]);
  });

  test("sh -c and here-documents", () => {
    expect(access("sh -c 'cat ~/Projects/other/a'").reads).toEqual([`${P}/other/a`]);
    expect(access("cat > notes.md <<'EOF'\nsee ~/Projects/other/x\nEOF")).toEqual({ reads: [], writes: [`${app}/notes.md`] });
  });

  const D = `${H}/.pi/agent/subagents`;

  test("a /dev/null redirect is never a write: a read-only part in a cd'd directory only reads it", () => {
    for (const redirect of ["2>/dev/null", "&>/dev/null", ">/dev/null 2>&1", "> /dev/null", "2> /dev/null >&2"]) {
      expect(access(`cd ~/.pi/agent/subagents; wc -l x/messages.jsonl ${redirect}`)).toEqual({ reads: [D, `${D}/x/messages.jsonl`], writes: [] });
    }
  });

  test("redirects write relative to the directory their command runs in", () => {
    expect(access("cd ~/.pi/agent; echo {} > settings.json").writes).toEqual([`${H}/.pi/agent/settings.json`]);
    expect(access("cd ~/.pi/agent && ls >| out; cat a > /tmp/b").writes).toEqual([`${H}/.pi/agent/out`, "/tmp/b"]);
    expect(access("echo a > x; cd /tmp/s && echo b >> y").writes).toEqual([`${app}/x`, "/tmp/s/y"]);
  });

  test("loop and if keywords are not programs; the commands inside them still count", () => {
    expect(access("cd ~/.pi/agent/subagents; for r in a b; do echo \"== $r\"; ls -la $r; done")).toEqual({ reads: [D], writes: [] });
    expect(access("if test -d x; then cat x/a; else echo none; fi")).toEqual({ reads: [`${app}/x/a`], writes: [] });
    expect(access("for f in ~/Projects/other/*.md; do echo $f; done").reads).toEqual([`${P}/other/*.md`]);
    expect(access("cd ~/.pi/agent/subagents; for r in a b; do rm -rf $r ./$r.bak; done").writes).toEqual([D, `${D}/$r.bak`]);
    expect(access("while true; do touch ~/.config/x; sleep 1; done").writes).toEqual([`${H}/.config/x`]);
    expect(access("if true; then cp a ~/.config/b; fi").writes).toEqual([`${H}/.config/b`]);
    expect(access("cd /tmp/s; for r in a; do make; done").writes).toEqual(["/tmp/s"]);
    expect(access("for r in a; do echo $r; done > ~/.config/list").writes).toEqual([`${H}/.config/list`]);
    expect(access("case $x in a) rm ~/.config/a;; esac").writes).toEqual([`${H}/.config/a`]);
    expect(access("cd ~/.config; do time -p cat ./a; done")).toEqual({ reads: [`${H}/.config`, `${H}/.config/a`], writes: [] });
    // A cd after a keyword is still followed.
    expect(access("if cd ~/.config; then rm x; fi").writes).toEqual([`${H}/.config`]);
    // A compound command's redirect applies where it starts.
    expect(access("{ cd /tmp/s; make; } > log").writes).toEqual([`${app}/log`, "/tmp/s"]);
    expect(access("cd /tmp/s; for r in a; do cd $r; ls; done > log; ls > b").writes).toEqual(["/tmp/s/log", "/tmp/s/$r/b"]);
  });

  test("a command started in another directory (bg_run's cwd) counts it by what each part does", () => {
    expect(bashPathAccess("for r in a b; do ls -la $r 2>/dev/null; done", D, [], [], app)).toEqual({ reads: [D], writes: [] });
    expect(bashPathAccess("f=$(ls | head -1); cat \"$f\"", D, [], [], app)).toEqual({ reads: [D], writes: [] });
    expect(bashPathAccess("make", D, [], [], app)).toEqual({ reads: [], writes: [D] });
    expect(bashPathAccess("x=$(make)", D, [], [], app)).toEqual({ reads: [], writes: [D] });
    expect(bashPathAccess("ls > out", D, [], [], app)).toEqual({ reads: [D], writes: [`${D}/out`] });
  });

  test("command and process substitutions are commands of their own, run where their command runs", () => {
    expect(access("f=$(ls -t $(find ~/.pi/agent/sessions -name '*.jsonl') | sed -n 3p); python3 - \"$f\"")).toEqual({
      reads: [`${H}/.pi/agent/sessions`],
      writes: [],
    });
    expect(access("x=$(rm -rf ~/.config/x)").writes).toEqual([`${H}/.config/x`]);
    expect(access("echo \"$(cp a ~/.config/b)\" `touch ~/.config/c`").writes).toEqual([`${H}/.config/b`, `${H}/.config/c`]);
    expect(access("cd ~/.config; v=$(touch ./y; make)").writes).toEqual([`${H}/.config`, `${H}/.config/y`]);
    expect(access("x=$(echo a > ~/.config/z)").writes).toEqual([`${H}/.config/z`]);
    expect(access("diff <(sort ~/.config/a) <(sort ~/.config/b)")).toEqual({ reads: [`${H}/.config/a`, `${H}/.config/b`], writes: [] });
    expect(access("echo '$(rm -rf ~/.config/q)' \\$(rm y)").writes).toEqual([]);
    expect(access('rg -n "export function (a|b)" src/a.ts; echo $((1 + 2))')).toEqual({ reads: [`${app}/src/a.ts`], writes: [] });
  });
});

describe("downloaded files on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-dl-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a download is found by any path to it: after cd, through a symlink, under its real directory", () => {
    const d = new Downloads();
    mkdirSync(path.join(dir, "w"));
    trackCommand(d, `cd ${dir}/w && curl -fsSLO https://h/tool.sh`, app);
    writeFileSync(path.join(dir, "w", "tool.sh"), "echo hi\n");
    symlinkSync(path.join(dir, "w", "tool.sh"), path.join(dir, "link.sh"));
    expect(downloadedRunReasons("./w/tool.sh", dir, d)).toEqual(["runs ./w/tool.sh, downloaded in this session"]);
    expect(downloadedRunReasons("sh link.sh", dir, d)).toEqual(["runs link.sh, downloaded in this session"]);
    // macOS's /var is /private/var: the real path is the same file.
    expect(downloadedRunReasons(`bash ${realpathSync(dir)}/w/tool.sh`, app, d)).toHaveLength(1);
    expect(downloadedRunReasons("./w/other.sh", dir, d)).toEqual([]);
  });

  test("a copy into an existing directory lands under it; bg_run's cwd is where its command runs", () => {
    const d = new Downloads();
    mkdirSync(path.join(dir, "bin"));
    trackCall(d, "bg_run", { command: "curl -o x https://h/x && cp x bin", cwd: dir }, app);
    expect(d.has(path.join(dir, "x"))).toBe(true);
    expect(d.has(path.join(dir, "bin", "x"))).toBe(true);
    expect(d.has(path.join(dir, "bin"))).toBe(false);
    expect(d.has(path.join(app, "x"))).toBe(false);
    // Tools other than bash and bg_run download nothing.
    trackCall(d, "write", { command: "curl -o y https://h/y", path: "y" }, dir);
    expect(d.has(path.join(dir, "y"))).toBe(false);
  });
});

describe("policy", () => {
  const policy = (over: Partial<typeof DEFAULT_DIRECTORIES> = {}, project = [app]) => resolvePolicy({ ...DEFAULT_DIRECTORIES, ...over }, project);

  test("globs and plain paths", () => {
    expect(under(`${P}/herdr-undo/x`, `${P}/herdr-*`)).toBe(true);
    expect(under(`${P}/herdr`, `${P}/herdr-*`)).toBe(false);
    expect(under(`${P}/appx`, `${P}/app`)).toBe(false);
  });

  test("default: the project, and anything outside the private roots, is readable; writes stay in the project and temp", () => {
    const p = policy();
    expect(canRead(p, `${app}/src/a.ts`)).toBe(true);
    expect(canRead(p, "/usr/include/stdio.h")).toBe(true);
    expect(canRead(p, `${H}/.config/git/config`)).toBe(true);
    expect(canRead(p, `${P}/other/a`)).toBe(false);
    expect(canRead(p, `${H}/Documents/tax.pdf`)).toBe(false);
    expect(canWrite(p, `${app}/a`)).toBe(true);
    expect(canWrite(p, "/tmp/x")).toBe(true);
    expect(canWrite(p, `${H}/.cache/x`)).toBe(true);
    expect(canWrite(p, `${H}/.zshrc`)).toBe(false);
  });

  test("grants: read anywhere, read lists, write lists with globs; a worktree's main checkout belongs to the project", () => {
    expect(canRead(policy({ read: ["*"] }), `${P}/other/a`)).toBe(true);
    expect(canWrite(policy({ read: ["*"] }), `${P}/other/a`)).toBe(false);
    expect(canRead(policy({ read: ["~/Projects/other"] }), `${P}/other/a`)).toBe(true);
    const w = policy({ write: ["~/dotfiles", "~/Projects/herdr-*"] });
    expect(canWrite(w, `${H}/dotfiles/x`)).toBe(true);
    expect(canWrite(w, `${P}/herdr-undo/x`)).toBe(true);
    expect(canRead(w, `${P}/herdr-undo/x`)).toBe(true);
    expect(canWrite(policy({}, [`${app}/.worktrees/b`, app]), `${app}/x`)).toBe(true);
  });

  test("derived paths: writes are held even under a grant, with the hint; the project and reads are unaffected", () => {
    const p = policy({ write: ["~/.config"], derived: [{ path: "~/.config/app", hint: "Edit ~/src/app.toml." }, { path: "~/.local/bin" } as any] }, [app, `${H}/.config/app/repo`]);
    expect(canWrite(p, `${H}/.config/other`)).toBe(true);
    expect(canWrite(p, `${H}/.config/app/x`)).toBe(false);
    expect(canRead(p, `${H}/.config/app/x`)).toBe(true);
    expect(canWrite(p, `${H}/.config/app/repo/x`)).toBe(true);
    expect(violations(p, { reads: [`${H}/.config/app/y`], writes: [`${H}/.config/app/x`, `${H}/.local/bin/t`] })).toEqual([
      { access: "write", file: `${H}/.config/app/x`, scope: `${H}/.config/app`, hint: "Edit ~/src/app.toml." },
      { access: "write", file: `${H}/.local/bin/t`, scope: `${H}/.local/bin`, hint: "" },
    ]);
    expect(describePolicy(p)).toMatch(/Derived \(writes held\): ~\/\.config\/app, ~\/\.local\/bin\./u);
  });

  test("a grant covers the folder under a private root", () => {
    const p = policy();
    expect(scopeOf(p, `${P}/other/src/a.ts`, "read")).toBe(`${P}/other`);
    expect(scopeOf(p, `${H}/.zshrc`, "write")).toBe(H);
    expect(scopeOf(p, "/smoke", "write")).toBe("/smoke");
    expect(scopeOf(p, "/", "write")).toBe("/");
    // A file directly in a private root grants the root, not the file.
    expect(scopeOf(p, `${H}/Downloads/Screenshot at 1.01.45 PM.png`, "read")).toBe(`${H}/Downloads`);
    const root = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-scope-"));
    try {
      mkdirSync(path.join(root, "repo"));
      writeFileSync(path.join(root, "notes"), "");
      const q = policy({ private: [root] });
      expect(scopeOf(q, path.join(root, "repo"), "read")).toBe(path.join(root, "repo"));
      expect(scopeOf(q, path.join(root, "notes"), "read")).toBe(root);
      expect(scopeOf(q, path.join(root, "new-folder"), "write")).toBe(path.join(root, "new-folder"));
      expect(scopeOf(q, path.join(root, "new.txt"), "write")).toBe(root);
      // Outside private roots, a write to an existing directory (a command's working directory) covers
      // that directory, not its parent: `cd ~ && chezmoi apply` grants writes in ~, not in /Users.
      const plain = policy();
      expect(scopeOf(plain, path.join(root, "repo"), "write")).toBe(path.join(root, "repo"));
      expect(scopeOf(plain, path.join(root, "repo", "new.txt"), "write")).toBe(path.join(root, "repo"));
      expect(violations(plain, bashPathAccess("cd ~ && chezmoi apply", app))).toEqual([{ access: "write", file: H, scope: H }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(violations(p, { reads: [`${P}/other/a`], writes: [`${H}/.zshrc`] })).toEqual([
      { access: "write", file: `${H}/.zshrc`, scope: H },
      { access: "read", file: `${P}/other/a`, scope: `${P}/other` },
    ]);
    expect(describePolicy(p)).toMatch(/^Project: ~\/Projects\/app\./u);
  });
});

describe("the gate", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-dirs-"));
    vi.stubEnv("XDG_CONFIG_HOME", path.join(configDir, "xdg"));
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(configDir, "pi"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  const safe = {
    in_scope: { type: "bool", probability: 0.95 },
    irreversible: { type: "bool", probability: 0.05 },
    remote_change: { type: "bool", probability: 0.02 },
    exfiltration: { type: "bool", probability: 0.01 },
    impact: { type: "score", score: 1, confidence: 0.9 },
  };
  const call = (toolName: string, input: Record<string, unknown>, id = "t1") => ({ type: "tool_call", toolCallId: id, toolName, input });

  function setup(directories?: Record<string, unknown>, cwd = app) {
    if (directories) {
      mkdirSync(path.join(configDir, "xdg", "agents"), { recursive: true });
      writeFileSync(path.join(configDir, "xdg", "agents", "tool-gate.json"), JSON.stringify({ directories }));
    }
    const h = harness();
    toolGate(h.pi);
    const branch: any[] = [userEntry("Fix it"), assistantEntry("On it.")];
    const jev = fakeJev((q) => (q.workaround ? { workaround: { type: "choice", choice: "skip", probabilities: { skip: 1 }, confidence: 1 } } : safe));
    const ctx = h.ctx({ cwd, modelRegistry: jev.registry, sessionManager: { getBranch: () => branch } });
    return { h, ctx, jev };
  }

  test("reads inside the project and outside private roots run; a read of another project is pushed back, then asked", async () => {
    const { h, ctx, jev } = setup();
    await h.emit("session_start", {}, ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("read", { path: "src/a.ts" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("read", { path: "/etc/hosts" }), ctx)).toBeUndefined();
    const first: any = await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }), ctx);
    expect(first.block).toBe(true);
    expect(first.reason).toMatch(/reads ~\/Projects\/other\/a\.ts, outside this project's directories/u);
    ctx.ui.selectAnswers.push("Allow folder for this session");
    expect(await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }, "t2"), ctx)).toBeUndefined();
    expect(ctx.ui.selects[0]?.options).toEqual(["Allow once", "Allow folder for this session", "Allow folder in this project", "Block", "Block with a message"]);
    expect(ctx.ui.selects[0]?.title).toMatch(/\nFolder: reads in ~\/Projects\/other$/u);
    // The folder is granted for the session: no more asking, no Jev.
    expect(await h.emit("tool_call", call("bash", { command: "rg foo ~/Projects/other" }, "t3"), ctx)).toBeUndefined();
    expect(ctx.ui.selects).toHaveLength(1);
    expect(jev.calls.filter((c) => !c.questions.workaround)).toHaveLength(0);
  });

  test("a project grant outlives the session and can be revoked with /gate grants", async () => {
    const first = setup();
    await first.h.emit("session_start", {}, first.ctx);
    await first.h.emit("before_agent_start", { prompt: "x" }, first.ctx);
    const pushed: any = await first.h.emit("tool_call", call("read", { path: "~/Downloads/shot.png" }), first.ctx);
    expect(pushed.block).toBe(true);
    first.ctx.ui.selectAnswers.push("Allow folder in this project");
    expect(await first.h.emit("tool_call", call("read", { path: "~/Downloads/shot.png" }, "t2"), first.ctx)).toBeUndefined();
    expect(first.ctx.ui.selects[0]?.options.slice(1, 3)).toEqual(["Allow folder for this session", "Allow folder in this project"]);
    const stored = JSON.parse(readFileSync(path.join(configDir, "pi", "tool-gate", "project-grants.json"), "utf8"));
    expect(stored[app]).toEqual([expect.objectContaining({ key: `dir:read:${H}/Downloads`, label: "reads in ~/Downloads" })]);

    // A new session in the same project: no asking.
    const second = setup();
    await second.h.emit("session_start", {}, second.ctx);
    await second.h.emit("before_agent_start", { prompt: "x" }, second.ctx);
    expect(await second.h.emit("tool_call", call("read", { path: "~/Downloads/other.pdf" }), second.ctx)).toBeUndefined();
    expect(second.ctx.ui.selects).toHaveLength(0);

    second.ctx.ui.selectAnswers.push("folder: reads in ~/Downloads (project (this machine))", "Remove");
    await second.h.commands.get("gate").handler("grants", second.ctx);
    expect(JSON.parse(readFileSync(path.join(configDir, "pi", "tool-gate", "project-grants.json"), "utf8"))).toEqual({});
    const again: any = await second.h.emit("tool_call", call("read", { path: "~/Downloads/other.pdf" }, "t3"), second.ctx);
    expect(again.block).toBe(true);
  });

  test("write grants and read-anywhere come from tool-gate.json", async () => {
    const { h, ctx, jev } = setup({ read: ["*"], write: ["~/dotfiles"] });
    await h.emit("session_start", {}, ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }), ctx)).toBeUndefined();
    expect(await h.emit("tool_call", call("edit", { path: "~/dotfiles/x", edits: [] }, "t2"), ctx)).toBeUndefined();
    expect(jev.calls).toHaveLength(1);
    const held: any = await h.emit("tool_call", call("write", { path: "~/Projects/other/a.ts", content: "" }, "t3"), ctx);
    expect(held.reason).toMatch(/writes ~\/Projects\/other\/a\.ts/u);
  });

  test("a derived write is pushed back with its hint and no Jev workaround; exempt commands run", async () => {
    const { h, ctx, jev } = setup({
      derived: [{ path: "~/.config/app", hint: "Edit ~/src/app.toml, then run the generator." }],
      exemptCommands: ["gen apply"],
    });
    await h.emit("session_start", {}, ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    const held: any = await h.emit("tool_call", call("write", { path: "~/.config/app/a.toml", content: "" }), ctx);
    expect(held.block).toBe(true);
    expect(held.reason).toMatch(/writes ~\/\.config\/app\/a\.toml, a derived path/u);
    expect(held.reason).toMatch(/\nEdit ~\/src\/app\.toml, then run the generator\.\n/u);
    expect(jev.calls).toHaveLength(0);
    expect(await h.emit("tool_call", call("bash", { command: "gen apply ~/.config/app/a.toml" }, "t2"), ctx)).toBeUndefined();
    expect(jev.calls.filter((c) => c.questions.workaround)).toHaveLength(0);
  });

  test("read-only calls in derived directories are not held as derived writes", async () => {
    const hint = "Edit its source in ~/Projects/dotfiles instead.";
    const { h, ctx, jev } = setup(
      { derived: ["~/.config", "~/.local/bin", "~/.pi/agent"].map((p) => ({ path: p, hint })), exemptCommands: ["chezmoi apply"] },
      `${P}/pi-plugins/packages/pi-tool-gate`,
    );
    await h.emit("session_start", {}, ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    const loop = `cd ~/.pi/agent/subagents; for r in nv5qou 342xs3; do echo "== $r"; ls -la $r; wc -l $r/messages.jsonl 2>/dev/null; tail -c 600 $r/output.md 2>/dev/null; done`;
    const sessions = String.raw`cd ~/Projects/pi-plugins/packages/pi-tool-gate; rg -n "appendEntry\(" src/index.ts | head; rg -n "export function (commandKeys|keyOf|callKey|similar)" -A3 src/bash.ts src/index.ts | head -20; ls ~/.pi/agent/sessions | wc -l; find ~/.pi/agent/sessions -name '*.jsonl' -mtime -14 | wc -l; f=$(ls -t $(find ~/.pi/agent/sessions -name '*.jsonl') | sed -n 3p); python3 - "$f" <<'EOF'
import json,sys,collections
c=collections.Counter()
for l in open(sys.argv[1]):
    e=json.loads(l); t=e.get("type"); c[(t,e.get("customType"))]+=1
print(c.most_common(20))
EOF`;
    for (const [i, command] of [loop, sessions, `${loop} >/dev/null 2>&1`, `cd ~/.pi/agent && ls &>/dev/null`].entries()) {
      expect(await h.emit("tool_call", call("bash", { command }, `r${i}`), ctx)).toBeUndefined();
    }
    expect(ctx.ui.selects).toHaveLength(0);
    expect(await h.emit("tool_call", call("bg_run", { command: "for r in a b; do wc -l $r/messages.jsonl 2>/dev/null; done", cwd: "~/.pi/agent/subagents", kind: "job" }, "bg"), ctx)).toBeUndefined();
    expect(jev.calls.filter((c) => c.questions.workaround)).toHaveLength(0);
    // Real writes there still are.
    for (const [i, command] of [
      "cd ~/.pi/agent/subagents; for r in a; do echo x > $r/out 2>/dev/null; done",
      "cd ~/.pi/agent; f=$(ls | head -1); cp /tmp/a ./settings.json",
      "x=$(sed -i s/a/b/ ~/.config/app/a.toml)",
      "cd ~/.local/bin; echo x > tool",
    ].entries()) {
      const held: any = await h.emit("tool_call", call("bash", { command }, `w${i}`), ctx);
      expect(held?.block).toBe(true);
      expect(held.reason).toMatch(/writes ~\/\.(pi\/agent|config|local\/bin)\/\S+, a derived path/u);
    }
    const make: any = await h.emit("tool_call", call("bg_run", { command: "make", cwd: "~/.pi/agent/subagents", kind: "job" }, "bg2"), ctx);
    expect(make.reason).toMatch(/writes ~\/\.pi\/agent\/subagents, a derived path/u);
  });

  test("off: no directory holds", async () => {
    const { h, ctx } = setup({ enabled: false });
    await h.emit("session_start", {}, ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }), ctx)).toBeUndefined();
  });

  test("chat allows approved outside reads; yolo changes approvals without leaving chat", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", {}, ctx);
    await h.commands.get("mode").handler("chat", ctx);
    ctx.ui.selectAnswers.push("Allow once");
    expect(await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }), ctx)).toBeUndefined();
    expect(ctx.ui.selects).toHaveLength(1);
    await h.commands.get("mode").handler("yolo", ctx);
    const blocked: any = await h.emit("tool_call", call("write", { path: "~/Projects/other/a.ts", content: "" }, "t2"), ctx);
    expect(blocked?.block).toBe(true);
    expect(blocked.reason).toMatch(/^Chat mode is on:/u);
    await h.commands.get("mode").handler("work", ctx);
    expect(await h.emit("tool_call", call("write", { path: "~/Projects/other/a.ts", content: "" }, "t3"), ctx)).toBeUndefined();
  });

  test("/gate shows the policy", async () => {
    const { h, ctx } = setup({ write: ["~/dotfiles"] });
    await h.emit("session_start", {}, ctx);
    await h.commands.get("gate").handler("", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toMatch(/Writes: the project, ~\/dotfiles, and/u);
  });
});
