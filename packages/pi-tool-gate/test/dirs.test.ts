import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bashPathAccess } from "../src/bash.ts";
import { DEFAULT_DIRECTORIES, canRead, canWrite, describePolicy, resolvePolicy, scopeOf, under, violations } from "../src/dirs.ts";
import toolGate from "../src/index.ts";
import { assistantEntry, fakeJev, harness, userEntry } from "./harness.ts";

const H = homedir();
const P = path.join(H, "Projects");
const app = path.join(P, "app");

describe("bashPathAccess", () => {
  const access = (command: string, cwd = app) => bashPathAccess(command, cwd);

  test("read-only commands read what they name, relative to the directory they run in", () => {
    expect(access("cat ~/Projects/other/README.md")).toEqual({ reads: [`${P}/other/README.md`], writes: [] });
    expect(access("rg foo ../other src")).toEqual({ reads: [`${P}/other`], writes: [] });
    expect(access("git -C ~/dotfiles log").reads).toContain(`${H}/dotfiles`);
    expect(access("chezmoi cat ~/.config/git/ignore > /tmp/g && diff /tmp/g ~/.config/git/ignore")).toEqual({
      reads: [`${H}/.config/git/ignore`],
      writes: ["/tmp/g"],
    });
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

  function setup(directories?: Record<string, unknown>) {
    if (directories) {
      mkdirSync(path.join(configDir, "xdg", "agents"), { recursive: true });
      writeFileSync(path.join(configDir, "xdg", "agents", "tool-gate.json"), JSON.stringify({ directories }));
    }
    const h = harness();
    toolGate(h.pi);
    const branch: any[] = [userEntry("Fix it"), assistantEntry("On it.")];
    const jev = fakeJev((q) => (q.workaround ? { workaround: { type: "choice", choice: "skip", probabilities: { skip: 1 }, confidence: 1 } } : safe));
    const ctx = h.ctx({ cwd: app, modelRegistry: jev.registry, sessionManager: { getBranch: () => branch } });
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
    ctx.ui.selectAnswers.push("Allow similar for this session (reads in ~/Projects/other)");
    expect(await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }, "t2"), ctx)).toBeUndefined();
    expect(ctx.ui.selects[0]?.options[1]).toBe("Allow similar for this session (reads in ~/Projects/other)");
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
    first.ctx.ui.selectAnswers.push("Always allow similar in this project (reads in ~/Downloads)");
    expect(await first.h.emit("tool_call", call("read", { path: "~/Downloads/shot.png" }, "t2"), first.ctx)).toBeUndefined();
    expect(first.ctx.ui.selects[0]?.options.slice(1, 3)).toEqual([
      "Allow similar for this session (reads in ~/Downloads)",
      "Always allow similar in this project (reads in ~/Downloads)",
    ]);
    const stored = JSON.parse(readFileSync(path.join(configDir, "pi", "tool-gate", "project-grants.json"), "utf8"));
    expect(stored[app]).toEqual([expect.objectContaining({ key: `dir:read:${H}/Downloads`, label: "reads in ~/Downloads" })]);

    // A new session in the same project: no asking.
    const second = setup();
    await second.h.emit("session_start", {}, second.ctx);
    await second.h.emit("before_agent_start", { prompt: "x" }, second.ctx);
    expect(await second.h.emit("tool_call", call("read", { path: "~/Downloads/other.pdf" }), second.ctx)).toBeUndefined();
    expect(second.ctx.ui.selects).toHaveLength(0);

    second.ctx.ui.selectAnswers.push(`reads in ~/Downloads (since ${new Date().toISOString().slice(0, 10)})`);
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

  test("off: no directory holds", async () => {
    const { h, ctx } = setup({ enabled: false });
    await h.emit("session_start", {}, ctx);
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    expect(await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }), ctx)).toBeUndefined();
  });

  test("chat mode asks about reads outside instead of refusing them; yolo ignores the policy", async () => {
    const { h, ctx } = setup();
    await h.emit("session_start", {}, ctx);
    await h.commands.get("mode").handler("chat", ctx);
    ctx.ui.selectAnswers.push("Allow once");
    expect(await h.emit("tool_call", call("read", { path: "~/Projects/other/a.ts" }), ctx)).toBeUndefined();
    expect(ctx.ui.selects).toHaveLength(1);
    await h.commands.get("mode").handler("yolo", ctx);
    expect(await h.emit("tool_call", call("write", { path: "~/Projects/other/a.ts", content: "" }, "t2"), ctx)).toBeUndefined();
  });

  test("/gate shows the policy", async () => {
    const { h, ctx } = setup({ write: ["~/dotfiles"] });
    await h.emit("session_start", {}, ctx);
    await h.commands.get("gate").handler("", ctx);
    expect(ctx.ui.notes.at(-1)?.message).toMatch(/Writes: the project, ~\/dotfiles, and/u);
  });
});
